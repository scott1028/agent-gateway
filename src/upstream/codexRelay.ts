// Native relay for the official Codex CLI on /backend-api/codex/* (HTTP and WebSocket). With
// `openai_base_url` pointed at the gateway, Codex treats it as the ChatGPT backend and sends its own
// official requests (.tmp/codex-ws-capture.md, official-route capture); the gateway only checks
// that the client is logged in to the same account as a Codex home and swaps the bearer token.
// Sources: references/codex @0d58012 core/src/client.rs, codex-api/src/endpoint/responses_websocket.rs,
// model-provider-info/src/lib.rs.
import { type IncomingMessage, type ServerResponse, STATUS_CODES } from 'node:http';
import type { Socket } from 'node:net';
import { resolveAccount, type Account, type CodexAccount } from '../accounts.js';
import { CODEX_REJECTED_UPGRADE_BODY_BYTES, CODEX_WEBSOCKET_CONNECT_TIMEOUT_MS, GATEWAY_API_KEY_HEADER } from '../constants.js';
import { createProxyError, isProxyError, type ProxyError, toOpenAiErrorBody } from '../errors.js';
import { degradeCodexResponses } from './degradeCodex.js';
import type { Credentials, Json } from '../types.js';
import { recordUpstreamSend, type ProxyDeps, type RequestLog } from '../utils/http.js';
import {
  createRawRequest,
  filterRawHeaders,
  getRawHeader,
  pipeRawResponse,
  RELAY_DROPPED_REQUEST_HEADERS,
  RELAY_DROPPED_RESPONSE_HEADERS,
  replaceRawHeaders,
  sendRawRequest,
} from '../utils/rawRelay.js';

export const CODEX_RELAY_PATH_PREFIX = '/backend-api/codex/';

type CodexRelayTarget = {
  account: CodexAccount;
  // The client's own chatgpt-account-id; every send must still hold this account.
  accountId: string;
  // Raw request target below the backend base, e.g. /models?client_version=0.163.0.
  path: string;
  isDegraded?: boolean;
};

// The built-in openai provider cannot carry extra headers (model-provider-info/src/lib.rs:699-733:
// only the Bedrock providers may override http_headers), so Codex has no way to send a gateway key.
export const getCodexRelayApiKeyError = (): ProxyError =>
  createProxyError({
    status: 403,
    type: 'permission_error',
    code: 'api_key_unsupported',
    message:
      "The Codex relay (/backend-api/codex/*) works only on loopback without AGENT_GATEWAY_API_KEY: Codex's built-in openai provider cannot send the gateway key (only Bedrock may override provider headers).",
  });

const getAccountMismatchError = (accounts: Account[]): ProxyError => {
  const aliases = accounts.filter((account) => account.provider === 'codex').map((account) => account.alias).join(', ') || 'none configured';
  return createProxyError({
    status: 400,
    code: 'account_mismatch',
    message: `The Codex CLI must be logged in to the same ChatGPT account as a gateway Codex home (${aliases}); its chatgpt-account-id matches none of them.`,
  });
};

const getAbortError = (): Error => Object.assign(new Error('The relay request was cancelled'), { name: 'AbortError' });

// A getter can start an OAuth refresh, so a cancelled request (deadline passed or client gone)
// never starts another one. A refresh already running is never aborted: it finishes and saves the
// rotated token, and only the step after it is skipped.
const throwIfCancelled = (signal: AbortSignal): void => {
  if (signal.aborted) throw getAbortError();
};

