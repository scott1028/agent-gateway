// Strict Claude SSE reading. Unlike the Codex passthrough (utils/sse.ts), a Claude message that
// does not parse or has no event type has to fail the response instead of being skipped, because a
// skipped event would otherwise turn a broken stream into a successful-looking answer.
import { describe, expect, it } from 'vitest';
import { parseClaudeSseStream } from '../../src/claude/sse.js';
import { toByteChunks } from '../helpers.js';

const collect = async (text: string): Promise<unknown[]> => {
  const events: unknown[] = [];
  for await (const event of parseClaudeSseStream(toByteChunks(text))) events.push(event);
  return events;
};

describe('parseClaudeSseStream', () => {
  it('reads event/data messages in order', async () => {
    expect(await collect('event: message_start\ndata: {"type":"message_start"}\n\ndata: {"type":"message_stop"}\n\n')).toEqual([
      { type: 'message_start' },
      { type: 'message_stop' },
    ]);
  });

  it('reassembles a message split across chunks', async () => {
    const chunks = [new TextEncoder().encode('data: {"type":"mes'), new TextEncoder().encode('sage_stop"}\n\n')];
    const events: unknown[] = [];
    for await (const event of parseClaudeSseStream((async function* toStream() {
      yield* chunks;
    })())) {
      events.push(event);
    }
    expect(events).toEqual([{ type: 'message_stop' }]);
  });

  it('fails on data that is not JSON instead of skipping it', async () => {
    await expect(collect('data: {not json}\n\n')).rejects.toThrow('not valid JSON');
  });

  it('fails on an event without a type', async () => {
    await expect(collect('data: {"foo":1}\n\n')).rejects.toThrow('without a `type`');
    await expect(collect('data: [1,2]\n\n')).rejects.toThrow('without a `type`');
  });

  it('ignores comments, keep-alives and a stray [DONE]', async () => {
    expect(await collect(': ping\n\nevent: ping\ndata: {"type":"ping"}\n\ndata: [DONE]\n\n')).toEqual([{ type: 'ping' }]);
  });
});
