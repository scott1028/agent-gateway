// End-to-end proxy behaviour for a Claude account: routing, request shaping, stream
// translation and thinking replay across both OpenAI-compatible endpoints. The upstream is a
// mocked fetch serving the saved fixtures in test/fixtures/claude-*.sse.
// Upstream UA/Accept expectations mirror the official $0() at native offset 218027148 and the
// SDK buildHeaders Accept at 218991503 (native release 2.1.299 SHA256 2d894a4b1bfaaa9a;
// references/claude-code @9b4f0d6 plugin code is not the full CLI transport).
import type { AddressInfo } from 'node:net';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Account, ClaudeAccount } from '../../src/accounts.js';
import { createClaudeAuthManager } from '../../src/claude/auth.js';
import type { ClaudeAuthManager } from '../../src/claude/auth.js';
import { CLAUDE_CLI_VERSION } from '../../src/constants.js';
import { getConfig } from '../../src/config.js';
import { createModelCatalog } from '../../src/models.js';
import { createClaudeClient } from '../../src/claude/client.js';
import { createClaudeModelCatalog } from '../../src/claude/models.js';
import { createClaudeStateStore } from '../../src/claude/state.js';
import { createProxyServer } from '../../src/server.js';
import type { Json } from '../../src/types.js';
import { createCodexClient } from '../../src/upstream/codexClient.js';
import { readFixture } from '../helpers.js';

