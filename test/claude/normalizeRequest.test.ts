// OpenAI Responses-shaped request -> Claude Messages request. None of the Codex Responses Lite
// wrappers may reach here; the Claude anchors are listed in docs/CLAUDE_UPSTREAM_PROTOCOL_DIFF.md.
// System block shape mirrors the native K_o tail branch at 218995076 via $Nr at 226727459, the
// interactive prefix el at 218994031 and billing wSo at 218606801 (native release 2.1.299).
// Caller placement follows references/CLIProxyAPI v8.0.29 claude_executor_cloaking.go.
import { afterAll, describe, expect, it } from 'vitest';
import {
  CLAUDE_CLI_SYSTEM_PREFIX,
  CLAUDE_CODE_BETA,
  CLAUDE_EFFORT_BETA,
  CLAUDE_INTERLEAVED_THINKING_BETA,
  CLAUDE_OAUTH_BETA,
  CLAUDE_STRUCTURED_OUTPUTS_BETA,
} from '../../src/constants.js';
import { findClaudeModelMetadata } from '../../src/claude/modelMetadata.js';
import { getClaudeBoundaryStateKey, assertClaudeChatInput, prepareClaudeRequest } from '../../src/claude/normalizeRequest.js';
import { getClaudeAssistantBoundaries } from '../../src/claude/state.js';
import type { ClaudeAssistantBoundary } from '../../src/claude/state.js';
import type { ClaudeSettings, ClaudeTurnState } from '../../src/claude/types.js';
import type { Json } from '../../src/types.js';

// File-level isolation: attribution reads these env vars, so every test runs with them cleared.
const CLAUDE_ENV_KEYS = ['CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_ACTION', 'CLAUDE_CODE_ATTRIBUTION_HEADER'] as const;
const savedEnv = Object.fromEntries(CLAUDE_ENV_KEYS.map((key) => [key, process.env[key]]));
for (const key of CLAUDE_ENV_KEYS) delete process.env[key];
afterAll(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

const EPHEMERAL = { cache_control: { type: 'ephemeral' } };
// references/CLIProxyAPI v8.0.29 baseline, with native 2.1.299 capability gates.
const SUBSCRIPTION_BETAS = [
  CLAUDE_CODE_BETA, CLAUDE_INTERLEAVED_THINKING_BETA, 'redact-thinking-2026-02-12',
  'thinking-token-count-2026-05-13', 'context-management-2025-06-27', 'prompt-caching-scope-2026-01-05',
];
// Basic billing block for the default test entry ("hi" -> chars "000" -> literal fingerprint fa6).
const BILLING_HI = { type: 'text', text: 'x-anthropic-billing-header: cc_version=2.1.299.fa6; cc_entrypoint=cli; cch=00000;' };

const prepare = (
  body: Json,
  options: { modelId?: string; settings?: ClaudeSettings; liveModel?: Json; state?: ClaudeTurnState; boundaryStates?: Map<string, ClaudeTurnState> } = {},
) =>
  prepareClaudeRequest({
    body,
    modelId: options.modelId ?? 'claude-opus-5',
    alias: 'claude1',
    metadata: findClaudeModelMetadata(options.modelId ?? 'claude-opus-5'),
    settings: options.settings ?? {},
    ...(options.liveModel ? { liveModel: options.liveModel } : {}),
    ...(options.state ? { state: options.state } : {}),
    ...(options.boundaryStates ? { boundaryStates: options.boundaryStates } : {}),
  });

const userText = (text: string): Json => ({
  input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text }] }],
});

const getError = (run: () => unknown): Error & { status: number } => {
  try {
    run();
  } catch (error) {
    return error as Error & { status: number };
  }
  throw new Error('expected prepareClaudeRequest to throw');
};

const turnState = (overrides: Partial<ClaudeTurnState> = {}): ClaudeTurnState => ({
  version: 1,
  alias: 'claude1',
  model: 'claude-opus-5',
  accountIdentity: 'acct-identity',
  identity: 'turn-identity',
  thinking: { type: 'adaptive', effort: 'high' },
  savedAtMs: 1700000000000,
  assistantContent: [{ type: 'thinking', thinking: 'hidden', signature: 'sig' }, { type: 'tool_use', id: 'call_1', name: 'get_weather', input: { city: 'Paris' } }],
  callIds: ['call_1'],
  ...overrides,
});

describe('request shape', () => {
  it('always streams, like the official inference call', () => {
    // The main inference call sets stream:true in the body (binary offset 226675303).
    expect(prepare(userText('hi')).request.stream).toBe(true);
    expect(prepare(userText('hi')).request.model).toBe('claude-opus-5');
  });

  it('expands the shorthand string input', () => {
    expect(prepare({ input: 'hi' }).request.messages).toEqual([{ role: 'user', content: [{ type: 'text', text: 'hi', ...EPHEMERAL }] }]);
  });
});

