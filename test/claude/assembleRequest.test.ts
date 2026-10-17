// Assembly layer: normalized native input -> the official request shape. Mirrors the native
// release 2.1.299 anchors in docs/CLAUDE_UPSTREAM_PROTOCOL_DIFF.md (system K_o tail at 218995076
// via $Nr at 226727459, billing wSo at 218606801, cache builder NNr at 226725197, metadata nUe at
// 218996645, effort tGe at 226583782, thinking floor at 226635226) and the caller placement of
// references/CLIProxyAPI v8.0.29 claude_executor_cloaking.go.
import { afterAll, describe, expect, it } from 'vitest';
import { assembleClaudeRequest, type ClaudeNativeInput, type ClaudeRequestFieldNames, markLastEligibleMessage } from '../../src/claude/assembleRequest.js';
import { findClaudeModelMetadata } from '../../src/claude/modelMetadata.js';
import { CLAUDE_CLI_SYSTEM_PREFIX, CLAUDE_CODE_BETA, CLAUDE_EFFORT_BETA, CLAUDE_STRUCTURED_OUTPUTS_BETA } from '../../src/constants.js';
import type { Json } from '../../src/types.js';

const CLAUDE_ENV_KEYS = ['CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_ACTION', 'CLAUDE_CODE_ATTRIBUTION_HEADER'] as const;
const savedEnv = Object.fromEntries(CLAUDE_ENV_KEYS.map((key) => [key, process.env[key]]));
for (const key of CLAUDE_ENV_KEYS) delete process.env[key];
afterAll(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

const EPHEMERAL = { type: 'ephemeral' };
// "hi" -> chars "000" -> literal fingerprint fa6 (same vector as normalizeRequest.test.ts).
const BILLING_HI = { type: 'text', text: 'x-anthropic-billing-header: cc_version=2.1.299.fa6; cc_entrypoint=cli; cch=00000;' };
const ANTHROPIC_FIELD_NAMES: ClaudeRequestFieldNames = {
  maxTokens: '`max_tokens`',
  effort: '`output_config.effort`',
  disableThinking: '`thinking: {"type":"disabled"}`',
  autoToolChoice: '`tool_choice: {"type":"auto"}`',
};

const native = (overrides: Partial<ClaudeNativeInput> = {}): ClaudeNativeInput => ({
  messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
  callerTexts: [],
  tools: [],
  isToolChoiceNone: false,
  firstUserText: 'hi',
  ...overrides,
});

const assemble = (input: ClaudeNativeInput, modelId = 'claude-opus-5', extra: { fieldNames?: ClaudeRequestFieldNames; session?: { sessionId: string; accountUuid: string; deviceId?: string } } = {}) =>
  assembleClaudeRequest({ native: input, modelId, metadata: findClaudeModelMetadata(modelId), settings: {}, ...extra });

const getError = (run: () => unknown): Error & { status: number } => {
  try {
    run();
  } catch (error) {
    return error as Error & { status: number };
  }
  throw new Error('expected assembleClaudeRequest to throw');
};

describe('assembleClaudeRequest', () => {
  it('builds billing, the cached CLI prefix and a mid-conversation caller block', () => {
    const { request } = assemble(native({ callerTexts: ['Rule one.', 'Rule two.'] }));
    expect(request.system).toEqual([BILLING_HI, { type: 'text', text: CLAUDE_CLI_SYSTEM_PREFIX, cache_control: EPHEMERAL }]);
    expect(request.messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'hi', cache_control: EPHEMERAL }] },
      { role: 'system', content: [{ type: 'text', text: 'Rule one.\n\nRule two.', cache_control: EPHEMERAL }] },
    ]);
  });

  it('keeps the caller block in system on a model without mid-conversation system support', () => {
    const { request } = assemble(native({ callerTexts: ['Rule one.'] }), 'claude-sonnet-4-5');
    expect(request.system).toEqual([BILLING_HI, { type: 'text', text: CLAUDE_CLI_SYSTEM_PREFIX, cache_control: EPHEMERAL }, { type: 'text', text: 'Rule one.', cache_control: EPHEMERAL }]);
    expect(request.messages).toHaveLength(1);
  });

  it('fingerprints the billing block from the given first user text', () => {
    // Literal vector shared with attribution.test.ts: chars "h?0" -> "205".
    const { request } = assemble(native({ firstUserText: 'weather?' }));
    expect((request.system as Json[])[0]?.text).toBe('x-anthropic-billing-header: cc_version=2.1.299.205; cc_entrypoint=cli; cch=00000;');
  });

  it('marks only the last eligible message, skipping an assistant that ends in thinking', () => {
    const messages: Json[] = [
      { role: 'user', content: [{ type: 'text', text: 'first' }, { type: 'text', text: '  ' }] },
      { role: 'assistant', content: [{ type: 'thinking', thinking: 'x', signature: 'sig' }] },
    ];
    markLastEligibleMessage(messages);
    expect(messages[0]?.content).toEqual([{ type: 'text', text: 'first', cache_control: EPHEMERAL }, { type: 'text', text: '  ' }]);
    expect(messages[1]?.content).toEqual([{ type: 'thinking', thinking: 'x', signature: 'sig' }]);
  });

  it('sends metadata.user_id only with a session, device_id only when known', () => {
    expect(assemble(native()).request.metadata).toBeUndefined();
    const withDevice = assemble(native(), 'claude-opus-5', { session: { sessionId: 's-1', accountUuid: 'a-1', deviceId: 'd-1' } });
    expect(withDevice.request.metadata).toEqual({ user_id: JSON.stringify({ device_id: 'd-1', account_uuid: 'a-1', session_id: 's-1' }) });
    const withoutDevice = assemble(native(), 'claude-opus-5', { session: { sessionId: 's-1', accountUuid: 'a-1' } });
    expect(withoutDevice.request.metadata).toEqual({ user_id: JSON.stringify({ account_uuid: 'a-1', session_id: 's-1' }) });
  });

  it('applies the model gates for betas', () => {
    expect(assemble(native()).betas).toContain(CLAUDE_CODE_BETA);
    expect(assemble(native()).betas).toContain(CLAUDE_EFFORT_BETA);
    expect(assemble(native(), 'claude-haiku-4-5').betas).not.toContain(CLAUDE_CODE_BETA);
  });

  it('resolves thinking: adaptive, budget form, and explicit none', () => {
    expect(assemble(native()).request.thinking).toEqual({ type: 'adaptive' });
    expect(assemble(native(), 'claude-sonnet-4-5').request.thinking).toEqual({ type: 'enabled', budget_tokens: 31999 });
    expect(assemble(native({ explicitEffort: 'none' }), 'claude-sonnet-4-5').request.thinking).toEqual({ type: 'disabled' });
  });

  it('drops tools for tool_choice none and keeps an explicit native tool_choice', () => {
    const tool = { name: 'get_weather', input_schema: { type: 'object', properties: {} } };
    expect(assemble(native({ tools: [tool], isToolChoiceNone: true })).request.tools).toBeUndefined();
    const { request } = assemble(native({ tools: [tool], toolChoice: { type: 'auto', disable_parallel_tool_use: true } }));
    expect(request.tools).toEqual([tool]);
    expect(request.tool_choice).toEqual({ type: 'auto', disable_parallel_tool_use: true });
  });

  it.each([
    ['OpenAI names by default', undefined, 'send `reasoning.effort: "none"` or `tool_choice: "auto"`'],
    ['the caller API names when given', ANTHROPIC_FIELD_NAMES, 'send `thinking: {"type":"disabled"}` or `tool_choice: {"type":"auto"}`'],
  ])('rejects a forced tool_choice while thinking is on, with %s', (_name, fieldNames, expected) => {
    const tool = { name: 'get_weather', input_schema: { type: 'object', properties: {} } };
    const error = getError(() => assemble(native({ tools: [tool], toolChoice: { type: 'any' } }), 'claude-opus-5', fieldNames ? { fieldNames } : {}));
    expect(error.status).toBe(400);
    expect(error.message).toContain(expected);
  });

  it('defaults max_tokens from the model table and rejects values above its limit', () => {
    const metadata = findClaudeModelMetadata('claude-opus-5');
    expect(assemble(native()).maxTokens).toBe(metadata?.maxOutputDefault);
    const error = getError(() => assemble(native({ maxTokens: (metadata?.maxOutputUpper ?? 0) + 1 }), 'claude-opus-5', { fieldNames: ANTHROPIC_FIELD_NAMES }));
    expect(error.message).toBe(`\`max_tokens\` exceeds the claude-opus-5 limit of ${metadata?.maxOutputUpper}`);
  });

  it('requires max_tokens for an unknown model and enforces the thinking budget floor', () => {
    expect(getError(() => assemble(native(), 'claude-unknown-9')).message).toBe('Unknown Claude model "claude-unknown-9"; send `max_output_tokens`');
    const floor = getError(() => assemble(native({ maxTokens: 512 }), 'claude-sonnet-4-5', { fieldNames: ANTHROPIC_FIELD_NAMES }));
    expect(floor.message).toContain('`max_tokens` must exceed the 1024-token thinking budget floor');
  });

  it('adds output_config.format with its beta, and rejects it on a model without structured output', () => {
    const format = { type: 'json_schema', schema: { type: 'object', properties: {} } };
    const prepared = assemble(native({ format }));
    expect(prepared.request.output_config).toMatchObject({ format });
    expect(prepared.betas).toContain(CLAUDE_STRUCTURED_OUTPUTS_BETA);
    expect(getError(() => assemble(native({ format }), 'claude-opus-4-1')).message).toBe('Model "claude-opus-4-1" does not support structured output');
  });
});