// Every check happens before any upstream call. The required chatgpt-account-id is not a
// CORS-safelisted header, so a browser page can never send it without a preflight.
const getCodexRelayTarget = async (accounts: Account[], rawHeaders: string[], url: string, signal: AbortSignal): Promise<CodexRelayTarget> => {
  // The target is forwarded byte for byte, so only origin-form below the relay prefix is accepted.
  if (!url.startsWith(CODEX_RELAY_PATH_PREFIX)) {
    throw createProxyError({ status: 400, message: `The request target must be a path under ${CODEX_RELAY_PATH_PREFIX}` });
  }
  const accountId = getRawHeader(rawHeaders, 'chatgpt-account-id');
  if (accountId !== undefined && accountId !== '') {
    for (const account of accounts) {
      if (account.provider !== 'codex') continue;
      let credentials: Credentials;
      throwIfCancelled(signal);
      try {
        credentials = await account.client.getCredentials();
      } catch {
        // A home whose login cannot be read cannot be the client's account.
        throwIfCancelled(signal);
        continue;
      }
      // Cancelled while this home was read: stop here, never move on to the next home.
      throwIfCancelled(signal);
      if (credentials.accountId === accountId) return { account, accountId, path: url.slice(CODEX_RELAY_PATH_PREFIX.length - 1) };
    }
  }
  throw getAccountMismatchError(accounts);
};

// The token and its account id come from the same credentials, so checking them right before each
// send (first and after 401 recovery) means a relogin of the home never carries this request.
const verifyCodexRelayAccount = (target: CodexRelayTarget, credentials: Credentials): void => {
  if (target.isDegraded) {
    // A degraded send replaces the client's chatgpt-account-id with the home's own; with none there
    // is nothing to send, so reject before the request goes out.
    if (!credentials.accountId) {
      throw createProxyError({
        status: 400,
        code: 'account_id_required',
        message: `Gateway Codex home ${target.account.alias} has no ChatGPT account id in its credentials, so the degraded relay request was not sent. Log that home in to a ChatGPT account and retry.`,
      });
    }
    return;
  }
  if (credentials.accountId === target.accountId) return;
  throw createProxyError({
    status: 400,
    code: 'account_mismatch',
    message: `Gateway Codex home ${target.account.alias} is now logged in to a different ChatGPT account than the Codex CLI, so the request was not sent. Log that home back in to the same account and retry.`,
  });
};


// Bounded like createCodexClient's sendWithAuth: one retry after a 401, never more. Credentials and
// recovery can take long (a refresh), so a cancelled request is checked again before every send.
// The abandoned first 401 is destroyed, never left reading; the final 401 goes back to the client.
const sendWithCodexRelayAuth = async <T>(
  target: CodexRelayTarget,
  signal: AbortSignal,
  send: (credentials: Credentials) => Promise<T>,
  getIsUnauthorized: (response: T) => boolean,
  destroy: (response: T) => void,
): Promise<T> => {
  throwIfCancelled(signal);
  let credentials = await target.account.client.getCredentials();
  try {
    throwIfCancelled(signal);
    verifyCodexRelayAccount(target, credentials);
    const response = await send(credentials);
    if (!getIsUnauthorized(response)) return response;
    destroy(response);
    throwIfCancelled(signal);
    credentials = await target.account.client.recoverUnauthorized(credentials.accessToken);
    throwIfCancelled(signal);
    verifyCodexRelayAccount(target, credentials);
    return await send(credentials);
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') throw error;
    if (isProxyError(error)) throw error;
    throw createProxyError({ status: 502, code: 'upstream_unreachable', message: `Upstream request failed: ${String(error)}` });
  }
};

type CodexHttpInput = {
  req: IncomingMessage;
  res: ServerResponse;
  rawBody: Buffer;
  signal: AbortSignal;
  deps: ProxyDeps;
  log: RequestLog;
};

