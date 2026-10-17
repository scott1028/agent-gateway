import { fromFailedEvent, toOpenAiErrorBody } from '../errors.js';
import type { ChatChunk, Json, OpenAiErrorBody, ResponsesEvent, ResponsesUsage } from '../types.js';
import { type ChatMeta, getFinishReason, getMessageText, toChatToolCall, toChatUsage } from './toChatCompletion.js';

export type ChatStreamState = ChatMeta & {
  isUsageIncluded: boolean;
  // Joins consecutive assistant message items in the aggregated content. Codex keeps a blank
  // line; Claude turns are echoed back for signed replay, so their items join exactly like the
  // native text blocks (no separator) and the client can echo the content unchanged.
  textSeparator: string;
  toolCallCount: number;
  streamedItemIds: string[];
  lastTextItemId?: string;
  isDone: boolean;
};

export type ChatStreamPayload = ChatChunk | OpenAiErrorBody | '[DONE]';

type ChatStreamStep = { state: ChatStreamState; payloads: ChatStreamPayload[] };

export const createChatStreamState = (
  meta: ChatMeta & { isUsageIncluded: boolean; textSeparator?: string },
): ChatStreamState => ({
  ...meta,
  textSeparator: meta.textSeparator ?? '\n\n',
  toolCallCount: 0,
  streamedItemIds: [],
  isDone: false,
});

const toChunk = (state: ChatStreamState, delta: Json, finishReason: string | null = null): ChatChunk => ({
  id: state.id,
  object: 'chat.completion.chunk',
  created: state.created,
  model: state.model,
  choices: [{ index: 0, delta, finish_reason: finishReason, logprobs: null }],
});

// Join consecutive message items (e.g. commentary then final answer) with the state's separator.
const appendText = (state: ChatStreamState, itemId: string, text: string): ChatStreamStep => {
  if (text === '') return { state, payloads: [] };
  const separator = state.lastTextItemId !== undefined && state.lastTextItemId !== itemId ? state.textSeparator : '';
  const nextState = {
    ...state,
    lastTextItemId: itemId,
    streamedItemIds: state.streamedItemIds.includes(itemId) ? state.streamedItemIds : [...state.streamedItemIds, itemId],
  };
  return { state: nextState, payloads: [toChunk(nextState, { content: separator + text })] };
};

const finishStream = (state: ChatStreamState, response: Json): ChatStreamStep => {
  const payloads: ChatStreamPayload[] = [toChunk(state, {}, getFinishReason(response, state.toolCallCount > 0))];
  const usage = toChatUsage(response.usage as ResponsesUsage | undefined);
  if (state.isUsageIncluded && usage) {
    payloads.push({
      id: state.id,
      object: 'chat.completion.chunk',
      created: state.created,
      model: state.model,
      choices: [],
      usage,
    });
  }
  payloads.push('[DONE]');
  return { state: { ...state, isDone: true }, payloads };
};

// Converts one upstream Responses event into Chat Completions stream payloads.
export const reduceChatStream = (state: ChatStreamState, event: ResponsesEvent): ChatStreamStep => {
  if (event.type === 'response.created') {
    return { state, payloads: [toChunk(state, { role: 'assistant', content: '' })] };
  }
  if (event.type === 'response.output_text.delta') {
    return appendText(state, String(event.item_id ?? ''), String(event.delta ?? ''));
  }
  if (event.type === 'response.output_item.done') {
    const item = (event.item ?? {}) as Json;
    const itemId = String(item.id ?? '');
    // Fallback when the item text arrived without deltas.
    if (item.type === 'message' && !state.streamedItemIds.includes(itemId)) {
      return appendText(state, itemId, getMessageText(item));
    }
    if (item.type === 'function_call') {
      const toolCall = { index: state.toolCallCount, ...toChatToolCall(item) };
      const nextState = { ...state, toolCallCount: state.toolCallCount + 1 };
      return { state: nextState, payloads: [toChunk(nextState, { tool_calls: [toolCall] })] };
    }
    return { state, payloads: [] };
  }
  if (event.type === 'response.completed' || event.type === 'response.incomplete') {
    return finishStream(state, (event.response ?? {}) as Json);
  }
  if (event.type === 'response.failed' || event.type === 'error') {
    return { state: { ...state, isDone: true }, payloads: [toOpenAiErrorBody(fromFailedEvent(event))] };
  }
  return { state, payloads: [] };
};
