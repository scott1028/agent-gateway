// Downgrade path on POST /v1/messages for Anthropic clients that are not the official Claude Code,
// through the real server. The upstream is a mocked fetch serving test/fixtures/claude-*.sse;
// the native relay keeps its loopback upstream, so a request that reaches it was not downgraded.
// Expected upstream shape: native 2.1.299 anchors in docs/CLAUDE_UPSTREAM_PROTOCOL_DIFF.md
// (system K_o at 218995076, billing wSo at 218606801, cache NNr at 226725197, metadata nUe at
// 218996645, UA $0() at 218027148); the rebuild itself follows references/CLIProxyAPI v8.0.29
// claude_executor_cloaking.go, and client detection its helps/claude_client_detection.go.
import { createServer, type Server } from 'node:http';
import { mkdtemp, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClaudeAccount } from '../../src/accounts.js';
import type { ClaudeAuthManager } from '../../src/claude/auth.js';
import { createClaudeClient } from '../../src/claude/client.js';
import { createClaudeModelCatalog } from '../../src/claude/models.js';
import { createClaudeStateStore } from '../../src/claude/state.js';
import { CLAUDE_CLI_SYSTEM_PREFIX, CLAUDE_CLI_VERSION, CLAUDE_CODE_BETA, CLAUDE_OAUTH_BETA } from '../../src/constants.js';
import { getSessionId } from '../../src/responses/normalizeResponsesRequest.js';
import { createProxyServer } from '../../src/server.js';
import type { Json } from '../../src/types.js';
import { readFixture } from '../helpers.js';

const CLAUDE_ENV_KEYS = ['CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_AGENT_SDK_VERSION', 'CLAUDE_AGENT_SDK_CLIENT_APP', 'CLAUDE_CODE_ACTION', 'CLAUDE_CODE_ATTRIBUTION_HEADER'] as const;
const savedEnv = Object.fromEntries(CLAUDE_ENV_KEYS.map((key) => [key, process.env[key]]));
for (const key of CLAUDE_ENV_KEYS) delete process.env[key];

// Synthetic ids; the relay fixture carries the same account uuid.
const ACCOUNT_UUID = '11111111-2222-4333-8444-555555555555';
const DEVICE_ID = 'b'.repeat(64);
const API_KEY = 'test-gateway-key';
const EPHEMERAL = { type: 'ephemeral' };
const RELAY_REQUEST = JSON.parse(readFixture('claude-relay-request.json')) as { path: string; headers: Record<string, string> };
const RELAY_BODY = readFixture('claude-relay-body.json');
const TOOL = { name: 'get_weather', description: 'Weather.', input_schema: { type: 'object', properties: { city: { type: 'string' } } } };

const auth: ClaudeAuthManager = {
  getCredentials: async () => ({ accessToken: 'claude1-token' }),
  recoverUnauthorized: async () => ({ accessToken: 'claude1-token-2' }),
};

type UpstreamCall = { url: string; headers: Record<string, string>; body: Json };
let upstreamCalls: UpstreamCall[] = [];
let nextUpstream: () => Response = () => new Response(readFixture('claude-text.sse'), { status: 200, headers: { 'content-type': 'text/event-stream' } });
const fetchFn = vi.fn<typeof fetch>(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
  upstreamCalls.push({ url: String(input), headers: init?.headers as Record<string, string>, body: JSON.parse(String(init?.body)) as Json });
  return nextUpstream();
});

const sseResponse = (fixture: string): Response => new Response(readFixture(fixture), { status: 200, headers: { 'content-type': 'text/event-stream' } });

let home = '';
let relayUpstream: Server;
let relayUpstreamBodies: string[] = [];
let closeGateway: (() => void) | undefined;

