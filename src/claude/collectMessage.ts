// Native Claude SSE -> one Messages API response, for /v1/messages clients that send stream:false
// while the gateway always streams upstream. Accumulation mirrors the official SDK accumulator
// (native 2.1.302 at binary offset 238304387): text and tool input append in order,
// signature_delta replaces the signature and compaction_delta replaces the content. Event order
// is checked as strictly as toResponsesEvents.ts, so a broken stream fails instead of looking done.
import { createProxyError } from '../errors.js';
import type { Json, ResponsesEvent } from '../types.js';
import { STOP_REASONS } from './toResponsesEvents.js';

type BlockState = { block: Json; inputJson: string; isOpen: boolean };

// The block type each delta may extend.
const DELTA_BLOCK_TYPES: Record<string, string> = {
  text_delta: 'text',
  citations_delta: 'text',
  input_json_delta: 'tool_use',
  thinking_delta: 'thinking',
  signature_delta: 'thinking',
  compaction_delta: 'compaction',
};

const badUpstream = (message: string): Error => createProxyError({ status: 502, code: 'bad_upstream', message });

const getIsObject = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value);

const requireDeltaString = (delta: Json, field: string): string => {
  const text = delta[field];
  if (typeof text !== 'string') throw badUpstream(`Claude stream sent a ${String(delta.type)} without string ${field}`);
  return text;
};

const applyDelta = (state: BlockState, delta: Json): void => {
  const { block } = state;
  switch (delta.type) {
    case 'text_delta':
      block.text = `${String(block.text ?? '')}${requireDeltaString(delta, 'text')}`;
      return;
    case 'citations_delta':
      block.citations = [...(Array.isArray(block.citations) ? block.citations : []), delta.citation];
      return;
    case 'input_json_delta':
      state.inputJson += requireDeltaString(delta, 'partial_json');
      return;
    case 'thinking_delta':
      block.thinking = `${String(block.thinking ?? '')}${requireDeltaString(delta, 'thinking')}`;
      return;
    case 'signature_delta':
      block.signature = requireDeltaString(delta, 'signature');
      return;
    default:
      block.content = delta.content;
      if ('encrypted_content' in delta) block.encrypted_content = delta.encrypted_content;
  }
};

// A tool_use input comes from its deltas, or stays the start input when none arrived.
const getToolInput = (state: BlockState): Json => {
  if (state.inputJson === '') return getIsObject(state.block.input) ? state.block.input : {};
  try {
    const parsed: unknown = JSON.parse(state.inputJson);
    if (getIsObject(parsed)) return parsed;
  } catch {
    // Reported below.
  }
  throw badUpstream(`Claude stream sent invalid tool input for "${String(state.block.id)}"`);
};

// Counters touched by message_delta replace the message_start ones; null counters are skipped.
const mergeUsage = (current: unknown, update: Json): Json => ({
  ...(getIsObject(current) ? current : {}),
  ...Object.fromEntries(Object.entries(update).filter(([, count]) => count !== null && count !== undefined)),
});

