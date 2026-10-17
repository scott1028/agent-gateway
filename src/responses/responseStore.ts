// Project-owned `previous_response_id` support: there is no upstream counterpart. The pinned
// Codex HTTP path (references/codex/codex-rs/core/src/client.rs) always sends store:false with the
// full input, and Claude Messages keeps no server-side conversation. So the gateway keeps finished
// responses in memory and expands the id into the full input before any provider path runs; the
// upstream request is the same one a full-history client would send.
import { RESPONSE_STORE_MAX_ENTRIES } from '../constants.js';
import { createProxyError } from '../errors.js';
import type { Json, ResponsesEvent } from '../types.js';

// Items are shared references and treated as immutable; a record holds the whole expanded input,
// so evicting an ancestor never breaks a descendant. accountIdentity is the real login behind the
// alias, so a relogin under the same alias cannot continue the previous login's history.
export type StoredResponse = { id: string; alias: string; accountIdentity: string | undefined; input: Json[]; output: Json[] };

export type ResponseStore = {
  get: (id: string) => StoredResponse | undefined;
  save: (record: StoredResponse) => void;
};

// In-memory LRU: Map keeps insertion order, so re-inserting on access keeps the oldest first.
export const createResponseStore = (maxEntries = RESPONSE_STORE_MAX_ENTRIES): ResponseStore => {
  const records = new Map<string, StoredResponse>();
  return {
    get: (id) => {
      const record = records.get(id);
      if (record !== undefined) {
        records.delete(id);
        records.set(id, record);
      }
      return record;
    },
    save: (record) => {
      records.delete(record.id);
      records.set(record.id, record);
      for (const id of records.keys()) {
        if (records.size <= maxEntries) break;
        records.delete(id);
      }
    },
  };
};

// Same user message shape as the Codex and Claude input normalizers give a bare string.
const toInputArray = (input: unknown): Json[] => {
  if (typeof input === 'string') return [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: input }] }];
  return Array.isArray(input) ? (input as Json[]) : [];
};

// Checks the alias only; the login is checked with assertSameLogin when the identity is known.
export const expandPreviousResponse = (
  store: ResponseStore,
  body: Json,
  alias: string,
): { body: Json; inputItems: Json[]; previous: StoredResponse | undefined } => {
  const { previous_response_id: previousResponseId, ...rest } = body;
  if (previousResponseId === undefined || previousResponseId === null) return { body: rest, inputItems: toInputArray(rest.input), previous: undefined };
  if (typeof previousResponseId !== 'string') throw createProxyError({ status: 400, message: '`previous_response_id` must be a string' });
  if (rest.input !== undefined && rest.input !== null && typeof rest.input !== 'string' && !Array.isArray(rest.input)) {
    throw createProxyError({ status: 400, message: '`input` must be a string or an array' });
  }
  const record = store.get(previousResponseId);
  // Code mirrors references/CLIProxyAPI internal/clienterror/client_error.go.
  if (record === undefined) {
    throw createProxyError({ status: 400, code: 'previous_response_not_found', message: `Previous response with id '${previousResponseId}' not found.` });
  }
  if (record.alias !== alias) {
    throw createProxyError({ status: 400, message: `Previous response with id '${previousResponseId}' belongs to another account; use a model of the same account.` });
  }
  const inputItems = [...record.input, ...record.output, ...toInputArray(rest.input)];
  return { body: { ...rest, input: inputItems }, inputItems, previous: record };
};

// A relogin under the same alias must never receive the previous login's history.
export const assertSameLogin = (previous: StoredResponse | undefined, accountIdentity: string | undefined): void => {
  if (previous !== undefined && previous.accountIdentity !== accountIdentity) {
    throw createProxyError({ status: 400, message: `Previous response with id '${previous.id}' was created under another login; start a new conversation.` });
  }
};

// Output items follow the collectResponse rule: done items by output_index, else response.output.
// Failed or errored responses are never saved.
export const createResponseRecorder = (save: (id: string, output: Json[]) => void): ((event: ResponsesEvent) => void) => {
  const doneItems: Array<{ index: number; item: Json }> = [];
  return (event) => {
    if (event.type === 'response.output_item.done') {
      doneItems.push({ index: Number(event.output_index ?? doneItems.length), item: event.item as Json });
    } else if (event.type === 'response.completed' || event.type === 'response.incomplete') {
      const response = (event.response ?? {}) as Json;
      if (typeof response.id !== 'string') return;
      const outputItems = doneItems.sort((left, right) => left.index - right.index).map(({ item }) => item);
      save(response.id, outputItems.length > 0 ? outputItems : Array.isArray(response.output) ? (response.output as Json[]) : []);
    }
  };
};

// Observes each event before the caller sees it, so a record exists before the client can reuse it.
export async function* observeEvents(
  events: AsyncIterable<ResponsesEvent>,
  observe?: (event: ResponsesEvent) => void,
): AsyncGenerator<ResponsesEvent> {
  for await (const event of events) {
    observe?.(event);
    yield event;
  }
}
