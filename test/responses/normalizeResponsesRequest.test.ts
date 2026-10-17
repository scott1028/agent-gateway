import { describe, expect, it } from 'vitest';
import { applyResponsesLite, getSessionId, normalizeResponsesRequest } from '../../src/responses/normalizeResponsesRequest.js';
import type { CodexModel, ResponsesRequest } from '../../src/types.js';

const LITE_MODEL: CodexModel = { slug: 'lite', use_responses_lite: true, default_reasoning_level: 'medium' };
const FUNCTION_TOOL = { type: 'function', name: 'get_weather', description: '', strict: false, parameters: {} };

describe('normalizeResponsesRequest', () => {
  it('forces stream/store/include and strips unsupported fields', () => {
    const { request, strippedKeys } = normalizeResponsesRequest({
      model: 'm',
      input: 'hi',
      stream: false,
      store: true,
      temperature: 0.2,
      metadata: { a: 1 },
      max_output_tokens: 100,
    });
    expect(request).toMatchObject({ model: 'm', stream: true, store: false, max_output_tokens: 100 });
    expect(request.include).toEqual(['reasoning.encrypted_content']);
    expect(request.input).toEqual([{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] }]);
    expect(request).not.toHaveProperty('temperature');
    expect(strippedKeys).toEqual(['temperature', 'metadata']);
  });

  it('rewrites system messages to developer and maps ultra effort to max', () => {
    const { request } = normalizeResponsesRequest({
      model: 'm',
      input: [{ type: 'message', role: 'system', content: [{ type: 'input_text', text: 'rules' }] }],
      reasoning: { effort: 'ultra' },
    });
    expect(request.input[0]?.role).toBe('developer');
    expect(request.reasoning).toEqual({ effort: 'max' });
  });

  it('never forwards previous_response_id and rejects a missing model', () => {
    // handleResponses expands previous_response_id before this point; a leftover key is dropped.
    const { request, strippedKeys } = normalizeResponsesRequest({ model: 'm', input: 'hi', previous_response_id: 'r' });
    expect(request).not.toHaveProperty('previous_response_id');
    expect(strippedKeys).toEqual(['previous_response_id']);
    expect(() => normalizeResponsesRequest({ input: 'hi' })).toThrow(/model/);
  });

  it('derives a stable session id unless prompt_cache_key is given', () => {
    const body = { model: 'm', input: [{ role: 'developer', content: 'rules' }, { role: 'user', content: 'q1' }] };
    const first = normalizeResponsesRequest(body);
    const nextTurn = normalizeResponsesRequest({ ...body, input: [...body.input, { role: 'assistant', content: 'a' }] });
    expect(first.sessionId).toBe(nextTurn.sessionId);
    expect(first.sessionId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(first.request.prompt_cache_key).toBe(first.sessionId);
    expect(normalizeResponsesRequest({ ...body, prompt_cache_key: 'key-1' }).sessionId).toBe('key-1');
    expect(getSessionId('a')).not.toBe(getSessionId('b'));
  });

  it('applies the catalog default effort and Responses Lite shaping', () => {
    const { request, isResponsesLite } = normalizeResponsesRequest(
      { model: 'lite', input: 'hi', tools: [FUNCTION_TOOL, { type: 'web_search' }], parallel_tool_calls: true },
      LITE_MODEL,
    );
    expect(isResponsesLite).toBe(true);
    expect(request).not.toHaveProperty('tools');
    expect(request.parallel_tool_calls).toBe(false);
    expect(request.reasoning).toEqual({ effort: 'medium', context: 'all_turns' });
    expect(request.input[0]).toEqual({
      type: 'additional_tools',
      role: 'developer',
      tools: [{ type: 'namespace', name: 'functions', description: '', tools: [FUNCTION_TOOL] }, { type: 'web_search' }],
    });
  });
});

describe('applyResponsesLite', () => {
  const baseRequest: ResponsesRequest = { model: 'lite', input: [], stream: true, store: false };

  it('keeps an existing additional_tools item and adds reasoning context', () => {
    const existing = { type: 'additional_tools', role: 'developer', tools: [] };
    const request = applyResponsesLite({ ...baseRequest, input: [existing] });
    expect(request.input).toEqual([existing]);
    expect(request.reasoning).toEqual({ context: 'all_turns' });
  });

  it('merges a client functions namespace into the generated one', () => {
    const request = applyResponsesLite({
      ...baseRequest,
      tools: [{ type: 'namespace', name: 'functions', tools: [FUNCTION_TOOL] }, { type: 'custom', name: 'patch' }],
    });
    const liteItem = request.input[0] as { tools: Array<{ tools: unknown[] }> };
    expect(liteItem.tools[0]?.tools).toEqual([FUNCTION_TOOL, { type: 'custom', name: 'patch' }]);
  });

  it('rejects tools sent both top-level and as additional_tools', () => {
    expect(() =>
      applyResponsesLite({ ...baseRequest, input: [{ type: 'additional_tools' }], tools: [FUNCTION_TOOL] }),
    ).toThrow(/not both/);
  });
});
