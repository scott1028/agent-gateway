// Native relay for the official Claude Code CLI on POST /v1/messages (and its count_tokens). With
// _CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL=1 the client builds the first-party request itself
// (native 2.1.302: billing builder GPo at 237985931, first-party gate xi at 235237156, SDK client
// with custom headers at 238472365), so the gateway only checks that it is that request, picks
// the home logged in to the same account and swaps the bearer token. Client detection follows
// references/CLIProxyAPI v8.0.29 internal/runtime/executor/helps/claude_client_detection.go.
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Account, ClaudeAccount } from '../accounts.js';
import { CLAUDE_OAUTH_BETA, CLAUDE_RELAY_SESSION_MAX_ENTRIES, MODEL_ID_SEPARATOR } from '../constants.js';
import { createProxyError, isProxyError, type ProxyError } from '../errors.js';
import type { Json } from '../types.js';
import { recordUpstreamSend, type ProxyDeps, type RequestLog } from '../utils/http.js';
import { filterRawHeaders, getRawHeader, pipeRawResponse, RELAY_DROPPED_REQUEST_HEADERS } from '../utils/rawRelay.js';
import { degradeClaudeMessages } from './degradeRelay.js';
import { readClaudeAccountMetadata } from './auth.js';

export type ClaudeRelayRequest = {
  account: ClaudeAccount;
  // The client's metadata.user_id account; the home must still hold it at every send.
  accountUuid: string;
  // Model id as sent upstream, for the request log.
  model: string;
  body: Uint8Array;
  // Client headers in rawHeaders form and arrival order; the transport fills in host,
  // authorization and content-length for the upstream hop.
  headers: string[];
  // Raw request target, never re-encoded.
  pathAndQuery: string;
};

// The home and account a /v1/messages request of one Claude Code session passed the same-account
// check with. count_tokens carries no metadata.user_id, so this is the only proof of its account.
export type ClaudeRelaySession = { alias: string; accountUuid: string };

export type ClaudeRelaySessions = {
  get: (sessionId: string) => ClaudeRelaySession | undefined;
  save: (sessionId: string, session: ClaudeRelaySession) => void;
};

const QUOTE = 0x22;
const BACKSLASH = 0x5c;
const COLON = 0x3a;
const COMMA = 0x2c;
const OPEN_BRACE = 0x7b;
const OPEN_BRACKET = 0x5b;
const CLOSE_BRACE = 0x7d;
const CLOSE_BRACKET = 0x5d;
const JSON_WHITESPACE = new Set([0x20, 0x09, 0x0a, 0x0d]);

// Wl() at native 2.1.302 offset 238462490 puts it on every request of the session, count_tokens included.
const SESSION_HEADER = 'x-claude-code-session-id';

const toRelayError = (message: string, code?: string): ProxyError => createProxyError({ status: 400, type: 'invalid_request_error', message, code });
const DEGRADABLE_CODES = new Set(['missing_cch', 'missing_oauth', 'account_mismatch', 'alias_mismatch', 'unbound_session', 'account_changed']);

// In-memory LRU keyed by x-claude-code-session-id, the same Map-order scheme as responseStore.ts.
export const createClaudeRelaySessions = (): ClaudeRelaySessions => {
  const sessions = new Map<string, ClaudeRelaySession>();
  return {
    get: (sessionId) => {
      const session = sessions.get(sessionId);
      if (session !== undefined) {
        sessions.delete(sessionId);
        sessions.set(sessionId, session);
      }
      return session;
    },
    save: (sessionId, session) => {
      sessions.delete(sessionId);
      sessions.set(sessionId, session);
      for (const oldestId of sessions.keys()) {
        if (sessions.size <= CLAUDE_RELAY_SESSION_MAX_ENTRIES) break;
        sessions.delete(oldestId);
      }
    },
  };
};

// metadata.user_id is a JSON string built by the native metadata builder; anything else is not
// Claude Code.
const parseUserId = (metadata: unknown): Json | undefined => {
  const userId = typeof metadata === 'object' && metadata !== null ? (metadata as Json).user_id : undefined;
  if (typeof userId !== 'string') return undefined;
  try {
    const parsed: unknown = JSON.parse(userId);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? (parsed as Json) : undefined;
  } catch {
    return undefined;
  }
};

