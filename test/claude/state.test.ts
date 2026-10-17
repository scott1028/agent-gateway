// Gateway-owned thinking replay state. The state lives under the selected Claude home in a
// gateway-owned directory; identity matching is what lets a restart continue a tool-use turn.
import { copyFile, mkdir, mkdtemp, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { CLAUDE_STATE_VERSION } from '../../src/constants.js';
import {
  createClaudeStateStore,
  getClaudeAccountIdentity,
  getClaudeAssistantBoundaries,
  getClaudeConversationIdentity,
  getClaudeInputItems,
  getClaudeNativeVisibleIdentity,
  getClaudeStateKey,
  getClaudeVisibleAssistantIdentity,
  normalizeClaudeToolInput,
} from '../../src/claude/state.js';
import type { Json } from '../../src/types.js';

const ACCOUNT = getClaudeAccountIdentity('/home/claude1', 'acct-1');

const makeStore = async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'agent-gateway-claude-state-'));
  const stateDir = path.join(dir, '.agent-gateway/claude-state');
  return { dir, stateDir, store: createClaudeStateStore({ stateDir }) };
};

const USER_TURN: Json[] = [
  { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'weather?' }] },
  { type: 'function_call', call_id: 'call_1', name: 'get_weather', arguments: '{"city":"Paris"}' },
];

const getRejection = async (promise: Promise<unknown>): Promise<Error & { status: number }> => {
  try {
    await promise;
  } catch (error) {
    return error as Error & { status: number };
  }
  throw new Error('expected the call to reject');
};

describe('normalizeClaudeToolInput', () => {
  it('ignores key order and spacing added by clients', () => {
    expect(normalizeClaudeToolInput('{ "city": "Paris" }')).toBe(normalizeClaudeToolInput('{"city":"Paris"}'));
    expect(normalizeClaudeToolInput({ city: 'Paris' })).toBe(normalizeClaudeToolInput('{"city":"Paris"}'));
    expect(normalizeClaudeToolInput('')).toBe('{}');
    expect(normalizeClaudeToolInput('not json')).toBe('"not json"');
  });

  it('sorts keys at every depth, not just the top level', () => {
    expect(normalizeClaudeToolInput('{"b":{"d":1,"c":2},"a":3}')).toBe(normalizeClaudeToolInput({ a: 3, b: { c: 2, d: 1 } }));
    expect(normalizeClaudeToolInput('{"a":[2,{"b":1,"c":0}]}')).toBe(normalizeClaudeToolInput({ a: [2, { c: 0, b: 1 }] }));
  });
});