describe('system prompt', () => {
  it('sends billing, then the cached interactive CLI prefix (K_o tail branch)', () => {
    const { request } = prepare(userText('hi'));
    // K_o at 218995076 via $Nr at 226727459: the billing block carries no cache marker, the
    // interactive prefix el at 218994031 is cached, and there is no caller text here.
    expect(request.system).toEqual([BILLING_HI, { type: 'text', text: CLAUDE_CLI_SYSTEM_PREFIX, ...EPHEMERAL }]);
  });

  it('joins instructions and developer messages into a cached system turn after the first user', () => {
    const { request } = prepare({
      instructions: 'be terse',
      input: [
        { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'policy' }] },
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] },
      ],
    });
    expect((request.system as Json[]).map((block) => block.text)).toEqual([
      'x-anthropic-billing-header: cc_version=2.1.299.fa6; cc_entrypoint=cli; cch=00000;',
      CLAUDE_CLI_SYSTEM_PREFIX,
    ]);
    expect(request.messages[1]).toEqual({
      role: 'system', content: [{ type: 'text', text: 'be terse\n\npolicy', ...EPHEMERAL }],
    });
  });

  it('drops only the billing block when attribution is opted out', () => {
    process.env.CLAUDE_CODE_ATTRIBUTION_HEADER = '0';
    try {
      const { request } = prepare(userText('hi'));
      expect(request.system).toEqual([{ type: 'text', text: CLAUDE_CLI_SYSTEM_PREFIX, ...EPHEMERAL }]);
    } finally {
      delete process.env.CLAUDE_CODE_ATTRIBUTION_HEADER;
    }
  });
});

describe('messages', () => {
  it('maps user text into one user message', () => {
    const { request } = prepare(userText('hello'));
    expect(request.messages).toEqual([{ role: 'user', content: [{ type: 'text', text: 'hello', ...EPHEMERAL }] }]);
  });

  it('merges consecutive items of the same role and keeps alternation', () => {
    const { request } = prepare({
      input: [
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'one' }] },
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'two' }] },
        { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'reply' }] },
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'three' }] },
      ],
    });
    expect(request.messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'one' }, { type: 'text', text: 'two' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'reply' }] },
      { role: 'user', content: [{ type: 'text', text: 'three', ...EPHEMERAL }] },
    ]);
  });

  it('maps base64 and https images, and rejects what Claude cannot take', () => {
    const { request } = prepare({
      input: [{ type: 'message', role: 'user', content: [{ type: 'input_image', image_url: 'data:image/png;base64,AAA' }] }],
    });
    expect(request.messages).toEqual([
      { role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAA' }, ...EPHEMERAL }] },
    ]);

    const byUrl = prepare({
      input: [{ type: 'message', role: 'user', content: [{ type: 'input_image', image_url: 'https://x.test/a.png' }] }],
    });
    expect(byUrl.request.messages).toEqual([
      { role: 'user', content: [{ type: 'image', source: { type: 'url', url: 'https://x.test/a.png' }, ...EPHEMERAL }] },
    ]);

    expect(getError(() => prepare({
      input: [{ type: 'message', role: 'user', content: [{ type: 'input_image', image_url: 'data:image/tiff;base64,AAA' }] }],
    })).message).toContain('Unsupported image media type');
    expect(getError(() => prepare({
      input: [{ type: 'message', role: 'user', content: [{ type: 'input_image', image_url: 'http://x.test/a.png' }] }],
    })).message).toContain('https://');
    expect(getError(() => prepare({
      input: [{ type: 'message', role: 'assistant', content: [{ type: 'input_image', image_url: 'https://x.test/a.png' }] }],
    })).message).toContain('Assistant messages cannot contain');
  });

  it('maps tool calls and tool results, and ignores client reasoning items', () => {
    const { request } = prepare(
      {
        input: [
          { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'weather?' }] },
          { type: 'reasoning', id: 'rs_1', summary: [], encrypted_content: 'opaque' },
          { type: 'function_call', call_id: 'call_1', name: 'get_weather', arguments: '{"city":"Paris"}' },
          { type: 'function_call_output', call_id: 'call_1', output: 'sunny' },
        ],
      },
      { modelId: 'claude-3-5-haiku' },
    );
    expect(request.messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'weather?' }] },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'call_1', name: 'get_weather', input: { city: 'Paris' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_1', content: [{ type: 'text', text: 'sunny' }], ...EPHEMERAL }] },
    ]);
  });

  it('maps object and array tool outputs without reformatting them', () => {
    const { request } = prepare({
      input: [
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'weather?' }] },
        { type: 'function_call', call_id: 'call_1', name: 'get_weather', arguments: '{}' },
        { type: 'function_call_output', call_id: 'call_1', output: { city: 'Paris' } },
      ],
    }, { modelId: 'claude-3-5-haiku' });
    const result = ((request.messages as Json[])[2]?.content as Json[])?.[0];
    expect(result?.content).toEqual([{ type: 'text', text: '{"city":"Paris"}' }]);

    const parts = prepare({
      input: [
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'weather?' }] },
        { type: 'function_call', call_id: 'call_1', name: 'get_weather', arguments: '{}' },
        { type: 'function_call_output', call_id: 'call_1', output: [{ type: 'input_text', text: 'sunny' }] },
      ],
    }, { modelId: 'claude-3-5-haiku' });
    const partsResult = ((parts.request.messages as Json[])[2]?.content as Json[])?.[0];
    expect(partsResult?.content).toEqual([{ type: 'text', text: 'sunny' }]);
  });

  it('rejects an empty conversation and a conversation that does not start with the user', () => {
    expect(getError(() => prepare({ input: [] })).message).toContain('at least one message');
    expect(getError(() => prepare({
      input: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'hi' }] }],
    })).message).toContain('first message to come from the user');
  });

  it('rejects input items it cannot represent', () => {
    const error = getError(() => prepare({ input: [{ type: 'web_search_call', id: 'ws_1' }] }));
    expect(error.status).toBe(400);
    expect(error.message).toBe('Unsupported input item type: web_search_call');
  });
});