beforeAll(async () => {
  home = await mkdtemp(path.join(os.tmpdir(), 'agent-gateway-cloak-'));
  await writeFile(path.join(home, '.claude.json'), JSON.stringify({ userID: DEVICE_ID, oauthAccount: { accountUuid: ACCOUNT_UUID } }));
  relayUpstream = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      relayUpstreamBodies.push(Buffer.concat(chunks).toString('utf8'));
      res.writeHead(200, { 'content-type': 'text/event-stream' }).end(readFixture('claude-text.sse'));
    });
  });
  await new Promise<void>((resolve) => relayUpstream.listen(0, '127.0.0.1', resolve));
});

afterAll(() => {
  relayUpstream.close();
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

beforeEach(() => {
  upstreamCalls = [];
  relayUpstreamBodies = [];
  nextUpstream = () => sseResponse('claude-text.sse');
});

afterEach(() => {
  closeGateway?.();
  closeGateway = undefined;
  vi.restoreAllMocks();
});

const startGateway = async (options: { apiKey?: string; debugLevel?: 2 | 3 } = {}): Promise<string> => {
  const account: ClaudeAccount = {
    provider: 'claude',
    alias: 'claude1',
    homePath: home,
    settingsPath: path.join(home, 'settings.json'),
    client: createClaudeClient({ auth, baseUrl: `http://127.0.0.1:${(relayUpstream.address() as AddressInfo).port}`, credentialsPath: path.join(home, '.credentials.json'), fetchFn }),
    catalog: createClaudeModelCatalog({ getModels: async () => [{ id: 'claude-opus-5' }] }),
    state: createClaudeStateStore({ stateDir: path.join(home, '.agent-gateway', 'claude-state') }),
  };
  const server = createProxyServer({ accounts: [account], contextLength: 200000, apiKey: options.apiKey, debugLevel: options.debugLevel });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  closeGateway = () => {
    server.closeAllConnections();
    server.close();
  };
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
};

const postMessages = (base: string, body: Json | string, headers: Record<string, string> = {}, pathname = '/v1/messages'): Promise<Response> =>
  fetch(`${base}${pathname}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'anthropic-version': '2023-06-01', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

const USER_TURN: Json = {
  model: 'claude-opus-5',
  max_tokens: 2048,
  system: [{ type: 'text', text: 'Be brief.', cache_control: { type: 'ephemeral' } }],
  messages: [{ role: 'user', content: 'weather?' }],
  tools: [TOOL],
  metadata: { user_id: 'client-user' },
  stream: true,
};

describe('POST /v1/messages downgrade path', () => {
  it('sends the gateway-built official shape upstream and passes the native SSE back untranslated', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const base = await startGateway();
    const reply = await postMessages(base, { ...USER_TURN, temperature: 0.2 });
    expect(reply.status).toBe(200);
    expect(reply.headers.get('content-type')).toContain('text/event-stream');
    expect(await reply.text()).toBe(readFixture('claude-text.sse'));

    const [call] = upstreamCalls;
    const sessionId = getSessionId(JSON.stringify(['claude1', 'claude-opus-5', { role: 'user', content: [{ type: 'text', text: 'weather?' }] }]));
    expect(call?.url).toMatch(/\/v1\/messages\?beta=true$/);
    // "weather?" -> literal fingerprint 205 (attribution.test.ts); cch is signed per body.
    expect((call?.body.system as Json[])[0]?.text).toMatch(new RegExp(`^x-anthropic-billing-header: cc_version=${CLAUDE_CLI_VERSION.replace(/\./g, '\\.')}\\.205; cc_entrypoint=cli; cch=[0-9a-f]{5};$`));
    expect((call?.body.system as Json[]).slice(1)).toEqual([{ type: 'text', text: CLAUDE_CLI_SYSTEM_PREFIX, cache_control: EPHEMERAL }]);
    expect(call?.body.messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'weather?', cache_control: EPHEMERAL }] },
      { role: 'system', content: [{ type: 'text', text: 'Be brief.', cache_control: EPHEMERAL }] },
    ]);
    expect(call?.body.tools).toEqual([TOOL]);
    expect(call?.body.metadata).toEqual({ user_id: JSON.stringify({ device_id: DEVICE_ID, account_uuid: ACCOUNT_UUID, session_id: sessionId }) });
    expect(call?.body.thinking).toEqual({ type: 'adaptive' });
    expect(call?.body).toMatchObject({ model: 'claude-opus-5', max_tokens: 2048, stream: true });
    expect(call?.body).not.toHaveProperty('temperature');
    expect(call?.headers).toMatchObject({ authorization: 'Bearer claude1-token', 'user-agent': `claude-cli/${CLAUDE_CLI_VERSION} (external, cli)`, 'x-app': 'cli', 'x-claude-code-session-id': sessionId });
    expect(call?.headers['anthropic-beta']?.split(',').slice(0, 2)).toEqual([CLAUDE_CODE_BETA, CLAUDE_OAUTH_BETA]);
    await vi.waitFor(() => expect(log.mock.calls.flat().join('\n')).toContain('model=claude1/claude-opus-5'));
    expect(log.mock.calls.flat().join('\n')).toContain('ignored=temperature');
    // The downgrade shows in the default access log, without --debug.
    const logged = log.mock.calls.flat().join('\n');
    expect(logged).toContain('degraded=not_official_client');
    // Third-party client, gateway-built send, and the tree-bracketed upstream send line.
    expect(logged).toContain('client=third_party mode=gateway');
    expect(logged).toMatch(/\n└─ POST http:\/\/127\.0\.0\.1:\d+\/v1\/messages\?beta=true model=claude-opus-5/);
  });

  it('aggregates a stream:false reply into one Message (thinking signature, tool input, usage)', async () => {
    nextUpstream = () => sseResponse('claude-tool-call.sse');
    const base = await startGateway();
    const reply = await postMessages(base, { ...USER_TURN, stream: false });
    expect(reply.status).toBe(200);
    expect(await reply.json()).toEqual({
      id: 'msg_01A2B3C4D5',
      type: 'message',
      role: 'assistant',
      model: 'claude-opus-5',
      content: [
        { type: 'thinking', thinking: 'I should call the weather tool.', signature: 'Eq4KCmUIhAIKEGN2eA5xkQ2SgBACQo1K7' },
        { type: 'tool_use', id: 'toolu_01XYZ7Qm', name: 'get_weather', input: { city: 'Paris' } },
      ],
      stop_reason: 'tool_use',
      stop_sequence: null,
      usage: { input_tokens: 40, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 58, thinking_tokens: 21 },
    });
    // Upstream is always streamed.
    expect(upstreamCalls[0]?.body.stream).toBe(true);
  });

  it('replays the thinking block the client echoes on the continuation, with the cache marker on the tool result', async () => {
    const thinking = { type: 'thinking', thinking: 'I should call the weather tool.', signature: 'Eq4KCmUIhAIKEGN2eA5xkQ2SgBACQo1K7' };
    const toolUse = { type: 'tool_use', id: 'toolu_01XYZ7Qm', name: 'get_weather', input: { city: 'Paris' } };
    const base = await startGateway();
    const reply = await postMessages(base, {
      ...USER_TURN,
      messages: [
        { role: 'user', content: 'weather?' },
        { role: 'assistant', content: [thinking, toolUse] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_01XYZ7Qm', content: 'sunny' }] },
      ],
    });
    expect(reply.status).toBe(200);
    await reply.text();
    expect(upstreamCalls[0]?.body.messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'weather?' }] },
      { role: 'system', content: [{ type: 'text', text: 'Be brief.', cache_control: EPHEMERAL }] },
      { role: 'assistant', content: [thinking, toolUse] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_01XYZ7Qm', content: 'sunny', cache_control: EPHEMERAL }] },
    ]);
    // Same first message, same session as the first turn.
    expect(upstreamCalls[0]?.headers['x-claude-code-session-id']).toBe(getSessionId(JSON.stringify(['claude1', 'claude-opus-5', { role: 'user', content: [{ type: 'text', text: 'weather?' }] }])));
  });

  it('keeps the session when an adjacent user message is appended, and still merges it upstream', async () => {
    const base = await startGateway();
    for (const messages of [[{ role: 'user', content: 'weather?' }], [{ role: 'user', content: 'weather?' }, { role: 'user', content: 'in Paris' }]]) {
      const reply = await postMessages(base, { ...USER_TURN, messages });
      expect(reply.status).toBe(200);
      await reply.text();
    }
    const getUserIdSession = (call?: UpstreamCall): unknown => (JSON.parse(String((call?.body.metadata as Json).user_id)) as Json).session_id;
    const sessionId = getSessionId(JSON.stringify(['claude1', 'claude-opus-5', { role: 'user', content: [{ type: 'text', text: 'weather?' }] }]));
    expect(upstreamCalls.map((call) => call.headers['x-claude-code-session-id'])).toEqual([sessionId, sessionId]);
    expect(upstreamCalls.map(getUserIdSession)).toEqual([sessionId, sessionId]);
    expect((upstreamCalls[1]?.body.messages as Json[])[0]).toEqual({ role: 'user', content: [{ type: 'text', text: 'weather?' }, { type: 'text', text: 'in Paris', cache_control: EPHEMERAL }] });
  });

  it('cuts the client connection when the upstream stream breaks, instead of ending it cleanly', async () => {
    // One chunk goes out first; the upstream fails a moment later.
    let pulls = 0;
    nextUpstream = () => new Response(new ReadableStream<Uint8Array>({
      pull(controller) {
        if (pulls++ === 0) {
          controller.enqueue(Buffer.from(readFixture('claude-text.sse').slice(0, 200)));
          return undefined;
        }
        return new Promise<void>((resolve) => setTimeout(() => {
          controller.error(new Error('upstream reset'));
          resolve();
        }, 50));
      },
    }), { status: 200, headers: { 'content-type': 'text/event-stream' } });
    const base = await startGateway();
    const outcome = await postMessages(base, USER_TURN).then((reply) => reply.text()).then(() => 'complete', () => 'cut');
    expect(outcome).toBe('cut');
  });

  it('answers an upstream HTTP error in the Anthropic error shape', async () => {
    nextUpstream = () => new Response(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'Slow down' } }), { status: 429, headers: { 'content-type': 'application/json' } });
    const base = await startGateway();
    const reply = await postMessages(base, USER_TURN);
    expect(reply.status).toBe(429);
    expect(await reply.json()).toEqual({ type: 'error', error: { type: 'rate_limit_error', message: 'Slow down' } });
  });

  it('answers a stream:false upstream error event with a 502 carrying the upstream error type', async () => {
    nextUpstream = () => sseResponse('claude-error.sse');
    const base = await startGateway();
    const reply = await postMessages(base, { ...USER_TURN, stream: false });
    expect(reply.status).toBe(502);
    expect(await reply.json()).toEqual({ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } });
  });

  it.each([
    ['an unsupported field', { ...USER_TURN, stop_sequences: ['x'] }, 'stop_sequences'],
    ['a forced tool with thinking on', { ...USER_TURN, tool_choice: { type: 'any' } }, 'send `thinking: {"type":"disabled"}` or `tool_choice: {"type":"auto"}`'],
    ['a max_tokens above the model limit', { ...USER_TURN, max_tokens: 10_000_000 }, '`max_tokens` exceeds'],
    ['a model without a Claude home', { ...USER_TURN, model: 'gpt-5.5' }, 'No codex account'],
  ])('rejects %s with an Anthropic 400 before any upstream call', async (_name, body, messagePart) => {
    const base = await startGateway();
    const reply = await postMessages(base, body);
    expect(reply.status).toBe(400);
    expect(await reply.json()).toEqual({ type: 'error', error: { type: 'invalid_request_error', message: expect.stringContaining(messagePart) } });
    expect(upstreamCalls).toHaveLength(0);
  });

  it('answers /v1/messages/count_tokens with an Anthropic 400 that says why, without an upstream call', async () => {
    const base = await startGateway();
    const reply = await postMessages(base, USER_TURN, {}, '/v1/messages/count_tokens');
    expect(reply.status).toBe(400);
    expect(await reply.json()).toEqual({ type: 'error', error: { type: 'invalid_request_error', message: expect.stringContaining('does not serve /v1/messages/count_tokens') } });
    expect(upstreamCalls).toHaveLength(0);
  });
});

describe('with AGENT_GATEWAY_API_KEY', () => {
  it.each([
    ['x-api-key', { 'x-api-key': API_KEY }],
    ['Authorization: Bearer', { authorization: `Bearer ${API_KEY}` }],
    ['x-agent-gateway-api-key', { 'x-agent-gateway-api-key': API_KEY }],
  ])('accepts the gateway key in %s', async (_name, headers) => {
    const base = await startGateway({ apiKey: API_KEY });
    const reply = await postMessages(base, USER_TURN, headers);
    expect(reply.status).toBe(200);
    await reply.text();
    expect(upstreamCalls[0]?.headers.authorization).toBe('Bearer claude1-token');
  });

  it.each([
    ['no key', {}],
    ['a wrong key', { 'x-api-key': 'wrong-key' }],
  ])('answers %s with an Anthropic 401 authentication_error', async (_name, headers) => {
    const base = await startGateway({ apiKey: API_KEY });
    const reply = await postMessages(base, USER_TURN, headers);
    expect(reply.status).toBe(401);
    expect(await reply.json()).toEqual({ type: 'error', error: { type: 'authentication_error', message: expect.stringContaining('x-api-key') } });
    expect(upstreamCalls).toHaveLength(0);
  });

  it('masks the whole x-api-key value in the debug log', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const base = await startGateway({ apiKey: API_KEY, debugLevel: 2 });
    const reply = await postMessages(base, USER_TURN, { 'x-api-key': API_KEY });
    expect(reply.status).toBe(200);
    await reply.text();
    await vi.waitFor(() => expect(log.mock.calls.flat().join('\n')).toContain('response 200'));
    const logged = log.mock.calls.flat().join('\n');
    expect(logged).toContain('x-api-key: ***');
    expect(logged).not.toContain(API_KEY);
  });
});

describe('official Claude Code requests stay on the native relay', () => {
  // fetch sets these itself.
  const relayHeaders = Object.fromEntries(Object.entries(RELAY_REQUEST.headers).filter(([name]) => !['host', 'connection', 'content-length'].includes(name)));

  it('relays the Claude Code request byte for byte and never downgrades it', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const base = await startGateway();
    const reply = await postMessages(base, RELAY_BODY, relayHeaders, RELAY_REQUEST.path);
    expect(reply.status).toBe(200);
    await reply.text();
    expect(relayUpstreamBodies).toEqual([RELAY_BODY]);
    expect(upstreamCalls).toHaveLength(0);
    await vi.waitFor(() => expect(log.mock.calls.flat().join('\n')).toContain('POST /v1/messages'));
    const logged = log.mock.calls.flat().join('\n');
    expect(logged).not.toContain('degraded=');
    // The official CLI's own bytes were relayed; the branch line is that upstream send.
    expect(logged).toContain('client=official mode=relay');
    expect(logged).toMatch(/\n└─ POST http:\/\/127\.0\.0\.1:\d+\/v1\/messages\?beta=true model=/);
  });

  it('downgrades the same body once the client no longer looks like Claude Code', async () => {
    const base = await startGateway();
    const reply = await postMessages(base, RELAY_BODY, { ...relayHeaders, 'user-agent': 'opencode/1.0' }, RELAY_REQUEST.path);
    // The downgrade path rejects the Claude Code-only fields instead of the relay's checks.
    expect(reply.status).toBe(400);
    expect(await reply.json()).toEqual({ type: 'error', error: { type: 'invalid_request_error', message: expect.stringContaining('context_management') } });
    expect(relayUpstreamBodies).toHaveLength(0);
    expect(upstreamCalls).toHaveLength(0);
  });
});
