// Raw HTTP relay primitives shared by the native relays (Claude POST /v1/messages and Codex
// /backend-api/codex/*). node:http(s) instead of fetch, so nothing is added, decoded, redirected or
// re-encoded on the wire; headers travel in rawHeaders form (name, value, ...), so casing, order
// and repeats survive. Project-owned: the official clients talk to their backends directly.
import { type ClientRequest, type IncomingMessage, request as httpRequest, type ServerResponse } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { GATEWAY_API_KEY_HEADER } from '../constants.js';
import { writeText } from './http.js';

// The body is buffered and resent with content-length, so chunked framing and upgrade headers do
// not apply upstream; the gateway's own key never leaves the gateway.
export const RELAY_DROPPED_REQUEST_HEADERS = new Set(['transfer-encoding', 'keep-alive', 'upgrade', GATEWAY_API_KEY_HEADER]);
// The gateway's own response connection sets these again.
export const RELAY_DROPPED_RESPONSE_HEADERS = new Set(['connection', 'keep-alive', 'transfer-encoding', 'upgrade', 'proxy-authenticate', 'trailer', 'te']);

// Case-insensitive lookup in a rawHeaders list; repeated headers join like node's req.headers.
export const getRawHeader = (rawHeaders: string[], name: string): string | undefined => {
  const headerValues = rawHeaders.filter((_, index) => index % 2 === 1 && rawHeaders[index - 1]?.toLowerCase() === name);
  return headerValues.length === 0 ? undefined : headerValues.join(', ');
};

export const filterRawHeaders = (rawHeaders: string[], droppedNames: Set<string>): string[] =>
  rawHeaders.filter((_, index) => !droppedNames.has((rawHeaders[index - (index % 2)] ?? '').toLowerCase()));

// Each replacement takes the position of its first occurrence; later copies are dropped, so a
// duplicate authorization can never leak the client token. Names the client did not send are
// appended. Keys are lowercase; the client's casing is kept.
export const replaceRawHeaders = (rawHeaders: string[], replacements: Map<string, string>): string[] => {
  const headers: string[] = [];
  const replacedNames = new Set<string>();
  for (let index = 0; index < rawHeaders.length; index += 2) {
    const name = rawHeaders[index] ?? '';
    const replacement = replacements.get(name.toLowerCase());
    if (replacement === undefined) {
      headers.push(name, rawHeaders[index + 1] ?? '');
    } else if (!replacedNames.has(name.toLowerCase())) {
      replacedNames.add(name.toLowerCase());
      headers.push(name, replacement);
    }
  }
  for (const [name, replacement] of replacements) {
    if (!replacedNames.has(name)) headers.push(name, replacement);
  }
  return headers;
};

// setDefaultHeaders:false: the list already carries host and content-length where the client put
// them, and Node adds nothing of its own (no Connection when the client sent none), so repeated
// headers also keep their order and casing.
export const createRawRequest = (input: { baseUrl: URL; path: string; method: string; headers: string[]; signal?: AbortSignal }): ClientRequest =>
  (input.baseUrl.protocol === 'https:' ? httpsRequest : httpRequest)({
    protocol: input.baseUrl.protocol,
    hostname: input.baseUrl.hostname,
    port: input.baseUrl.port,
    method: input.method,
    path: input.path,
    headers: input.headers,
    setDefaultHeaders: false,
    signal: input.signal,
  });

export const sendRawRequest = (input: Parameters<typeof createRawRequest>[0] & { body: Uint8Array }): Promise<IncomingMessage> =>
  new Promise((resolve, reject) => {
    const request = createRawRequest(input);
    request.on('response', resolve);
    request.on('error', reject);
    request.end(input.body);
  });

// Status, status message, headers (names, casing, order, repeats) and body bytes go back as upstream
// sent them, errors and redirects included, still encoded.
export const pipeRawResponse = async (res: ServerResponse, upstream: IncomingMessage): Promise<void> => {
  res.writeHead(upstream.statusCode ?? 502, upstream.statusMessage, filterRawHeaders(upstream.rawHeaders, RELAY_DROPPED_RESPONSE_HEADERS));
  for await (const chunk of upstream) await writeText(res, chunk as Buffer);
  res.end();
};