describe('getClaudeConversationIdentity', () => {
  it('is stable for the same visible conversation', () => {
    expect(getClaudeConversationIdentity(USER_TURN)).toBe(getClaudeConversationIdentity([...USER_TURN]));
  });

  it('ignores Codex-only additional_tools items', () => {
    expect(getClaudeConversationIdentity([...USER_TURN, { type: 'additional_tools', tools: [] }])).toBe(
      getClaudeConversationIdentity(USER_TURN),
    );
  });

  it('ignores reasoning items, which clients may drop from the echo', () => {
    const withReasoning: Json[] = [...USER_TURN, { type: 'reasoning', id: 'rs_1', summary: [] }];
    expect(getClaudeConversationIdentity(withReasoning)).toBe(getClaudeConversationIdentity(USER_TURN));
  });

  it('includes historical tool results, which separate two branches of the same assistant turn', () => {
    const branchA: Json[] = [...USER_TURN, { type: 'function_call_output', call_id: 'call_1', output: 'sunny' }];
    const branchB: Json[] = [...USER_TURN, { type: 'function_call_output', call_id: 'call_1', output: 'rain' }];
    expect(getClaudeConversationIdentity(branchA)).not.toBe(getClaudeConversationIdentity(branchB));
    expect(getClaudeConversationIdentity(branchA)).not.toBe(getClaudeConversationIdentity(USER_TURN));
  });

  it('does not collide when text content is forged into part boundaries', () => {
    const onePart: Json[] = [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'a|t:b' }] }];
    const twoParts: Json[] = [
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'a' }, { type: 'input_text', text: 'b' }] },
    ];
    expect(getClaudeConversationIdentity(onePart)).not.toBe(getClaudeConversationIdentity(twoParts));
  });

  it('does not collide across roles and item types', () => {
    const asText: Json[] = [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'call_1get_weather' }] }];
    const asCall: Json[] = [{ type: 'function_call', call_id: 'call_1', name: 'get_weather', arguments: '{}' }];
    expect(getClaudeConversationIdentity(asText)).not.toBe(getClaudeConversationIdentity(asCall));
  });

  it('changes when the client edits visible content', () => {
    const edited = USER_TURN.map((item) =>
      item.type === 'function_call' ? { ...item, arguments: '{"city":"Lyon"}' } : item,
    );
    expect(getClaudeConversationIdentity(edited)).not.toBe(getClaudeConversationIdentity(USER_TURN));
  });

  it('changes when the system instructions change', () => {
    expect(getClaudeConversationIdentity(USER_TURN, { instructions: 'a' })).not.toBe(
      getClaudeConversationIdentity(USER_TURN, { instructions: 'b' }),
    );
    expect(getClaudeConversationIdentity(USER_TURN, { instructions: 'a' })).not.toBe(getClaudeConversationIdentity(USER_TURN));
  });

  it('hashes image payloads instead of trusting their shape', () => {
    const withImage: Json[] = [{ type: 'message', role: 'user', content: [{ type: 'input_image', image_url: 'https://x.test/a.png' }] }];
    const otherImage: Json[] = [{ type: 'message', role: 'user', content: [{ type: 'input_image', image_url: 'https://x.test/b.png' }] }];
    expect(getClaudeConversationIdentity(withImage)).not.toBe(getClaudeConversationIdentity(otherImage));
  });
});

describe('getClaudeInputItems', () => {
  it('expands the shorthand string input into a user message', () => {
    expect(getClaudeInputItems({ input: 'hi' })).toEqual([
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] },
    ]);
    expect(getClaudeInputItems({ input: ['hi', { type: 'message', role: 'user', content: [] }] })).toEqual([
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] },
      { type: 'message', role: 'user', content: [] },
    ]);
  });

  it('treats a role-only item as a message', () => {
    expect(getClaudeInputItems({ input: [{ role: 'user', content: 'hi' }] })).toEqual([
      { type: 'message', role: 'user', content: 'hi' },
    ]);
  });
});

