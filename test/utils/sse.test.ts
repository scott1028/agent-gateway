import { describe, expect, it } from 'vitest';
import { formatSseData, parseSseStream, splitSseEvents } from '../../src/utils/sse.js';
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

describe('formatSseData', () => {
  it('formats one data line', () => {
    expect(formatSseData({ a: 1 })).toBe('data: {"a":1}\n\n');
  });
});
