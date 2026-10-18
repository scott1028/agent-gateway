// Matches references/codex @0d58012 core/src/client.rs 426 fallback and Responses builder.
import { createServer, request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CodexAccount } from '../../src/accounts.js';
import { getConfig } from '../../src/config.js';
import { createModelCatalog } from '../../src/models.js';
import { createProxyServer } from '../../src/server.js';
import type { Json } from '../../src/types.js';
import { createCodexClient } from '../../src/upstream/codexClient.js';
import { readFixture } from '../helpers.js';

const servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
  vi.restoreAllMocks();
});
const listen = async (server: Server) => {
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
};
const setup = async (mode: 'reject' | 'degrade', options: { count?: number; changed?: boolean; lite?: boolean; noAccountId?: boolean } = {}) => {
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  const rawCalls: { headers: Json; url: string; body: Buffer }[] = [];
  const upstream = await listen(createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      rawCalls.push({ headers: req.headers, url: req.url ?? '', body: Buffer.concat(chunks) });
      res.setHeader('x-test', 'raw');
      res.end('{"models":[]}');
    });
  }));
  const calls: { body: Json; headers: Record<string, string> }[] = [];
  const accounts: CodexAccount[] = [];
  for (let index = 0; index < (options.count ?? 2); index++) {
    let reads = 0;
    const credentials = { accessToken: 'synthetic-credential', accountId: options.noAccountId ? undefined : `synthetic-account-${index}`, isFedramp: false };
    const client = createCodexClient({ auth: { getCredentials: async () => ({ ...credentials, accountId: options.changed && reads++ === 0 ? 'synthetic-client-account' : credentials.accountId }), recoverUnauthorized: async () => credentials }, config: { ...getConfig({}, ['/synthetic']), baseUrl: `${upstream}/backend-api/codex` }, authPath: '/synthetic/auth.json', fetchFn: async (_url, init) => {
      calls.push({ body: JSON.parse(String(init?.body)) as Json, headers: init?.headers as Record<string, string> });
      return new Response(readFixture('codex-relay-fallback.tdd.sse'), { headers: { 'content-type': 'text/event-stream' } });
    } });
    accounts.push({ provider: 'codex', alias: `codex${index + 1}`, homePath: '/synthetic', client, catalog: createModelCatalog({ getModels: async () => [{ slug: 'gpt-test', use_responses_lite: options.lite === true }] }) });
  }
  const base = await listen(createProxyServer({ accounts, contextLength: 200000, relayFallback: mode }));
  const post = (body: Json = { model: 'gpt-test', input: 'hi' }) => fetch(`${base}/backend-api/codex/responses`, { method: 'POST', headers: { 'content-type': 'application/json', 'chatgpt-account-id': 'synthetic-client-account', 'user-agent': 'client-UA' }, body: JSON.stringify(body) });
  return { base, calls, rawCalls, post, accounts };
};