describe('getClaudeAssistantBoundaries', () => {
  const conversation: Json[] = [
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'look it up' }] },
    { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'checking' }] },
    { type: 'function_call', call_id: 'call_1', name: 'lookup', arguments: '{}' },
    { type: 'function_call_output', call_id: 'call_1', output: 'found' },
    { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'done' }] },
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'thanks' }] },
  ];

  it('groups each assistant turn and records its conversation prefix', () => {
    const boundaries = getClaudeAssistantBoundaries(conversation);
    expect(boundaries).toHaveLength(2);
    expect(boundaries[0]?.callIds).toEqual(['call_1']);
    expect(boundaries[1]?.callIds).toEqual([]);
    expect(boundaries[0]?.prefixIdentity).toBe(getClaudeConversationIdentity(conversation.slice(0, 1)));
    expect(boundaries[1]?.prefixIdentity).toBe(getClaudeConversationIdentity(conversation.slice(0, 4)));
    expect(boundaries[0]?.prefixIdentity).not.toBe(boundaries[1]?.prefixIdentity);
  });

  it('marks only the unfinished tool turn as pending', () => {
    const boundaries = getClaudeAssistantBoundaries(conversation);
    expect(boundaries.map((boundary) => boundary.isPendingToolTurn)).toEqual([false, false]);

    const pending: Json[] = [
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'look it up' }] },
      { type: 'function_call', call_id: 'call_1', name: 'lookup', arguments: '{}' },
      { type: 'function_call_output', call_id: 'call_1', output: 'found' },
    ];
    expect(getClaudeAssistantBoundaries(pending)[0]?.isPendingToolTurn).toBe(true);

    // A user turn after the tool result closes the turn again.
    const closed: Json[] = [...pending, { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'and now?' }] }];
    expect(getClaudeAssistantBoundaries(closed)[0]?.isPendingToolTurn).toBe(false);
  });

  it('ignores reasoning items when deciding whether a tool turn is still open', () => {
    const pending: Json[] = [
      { type: 'function_call', call_id: 'call_1', name: 'lookup', arguments: '{}' },
      { type: 'function_call_output', call_id: 'call_1', output: 'found' },
      { type: 'reasoning', id: 'rs_1', summary: [] },
    ];
    expect(getClaudeAssistantBoundaries(pending)[0]?.isPendingToolTurn).toBe(true);
  });

  it('keeps one native assistant whole across an echoed reasoning shell', () => {
    // Supervisor input-validation probe: user, assistant text, reasoning, function_call, result
    // is ONE assistant turn (text + thinking + tool), never two boundaries.
    const echoed: Json[] = [
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'look it up' }] },
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Look this up.' }] },
      { type: 'reasoning', summary: [] },
      { type: 'function_call', call_id: 'a', name: 'tool', arguments: '{}' },
      { type: 'function_call_output', call_id: 'a', output: 'found' },
    ];
    const boundaries = getClaudeAssistantBoundaries(echoed);
    expect(boundaries).toHaveLength(1);
    expect(boundaries[0]?.callIds).toEqual(['a']);
    expect(boundaries[0]?.isPendingToolTurn).toBe(true);
  });

  it('groups text before and between multiple tools with interleaved reasoning as one turn', () => {
    const echoed: Json[] = [
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'first' }] },
      { type: 'function_call', call_id: 'a', name: 'one', arguments: '{}' },
      { type: 'reasoning', summary: [] },
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'between' }] },
      { type: 'function_call', call_id: 'b', name: 'two', arguments: '{}' },
      { type: 'reasoning', summary: [] },
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'last' }] },
      { type: 'function_call', call_id: 'c', name: 'three', arguments: '{}' },
    ];
    const boundaries = getClaudeAssistantBoundaries(echoed);
    expect(boundaries).toHaveLength(1);
    expect(boundaries[0]?.callIds).toEqual(['a', 'b', 'c']);
  });
});

describe('getClaudeVisibleAssistantIdentity', () => {
  it('matches the native content saved for the same turn', () => {
    const native: Json[] = [
      { type: 'thinking', thinking: 'hidden', signature: 'sig' },
      { type: 'text', text: 'Checking.' },
      { type: 'tool_use', id: 'a', name: 'lookup', input: { key: 'v' } },
    ];
    const echoed: Json[] = [
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Checking.' }] },
      { type: 'function_call', call_id: 'a', name: 'lookup', arguments: '{"key":"v"}' },
    ];
    expect(getClaudeVisibleAssistantIdentity(echoed)).toBe(getClaudeNativeVisibleIdentity(native));
  });

  it('survives Chat aggregation of multiple text blocks and key reordering', () => {
    const responsesEcho: Json[] = [
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'one ' }] },
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'two' }] },
      { type: 'function_call', call_id: 'a', name: 'lookup', arguments: '{"b":2,"a":1}' },
    ];
    const chatEcho: Json[] = [
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'one two' }] },
      { type: 'function_call', call_id: 'a', name: 'lookup', arguments: '{"a":1,"b":2}' },
    ];
    expect(getClaudeVisibleAssistantIdentity(responsesEcho)).toBe(getClaudeVisibleAssistantIdentity(chatEcho));
  });

  it('separates two branches that share a prefix but produced different tool ids', () => {
    const branchA: Json[] = [{ type: 'function_call', call_id: 'toolu_1', name: 'lookup', arguments: '{}' }];
    const branchB: Json[] = [{ type: 'function_call', call_id: 'toolu_2', name: 'lookup', arguments: '{}' }];
    expect(getClaudeVisibleAssistantIdentity(branchA)).not.toBe(getClaudeVisibleAssistantIdentity(branchB));
  });

  it('changes when the client edits visible text or arguments', () => {
    const original: Json[] = [
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'ok' }] },
      { type: 'function_call', call_id: 'a', name: 'lookup', arguments: '{"x":1}' },
    ];
    const editedText = original.map((item) => (item.type === 'message' ? { ...item, content: [{ type: 'output_text', text: 'edited' }] } : item));
    const editedArgs = original.map((item) => (item.type === 'function_call' ? { ...item, arguments: '{"x":2}' } : item));
    expect(getClaudeVisibleAssistantIdentity(editedText)).not.toBe(getClaudeVisibleAssistantIdentity(original));
    expect(getClaudeVisibleAssistantIdentity(editedArgs)).not.toBe(getClaudeVisibleAssistantIdentity(original));
  });
});

