import { readFileSync } from 'node:fs';
import path from 'node:path';

export const readFixture = (name: string): string =>
  readFileSync(path.join(import.meta.dirname, 'fixtures', name), 'utf8');

// Re-chunks text at a fixed size to exercise SSE boundary handling.
export async function* toByteChunks(text: string, chunkSize = 37): AsyncGenerator<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    yield bytes.slice(offset, offset + chunkSize);
  }
}

export const toJwt = (payload: Record<string, unknown>): string =>
  ['e30', Buffer.from(JSON.stringify(payload)).toString('base64url'), 'sig'].join('.');
