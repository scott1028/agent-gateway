import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Account } from '../accounts.js';
import { FORWARDED_RESPONSE_HEADER_PREFIX, FORWARDED_RESPONSE_HEADERS } from '../constants.js';
import { createProxyError } from '../errors.js';
import type { ReasoningStore } from './reasoningStore.js';
import type { ResponseStore } from '../responses/responseStore.js';
import type { DebugLevel, Json } from '../types.js';

export type ProxyDeps = {
  accounts: Account[];
  contextLength: number;
  defaultModelId?: string;
  debugLevel?: DebugLevel;
  apiKey?: string;
  relayFallback?: 'reject' | 'degrade';
  reasoningStore?: ReasoningStore;
  now?: () => number;
  // Test seam; production uses CODEX_WEBSOCKET_CONNECT_TIMEOUT_MS.
  codexWebSocketConnectTimeoutMs?: number;
};

// One upstream model send as it actually left the gateway; the access log prints one indented
// line per entry. Codex pure relays do not parse the body, so they may carry no model.
export type UpstreamSend = { method: string; url: string; model?: string };

// client: who presented the request (official CLI shape checks, not a cryptographic proof);
// mode: what went upstream (relay = client's own bytes, gateway = gateway-built).
export type RequestLog = {
  degraded?: string;
  client?: 'official' | 'third_party';
  mode?: 'relay' | 'gateway';
  upstreamSends?: UpstreamSend[];
  model?: string;
  upstreamRequestId?: string;
  ignoredKeys?: string[];
};

export const recordUpstreamSend = (log: RequestLog, send: UpstreamSend): void => {
  (log.upstreamSends ??= []).push(send);
};

export type HandlerContext = {
  body: Json;
  req: IncomingMessage;
  res: ServerResponse;
  signal: AbortSignal;
  deps: ProxyDeps;
  log: RequestLog;
  responseStore: ResponseStore;
};

export const SSE_HEADERS = {
  'content-type': 'text/event-stream; charset=utf-8',
  'cache-control': 'no-cache',
  connection: 'keep-alive',
};

export const readRawBody = async (req: IncomingMessage, limitBytes: number): Promise<Buffer> => {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limitBytes) throw createProxyError({ status: 413, message: `Request body exceeds ${limitBytes} bytes` });
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
};

export const readJsonBody = async (req: IncomingMessage, limitBytes: number): Promise<Json> => {
  const rawBody = await readRawBody(req, limitBytes);
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody.toString('utf8'));
  } catch {
    throw createProxyError({ status: 400, message: 'Request body must be valid JSON' });
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw createProxyError({ status: 400, message: 'Request body must be a JSON object' });
  }
  return parsed as Json;
};

export const sendJson = (res: ServerResponse, status: number, payload: unknown, headers: Record<string, string> = {}): void => {
  res.writeHead(status, { ...headers, 'content-type': 'application/json' });
  res.end(JSON.stringify(payload));
};

// Respects backpressure so slow clients do not buffer the whole stream in memory. A client that
// goes away while the write buffer is full must not leave the handler stuck waiting for a drain
// that never comes: `close` aborts the wait so the handler reaches its cleanup (upstream cancel).
// A writer that is ALREADY gone fails fast for the same reason: its close event has fired (or
// will never fire again), so waiting on drain/close would hang the handler forever.
export const writeText = async (res: ServerResponse, text: string | Uint8Array): Promise<void> => {
  if (res.destroyed || res.writableEnded) throw new Error('Client connection is already closed');
  if (res.write(text)) return;
  await new Promise<void>((resolve, reject) => {
    const onDrain = (): void => {
      res.off('close', onClose);
      resolve();
    };
    const onClose = (): void => {
      res.off('drain', onDrain);
      reject(new Error('Client closed while the response was backpressured'));
    };
    res.once('drain', onDrain);
    res.once('close', onClose);
  });
};

export const getForwardedHeaders = (headers: Headers): Record<string, string> => {
  const forwarded: Record<string, string> = {};
  headers.forEach((headerValue, name) => {
    if (FORWARDED_RESPONSE_HEADERS.includes(name) || name.startsWith(FORWARDED_RESPONSE_HEADER_PREFIX)) {
      forwarded[name] = headerValue;
    }
  });
  return forwarded;
};

export const getRequestHeader = (req: IncomingMessage, name: string): string | undefined => {
  const headerValue = req.headers[name];
  return Array.isArray(headerValue) ? headerValue[0] : headerValue;
};
