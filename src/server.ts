import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type OutgoingHttpHeaders, type Server, type ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import { listAccountModels } from './accounts.js';
import { handleChatCompletions } from './chat/handleChatCompletions.js';
import { type ClaudeRelaySessions, cloakClaudeMessages, createClaudeRelaySessions, getClaudeCloakBody, relayClaudeCountTokens, relayClaudeMessages } from './claude/index.js';
import { GATEWAY_API_KEY_HEADER, LOCAL_HOSTNAMES, MAX_BODY_BYTES } from './constants.js';
import { createProxyError, isProxyError, type ProxyError, toAnthropicErrorBody, toOpenAiErrorBody } from './errors.js';
import { handleResponses } from './responses/handleResponses.js';
import { createResponseStore, type ResponseStore } from './responses/responseStore.js';
import { CODEX_RELAY_PATH_PREFIX, getCodexRelayApiKeyError, rejectCodexUpgrade, relayCodexHttp, relayCodexUpgrade } from './upstream/codexRelay.js';
import { getDebugPrefix, getDebugSeparator, getFormattedBody, getMaskedAuthorization } from './utils/debugFetch.js';
import { createReasoningStore } from './utils/reasoningStore.js';
import { getRequestHeader, type ProxyDeps, readJsonBody, readRawBody, type RequestLog, sendJson } from './utils/http.js';

// Native Claude Code relay (src/claude/relayMessages.ts) or, for other clients, the downgrade
// path (src/claude/cloakMessages.ts); both answer errors in the Anthropic shape. count_tokens is
// relayed for Claude Code sessions bound by a relayed /v1/messages, and refused for other clients.
const CLAUDE_RELAY_ROUTE = 'POST /v1/messages';
const CLAUDE_COUNT_TOKENS_ROUTE = 'POST /v1/messages/count_tokens';

// Rejects DNS-rebinding requests: browsers send the attacker's hostname in Host.
const getIsLocalHost = (host: string | undefined): boolean => {
  if (!host) return false;
  try {
    return LOCAL_HOSTNAMES.includes(new URL(`http://${host}`).hostname);
  } catch {
    return false;
  }
};

// Hashing both sides gives equal-length buffers, so the comparison time does not leak the key.
const getIsApiKeyValid = (presentedKey: string, apiKey: string): boolean =>
  timingSafeEqual(createHash('sha256').update(presentedKey).digest(), createHash('sha256').update(apiKey).digest());

const sendError = (res: ServerResponse, error: unknown, toErrorBody: (error: ProxyError) => unknown): void => {
  if (res.headersSent) {
    res.end();
    return;
  }
  const proxyError = isProxyError(error)
    ? error
    : createProxyError({ status: 500, message: error instanceof Error ? error.message : String(error) });
  sendJson(res, proxyError.status, toErrorBody(proxyError), proxyError.headers);
};

const logRequest = (req: IncomingMessage, statusCode: number, startedAtMs: number, log: RequestLog): void => {
  const fields = [
    `${req.method} ${req.url}`,
    String(statusCode),
    `${Date.now() - startedAtMs}ms`,
    log.model ? `model=${log.model}` : '',
    log.upstreamRequestId ? `upstream=${log.upstreamRequestId}` : '',
    log.client ? `client=${log.client}` : '',
    log.mode ? `mode=${log.mode}` : '',
    log.degraded ? `degraded=${log.degraded}` : '',
    log.ignoredKeys?.length ? `ignored=${log.ignoredKeys.join(',')}` : '',
  ];
  console.log(fields.filter((field) => field !== '').join(' '));
  // One branch line per upstream model send, in send order; requests that never reached
  // upstream print none. The tree glyph marks each line as belonging to the request above.
  const sends = log.upstreamSends ?? [];
  sends.forEach((send, index) => {
    const branch = index === sends.length - 1 ? '└─' : '├─';
    console.log(`${branch} ${send.method} ${send.url}${send.model === undefined ? '' : ` model=${send.model}`}`);
  });
};