export const collectClaudeMessage = async (events: AsyncIterable<ResponsesEvent>): Promise<Json> => {
  let message: Json | undefined;
  const blocks: BlockState[] = [];
  const toolUseIds = new Set<string>();
  let isDeltaSeen = false;
  let isStopped = false;

  const getOpenBlock = (event: ResponsesEvent): BlockState => {
    const state = typeof event.index === 'number' ? blocks[event.index] : undefined;
    if (state === undefined) throw badUpstream(`Claude stream referenced content block ${String(event.index)} that was never opened`);
    if (!state.isOpen) throw badUpstream(`Claude stream reused the already closed content block ${String(event.index)}`);
    return state;
  };

  for await (const event of events) {
    if (isStopped && event.type !== 'ping') throw badUpstream(`Claude stream sent ${event.type} after message_stop`);
    switch (event.type) {
      case 'message_start': {
        if (message !== undefined) throw badUpstream('Claude stream sent message_start twice');
        const start = event.message;
        if (!getIsObject(start) || typeof start.id !== 'string' || start.id === '' || typeof start.role !== 'string' || !Array.isArray(start.content)) {
          throw badUpstream('Claude stream message_start has no message with id, role and content');
        }
        if (start.usage !== undefined && !getIsObject(start.usage)) throw badUpstream('Claude stream message_start has invalid usage');
        message = { ...start, content: [] };
        continue;
      }
      case 'content_block_start': {
        if (message === undefined) throw badUpstream('Claude stream started a content block before message_start');
        if (isDeltaSeen) throw badUpstream('Claude stream started a content block after message_delta');
        if (event.index !== blocks.length) throw badUpstream(`Claude stream opened content block ${String(event.index)} out of order`);
        const block = event.content_block;
        if (!getIsObject(block) || typeof block.type !== 'string') throw badUpstream('Claude stream started a content block without a type');
        if (block.type === 'tool_use') {
          if (typeof block.id !== 'string' || block.id === '') throw badUpstream('Claude stream started a tool_use block without an id');
          if (typeof block.name !== 'string' || block.name === '') throw badUpstream(`Claude stream started tool_use "${block.id}" without a name`);
          if (toolUseIds.has(block.id)) throw badUpstream(`Claude stream reused the tool_use id "${block.id}"`);
          toolUseIds.add(block.id);
        }
        blocks.push({ block: { ...block }, inputJson: '', isOpen: true });
        continue;
      }
      case 'content_block_delta': {
        const state = getOpenBlock(event);
        const delta = event.delta;
        if (!getIsObject(delta) || typeof delta.type !== 'string') throw badUpstream('Claude stream sent a content_block_delta without a delta type');
        const blockType = DELTA_BLOCK_TYPES[delta.type];
        if (blockType === undefined) throw badUpstream(`Unknown Claude delta type: ${delta.type}`);
        if (blockType !== state.block.type) throw badUpstream(`Claude stream sent a "${delta.type}" delta for a ${String(state.block.type)} content block`);
        applyDelta(state, delta);
        continue;
      }
      case 'content_block_stop': {
        const state = getOpenBlock(event);
        state.isOpen = false;
        if (state.block.type === 'tool_use') state.block.input = getToolInput(state);
        continue;
      }
      case 'message_delta': {
        if (message === undefined) throw badUpstream('Claude stream sent message_delta before message_start');
        if (blocks.some((state) => state.isOpen)) throw badUpstream('Claude stream sent message_delta with a content block still open');
        const delta = event.delta;
        if (!getIsObject(delta) || typeof delta.stop_reason !== 'string' || !STOP_REASONS.includes(delta.stop_reason)) {
          throw badUpstream(`Claude stream message_delta has an unknown stop_reason: ${String(getIsObject(delta) ? delta.stop_reason : undefined)}`);
        }
        if (event.usage !== undefined && !getIsObject(event.usage)) throw badUpstream('Claude stream message_delta has invalid usage');
        message.stop_reason = delta.stop_reason;
        message.stop_sequence = delta.stop_sequence ?? null;
        if (delta.stop_details !== undefined) message.stop_details = delta.stop_details;
        if (event.usage !== undefined) message.usage = mergeUsage(message.usage, event.usage);
        isDeltaSeen = true;
        continue;
      }
      case 'message_stop':
        if (!isDeltaSeen) throw badUpstream('Claude stream ended without message_delta');
        if (blocks.some((state) => state.isOpen)) throw badUpstream('Claude stream sent message_stop with a content block still open');
        isStopped = true;
        continue;
      case 'error': {
        // The upstream error type (e.g. overloaded_error) is kept for the Anthropic error body.
        const error = getIsObject(event.error) ? event.error : {};
        throw createProxyError({
          status: 502,
          type: typeof error.type === 'string' ? error.type : 'api_error',
          message: typeof error.message === 'string' ? error.message : 'Claude stream reported an error',
        });
      }
      default:
        // ping and event types newer than this release.
        continue;
    }
  }
  if (message === undefined || !isStopped) {
    throw createProxyError({ status: 502, code: 'stream_incomplete', message: 'Claude stream ended before message_stop' });
  }
  return { ...message, content: blocks.map((state) => state.block) };
};
