import { createProxyError, fromFailedEvent } from '../errors.js';
import type { CollectedResponse, Json, ResponsesEvent } from '../types.js';

// Aggregates an upstream SSE stream into the final response (for stream:false callers).
export const collectResponse = async (events: AsyncIterable<ResponsesEvent>): Promise<CollectedResponse> => {
  const doneItems: Array<{ index: number; item: Json }> = [];
  for await (const event of events) {
    if (event.type === 'response.output_item.done') {
      doneItems.push({ index: Number(event.output_index ?? doneItems.length), item: event.item as Json });
    } else if (event.type === 'response.completed' || event.type === 'response.incomplete') {
      const outputItems = doneItems.sort((left, right) => left.index - right.index).map(({ item }) => item);
      const response = (event.response ?? {}) as Json;
      return { response: { ...response, output: outputItems.length > 0 ? outputItems : response.output }, outputItems };
    } else if (event.type === 'response.failed' || event.type === 'error') {
      throw fromFailedEvent(event);
    }
  }
  throw createProxyError({ status: 502, code: 'stream_incomplete', message: 'Upstream stream closed before response.completed' });
};
