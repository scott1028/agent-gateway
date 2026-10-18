import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Account } from '../src/accounts.js';
import { getConfig } from '../src/config.js';
import { createModelCatalog } from '../src/models.js';
import { createProxyServer } from '../src/server.js';
import type { Json } from '../src/types.js';
import { createCodexClient } from '../src/upstream/codexClient.js';
import { createDebugFetch } from '../src/utils/debugFetch.js';
import { readFixture } from './helpers.js';

// Project-owned debug logs; upstream payloads follow references/codex/codex-rs/codex-api.
// The upstream is mocked with the existing SSE fixture; no account or external calls are used.

const FIXED_TIME = '2026-10-15T11:56:40Z';
const PREFIX = `[debug:${FIXED_TIME}]`;
const SEPARATOR = `\n${PREFIX} ${'─'.repeat(40)}`;
const TIME_PREFIX_PATTERN = /^\[debug:\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z\]/;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(FIXED_TIME));
});
afterEach(() => {
  vi.useRealTimers();
});

describe.each([undefined, 0, 1, 2, 3] as const)('debug logging at level %s', (debugLevel) => {
  it.each(['/v1/chat/completions', '/v1/responses'])('respects the configured level for %s', async (pathname) => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const fetchFn = vi.fn<typeof fetch>(async () => new Response(readFixture('text-nonlite.sse')));
    const config = getConfig({}, ['/tmp/debug-test']);
    const account: Account = {
      provider: 'codex',
      alias: 'codex1',
      homePath: '/tmp/debug-test',
      catalog: createModelCatalog({ getModels: async () => [{ slug: 'gpt-x' }] }),
      client: createCodexClient({
        auth: {
          getCredentials: async () => ({ accessToken: 'test-token', isFedramp: false }),
          recoverUnauthorized: async () => ({ accessToken: 'test-token', isFedramp: false }),
        },
        config,
        authPath: '/tmp/debug-test/auth.json',
        fetchFn: debugLevel === undefined ? fetchFn : createDebugFetch({ alias: 'codex1', debugLevel, fetchFn }),
      }),
    };
    const deps = { accounts: [account], contextLength: config.contextLength, debugLevel };
    const server = createProxyServer(deps);
    try {
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const messages = [
        { role: 'system', content: 'Original system prompt.' },
        { role: 'developer', content: 'Developer instructions.' },
        { role: 'user', content: 'User prompt.' },
      ];
      const body = {
        model: 'codex1/gpt-x',
        stream: false,
        temperature: 0.5,
        ...(pathname.endsWith('/responses') ? { instructions: 'Top-level instructions.', input: messages } : { messages }),
      };
      const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}${pathname}`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      });
      expect(response.status).toBe(200);
      expect(await response.text()).toContain('pong');
      // The upstream response body log and the incoming response log are async; let them flush.
      await new Promise((resolve) => setImmediate(resolve));
      const calls = log.mock.calls.map((call) => String(call[0]));
      const logs = calls.join('\n');
      const upstreamBody = JSON.parse(String(fetchFn.mock.calls[0]?.[1]?.body)) as Json;
      expect(upstreamBody.model).toBe('gpt-x');
      expect(upstreamBody.temperature).toBeUndefined();
      expect((upstreamBody.input as Json[])[0]?.role).toBe('developer');
      // The access log marks these endpoints third_party/gateway (never a relay) and prints the
      // tree-bracketed upstream send line, without --debug.
      expect(logs).toContain('client=third_party mode=gateway');
      expect(logs).toContain(`└─ POST ${config.baseUrl}/responses model=gpt-x`);
      const showsDownstream = debugLevel === 2 || debugLevel === 3;
      const showsUpstream = debugLevel === 1 || debugLevel === 3;
      if (debugLevel === undefined) {
        expect(logs).not.toContain('[debug:');
      } else {
        expect(log).toHaveBeenCalledWith(`${PREFIX} incoming POST ${pathname}`);
        expect(log).toHaveBeenCalledWith(`${PREFIX} codex1 POST ${config.baseUrl}/responses`);
        for (const call of calls.filter((call) => call.startsWith('[debug:'))) {
          expect(call).toMatch(TIME_PREFIX_PATTERN);
        }
      }
      if (showsDownstream) {
        expect(log).toHaveBeenCalledWith(`${PREFIX} incoming POST ${pathname} body:\n${JSON.stringify(body, null, 2)}`);
        expect(log).toHaveBeenCalledWith(`${PREFIX}   content-type: application/json`);
        expect(log).toHaveBeenCalledWith(`${PREFIX} incoming POST ${pathname} response 200`);
        expect(logs).toContain(`${PREFIX} incoming POST ${pathname} response body:\n`);
        const arrivalIndex = calls.indexOf(`${PREFIX} incoming POST ${pathname}`);
        expect(calls[arrivalIndex - 1]).toBe(SEPARATOR);
        const responseIndex = calls.indexOf(`${PREFIX} incoming POST ${pathname} response 200`);
        expect(calls[responseIndex - 1]).toBe(SEPARATOR);
      } else {
        expect(logs).not.toContain(`incoming POST ${pathname} body:`);
        expect(logs).not.toContain(`incoming POST ${pathname} response`);
        if (debugLevel !== undefined) {
          // A single-line hop never opens with a separator, so the arrival line is the first call.
          expect(calls.indexOf(`${PREFIX} incoming POST ${pathname}`)).toBe(0);
        }
        if (debugLevel === 0) {
          // The separator hop never appears at level 0; the access log's own └─ branch glyph is
          // not a separator.
          expect(logs).not.toContain(SEPARATOR);
          expect(logs).not.toContain('\n\n');
        }
      }
      if (showsUpstream) {
        expect(log).toHaveBeenCalledWith(
          `${PREFIX} codex1 upstream POST ${config.baseUrl}/responses body:\n${JSON.stringify(upstreamBody, null, 2)}`,
        );
        expect(log).toHaveBeenCalledWith(`${PREFIX} codex1 upstream POST ${config.baseUrl}/responses response 200`);
        expect(logs).toContain(`${PREFIX} codex1 upstream POST ${config.baseUrl}/responses response body:\n`);
        const upstreamRequestIndex = calls.indexOf(`${PREFIX} codex1 POST ${config.baseUrl}/responses`);
        expect(calls[upstreamRequestIndex - 1]).toBe(SEPARATOR);
        const upstreamResponseIndex = calls.indexOf(`${PREFIX} codex1 upstream POST ${config.baseUrl}/responses response 200`);
        expect(calls[upstreamResponseIndex - 1]).toBe(SEPARATOR);
      } else {
        expect(logs).not.toContain('upstream POST');
      }
      if (!showsDownstream && !showsUpstream) {
        expect(logs).not.toContain('body:');
        expect(logs).not.toContain('prompt');
      }
      expect(logs).not.toContain('test-token');
      expect(fetchFn).toHaveBeenCalledOnce();
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
        server.closeAllConnections();
      });
      log.mockRestore();
    }
  });
});

// The arrival and downstream response lines use the raw req.url; only the body line uses the parsed route.
describe('incoming debug lines with a query string', () => {
  it('logs the full req.url at debug level 3', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const fetchFn = vi.fn<typeof fetch>(async () => new Response(readFixture('text-nonlite.sse')));
    const config = getConfig({}, ['/tmp/debug-test']);
    const account: Account = {
      provider: 'codex',
      alias: 'codex1',
      homePath: '/tmp/debug-test',
      catalog: createModelCatalog({ getModels: async () => [{ slug: 'gpt-x' }] }),
      client: createCodexClient({
        auth: {
          getCredentials: async () => ({ accessToken: 'test-token', isFedramp: false }),
          recoverUnauthorized: async () => ({ accessToken: 'test-token', isFedramp: false }),
        },
        config,
        authPath: '/tmp/debug-test/auth.json',
        fetchFn: createDebugFetch({ alias: 'codex1', debugLevel: 3, fetchFn }),
      }),
    };
    const server = createProxyServer({ accounts: [account], contextLength: config.contextLength, debugLevel: 3 });
    try {
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const body = { model: 'codex1/gpt-x', stream: false, input: [{ role: 'user', content: 'User prompt.' }] };
      const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/responses?debug=1`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      });
      expect(response.status).toBe(200);
      await response.text();
      await new Promise((resolve) => setImmediate(resolve));
      expect(log).toHaveBeenCalledWith(`${PREFIX} incoming POST /v1/responses?debug=1`);
      expect(log).toHaveBeenCalledWith(`${PREFIX} incoming POST /v1/responses?debug=1 response 200`);
      expect(log).toHaveBeenCalledWith(`${PREFIX} incoming POST /v1/responses body:\n${JSON.stringify(body, null, 2)}`);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
        server.closeAllConnections();
      });
      log.mockRestore();
    }
  });
});
