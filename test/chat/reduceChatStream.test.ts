import { describe, expect, it } from 'vitest';
import { type ChatStreamPayload, createChatStreamState, reduceChatStream } from '../../src/chat/reduceChatStream.js';
import type { ResponsesEvent } from '../../src/types.js';
import { parseSseStream } from '../../src/utils/sse.js';
import { readFixture, toByteChunks } from '../helpers.js';

const META = { id: 'chatcmpl-1', model: 'm', created: 1 };

const runEvents = (events: ResponsesEvent[], isUsageIncluded = false) => {
  let state = createChatStreamState({ ...META, isUsageIncluded });
  const payloads: ChatStreamPayload[] = [];
  for (const event of events) {
    const step = reduceChatStream(state, event);
    state = step.state;
    payloads.push(...step.payloads);
  }
  return { state, payloads };
};

const readEvents = async (fixture: string): Promise<ResponsesEvent[]> => {
  const events: ResponsesEvent[] = [];
  for await (const event of parseSseStream(toByteChunks(readFixture(fixture)))) events.push(event);
  return events;
};

const getDeltas = (payloads: ChatStreamPayload[]) =>
  payloads.flatMap((payload) =>
    typeof payload === 'object' && 'choices' in payload ? (payload.choices as Array<{ delta: unknown; finish_reason: unknown }>) : [],
  );

describe('reduceChatStream', () => {
  it('streams text from a fixture and finishes with stop + usage + [DONE]', async () => {
    const { state, payloads } = runEvents(await readEvents('roundtrip-lite.sse'), true);
    const deltas = getDeltas(payloads);
    expect(deltas[0]?.delta).toEqual({ role: 'assistant', content: '' });
    const text = deltas.map((choice) => (choice.delta as { content?: string }).content ?? '').join('');
    expect(text).toContain('Paris');
    expect(deltas.at(-1)?.finish_reason).toBe('stop');
    expect(payloads.at(-2)).toMatchObject({ choices: [], usage: { prompt_tokens: expect.any(Number) } });
    expect(payloads.at(-1)).toBe('[DONE]');
    expect(state.isDone).toBe(true);
  });

  it('emits a whole tool call at output_item.done and finishes with tool_calls', async () => {
    const { payloads } = runEvents(await readEvents('tool-call-lite.sse'));
    const deltas = getDeltas(payloads);
    const toolDelta = deltas.find((choice) => (choice.delta as { tool_calls?: unknown }).tool_calls);
    expect((toolDelta?.delta as { tool_calls: unknown[] }).tool_calls).toEqual([
      { index: 0, id: expect.stringMatching(/^call_/), type: 'function', function: { name: 'get_weather', arguments: '{"city":"Paris"}' } },
    ]);
    expect(deltas.at(-1)?.finish_reason).toBe('tool_calls');
  });

  it('separates message items and falls back to item text without deltas', () => {
    const { payloads } = runEvents([
      { type: 'response.output_text.delta', item_id: 'a', delta: 'first' },
      { type: 'response.output_item.done', item: { type: 'message', id: 'a', content: [{ type: 'output_text', text: 'first' }] } },
      { type: 'response.output_item.done', item: { type: 'message', id: 'b', content: [{ type: 'output_text', text: 'second' }] } },
    ]);
    expect(getDeltas(payloads).map((choice) => choice.delta)).toEqual([{ content: 'first' }, { content: '\n\nsecond' }]);
  });

  it('joins message items without a separator when the state asks for it (Claude echo round trip)', () => {
    let state = createChatStreamState({ ...META, isUsageIncluded: false, textSeparator: '' });
    const payloads: ChatStreamPayload[] = [];
    for (const event of [
      { type: 'response.output_text.delta', item_id: 'a', delta: 'Before tool.' },
      { type: 'response.output_item.done', item: { type: 'message', id: 'a', content: [{ type: 'output_text', text: 'Before tool.' }] } },
      { type: 'response.output_text.delta', item_id: 'b', delta: 'After tool.' },
      { type: 'response.output_item.done', item: { type: 'message', id: 'b', content: [{ type: 'output_text', text: 'After tool.' }] } },
    ] as ResponsesEvent[]) {
      const step = reduceChatStream(state, event);
      state = step.state;
      payloads.push(...step.payloads);
    }
    expect(getDeltas(payloads).map((choice) => choice.delta)).toEqual([{ content: 'Before tool.' }, { content: 'After tool.' }]);
  });

  it('maps incomplete max_output_tokens to length', () => {
    const { payloads } = runEvents([
      { type: 'response.incomplete', response: { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } } },
    ]);
    expect(getDeltas(payloads).at(-1)?.finish_reason).toBe('length');
  });

  it('emits an error payload without [DONE] on failure', () => {
    const { state, payloads } = runEvents([
      { type: 'response.failed', response: { error: { code: 'server_is_overloaded', message: 'busy' } } },
    ]);
    expect(payloads).toEqual([{ error: { message: 'busy', type: 'api_error', param: null, code: 'server_is_overloaded' } }]);
    expect(state.isDone).toBe(true);
  });
});