const sendCodexHttp = async (input: CodexHttpInput, target: CodexRelayTarget): Promise<void> => {
  const { req, res, rawBody: body, signal, log } = input;
  log.model = target.account.alias;
  log.client = 'official';
  log.mode = target.isDegraded ? 'gateway' : 'relay';
  const headers = filterRawHeaders(req.rawHeaders, RELAY_DROPPED_REQUEST_HEADERS);
  // A body-less GET must not gain a content-length the client never sent.
  const hasContentLength = getRawHeader(req.rawHeaders, 'content-length') !== undefined || body.length > 0;
  const baseUrl = new URL(target.account.client.baseUrl);
  const path = `${baseUrl.pathname.replace(/\/$/, '')}${target.path}`;
  // A pure relay does not parse the body, so its send line carries no model. Recorded inside the
  // send closure: an account check that refuses before the wire must not print a send line.
  const upstream = await sendWithCodexRelayAuth(
    target,
    signal,
    (credentials) => {
      recordUpstreamSend(log, { method: req.method ?? 'GET', url: `${baseUrl.origin}${path}` });
      return sendRawRequest({
        baseUrl,
        path,
        method: req.method ?? 'GET',
        // A Map, not an object: names such as `constructor` or `__proto__` must not hit Object.prototype.
        headers: replaceRawHeaders(
          headers,
          new Map([
            ['host', baseUrl.host],
            ['authorization', `Bearer ${credentials.accessToken}`],
            // verifyCodexRelayAccount has already rejected a degraded send without an account id.
            ...(target.isDegraded ? [['chatgpt-account-id', credentials.accountId!] as [string, string]] : []),
            ...(hasContentLength ? [['content-length', String(body.length)] as [string, string]] : []),
          ]),
        ),
        body,
        signal,
      });
    },
    (response) => response.statusCode === 401,
    (response) => response.destroy(),
  );
  log.upstreamRequestId = getRawHeader(upstream.rawHeaders, 'x-request-id');
  await pipeRawResponse(res, upstream);
};

export const relayCodexHttp = async (input: CodexHttpInput): Promise<void> => {
  const { req, res, rawBody, signal, deps, log } = input;
  try {
    const target = await getCodexRelayTarget(deps.accounts, req.rawHeaders, req.url ?? '', signal);
    await sendCodexHttp(input, target);
  } catch (error) {
    if (deps.relayFallback !== 'degrade' || res.headersSent || signal.aborted || !isProxyError(error) || error.status !== 400 || error.code !== 'account_mismatch') throw error;
    const reason = log.model ? 'account_changed' : 'account_mismatch';
    const path = (req.url ?? '').slice(CODEX_RELAY_PATH_PREFIX.length - 1);
    if (req.method === 'POST' && path.split('?')[0] === '/responses') {
      let body: Json = {};
      if (rawBody.length > 0) {
        let parsed: unknown;
        try { parsed = JSON.parse(rawBody.toString('utf8')); }
        catch { throw createProxyError({ status: 400, message: 'Request body must be valid JSON' }); }
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw createProxyError({ status: 400, message: 'Request body must be a JSON object' });
        body = parsed as Json;
      }
      log.degraded = reason;
      await degradeCodexResponses({ body, res, signal, deps, log });
      return;
    }
    // Non-Responses endpoints keep the official client's own headers/body; only credentials change.
    // The body is forwarded as sent; it is parsed only to pick the account when it names a model.
    log.degraded = reason;
    let model: unknown;
    if (rawBody.length > 0) {
      try {
        const parsed: unknown = JSON.parse(rawBody.toString('utf8'));
        if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) model = (parsed as Json).model;
      } catch { /* not JSON: forwarded as-is with the first Codex account */ }
    }
    const account = model === undefined
      ? deps.accounts.find((candidate): candidate is CodexAccount => candidate.provider === 'codex')
      : resolveAccount(deps.accounts, model).account;
    if (account === undefined || account.provider !== 'codex') throw createProxyError({ status: 400, message: 'No Codex account configured for fallback' });
    await sendCodexHttp(input, { account, accountId: '', path, isDegraded: true });
  }
};

// The upgrade mechanism itself (connection, upgrade, sec-websocket-*) must reach upstream, so only
// body framing and the gateway's own key are dropped from a handshake.
const UPGRADE_DROPPED_REQUEST_HEADERS = new Set(['keep-alive', 'transfer-encoding', GATEWAY_API_KEY_HEADER]);

type UpgradeOutcome =
  | { kind: 'upgrade'; response: IncomingMessage; socket: Socket; head: Buffer }
  | { kind: 'response'; response: IncomingMessage };

// An upgrade socket has no ServerResponse, so the status line and headers are written by hand.
// Node's rawHeaders hold header octets as latin1 strings, so latin1 turns them back into the same
// bytes (a plain string write would re-encode obs-text such as 0xe9 as UTF-8).
const writeRawHead = (socket: Socket, status: number, statusMessage: string, rawHeaders: string[]): void => {
  const lines = [`HTTP/1.1 ${status} ${statusMessage}`];
  for (let index = 0; index < rawHeaders.length; index += 2) lines.push(`${rawHeaders[index]}: ${rawHeaders[index + 1]}`);
  socket.write(Buffer.from(`${lines.join('\r\n')}\r\n\r\n`, 'latin1'));
};

