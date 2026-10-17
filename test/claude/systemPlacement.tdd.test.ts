// Mirrors references/CLIProxyAPI v8.0.29 claude_executor_cloaking.go caller placement.
// Native 2.1.299 bL/cr @217933672/@217928457 gates the GA system role (no beta).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { prepareClaudeRequest } from '../../src/claude/normalizeRequest.js';
import { findClaudeModelMetadata } from '../../src/claude/modelMetadata.js';
import type { ClaudeTurnState } from '../../src/claude/types.js';
import type { Json } from '../../src/types.js';

afterEach(() => vi.unstubAllEnvs());

const prepare = (body: Json, modelId = 'claude-sonnet-5') => prepareClaudeRequest({
  body: { max_output_tokens: 4096, ...body }, modelId, alias: 'claude1', settings: {}, metadata: findClaudeModelMetadata(modelId),
});

describe('caller system placement', () => {
  it.each(['claude-sonnet-5', 'claude-sonnet-5[1m]', 'claude-opus-5', 'claude-opus-4-8', 'claude-future'])('preserves caller instructions as system after the first user turn on %s', (modelId) => {
    const body = {
      instructions: 'Application policy: 回答要精簡。',
      input: [
        { type: 'message', role: 'developer', content: 'Keep the tool names intact.' },
        { type: 'message', role: 'user', content: 'hello' },
      ],
      tools: [{ type: 'function', name: 'read', parameters: { type: 'object', properties: {} } }],
    };
    const original = structuredClone(body);
    const { request, betas } = prepare(body, modelId);
    const callerText = 'Application policy: 回答要精簡。\n\nKeep the tool names intact.';
    expect((request.system as Json[]).some((block) => block.text === callerText)).toBe(false);
    expect(request.messages.map((message) => message.role)).toEqual(['user', 'system']);
    expect(request.messages[1]?.content).toEqual([{ type: 'text', text: callerText, cache_control: { type: 'ephemeral' } }]);
    expect((request.tools as Json[])[0]?.name).toBe('read');
    expect(betas).not.toContain('mid-conversation-system-2026-04-07');
    expect(body).toEqual(original);
  });

  it('keeps the merged leading user turn and later history in their original order', () => {
    const { request } = prepare({ instructions: 'policy', input: [
      { type: 'message', role: 'user', content: 'first' },
      { type: 'message', role: 'user', content: 'second' },
      { type: 'message', role: 'assistant', content: 'answer' },
      { type: 'message', role: 'user', content: 'next' },
    ] });
    expect(request.messages.map((message) => message.role)).toEqual(['user', 'system', 'assistant', 'user']);
    expect((request.messages[0]?.content as Json[]).map((block) => block.text)).toEqual(['first', 'second']);
    expect((request.messages[2]?.content as Json[])[0]?.text).toBe('answer');
    expect((request.messages[3]?.content as Json[])[0]?.text).toBe('next');
  });

  it('places the same policy when billing attribution is disabled', () => {
    vi.stubEnv('CLAUDE_CODE_ATTRIBUTION_HEADER', '0');
    const { request } = prepare({ input: 'hello', instructions: 'policy' });
    expect((request.system as Json[])).toHaveLength(1);
    expect(request.messages[1]).toMatchObject({ role: 'system', content: [{ text: 'policy' }] });
  });

  it('keeps signed tool replay verbatim after the inserted system turn', () => {
    const state: ClaudeTurnState = {
      version: 1, alias: 'claude1', model: 'claude-sonnet-5', accountIdentity: 'account',
      identity: 'turn', savedAtMs: 0, thinking: { type: 'adaptive', effort: 'high' }, callIds: ['call_1'],
      assistantContent: [
        { type: 'thinking', thinking: 'private', signature: 'signed-content' },
        { type: 'tool_use', id: 'call_1', name: 'read', input: { path: 'package.json' } },
      ],
    };
    const originalState = structuredClone(state);
    const { request } = prepareClaudeRequest({
      modelId: state.model, alias: 'claude1', settings: {}, state, metadata: findClaudeModelMetadata(state.model),
      body: { instructions: 'policy', input: [
        { type: 'message', role: 'user', content: 'read the package' },
        { type: 'function_call', call_id: 'call_1', name: 'read', arguments: '{"path":"package.json"}' },
        { type: 'function_call_output', call_id: 'call_1', output: 'file contents' },
      ] },
    });
    expect(request.messages.map((message) => message.role)).toEqual(['user', 'system', 'assistant', 'user']);
    expect(request.messages[2]?.content).toEqual(originalState.assistantContent);
    expect(request.messages[3]?.content).toMatchObject([{ type: 'tool_result', tool_use_id: 'call_1', content: [{ text: 'file contents' }] }]);
    expect(state).toEqual(originalState);
  });

  it.each([
    'claude-3-5-sonnet', 'claude-3-7-sonnet-latest', 'claude-3-5-haiku-20241022',
    'claude-sonnet-4', 'claude-sonnet-4-0', 'claude-sonnet-4-20250514', 'claude-sonnet-4-5-20250929',
    'claude-sonnet-4-6[1m]', 'claude-haiku-4-5', 'claude-opus-4', 'claude-opus-4-0',
    'claude-opus-4-1', 'claude-opus-4-5', 'claude-opus-4-6', 'claude-opus-4-7',
  ])('retains top-level system authority on unsupported %s', (modelId) => {
    const { request } = prepare({ input: 'hello', instructions: 'policy' }, modelId);
    expect(request.messages.map((message) => message.role)).toEqual(['user']);
    expect((request.system as Json[]).at(-1)?.text).toBe('policy');
  });

  it('does not add an empty system turn without caller instructions', () => {
    const { request } = prepare({ input: 'hello' });
    expect(request.messages.map((message) => message.role)).toEqual(['user']);
  });
});