describe('replay of stored thinking', () => {
  const roundTrip: Json = {
    input: [
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'weather?' }] },
      { type: 'function_call', call_id: 'call_1', name: 'get_weather', arguments: '{"city":"Paris"}' },
      { type: 'function_call_output', call_id: 'call_1', output: 'sunny' },
    ],
  };

  it('replays the native assistant content verbatim', () => {
    const { request, thinking } = prepare(roundTrip, { state: turnState() });
    expect(thinking).toEqual({ type: 'adaptive', effort: 'high' });
    expect(request.messages[1]).toEqual({
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'hidden', signature: 'sig' },
        { type: 'tool_use', id: 'call_1', name: 'get_weather', input: { city: 'Paris' } },
      ],
    });
    expect(request.thinking).toEqual({ type: 'adaptive' });
  });

  it('replays one stored turn exactly once, with text and three tool calls', () => {
    // Supervisor request probe: the visible echo must not add the same text or calls again.
    const rawContent: Json[] = [
      { type: 'thinking', thinking: 'test-thought', signature: 'test-signature' },
      { type: 'text', text: 'Checking.' },
      ...['a', 'b', 'c'].map((id) => ({ type: 'tool_use', id, name: 'lookup', input: {} })),
    ];
    const { request } = prepare({
      input: [
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Look up x.' }] },
        { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Checking.' }] },
        ...['a', 'b', 'c'].map((id) => ({ type: 'function_call', call_id: id, name: 'lookup', arguments: '{}' })),
        ...['a', 'b', 'c'].map((id) => ({ type: 'function_call_output', call_id: id, output: 'found' })),
      ],
    }, {
      modelId: 'claude-opus-4-6',
      state: turnState({ model: 'claude-opus-4-6', assistantContent: rawContent, callIds: ['a', 'b', 'c'] }),
    });
    const assistant = (request.messages as Json[]).find((message) => message.role === 'assistant') as Json;
    expect(assistant.content).toEqual(rawContent);
    expect((assistant.content as Json[]).filter((block) => block.type === 'tool_use').map((block) => block.id)).toEqual(['a', 'b', 'c']);
    expect((assistant.content as Json[]).filter((block) => block.type === 'text')).toHaveLength(1);
  });

  it('restores each historical boundary from its own record, in order', () => {
    const items: Json[] = [
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'first' }] },
      { type: 'function_call', call_id: 'call_1', name: 'lookup', arguments: '{}' },
      { type: 'function_call_output', call_id: 'call_1', output: 'one' },
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'between' }] },
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'second' }] },
      { type: 'function_call', call_id: 'call_2', name: 'lookup', arguments: '{}' },
      { type: 'function_call_output', call_id: 'call_2', output: 'two' },
    ];
    const first = turnState({ assistantContent: [{ type: 'thinking', thinking: 'one', signature: 's1' }, { type: 'tool_use', id: 'call_1', name: 'lookup', input: {} }], callIds: ['call_1'] });
    const second = turnState({ assistantContent: [{ type: 'thinking', thinking: 'two', signature: 's2' }, { type: 'tool_use', id: 'call_2', name: 'lookup', input: {} }], callIds: ['call_2'] });
    const boundaryStates = new Map<string, ClaudeTurnState>();
    const boundaries = getClaudeAssistantBoundaries(items);
    boundaryStates.set(getClaudeBoundaryStateKey(boundaries[0] as ClaudeAssistantBoundary), first);
    boundaryStates.set(getClaudeBoundaryStateKey(boundaries[2] as ClaudeAssistantBoundary), second);

    const { request } = prepare({ input: items }, { boundaryStates });
    expect((request.messages as Json[]).map((message) => (message.content as Json[]).map((block) => block.type))).toEqual([
      ['text'],
      ['thinking', 'tool_use'],
      ['tool_result'],
      ['text'],
      ['text'],
      ['thinking', 'tool_use'],
      ['tool_result'],
    ]);
    expect(JSON.stringify(request.messages)).toContain('"thinking":"one"');
    expect(JSON.stringify(request.messages)).toContain('"thinking":"two"');
  });

  it('allows a new user turn after a completed tool cycle without any stored state', () => {
    // R3: a finished cycle must not require replay state, so home settings may change again.
    const { request } = prepare({
      input: [
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'weather?' }] },
        { type: 'function_call', call_id: 'call_1', name: 'get_weather', arguments: '{"city":"Paris"}' },
        { type: 'function_call_output', call_id: 'call_1', output: 'sunny' },
        { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'It is sunny.' }] },
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'and tomorrow?' }] },
      ],
    });
    expect((request.messages as Json[]).map((message) => message.role)).toEqual(['user', 'assistant', 'user', 'assistant', 'user']);
  });

  it('rejects a client that changed the visible tool call', () => {
    const changed: Json = {
      input: [
        ...((roundTrip.input as Json[]).slice(0, 1) as Json[]),
        { type: 'function_call', call_id: 'call_1', name: 'get_weather', arguments: '{"city":"Lyon"}' },
        { type: 'function_call_output', call_id: 'call_1', output: 'sunny' },
      ],
    };
    const error = getError(() => prepare(changed, { state: turnState() }));
    expect(error.status).toBe(400);
    expect(error.message).toContain('changed since it was generated');
  });

  it('rejects a tool round trip whose thinking state is gone', () => {
    const error = getError(() => prepare(roundTrip));
    expect(error.status).toBe(400);
    expect(error.message).toContain('No stored Claude thinking state');
  });

  it('still requires the state when the home disabled thinking since it was generated', () => {
    // R3: the signed blocks were created with thinking on; rebuilding them unsigned is not allowed.
    const error = getError(() => prepare(roundTrip, { settings: { alwaysThinkingEnabled: false } }));
    expect(error.status).toBe(400);
    expect(error.message).toContain('No stored Claude thinking state');
  });

  it('rebuilds unsigned content for a model that never has thinking', () => {
    const { request } = prepare(roundTrip, { modelId: 'claude-3-5-haiku' });
    expect(request.messages[1]).toEqual({
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'call_1', name: 'get_weather', input: { city: 'Paris' } }],
    });
    expect(request.thinking).toBeUndefined();
  });

  it('pins the thinking configuration the turn was generated with', () => {
    const state = turnState({
      thinking: { type: 'enabled', budgetTokens: 4096 },
      assistantContent: [{ type: 'thinking', thinking: 'hidden', signature: 'sig', budget_tokens: 4096 }, { type: 'tool_use', id: 'call_1', name: 'get_weather', input: { city: 'Paris' } }],
    });
    const { request, thinking } = prepare(roundTrip, { modelId: 'claude-sonnet-4-5', state });
    expect(request.thinking).toEqual({ type: 'enabled', budget_tokens: 4096 });
    expect(thinking.budgetTokens).toBe(4096);

    const lowered = getError(() => prepare({ ...roundTrip, max_output_tokens: 2048 }, { modelId: 'claude-sonnet-4-5', state }));
    expect(lowered.message).toContain('Cannot lower `max_output_tokens` mid-turn');
  });

  it('rejects an effort that changed mid-turn', () => {
    const error = getError(() => prepare({ ...roundTrip, reasoning: { effort: 'low' } }, { state: turnState() }));
    expect(error.status).toBe(400);
    expect(error.message).toContain('Cannot change reasoning effort mid-turn');
  });
});

