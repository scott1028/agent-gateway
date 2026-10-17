import { describe, expect, it } from 'vitest';
import { collectResponse } from '../../src/responses/collectResponse.js';
import type { ResponsesEvent } from '../../src/types.js';
import { parseSseStream } from '../../src/utils/sse.js';
import { readFixture, toByteChunks } from '../helpers.js';

async function* toEvents(events: ResponsesEvent[]): AsyncGenerator<ResponsesEvent> {
  yield* events;
}

describe('collectResponse', () => {
  it('collects output items from a tool-call fixture', async () => {
    const { response, outputItems } = await collectResponse(parseSseStream(toByteChunks(readFixture('tool-call-lite.sse'))));
    expect(response.status).toBe('completed');
    expect(outputItems.map((item) => item.type)).toEqual(['function_call']);
    expect(response.output).toEqual(outputItems);
  });

  it('orders items by output_index', async () => {
    const { outputItems } = await collectResponse(
      toEvents([
        { type: 'response.output_item.done', output_index: 1, item: { id: 'b' } },
        { type: 'response.output_item.done', output_index: 0, item: { id: 'a' } },
        { type: 'response.completed', response: { status: 'completed' } },
      ]),
    );
    expect(outputItems.map((item) => item.id)).toEqual(['a', 'b']);
  });

  it('throws mapped errors for failed events and truncated streams', async () => {
    await expect(
      collectResponse(toEvents([{ type: 'response.failed', response: { error: { code: 'context_length_exceeded', message: 'too long' } } }])),
    ).rejects.toMatchObject({ status: 400, code: 'context_length_exceeded' });
    await expect(collectResponse(toEvents([{ type: 'response.created' }]))).rejects.toMatchObject({ code: 'stream_incomplete' });
  });
});
