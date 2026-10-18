import { randomUUID } from 'node:crypto';
import { findAccountForModel, getRequestModelId, resolveAccount } from '../accounts.js';
import { assertClaudeChatInput, parseClaudeSseStream, startClaudeCall, translateClaudeStream } from '../claude/index.js';
import { TURN_STATE_HEADER } from '../constants.js';
import { createProxyError, isProxyError, toOpenAiErrorBody } from '../errors.js';
import { collectResponse } from '../responses/collectResponse.js';
import { normalizeResponsesRequest } from '../responses/normalizeResponsesRequest.js';
import { formatSseData, parseSseStream } from '../utils/sse.js';
import { getForwardedHeaders, getRequestHeader, type HandlerContext, recordUpstreamSend, sendJson, SSE_HEADERS, writeText } from '../utils/http.js';
import { createChatStreamState, reduceChatStream } from './reduceChatStream.js';
import { toChatCompletion } from './toChatCompletion.js';
import { toResponsesRequest } from './toResponsesRequest.js';
import type { ResponsesEvent } from '../types.js';

export const handleChatCompletions = async ({ body, req, res, signal, deps, log }: HandlerContext): Promise<void> => {
  // This endpoint is never a relay: the gateway always builds the upstream request itself.
  log.client = 'third_party';
  log.mode = 'gateway';
  const modelId = await getRequestModelId(deps, body.model);
  // Claude checks the original body first: the conversion below drops non-text parts of
  // system/assistant/tool messages, which would silently change a Claude conversation.
  if (findAccountForModel(deps.accounts, modelId)?.provider === 'claude') assertClaudeChatInput(body);
  const { request: draftRequest, ignoredKeys } = toResponsesRequest({ ...body, model: modelId });
  const { account, slug } = resolveAccount(deps.accounts, draftRequest.model);
  log.ignoredKeys = ignoredKeys;

  let events: AsyncIterable<ResponsesEvent>;
  let upstreamHeaders: Headers;
  let claudeUpstream: Response | undefined;
  const isClaude = account.provider === 'claude';
  if (isClaude) {
    const call = await startClaudeCall({ account, slug, body: draftRequest, signal, deps, log });
    if (!call.upstream.body) throw new Error('Upstream response has no body');
    events = translateClaudeStream({ events: parseClaudeSseStream(call.upstream.body), meta: call.meta, saveState: call.saveState });
    upstreamHeaders = call.upstream.headers;
    claudeUpstream = call.upstream;
  } else {
    const model = await account.catalog.findModel(slug);
    const { request, sessionId, isResponsesLite } = normalizeResponsesRequest({ ...draftRequest, model: slug }, model);
    log.model = `${account.alias}/${request.model}`;
    recordUpstreamSend(log, { method: 'POST', url: `${account.client.baseUrl}/responses`, model: request.model });
    const upstream = await account.client.postResponses(request, {
      sessionId,
      isResponsesLite,
      turnState: getRequestHeader(req, TURN_STATE_HEADER),
      signal,
    });
    log.upstreamRequestId = upstream.headers.get('x-oai-request-id') ?? undefined;
    if (!upstream.body) throw new Error('Upstream response has no body');
    events = parseSseStream(upstream.body);
    upstreamHeaders = upstream.headers;
  }

  const meta = {
    id: `chatcmpl-${randomUUID()}`,
    model: slug,
    created: Math.floor((deps.now ?? Date.now)() / 1000),
  };

  try {
    if (body.stream !== true) {
      const collected = await collectResponse(events);
      // Claude assistant text items join without a separator so the client can echo the content
      // back unchanged for signed replay; Codex keeps the blank-line join.
      sendJson(res, 200, toChatCompletion(collected, meta, isClaude ? '' : '\n\n'), getForwardedHeaders(upstreamHeaders));
      return;
    }

    res.writeHead(200, { ...SSE_HEADERS, ...getForwardedHeaders(upstreamHeaders) });
    const streamOptions = (body.stream_options ?? {}) as { include_usage?: boolean };
    let state = createChatStreamState({ ...meta, isUsageIncluded: streamOptions.include_usage === true, textSeparator: isClaude ? '' : '\n\n' });
    let failure: unknown;
    try {
      for await (const event of events) {
        const step = reduceChatStream(state, event);
        state = step.state;
        for (const payload of step.payloads) {
          await writeText(res, payload === '[DONE]' ? 'data: [DONE]\n\n' : formatSseData(payload));
        }
        if (state.isDone) break;
      }
    } catch (error) {
      // A Claude translator failure after headers: deliver an error payload, never a success
      // terminal or [DONE].
      failure = error;
    }
    if (!state.isDone) {
      const error = failure !== undefined
        ? (isProxyError(failure) ? failure : createProxyError({ status: 502, message: failure instanceof Error ? failure.message : String(failure) }))
        : createProxyError({ status: 502, code: 'stream_incomplete', message: 'Upstream stream closed before response.completed' });
      await writeText(res, formatSseData(toOpenAiErrorBody(error))).catch(() => undefined);
    }
    res.end();
  } finally {
    // A failed translation or a disconnected client must close the upstream stream; nothing is
    // retried once chat chunks have reached the client.
    await claudeUpstream?.body?.cancel().catch(() => undefined);
  }
};