describe('tools', () => {
  it('maps function tools to the Claude input_schema shape', () => {
    const { request } = prepare({
      ...userText('hi'),
      tools: [{ type: 'function', name: 'get_weather', description: 'd', parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] } }],
    });
    expect(request.tools).toEqual([
      { name: 'get_weather', description: 'd', input_schema: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] } },
    ]);
  });

  it('keeps the whole JSON Schema, including $defs and additionalProperties', () => {
    // Supervisor request probe: dropping `$defs` would leave a dangling `$ref` upstream.
    const schema = { type: 'object', additionalProperties: false, $defs: { key: { type: 'string' } }, properties: { key: { $ref: '#/$defs/key' } }, required: ['key'] };
    const { request } = prepare({ ...userText('hi'), tools: [{ type: 'function', name: 'lookup', parameters: schema }] });
    expect((request.tools as Json[])[0]?.input_schema).toEqual(schema);
  });

  it('gives tools without parameters an empty object schema', () => {
    const { request } = prepare({ ...userText('hi'), tools: [{ type: 'function', name: 'now' }] });
    expect((request.tools as Json[])[0]?.input_schema).toEqual({ type: 'object', properties: {} });
  });

  it('rejects built-in and custom tool types instead of dropping them', () => {
    const error = getError(() => prepare({ ...userText('hi'), tools: [{ type: 'web_search' }] }));
    expect(error.status).toBe(400);
    expect(error.message).toContain('Only `function` tools are supported');
  });

  it('maps tool_choice and parallel_tool_calls', () => {
    const withTools: Json = { ...userText('hi'), tools: [{ type: 'function', name: 'now' }] };
    const noThinking = { modelId: 'claude-3-5-haiku' };
    expect(prepare(withTools, noThinking).request.tool_choice).toBeUndefined();
    expect(prepare({ ...withTools, tool_choice: 'required' }, noThinking).request.tool_choice).toEqual({ type: 'any' });
    expect(prepare({ ...withTools, tool_choice: { type: 'function', function: { name: 'now' } } }, noThinking).request.tool_choice).toEqual({
      type: 'tool',
      name: 'now',
    });
    expect(prepare({ ...withTools, parallel_tool_calls: false }, noThinking).request.tool_choice).toEqual({
      type: 'auto',
      disable_parallel_tool_use: true,
    });
    expect(prepare({ ...withTools, tool_choice: 'none' }, noThinking).request.tools).toBeUndefined();
    expect(getError(() => prepare({ ...withTools, tool_choice: 'sometimes' }, noThinking)).message).toContain('Unsupported `tool_choice`');
  });

  it('keeps a forced tool choice instead of demoting it, and rejects it while thinking is on', () => {
    // The official client demotes to auto (binary offset 226635226); the gateway reports instead.
    const forced = prepare({ ...userText('hi'), tools: [{ type: 'function', name: 'now' }], tool_choice: 'required' }, { modelId: 'claude-3-5-haiku' });
    expect(forced.request.tool_choice).toEqual({ type: 'any' });
    const error = getError(() => prepare({ ...userText('hi'), tools: [{ type: 'function', name: 'now' }], tool_choice: { type: 'function', function: { name: 'now' } } }));
    expect(error.status).toBe(400);
    expect(error.message).toContain('cannot be combined with thinking');

    const off = prepare({ ...userText('hi'), tools: [{ type: 'function', name: 'now' }], tool_choice: 'required', reasoning: { effort: 'none' } });
    expect(off.request.tool_choice).toEqual({ type: 'any' });
    expect(off.request.thinking).toEqual({ type: 'disabled' });
  });
});