const writeRawReply = (socket: Socket, status: number, statusMessage: string, rawHeaders: string[], body: Buffer): void => {
  const headers = replaceRawHeaders(rawHeaders, new Map([['content-length', String(body.length)], ['connection', 'close']]));
  writeRawHead(socket, status, statusMessage, headers);
  socket.end(body);
};

// Gateway-made errors before the upgrade use the OpenAI error body, like every Codex route.
export const rejectCodexUpgrade = (socket: Socket, error: unknown): number => {
  const proxyError = isProxyError(error)
    ? error
    : createProxyError({ status: 500, message: error instanceof Error ? error.message : String(error) });
  if (socket.writable) {
    writeRawReply(socket, proxyError.status, STATUS_CODES[proxyError.status] ?? '', ['content-type', 'application/json'], Buffer.from(JSON.stringify(toOpenAiErrorBody(proxyError))));
  }
  return proxyError.status;
};

// The capped body of a rejected upgrade; reading stops at the cap.
const readRejectedBody = async (response: IncomingMessage): Promise<Buffer> => {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of response) {
    chunks.push((chunk as Buffer).subarray(0, CODEX_REJECTED_UPGRADE_BODY_BYTES - size));
    size += (chunk as Buffer).length;
    if (size >= CODEX_REJECTED_UPGRADE_BODY_BYTES) {
      response.destroy();
      break;
    }
  }
  return Buffer.concat(chunks);
};

// A graceful close (close frames, then FIN) travels through the pipes end to end; an abrupt one
// tears the other side down, so no socket outlives its peer.
const connectSockets = (client: Socket, upstream: Socket): void => {
  client.setNoDelay(true);
  upstream.setNoDelay(true);
  client.on('error', () => upstream.destroy());
  upstream.on('error', () => client.destroy());
  client.on('close', () => upstream.destroySoon());
  upstream.on('close', () => client.destroySoon());
  client.pipe(upstream);
  upstream.pipe(client);
};

const destroyOutcome = (outcome: UpgradeOutcome): void => {
  if (outcome.kind === 'upgrade') outcome.socket.destroy();
  outcome.response.destroy();
};

