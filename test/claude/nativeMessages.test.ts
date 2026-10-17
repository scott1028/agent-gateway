// Anthropic Messages body (not the official Claude Code) -> normalized native input for the
// downgrade path. One case per accept/reject rule of the 2b spec table; the accepted surface is
// the Claude support boundary in docs/CLAUDE_UPSTREAM_PROTOCOL_DIFF.md §10, and dropping client
// cache markers and metadata follows references/CLIProxyAPI v8.0.29 claude_executor_cloaking.go.
// The billing text rule is qB at 222259800 (native release 2.1.299) via attribution.ts.
import { describe, expect, it } from 'vitest';
import { toClaudeNativeRequest } from '../../src/claude/nativeMessages.js';
import type { Json } from '../../src/types.js';

const body = (overrides: Json = {}): Json => ({
  model: 'claude-opus-5',
  max_tokens: 1024,
  messages: [{ role: 'user', content: 'hi' }],
  ...overrides,
});

const getError = (run: () => unknown): Error & { status: number } => {
  try {
    run();
  } catch (error) {
    return error as Error & { status: number };
  }
  throw new Error('expected toClaudeNativeRequest to throw');
};

const IMAGE_BASE64 = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } };
const IMAGE_URL = { type: 'image', source: { type: 'url', url: 'https://example.test/a.png' } };
const TOOL = { name: 'get_weather', description: 'Weather.', input_schema: { type: 'object', properties: { city: { type: 'string' } } } };

describe('system', () => {
  it('accepts a string or text blocks and drops client cache_control', () => {
    expect(toClaudeNativeRequest(body({ system: 'Be brief.' })).native.callerTexts).toEqual(['Be brief.']);
    const blocks = toClaudeNativeRequest(body({ system: [{ type: 'text', text: 'One.', cache_control: { type: 'ephemeral' } }, { type: 'text', text: 'Two.' }] }));
    expect(blocks.native.callerTexts).toEqual(['One.', 'Two.']);
  });

  it('rejects a non-text system block', () => {
    expect(getError(() => toClaudeNativeRequest(body({ system: [IMAGE_BASE64] }))).message).toContain('system[0] must be a text block');
  });
});

