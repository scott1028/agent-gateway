import { getRequestModelId, resolveAccount } from '../accounts.js';
import { parseClaudeSseStream, readClaudeAccountMetadata, startClaudeCall, translateClaudeStream } from '../claude/index.js';
import { TURN_STATE_HEADER } from '../constants.js';
import { createProxyError, isProxyError } from '../errors.js';
import { formatSseEvent, parseSseStream, readSseChunks } from '../utils/sse.js';
import { getForwardedHeaders, getRequestHeader, type HandlerContext, recordUpstreamSend, sendJson, SSE_HEADERS, writeText } from '../utils/http.js';
import { collectResponse } from './collectResponse.js';
import { normalizeResponsesRequest } from './normalizeResponsesRequest.js';
import { assertSameLogin, createResponseRecorder, expandPreviousResponse, observeEvents } from './responseStore.js';
import type { ServerResponse } from 'node:http';
import type { ClaudeStreamMeta } from '../claude/toResponsesEvents.js';

// After SSE headers are out, an HTTP error body is impossible: a failed Claude stream must end
// with a standard Responses failure event instead of a silent EOF, and never with a success
// terminal. Best-effort: a client that already went away just drops the event.
const writeStreamFailure = async (res: ServerResponse, meta: ClaudeStreamMeta, sequence: number, error: unknown): Promise<void> => {
  const proxyError = isProxyError(error) ? error : createProxyError({ status: 502, message: error instanceof Error ? error.message : String(error) });
  const failure = {
    type: 'response.failed',
    sequence_number: sequence + 1,
    response: {
      id: meta.id,
      object: 'response',
      created_at: meta.created,
      completed_at: Math.floor(Date.now() / 1000),
      status: 'failed',
      model: meta.model,
      output: [],
      error: { type: 'upstream_error', code: proxyError.code ?? null, message: proxyError.message },
      usage: null,
      incomplete_details: null,
    },
  };
  await writeText(res, formatSseEvent(failure)).catch(() => undefined);
};

export const handleResponses = async ({ body: rawBody, req, res, signal, deps, log, responseStore }: HandlerContext): Promise<void> => {
  // This endpoint is never a relay: the gateway always builds the upstream request itself.
  log.client = 'third_party';
  log.mode = 'gateway';
  const modelId = await getRequestModelId(deps, rawBody.model);
  const { account, slug } = resolveAccount(deps.accounts, modelId);
  // Both providers see the expanded full input, exactly what a full-history client would send.
  const { body, inputItems, previous } = expandPreviousResponse(responseStore, rawBody, account.alias);
  // The login that really sent this request, like the Claude turn state; records are bound to it.
  let accountIdentity: string | undefined;
  // OpenAI semantics: store:false responses are not kept for a later previous_response_id.
  const observe =
    rawBody.store === false
      ? undefined
      : createResponseRecorder((id, output) => responseStore.save({ id, alias: account.alias, accountIdentity, input: inputItems, output }));

  if (account.provider === 'claude') {
    // Local file read only, the same source startClaudeCall uses; no extra upstream call.
    accountIdentity = (await readClaudeAccountMetadata(account.homePath)).accountUuid;
    assertSameLogin(previous, accountIdentity);
    // Claude emits its own Messages SSE, so events are translated instead of piped through.
    const call = await startClaudeCall({ account, slug, body, signal, deps, log });
    if (!call.upstream.body) throw new Error('Upstream response has no body');
    const events = observeEvents(translateClaudeStream({ events: parseClaudeSseStream(call.upstream.body), meta: call.meta, saveState: call.saveState }), observe);
    try {
      if (body.stream === true) {
        res.writeHead(200, { ...SSE_HEADERS, ...getForwardedHeaders(call.upstream.headers) });
        let lastSequence = 0;
        try {
          for await (const event of events) {
            if (typeof event.sequence_number === 'number') lastSequence = event.sequence_number;
            await writeText(res, formatSseEvent(event));
          }
        } catch (error) {
          await writeStreamFailure(res, call.meta, lastSequence, error);
        }
        res.end();
        return;
      }
      const collected = await collectResponse(events);
      sendJson(res, 200, collected.response, getForwardedHeaders(call.upstream.headers));
      return;
    } finally {
      // A failed translation or a disconnected client must close the upstream stream, not leave it
      // running; nothing is retried once events have reached the client.
      await call.upstream.body?.cancel().catch(() => undefined);
    }
  }

  const model = await account.catalog.findModel(slug);
  const { request, sessionId, isResponsesLite, strippedKeys } = normalizeResponsesRequest({ ...body, model: slug }, model);
  log.model = `${account.alias}/${request.model}`;
  log.ignoredKeys = strippedKeys;

  recordUpstreamSend(log, { method: 'POST', url: `${account.client.baseUrl}/responses`, model: request.model });
  const upstream = await account.client.postResponses(request, {
    sessionId,
    isResponsesLite,
    turnState: getRequestHeader(req, TURN_STATE_HEADER),
    signal,
    // Checked at every real send, including the 401 retry, so no extra credential read or refresh.
    onCredentials: (credentials) => {
      assertSameLogin(previous, credentials.accountId);
      accountIdentity = credentials.accountId;
    },
  });
  log.upstreamRequestId = upstream.headers.get('x-oai-request-id') ?? undefined;
  if (!upstream.body) throw new Error('Upstream response has no body');

  if (body.stream === true) {
    // Backend omits content-type on SSE, so set it explicitly and pipe events through untouched.
    // Events are recorded before their chunk is written, so the terminal chunk follows the save.
    res.writeHead(200, { ...SSE_HEADERS, ...getForwardedHeaders(upstream.headers) });
    for await (const { chunk, events } of readSseChunks(upstream.body)) {
      if (observe) events.forEach(observe);
      await writeText(res, chunk);
    }
    res.end();
    return;
  }

  const collected = await collectResponse(observeEvents(parseSseStream(upstream.body), observe));
  sendJson(res, 200, collected.response, getForwardedHeaders(upstream.headers));
};
