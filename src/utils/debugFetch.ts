// Project-owned debug tool: prints the method and URL of every upstream call; levels 1/3 add full
// request/response headers and inference bodies. Every line carries a UTC timestamp prefix, and a
// hop that prints details opens with a blank line plus a separator. There is no counterpart for
// this in references/codex, and it never changes what is sent upstream or returned to the caller.
import type { DebugLevel } from '../types.js';

// UTC to the second, e.g. [debug:2026-10-15T11:56:40Z]; taken at print time.
export const getDebugPrefix = (): string => `[debug:${new Date().toISOString().slice(0, 19)}Z]`;

// One log call prints the blank line plus the separator that opens a detailed hop.
export const getDebugSeparator = (): string => `\n${getDebugPrefix()} ${'─'.repeat(40)}`;

// Keeps the scheme so the log still shows the auth mode, but never the token itself.
export const getMaskedAuthorization = (value: string): string => {
  const separatorIndex = value.indexOf(' ');
  return separatorIndex === -1 ? '***' : `${value.slice(0, separatorIndex)} ***`;
};

// Indents parseable JSON; SSE and other text stays raw.
export const getFormattedBody = (body: string): string => {
  try {
    return JSON.stringify(JSON.parse(body), null, 2);
  } catch {
    return body;
  }
};

type DebugFetchDeps = {
  alias: string;
  debugLevel?: DebugLevel;
  fetchFn?: typeof fetch;
  log?: (message: string) => void;
};

export const createDebugFetch = ({ alias, debugLevel = 0, fetchFn = fetch, log = console.log }: DebugFetchDeps): typeof fetch => {
  const showHeadersAndBodies = debugLevel === 1 || debugLevel === 3;
  return async (input, init) => {
    const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    if (showHeadersAndBodies) log(getDebugSeparator());
    log(`${getDebugPrefix()} ${alias} ${method} ${url}`);
    // Only inference bodies contain prompts; OAuth refresh bodies contain credentials.
    const isInferencePost = method.toUpperCase() === 'POST' && /\/(responses|messages)\/?$/.test(new URL(url).pathname);
    if (showHeadersAndBodies) {
      new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined)).forEach((value, name) => {
        log(`${getDebugPrefix()}   ${name}: ${name === 'authorization' ? getMaskedAuthorization(value) : value}`);
      });
      if (isInferencePost) {
        const body = typeof init?.body === 'string'
          ? init.body
          : input instanceof Request && init?.body == null ? await input.clone().text() : undefined;
        if (body) {
          log(`${getDebugPrefix()} ${alias} upstream ${method} ${url} body:\n${getFormattedBody(body)}`);
        }
      }
    }
    const response = await fetchFn(input, init);
    if (showHeadersAndBodies) {
      log(getDebugSeparator());
      log(`${getDebugPrefix()} ${alias} upstream ${method} ${url} response ${response.status}`);
      response.headers.forEach((value, name) => {
        log(`${getDebugPrefix()}   ${name}: ${name === 'authorization' ? getMaskedAuthorization(value) : value}`);
      });
      // The clone keeps the caller's response readable; its text resolves when the stream ends.
      // A mid-stream abort rejects the clone, which must not surface as an unhandled rejection.
      if (isInferencePost) {
        response.clone().text()
          .then((body) => {
            if (body) log(`${getDebugPrefix()} ${alias} upstream ${method} ${url} response body:\n${getFormattedBody(body)}`);
          })
          .catch(() => undefined);
      }
    }
    return response;
  };
};
