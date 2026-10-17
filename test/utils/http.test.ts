// writeText backpressure: a client that goes away while the buffer is full must not leave the
// handler stuck waiting for a drain that never comes. The shared Codex path keeps its behaviour:
// only the close-during-backpressure wait and the already-closed fast fail change.
import { EventEmitter } from 'node:events';
import type { ServerResponse } from 'node:http';
import { describe, expect, it } from 'vitest';
import { writeText } from '../../src/utils/http.js';

const makeResponse = (accepts: boolean) => {
  const res = new EventEmitter();
  res.on('error', () => undefined);
  (res as EventEmitter & { write: (chunk: string) => boolean }).write = () => accepts;
  return res as unknown as ServerResponse;
};

describe('writeText', () => {
  it('returns without waiting when the buffer has room', async () => {
    await expect(writeText(makeResponse(true), 'x')).resolves.toBeUndefined();
  });

  it('waits for drain when the buffer is full', async () => {
    const res = makeResponse(false);
    const pending = writeText(res, 'x');
    res.emit('drain');
    await expect(pending).resolves.toBeUndefined();
  });

  it('rejects when the client closes while the response is backpressured', async () => {
    const res = makeResponse(false);
    const pending = writeText(res, 'x');
    res.emit('close');
    await expect(pending).rejects.toThrow('Client closed while the response was backpressured');
  });

  it('stays rejected after a close even when drain arrives later', async () => {
    const res = makeResponse(false);
    const pending = writeText(res, 'x');
    res.emit('close');
    res.emit('drain');
    await expect(pending).rejects.toThrow('Client closed while the response was backpressured');
  });

  it('fails fast when the writer is already closed, without waiting for events', async () => {
    // Handler error reporting may write again after the first close was observed; the close
    // event will not fire a second time, so a second wait would hang the handler forever.
    const destroyed = makeResponse(false) as ServerResponse & { destroyed: boolean };
    destroyed.destroyed = true;
    await expect(writeText(destroyed, 'x')).rejects.toThrow('already closed');
    const ended = makeResponse(false) as ServerResponse & { writableEnded: boolean };
    ended.writableEnded = true;
    await expect(writeText(ended, 'x')).rejects.toThrow('already closed');
  });
});
