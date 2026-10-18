// Matches references/claude-code native 2.1.302 relay checks and gateway-owned assembly.
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ClaudeAccount } from '../../src/accounts.js';
import { createClaudeClient } from '../../src/claude/client.js';
import { createClaudeModelCatalog } from '../../src/claude/models.js';
import { createClaudeStateStore } from '../../src/claude/state.js';
import { createProxyServer } from '../../src/server.js';
import type { Json } from '../../src/types.js';
import { readFixture } from '../helpers.js';

const body = (): Json => JSON.parse(readFixture('claude-relay-body.json')) as Json;
const headers = { 'content-type': 'application/json', 'user-agent': 'claude-cli/2.1.302', 'x-app': 'cli', 'anthropic-beta': 'oauth-2025-04-20', 'x-claude-code-session-id': 'synthetic-session' };
const servers: Server[] = [];
const homes: string[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
  for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true });
  vi.restoreAllMocks();
});

const setup = async (mode: 'reject' | 'degrade', count = 2, matching = false) => {
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  const calls: { url: string; headers: Record<string, string>; body: Json }[] = [];
  let sse = readFixture('claude-text.sse');
  const accounts: ClaudeAccount[] = [];
  for (let index = 0; index < count; index++) {
    const home = await mkdtemp(path.join(os.tmpdir(), 'fallback-'));
    homes.push(home);
    await writeFile(path.join(home, '.claude.json'), JSON.stringify({ userID: 'synthetic-device', oauthAccount: { accountUuid: matching ? '11111111-2222-4333-8444-555555555555' : `synthetic-account-${index}` } }));
    const client = createClaudeClient({ auth: { getCredentials: async () => ({ accessToken: 'synthetic-credential' }), recoverUnauthorized: async () => ({ accessToken: 'synthetic-credential' }) }, baseUrl: 'http://127.0.0.1:1', credentialsPath: path.join(home, '.credentials.json'), fetchFn: async (url, init) => {
      calls.push({ url: String(url), headers: init?.headers as Record<string, string>, body: JSON.parse(String(init?.body)) as Json });
      return String(url).includes('count_tokens') ? new Response('{"input_tokens":42}', { status: 201, headers: { 'x-test': 'kept' } }) : new Response(sse, { headers: { 'content-type': 'text/event-stream' } });
    } });
    accounts.push({ provider: 'claude', alias: `claude${index + 1}`, homePath: home, settingsPath: path.join(home, 'settings.json'), client, catalog: createClaudeModelCatalog({ getModels: async () => [] }), state: createClaudeStateStore({ stateDir: path.join(home, 'state') }) });
  }
  const server = createProxyServer({ accounts, contextLength: 200000, relayFallback: mode });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const post = (requestBody = body(), changes = {}, endpoint = '/v1/messages') => fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}${endpoint}`, { method: 'POST', headers: { ...headers, ...changes }, body: JSON.stringify(requestBody) });
  return { calls, accounts, post, setSse: (text: string) => { sse = text; } };
};

describe('Claude relay fallback', () => {
  it.each(['missing_cch', 'missing_oauth', 'account_mismatch', 'alias_mismatch', 'unbound_session', 'account_changed'])('keeps reject unchanged and degrades %s before writing bytes', async (reason) => {
    for (const mode of ['reject', 'degrade'] as const) {
      const { post, calls, accounts } = await setup(mode, 2, reason === 'alias_mismatch' || reason === 'account_changed');
      const request = body();
      let endpoint = '/v1/messages';
      const changes: Record<string, string> = {};
      if (reason === 'missing_cch') (request.system as Json[])[0] = { text: 'x-anthropic-billing-header: no signature' };
      if (reason === 'missing_oauth') changes['anthropic-beta'] = '';
      if (reason === 'alias_mismatch') request.model = 'claude2/claude-opus-5';
      if (reason === 'unbound_session') endpoint += '/count_tokens';
      if (reason === 'account_changed') accounts[0]!.client.postRawMessages = async (input) => {
        await writeFile(path.join(accounts[0]!.homePath, '.claude.json'), JSON.stringify({ oauthAccount: { accountUuid: 'synthetic-relogin' } }));
        await input.verifyAccount();
        throw new Error('verify must throw');
      };
      const response = await post(request, changes, endpoint);
      expect(response.status).toBe(mode === 'reject' ? 400 : reason === 'unbound_session' ? 201 : 200);
      await response.text();
      expect(calls).toHaveLength(mode === 'reject' ? 0 : 1);
      if (mode === 'degrade') {
        // client=official (the relay checks saw the official CLI) with mode=gateway (the send was rebuilt).
        const logged = vi.mocked(console.log).mock.calls.flat().join('\n');
        expect(logged).toContain('client=official mode=gateway');
        expect(logged).toContain(`degraded=${reason}`);
        expect(calls[0]?.headers['user-agent']).toContain('claude-cli/2.1.299');
        expect(calls[0]?.body).not.toHaveProperty('context_management');
        expect(calls[0]?.body).not.toHaveProperty('diagnostics');
        if (reason === 'unbound_session') {
          expect(Object.keys(calls[0]!.body).sort()).toEqual(['messages', 'model', 'thinking', 'tools']);
          for (const key of ['system', 'metadata', 'max_tokens', 'stream', 'safeguards', 'output_config']) expect(calls[0]?.body).not.toHaveProperty(key);
          expect(calls[0]?.headers['anthropic-beta']?.split(',')).toEqual(['claude-code-20250219', 'oauth-2025-04-20', 'interleaved-thinking-2025-05-14', 'context-management-2025-06-27', 'token-counting-2024-11-01']);
        } else {
          expect(calls[0]?.headers['anthropic-beta']).toContain('dangerous-tool-use-2026-09-03');
          expect((calls[0]?.body.system as Json[])[0]?.text).toMatch(/cch=[0-9a-f]{5}/);
        }
      }
    }
  });

  it('uses the model alias and rejects only when no provider account exists', async () => {
    const gateway = await setup('degrade');
    const response = await gateway.post({ ...body(), model: 'claude2/claude-opus-5' });
    await response.text();
    expect(JSON.parse(String((gateway.calls[0]?.body.metadata as Json).user_id)).account_uuid).toBe('synthetic-account-1');
    expect(gateway.calls[0]?.body.model).toBe('claude-opus-5');
    const empty = await setup('degrade', 0);
    expect((await empty.post()).status).toBe(400);
    expect(empty.calls).toHaveLength(0);
  });

  it.each([true, false])('records only stopped blocks from the target, then retains those signatures (stream=%s)', async (stream) => {
    const gateway = await setup('degrade');
    gateway.setSse(readFixture('claude-relay-fallback.sse'));
    const response = await gateway.post({ ...body(), stream });
    const text = await response.text();
    expect(response.status).toBe(200);
    if (stream) expect(text).toBe(readFixture('claude-relay-fallback.sse'));
    const next = body();
    (next.messages as Json[]).push({ role: 'assistant', content: [
      { type: 'thinking', thinking: 'old', signature: 'foreign-signature' },
      { type: 'thinking', thinking: 'new', signature: 'synthetic-final-signature' },
      { type: 'thinking', thinking: 'partial', signature: 'synthetic-partial-signature' },
      { type: 'redacted_thinking', data: 'synthetic-redacted' },
    ] });
    await (await gateway.post(next)).text();
    const sent = JSON.stringify(gateway.calls[1]?.body.messages);
    expect(sent).toContain('synthetic-final-signature');
    expect(sent).toContain('synthetic-redacted');
    expect(sent).not.toContain('foreign-signature');
    expect(sent).not.toContain('synthetic-partial-signature');
    const other = await gateway.post({ ...next, model: 'claude2/claude-opus-5' });
    await other.text();
    expect(JSON.stringify(gateway.calls[2]?.body.messages)).not.toContain('synthetic-final-signature');
  });

  it('rebuilds count_tokens and returns its exact status/body with target headers', async () => {
    const gateway = await setup('degrade');
    const request = body();
    delete request.metadata;
    const response = await gateway.post(request, {}, '/v1/messages/count_tokens');
    expect(response.status).toBe(201);
    expect(response.headers.get('x-test')).toBe('kept');
    expect(await response.text()).toBe('{"input_tokens":42}');
    expect(gateway.calls[0]?.url).toBe('http://127.0.0.1:1/v1/messages/count_tokens?beta=true');
    expect(gateway.calls[0]?.headers['x-claude-code-session-id']).toBe('synthetic-session');
    expect(Object.keys(gateway.calls[0]!.body).sort()).toEqual(['messages', 'model', 'thinking', 'tools']);
    expect(gateway.calls[0]?.body.thinking).toEqual(request.thinking);
    for (const key of ['metadata', 'system', 'max_tokens', 'stream']) expect(gateway.calls[0]?.body).not.toHaveProperty(key);
  });

  it.each([
    ['claude-3-5-haiku', ['oauth-2025-04-20', 'token-counting-2024-11-01']],
    ['claude-3-5-sonnet', ['claude-code-20250219', 'oauth-2025-04-20', 'token-counting-2024-11-01']],
    ['claude-haiku-4-5', ['oauth-2025-04-20', 'interleaved-thinking-2025-05-14', 'context-management-2025-06-27', 'token-counting-2024-11-01']],
  ])('counts %s without tools/thinking/generation fields using model-gated betas', async (model, betas) => {
    const gateway = await setup('degrade');
    const catalog = vi.spyOn(gateway.accounts[1]!.catalog, 'findModel');
    const request: Json = { ...body(), model: `claude2/${String(model)}`, tools: [] };
    delete request.thinking;
    delete request.max_tokens;
    await (await gateway.post(request, {}, '/v1/messages/count_tokens')).text();
    const call = gateway.calls[0]!;
    expect(Object.keys(call.body).sort()).toEqual(['messages', 'model']);
    expect(call.body.model).toBe(model);
    expect(call.body.messages).toEqual([
      (body().messages as Json[])[0],
      { role: 'system', content: [{ type: 'text', text: 'Fixture session guidance.' }] },
    ]);
    expect(call.headers['anthropic-beta']?.split(',')).toEqual(betas);
    expect(call.headers['user-agent']).toContain('claude-cli/2.1.299');
    expect(catalog).not.toHaveBeenCalled();
  });

  it.each(['deferred', 'reference'])('counts %s tools without advanced-tool-use or generation betas', async (shape) => {
    const gateway = await setup('degrade');
    const request = body();
    request.thinking = { type: 'enabled', budget_tokens: 2048 };
    request.tools = [{ name: 'Deferred', ...(shape === 'deferred' ? { defer_loading: true } : { input_schema: { type: 'object' } }), cache_control: {} }];
    request.messages = [{ role: 'user', cache_control: {}, content: shape === 'reference'
      ? [{ type: 'tool_result', tool_use_id: 'synthetic-tool', cache_control: {}, content: [{ type: 'tool_reference', tool_name: 'Deferred', cache_control: {} }] }]
      : [{ type: 'text', text: 'hi', cache_control: {} }] }];
    await (await gateway.post(request, { 'anthropic-beta': 'oauth-2025-04-20,advanced-tool-use-2025-11-20,dangerous-tool-use-2026-09-03,effort-2025-11-24' }, '/v1/messages/count_tokens')).text();
    const call = gateway.calls[0]!;
    expect(Object.keys(call.body).sort()).toEqual(['messages', 'model', 'thinking', 'tools']);
    expect(call.body.thinking).toEqual(request.thinking);
    expect(JSON.stringify(call.body)).not.toContain('cache_control');
    expect(JSON.stringify(call.body)).toContain(shape === 'reference' ? 'tool_reference' : 'defer_loading');
    expect(call.headers['anthropic-beta']?.split(',')).toEqual(['claude-code-20250219', 'oauth-2025-04-20', 'interleaved-thinking-2025-05-14', 'context-management-2025-06-27', 'token-counting-2024-11-01']);
  });

  it('filters count history using the same recorded-target thinking policy without adding cache markers', async () => {
    const gateway = await setup('degrade');
    gateway.setSse(readFixture('claude-relay-fallback.sse'));
    await (await gateway.post()).text();
    const request = body();
    request.messages = [{ role: 'assistant', content: [
      { type: 'thinking', thinking: 'old', signature: 'foreign-signature' },
      { type: 'thinking', thinking: 'new', signature: 'synthetic-final-signature' },
      { type: 'redacted_thinking', data: 'synthetic-redacted' },
    ] }];
    await (await gateway.post(request, {}, '/v1/messages/count_tokens')).text();
    expect(gateway.calls[1]?.body.messages).toEqual([{ role: 'assistant', content: [
      { type: 'thinking', thinking: 'new', signature: 'synthetic-final-signature' },
      { type: 'redacted_thinking', data: 'synthetic-redacted' },
    ] }]);
    expect(JSON.stringify(gateway.calls[1]?.body)).not.toContain('cache_control');
  });

  it('does not degrade invalid bodies or gateway authentication failures', async () => {
    const gateway = await setup('degrade');
    expect((await gateway.post([] as unknown as Json)).status).toBe(400);
    expect(gateway.calls).toHaveLength(0);
  });
  it('degrades an unmatched official client to the first provider account', async () => {
    const { post, calls } = await setup('degrade');
    const response = await post();
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(readFixture('claude-text.sse'));
    expect(JSON.parse(String((calls[0]?.body.metadata as Json).user_id))).toMatchObject({ account_uuid: 'synthetic-account-0', session_id: 'synthetic-session' });
  });
});