// Byte offset just past the JSON string whose opening quote is at `start`.
const getJsonStringEnd = (bytes: Uint8Array, start: number): number => {
  for (let index = start + 1; index < bytes.length; index += 1) {
    if (bytes[index] === BACKSLASH) index += 1;
    else if (bytes[index] === QUOTE) return index + 1;
  }
  return bytes.length;
};

// Replaces only the value bytes of the top-level "model" member, so every other byte of the
// client body stays as sent. JSON structure is ASCII, so the scan never splits a UTF-8 sequence.
// The last duplicate key wins, matching JSON.parse.
const replaceTopLevelModel = (raw: Buffer, model: string): Buffer => {
  let depth = 0;
  let isKeyNext = false;
  let span: [number, number] | undefined;
  for (let index = 0; index < raw.length; index += 1) {
    const byte = raw[index];
    if (byte === QUOTE) {
      const end = getJsonStringEnd(raw, index);
      if (depth !== 1 || !isKeyNext) {
        index = end - 1;
        continue;
      }
      isKeyNext = false;
      let valueStart = end;
      while (raw[valueStart] !== COLON) valueStart += 1;
      valueStart += 1;
      while (JSON_WHITESPACE.has(raw[valueStart] ?? 0)) valueStart += 1;
      if (raw[valueStart] === QUOTE && JSON.parse(raw.toString('utf8', index, end)) === 'model') {
        span = [valueStart, getJsonStringEnd(raw, valueStart)];
      }
      index = valueStart - 1;
    } else if (byte === OPEN_BRACE || byte === OPEN_BRACKET) {
      depth += 1;
      if (depth === 1) isKeyNext = byte === OPEN_BRACE;
    } else if (byte === CLOSE_BRACE || byte === CLOSE_BRACKET) {
      depth -= 1;
    } else if (byte === COMMA && depth === 1) {
      isKeyNext = true;
    }
  }
  if (span === undefined) return raw;
  return Buffer.concat([raw.subarray(0, span[0]), Buffer.from(JSON.stringify(model)), raw.subarray(span[1])]);
};

// Three of CPA's strong signals. The claude-code-20250219 beta is not required: native helper
// requests may omit it. Requests that fail it take the downgrade path (cloakMessages.ts).
export const getIsClaudeCodeRequest = (rawHeaders: string[], body: Json): boolean => {
  const userId = parseUserId(body.metadata);
  return (
    getRawHeader(rawHeaders, 'x-app') === 'cli' &&
    /^claude-cli\//i.test(getRawHeader(rawHeaders, 'user-agent') ?? '') &&
    typeof userId?.device_id === 'string' &&
    typeof userId.session_id === 'string'
  );
};

// The target is forwarded byte for byte, so only origin-form (/v1/messages?...) is accepted.
const parseRelayBody = (url: string, rawBody: Buffer): Json => {
  if (!url.startsWith('/')) throw toRelayError('The request target must be a path such as /v1/messages?beta=true');
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody.toString('utf8'));
  } catch {
    throw toRelayError('Request body must be valid JSON');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw toRelayError('Request body must be a JSON object');
  }
  return parsed as Json;
};

const assertOAuthBeta = (headers: string[]): void => {
  const betas = (getRawHeader(headers, 'anthropic-beta') ?? '').split(',').map((beta) => beta.trim());
  if (!betas.includes(CLAUDE_OAUTH_BETA)) {
    throw toRelayError(
      `Log Claude Code in with a Claude subscription first (run \`claude\`, then /login); requests without the ${CLAUDE_OAUTH_BETA} beta come from an auth token or API key login and are not relayed.`, 'missing_oauth',
    );
  }
};