describe('thinking, effort and betas', () => {
  it('sends adaptive thinking plus effort for adaptive models', () => {
    const { request, betas } = prepare(userText('hi'), { modelId: 'claude-opus-5' });
    expect(request.thinking).toEqual({ type: 'adaptive' });
    expect(request.output_config).toEqual({ effort: 'high' });
    // SL at 217935458 (claude-code beta for non-haiku) + tGe at 226583782 (effort beta).
    expect(betas).toEqual([...SUBSCRIPTION_BETAS, CLAUDE_EFFORT_BETA]);
  });

  it('sends the budget form for legacy thinking models', () => {
    const { request } = prepare(userText('hi'), { modelId: 'claude-sonnet-4-5-20250929' });
    expect(request.thinking).toEqual({ type: 'enabled', budget_tokens: 31999 });
    expect(request.output_config).toBeUndefined();
  });

  it('sends the interleaved thinking beta by model capability, not by request shape', () => {
    // Bzn at 217932522: the beta follows the model, so it is stable across turns of one model.
    expect(prepare(userText('hi'), { modelId: 'claude-opus-5' }).betas).toEqual([...SUBSCRIPTION_BETAS, CLAUDE_EFFORT_BETA]);
    expect(prepare(userText('hi'), { modelId: 'claude-3-5-haiku' }).betas).toEqual(['prompt-caching-scope-2026-01-05']);
    expect(prepare(userText('hi'), { modelId: 'claude-opus-5', settings: { alwaysThinkingEnabled: false } }).betas).toEqual([...SUBSCRIPTION_BETAS, CLAUDE_EFFORT_BETA]);
  });

  it('honours an explicit reasoning effort', () => {
    const { request } = prepare({ ...userText('hi'), reasoning: { effort: 'xhigh' } });
    expect(request.output_config).toEqual({ effort: 'xhigh' });
  });

  it('sends an explicit disabled thinking block and keeps the capped effort', () => {
    // Binary offset 226633000; Zdt at 218703811 caps claude-opus-5 effort at high.
    const { request } = prepare(userText('hi'), { modelId: 'claude-opus-5', settings: { alwaysThinkingEnabled: false } });
    expect(request.thinking).toEqual({ type: 'disabled' });
    expect(request.output_config).toEqual({ effort: 'high' });
  });

  it('omits thinking entirely for a model that has none', () => {
    const { request } = prepare(userText('hi'), { modelId: 'claude-3-5-haiku', settings: { alwaysThinkingEnabled: false } });
    expect(request.thinking).toBeUndefined();
    expect(request.output_config).toBeUndefined();
  });
});

