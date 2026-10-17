import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type OutgoingHttpHeaders, type Server, type ServerResponse } from 'node:http';
import { listAccountModels } from './accounts.js';
import { handleChatCompletions } from './chat/handleChatCompletions.js';
import { LOCAL_HOSTNAMES, MAX_BODY_BYTES } from './constants.js';
import { createProxyError, isProxyError, toOpenAiErrorBody } from './errors.js';
import { handleResponses } from './responses/handleResponses.js';
import { getDebugPrefix, getDebugSeparator, getFormattedBody, getMaskedAuthorization } from './utils/debugFetch.js';
import { type ProxyDeps, readJsonBody, type RequestLog, sendJson } from './utils/http.js';

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
const getIsApiKeyValid = (authorization: string | undefined, apiKey: string): boolean => {
  const token = /^Bearer (.+)$/i.exec(authorization ?? '')?.[1] ?? '';
  return timingSafeEqual(createHash('sha256').update(token).digest(), createHash('sha256').update(apiKey).digest());
};

const sendError = (res: ServerResponse, error: unknown): void => {
  if (res.headersSent) {
    res.end();
    return;
  }
  const proxyError = isProxyError(error)
    ? error
    : createProxyError({ status: 500, message: error instanceof Error ? error.message : String(error) });
  sendJson(res, proxyError.status, toOpenAiErrorBody(proxyError), proxyError.headers);
};

const logRequest = (req: IncomingMessage, res: ServerResponse, startedAtMs: number, log: RequestLog): void => {
  const fields = [
    `${req.method} ${req.url}`,
    String(res.statusCode),
    `${Date.now() - startedAtMs}ms`,
    log.model ? `model=${log.model}` : '',
    log.upstreamRequestId ? `upstream=${log.upstreamRequestId}` : '',
    log.ignoredKeys?.length ? `ignored=${log.ignoredKeys.join(',')}` : '',
  ];
  console.log(fields.filter((field) => field !== '').join(' '));
};

const getHeaderLine = (name: string, value: number | string | string[]): string => {
  const text = Array.isArray(value) ? value.join(', ') : String(value);
  return `${getDebugPrefix()}   ${name}: ${name === 'authorization' ? getMaskedAuthorization(text) : text}`;
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
  const writtenHeaders: OutgoingHttpHeaders = {};
  const originalWriteHead = res.writeHead.bind(res);
  res.writeHead = ((statusCode: number, ...args: unknown[]) => {
    const headersArg = args.find((arg) => typeof arg === 'object' && arg !== null);
    if (headersArg) Object.assign(writtenHeaders, headersArg as OutgoingHttpHeaders);
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

const handleRequest = async (req: IncomingMessage, res: ServerResponse, deps: ProxyDeps): Promise<void> => {
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
  try {
    // A DNS-rebinding page cannot know the key, so the Host allowlist is only needed without one.
    if (deps.apiKey !== undefined) {
      if (!getIsApiKeyValid(req.headers.authorization, deps.apiKey)) {
        throw createProxyError({ status: 401, message: 'Invalid API key', type: 'invalid_request_error', code: 'invalid_api_key' });
      }
    } else if (!getIsLocalHost(req.headers.host)) {
      throw createProxyError({ status: 403, message: 'Host not allowed' });
    }
    const pathname = new URL(req.url ?? '/', 'http://localhost').pathname.replace(/\/+$/, '');
    const route = `${req.method} ${pathname}`;
    if (route === 'GET /v1/models') {
      const { contextLength, defaultModelId } = deps;
      sendJson(res, 200, await listAccountModels(deps.accounts, { contextLength, defaultModelId }));
      return;
    }
    if (route !== 'POST /v1/responses' && route !== 'POST /v1/chat/completions') {
      throw createProxyError({ status: 404, message: `Unknown route: ${route}` });
    }
    // Requiring JSON forces a CORS preflight for browser-originated requests.
    if (!req.headers['content-type']?.startsWith('application/json')) {
      throw createProxyError({ status: 415, message: 'Content-Type must be application/json' });
    }
    const context = { body: await readJsonBody(req, MAX_BODY_BYTES), req, res, signal: controller.signal, deps, log };
    if (deps.debugLevel === 2 || deps.debugLevel === 3) {
      console.log(`${getDebugPrefix()} incoming ${route} body:\n${JSON.stringify(context.body, null, 2)}`);
    }
    await (route === 'POST /v1/responses' ? handleResponses(context) : handleChatCompletions(context));
  } catch (error) {
    if (!controller.signal.aborted) sendError(res, error);
  } finally {
    logRequest(req, res, startedAtMs, log);
  }
};

export const createProxyServer = (deps: ProxyDeps): Server =>
  createServer((req, res) => {
    void handleRequest(req, res, deps);
  });