describe('messages', () => {
  it('keeps text, images, tool_use, tool_result and assistant thinking blocks, without cache_control', () => {
    const request = toClaudeNativeRequest(body({
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'look', cache_control: { type: 'ephemeral' } }, IMAGE_BASE64, IMAGE_URL] },
        { role: 'assistant', content: [
          { type: 'thinking', thinking: 'hmm', signature: 'sig-1' },
          { type: 'redacted_thinking', data: 'opaque' },
          { type: 'text', text: 'calling', citations: null },
          { type: 'tool_use', id: 'toolu_1', name: 'get_weather', input: { city: 'Paris' } },
        ] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: [{ type: 'text', text: 'sunny' }, IMAGE_BASE64], is_error: false }] },
      ],
    }));
    expect(request.native.messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'look' }, IMAGE_BASE64, IMAGE_URL] },
      { role: 'assistant', content: [
        { type: 'thinking', thinking: 'hmm', signature: 'sig-1' },
        { type: 'redacted_thinking', data: 'opaque' },
        { type: 'text', text: 'calling' },
        { type: 'tool_use', id: 'toolu_1', name: 'get_weather', input: { city: 'Paris' } },
      ] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: [{ type: 'text', text: 'sunny' }, IMAGE_BASE64], is_error: false }] },
    ]);
  });

  it('turns string content into a text block and merges adjacent same-role messages', () => {
    const request = toClaudeNativeRequest(body({ messages: [{ role: 'user', content: 'a' }, { role: 'user', content: [{ type: 'text', text: 'b' }] }] }));
    expect(request.native.messages).toEqual([{ role: 'user', content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] }]);
  });

  it.each([
    ['a document block', { role: 'user', content: [{ type: 'document', source: { type: 'text', data: 'x' } }] }, 'Unsupported content block type "document"'],
    ['a search_result block', { role: 'user', content: [{ type: 'search_result', source: 'x', title: 't', content: [] }] }, '"search_result"'],
    ['a server tool result', { role: 'user', content: [{ type: 'web_search_tool_result', tool_use_id: 'x', content: [] }] }, '"web_search_tool_result"'],
    ['an mcp block', { role: 'assistant', content: [{ type: 'mcp_tool_use', id: 'x', name: 'n', server_name: 's', input: {} }] }, '"mcp_tool_use"'],
    ['thinking in a user message', { role: 'user', content: [{ type: 'thinking', thinking: 'x', signature: 's' }] }, 'thinking blocks belong to assistant messages'],
    ['an assistant image', { role: 'assistant', content: [IMAGE_BASE64] }, 'assistant messages cannot carry images'],
    ['an http image URL', { role: 'user', content: [{ type: 'image', source: { type: 'url', url: 'http://example.test/a.png' } }] }, 'https://'],
    ['an unsupported image type', { role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/bmp', data: 'AA' } }] }, 'image/bmp'],
    ['a tool_result with a document', { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x', content: [{ type: 'document' }] }] }, 'Unsupported tool_result content type "document"'],
  ])('rejects %s', (_name, message, expected) => {
    const messages = message.role === 'assistant' ? [{ role: 'user', content: 'hi' }, message] : [message];
    const error = getError(() => toClaudeNativeRequest(body({ messages })));
    expect(error.status).toBe(400);
    expect(error.message).toContain(expected);
  });

  it('requires the first message to come from the user', () => {
    expect(getError(() => toClaudeNativeRequest(body({ messages: [{ role: 'assistant', content: 'hi' }] }))).message).toContain('first message to come from the user');
  });
});

describe('tools and tool_choice', () => {
  it('accepts custom tools in the official tool shape', () => {
    expect(toClaudeNativeRequest(body({ tools: [{ ...TOOL, cache_control: { type: 'ephemeral' } }] })).native.tools).toEqual([TOOL]);
    expect(toClaudeNativeRequest(body({ tools: [{ ...TOOL, type: 'custom' }] })).native.tools).toEqual([TOOL]);
  });

  it('rejects server and built-in tools', () => {
    expect(getError(() => toClaudeNativeRequest(body({ tools: [{ type: 'web_search_20250305', name: 'web_search' }] }))).message).toContain('Only custom tools');
  });

  it.each([
    [{ type: 'auto' }, undefined, false],
    [{ type: 'auto', disable_parallel_tool_use: true }, { type: 'auto', disable_parallel_tool_use: true }, false],
    [{ type: 'any' }, { type: 'any' }, false],
    [{ type: 'tool', name: 'get_weather' }, { type: 'tool', name: 'get_weather' }, false],
    [{ type: 'none' }, undefined, true],
  ])('maps tool_choice %j', (toolChoice, expected, isNone) => {
    const { native } = toClaudeNativeRequest(body({ tools: [TOOL], tool_choice: toolChoice }));
    expect(native.toolChoice).toEqual(expected);
    expect(native.isToolChoiceNone).toBe(isNone);
  });

  it('drops a tool_choice without tools, as the OpenAI path does', () => {
    expect(toClaudeNativeRequest(body({ tool_choice: { type: 'any' } })).native.toolChoice).toBeUndefined();
  });
});

describe('max_tokens, output_config and thinking', () => {
  it.each([undefined, 0, 1.5, '1024'])('requires a positive integer max_tokens (%j)', (maxTokens) => {
    expect(getError(() => toClaudeNativeRequest(body({ max_tokens: maxTokens }))).message).toBe('`max_tokens` must be a positive integer');
  });

  it('takes output_config.effort as the explicit effort and maps json_schema format', () => {
    const schema = { type: 'object', properties: {} };
    const { native } = toClaudeNativeRequest(body({ output_config: { effort: 'low', format: { type: 'json_schema', schema } } }));
    expect(native.explicitEffort).toBe('low');
    expect(native.format).toEqual({ type: 'json_schema', schema });
  });

  it('rejects other formats and unknown output_config fields', () => {
    expect(getError(() => toClaudeNativeRequest(body({ output_config: { format: { type: 'json_object' } } }))).message).toContain('json_schema');
    expect(getError(() => toClaudeNativeRequest(body({ output_config: { task_budget: 1 } }))).message).toContain('task_budget');
  });

  it('treats thinking disabled as effort "none" and does not forward other thinking shapes', () => {
    expect(toClaudeNativeRequest(body({ thinking: { type: 'disabled' } })).native.explicitEffort).toBe('none');
    const enabled = toClaudeNativeRequest(body({ thinking: { type: 'enabled', budget_tokens: 2048 } }));
    expect(enabled.native.explicitEffort).toBeUndefined();
    expect(enabled.ignoredKeys).toEqual(['thinking']);
    expect(getError(() => toClaudeNativeRequest(body({ thinking: { type: 'disabled' }, output_config: { effort: 'high' } }))).status).toBe(400);
  });
});

describe('top-level fields', () => {
  it('drops metadata, keeps stream, and drops temperature/top_p/top_k as ignored', () => {
    const request = toClaudeNativeRequest(body({ metadata: { user_id: 'client' }, stream: true, temperature: 0.2, top_p: 0.9, top_k: 5 }));
    expect(request.isStream).toBe(true);
    expect(request.ignoredKeys).toEqual(['temperature', 'top_p', 'top_k']);
    expect(JSON.stringify(request.native)).not.toContain('client');
  });

  it.each(['stop_sequences', 'service_tier', 'container', 'mcp_servers', 'context_management', 'inference_geo', 'brand_new_field'])('rejects %s and names it', (key) => {
    const error = getError(() => toClaudeNativeRequest(body({ [key]: 'x' })));
    expect(error.status).toBe(400);
    expect(error.message).toContain(key);
  });

  it('lists every unsupported field in one message', () => {
    expect(getError(() => toClaudeNativeRequest(body({ stop_sequences: ['x'], container: 'c' }))).message).toContain('stop_sequences, container');
  });
});

describe('billing text and session seed', () => {
  it.each([
    ['string content', [{ role: 'user', content: 'weather?' }], 'weather?'],
    ['the first text block', [{ role: 'user', content: [IMAGE_BASE64, { type: 'text', text: 'second' }, { type: 'text', text: 'third' }] }], 'second'],
    ['no text block', [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x', content: 'r' }] }], ''],
  ])('takes the first user text from %s, before merging', (_name, messages, expected) => {
    expect(toClaudeNativeRequest(body({ messages })).native.firstUserText).toBe(expected);
  });

  it('seeds the session with a copy of the normalized first message', () => {
    const request = toClaudeNativeRequest(body({ messages: [{ role: 'user', content: [{ type: 'text', text: 'hi', cache_control: { type: 'ephemeral' } }] }] }));
    expect(request.firstMessage).toEqual({ role: 'user', content: [{ type: 'text', text: 'hi' }] });
    expect(request.firstMessage).not.toBe(request.native.messages[0]);
  });

  it('takes the session seed from the first raw message, before an adjacent user message merges into it', () => {
    const request = toClaudeNativeRequest(body({ messages: [{ role: 'user', content: 'hi' }, { role: 'user', content: 'more' }] }));
    expect(request.firstMessage).toEqual({ role: 'user', content: [{ type: 'text', text: 'hi' }] });
    expect(request.native.messages).toEqual([{ role: 'user', content: [{ type: 'text', text: 'hi' }, { type: 'text', text: 'more' }] }]);
  });
});