describe('structured output', () => {
  it('maps json_schema to output_config.format and adds the beta', () => {
    // rNr at 226584133 sets output_config.format; the beta is _ie at 216789360.
    const { request, betas } = prepare({
      ...userText('hi'),
      text: { format: { type: 'json_schema', json_schema: { name: 'answer', schema: { type: 'object', properties: { a: { type: 'string' } } } } } },
    });
    expect(request.output_config).toEqual({ effort: 'high', format: { type: 'json_schema', schema: { type: 'object', properties: { a: { type: 'string' } } } } });
    expect(betas).toEqual([...SUBSCRIPTION_BETAS, CLAUDE_EFFORT_BETA, CLAUDE_STRUCTURED_OUTPUTS_BETA]);
  });

  it('rejects json_object and a schema-less json_schema', () => {
    expect(getError(() => prepare({ ...userText('hi'), response_format: { type: 'json_object' } })).message).toContain('Only `json_schema`');
    expect(getError(() => prepare({ ...userText('hi'), text: { format: { type: 'json_schema' } } })).message).toContain('needs a `schema`');
  });

  it('rejects structured output on a model the release excludes', () => {
    const error = getError(() => prepare({ ...userText('hi'), text: { format: { type: 'json_schema', schema: { type: 'object' } } } }, { modelId: 'claude-opus-4-1' }));
    expect(error.status).toBe(400);
    expect(error.message).toContain('does not support structured output');
  });
});

describe('max_tokens and unknown models', () => {
  it('uses the pinned default, the live catalog value, then the client value', () => {
    expect(prepare(userText('hi')).request.max_tokens).toBe(64000);
    expect(prepare(userText('hi'), { liveModel: { id: 'claude-opus-5', max_tokens: 4096 } }).request.max_tokens).toBe(4096);
    expect(prepare({ ...userText('hi'), max_output_tokens: 1234 }).request.max_tokens).toBe(1234);
  });

  it('rejects a non-integer or over-ceiling max_output_tokens', () => {
    expect(getError(() => prepare({ ...userText('hi'), max_output_tokens: 0 })).message).toContain('positive integer');
    expect(getError(() => prepare({ ...userText('hi'), max_output_tokens: 1.5 })).message).toContain('positive integer');
    const error = getError(() => prepare({ ...userText('hi'), max_output_tokens: 130000 }));
    expect(error.status).toBe(400);
    expect(error.message).toContain('exceeds the claude-opus-5 limit of 128000');
  });

  it('asks the caller for max_output_tokens when the model is unknown', () => {
    const error = getError(() => prepare(userText('hi'), { modelId: 'claude-brand-new' }));
    expect(error.status).toBe(400);
    expect(error.message).toContain('Unknown Claude model "claude-brand-new"');
    expect(prepare({ ...userText('hi'), max_output_tokens: 999 }, { modelId: 'claude-brand-new' }).request.max_tokens).toBe(999);
  });
});

describe('unsupported OpenAI features', () => {
  it('never sends previous_response_id upstream: the gateway expands it before this point', () => {
    const { request } = prepare({ ...userText('hi'), previous_response_id: 'resp_1' });
    expect(request).not.toHaveProperty('previous_response_id');
    expect(JSON.stringify(request)).not.toContain('resp_1');
  });

  it('never leaks Codex Responses wrappers into the Claude request', () => {
    const { request } = prepare({ ...userText('hi'), store: true, include: ['reasoning.encrypted_content'], prompt_cache_key: 'k', service_tier: 'priority' });
    expect(Object.keys(request).sort()).toEqual(['max_tokens', 'messages', 'model', 'output_config', 'stream', 'system', 'thinking']);
    expect(request.model).toBe('claude-opus-5');
  });

  it('keeps the OAuth beta on the client side rather than in the body', () => {
    expect(CLAUDE_OAUTH_BETA).toBe('oauth-2025-04-20');
    expect(JSON.stringify(prepare(userText('hi')).request)).not.toContain('oauth');
  });
});

describe('assertClaudeChatInput', () => {
  it('accepts the shapes the chat conversion can carry losslessly', () => {
    expect(() => assertClaudeChatInput({
      messages: [
        { role: 'system', content: 'policy' },
        { role: 'user', content: [{ type: 'text', text: 'hi' }, { type: 'image_url', image_url: { url: 'https://x.test/a.png' } }] },
        { role: 'assistant', content: [{ type: 'text', text: 'hello' }] },
        { role: 'tool', content: 'result' },
      ],
    })).not.toThrow();
  });

  it('rejects content the conversion would silently drop', () => {
    expect(getError(() => assertClaudeChatInput({ messages: [{ role: 'assistant', content: [{ type: 'image_url', image_url: { url: 'https://x.test/a.png' } }] }] })).message)
      .toContain('cannot carry "image_url" content');
    expect(getError(() => assertClaudeChatInput({ messages: [{ role: 'user', content: [{ type: 'text' }] }] })).message).toContain('needs a string `text`');
    expect(getError(() => assertClaudeChatInput({ messages: [{ role: 'user', content: 5 }] })).message).toContain('must be a string or an array');
    expect(getError(() => assertClaudeChatInput({ messages: ['hi'] })).message).toContain('must be an object');
  });
});

