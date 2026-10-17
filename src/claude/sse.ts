// Strict SSE reader for the Claude upstream. utils/sse.ts skips unparsable messages, which is fine
// for the Codex passthrough but would turn a broken Claude stream into a successful-looking
// response, so every message here has to parse and carry an event type.
import { createProxyError } from '../errors.js';
import { splitSseEvents } from '../utils/sse.js';
import type { SseMessage } from '../utils/sse.js';
import type { ResponsesEvent } from '../types.js';

const toEvent = (message: SseMessage): ResponsesEvent[] => {
  if (message.data === '[DONE]') return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(message.data);
  } catch {
    throw createProxyError({ status: 502, code: 'bad_upstream', message: 'Claude stream sent SSE data that is not valid JSON' });
  }
  if (typeof parsed !== 'object' || parsed === null || typeof (parsed as ResponsesEvent).type !== 'string') {
    throw createProxyError({ status: 502, code: 'bad_upstream', message: 'Claude stream sent an SSE event without a `type`' });
  }
  return [parsed as ResponsesEvent];
};

export async function* parseClaudeSseStream(body: AsyncIterable<Uint8Array>): AsyncGenerator<ResponsesEvent> {
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of body) {
    const { messages, rest } = splitSseEvents(buffer + decoder.decode(chunk, { stream: true }));
    buffer = rest;
    yield* messages.flatMap(toEvent);
  }
  const { messages } = splitSseEvents(`${buffer}${decoder.decode()}\n\n`);
  yield* messages.flatMap(toEvent);
}
