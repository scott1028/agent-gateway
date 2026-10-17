// Project-owned previous_response_id store: no upstream counterpart. Compared against
// references/codex @0d58012ec2 codex-rs/core/src/client.rs (HTTP sends store:false + full input)
// and references/CLIProxyAPI @5fc580b1 internal/clienterror/client_error.go (error code).
import { describe, expect, it } from 'vitest';
import { RESPONSE_STORE_MAX_ENTRIES } from '../../src/constants.js';
import type { ProxyError } from '../../src/errors.js';
import {
  assertSameLogin,
  createResponseRecorder,
  createResponseStore,
  expandPreviousResponse,
  observeEvents,
  type StoredResponse,
} from '../../src/responses/responseStore.js';
import type { Json, ResponsesEvent } from '../../src/types.js';

const userMessage = (text: string): Json => ({ type: 'message', role: 'user', content: [{ type: 'input_text', text }] });
const assistantMessage = (text: string): Json => ({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] });
const CODEX1 = { alias: 'codex1', accountIdentity: 'acct-A' };
const record = (id: string, owner = CODEX1): StoredResponse => ({ id, ...owner, input: [userMessage(`${id} in`)], output: [assistantMessage(`${id} out`)] });

const getError = (run: () => unknown): ProxyError => {
  try {
    run();
  } catch (error) {
    return error as ProxyError;
  }
  throw new Error('expected an error');
};

async function* toEvents(events: ResponsesEvent[]): AsyncGenerator<ResponsesEvent> {
  yield* events;
}

describe('createResponseStore', () => {
  it('caps the gateway memory at 1000 responses by default', () => {
    expect(RESPONSE_STORE_MAX_ENTRIES).toBe(1000);
    const store = createResponseStore();
    for (let index = 0; index <= RESPONSE_STORE_MAX_ENTRIES; index += 1) store.save(record(`resp_${index}`));
    expect(store.get('resp_0')).toBeUndefined();
    expect(store.get('resp_1')).toBeDefined();
    expect(store.get(`resp_${RESPONSE_STORE_MAX_ENTRIES}`)).toBeDefined();
  });

  it('evicts the least recently used record, counting reads as use', () => {
    const store = createResponseStore(2);
    store.save(record('a'));
    store.save(record('b'));
    expect(store.get('a')?.id).toBe('a');
    store.save(record('c'));
    expect(store.get('b')).toBeUndefined();
    expect(store.get('a')?.id).toBe('a');
    expect(store.get('c')?.id).toBe('c');
  });

  it('replaces a record saved again under the same id', () => {
    const store = createResponseStore(2);
    store.save(record('a'));
    store.save({ ...record('a'), output: [] });
    store.save(record('b'));
    expect(store.get('a')?.output).toEqual([]);
    expect(store.get('b')).toBeDefined();
  });
});