describe('input validation (supervisor input-validation probe)', () => {
  it('rejects null and malformed input items with 400, not a TypeError', () => {
    for (const body of [
      { input: [null] },
      { input: [{ type: 'message', role: 'user', content: [null] }] },
      { input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 42 }] }] },
      { input: [{ type: 'message', role: 'user', content: 42 }] },
      { input: [{ type: 'function_call', call_id: 7 }] },
    ]) {
      const error = getError(() => prepare(body));
      expect(error.status).toBe(400);
    }
  });

  it('rejects null tools entries and non-array tools with 400', () => {
    expect(getError(() => prepare({ ...userText('hi'), tools: [null] })).status).toBe(400);
    expect(getError(() => prepare({ ...userText('hi'), tools: {} })).status).toBe(400);
  });

  it('applies the same semantic checks to system and developer content as Chat', () => {
    // Supervisor input-validation probe: a developer image must not be silently dropped.
    const error = getError(() => prepare({
      input: [
        { type: 'message', role: 'developer', content: [{ type: 'input_image', image_url: 'https://x.test/a.png' }] },
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] },
      ],
    }));
    expect(error.status).toBe(400);
    expect(error.message).toContain('cannot carry "input_image" content');
  });

  it('rejects malformed Chat fields before the shared converter runs (supervisor chat-validation probe)', () => {
    const chatCases: Json[] = [
      { messages: [{ role: 'user', content: 'Hi' }], tools: [null] },
      { messages: [{ role: 'user', content: 'Hi' }, { role: 'assistant', content: null, tool_calls: [null] }] },
      { messages: [{ role: 'user', content: 'Hi' }], max_completion_tokens: 'one' },
      { messages: [{ role: 'user', content: 'Hi' }], max_tokens: 0 },
      { messages: [{ role: 'user', content: 'Hi' }], response_format: { type: 'bogus' } },
    ];
    for (const body of chatCases) {
      expect(getError(() => assertClaudeChatInput(body)).status).toBe(400);
    }
    // Valid Chat shapes stay accepted.
    expect(() => assertClaudeChatInput({
      messages: [{ role: 'assistant', content: null, tool_calls: [{ id: 'a', type: 'function', function: { name: 'x', arguments: '{}' } }] }],
      max_completion_tokens: 64,
      response_format: { type: 'json_schema', json_schema: { name: 'x', schema: {} } },
    })).not.toThrow();
  });

  it('validates assistant function_call arguments as an object independently of identity', () => {
    // Supervisor input-validation probe: `{"x":` must not be re-encoded as a string input.
    const error = getError(() => prepare({
      input: [
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'go' }] },
        { type: 'function_call', call_id: 'a', name: 'tool', arguments: '{"x":' },
        { type: 'function_call_output', call_id: 'a', output: 'done' },
      ],
    }, { modelId: 'claude-3-5-haiku' }));
    expect(error.status).toBe(400);
    expect(error.message).toContain('not valid JSON');
  });

  it('validates tool result arrays', () => {
    const error = getError(() => prepare({
      input: [
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'go' }] },
        { type: 'function_call', call_id: 'a', name: 'tool', arguments: '{}' },
        { type: 'function_call_output', call_id: 'a', output: [null] },
      ],
    }, { modelId: 'claude-3-5-haiku' }));
    expect(error.status).toBe(400);
    expect(error.message).toContain('needs a string `type`');
  });

  it('rejects an impossible manual-thinking budget before any network call', () => {
    // Supervisor input-validation probe: Sonnet 4.5 (budget-form thinking) with tiny output tokens.
    const error = getError(() => prepare({ ...userText('hi'), max_output_tokens: 16 }, { modelId: 'claude-sonnet-4-5' }));
    expect(error.status).toBe(400);
    expect(error.message).toContain('thinking budget floor');
  });

  it('keeps valid adaptive small-token behaviour model-specific', () => {
    // Adaptive models have no budget floor, so a small max_output_tokens stays accepted.
    expect(prepare({ ...userText('hi'), max_output_tokens: 16 }, { modelId: 'claude-opus-4-6' }).request.max_tokens).toBe(16);
  });
});

