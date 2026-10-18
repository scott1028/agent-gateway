// Downgrade path for Anthropic Messages clients that are not the official Claude Code: the request
// is rebuilt with the gateway's official assembly, as references/CLIProxyAPI v8.0.29
// claude_executor_cloaking.go does for its clients, and sent with the home's own headers, token
// and cch signature. Unlike the native relay (relayMessages.ts) only the shape is official: the
// tools, system texts and messages are still the client's.
import type { ServerResponse } from 'node:http';
import path from 'node:path';
import { resolveAccount } from '../accounts.js';
import { CLAUDE_MESSAGES_PATH } from '../constants.js';
import { createProxyError } from '../errors.js';
import { getSessionId } from '../responses/normalizeResponsesRequest.js';
import type { Json } from '../types.js';
import { recordUpstreamSend, type ProxyDeps, type RequestLog, sendJson, SSE_HEADERS, writeText } from '../utils/http.js';
import { assembleClaudeRequest } from './assembleRequest.js';
import { getClaudeLoginHint, readClaudeAccountMetadata } from './auth.js';
import { collectClaudeMessage } from './collectMessage.js';
import { findClaudeModelMetadata } from './modelMetadata.js';
import { ANTHROPIC_FIELD_NAMES, toClaudeNativeRequest } from './nativeMessages.js';
import { getIsClaudeCodeRequest } from './relayMessages.js';
import { readClaudeSettings } from './settings.js';
import { parseClaudeSseStream } from './sse.js';

// The body to downgrade, or undefined for the native relay. A body that is not a JSON object stays
// on the relay path, which rejects it exactly as before.
export const getClaudeCloakBody = (rawHeaders: string[], rawBody: Buffer): Json | undefined => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody.toString('utf8'));
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined;
  return getIsClaudeCodeRequest(rawHeaders, parsed as Json) ? undefined : (parsed as Json);
};

export const cloakClaudeMessages = async (input: {
  res: ServerResponse;
  body: Json;
  signal: AbortSignal;
  deps: ProxyDeps;
  log: RequestLog;
}): Promise<void> => {
  const { res, body, signal, deps, log } = input;
  // Every request reaching here is gateway-rebuilt, so the default access log marks it even when
  // validation later rejects it before any upstream send.
  log.client = 'third_party';
  log.mode = 'gateway';
  log.degraded = 'not_official_client';
  const nativeRequest = toClaudeNativeRequest(body);
  if (nativeRequest.ignoredKeys.length > 0) log.ignoredKeys = nativeRequest.ignoredKeys;
  const { account, slug } = resolveAccount(deps.accounts, nativeRequest.model);
  if (account.provider !== 'claude') {
    throw createProxyError({ status: 400, message: `Model "${nativeRequest.model}" is not a Claude model; /v1/messages only serves the gateway Claude homes` });
  }
  // As in startClaudeCall, the local login read comes before any catalog call upstream.
  const { accountUuid, deviceId } = await readClaudeAccountMetadata(account.homePath);
  if (accountUuid === undefined) {
    throw createProxyError({
      status: 400,
      code: 'claude_account_required',
      message: `Claude home ${account.homePath} has no oauthAccount.accountUuid in its global config (.claude.json), so the official metadata.user_id cannot be built. ${getClaudeLoginHint(path.join(account.homePath, '.credentials.json'))}`,
    });
  }
  const settings = await readClaudeSettings(account.settingsPath);
  const liveModel = await account.catalog.findModel(slug);
  const sessionId = getSessionId(JSON.stringify([account.alias, slug, nativeRequest.firstMessage]));
  const prepared = assembleClaudeRequest({
    native: nativeRequest.native,
    modelId: slug,
    metadata: findClaudeModelMetadata(slug),
    liveModel,
    settings,
    session: { sessionId, accountUuid, ...(deviceId === undefined ? {} : { deviceId }) },
    fieldNames: ANTHROPIC_FIELD_NAMES,
  });

  log.model = `${account.alias}/${slug}`;
  recordUpstreamSend(log, { method: 'POST', url: `${account.client.baseUrl}${CLAUDE_MESSAGES_PATH}`, model: prepared.request.model });
  const upstream = await account.client.postMessages(prepared.request, { sessionId, betas: prepared.betas, signal });
  log.upstreamRequestId = upstream.headers.get('request-id') ?? undefined;
  if (!upstream.body) throw new Error('Upstream response has no body');
  try {
    if (!nativeRequest.isStream) {
      sendJson(res, 200, await collectClaudeMessage(parseClaudeSseStream(upstream.body)));
      return;
    }
    // The native SSE goes back untranslated. The client echoes thinking signatures itself, so no
    // turn state is kept.
    res.writeHead(200, SSE_HEADERS);
    try {
      for await (const chunk of upstream.body) await writeText(res, chunk);
    } catch (error) {
      // A cut stream must not end like a complete one.
      res.destroy();
      throw error;
    }
    res.end();
  } finally {
    await upstream.body.cancel().catch(() => undefined);
  }
};
