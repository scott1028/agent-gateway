import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Account } from '../accounts.js';
import { FORWARDED_RESPONSE_HEADER_PREFIX, FORWARDED_RESPONSE_HEADERS } from '../constants.js';
import { createProxyError } from '../errors.js';
import type { DebugLevel, Json } from '../types.js';

export type ProxyDeps = { accounts: Account[]; contextLength: number; defaultModelId?: string; debugLevel?: DebugLevel; apiKey?: string; now?: () => number };

export type RequestLog = { model?: string; upstreamRequestId?: string; ignoredKeys?: string[] };

export type HandlerContext = {
  body: Json;
  req: IncomingMessage;
  res: ServerResponse;
  signal: AbortSignal;
  deps: ProxyDeps;
  log: RequestLog;
};

export const SSE_HEADERS = {
  'content-type': 'text/event-stream; charset=utf-8',
  'cache-control': 'no-cache',
  connection: 'keep-alive',
};

export const readJsonBody = async (req: IncomingMessage, limitBytes: number): Promise<Json> => {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limitBytes) throw createProxyError({ status: 413, message: `Request body exceeds ${limitBytes} bytes` });
    chunks.push(chunk as Buffer);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
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