// cch hashes the body with model blanked (attribution.ts), so dropping the alias keeps it valid.
const toRelayBody = (rawBody: Buffer, body: Json, account: ClaudeAccount): { model: string; body: Buffer } => {
  const model = typeof body.model === 'string' ? body.model : '';
  const separatorIndex = model.indexOf(MODEL_ID_SEPARATOR);
  if (separatorIndex === -1) return { model, body: rawBody };
  const alias = model.slice(0, separatorIndex);
  if (alias !== account.alias) {
    throw toRelayError(`Model alias "${alias}" does not match the gateway Claude home of this login (${account.alias}).`, 'alias_mismatch');
  }
  const modelId = model.slice(separatorIndex + 1);
  if (modelId === '') throw toRelayError(`Missing model name after "${alias}${MODEL_ID_SEPARATOR}"`);
  return { model: modelId, body: replaceTopLevelModel(rawBody, modelId) };
};

// Every rejection happens before any upstream call.
export const getClaudeRelayRequest = async (input: {
  accounts: Account[];
  rawHeaders: string[];
  rawBody: Buffer;
  url: string;
}): Promise<ClaudeRelayRequest> => {
  const { accounts, rawHeaders: headers, rawBody, url } = input;
  const body = parseRelayBody(url, rawBody);

  const userId = parseUserId(body.metadata);
  if (!getIsClaudeCodeRequest(headers, body)) {
    throw toRelayError(
      'agent-gateway relays /v1/messages only for the official Claude Code CLI (x-app: cli, a claude-cli/ User-Agent and metadata.user_id with device_id and session_id).',
    );
  }

  // GPo signs the billing block (cch) only when xi() treats the base URL as first-party.
  const billingBlock = Array.isArray(body.system) ? (body.system[0] as Json | undefined) : undefined;
  const billingText = typeof billingBlock?.text === 'string' ? billingBlock.text : '';
  if (!billingText.startsWith('x-anthropic-billing-header:') || !billingText.includes(' cch=')) {
    throw toRelayError(
      'Start Claude Code with _CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL=1. Without it a custom ANTHROPIC_BASE_URL makes the client itself send a reduced request (no cch billing signature, fewer betas and tools), which the gateway cannot relay as the official request.', 'missing_cch',
    );
  }

  assertOAuthBeta(headers);

  // The account is chosen by the client's login, never by the model alias. Re-read per request so
  // a re-login of either side takes effect without a restart.
  const claudeAccounts = accounts.filter((account): account is ClaudeAccount => account.provider === 'claude');
  const accountUuid = typeof userId?.account_uuid === 'string' ? userId.account_uuid : '';
  let account: ClaudeAccount | undefined;
  if (accountUuid !== '') {
    for (const candidate of claudeAccounts) {
      if ((await readClaudeAccountMetadata(candidate.homePath)).accountUuid === accountUuid) {
        account = candidate;
        break;
      }
    }
  }
  if (account === undefined) {
    const aliases = claudeAccounts.map((candidate) => candidate.alias).join(', ') || 'none configured';
    throw toRelayError(`Claude Code must be logged in to the same account as a gateway Claude home (${aliases}); the client's account matches none of them.`, 'account_mismatch');
  }

  const { model, body: relayBody } = toRelayBody(rawBody, body, account);
  return { account, accountUuid, model, body: relayBody, headers: filterRawHeaders(headers, RELAY_DROPPED_REQUEST_HEADERS), pathAndQuery: url };
};

// count_tokens of the official Claude Code: native 2.1.302 DFe (offset 243429208) sends it through
// the same GU client, so it has the session header but no metadata.user_id. The caller has
// already matched the Claude Code headers; the account comes from the session binding.
export const getClaudeCountTokensRequest = (input: {
  accounts: Account[];
  sessions: ClaudeRelaySessions;
  rawHeaders: string[];
  rawBody: Buffer;
  url: string;
}): ClaudeRelayRequest => {
  const { accounts, sessions, rawHeaders: headers, rawBody, url } = input;
  const body = parseRelayBody(url, rawBody);
  assertOAuthBeta(headers);
  const sessionId = getRawHeader(headers, SESSION_HEADER);
  const session = sessionId === undefined ? undefined : sessions.get(sessionId);
  const account = accounts.find((candidate): candidate is ClaudeAccount => candidate.provider === 'claude' && candidate.alias === session?.alias);
  if (session === undefined || account === undefined) {
    throw toRelayError(
      `count_tokens is relayed only for a Claude Code session that already passed the same-account check on /v1/messages; send /v1/messages in this session (the same ${SESSION_HEADER}) first.`, 'unbound_session',
    );
  }
  const { model, body: relayBody } = toRelayBody(rawBody, body, account);
  return { account, accountUuid: session.accountUuid, model, body: relayBody, headers: filterRawHeaders(headers, RELAY_DROPPED_REQUEST_HEADERS), pathAndQuery: url };
};