// The gateway key is a bare secret, not a scheme plus token, so its whole value is hidden; Anthropic
// clients may send it as x-api-key.
const getHeaderLine = (name: string, value: number | string | string[]): string => {
  const text = Array.isArray(value) ? value.join(', ') : String(value);
  const shownText = name === 'authorization' ? getMaskedAuthorization(text) : name === GATEWAY_API_KEY_HEADER || name === 'x-api-key' ? '***' : text;
  return `${getDebugPrefix()}   ${name}: ${shownText}`;
};

// Levels 2-3: print the incoming request headers, then capture status, headers, and written chunks
// and print the downstream response once `close` fires, labelled with the same arrival string.
// Headers passed straight to writeHead bypass setHeader and never appear in getHeaders(), so they
// are captured from its arguments and merged in.
const logIncomingTraffic = (req: IncomingMessage, res: ServerResponse, incoming: string): void => {
  Object.entries(req.headers).forEach(([name, value]) => {
    if (value !== undefined) console.log(getHeaderLine(name, value));
  });
  const chunks: Buffer[] = [];
  // No prototype: header names such as `constructor` or `__proto__` must stay plain keys.
  const writtenHeaders: OutgoingHttpHeaders = Object.create(null) as OutgoingHttpHeaders;
  const originalWriteHead = res.writeHead.bind(res);
  res.writeHead = ((statusCode: number, ...args: unknown[]) => {
    const headersArg = args.find((arg) => typeof arg === 'object' && arg !== null);
    // The Claude relay passes upstream headers in rawHeaders form (name, value, ...).
    if (Array.isArray(headersArg)) {
      for (let index = 0; index < headersArg.length; index += 2) {
        const name = String(headersArg[index]).toLowerCase();
        const existing = writtenHeaders[name];
        const headerValue = String(headersArg[index + 1]);
        writtenHeaders[name] = existing === undefined ? headerValue : [...(Array.isArray(existing) ? existing : [String(existing)]), headerValue];
      }
    } else if (headersArg) {
      Object.assign(writtenHeaders, headersArg as OutgoingHttpHeaders);
    }
    return (originalWriteHead as (statusCode: number, ...args: unknown[]) => ServerResponse)(statusCode, ...args);
  }) as typeof res.writeHead;
  const originalWrite = res.write.bind(res);
  res.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
    chunks.push(Buffer.from(chunk));
    return (originalWrite as (chunk: string | Uint8Array, ...rest: unknown[]) => boolean)(chunk, ...rest);
  }) as typeof res.write;
  const originalEnd = res.end.bind(res);
  res.end = ((...args: unknown[]) => {
    const [chunk] = args;
    if (typeof chunk === 'string' || chunk instanceof Uint8Array) chunks.push(Buffer.from(chunk));
    return (originalEnd as (...args: unknown[]) => ServerResponse)(...args);
  }) as typeof res.end;
  res.on('close', () => {
    console.log(getDebugSeparator());
    console.log(`${getDebugPrefix()} incoming ${incoming} response ${res.statusCode}`);
    Object.entries({ ...res.getHeaders(), ...writtenHeaders }).forEach(([name, value]) => {
      if (value !== undefined) console.log(getHeaderLine(name, value));
    });
    const body = Buffer.concat(chunks).toString('utf8');
    if (body) console.log(`${getDebugPrefix()} incoming ${incoming} response body:\n${getFormattedBody(body)}`);
  });
};

