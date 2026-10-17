// Claude Messages SSE -> OpenAI Responses events, so the existing aggregation
// (responses/collectResponse.ts) and Chat rendering (chat/reduceChatStream.ts) work unchanged.
// Event flow and cumulative usage follow the official streaming docs recorded in
// docs/CLAUDE_UPSTREAM_PROTOCOL_DIFF.md; client-facing event shapes match test/fixtures/*.sse.
// The stream is validated the way the release's own accumulator does (binary offset 218919418 and
// the event/delta allowlists at 239430414): an out-of-order, unknown or half-closed block fails
// the response instead of being smoothed over. Required fields keep their types, and content_block
// start fields seed the accumulator so a nonempty start value is never dropped.
// TODO: Expose Claude thinking summaries and streaming events through the OpenAI-compatible APIs.
import { randomUUID } from 'node:crypto';
import { createProxyError } from '../errors.js';
import type { Json, ResponsesEvent, ResponsesUsage } from '../types.js';

export type ClaudeStreamMeta = { id: string; model: string; created: number };

type BlockState = {
  openaiIndex: number;
  itemId: string;
  kind: 'message' | 'reasoning' | 'function_call';
  callId?: string;
  name?: string;
  text: string;
  argumentsText: string;
  native: Json;
  isOpen: boolean;
};

const newId = (prefix: string): string => `${prefix}_${randomUUID().replace(/-/g, '')}`;

const badUpstream = (message: string): Error => createProxyError({ status: 502, code: 'bad_upstream', message });

// Claude usage splits cache counters out of input_tokens; OpenAI folds them in.
export const toResponsesUsage = (usage: Json | undefined): ResponsesUsage | undefined => {
  if (usage === undefined) return undefined;
  const inputTokens = Number(usage.input_tokens ?? 0);
  const cacheRead = Number(usage.cache_read_input_tokens ?? 0);
  const cacheWrite = Number(usage.cache_creation_input_tokens ?? 0);
  const outputTokens = Number(usage.output_tokens ?? 0);
  const input_tokens = inputTokens + cacheRead + cacheWrite;
  const thinkingTokens = typeof usage.thinking_tokens === 'number' ? usage.thinking_tokens : undefined;
  return {
    input_tokens,
    input_tokens_details: { cached_tokens: cacheRead },
    output_tokens: outputTokens,
    ...(thinkingTokens === undefined ? {} : { output_tokens_details: { reasoning_tokens: thinkingTokens } }),
    total_tokens: input_tokens + outputTokens,
  };
};

// message_delta usage is cumulative for the whole message but the release only guarantees the
// counters it touched, so untouched counters from message_start are kept.
const mergeNativeUsage = (current: Json | undefined, update: Json | undefined): Json | undefined => {
  if (update === undefined) return current;
  if (current === undefined) return update;
  return { ...current, ...update };
};

const getIncompleteDetails = (stopReason: string | undefined): { response: Json; status: string } | undefined => {
  if (stopReason === 'max_tokens') return { response: { reason: 'max_output_tokens' }, status: 'incomplete' };
  if (stopReason === 'refusal') return { response: { reason: 'content_filter' }, status: 'incomplete' };
  return undefined;
};

// stop_reason values the pinned release accepts (binary offset 218437250).
const STOP_REASONS = ['end_turn', 'max_tokens', 'stop_sequence', 'tool_use', 'refusal', 'pause_turn', 'model_context_window_exceeded'];

const DELTA_KINDS: Record<string, BlockState['kind'][]> = {
  text_delta: ['message'],
  citations_delta: ['message'],
  input_json_delta: ['function_call'],
  thinking_delta: ['reasoning'],
  signature_delta: ['reasoning'],
  compaction_delta: ['reasoning'],
};

// Block types the pinned release models but the gateway does not support: they must fail
// explicitly instead of silently becoming empty reasoning items. Unknown (future) block types stay
// tolerated the way the release tells consumers to tolerate newer types.
const SUPPORTED_BLOCK_TYPES = ['text', 'tool_use', 'thinking', 'redacted_thinking', 'compaction'];
const KNOWN_UNSUPPORTED_BLOCK_TYPES = [
  'server_tool_use',
  'web_search_tool_result',
  'web_fetch_tool_result',
  'code_execution_tool_result',
  'bash_code_execution_tool_result',
  'text_editor_code_execution_tool_result',
  'mcp_tool_use',
  'mcp_tool_result',
  'container_upload',
  'search_result',
  'document',
  'image',
];

