import { request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Account } from '../src/accounts.js';
import { getConfig } from '../src/config.js';
import { createModelCatalog } from '../src/models.js';
import { createProxyServer } from '../src/server.js';
import type { Json } from '../src/types.js';
import { createCodexClient } from '../src/upstream/codexClient.js';
import { readFixture } from './helpers.js';

// Project-owned access guard (--host / AGENT_GATEWAY_API_KEY); there is no official reference.
// The upstream is mocked with the existing SSE fixture; no account or external calls are used.

const API_KEY = 'test-api-key';

type Reply = { status: number; body: Json };

let fetchFn: ReturnType<typeof vi.fn<typeof fetch>>;
let closeServer: (() => void) | undefined;

const startServer = async (apiKey?: string): Promise<number> => {
  const config = getConfig({}, ['/tmp/access-test']);
  const account: Account = {
    provider: 'codex',
    alias: 'codex1',
    homePath: '/tmp/access-test',
    catalog: createModelCatalog({ getModels: async () => [{ slug: 'gpt-x' }] }),
    client: createCodexClient({
      auth: {
        getCredentials: async () => ({ accessToken: 'test-token', isFedramp: false }),
        recoverUnauthorized: async () => ({ accessToken: 'test-token', isFedramp: false }),
      },
      config,
      authPath: '/tmp/access-test/auth.json',
      fetchFn,
    }),
  };
  const server = createProxyServer({ accounts: [account], contextLength: config.contextLength, apiKey });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  closeServer = () => server.close();
  return (server.address() as AddressInfo).port;
};

// node:http instead of fetch: fetch cannot override the Host header.
const sendRequest = (
  port: number,
  input: { method: 'GET' | 'POST'; path: string; headers?: Record<string, string>; body?: Json },
): Promise<Reply> =>
  new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, method: input.method, path: input.path, headers: input.headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as Json }));
    });
    req.on('error', reject);
    req.end(input.body === undefined ? undefined : JSON.stringify(input.body));
  });

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  fetchFn = vi.fn<typeof fetch>(async () => new Response(readFixture('text-nonlite.sse')));
});
afterEach(() => {
  closeServer?.();
  closeServer = undefined;
  vi.restoreAllMocks();
});

describe('with AGENT_GATEWAY_API_KEY', () => {
  it.each([
    ['no Authorization header', {}],
    ['a wrong key', { authorization: 'Bearer wrong-key' }],
    ['the key without the Bearer scheme', { authorization: API_KEY }],
  ])('rejects %s with an OpenAI invalid_api_key error', async (_name, headers) => {
    const port = await startServer(API_KEY);
    const reply = await sendRequest(port, { method: 'GET', path: '/v1/models', headers });
    expect(reply.status).toBe(401);
    expect(reply.body).toEqual({
      error: { message: 'Invalid API key', type: 'invalid_request_error', param: null, code: 'invalid_api_key' },
    });
  });

  it('accepts the right key from any Host, as remote clients send the server address', async () => {
    const port = await startServer(API_KEY);
    const reply = await sendRequest(port, {
      method: 'GET', path: '/v1/models', headers: { authorization: `Bearer ${API_KEY}`, host: `192.168.1.10:${port}` },
    });
    expect(reply.status).toBe(200);
    expect(reply.body.object).toBe('list');
  });

  it('never forwards the client key upstream', async () => {
    const port = await startServer(API_KEY);
    const reply = await sendRequest(port, {
      method: 'POST',
      path: '/v1/responses',
      headers: { authorization: `Bearer ${API_KEY}`, 'content-type': 'application/json' },
      body: { model: 'codex1/gpt-x', stream: false, input: [{ role: 'user', content: 'User prompt.' }] },
    });
    expect(reply.status).toBe(200);
    const upstreamHeaders = new Headers(fetchFn.mock.calls[0]?.[1]?.headers);
    expect(upstreamHeaders.get('authorization')).toBe('Bearer test-token');
    expect([...upstreamHeaders.values()].some((value) => value.includes(API_KEY))).toBe(false);
  });
});

describe('without an API key', () => {
  it('keeps the loopback Host allowlist against DNS rebinding', async () => {
    const port = await startServer();
    expect((await sendRequest(port, { method: 'GET', path: '/v1/models', headers: { host: 'example.com' } })).status).toBe(403);
    expect((await sendRequest(port, { method: 'GET', path: '/v1/models' })).status).toBe(200);
  });
});