describe('getClaudeAccountIdentity', () => {
  it('follows the recorded account, not just the home path', () => {
    expect(getClaudeAccountIdentity('/home/claude1', 'acct-1')).not.toBe(getClaudeAccountIdentity('/home/claude1', 'acct-2'));
    expect(getClaudeAccountIdentity('/home/claude1', 'acct-1')).toBe(getClaudeAccountIdentity('/home/claude1', 'acct-1'));
  });
});

describe('createClaudeStateStore', () => {
  const baseSave = {
    accountIdentity: ACCOUNT,
    alias: 'claude1',
    model: 'claude-opus-5',
    thinking: { type: 'adaptive' as const, effort: 'high' },
    assistantContent: [
      { type: 'thinking', thinking: 'hidden', signature: 'sig' },
      { type: 'tool_use', id: 'call_1', name: 'get_weather', input: { city: 'Paris' } },
    ],
    callIds: ['call_1'],
  };

  it('saves and reads back the native assistant content', async () => {
    const { store } = await makeStore();
    const identity = getClaudeConversationIdentity(USER_TURN);
    await store.save({ ...baseSave, identity, nowMs: 1700000000000 });
    const state = await store.read(getClaudeStateKey(ACCOUNT, 'claude-opus-5', identity));
    expect(state).toMatchObject({
      version: CLAUDE_STATE_VERSION,
      alias: 'claude1',
      model: 'claude-opus-5',
      thinking: { type: 'adaptive', effort: 'high' },
      savedAtMs: 1700000000000,
      callIds: ['call_1'],
    });
    expect(state?.assistantContent[0]).toEqual({ type: 'thinking', thinking: 'hidden', signature: 'sig' });
  });

  it('keeps state isolated per account, per login and per model', async () => {
    const { store } = await makeStore();
    const identity = getClaudeConversationIdentity(USER_TURN);
    await store.save({ ...baseSave, identity });
    expect(await store.read(getClaudeStateKey(getClaudeAccountIdentity('/home/claude2', 'acct-1'), 'claude-opus-5', identity))).toBeUndefined();
    expect(await store.read(getClaudeStateKey(getClaudeAccountIdentity('/home/claude1', 'acct-2'), 'claude-opus-5', identity))).toBeUndefined();
    expect(await store.read(getClaudeStateKey(ACCOUNT, 'claude-sonnet-5', identity))).toBeUndefined();
    expect(await store.read(getClaudeStateKey(ACCOUNT, 'claude-opus-5', `${identity}x`))).toBeUndefined();
  });

  it('writes a 0700 directory and 0600 files', async () => {
    const { stateDir, store } = await makeStore();
    await store.save({ ...baseSave, identity: getClaudeConversationIdentity(USER_TURN) });
    expect(((await stat(stateDir)).mode & 0o777).toString(8)).toBe('700');
    const [fileName] = await readdir(stateDir);
    expect(fileName).toMatch(/^[0-9a-f]{64}\.json$/);
    expect(((await stat(path.join(stateDir, fileName ?? ''))).mode & 0o777).toString(8)).toBe('600');
  });

  it('leaves no temp files behind', async () => {
    const { stateDir, store } = await makeStore();
    await store.save({ ...baseSave, identity: getClaudeConversationIdentity(USER_TURN) });
    expect((await readdir(stateDir)).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });

  it('reports corrupt state as a request error instead of replaying garbage', async () => {
    const { stateDir, store } = await makeStore();
    await mkdir(stateDir, { recursive: true, mode: 0o700 });
    const stateKey = getClaudeStateKey(ACCOUNT, 'claude-opus-5', 'abc');
    await writeFile(path.join(stateDir, `${stateKey}.json`), '{ nope');
    const error = await getRejection(store.read(stateKey));
    expect(error.status).toBe(400);
    expect(error.message).toContain('corrupt');
  });

  it('rejects a valid record that was copied under another key', async () => {
    // Review round 1 / A: the stored account/model/identity must match the key it is read under.
    const { stateDir, store } = await makeStore();
    await store.save({ ...baseSave, identity: getClaudeConversationIdentity(USER_TURN) });
    const [fileName] = await readdir(stateDir);
    const copiedKey = getClaudeStateKey(ACCOUNT, 'claude-opus-5', 'copied-identity');
    await copyFile(path.join(stateDir, fileName ?? ''), path.join(stateDir, `${copiedKey}.json`));
    const error = await getRejection(store.read(copiedKey));
    expect(error.status).toBe(400);
    expect(error.message).toContain('corrupt');
  });

  it('never echoes the stored content when the state file is corrupt', async () => {
    const { stateDir, store } = await makeStore();
    await mkdir(stateDir, { recursive: true, mode: 0o700 });
    const stateKey = getClaudeStateKey(ACCOUNT, 'claude-opus-5', 'abc');
    await writeFile(path.join(stateDir, `${stateKey}.json`), '{"signature":"secret-signature"');
    const error = await getRejection(store.read(stateKey));
    expect(error.message).not.toContain('secret-signature');
  });

  it.each([
    ['another version', { version: 999, alias: 'claude1', model: 'claude-opus-5', accountIdentity: ACCOUNT, identity: 'abc', savedAtMs: 1, thinking: { type: 'adaptive' }, assistantContent: [], callIds: [] }],
    ['no thinking configuration', { version: CLAUDE_STATE_VERSION, alias: 'claude1', model: 'claude-opus-5', accountIdentity: ACCOUNT, identity: 'abc', savedAtMs: 1, assistantContent: [], callIds: [] }],
    ['a non-array assistantContent', { version: CLAUDE_STATE_VERSION, alias: 'claude1', model: 'claude-opus-5', accountIdentity: ACCOUNT, identity: 'abc', savedAtMs: 1, thinking: { type: 'adaptive' }, assistantContent: {}, callIds: [] }],
    ['a non-string callIds entry', { version: CLAUDE_STATE_VERSION, alias: 'claude1', model: 'claude-opus-5', accountIdentity: ACCOUNT, identity: 'abc', savedAtMs: 1, thinking: { type: 'adaptive' }, assistantContent: [], callIds: [1] }],
    ['no account identity', { version: CLAUDE_STATE_VERSION, alias: 'claude1', model: 'claude-opus-5', identity: 'abc', savedAtMs: 1, thinking: { type: 'adaptive' }, assistantContent: [], callIds: [] }],
    ['no conversation identity', { version: CLAUDE_STATE_VERSION, alias: 'claude1', model: 'claude-opus-5', accountIdentity: ACCOUNT, savedAtMs: 1, thinking: { type: 'adaptive' }, assistantContent: [], callIds: [] }],
    ['a thinking block without signature', { version: CLAUDE_STATE_VERSION, alias: 'claude1', model: 'claude-opus-5', accountIdentity: ACCOUNT, identity: 'abc', savedAtMs: 1, thinking: { type: 'enabled', budgetTokens: 2048 }, assistantContent: [{ type: 'thinking', thinking: 'x' }], callIds: [] }],
    ['a tool_use block without name', { version: CLAUDE_STATE_VERSION, alias: 'claude1', model: 'claude-opus-5', accountIdentity: ACCOUNT, identity: 'abc', savedAtMs: 1, thinking: { type: 'adaptive' }, assistantContent: [{ type: 'tool_use', id: 'a', input: {} }], callIds: ['a'] }],
    ['a tool_use block with string input', { version: CLAUDE_STATE_VERSION, alias: 'claude1', model: 'claude-opus-5', accountIdentity: ACCOUNT, identity: 'abc', savedAtMs: 1, thinking: { type: 'adaptive' }, assistantContent: [{ type: 'tool_use', id: 'a', name: 'x', input: 'oops' }], callIds: ['a'] }],
    ['callIds that do not match the stored tool_use blocks', { version: CLAUDE_STATE_VERSION, alias: 'claude1', model: 'claude-opus-5', accountIdentity: ACCOUNT, identity: 'abc', savedAtMs: 1, thinking: { type: 'adaptive' }, assistantContent: [{ type: 'tool_use', id: 'a', name: 'x', input: {} }], callIds: ['other'] }],
    ['enabled thinking without a budget', { version: CLAUDE_STATE_VERSION, alias: 'claude1', model: 'claude-opus-5', accountIdentity: ACCOUNT, identity: 'abc', savedAtMs: 1, thinking: { type: 'enabled' }, assistantContent: [], callIds: [] }],
    ['enabled thinking below the 1024 budget floor', { version: CLAUDE_STATE_VERSION, alias: 'claude1', model: 'claude-opus-5', accountIdentity: ACCOUNT, identity: 'abc', savedAtMs: 1, thinking: { type: 'enabled', budgetTokens: 1 }, assistantContent: [], callIds: [] }],
    ['an unknown effort level', { version: CLAUDE_STATE_VERSION, alias: 'claude1', model: 'claude-opus-5', accountIdentity: ACCOUNT, identity: 'abc', savedAtMs: 1, thinking: { type: 'adaptive', effort: 'ultra' }, assistantContent: [], callIds: [] }],
    ['a non-string requestedEffort', { version: CLAUDE_STATE_VERSION, alias: 'claude1', model: 'claude-opus-5', accountIdentity: ACCOUNT, identity: 'abc', savedAtMs: 1, thinking: { type: 'adaptive', requestedEffort: 7 }, assistantContent: [], callIds: [] }],
    ['a requestedEffort outside the supported domain', { version: CLAUDE_STATE_VERSION, alias: 'claude1', model: 'claude-opus-5', accountIdentity: ACCOUNT, identity: 'abc', savedAtMs: 1, thinking: { type: 'adaptive', requestedEffort: 'banana' }, assistantContent: [], callIds: [] }],
  ])('rejects a state file with %s', async (_label, record) => {
    const { stateDir, store } = await makeStore();
    await mkdir(stateDir, { recursive: true, mode: 0o700 });
    const stateKey = getClaudeStateKey(ACCOUNT, 'claude-opus-5', 'abc');
    await writeFile(path.join(stateDir, `${stateKey}.json`), JSON.stringify(record));
    const error = await getRejection(store.read(stateKey));
    expect(error.status).toBe(400);
    expect(error.message).toContain('corrupt');
  });

  it('reads back what it wrote as valid JSON', async () => {
    const { stateDir, store } = await makeStore();
    await store.save({ ...baseSave, thinking: { type: 'enabled', effort: 'low', budgetTokens: 2048 }, identity: getClaudeConversationIdentity(USER_TURN) });
    const [fileName] = await readdir(stateDir);
    const raw = JSON.parse(await readFile(path.join(stateDir, fileName ?? ''), 'utf8')) as Json;
    expect(raw.model).toBe('claude-opus-5');
    expect((raw.thinking as Json).budgetTokens).toBe(2048);
  });
});
