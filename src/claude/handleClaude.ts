// Shared Claude request path for both OpenAI-compatible endpoints: prepare the native request,
// send it, and hand back translated Responses events. Endpoint handlers keep their own output
// formatting so Codex behaviour stays untouched.
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { createProxyError } from '../errors.js';
import { CLAUDE_MESSAGES_PATH } from '../constants.js';
import type { Json } from '../types.js';
import { recordUpstreamSend, type ProxyDeps, type RequestLog } from '../utils/http.js';
import { getSessionId } from '../responses/normalizeResponsesRequest.js';
import type { ClaudeAccount } from '../accounts.js';
import { getClaudeLoginHint, readClaudeAccountMetadata } from './auth.js';
import { findClaudeModelMetadata } from './modelMetadata.js';
import { getClaudeBoundaryStateKey, prepareClaudeRequest, validateClaudeResponsesInput, type PreparedClaudeRequest } from './normalizeRequest.js';
import { readClaudeSettings } from './settings.js';
import {
  getClaudeAccountIdentity,
  getClaudeAssistantBoundaries,
  getClaudeConversationIdentity,
  getClaudeInputItems,
  getClaudeNativeVisibleIdentity,
  getClaudeStateKey,
} from './state.js';
import type { ClaudeTurnState } from './types.js';
import type { ClaudeStreamMeta } from './toResponsesEvents.js';

export type ClaudeCall = {
  upstream: Response;
  meta: ClaudeStreamMeta;
  prepared: PreparedClaudeRequest;
  // Called with the native assistant content and its tool call ids; the record is keyed by the
  // conversation prefix plus the turn's visible identity, so two branches of the same prefix
  // coexist and each continuation finds its own signed turn.
  saveState: (nativeContent: Json[], callIds: string[]) => Promise<void>;
};

const getResponseId = (): string => `resp_${randomUUID().replace(/-/g, '')}`;

export const startClaudeCall = async (input: {
  account: ClaudeAccount;
  slug: string;
  body: Json;
  signal: AbortSignal;
  deps: ProxyDeps;
  log: RequestLog;
}): Promise<ClaudeCall> => {
  const { account, slug, body, signal, deps, log } = input;
  // Validate the accepted surface before any identity read: malformed input must be a 400 here,
  // not a TypeError from the identity scan.
  validateClaudeResponsesInput(body);
  const items = getClaudeInputItems(body);
  const instructions = typeof body.instructions === 'string' ? body.instructions : undefined;
  // Re-read the login identity for every call BEFORE any catalog access (the catalog may call
  // /v1/models upstream): a re-login between requests must not keep replaying the previous
  // account's signed state just because the process never restarted. Signed replay requires a
  // PROVEN account identity: without the home's account record, a re-login would keep the same
  // state key while auth adopts the new token, so the request fails explicitly instead — and
  // without spending any upstream traffic.
  const { accountUuid, deviceId } = await readClaudeAccountMetadata(account.homePath);
  if (accountUuid === undefined) {
    throw createProxyError({
      status: 400,
      code: 'claude_account_required',
      message: `Claude home ${account.homePath} has no oauthAccount.accountUuid in its global config (.claude.json), so signed turns cannot be isolated per account. ${getClaudeLoginHint(path.join(account.homePath, '.credentials.json'))}`,
    });
  }
  const settings = await readClaudeSettings(account.settingsPath);
  const liveModel = await account.catalog.findModel(slug);
  const metadata = findClaudeModelMetadata(slug);
  const accountIdentity = getClaudeAccountIdentity(account.homePath, accountUuid);
  const conversationIdentity = getClaudeConversationIdentity(items, { instructions });

  // Every assistant boundary may have signed content that the client cannot echo, so each one is
  // looked up by its own prefix plus the visible identity of the echoed turn. Only the unfinished
  // tool turn pins its thinking configuration.
  const boundaryStates = new Map<string, ClaudeTurnState>();
  let pendingState: ClaudeTurnState | undefined;
  for (const boundary of getClaudeAssistantBoundaries(items, { instructions })) {
    const record = await account.state.read(getClaudeStateKey(accountIdentity, slug, `${boundary.prefixIdentity}\u0000${boundary.visibleIdentity}`));
    if (record === undefined) continue;
    if (record.alias !== account.alias || record.model !== slug) {
      throw createProxyError({ status: 400, message: 'Claude turn state belongs to another account or model; start a new conversation' });
    }
    // A record copied under another key must fail here, not be replayed upstream.
    if (record.accountIdentity !== accountIdentity || record.identity !== `${boundary.prefixIdentity}\u0000${boundary.visibleIdentity}`) {
      throw createProxyError({ status: 400, message: 'Claude turn state does not belong to this conversation; start a new conversation' });
    }
    boundaryStates.set(getClaudeBoundaryStateKey(boundary), record);
    if (boundary.isPendingToolTurn) pendingState = record;
  }

  const sessionId = getSessionId(JSON.stringify([account.alias, slug, items[0] ?? null, items.find((item) => item.role === 'user') ?? null]));
  const prepared = prepareClaudeRequest({
    body,
    modelId: slug,
    alias: account.alias,
    metadata,
    liveModel,
    settings,
    state: pendingState,
    boundaryStates,
    session: { sessionId, accountUuid, ...(deviceId === undefined ? {} : { deviceId }) },
  });

  log.model = `${account.alias}/${slug}`;
  recordUpstreamSend(log, { method: 'POST', url: `${account.client.baseUrl}${CLAUDE_MESSAGES_PATH}`, model: prepared.request.model });
  const upstream = await account.client.postMessages(prepared.request, { sessionId, betas: prepared.betas, signal });
  log.upstreamRequestId = upstream.headers.get('request-id') ?? undefined;

  const meta: ClaudeStreamMeta = {
    id: getResponseId(),
    model: slug,
    created: Math.floor((deps.now ?? Date.now)() / 1000),
  };
  const saveState = async (nativeContent: Json[], callIds: string[]): Promise<void> => {
    await account.state.save({
      accountIdentity,
      alias: account.alias,
      model: slug,
      identity: `${conversationIdentity}\u0000${getClaudeNativeVisibleIdentity(nativeContent)}`,
      thinking: prepared.thinking,
      assistantContent: nativeContent,
      callIds,
    });
  };
  return { upstream, meta, prepared, saveState };
};
