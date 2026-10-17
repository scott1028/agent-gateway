import { describe, expect, it } from 'vitest';
import { toChatCompletion, toChatUsage } from '../../src/chat/toChatCompletion.js';

describe('toChatUsage', () => {
  it('maps usage and tolerates null details', () => {
    expect(
      toChatUsage({ input_tokens: 10, output_tokens: 5, total_tokens: 15, input_tokens_details: null, output_tokens_details: null }),
    ).toEqual({
      prompt_tokens: 10,
      completion_tokens: 5,
      total_tokens: 15,
      prompt_tokens_details: { cached_tokens: 0 },
      completion_tokens_details: { reasoning_tokens: 0 },
    });
    expect(toChatUsage(undefined)).toBeUndefined();
  });
});

describe('toChatCompletion', () => {
  it('joins message text, skips reasoning and maps tool calls', () => {
    const completion = toChatCompletion(
      {
        response: { status: 'completed', usage: { input_tokens: 3, output_tokens: 2, input_tokens_details: { cached_tokens: 1 } } },
        outputItems: [
          { type: 'reasoning', summary: [] },
          { type: 'message', content: [{ type: 'output_text', text: 'checking' }] },
          { type: 'function_call', call_id: 'call_1', name: 'f', arguments: '{}' },
        ],
      },
      { id: 'chatcmpl-1', model: 'm', created: 1 },
    );
    expect(completion).toMatchObject({
      object: 'chat.completion',
      choices: [
        {
          message: {
            role: 'assistant',
            content: 'checking',
            tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'f', arguments: '{}' } }],
          },
          finish_reason: 'tool_calls',
        },
      ],
      usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5, prompt_tokens_details: { cached_tokens: 1 } },
    });
  });

  it('returns null content when there is no text', () => {
    const completion = toChatCompletion({ response: { status: 'completed' }, outputItems: [] }, { id: 'x', model: 'm', created: 1 });
    expect(completion).toMatchObject({ choices: [{ message: { content: null }, finish_reason: 'stop' }] });
    expect(completion).not.toHaveProperty('usage');
  });

  it('joins consecutive message items with the requested separator', () => {
    const collected = {
      response: { status: 'completed' },
      outputItems: [
        { type: 'message', content: [{ type: 'output_text', text: 'Before tool.' }] },
        { type: 'function_call', call_id: 'call_1', name: 'f', arguments: '{}' },
        { type: 'message', content: [{ type: 'output_text', text: 'After tool.' }] },
      ],
    };
    const meta = { id: 'chatcmpl-1', model: 'm', created: 1 };
    // Codex default: a blank line between commentary and final answer.
    expect(toChatCompletion(collected, meta)).toMatchObject({ choices: [{ message: { content: 'Before tool.\n\nAfter tool.' } }] });
    // Claude: items join exactly like the native text blocks so the echo round-trips unchanged.
    expect(toChatCompletion(collected, meta, '')).toMatchObject({ choices: [{ message: { content: 'Before tool.After tool.' } }] });
  });
});
