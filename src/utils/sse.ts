import type { ResponsesEvent } from '../types.js';

export type SseMessage = { event?: string; data: string };

// Splits complete SSE messages out of `buffer` and returns the incomplete tail as `rest`.
export const splitSseEvents = (buffer: string): { messages: SseMessage[]; rest: string } => {
  const blocks = buffer.replace(/\r\n/g, '\n').split('\n\n');
  const rest = blocks.pop() ?? '';
  const messages = blocks.flatMap((block) => {
    let event: string | undefined;
    const dataLines: string[] = [];
    for (const line of block.split('\n')) {
      if (line === '' || line.startsWith(':')) continue;
      const separatorIndex = line.indexOf(':');
      const field = separatorIndex === -1 ? line : line.slice(0, separatorIndex);
      const rawFieldValue = separatorIndex === -1 ? '' : line.slice(separatorIndex + 1);
      const fieldValue = rawFieldValue.startsWith(' ') ? rawFieldValue.slice(1) : rawFieldValue;
      if (field === 'event') event = fieldValue;
      if (field === 'data') dataLines.push(fieldValue);
    }
    return dataLines.length === 0 ? [] : [{ event, data: dataLines.join('\n') }];
  });
  return { messages, rest };
};

const toResponsesEvents = (messages: SseMessage[]): ResponsesEvent[] =>
  messages.flatMap((message) => {
    if (message.data === '[DONE]') return [];
    try {
      const parsed: unknown = JSON.parse(message.data);
      return typeof parsed === 'object' && parsed !== null && 'type' in parsed ? [parsed as ResponsesEvent] : [];
    } catch {
      return [];
    }
  });

// Yields each raw chunk untouched with the events it completes; the final flush has an empty chunk.
export async function* readSseChunks(body: AsyncIterable<Uint8Array>): AsyncGenerator<{ chunk: Uint8Array; events: ResponsesEvent[] }> {
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of body) {
    const { messages, rest } = splitSseEvents(buffer + decoder.decode(chunk, { stream: true }));
    buffer = rest;
    yield { chunk, events: toResponsesEvents(messages) };
  }
  const { messages } = splitSseEvents(`${buffer}${decoder.decode()}\n\n`);
  const events = toResponsesEvents(messages);
  if (events.length > 0) yield { chunk: new Uint8Array(0), events };
}

export async function* parseSseStream(body: AsyncIterable<Uint8Array>): AsyncGenerator<ResponsesEvent> {
  for await (const { events } of readSseChunks(body)) yield* events;
}

export const formatSseData = (data: unknown): string => `data: ${JSON.stringify(data)}\n\n`;

// Responses SSE carries the event name as well as the payload.
export const formatSseEvent = (event: { type: string }): string => `event: ${event.type}\n${formatSseData(event)}`;