const handleRequest = async (req: IncomingMessage, res: ServerResponse, deps: ProxyDeps, responseStore: ResponseStore, claudeSessions: ClaudeRelaySessions): Promise<void> => {
  const startedAtMs = Date.now();
  const log: RequestLog = {};
  const controller = new AbortController();
  res.on('close', () => {
    if (!res.writableFinished) controller.abort();
  });
  // The arrival line and downstream capture run before the Host check and URL parse, so every
  // request is logged even when those reject it. Levels 2/3 open the hop with a separator.
  const incoming = `${req.method} ${req.url ?? '/'}`;
  if (deps.debugLevel === 2 || deps.debugLevel === 3) console.log(getDebugSeparator());
  if (deps.debugLevel !== undefined) console.log(`${getDebugPrefix()} incoming ${incoming}`);
  if (deps.debugLevel === 2 || deps.debugLevel === 3) logIncomingTraffic(req, res, incoming);
  let isAnthropicRoute = false;
  try {
    const parsedUrl = new URL(req.url ?? '/', 'http://localhost');
    const pathname = parsedUrl.pathname.replace(/\/+$/, '');
    const route = `${req.method} ${pathname}`;
    const isClaudeRelay = route === CLAUDE_RELAY_ROUTE;
    isAnthropicRoute = isClaudeRelay || route === CLAUDE_COUNT_TOKENS_ROUTE;
    // Header-only, because the key check below runs before the body is read.
    const isClaudeCodeClient = isAnthropicRoute && getRequestHeader(req, 'x-app') === 'cli' && /^claude-cli\//i.test(req.headers['user-agent'] ?? '');
    // Native Codex relay (src/upstream/codexRelay.ts): every method below the backend prefix.
    const isCodexRelay = parsedUrl.pathname.startsWith(CODEX_RELAY_PATH_PREFIX);
    // A DNS-rebinding page cannot know the key, so the Host allowlist is only needed without one.
    if (deps.apiKey !== undefined) {
      const { apiKey } = deps;
      if (isCodexRelay) throw getCodexRelayApiKeyError();
      const bearerKey = /^Bearer (.+)$/i.exec(req.headers.authorization ?? '')?.[1];
      // Claude Code's Authorization is its own Claude OAuth token, so its key has a header of its own.
      if (isClaudeCodeClient) {
        if (!getIsApiKeyValid(getRequestHeader(req, GATEWAY_API_KEY_HEADER) ?? '', apiKey)) {
          // Not 401: on a 401 the native client starts its own OAuth recovery (2.1.302 @246047850),
          // but its OAuth token is fine; only the gateway key is wrong.
          throw createProxyError({ status: 403, type: 'permission_error', message: `Invalid or missing ${GATEWAY_API_KEY_HEADER} header; set ANTHROPIC_CUSTOM_HEADERS="${GATEWAY_API_KEY_HEADER}: <key>"` });
        }
      } else if (isAnthropicRoute) {
        // Other Anthropic clients send the gateway key as their API key or auth token.
        const presentedKeys = [getRequestHeader(req, GATEWAY_API_KEY_HEADER), getRequestHeader(req, 'x-api-key'), bearerKey];
        if (!presentedKeys.some((presentedKey) => presentedKey !== undefined && getIsApiKeyValid(presentedKey, apiKey))) {
          throw createProxyError({ status: 401, type: 'authentication_error', message: `Invalid or missing API key; send the gateway key as x-api-key, Authorization: Bearer or ${GATEWAY_API_KEY_HEADER}` });
        }
      } else if (!getIsApiKeyValid(bearerKey ?? '', apiKey)) {
        throw createProxyError({ status: 401, message: 'Invalid API key', type: 'invalid_request_error', code: 'invalid_api_key' });
      }
    } else if (!getIsLocalHost(req.headers.host)) {
      throw createProxyError({ status: 403, message: 'Host not allowed' });
    }
    if (isCodexRelay) {
      const rawBody = await readRawBody(req, MAX_BODY_BYTES);
      if ((deps.debugLevel === 2 || deps.debugLevel === 3) && rawBody.length > 0) {
        console.log(`${getDebugPrefix()} incoming ${route} body:\n${getFormattedBody(rawBody.toString('utf8'))}`);
      }
      await relayCodexHttp({ req, res, rawBody, signal: controller.signal, deps, log });
      return;
    }
    if (route === 'GET /v1/models') {
      const { contextLength, defaultModelId } = deps;
      sendJson(res, 200, await listAccountModels(deps.accounts, { contextLength, defaultModelId }));
      return;
    }
    if (route === CLAUDE_COUNT_TOKENS_ROUTE && !isClaudeCodeClient) {
      throw createProxyError({
        status: 400,
        message: 'agent-gateway does not serve /v1/messages/count_tokens for clients other than the official Claude Code: it has no captured official request shape for it, so nothing is sent upstream',
      });
    }
    if (route !== 'POST /v1/responses' && route !== 'POST /v1/chat/completions' && !isAnthropicRoute) {
      throw createProxyError({ status: 404, message: `Unknown route: ${route}` });
    }
    // Requiring JSON forces a CORS preflight for browser-originated requests.
    if (!req.headers['content-type']?.startsWith('application/json')) {
      throw createProxyError({ status: 415, message: 'Content-Type must be application/json' });
    }
    if (isAnthropicRoute) {
      const rawBody = await readRawBody(req, MAX_BODY_BYTES);
      if (deps.debugLevel === 2 || deps.debugLevel === 3) {
        console.log(`${getDebugPrefix()} incoming ${route} body:\n${getFormattedBody(rawBody.toString('utf8'))}`);
      }
      const relayInput = { req, res, rawBody, signal: controller.signal, deps, log, sessions: claudeSessions };
      if (!isClaudeRelay) {
        await relayClaudeCountTokens(relayInput);
        return;
      }
      // Official Claude Code is relayed as sent; every other Anthropic client is downgraded.
      const cloakBody = getClaudeCloakBody(req.rawHeaders, rawBody);
      await (cloakBody === undefined ? relayClaudeMessages(relayInput) : cloakClaudeMessages({ res, body: cloakBody, signal: controller.signal, deps, log }));
      return;
    }
    const context = { body: await readJsonBody(req, MAX_BODY_BYTES), req, res, signal: controller.signal, deps, log, responseStore };
    if (deps.debugLevel === 2 || deps.debugLevel === 3) {
      console.log(`${getDebugPrefix()} incoming ${route} body:\n${JSON.stringify(context.body, null, 2)}`);
    }
    await (route === 'POST /v1/responses' ? handleResponses(context) : handleChatCompletions(context));
  } catch (error) {
    if (!controller.signal.aborted) sendError(res, error, isAnthropicRoute ? toAnthropicErrorBody : toOpenAiErrorBody);
  } finally {
    logRequest(req, res.statusCode, startedAtMs, log);
  }
};