// WebSocket relay as a byte tunnel: the client's own handshake goes upstream with only host and
// authorization replaced (its sec-websocket-key and permessage-deflate offer included), upstream's
// own 101 goes back as sent (x-codex-turn-state, openai-model, ...), and then frames, compression,
// ping/pong and close codes run end to end between Codex and the backend. Rejections (426, 401, ...)
// come back with their status and capped body, so Codex can fall back to HTTP as it does officially.
// Returns the status sent to the client.
export const relayCodexUpgrade = async (input: {
  req: IncomingMessage;
  socket: Socket;
  head: Buffer;
  deps: ProxyDeps;
  log: RequestLog;
}): Promise<number> => {
  const { req, socket, head, deps, log } = input;
  // The request lifetime starts before the first await, so account resolution, credentials,
  // recovery, both attempts and a rejected body all share one deadline and one client-gone signal.
  const lifetime = new AbortController();
  let isTimedOut = false;
  const deadline = setTimeout(() => {
    isTimedOut = true;
    lifetime.abort();
  }, deps.codexWebSocketConnectTimeoutMs ?? CODEX_WEBSOCKET_CONNECT_TIMEOUT_MS);
  // A FIN (end) means the client stopped waiting just like a reset (close) does.
  const handleClientGone = (): void => lifetime.abort();
  socket.on('end', handleClientGone);
  socket.on('close', handleClientGone);
  if (socket.readableEnded || socket.destroyed) lifetime.abort();
  const dispose = (): void => {
    clearTimeout(deadline);
    socket.off('end', handleClientGone);
    socket.off('close', handleClientGone);
  };
  // Settles only by rejecting, the moment the lifetime ends; awaited through Promise.race.
  const lifetimeEnded = new Promise<never>((_, reject) => {
    lifetime.signal.addEventListener('abort', () => reject(getAbortError()), { once: true });
  });

  const outcomePromise = (async (): Promise<UpgradeOutcome> => {
    const target = await getCodexRelayTarget(deps.accounts, req.rawHeaders, req.url ?? '', lifetime.signal);
    log.model = target.account.alias;
    log.client = 'official';
    log.mode = 'relay';
    const baseUrl = new URL(target.account.client.baseUrl);
    const path = `${baseUrl.pathname.replace(/\/$/, '')}${target.path}`;
    const headers = filterRawHeaders(req.rawHeaders, UPGRADE_DROPPED_REQUEST_HEADERS);
    return sendWithCodexRelayAuth<UpgradeOutcome>(
      target,
      lifetime.signal,
      (credentials) => {
        // Recorded inside the send closure, like the HTTP relay: a refused account check never
        // reaches the wire and must not print a send line.
        recordUpstreamSend(log, { method: req.method ?? 'GET', url: `${baseUrl.origin}${path}` });
        return new Promise((resolve, reject) => {
          const request = createRawRequest({
            baseUrl,
            path,
            method: req.method ?? 'GET',
            headers: replaceRawHeaders(headers, new Map([['host', baseUrl.host], ['authorization', `Bearer ${credentials.accessToken}`]])),
            signal: lifetime.signal,
          });
          request.on('upgrade', (response, upstreamSocket, upstreamHead) => resolve({ kind: 'upgrade', response, socket: upstreamSocket, head: upstreamHead }));
          request.on('response', (response) => resolve({ kind: 'response', response }));
          request.on('error', reject);
          request.end();
        });
      },
      (outcome) => outcome.kind === 'response' && outcome.response.statusCode === 401,
      destroyOutcome,
    );
  })();

  let outcome: UpgradeOutcome | undefined;
  try {
    outcome = await Promise.race([outcomePromise, lifetimeEnded]);
    log.upstreamRequestId = getRawHeader(outcome.response.rawHeaders, 'x-request-id');
    if (outcome.kind === 'response') {
      const body = await Promise.race([readRejectedBody(outcome.response), lifetimeEnded]);
      const status = outcome.response.statusCode ?? 502;
      dispose();
      writeRawReply(socket, status, outcome.response.statusMessage ?? '', filterRawHeaders(outcome.response.rawHeaders, RELAY_DROPPED_RESPONSE_HEADERS), body);
      return status;
    }
    // Hand-off: from here the tunnel owns both sockets, so no lifetime hook may touch them.
    dispose();
    if (!socket.writable || socket.readableEnded) {
      destroyOutcome(outcome);
      socket.destroy();
      return 499;
    }
    writeRawHead(socket, 101, outcome.response.statusMessage ?? 'Switching Protocols', outcome.response.rawHeaders);
    if (outcome.head.length > 0) socket.write(outcome.head);
    if (head.length > 0) outcome.socket.write(head);
    connectSockets(socket, outcome.socket);
    return 101;
  } catch (error) {
    // An attempt nobody will use is torn down, including one that finishes later (after a slow
    // refresh, say); the refresh itself is never aborted, so it can still save the rotated token.
    if (outcome === undefined) void outcomePromise.then(destroyOutcome, () => undefined);
    else destroyOutcome(outcome);
    if (!lifetime.signal.aborted) {
      if (deps.relayFallback === 'degrade' && isProxyError(error) && error.status === 400 && error.code === 'account_mismatch') {
        log.degraded = log.model ? 'account_changed' : 'account_mismatch';
        // references/codex core/src/client.rs:1622/2053 switches this session to HTTP on 426.
        return rejectCodexUpgrade(socket, createProxyError({ status: 426, message: 'Account changed; retry over HTTP for gateway fallback.' }));
      }
      throw error;
    }
    if (isTimedOut) {
      throw createProxyError({ status: 504, code: 'upstream_timeout', message: 'The upstream WebSocket handshake did not finish in time' });
    }
    // The client left: there is nobody to answer.
    socket.destroy();
    throw createProxyError({ status: 499, message: 'The client closed the connection before the upstream handshake finished' });
  } finally {
    dispose();
  }
};