describe('expandPreviousResponse', () => {
  it('passes a body without the id through, only dropping a null key', () => {
    const store = createResponseStore();
    const body = { model: 'm', input: 'hi', previous_response_id: null };
    expect(expandPreviousResponse(store, body, 'codex1')).toEqual({ body: { model: 'm', input: 'hi' }, inputItems: [userMessage('hi')], previous: undefined });
    const arrayInput = [userMessage('x')];
    const expanded = expandPreviousResponse(store, { model: 'm', input: arrayInput }, 'codex1');
    expect(expanded.body).toEqual({ model: 'm', input: arrayInput });
    expect(expanded.inputItems).toBe(arrayInput);
  });

  it('expands the stored input and output before the new input', () => {
    const store = createResponseStore();
    const saved = record('resp_1');
    store.save(saved);
    const { body, inputItems, previous } = expandPreviousResponse(store, { model: 'm', previous_response_id: 'resp_1', input: 'next', instructions: 'i' }, 'codex1');
    expect(previous).toBe(saved);
    expect(inputItems).toEqual([userMessage('resp_1 in'), assistantMessage('resp_1 out'), userMessage('next')]);
    expect(body).toEqual({ model: 'm', input: inputItems, instructions: 'i' });
    expect('previous_response_id' in body).toBe(false);
  });

  it('keeps array input items as they are and allows no new input', () => {
    const store = createResponseStore();
    store.save(record('resp_1'));
    const toolOutput = { type: 'function_call_output', call_id: 'c1', output: 'sunny' };
    expect(expandPreviousResponse(store, { previous_response_id: 'resp_1', input: [toolOutput] }, 'codex1').inputItems.at(-1)).toBe(toolOutput);
    expect(expandPreviousResponse(store, { previous_response_id: 'resp_1' }, 'codex1').inputItems).toHaveLength(2);
  });

  it('rejects unknown, non-string and other-account ids with 400', () => {
    const store = createResponseStore();
    store.save(record('resp_1'));
    const missing = getError(() => expandPreviousResponse(store, { previous_response_id: 'resp_404' }, 'codex1'));
    expect(missing).toMatchObject({ status: 400, code: 'previous_response_not_found', message: "Previous response with id 'resp_404' not found." });
    expect(getError(() => expandPreviousResponse(store, { previous_response_id: 1 }, 'codex1')).status).toBe(400);
    expect(getError(() => expandPreviousResponse(store, { previous_response_id: 'resp_1', input: 5 }, 'codex1')).status).toBe(400);
    const otherAccount = getError(() => expandPreviousResponse(store, { previous_response_id: 'resp_1' }, 'claude1'));
    expect(otherAccount.status).toBe(400);
    expect(otherAccount.message).toContain('another account');
  });

});

describe('assertSameLogin', () => {
  it('rejects a record saved under another login of the same alias with 400', () => {
    const previous = record('resp_1');
    for (const accountIdentity of ['acct-B', undefined]) {
      const relogin = getError(() => assertSameLogin(previous, accountIdentity));
      expect(relogin).toMatchObject({ status: 400, message: "Previous response with id 'resp_1' was created under another login; start a new conversation." });
    }
    expect(() => assertSameLogin(previous, 'acct-A')).not.toThrow();
    expect(() => assertSameLogin({ ...previous, accountIdentity: undefined }, undefined)).not.toThrow();
    expect(() => assertSameLogin(undefined, 'acct-B')).not.toThrow();
  });
});

describe('createResponseRecorder', () => {
  it('saves done items ordered by output_index on response.completed', () => {
    const saved: Array<[string, Json[]]> = [];
    const observe = createResponseRecorder((id, output) => saved.push([id, output]));
    observe({ type: 'response.output_item.done', output_index: 1, item: { id: 'b' } });
    observe({ type: 'response.output_item.done', output_index: 0, item: { id: 'a' } });
    expect(saved).toEqual([]);
    observe({ type: 'response.completed', response: { id: 'resp_1', output: [] } });
    expect(saved).toEqual([['resp_1', [{ id: 'a' }, { id: 'b' }]]]);
  });

  it('falls back to response.output and also saves incomplete responses', () => {
    const saved: Array<[string, Json[]]> = [];
    createResponseRecorder((id, output) => saved.push([id, output]))({ type: 'response.incomplete', response: { id: 'resp_2', output: [{ id: 'x' }] } });
    expect(saved).toEqual([['resp_2', [{ id: 'x' }]]]);
  });

  it('never saves failed or errored responses', () => {
    const saved: string[] = [];
    const observe = createResponseRecorder((id) => saved.push(id));
    observe({ type: 'response.output_item.done', output_index: 0, item: { id: 'a' } });
    observe({ type: 'response.failed', response: { id: 'resp_3', status: 'failed' } });
    observe({ type: 'error', error: { message: 'boom' } });
    expect(saved).toEqual([]);
  });
});

describe('observeEvents', () => {
  it('observes each event before yielding it, and passes events through without an observer', async () => {
    const order: string[] = [];
    const events: ResponsesEvent[] = [{ type: 'a' }, { type: 'b' }];
    for await (const event of observeEvents(toEvents(events), (observed) => order.push(`observe ${observed.type}`))) order.push(`yield ${event.type}`);
    expect(order).toEqual(['observe a', 'yield a', 'observe b', 'yield b']);
    const passed: ResponsesEvent[] = [];
    for await (const event of observeEvents(toEvents(events))) passed.push(event);
    expect(passed).toEqual(events);
  });
});