export type TranslateClaudeStreamInput = {
  events: AsyncIterable<ResponsesEvent>;
  meta: ClaudeStreamMeta;
  // Called once, at a validated message_stop, with the COMPLETE native assistant content: a state
  // write failure must fail the response before any tool item is reported complete, so a partial
  // or unwritable turn can never leave a tool call the next turn would not be able to replay.
  saveState?: (nativeContent: Json[], callIds: string[]) => Promise<void>;
};

const parseToolArguments = (block: BlockState): Json => {
  if (block.argumentsText === '') {
    // A tool_use block may carry its full input already at content_block_start; keep it.
    const startInput = block.native.input;
    if (typeof startInput === 'object' && startInput !== null && !Array.isArray(startInput)) return startInput as Json;
    return {};
  }
  try {
    const parsed: unknown = JSON.parse(block.argumentsText);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('not an object');
    return parsed as Json;
  } catch {
    throw badUpstream(`Claude stream sent invalid tool arguments for "${block.callId ?? block.name ?? 'unknown call'}"`);
  }
};

const toOutputItem = (block: BlockState): Json => {
  if (block.kind === 'function_call') {
    return {
      type: 'function_call',
      id: block.itemId,
      call_id: block.callId,
      name: block.name,
      arguments: block.argumentsText === '' ? JSON.stringify(block.native.input ?? {}) : block.argumentsText,
      status: 'completed',
    };
  }
  if (block.kind === 'reasoning') return { type: 'reasoning', id: block.itemId, summary: [], content: [] };
  return {
    type: 'message',
    id: block.itemId,
    role: 'assistant',
    status: 'completed',
    content: [{ type: 'output_text', text: block.text, annotations: [], logprobs: [] }],
    phase: 'final_answer',
  };
};

const hasHiddenBlocks = (content: Json[]): boolean =>
  content.some((block) => block.type !== 'text' && block.type !== 'tool_use');

