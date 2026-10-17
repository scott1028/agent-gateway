import { describe, expect, it } from 'vitest';
import { toResponsesRequest } from '../../src/chat/toResponsesRequest.js';

describe('toResponsesRequest', () => {
  it('converts every message role', () => {
    const { request } = toResponsesRequest({
      model: 'm',
      messages: [
        { role: 'system', content: 'rules' },
        { role: 'user', content: [{ type: 'text', text: 'look' }, { type: 'image_url', image_url: { url: 'data:x', detail: 'low' } }] },
        {
          role: 'assistant',
          content: 'checking',
          tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Paris"}' } }],
        },
        { role: 'tool', tool_call_id: 'call_1', content: [{ type: 'text', text: 'sunny' }] },
        { role: 'assistant', content: null },
      ],
    });
    expect(request.input).toEqual([
      { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'rules' }] },
      {
        type: 'message',
        role: 'user',
        content: [
          { type: 'input_text', text: 'look' },
          { type: 'input_image', image_url: 'data:x', detail: 'low' },
        ],
      },
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'checking' }] },
      { type: 'function_call', call_id: 'call_1', name: 'get_weather', arguments: '{"city":"Paris"}' },
      { type: 'function_call_output', call_id: 'call_1', output: 'sunny' },
    ]);
  });

  it('converts tools, tool_choice, effort, response_format and token limit', () => {
    const { request, ignoredKeys } = toResponsesRequest({
      model: 'm',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [{ type: 'function', function: { name: 'f', parameters: { type: 'object' } } }],
      tool_choice: { type: 'function', function: { name: 'f' } },
      parallel_tool_calls: true,
      reasoning_effort: 'high',
      response_format: { type: 'json_schema', json_schema: { name: 's', schema: { type: 'object' }, strict: true } },
      verbosity: 'low',
      max_tokens: 50,
      max_completion_tokens: 80,
      temperature: 0.3,
      stream: true,
    });
    expect(request).toMatchObject({
      tools: [{ type: 'function', name: 'f', description: '', strict: false, parameters: { type: 'object' } }],
      tool_choice: { type: 'function', name: 'f' },
      parallel_tool_calls: true,
      reasoning: { effort: 'high' },
      text: { format: { type: 'json_schema', name: 's', schema: { type: 'object' }, strict: true }, verbosity: 'low' },
      max_output_tokens: 80,
    });
    expect(ignoredKeys).toEqual(['temperature']);
  });

  it('maps json_object and drops text response_format', () => {
    const base = { model: 'm', messages: [{ role: 'user', content: 'hi' }] };
    expect(toResponsesRequest({ ...base, response_format: { type: 'json_object' } }).request.text).toEqual({
      format: { type: 'json_object' },
    });
    expect(toResponsesRequest({ ...base, response_format: { type: 'text' } }).request).not.toHaveProperty('text');
  });

  it('rejects unsupported input', () => {
    const base = { model: 'm', messages: [{ role: 'user', content: 'hi' }] };
    expect(() => toResponsesRequest({ ...base, n: 2 })).toThrow(/n/);
    expect(() => toResponsesRequest({ model: 'm', messages: [] })).toThrow(/messages/);
    expect(() => toResponsesRequest({ ...base, messages: [{ role: 'function', content: 'x' }] })).toThrow(/role/);
    expect(() =>
      toResponsesRequest({ ...base, messages: [{ role: 'user', content: [{ type: 'input_audio' }] }] }),
    ).toThrow(/input_audio/);
    expect(() => toResponsesRequest({ ...base, tools: [{ type: 'web_search' }] })).toThrow(/function/);
  });
});