describe('Codex relay fallback', () => {
  it.each([false, true])('returns 426 on WS mismatch (send-time change=%s), and reject still returns 400', async (changed) => {
    for (const mode of ['reject', 'degrade'] as const) {
      const gateway = await setup(mode, { changed });
      const reply = await new Promise<{ status: number; text: string }>((resolve, reject) => {
        const req = request(`${gateway.base}/backend-api/codex/responses`, { headers: { connection: 'Upgrade', upgrade: 'websocket', 'sec-websocket-key': 'synthetic-key', 'sec-websocket-version': '13', 'chatgpt-account-id': 'synthetic-client-account' } }, (response) => {
          let text = '';
          response.on('data', (chunk) => { text += String(chunk); });
          response.on('end', () => resolve({ status: response.statusCode ?? 0, text }));
        });
        req.on('error', reject);
        req.end();
      });
      expect(reply.status).toBe(mode === 'degrade' ? 426 : 400);
      if (mode === 'degrade') expect(reply.text).toContain('HTTP');
      expect(gateway.rawCalls).toHaveLength(0);
      expect(gateway.calls).toHaveLength(0);
    }
  });

  it.each([false, true])('preserves reject and rebuilds HTTP mismatches (send-time change=%s)', async (changed) => {
    for (const mode of ['reject', 'degrade'] as const) {
      const gateway = await setup(mode, { changed, lite: true });
      const response = await gateway.post({ model: 'gpt-test', input: [{ role: 'system', content: 'rules' }], tools: [{ type: 'function', name: 'test' }], reasoning: { effort: 'ultra' }, client_metadata: {} });
      expect(response.status).toBe(mode === 'degrade' ? 200 : 400);
      await response.text();
      expect(gateway.calls).toHaveLength(mode === 'degrade' ? 1 : 0);
      if (mode === 'degrade') {
        const call = gateway.calls[0]!;
        expect(call.body).toMatchObject({ model: 'gpt-test', stream: true, store: false, parallel_tool_calls: false, reasoning: { effort: 'max', context: 'all_turns' } });
        expect(call.body).not.toHaveProperty('client_metadata');
        expect(call.body).not.toHaveProperty('tools');
        expect((call.body.input as Json[])[0]?.type).toBe('additional_tools');
        expect((call.body.input as Json[])[1]?.role).toBe('developer');
        expect(call.headers['user-agent']).toContain('agent-gateway');
        expect(vi.mocked(console.log).mock.calls.flat().join('\n')).toContain(`degraded=${changed ? 'account_changed' : 'account_mismatch'}`);
      }
    }
  });

  it('filters reasoning by target alias and records only output_item.done reasoning', async () => {
    const gateway = await setup('degrade');
    const input = [
      { type: 'message', role: 'user', content: 'hi' },
      { type: 'reasoning', encrypted_content: 'synthetic-encrypted' },
      { type: 'reasoning', encrypted_content: 'synthetic-unfinished' },
      { type: 'reasoning', encrypted_content: 'synthetic-not-reasoning' },
      { type: 'reasoning', summary: [] },
    ];
    await (await gateway.post({ model: 'codex2/gpt-test', input })).text();
    expect(gateway.calls[0]?.body.input).toHaveLength(1);
    await (await gateway.post({ model: 'codex2/gpt-test', input })).text();
    expect(gateway.calls[1]?.body.input).toEqual(input.slice(0, 2));
    expect(gateway.calls[1]?.headers['chatgpt-account-id']).toBe('synthetic-account-1');
    await (await gateway.post({ model: 'gpt-test', input })).text();
    expect(gateway.calls[2]?.body.input).toHaveLength(1);
  });

  it('forwards other endpoints with the target account id and client UA unchanged', async () => {
    const gateway = await setup('degrade');
    const response = await fetch(`${gateway.base}/backend-api/codex/models?literal=%2f`, { headers: { 'chatgpt-account-id': 'synthetic-client-account', 'user-agent': 'client-UA' } });
    expect(await response.text()).toBe('{"models":[]}');
    expect(response.headers.get('x-test')).toBe('raw');
    expect(gateway.rawCalls[0]).toMatchObject({ url: '/backend-api/codex/models?literal=%2f', headers: { 'chatgpt-account-id': 'synthetic-account-0', 'user-agent': 'client-UA' } });
    expect(gateway.calls).toHaveLength(0);
  });

  it('rejects a degraded other-endpoint send when the target home has no account id', async () => {
    const gateway = await setup('degrade', { noAccountId: true });
    const response = await fetch(`${gateway.base}/backend-api/codex/models`, { headers: { 'chatgpt-account-id': 'synthetic-client-account', 'user-agent': 'client-UA' } });
    expect(response.status).toBe(400);
    expect(await response.text()).toContain('account_id_required');
    expect(gateway.rawCalls).toHaveLength(0);
    expect(gateway.calls).toHaveLength(0);
  });

  it('forwards a non-JSON other-endpoint body byte for byte with the first Codex account', async () => {
    const gateway = await setup('degrade');
    const response = await fetch(`${gateway.base}/backend-api/codex/models`, { method: 'POST', headers: { 'content-type': 'text/plain', 'chatgpt-account-id': 'synthetic-client-account', 'user-agent': 'client-UA' }, body: 'hello' });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('{"models":[]}');
    expect(gateway.rawCalls[0]).toMatchObject({ url: '/backend-api/codex/models', headers: { 'chatgpt-account-id': 'synthetic-account-0', 'user-agent': 'client-UA' } });
    expect(gateway.rawCalls[0]?.body.toString('utf8')).toBe('hello');
    expect(gateway.calls).toHaveLength(0);
  });

  it('still returns 400 for a non-JSON POST /responses body when degrading', async () => {
    const gateway = await setup('degrade');
    const response = await fetch(`${gateway.base}/backend-api/codex/responses`, { method: 'POST', headers: { 'content-type': 'text/plain', 'chatgpt-account-id': 'synthetic-client-account' }, body: 'hello' });
    expect(response.status).toBe(400);
    expect(await response.text()).toContain('Request body must be valid JSON');
    expect(gateway.rawCalls).toHaveLength(0);
    expect(gateway.calls).toHaveLength(0);
  });

  it('does not degrade malformed JSON objects or missing providers', async () => {
    const gateway = await setup('degrade');
    expect((await gateway.post([] as unknown as Json)).status).toBe(400);
    expect(gateway.calls).toHaveLength(0);
    const empty = await setup('degrade', { count: 0 });
    expect((await empty.post()).status).toBe(400);
  });
  it('degrades mismatched responses through gateway assembly', async () => {
    const gateway = await setup('degrade');
    const response = await gateway.post();
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(readFixture('codex-relay-fallback.tdd.sse'));
    expect(gateway.calls[0]?.headers['chatgpt-account-id']).toBe('synthetic-account-0');
  });
});