// WebSocket upgrades: only the Codex relay accepts them, after the same checks as handleRequest.
const handleUpgrade = async (req: IncomingMessage, socket: Socket, head: Buffer, deps: ProxyDeps): Promise<void> => {
  const startedAtMs = Date.now();
  const log: RequestLog = {};
  // Before the tunnel owns the socket, a client reset must not become an unhandled error.
  socket.on('error', () => socket.destroy());
  if (deps.debugLevel !== undefined) console.log(`${getDebugPrefix()} incoming ${req.method} ${req.url ?? '/'} (upgrade)`);
  if (deps.debugLevel === 2 || deps.debugLevel === 3) {
    Object.entries(req.headers).forEach(([name, value]) => {
      if (value !== undefined) console.log(getHeaderLine(name, value));
    });
  }
  let statusCode: number;
  try {
    if (!new URL(req.url ?? '/', 'http://localhost').pathname.startsWith(CODEX_RELAY_PATH_PREFIX)) {
      throw createProxyError({ status: 404, message: `WebSocket upgrades are only relayed under ${CODEX_RELAY_PATH_PREFIX}` });
    }
    if (deps.apiKey !== undefined) throw getCodexRelayApiKeyError();
    if (!getIsLocalHost(req.headers.host)) throw createProxyError({ status: 403, message: 'Host not allowed' });
    statusCode = await relayCodexUpgrade({ req, socket, head, deps, log });
  } catch (error) {
    statusCode = rejectCodexUpgrade(socket, error);
  }
  logRequest(req, statusCode, startedAtMs, log);
};

// One previous_response_id store and one Claude Code session binding store per server, so each
// server instance keeps its own.
export const createProxyServer = (deps: ProxyDeps): Server => {
  deps = { ...deps, reasoningStore: createReasoningStore() };
  const responseStore = createResponseStore();
  const claudeSessions = createClaudeRelaySessions();
  const server = createServer((req, res) => {
    void handleRequest(req, res, deps, responseStore, claudeSessions);
  });
  server.on('upgrade', (req: IncomingMessage, socket: Socket, head: Buffer) => {
    void handleUpgrade(req, socket, head, deps);
  });
  return server;
};