describe('source-faithful request extras', () => {
  it('sends the official metadata.user_id envelope with real home values', () => {
    // nUe at 218996645: user_id is a JSON string with device_id, account_uuid and session_id.
    const { request } = prepareClaudeRequest({
      body: userText('hi'),
      modelId: 'claude-opus-5',
      alias: 'claude1',
      metadata: findClaudeModelMetadata('claude-opus-5'),
      settings: {},
      session: { sessionId: 'sess_123', accountUuid: 'acct-uuid', deviceId: 'a'.repeat(64) },
    });
    const userId = JSON.parse(String((request.metadata as Json).user_id));
    expect(userId).toEqual({ device_id: 'a'.repeat(64), account_uuid: 'acct-uuid', session_id: 'sess_123' });
  });

  it('omits device_id when the home config has no userID instead of inventing one', () => {
    const { request } = prepareClaudeRequest({
      body: userText('hi'),
      modelId: 'claude-opus-5',
      alias: 'claude1',
      metadata: findClaudeModelMetadata('claude-opus-5'),
      settings: {},
      session: { sessionId: 'sess_123', accountUuid: 'acct-uuid' },
    });
    const userId = JSON.parse(String((request.metadata as Json).user_id));
    expect(userId).toEqual({ account_uuid: 'acct-uuid', session_id: 'sess_123' });
  });

  it('marks the tail system block and the last message block, but never the tools', () => {
    // NNr/ryn default shape; the main builder passes no cacheControl for tools (226609101).
    const { request } = prepare({
      ...userText('hi'),
      tools: [{ type: 'function', name: 'now' }],
    });
    expect((request.system as Json[]).at(-1)).toMatchObject(EPHEMERAL);
    expect(((request.messages as Json[]).at(-1)?.content as Json[]).at(-1)).toMatchObject(EPHEMERAL);
    for (const tool of request.tools as Json[]) expect(tool).not.toHaveProperty('cache_control');
  });

  it('skips an assistant message ending in thinking and marks an earlier eligible message', () => {
    // ryn at 226486727 / oyn at 226486225 judge the LAST block of a candidate MESSAGE (E7e at
    // 226486043): a thinking tail skips the WHOLE assistant message, never just its last block.
    const items: Json[] = [
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'go' }] },
      { type: 'function_call', call_id: 'call_1', name: 'get_weather', arguments: '{"city":"Paris"}' },
    ];
    const boundaryStates = new Map<string, ClaudeTurnState>();
    boundaryStates.set(getClaudeBoundaryStateKey(getClaudeAssistantBoundaries(items)[0] as ClaudeAssistantBoundary), turnState({
      assistantContent: [
        { type: 'tool_use', id: 'call_1', name: 'get_weather', input: { city: 'Paris' } },
        { type: 'thinking', thinking: 'after the call', signature: 'sig2' },
      ],
    }));
    const { request } = prepare({ input: items }, { boundaryStates });
    const messages = request.messages as Json[];
    expect(messages.at(-1)).toMatchObject({ role: 'assistant' });
    expect((messages.at(-1)?.content as Json[]).at(-1)).toEqual({ type: 'thinking', thinking: 'after the call', signature: 'sig2' });
    expect((messages.at(-1)?.content as Json[]).at(-2)).not.toMatchObject(EPHEMERAL);
    expect((messages[0]?.content as Json[]).at(-1)).toMatchObject(EPHEMERAL);
  });

  it('marks a tool_use tail block because E7e keeps it eligible', () => {
    const items: Json[] = [
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'go' }] },
      { type: 'function_call', call_id: 'call_1', name: 'get_weather', arguments: '{"city":"Paris"}' },
    ];
    const boundaryStates = new Map<string, ClaudeTurnState>();
    boundaryStates.set(getClaudeBoundaryStateKey(getClaudeAssistantBoundaries(items)[0] as ClaudeAssistantBoundary), turnState());
    const { request } = prepare({ input: items }, { boundaryStates });
    const messages = request.messages as Json[];
    expect(messages.at(-1)).toMatchObject({ role: 'assistant' });
    expect((messages.at(-1)?.content as Json[]).at(-1)).toMatchObject({ type: 'tool_use', ...EPHEMERAL });
    expect((messages[0]?.content as Json[]).at(-1)).not.toMatchObject(EPHEMERAL);
  });

  it('marks the last non-empty block of a user message (rkn at 226585570 view)', () => {
    const { request } = prepare({
      input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }, { type: 'input_text', text: '' }] }],
    });
    const blocks = ((request.messages as Json[])[0]?.content as Json[]);
    expect(blocks[0]).toMatchObject(EPHEMERAL);
    expect(blocks[1]).not.toMatchObject(EPHEMERAL);
  });

  it('supports effort on claude-opus-4-5 despite the raw table absence (bb fallback)', () => {
    // bb at 218701764: only a fixed name list is excluded; firstParty defaults to true.
    const { request, betas } = prepare(userText('hi'), { modelId: 'claude-opus-4-5' });
    expect(betas).toContain(CLAUDE_EFFORT_BETA);
    expect(request.output_config).toEqual({ effort: 'high' });
  });

  it('drops a home effort the model does not support instead of sending it', () => {
    // Qdt at 218702663 excludes claude-opus-4-6; jBn validates each candidate.
    const { request } = prepare(userText('hi'), { modelId: 'claude-opus-4-6', settings: { modelSettings: { 'claude-opus-4-6': { effortLevel: 'xhigh' } } } });
    expect(request.output_config).toEqual({ effort: 'high' });
    const explicit = getError(() => prepare({ ...userText('hi'), reasoning: { effort: 'xhigh' } }, { modelId: 'claude-opus-4-6' }));
    expect(explicit.status).toBe(400);
  });

  it('never sends the claude-code beta for haiku models', () => {
    // SL at 217935458: `when: (e) => !e.canonical.includes("haiku")`.
    expect(prepare(userText('hi'), { modelId: 'claude-haiku-4-5' }).betas).not.toContain(CLAUDE_CODE_BETA);
    expect(prepare(userText('hi'), { modelId: 'claude-opus-5' }).betas).toContain(CLAUDE_CODE_BETA);
  });
});
