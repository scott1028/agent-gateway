// Gateway-built fallback, not an official-client relay. Mirrors references/codex
// core/src/client.rs Responses/Lite builder and codex-api/src/sse/responses.rs done items.
import type { ServerResponse } from 'node:http';
import { resolveAccount } from '../accounts.js';
import { createProxyError } from '../errors.js';
import { normalizeResponsesRequest } from '../responses/normalizeResponsesRequest.js';
import type { Json } from '../types.js';
import { getForwardedHeaders, type ProxyDeps, recordUpstreamSend, type RequestLog, SSE_HEADERS, writeText } from '../utils/http.js';
import { readSseChunks } from '../utils/sse.js';

export const degradeCodexResponses = async (input: {
  body: Json; res: ServerResponse; deps: ProxyDeps; signal: AbortSignal; log: RequestLog;
}): Promise<void> => {
  const { body, res, deps, signal, log } = input;
  // The relay checks failed, so this send is gateway-built with the home's own identity.
  log.client = 'official';
  log.mode = 'gateway';
  const { account, slug } = resolveAccount(deps.accounts, body.model);
  if (account.provider !== 'codex') throw createProxyError({ status: 400, message: 'Codex fallback requires a Codex account' });
  const normalized = normalizeResponsesRequest({ ...body, model: slug }, await account.catalog.findModel(slug));
  normalized.request.input = normalized.request.input.filter((item) => item.type !== 'reasoning' || (
    typeof item.encrypted_content === 'string' && deps.reasoningStore?.has(account.alias, item.encrypted_content) === true));
  log.model = `${account.alias}/${slug}`;
  log.ignoredKeys = normalized.strippedKeys;
  recordUpstreamSend(log, { method: 'POST', url: `${account.client.baseUrl}/responses`, model: normalized.request.model });
  const upstream = await account.client.postResponses(normalized.request, { sessionId: normalized.sessionId, isResponsesLite: normalized.isResponsesLite, signal });
  log.upstreamRequestId = upstream.headers.get('x-oai-request-id') ?? undefined;
  if (!upstream.body) throw new Error('Upstream response has no body');
  try {
    res.writeHead(200, { ...SSE_HEADERS, ...getForwardedHeaders(upstream.headers) });
    for await (const { chunk, events } of readSseChunks(upstream.body)) {
      for (const event of events) {
        const item = event.item as Json | undefined;
        if (event.type === 'response.output_item.done' && item?.type === 'reasoning' && typeof item.encrypted_content === 'string' && item.encrypted_content !== '') {
          deps.reasoningStore?.record(account.alias, item.encrypted_content);
        }
      }
      if (chunk.length > 0) await writeText(res, chunk);
    }
    res.end();
  } catch (error) {
    res.destroy();
    throw error;
  } finally {
    await upstream.body.cancel().catch(() => undefined);
  }
};
