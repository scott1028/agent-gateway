// Native SSE -> one Messages response for stream:false downgrade clients. Accumulation follows the
// official SDK accumulator in native 2.1.302 (binary offset 238304387: text and input_json append,
// signature_delta replaces, usage counters from message_delta win); the order checks match
// src/claude/toResponsesEvents.ts. Streams come from test/fixtures/claude-*.sse.
import { describe, expect, it } from 'vitest';
import { collectClaudeMessage } from '../../src/claude/collectMessage.js';
import { parseClaudeSseStream } from '../../src/claude/sse.js';
import type { Json } from '../../src/types.js';
import { readFixture } from '../helpers.js';

const collect = (sse: string): Promise<Json> =>
  collectClaudeMessage(parseClaudeSseStream((async function* () {
    yield Buffer.from(sse);
  })()));

const toSse = (...events: Json[]): string => events.map((event) => `event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`).join('');

const MESSAGE_START = { type: 'message_start', message: { id: 'msg_test', type: 'message', role: 'assistant', model: 'claude-opus-5', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 5, output_tokens: 1 } } };
const MESSAGE_DELTA = { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 9 } };
const MESSAGE_STOP = { type: 'message_stop' };

const getRejection = async (promise: Promise<unknown>): Promise<Error & { status: number; type: string; code?: string }> => {
  try {
    await promise;
  } catch (error) {
    return error as Error & { status: number; type: string; code?: string };
  }
  throw new Error('expected the stream to be rejected');
};

describe('collectClaudeMessage', () => {
  it('collects text and merges usage', async () => {
    expect(await collect(readFixture('claude-text.sse'))).toEqual({
      id: 'msg_01C6B1F0A2',
      type: 'message',
      role: 'assistant',
      model: 'claude-sonnet-5',
      content: [{ type: 'text', text: 'Hello there.' }],
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: 12, cache_creation_input_tokens: 300, cache_read_input_tokens: 1200, output_tokens: 17 },
    });
  });

  it('collects thinking with its signature and the tool input, in block order', async () => {
    const message = await collect(readFixture('claude-tool-call.sse'));
    expect(message.content).toEqual([
      { type: 'thinking', thinking: 'I should call the weather tool.', signature: 'Eq4KCmUIhAIKEGN2eA5xkQ2SgBACQo1K7' },
      { type: 'tool_use', id: 'toolu_01XYZ7Qm', name: 'get_weather', input: { city: 'Paris' } },
    ]);
    expect(message.stop_reason).toBe('tool_use');
    expect(message.usage).toEqual({ input_tokens: 40, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 58, thinking_tokens: 21 });
  });

  it('keeps start values: text and thinking carried by content_block_start', async () => {
    const message = await collect(readFixture('claude-text-tool.sse'));
    expect((message.content as Json[]).map((block) => block.type)).toEqual(['thinking', 'text', 'tool_use', 'text']);
    expect((message.content as Json[])[0]).toEqual({ type: 'thinking', thinking: 'private test thought', signature: 'fake-test-signature' });
  });

  it('replaces the signature with the latest signature_delta, as the official accumulator does', async () => {
    const message = await collect(toSse(
      MESSAGE_START,
      { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: 'start-sig' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'a' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'first-sig' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'second-sig' } },
      { type: 'content_block_stop', index: 0 },
      MESSAGE_DELTA,
      MESSAGE_STOP,
    ));
    expect(message.content).toEqual([{ type: 'thinking', thinking: 'a', signature: 'second-sig' }]);
    expect(message.usage).toEqual({ input_tokens: 5, output_tokens: 9 });
  });

  it('keeps redacted thinking as sent', async () => {
    const message = await collect(readFixture('claude-redacted-thinking.sse'));
    expect((message.content as Json[]).find((block) => block.type === 'redacted_thinking')).toHaveProperty('data');
  });

  it('reports an upstream error event with its Anthropic error type', async () => {
    expect(await getRejection(collect(readFixture('claude-error.sse')))).toMatchObject({ status: 502, type: 'overloaded_error', message: 'Overloaded' });
  });

  it.each([
    ['message_stop with an open block and no message_delta', readFixture('claude-broken-tail.sse'), 'bad_upstream'],
    ['a stream cut before message_stop', toSse(MESSAGE_START, MESSAGE_DELTA), 'stream_incomplete'],
    ['a block opened out of order', toSse(MESSAGE_START, { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } }), 'bad_upstream'],
    ['a delta for the wrong block type', toSse(MESSAGE_START, { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }, { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{}' } }), 'bad_upstream'],
    ['invalid tool input', toSse(MESSAGE_START, { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 't1', name: 'n', input: {} } }, { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"a":' } }, { type: 'content_block_stop', index: 0 }), 'bad_upstream'],
    ['an unknown stop_reason', toSse(MESSAGE_START, { ...MESSAGE_DELTA, delta: { stop_reason: 'bogus' } }), 'bad_upstream'],
    ['an event after message_stop', toSse(MESSAGE_START, MESSAGE_DELTA, MESSAGE_STOP, { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }), 'bad_upstream'],
  ])('fails on %s', async (_name, sse, code) => {
    expect(await getRejection(collect(sse))).toMatchObject({ status: 502, code });
  });
});