// Status, headers (names, casing, order, repeats) and body bytes come back as upstream sent them,
// errors and redirects included, still encoded; a client that disconnects aborts `signal`, which
// cancels the upstream request.
const sendClaudeRelay = async (res: ServerResponse, relay: ClaudeRelayRequest, signal: AbortSignal, log: RequestLog): Promise<void> => {
  log.model = `${relay.account.alias}/${relay.model}`;
  log.client = 'official';
  log.mode = 'relay';
  // Local file read only, no OAuth preflight: the body stays bound to the client's account, so a
  // home that now holds another login is refused instead of re-signed for it.
  // Same URL the transport builds (src/claude/client.ts sendRawMessages), for the access log;
  // postRawMessages runs verifyAccount before every attempt, so recording after it prints a send
  // line only for sends that reach the wire.
  const target = new URL(relay.account.client.baseUrl);
  const sendUrl = `${target.origin}${target.pathname.replace(/\/$/, '')}${relay.pathAndQuery}`;
  const verifyAccount = async (): Promise<void> => {
    if ((await readClaudeAccountMetadata(relay.account.homePath)).accountUuid !== relay.accountUuid) {
      throw toRelayError(
        `Gateway Claude home ${relay.account.alias} is now logged in to a different account than Claude Code, so the request was not sent. Log that home back in to the same account as Claude Code and retry.`, 'account_changed',
      );
    }
    recordUpstreamSend(log, { method: 'POST', url: sendUrl, model: relay.model });
  };
  const upstream = await relay.account.client.postRawMessages({ body: relay.body, headers: relay.headers, pathAndQuery: relay.pathAndQuery, signal, verifyAccount });
  log.upstreamRequestId = getRawHeader(upstream.rawHeaders, 'request-id');
  await pipeRawResponse(res, upstream);
};

type RelayInput = {
  req: IncomingMessage;
  res: ServerResponse;
  rawBody: Buffer;
  signal: AbortSignal;
  deps: ProxyDeps;
  log: RequestLog;
  sessions: ClaudeRelaySessions;
};

const relayClaudeRequest = async (input: RelayInput, isCountTokens: boolean): Promise<void> => {
  const { req, res, rawBody, signal, deps, log, sessions } = input;
  try {
    const relay = isCountTokens
      ? getClaudeCountTokensRequest({ accounts: deps.accounts, sessions, rawHeaders: req.rawHeaders, rawBody, url: req.url ?? '' })
      : await getClaudeRelayRequest({ accounts: deps.accounts, rawHeaders: req.rawHeaders, rawBody, url: req.url ?? '' });
    // Bound once every entry check has passed; the send-time account check still applies.
    const sessionId = getRawHeader(req.rawHeaders, SESSION_HEADER);
    if (!isCountTokens && sessionId) sessions.save(sessionId, { alias: relay.account.alias, accountUuid: relay.accountUuid });
    await sendClaudeRelay(res, relay, signal, log);
  } catch (error) {
    if (deps.relayFallback !== 'degrade' || res.headersSent || !isProxyError(error) || error.status !== 400 || !DEGRADABLE_CODES.has(error.code ?? '')) throw error;
    log.degraded = error.code;
    await degradeClaudeMessages({ ...input, body: parseRelayBody(req.url ?? '', rawBody), isCountTokens });
  }
};

export const relayClaudeMessages = (input: RelayInput): Promise<void> => relayClaudeRequest(input, false);
export const relayClaudeCountTokens = (input: RelayInput): Promise<void> => relayClaudeRequest(input, true);