export async function* translateClaudeStream({
  events,
  meta,
  saveState,
}: TranslateClaudeStreamInput): AsyncGenerator<ResponsesEvent> {
  let sequence = 0;
  let outputIndex = 0;
  const blocks: BlockState[] = [];
  const nativeContent: Json[] = [];
  const callIds: string[] = [];
  const toolCallIds = new Set<string>();
  const deferredToolEvents: ResponsesEvent[] = [];
  let nativeUsage: Json | undefined;
  let usage: ResponsesUsage | undefined;
  let stopReason: string | undefined;
  let isStarted = false;
  let isDeltaSeen = false;
  let isStopped = false;
  const next = (): number => sequence++;

  const responseShell = (status: string, output: Json[]): Json => ({
    id: meta.id,
    object: 'response',
    created_at: meta.created,
    completed_at: status === 'completed' || status === 'incomplete' ? Math.floor(Date.now() / 1000) : null,
    status,
    model: meta.model,
    output,
    usage: usage ?? null,
    incomplete_details: null,
  });

  const emit = (type: string, extra: Json): ResponsesEvent => ({ type, sequence_number: next(), ...extra });

  const getOpenBlock = (event: ResponsesEvent): BlockState => {
    const index = event.index;
    if (typeof index !== 'number' || !Number.isInteger(index) || index < 0) {
      throw badUpstream(`Claude stream sent an invalid content block index: ${String(index)}`);
    }
    const block = blocks[index];
    if (block === undefined) throw badUpstream('Claude stream referenced a content block that was never opened');
    if (!block.isOpen) throw badUpstream(`Claude stream reused the already closed content block ${index}`);
    return block;
  };

  for await (const event of events) {
    if (isStopped && event.type !== 'ping') {
      throw badUpstream(`Claude stream sent ${event.type} after message_stop`);
    }
    switch (event.type) {
      case 'message_start': {
        if (isStarted) throw badUpstream('Claude stream sent message_start twice');
        const message = event.message;
        if (typeof message !== 'object' || message === null) throw badUpstream('Claude stream message_start has no message');
        if (typeof (message as Json).id !== 'string' || (message as Json).id === '') {
          throw badUpstream('Claude stream message_start has no message id');
        }
        if (typeof (message as Json).role !== 'string') throw badUpstream('Claude stream message_start has no message role');
        if (!Array.isArray((message as Json).content)) throw badUpstream('Claude stream message_start has no content array');
        const messageUsage = (message as Json).usage;
        if (messageUsage !== undefined && (typeof messageUsage !== 'object' || messageUsage === null)) {
          throw badUpstream('Claude stream message_start has invalid usage');
        }
        nativeUsage = mergeNativeUsage(nativeUsage, messageUsage as Json | undefined);
        usage = toResponsesUsage(nativeUsage);
        isStarted = true;
        yield emit('response.created', { response: responseShell('in_progress', []) });
        yield emit('response.in_progress', { response: responseShell('in_progress', []) });
        continue;
      }
      case 'content_block_start': {
        if (!isStarted) throw badUpstream('Claude stream started a content block before message_start');
        if (isDeltaSeen) throw badUpstream('Claude stream started a content block after message_delta');
        const index = event.index;
        if (typeof index !== 'number' || index !== blocks.length) {
          throw badUpstream(`Claude stream opened content block ${String(index)} out of order`);
        }
        const rawBlock = event.content_block;
        if (typeof rawBlock !== 'object' || rawBlock === null) {
          throw badUpstream('Claude stream started a content block without a block');
        }
        const block = rawBlock as Json;
        if (typeof block.type !== 'string') {
          throw badUpstream('Claude stream started a content block without a type');
        }
        const openaiIndex = outputIndex++;
        if (block.type === 'tool_use') {
          const callId = String(block.id ?? '');
          if (callId === '') throw badUpstream('Claude stream started a tool_use block without an id');
          if (typeof block.name !== 'string' || block.name === '') throw badUpstream(`Claude stream started tool_use "${callId}" without a name`);
          if (toolCallIds.has(callId)) throw badUpstream(`Claude stream reused the tool_use id "${callId}"`);
          toolCallIds.add(callId);
          callIds.push(callId);
          blocks[index] = {
            openaiIndex,
            itemId: newId('fc'),
            kind: 'function_call',
            callId,
            name: block.name,
            text: '',
            argumentsText: '',
            native: block,
            isOpen: true,
          };
          yield emit('response.output_item.added', {
            output_index: openaiIndex,
            item: { type: 'function_call', id: blocks[index]?.itemId, call_id: callId, name: block.name, arguments: '', status: 'in_progress' },
          });
          continue;
        }
        if (block.type === 'thinking' || block.type === 'redacted_thinking' || block.type === 'compaction') {
          blocks[index] = { openaiIndex, itemId: newId('rs'), kind: 'reasoning', text: '', argumentsText: '', native: block, isOpen: true };
          yield emit('response.output_item.added', {
            output_index: openaiIndex,
            item: { type: 'reasoning', id: blocks[index]?.itemId, summary: [], content: [] },
          });
          continue;
        }
        if (block.type !== 'text') {
          if (KNOWN_UNSUPPORTED_BLOCK_TYPES.includes(block.type)) {
            throw badUpstream(`Claude stream sent unsupported content block type "${block.type}"`);
          }
          if (SUPPORTED_BLOCK_TYPES.includes(block.type)) throw badUpstream(`Claude stream sent unhandled content block type "${block.type}"`);
          // A block type newer than this release stays opaque state instead of failing the stream.
          console.warn(`[claude] unsupported Claude content block type "${block.type}"; kept as opaque state`);
          blocks[index] = { openaiIndex, itemId: newId('rs'), kind: 'reasoning', text: '', argumentsText: '', native: block, isOpen: true };
          yield emit('response.output_item.added', {
            output_index: openaiIndex,
            item: { type: 'reasoning', id: blocks[index]?.itemId, summary: [], content: [] },
          });
          continue;
        }
        // content_block_start can carry the full text already; seed the accumulator with it.
        // The part is added EMPTY and the start text arrives as one output_text.delta, so an
        // accumulator that initializes the part then appends deltas sees the text exactly once.
        const startText = typeof block.text === 'string' ? block.text : '';
        blocks[index] = { openaiIndex, itemId: newId('msg'), kind: 'message', text: startText, argumentsText: '', native: block, isOpen: true };
        yield emit('response.output_item.added', {
          output_index: openaiIndex,
          item: { type: 'message', id: blocks[index]?.itemId, role: 'assistant', status: 'in_progress', content: [], phase: 'final_answer' },
        });
        yield emit('response.content_part.added', {
          item_id: blocks[index]?.itemId,
          output_index: openaiIndex,
          content_index: 0,
          part: { type: 'output_text', text: '', annotations: [], logprobs: [] },
        });
        if (startText !== '') {
          yield emit('response.output_text.delta', {
            item_id: blocks[index]?.itemId,
            output_index: openaiIndex,
            content_index: 0,
            delta: startText,
            logprobs: [],
          });
        }
        continue;
      }
      case 'content_block_delta': {
        const block = getOpenBlock(event);
        const rawDelta = event.delta;
        if (typeof rawDelta !== 'object' || rawDelta === null) {
          throw badUpstream('Claude stream sent a content_block_delta without a delta');
        }
        const delta = rawDelta as Json;
        if (typeof delta.type !== 'string') {
          throw badUpstream('Claude stream sent a content_block_delta without a delta type');
        }
        const allowedKinds = DELTA_KINDS[delta.type];
        if (allowedKinds === undefined) throw badUpstream(`Unknown Claude delta type: ${delta.type}`);
        if (!allowedKinds.includes(block.kind)) {
          throw badUpstream(`Claude stream sent a "${delta.type}" delta for a ${block.kind} content block`);
        }
        if (delta.type === 'text_delta') {
          if (typeof delta.text !== 'string') throw badUpstream('Claude stream sent a text_delta without string text');
          block.text += delta.text;
          // OpenAI output_text.delta carries a STRING delta, not the native delta object.
          yield emit('response.output_text.delta', {
            item_id: block.itemId,
            output_index: block.openaiIndex,
            content_index: 0,
            delta: delta.text,
            logprobs: [],
          });
          continue;
        }
        if (delta.type === 'input_json_delta') {
          if (typeof delta.partial_json !== 'string') throw badUpstream('Claude stream sent an input_json_delta without string partial_json');
          block.argumentsText += delta.partial_json;
          yield emit('response.function_call_arguments.delta', {
            item_id: block.itemId,
            output_index: block.openaiIndex,
            delta: delta.partial_json,
          });
          continue;
        }
        if (delta.type === 'thinking_delta' || delta.type === 'signature_delta') {
          // Thinking text and signatures are persisted for replay but not exposed yet (see TODO above).
          if (delta.type === 'thinking_delta') {
            if (typeof delta.thinking !== 'string') throw badUpstream('Claude stream sent a thinking_delta without string thinking');
            block.native = { ...block.native, thinking: `${String(block.native.thinking ?? '')}${delta.thinking}` };
          } else {
            if (typeof delta.signature !== 'string') throw badUpstream('Claude stream sent a signature_delta without string signature');
            block.native = { ...block.native, signature: `${String(block.native.signature ?? '')}${delta.signature}` };
          }
          continue;
        }
        if (delta.type === 'citations_delta') continue;
        if (delta.type === 'compaction_delta') {
          // Mirrors the official accumulator: content plus optional encrypted_content (binary offset 218919418).
          block.native = {
            ...block.native,
            content: `${String(block.native.content ?? '')}${String(delta.content ?? '')}`,
            ...(typeof delta.encrypted_content === 'string' ? { encrypted_content: delta.encrypted_content } : {}),
          };
          continue;
        }
        throw badUpstream(`Unknown Claude delta type: ${delta.type}`);
      }
      case 'content_block_stop': {
        const block = getOpenBlock(event);
        block.isOpen = false;
        if (block.kind === 'function_call') {
          const input = parseToolArguments(block);
          block.native = { ...block.native, input, id: block.callId, name: block.name, type: 'tool_use' };
          nativeContent.push(block.native);
          // The completion events are deferred: nothing may look "complete" until the whole native
          // turn has been validated and persisted at message_stop.
          const argumentsText = block.argumentsText === '' ? JSON.stringify(input) : block.argumentsText;
          deferredToolEvents.push(
            emit('response.function_call_arguments.done', {
              item_id: block.itemId,
              output_index: block.openaiIndex,
              arguments: argumentsText,
            }),
            emit('response.output_item.done', {
              output_index: block.openaiIndex,
              item: { type: 'function_call', id: block.itemId, call_id: block.callId, name: block.name, arguments: argumentsText, status: 'completed' },
            }),
          );
          continue;
        }
        if (block.kind === 'reasoning') {
          yield emit('response.output_item.done', {
            output_index: block.openaiIndex,
            item: { type: 'reasoning', id: block.itemId, summary: [], content: [] },
          });
          nativeContent.push(block.native);
          continue;
        }
        yield emit('response.output_text.done', { item_id: block.itemId, output_index: block.openaiIndex, content_index: 0, text: block.text, logprobs: [] });
        yield emit('response.content_part.done', {
          item_id: block.itemId,
          output_index: block.openaiIndex,
          content_index: 0,
          part: { type: 'output_text', text: block.text, annotations: [], logprobs: [] },
        });
        yield emit('response.output_item.done', {
          output_index: block.openaiIndex,
          item: { type: 'message', id: block.itemId, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: block.text, annotations: [], logprobs: [] }], phase: 'final_answer' },
        });
        // Keep the raw start block (citations and friends) and overwrite only the accumulated text.
        nativeContent.push({ ...block.native, type: 'text', text: block.text });
        continue;
      }
      case 'message_delta': {
        if (!isStarted) throw badUpstream('Claude stream sent message_delta before message_start');
        if (blocks.some((block) => block?.isOpen)) throw badUpstream('Claude stream sent message_delta with a content block still open');
        const deltaUsage = event.usage;
        if (deltaUsage !== undefined && (typeof deltaUsage !== 'object' || deltaUsage === null)) {
          throw badUpstream('Claude stream message_delta has invalid usage');
        }
        nativeUsage = mergeNativeUsage(nativeUsage, deltaUsage as Json | undefined);
        usage = toResponsesUsage(nativeUsage);
        const rawDelta = event.delta;
        if (typeof rawDelta !== 'object' || rawDelta === null) throw badUpstream('Claude stream message_delta has no delta');
        const delta = rawDelta as Json;
        if (typeof delta.stop_reason !== 'string' || !STOP_REASONS.includes(delta.stop_reason)) {
          throw badUpstream(`Claude stream message_delta has an unknown stop_reason: ${String(delta.stop_reason)}`);
        }
        stopReason = delta.stop_reason;
        isDeltaSeen = true;
        continue;
      }
      case 'message_stop': {
        if (!isDeltaSeen) throw badUpstream('Claude stream ended without message_delta');
        if (blocks.some((block) => block?.isOpen)) throw badUpstream('Claude stream sent message_stop with a content block still open');
        const incomplete = getIncompleteDetails(stopReason);
        const status = incomplete?.status ?? 'completed';
        const output = blocks
          .filter((block): block is BlockState => block !== undefined)
          .sort((left, right) => left.openaiIndex - right.openaiIndex)
          .map((block) => toOutputItem(block));
        // Tool turns and turns with hidden signed content need replay state, but only a fully
        // completed turn is replayable: one atomic save of the complete native content, before any
        // deferred tool completion or the terminal event is exposed.
        if (status === 'completed' && saveState !== undefined && (callIds.length > 0 || hasHiddenBlocks(nativeContent))) {
          await saveState(nativeContent.map((block) => ({ ...block })), [...callIds]);
        }
        isStopped = true;
        yield* deferredToolEvents;
        const shell = responseShell(status, output);
        if (incomplete) shell.incomplete_details = incomplete.response;
        yield emit(status === 'completed' ? 'response.completed' : 'response.incomplete', { response: shell });
        continue;
      }
      case 'ping':
        continue;
      case 'error': {
        const error = (event.error ?? {}) as Json;
        throw createProxyError({
          status: 502,
          code: typeof error.type === 'string' ? error.type : 'upstream_error',
          message: typeof error.message === 'string' ? error.message : 'Claude stream reported an error',
        });
      }
      default:
        continue;
    }
  }

  if (!isStarted || !isStopped) {
    throw createProxyError({ status: 502, code: 'stream_incomplete', message: 'Claude stream ended before message_stop' });
  }
}
