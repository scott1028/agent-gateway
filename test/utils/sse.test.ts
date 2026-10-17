import { describe, expect, it } from 'vitest';
import { formatSseData, parseSseStream, readSseChunks, splitSseEvents } from '../../src/utils/sse.js';
import { readFixture, toByteChunks } from '../helpers.js';

describe('splitSseEvents', () => {
  it('returns complete messages and keeps the incomplete tail', () => {
    const { messages, rest } = splitSseEvents('event: a\ndata: {"x":1}\n\ndata: {"y"');
    expect(messages).toEqual([{ event: 'a', data: '{"x":1}' }]);
    expect(rest).toBe('data: {"y"');
  });

  it('handles CRLF, multi-line data and comments', () => {
    const { messages } = splitSseEvents(': keepalive\r\n\r\ndata: line1\r\ndata: line2\r\n\r\n');
    expect(messages).toEqual([{ event: undefined, data: 'line1\nline2' }]);
  });
});

describe('parseSseStream', () => {
  it('parses a fixture split into small chunks', async () => {
    const types: string[] = [];
    for await (const event of parseSseStream(toByteChunks(readFixture('text-lite.sse')))) types.push(event.type);
    expect(types[0]).toBe('response.created');
    expect(types.at(-1)).toBe('response.completed');
    expect(types).toContain('response.output_text.delta');
  });

  it('flushes a final message without trailing blank line and skips [DONE]', async () => {
    const types: string[] = [];
    const text = 'data: [DONE]\n\ndata: {"type":"response.completed"}';
    for await (const event of parseSseStream(toByteChunks(text, 5))) types.push(event.type);
    expect(types).toEqual(['response.completed']);
  });
});

describe('readSseChunks', () => {
  it('passes every chunk through byte for byte and attaches each event to the chunk that ends it', async () => {
    const text = readFixture('text-nonlite.sse');
    const chunks: Uint8Array[] = [];
    const completedAt: number[] = [];
    const types: string[] = [];
    for await (const { chunk, events } of readSseChunks(toByteChunks(text))) {
      chunks.push(chunk);
      for (const event of events) {
        types.push(event.type);
        if (event.type === 'response.completed') completedAt.push(chunks.length - 1);
      }
    }
    expect(Buffer.concat(chunks).toString('utf8')).toBe(text);
    expect(chunks.every((chunk) => chunk.length > 0)).toBe(true);
    const parsed: string[] = [];
    for await (const event of parseSseStream(toByteChunks(text))) parsed.push(event.type);
    expect(types).toEqual(parsed);
    // The terminal event is only complete once its trailing blank line arrives in the last chunk.
    expect(completedAt).toEqual([chunks.length - 1]);
  });

  it('flushes a final event without trailing blank line under an empty chunk', async () => {
    const results: Array<{ size: number; types: string[] }> = [];
    for await (const { chunk, events } of readSseChunks(toByteChunks('data: {"type":"a"}\n\ndata: {"type":"b"}', 7))) {
      results.push({ size: chunk.length, types: events.map((event) => event.type) });
    }
    expect(results.flatMap(({ types }) => types)).toEqual(['a', 'b']);
    expect(results.at(-1)).toEqual({ size: 0, types: ['b'] });
  });
});

describe('formatSseData', () => {
  it('formats one data line', () => {
    expect(formatSseData({ a: 1 })).toBe('data: {"a":1}\n\n');
  });
});