// File-level isolation: the UA generator and attribution read these env vars, so every test in
// this file runs with them cleared; the originals are restored after the file finishes.
const CLAUDE_ENV_KEYS = ['CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_AGENT_SDK_VERSION', 'CLAUDE_AGENT_SDK_CLIENT_APP', 'CLAUDE_CODE_ACTION', 'CLAUDE_CODE_ATTRIBUTION_HEADER'] as const;
const savedUaEnv = Object.fromEntries(CLAUDE_ENV_KEYS.map((key) => [key, process.env[key]]));
for (const key of CLAUDE_ENV_KEYS) delete process.env[key];
afterAll(() => {
  for (const [key, value] of Object.entries(savedUaEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

const TOOL_CALL_ID = 'toolu_01XYZ7Qm';
// A logged-in Claude home keeps its account record in the global config (W_/BO/nUe); signed
// replay requires that proven identity, so the mocked home carries a synthetic real-shaped one.
const ACCOUNT_UUID = '11111111-2222-4333-8444-555555555555';
const DEVICE_ID = 'a'.repeat(64);

const auth: ClaudeAuthManager = {
  getCredentials: async () => ({ accessToken: 'at-1' }),
  recoverUnauthorized: async () => ({ accessToken: 'at-2' }),
};

let home = '';
const upstreamRequests: Json[] = [];
const upstreamHeaders: Record<string, string>[] = [];
let nextFixture = 'claude-text.sse';
// Set to a body to make the mocked upstream answer with a plain (non-SSE) JSON success response.
let nextJsonBody: Json | undefined;
// Set to a stream to serve the next upstream call once; the test decides when it ends.
let nextStreamBody: ReadableStream<Uint8Array> | undefined;
const instances: ReturnType<typeof createProxyServer>[] = [];
let baseUrl = '';

const fetchFn = vi.fn<typeof fetch>(async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
  upstreamRequests.push(JSON.parse(String(init?.body)) as Json);
  upstreamHeaders.push(init?.headers as Record<string, string>);
  if (nextJsonBody !== undefined) {
    return new Response(JSON.stringify(nextJsonBody), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  const streamBody = nextStreamBody;
  nextStreamBody = undefined;
  return new Response(streamBody ?? readFixture(nextFixture), { status: 200, headers: { 'content-type': 'text/event-stream' } });
});

const makeAccount = (homePath: string): Account => ({
  provider: 'claude',
  alias: 'claude1',
  homePath,
  settingsPath: path.join(homePath, 'settings.json'),
  client: createClaudeClient({ auth, baseUrl: 'http://127.0.0.1:1', credentialsPath: path.join(homePath, '.credentials.json'), fetchFn }),
  catalog: createClaudeModelCatalog({ getModels: async () => [{ id: 'claude-opus-5' }] }),
  state: createClaudeStateStore({ stateDir: path.join(homePath, '.agent-gateway', 'claude-state') }),
});

const startServer = async (...accounts: Account[]): Promise<string> => {
  const instance = createProxyServer({ accounts, contextLength: 200000 });
  await new Promise<void>((resolve) => instance.listen(0, '127.0.0.1', resolve));
  instances.push(instance);
  return `http://127.0.0.1:${(instance.address() as AddressInfo).port}/v1`;
};

beforeAll(async () => {
  home = await mkdtemp(path.join(os.tmpdir(), 'agent-gateway-claude-e2e-'));
  await writeFile(path.join(home, '.claude.json'), JSON.stringify({ userID: DEVICE_ID, oauthAccount: { accountUuid: ACCOUNT_UUID } }));
  baseUrl = await startServer(makeAccount(home));
});

afterAll(() => new Promise<void>((resolve) => {
  for (const instance of instances) {
    instance.closeAllConnections();
    instance.close();
  }
  resolve();
}));

const post = async (pathname: string, body: Json, base = baseUrl): Promise<Response> =>
  fetch(`${base}${pathname}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

const lastUpstreamRequest = (): Json => upstreamRequests.at(-1) ?? {};

// Shared by the four basic API cases: every upstream Messages call carries the official-shaped
// UA and JSON Accept, and the body still asks for a stream (native 2.1.299 $0() @218027148,
// SDK buildHeaders @218991503, main inference call stream:!0 @226675303).
const expectOfficialClaudeUpstreamCall = (): void => {
  const headers = upstreamHeaders.at(-1) ?? {};
  expect(headers['user-agent']).toBe(`claude-cli/${CLAUDE_CLI_VERSION} (external, cli)`);
  expect(headers.accept).toBe('application/json');
  expect(lastUpstreamRequest().stream).toBe(true);
};

// Parse the JSON payloads of an SSE body so tests can assert actual delta values and the text a
// client would reconstruct, not just event-name presence.
const sseDataOf = (text: string): Json[] =>
  text
    .split('\n')
    .filter((line) => line.startsWith('data: ') && line !== 'data: [DONE]')
    .map((line) => JSON.parse(line.slice(6)) as Json);

// Prompt caching matches tools -> system -> messages as a prefix; a moving breakpoint marker does
// not decide a hit by itself, so cache_control is removed at every level before comparing.
const stripCacheControl = (node: unknown): unknown => {
  if (Array.isArray(node)) return node.map(stripCacheControl);
  if (node === null || typeof node !== 'object') return node;
  return Object.fromEntries(Object.entries(node).filter(([key]) => key !== 'cache_control').map(([key, value]) => [key, stripCacheControl(value)]));
};

const USER_TURN: Json = {
  model: 'claude-opus-5',
  messages: [{ role: 'user', content: 'weather?' }],
  tools: [{ type: 'function', function: { name: 'get_weather', parameters: { type: 'object', properties: { city: { type: 'string' } } } } }],
};

// Same turn in the Responses shape: the Claude branch never runs the Codex request normalizer.
const RESPONSES_TURN: Json = {
  model: 'claude-opus-5',
  input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'weather?' }] }],
  tools: [{ type: 'function', name: 'get_weather', parameters: { type: 'object', properties: { city: { type: 'string' } } } }],
};

describe('/v1/models', () => {
  it('lists the Claude account with the anthropic owner label', async () => {
    const list = (await (await fetch(`${baseUrl}/models`)).json()) as { data: Json[] };
    expect(list.data).toEqual([
      {
        id: 'claude1/claude-opus-5',
        object: 'model',
        created: 0,
        owned_by: 'anthropic',
        description: `Claude home: ${home}`,
        context_length: 200000,
      },
    ]);
  });
});

describe('/v1/responses', () => {
  it('streams translated Responses events for a Claude turn', async () => {
    nextFixture = 'claude-text.sse';
    const response = await post('/responses', { ...RESPONSES_TURN, stream: true });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    const text = await response.text();
    expect(text).toContain('event: response.created');
    expect(text).toContain('event: response.output_text.delta');
    expect(text).toContain('event: response.completed');
    // output_text.delta must carry the STRING chunk (never the native delta object), and an
    // accumulator appending the deltas sees the client-visible text exactly once.
    const events = sseDataOf(text);
    const textDeltas = events.filter((event) => event.type === 'response.output_text.delta');
    expect(textDeltas.map((event) => event.delta)).toEqual(['Hello', ' there.']);
    expect(textDeltas.every((event) => typeof event.delta === 'string')).toBe(true);
    const addedParts = events.filter((event) => event.type === 'response.content_part.added');
    expect(addedParts.every((event) => ((event.part as Json).text as string) === '')).toBe(true);
    expect(text).not.toContain('[object Object]');
    // K_o tail shape (native 2.1.299 @218995076): billing block uncached, interactive CLI prefix
    // cached; "weather?" gives fingerprint 205. Final CCH vectors are in signing.tdd.test.ts.
    expect(lastUpstreamRequest().system).toEqual([
      { type: 'text', text: expect.stringMatching(/^x-anthropic-billing-header: cc_version=2\.1\.299\.205; cc_entrypoint=cli; cch=[0-9a-f]{5};$/) },
      { type: 'text', text: "You are Claude Code, Anthropic's official CLI for Claude.", cache_control: { type: 'ephemeral' } },
    ]);
    expect(lastUpstreamRequest().thinking).toEqual({ type: 'adaptive' });
    // The official inference call always streams, whatever the client asked for.
    expect(lastUpstreamRequest().stream).toBe(true);
    expect(upstreamHeaders.at(-1)?.['anthropic-beta']).toBe('claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14,redact-thinking-2026-02-12,thinking-token-count-2026-05-13,context-management-2025-06-27,prompt-caching-scope-2026-01-05,effort-2025-11-24');
    // nUe at 218996645: metadata.user_id carries the home's device userID, account uuid and the
    // gateway session.
    const userId = JSON.parse(String((lastUpstreamRequest().metadata as Json).user_id));
    expect(userId).toEqual({ device_id: DEVICE_ID, account_uuid: ACCOUNT_UUID, session_id: expect.stringMatching(/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/) });
    // The UA mirrors the official $0() generator (user-approved) and Accept mirrors the SDK
    // buildHeaders default; the upstream body still asks for a stream.
    expectOfficialClaudeUpstreamCall();
  });

  it('returns a collected response when stream is not requested', async () => {
    nextFixture = 'claude-text.sse';
    const response = await post('/responses', RESPONSES_TURN);
    expect(response.headers.get('content-type')).toContain('application/json');
    const body = (await response.json()) as Json;
    expect(body.status).toBe('completed');
    expect((body.output as Json[])[0]?.content).toEqual([{ type: 'output_text', text: 'Hello there.', annotations: [], logprobs: [] }]);
    expect(body.usage).toMatchObject({ input_tokens: 1512, output_tokens: 17 });
    expectOfficialClaudeUpstreamCall();
  });

  it('sends json_schema structured output upstream', async () => {
    const response = await post('/responses', {
      ...RESPONSES_TURN,
      text: { format: { type: 'json_schema', json_schema: { name: 'answer', schema: { type: 'object', properties: { a: { type: 'string' } } } } } },
    });
    expect(response.status).toBe(200);
    expect(lastUpstreamRequest().output_config).toMatchObject({ format: { type: 'json_schema', schema: { type: 'object', properties: { a: { type: 'string' } } } } });
    expect(upstreamHeaders.at(-1)?.['anthropic-beta']).toContain('structured-outputs-2025-12-15');
  });

  it('rejects json_object structured output instead of guessing an equivalent', async () => {
    const response = await post('/responses', { ...RESPONSES_TURN, text: { format: { type: 'json_object' } } });
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: { message: string } }).error.message).toContain('Only `json_schema`');
  });
});

describe('/v1/chat/completions', () => {
  it('renders a non-stream chat completion', async () => {
    nextFixture = 'claude-text.sse';
    const response = await post('/chat/completions', USER_TURN);
    expect(response.headers.get('content-type')).toContain('application/json');
    const body = (await response.json()) as Json;
    expect(body.object).toBe('chat.completion');
    expect((body.choices as Json[])[0]?.message).toMatchObject({ role: 'assistant', content: 'Hello there.' });
    expect(body.usage).toMatchObject({ prompt_tokens: 1512, completion_tokens: 17, total_tokens: 1529 });
    expectOfficialClaudeUpstreamCall();
  });

  it('renders a streamed chat completion and ends with [DONE]', async () => {
    nextFixture = 'claude-text.sse';
    const response = await post('/chat/completions', { ...USER_TURN, stream: true });
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    const text = await response.text();
    expect(text).toContain('"object":"chat.completion.chunk"');
    // The client-visible text must arrive as plain strings and reassemble exactly once.
    const content = sseDataOf(text)
      .map((chunk) => String((((chunk.choices as Json[] | undefined) ?? [])[0]?.delta as Json | undefined)?.content ?? ''))
      .join('');
    expect(content).toBe('Hello there.');
    expect(text).not.toContain('[object Object]');
    expect(text.trimEnd().endsWith('data: [DONE]')).toBe(true);
    expectOfficialClaudeUpstreamCall();
  });

  it('continues a tool-use turn by replaying the stored thinking block', async () => {
    nextFixture = 'claude-tool-call.sse';
    const first = (await (await post('/chat/completions', USER_TURN)).json()) as Json;
    const toolCall = ((first.choices as Json[])[0]?.message as Json).tool_calls as Json[];
    expect(toolCall[0]).toMatchObject({ id: TOOL_CALL_ID, function: { name: 'get_weather', arguments: '{"city":"Paris"}' } });

    nextFixture = 'claude-text.sse';
    const second = await post('/chat/completions', {
      model: USER_TURN.model,
      messages: [
        ...(USER_TURN.messages as Json[]),
        { role: 'assistant', content: null, tool_calls: toolCall },
        { role: 'tool', tool_call_id: TOOL_CALL_ID, content: 'sunny in Paris' },
      ],
      tools: (USER_TURN.tools as Json[]),
    });
    expect(second.status).toBe(200);
    const replayed = (lastUpstreamRequest().messages as Json[])[1];
    expect(replayed).toEqual({
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'I should call the weather tool.', signature: 'Eq4KCmUIhAIKEGN2eA5xkQ2SgBACQo1K7' },
        { type: 'tool_use', id: TOOL_CALL_ID, name: 'get_weather', input: { city: 'Paris' } },
      ],
    });
    expect((lastUpstreamRequest().messages as Json[])[2]).toMatchObject({ role: 'user', content: [{ type: 'tool_result' }] });
  });

  it('rejects a tool round trip whose stored thinking is missing', async () => {
    nextFixture = 'claude-text.sse';
    const response = await post('/chat/completions', {
      model: USER_TURN.model,
      messages: [
        { role: 'user', content: 'a conversation nobody has started before?' },
        { role: 'assistant', content: null, tool_calls: [{ id: 'toolu_never_seen', type: 'function', function: { name: 'get_weather', arguments: '{}' } }] },
        { role: 'tool', tool_call_id: 'toolu_never_seen', content: 'sunny' },
      ],
      tools: (USER_TURN.tools as Json[]),
    });
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: { message: string } }).error.message).toContain('No stored Claude thinking state');
  });
});

describe('restart continuation', () => {
  it('replays stored thinking after a fresh start over the same home', async () => {
    const turn: Json = {
      model: 'claude-opus-5',
      messages: [{ role: 'user', content: 'what time is it in Tokyo?' }],
      tools: [{ type: 'function', function: { name: 'get_weather', parameters: { type: 'object', properties: { city: { type: 'string' } } } } }],
    };
    nextFixture = 'claude-tool-call.sse';
    const first = (await (await post('/chat/completions', turn)).json()) as Json;
    const toolCall = ((first.choices as Json[])[0]?.message as Json).tool_calls as Json[];

    nextFixture = 'claude-text.sse';
    // A brand new account and state store over the same home: only the disk state can carry the turn.
    const restartedBaseUrl = await startServer(makeAccount(home));
    const response = await post(
      '/chat/completions',
      {
        model: turn.model,
        messages: [
          ...(turn.messages as Json[]),
          { role: 'assistant', content: null, tool_calls: toolCall },
          { role: 'tool', tool_call_id: TOOL_CALL_ID, content: 'noon in Tokyo' },
        ],
        tools: turn.tools as Json[],
      },
      restartedBaseUrl,
    );
    expect(response.status).toBe(200);
    expect((lastUpstreamRequest().messages as Json[])[1]).toMatchObject({
      role: 'assistant',
      content: [{ type: 'thinking', signature: expect.any(String) }, { type: 'tool_use', id: TOOL_CALL_ID }],
    });
  });

  it('allows a new user turn after the tool cycle completed', async () => {
    // R3: a finished cycle must not need replay state, so the next user turn works with fresh state.
    const turn: Json = {
      model: 'claude-opus-5',
      messages: [{ role: 'user', content: 'anything new?' }],
      tools: [{ type: 'function', function: { name: 'get_weather', parameters: { type: 'object', properties: { city: { type: 'string' } } } } }],
    };
    nextFixture = 'claude-tool-call.sse';
    const first = (await (await post('/chat/completions', turn)).json()) as Json;
    const toolMessage = (first.choices as Json[])[0]?.message as Json;

    nextFixture = 'claude-text.sse';
    const second = (await (await post('/chat/completions', {
      ...turn,
      messages: [...(turn.messages as Json[]), toolMessage, { role: 'tool', tool_call_id: TOOL_CALL_ID, content: 'sunny' }],
    })).json()) as Json;

    const third = await post('/chat/completions', {
      ...turn,
      messages: [
        ...(turn.messages as Json[]),
        toolMessage,
        { role: 'tool', tool_call_id: TOOL_CALL_ID, content: 'sunny' },
        (second.choices as Json[])[0]?.message as Json,
        { role: 'user', content: 'and now?' },
      ],
    });
    expect(third.status).toBe(200);
    const roles = (lastUpstreamRequest().messages as Json[]).map((message) => message.role);
    expect(roles).toEqual(['user', 'assistant', 'user', 'assistant', 'user']);
  });
});

describe('text + tool round trip', () => {
  // An ordinary assistant turn mixing text and a tool call must survive the Chat aggregation
  // unchanged: the client echoes the content it received and the signed turn replays exactly.
  const turn: Json = {
    model: 'claude-opus-5',
    messages: [{ role: 'user', content: 'Look up x.' }],
    tools: [{ type: 'function', function: { name: 'lookup', parameters: { type: 'object', properties: {} } } }],
  };
  const responsesTurn: Json = {
    model: 'claude-opus-5',
    input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Look up x.' }] }],
    tools: [{ type: 'function', name: 'lookup', parameters: { type: 'object', properties: {} } }],
  };

  it('echoes two text blocks plus a tool call through Chat with a restart', async () => {
    nextFixture = 'claude-text-tool.sse';
    const first = (await (await post('/chat/completions', turn)).json()) as Json;
    const message = (first.choices as Json[])[0]?.message as Json;
    // Claude text items join without a separator, so the echo matches the native blocks exactly.
    expect(message.content).toBe('Before tool.After tool.');
    expect(message.tool_calls).toMatchObject([{ id: 'toolu_test', function: { name: 'lookup', arguments: '{}' } }]);

    nextFixture = 'claude-text.sse';
    const restartedBaseUrl = await startServer(makeAccount(home));
    const second = await post(
      '/chat/completions',
      {
        ...turn,
        messages: [...(turn.messages as Json[]), message, { role: 'tool', tool_call_id: 'toolu_test', content: 'found' }],
      },
      restartedBaseUrl,
    );
    expect(second.status).toBe(200);
    const replayed = (lastUpstreamRequest().messages as Json[]).find((message) => message.role === 'assistant') as Json;
    expect(replayed.content).toEqual([
      { type: 'thinking', thinking: 'private test thought', signature: 'fake-test-signature' },
      { type: 'text', text: 'Before tool.' },
      { type: 'tool_use', id: 'toolu_test', name: 'lookup', input: {} },
      { type: 'text', text: 'After tool.' },
    ]);

    const secondMessage = ((await second.json()) as Json).choices as Json[];
    const third = await post(
      '/chat/completions',
      {
        ...turn,
        messages: [
          ...(turn.messages as Json[]),
          message,
          { role: 'tool', tool_call_id: 'toolu_test', content: 'found' },
          secondMessage[0]?.message as Json,
          { role: 'user', content: 'Now answer a new question.' },
        ],
      },
      restartedBaseUrl,
    );
    expect(third.status).toBe(200);
  });

  it('echoes the same turn through Responses with a restart', async () => {
    nextFixture = 'claude-text-tool.sse';
    const first = (await (await post('/responses', responsesTurn)).json()) as Json;
    const output = first.output as Json[];
    expect(output.filter((item) => item.type === 'message').map((item) => ((item.content as Json[])[0]?.text as string))).toEqual(['Before tool.', 'After tool.']);

    nextFixture = 'claude-text.sse';
    const restartedBaseUrl = await startServer(makeAccount(home));
    const second = await post(
      '/responses',
      {
        ...responsesTurn,
        input: [...(responsesTurn.input as Json[]), ...output, { type: 'function_call_output', call_id: 'toolu_test', output: 'found' }],
      },
      restartedBaseUrl,
    );
    expect(second.status).toBe(200);
    const replayed = (lastUpstreamRequest().messages as Json[]).find((message) => message.role === 'assistant') as Json;
    expect((replayed.content as Json[]).filter((block) => block.type === 'thinking')).toEqual([
      { type: 'thinking', thinking: 'private test thought', signature: 'fake-test-signature' },
    ]);
    expect((replayed.content as Json[]).filter((block) => block.type === 'text').map((block) => block.text)).toEqual(['Before tool.', 'After tool.']);
  });

  it('rejects a Chat echo whose joined text was edited', async () => {
    nextFixture = 'claude-text.sse';
    const response = await post('/chat/completions', {
      ...turn,
      messages: [
        ...(turn.messages as Json[]),
        { role: 'assistant', content: 'Before tool.\n\nAfter tool.', tool_calls: [{ id: 'toolu_test', type: 'function', function: { name: 'lookup', arguments: '{}' } }] },
        { role: 'tool', tool_call_id: 'toolu_test', content: 'found' },
      ],
      tools: turn.tools as Json[],
    });
    expect(response.status).toBe(400);
  });
});

describe('previous_response_id', () => {
  const turn: Json = {
    model: 'claude-opus-5',
    input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'weather, continued by id?' }] }],
    tools: RESPONSES_TURN.tools,
  };

  it('continues a tool-use turn by id and replays the stored signed thinking block', async () => {
    nextFixture = 'claude-tool-call.sse';
    const first = (await (await post('/responses', turn)).json()) as Json;
    const output = first.output as Json[];
    expect(output.find((item) => item.type === 'function_call')).toMatchObject({ call_id: TOOL_CALL_ID, name: 'get_weather' });

    nextFixture = 'claude-text.sse';
    const toolOutput = { type: 'function_call_output', call_id: TOOL_CALL_ID, output: 'sunny in Paris' };
    const second = await post('/responses', { model: turn.model, previous_response_id: first.id, input: [toolOutput], tools: turn.tools });
    expect(second.status).toBe(200);
    const expanded = lastUpstreamRequest();
    expect((expanded.messages as Json[])[1]).toEqual({
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'I should call the weather tool.', signature: 'Eq4KCmUIhAIKEGN2eA5xkQ2SgBACQo1K7' },
        { type: 'tool_use', id: TOOL_CALL_ID, name: 'get_weather', input: { city: 'Paris' } },
      ],
    });
    expect((expanded.messages as Json[])[2]).toMatchObject({ role: 'user', content: [{ type: 'tool_result' }] });
    expect(expanded).not.toHaveProperty('previous_response_id');

    // A client resending the full history produces the same upstream body.
    await post('/responses', { ...turn, input: [...(turn.input as Json[]), ...output, toolOutput] });
    expect(lastUpstreamRequest()).toEqual(expanded);
  });

  it('keeps tools, system, the message prefix and the session stable across a continuation', async () => {
    const cacheTurn: Json = { model: 'claude-opus-5', tools: RESPONSES_TURN.tools };
    nextFixture = 'claude-text.sse';
    const first = (await (await post('/responses', { ...cacheTurn, input: 'cache me, then continue by id' })).json()) as Json;
    const firstRequest = lastUpstreamRequest();
    const firstHeaders = upstreamHeaders.at(-1) ?? {};
    const second = await post('/responses', { ...cacheTurn, previous_response_id: first.id, input: 'and a follow-up' });
    expect(second.status).toBe(200);
    const secondRequest = lastUpstreamRequest();
    const secondHeaders = upstreamHeaders.at(-1) ?? {};

    expect(Array.isArray(firstRequest.tools)).toBe(true);
    expect(secondRequest.tools).toEqual(firstRequest.tools);
    // The billing block's cch differs per request by official design: src/claude/attribution.ts:82-96
    // signs every final body, and references/CLIProxyAPI @5fc580b1
    // internal/runtime/executor/claude_signing.go:180-201 quotes the native gate that always sends
    // cch for firstParty on api.anthropic.com. Mocks cannot show whether upstream ignores cch when
    // matching the cache; only a manual real run (turn 2 usage cached_tokens > 0) confirms it. So
    // only the single trailing cch of the billing block in system[0] is masked; everything else,
    // the cc_version fingerprint and the other system blocks included, is compared as is.
    const maskBillingCch = (system: unknown): Json[] => {
      const [billing, ...otherBlocks] = stripCacheControl(system) as Json[];
      const text = String(billing?.text);
      expect(text.startsWith('x-anthropic-billing-header:')).toBe(true);
      expect(text).toMatch(/ cch=[0-9a-f]{5};$/);
      const masked = text.replace(/cch=[0-9a-f]{5};$/, 'cch=xxxxx;');
      expect(masked).toBe(`${text.slice(0, -'xxxxx;'.length)}xxxxx;`);
      return [{ ...billing, text: masked }, ...otherBlocks];
    };
    expect(maskBillingCch(secondRequest.system)).toEqual(maskBillingCch(firstRequest.system));
    const firstMessages = stripCacheControl(firstRequest.messages) as Json[];
    const secondMessages = stripCacheControl(secondRequest.messages) as Json[];
    // The prefix must be the real first turn, never an empty conversation.
    expect(firstMessages).toEqual([{ role: 'user', content: [{ type: 'text', text: 'cache me, then continue by id' }] }]);
    expect(secondMessages.length).toBeGreaterThan(firstMessages.length);
    expect(secondMessages.slice(0, firstMessages.length)).toEqual(firstMessages);
    // Both turns carry the same non-empty session id in metadata and in the header.
    const getSessionOf = (request: Json): unknown => (JSON.parse(String((request.metadata as Json).user_id)) as Json).session_id;
    const firstSession = getSessionOf(firstRequest);
    expect(firstSession).toEqual(expect.stringMatching(/\S/));
    expect(firstHeaders['x-claude-code-session-id']).toBe(firstSession);
    expect(getSessionOf(secondRequest)).toBe(firstSession);
    expect(secondHeaders['x-claude-code-session-id']).toBe(firstSession);
  });

  it('keeps the record before the client sees response.completed on a stream', async () => {
    let closeUpstream = (): void => undefined;
    nextStreamBody = new ReadableStream<Uint8Array>({
      start: (controller) => {
        controller.enqueue(new TextEncoder().encode(readFixture('claude-text.sse')));
        closeUpstream = () => controller.close();
      },
    });
    const first = await post('/responses', { model: 'claude-opus-5', input: 'stream, then continue by id', stream: true });
    const reader = (first.body as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    let streamed = '';
    while (!streamed.includes('event: response.completed\n') || !streamed.endsWith('\n\n')) {
      const { value } = await reader.read();
      streamed += decoder.decode(value, { stream: true });
    }
    const completed = sseDataOf(streamed).find((event) => event.type === 'response.completed');

    // The upstream stream is still open after message_stop, so only a save made before the write can serve this.
    nextFixture = 'claude-text.sse';
    const second = await post('/responses', { model: 'claude-opus-5', previous_response_id: (completed?.response as Json).id, input: 'again' });
    expect(second.status).toBe(200);
    const messages = lastUpstreamRequest().messages as Json[];
    expect(messages.map((message) => message.role)).toEqual(['user', 'assistant', 'user']);
    expect(messages[0]?.content).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'text', text: 'stream, then continue by id' })]));
    expect(messages[1]?.content).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'text', text: 'Hello there.' })]));

    closeUpstream();
    for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) streamed += decoder.decode(chunk.value, { stream: true });
  });

  it('rejects a continuation after the home relogs into another account, before any upstream call', async () => {
    const reloginHome = await mkdtemp(path.join(os.tmpdir(), 'agent-gateway-claude-previous-'));
    const login = (uuid: string): Promise<void> => writeFile(path.join(reloginHome, '.claude.json'), JSON.stringify({ oauthAccount: { accountUuid: uuid } }));
    await login('uuid-A');
    const reloginUrl = await startServer(makeAccount(reloginHome));
    nextFixture = 'claude-text.sse';
    const first = (await (await post('/responses', { model: 'claude-opus-5', input: 'private prompt of A' }, reloginUrl)).json()) as Json;
    expect(JSON.parse(String((lastUpstreamRequest().metadata as Json).user_id)).account_uuid).toBe('uuid-A');

    await login('uuid-B');
    const before = upstreamRequests.length;
    const response = await post('/responses', { model: 'claude-opus-5', previous_response_id: first.id, input: 'again' }, reloginUrl);
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: { message: string } }).error.message).toBe(
      `Previous response with id '${String(first.id)}' was created under another login; start a new conversation.`,
    );
    expect(upstreamRequests.length).toBe(before);
  });

  it('rejects a Codex account response id on a Claude model before any Claude upstream call', async () => {
    const config = getConfig({}, ['/tmp/claude-e2e-codex']);
    const codexAccount: Account = {
      provider: 'codex',
      alias: 'codex1',
      homePath: '/tmp/claude-e2e-codex',
      catalog: createModelCatalog({ getModels: async () => [{ slug: 'gpt-x' }] }),
      client: createCodexClient({
        auth: {
          getCredentials: async () => ({ accessToken: 'test-token', isFedramp: false }),
          recoverUnauthorized: async () => ({ accessToken: 'test-token', isFedramp: false }),
        },
        config,
        authPath: '/tmp/claude-e2e-codex/auth.json',
        fetchFn: async () => new Response(readFixture('text-nonlite.sse')),
      }),
    };
    const mixedUrl = await startServer(codexAccount, makeAccount(home));
    const codexResponse = (await (await post('/responses', { model: 'codex1/gpt-x', input: 'ping' }, mixedUrl)).json()) as Json;
    const before = upstreamRequests.length;
    const response = await post('/responses', { model: 'claude1/claude-opus-5', previous_response_id: codexResponse.id, input: 'again' }, mixedUrl);
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: { message: string } }).error.message).toContain('another account');
    expect(upstreamRequests.length).toBe(before);
  });
});

describe('account identity', () => {
  it('fails explicitly when the home has no account record, before touching the catalog', async () => {
    // Signed replay needs a proven account identity: a home without the login's global account
    // record must fail before any upstream call instead of keying state on an unproven identity.
    // The catalog may call /v1/models upstream, so the identity preflight must also run BEFORE
    // any catalog access.
    const bareHome = await mkdtemp(path.join(os.tmpdir(), 'agent-gateway-claude-bare-'));
    const account = makeAccount(bareHome) as ClaudeAccount;
    const catalogCalls: string[] = [];
    const guardedAccount: Account = {
      ...account,
      catalog: {
        listModels: async () => {
          catalogCalls.push('listModels');
          return account.catalog.listModels();
        },
        findModel: async (slug: string) => {
          catalogCalls.push('findModel');
          return account.catalog.findModel(slug);
        },
      },
    };
    const before = upstreamRequests.length;
    const bareUrl = await startServer(guardedAccount);
    const response = await post('/chat/completions', { model: 'claude-opus-5', messages: [{ role: 'user', content: 'hi' }] }, bareUrl);
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: { message: string } }).error.message).toContain('oauthAccount.accountUuid');
    expect(catalogCalls).toEqual([]);
    expect(upstreamRequests.length).toBe(before);
  });
});

describe('branching', () => {
  it('keeps two branches of the same prefix continuable after a restart', async () => {
    // Two identical initial requests must not overwrite each other's state: each continuation
    // finds its own signed turn, even after the process restarts.
    const turn: Json = {
      model: 'claude-opus-5',
      messages: [{ role: 'user', content: 'branch me twice' }],
      tools: [{ type: 'function', function: { name: 'get_weather', parameters: { type: 'object', properties: { city: { type: 'string' } } } } }],
    };
    nextFixture = 'claude-tool-call.sse';
    const first = (await (await post('/chat/completions', turn)).json()) as Json;
    const callOne = ((first.choices as Json[])[0]?.message as Json).tool_calls as Json[];
    nextFixture = 'claude-tool-call-branch.sse';
    const second = (await (await post('/chat/completions', turn)).json()) as Json;
    const callTwo = ((second.choices as Json[])[0]?.message as Json).tool_calls as Json[];
    expect(callOne[0]?.id).not.toBe(callTwo[0]?.id);

    nextFixture = 'claude-text.sse';
    const restartedBaseUrl = await startServer(makeAccount(home));
    for (const [call, toolId] of [[callOne, TOOL_CALL_ID], [callTwo, 'toolu_BRANCH2']] as const) {
      const continuation = await post(
        '/chat/completions',
        {
          model: turn.model,
          messages: [...(turn.messages as Json[]), { role: 'assistant', content: null, tool_calls: call }, { role: 'tool', tool_call_id: toolId, content: 'sunny' }],
          tools: turn.tools as Json[],
        },
        restartedBaseUrl,
      );
      expect(continuation.status).toBe(200);
      const replayed = (lastUpstreamRequest().messages as Json[])[1] as Json;
      expect((replayed.content as Json[]).some((block) => block.type === 'tool_use' && block.id === toolId)).toBe(true);
    }
  });

  it('rejects a continuation whose echoed visible text was edited', async () => {
    nextFixture = 'claude-text.sse';
    const response = await post('/chat/completions', {
      model: 'claude-opus-5',
      messages: [
        { role: 'user', content: 'branch me twice' },
        { role: 'assistant', content: 'edited visible text', tool_calls: [{ id: TOOL_CALL_ID, type: 'function', function: { name: 'get_weather', arguments: '{"city":"Paris"}' } }] },
        { role: 'tool', tool_call_id: TOOL_CALL_ID, content: 'sunny' },
      ],
      tools: [{ type: 'function', function: { name: 'get_weather', parameters: { type: 'object', properties: { city: { type: 'string' } } } } }],
    });
    expect(response.status).toBe(400);
  });
});

describe('relogin coherence', () => {
  it('switches token, metadata and state identity together when the home relogins without a restart', async () => {
    const reloginHome = await mkdtemp(path.join(os.tmpdir(), 'agent-gateway-claude-relogin-'));
    const login = async (token: string, uuid: string): Promise<void> => {
      await writeFile(path.join(reloginHome, '.credentials.json'), JSON.stringify({
        claudeAiOauth: { accessToken: token, refreshToken: 'rt-1', expiresAt: Date.now() + 3_600_000, scopes: ['user:inference'] },
      }));
      await writeFile(path.join(reloginHome, '.claude.json'), JSON.stringify({ oauthAccount: { accountUuid: uuid } }));
    };
    await login('at-A', 'uuid-A');
    const reloginAuth = createClaudeAuthManager({
      credentialsPath: path.join(reloginHome, '.credentials.json'),
      tokenUrl: 'http://127.0.0.1:1/oauth/token',
      fetchFn: async () => {
        throw new Error('this test must never refresh');
      },
    });
    const reloginUrl = await startServer({
      provider: 'claude',
      alias: 'claude1',
      homePath: reloginHome,
      settingsPath: path.join(reloginHome, 'settings.json'),
      client: createClaudeClient({ auth: reloginAuth, baseUrl: 'http://127.0.0.1:1', credentialsPath: path.join(reloginHome, '.credentials.json'), fetchFn }),
      catalog: createClaudeModelCatalog({ getModels: async () => [{ id: 'claude-opus-5' }] }),
      state: createClaudeStateStore({ stateDir: path.join(reloginHome, '.agent-gateway', 'claude-state') }),
    });

    nextFixture = 'claude-tool-call.sse';
    const first = (await (await post('/chat/completions', USER_TURN, reloginUrl)).json()) as Json;
    expect(upstreamHeaders.at(-1)?.authorization).toBe('Bearer at-A');
    expect(JSON.parse(String((lastUpstreamRequest().metadata as Json).user_id)).account_uuid).toBe('uuid-A');

    await login('at-B', 'uuid-B');
    nextFixture = 'claude-text.sse';
    await post('/chat/completions', { ...USER_TURN, messages: [{ role: 'user', content: 'fresh prompt' }] }, reloginUrl);
    expect(upstreamHeaders.at(-1)?.authorization).toBe('Bearer at-B');
    expect(JSON.parse(String((lastUpstreamRequest().metadata as Json).user_id)).account_uuid).toBe('uuid-B');

    // The previous account's signed turn cannot replay under the new identity.
    const toolCall = ((first.choices as Json[])[0]?.message as Json).tool_calls as Json[];
    const stale = await post(
      '/chat/completions',
      {
        ...USER_TURN,
        messages: [...(USER_TURN.messages as Json[]), { role: 'assistant', content: null, tool_calls: toolCall }, { role: 'tool', tool_call_id: TOOL_CALL_ID, content: 'sunny' }],
      },
      reloginUrl,
    );
    expect(stale.status).toBe(400);
  });
});

describe('stream failure delivery', () => {
  it('ends a failed Responses stream with a failure event, not a silent EOF', async () => {
    nextFixture = 'claude-broken-tail.sse';
    const response = await post('/responses', { ...RESPONSES_TURN, stream: true });
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).toContain('event: response.created');
    expect(text).toContain('event: response.failed');
    expect(text).not.toContain('event: response.completed');
  });

  it('ends a failed Chat stream with an error payload and no [DONE]', async () => {
    nextFixture = 'claude-broken-tail.sse';
    const response = await post('/chat/completions', { ...USER_TURN, stream: true });
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).toContain('"error"');
    expect(text).not.toContain('data: [DONE]');
  });

  it('fails explicitly when the upstream answers a streaming call with a plain JSON success body', async () => {
    // Accept is application/json upstream now, but the body still asks for stream:true, so a
    // non-SSE success body is an upstream protocol violation, never a silent success.
    nextJsonBody = { id: 'msg_json', type: 'message', role: 'assistant', content: [{ type: 'text', text: 'not a stream' }], stop_reason: 'end_turn' };
    try {
      const response = await post('/responses', { ...RESPONSES_TURN, stream: true });
      expect(response.status).toBe(200);
      const text = await response.text();
      expect(text).toContain('event: response.failed');
      expect(text).not.toContain('event: response.completed');
    } finally {
      nextJsonBody = undefined;
    }
  });
});

describe('endpoint input validation', () => {
  it('rejects malformed Responses and Chat input with 400 before any upstream call', async () => {
    const before = upstreamRequests.length;
    expect((await post('/responses', { model: 'claude-opus-5', input: [null] })).status).toBe(400);
    expect((await post('/responses', { model: 'claude-opus-5', input: 'Hi', tools: [null] })).status).toBe(400);
    expect((await post('/chat/completions', { model: 'claude-opus-5', messages: [{ role: 'user', content: 'Hi' }], tools: [null] })).status).toBe(400);
    expect((await post('/chat/completions', { model: 'claude-opus-5', messages: [{ role: 'user', content: 'Hi' }, { role: 'assistant', content: null, tool_calls: [null] }] })).status).toBe(400);
    expect((await post('/chat/completions', { model: 'claude-opus-5', messages: [{ role: 'user', content: 'Hi' }], max_completion_tokens: 'one' })).status).toBe(400);
    expect((await post('/chat/completions', { model: 'claude-opus-5', messages: [{ role: 'user', content: 'Hi' }], response_format: { type: 'bogus' } })).status).toBe(400);
    expect(upstreamRequests.length).toBe(before);
  });
});

describe('routing', () => {
  it('accepts the bare model id and the account prefix alike', async () => {
    nextFixture = 'claude-text.sse';
    for (const model of ['claude-opus-5', 'claude1/claude-opus-5']) {
      const response = await post('/chat/completions', { model, messages: [{ role: 'user', content: 'hi' }] });
      expect(response.status).toBe(200);
      expect(lastUpstreamRequest().model).toBe('claude-opus-5');
    }
  });

  it('rejects a model the Claude account does not have', async () => {
    const response = await post('/chat/completions', { model: 'claude1/gpt-5.6-terra', messages: [{ role: 'user', content: 'hi' }] });
    expect(response.status).toBe(400);
  });
});
