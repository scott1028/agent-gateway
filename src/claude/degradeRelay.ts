// Official relay fallback reuses the gateway's assembly/client, never the client's identity.
// References: claude-code native 2.1.302 AKn and SDK accumulator; protocol diff §13.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { resolveAccount } from '../accounts.js';
import { CLAUDE_CODE_BETA, CLAUDE_CONTEXT_MANAGEMENT_BETA, CLAUDE_INTERLEAVED_THINKING_BETA, CLAUDE_MESSAGES_PATH } from '../constants.js';
import { createProxyError } from '../errors.js';
import { getSessionId } from '../responses/normalizeResponsesRequest.js';
import type { Json } from '../types.js';
import { type ProxyDeps, recordUpstreamSend, type RequestLog, sendJson, SSE_HEADERS, writeText } from '../utils/http.js';
import { getRawHeader } from '../utils/rawRelay.js';
import { readSseChunks } from '../utils/sse.js';
import { assembleClaudeRequest } from './assembleRequest.js';
import { readClaudeAccountMetadata } from './auth.js';
import { collectClaudeMessage } from './collectMessage.js';
import { toClaudeDegradedRequest } from './degradeMessages.js';
import { canonicalizeClaudeModelId, findClaudeModelMetadata, supportsClaudeInterleavedThinking } from './modelMetadata.js';
import { ANTHROPIC_FIELD_NAMES } from './nativeMessages.js';
import { readClaudeSettings } from './settings.js';
import { parseClaudeSseStream } from './sse.js';
import type { ClaudeCountTokensRequest, ClaudeRequest } from './types.js';

export const degradeClaudeMessages = async (input: {
  req: IncomingMessage; res: ServerResponse; body: Json; signal: AbortSignal;
  deps: ProxyDeps; log: RequestLog; isCountTokens: boolean;
}): Promise<void> => {
  const { req, res, body, signal, deps, log, isCountTokens } = input;
  // The relay checks failed, so this send is gateway-built with the home's own identity.
  log.client = 'official';
  log.mode = 'gateway';
  const { account, slug } = resolveAccount(deps.accounts, body.model);
  if (account.provider !== 'claude') throw createProxyError({ status: 400, message: 'Claude fallback requires a Claude account' });
  const normalized = toClaudeDegradedRequest(body, (block) => {
    const reasoning = block.type === 'thinking' ? block.signature : block.data;
    return typeof reasoning === 'string' && deps.reasoningStore?.has(account.alias, reasoning) === true;
  });
  log.ignoredKeys = normalized.ignoredKeys;
  log.model = `${account.alias}/${slug}`;
  const sessionId = getRawHeader(req.rawHeaders, 'x-claude-code-session-id')
    ?? getSessionId(JSON.stringify([account.alias, slug, normalized.firstMessage]));
  let prepared: { request: ClaudeRequest | ClaudeCountTokensRequest; betas: string[] };
  if (isCountTokens) {
    // Mirrors references/claude-code native DFe @243429208 and lUt @236024090.
    // Unlike Messages, count never assembles system/billing/metadata or cache markers.
    const canonical = canonicalizeClaudeModelId(slug);
    prepared = {
      request: {
        model: slug, messages: normalized.native.messages,
        ...(normalized.native.tools.length > 0 ? { tools: normalized.native.tools } : {}),
        ...(body.thinking === undefined ? {} : { thinking: body.thinking }),
      },
      betas: [
        ...(!canonical.includes('haiku') ? [CLAUDE_CODE_BETA] : []),
        ...(supportsClaudeInterleavedThinking(slug, findClaudeModelMetadata(slug)) ? [CLAUDE_INTERLEAVED_THINKING_BETA] : []),
        ...(!canonical.includes('claude-3-') ? [CLAUDE_CONTEXT_MANAGEMENT_BETA] : []),
      ],
    };
  } else {
    const { accountUuid, deviceId } = await readClaudeAccountMetadata(account.homePath);
    if (accountUuid === undefined) throw createProxyError({ status: 400, code: 'claude_account_required', message: `Claude home ${account.alias} has no account metadata` });
    prepared = assembleClaudeRequest({
      native: normalized.native, modelId: slug, metadata: findClaudeModelMetadata(slug),
      liveModel: await account.catalog.findModel(slug), settings: await readClaudeSettings(account.settingsPath),
      session: { sessionId, accountUuid, ...(deviceId === undefined ? {} : { deviceId }) },
      fieldNames: ANTHROPIC_FIELD_NAMES, extraBody: normalized.extraBody, extraBetas: normalized.extraBetas,
    });
  }
  recordUpstreamSend(log, { method: 'POST', url: `${account.client.baseUrl}${isCountTokens ? '/v1/messages/count_tokens?beta=true' : CLAUDE_MESSAGES_PATH}`, model: slug });
  const upstream = await account.client.postMessages(prepared.request, { sessionId, betas: prepared.betas, signal, ...(isCountTokens ? { isCountTokens: true } : {}) });
  log.upstreamRequestId = upstream.headers.get('request-id') ?? undefined;
  if (!upstream.body) throw new Error('Upstream response has no body');
  const recordBlock = (block: Json): void => {
    const reasoning = block.type === 'thinking' ? block.signature : block.type === 'redacted_thinking' ? block.data : undefined;
    if (typeof reasoning === 'string' && reasoning !== '') deps.reasoningStore?.record(account.alias, reasoning);
  };
  try {
    if (isCountTokens) {
      const headers = Object.fromEntries(upstream.headers);
      // fetch has decoded the body; do not forward its original encoding/framing.
      for (const header of ['content-length', 'content-encoding', 'transfer-encoding', 'connection']) delete headers[header];
      res.writeHead(upstream.status, headers);
      for await (const chunk of upstream.body) await writeText(res, chunk);
      res.end();
      return;
    }
    if (!normalized.isStream) {
      const message = await collectClaudeMessage(parseClaudeSseStream(upstream.body));
      for (const block of message.content as Json[]) recordBlock(block);
      sendJson(res, 200, message);
      return;
    }
    res.writeHead(200, SSE_HEADERS);
    const blocks = new Map<unknown, Json>();
    for await (const { chunk, events } of readSseChunks(upstream.body)) {
      for (const event of events) {
        if (event.type === 'content_block_start' && typeof event.content_block === 'object' && event.content_block !== null) blocks.set(event.index, { ...event.content_block as Json });
        if (event.type === 'content_block_delta') {
          const block = blocks.get(event.index);
          const delta = event.delta as Json | undefined;
          // SDK accumulator replaces (does not concatenate) signature_delta.
          if (block?.type === 'thinking' && delta?.type === 'signature_delta') block.signature = delta.signature;
        }
        if (event.type === 'content_block_stop') {
          const block = blocks.get(event.index);
          if (block !== undefined) recordBlock(block);
          blocks.delete(event.index);
        }
      }
      if (chunk.length > 0) await writeText(res, chunk);
    }
    res.end();
  } catch (error) {
    if (res.headersSent) res.destroy();
    throw error;
  } finally {
    await upstream.body.cancel().catch(() => undefined);
  }
};
