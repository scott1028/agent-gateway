import type { ChatToolCall, ChatUsage, CollectedResponse, Json, ResponsesUsage } from '../types.js';

export type ChatMeta = { id: string; model: string; created: number };

export const getMessageText = (item: Json): string =>
  Array.isArray(item.content)
    ? (item.content as Json[]).map((part) => (part.type === 'output_text' && typeof part.text === 'string' ? part.text : '')).join('')
    : '';

export const toChatToolCall = (item: Json): ChatToolCall => ({
  id: String(item.call_id ?? ''),
  type: 'function',
  function: { name: String(item.name ?? ''), arguments: typeof item.arguments === 'string' ? item.arguments : '' },
});

export const getFinishReason = (response: Json, hasToolCalls: boolean): string => {
  const reason = ((response.incomplete_details ?? {}) as Json).reason;
  if (response.status === 'incomplete' && reason === 'max_output_tokens') return 'length';
  if (response.status === 'incomplete' && reason === 'content_filter') return 'content_filter';
  return hasToolCalls ? 'tool_calls' : 'stop';
};

export const toChatUsage = (usage?: ResponsesUsage): ChatUsage | undefined => {
  if (!usage) return undefined;
  const promptTokens = usage.input_tokens ?? 0;
  const completionTokens = usage.output_tokens ?? 0;
  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: usage.total_tokens ?? promptTokens + completionTokens,
    prompt_tokens_details: { cached_tokens: usage.input_tokens_details?.cached_tokens ?? 0 },
    completion_tokens_details: { reasoning_tokens: usage.output_tokens_details?.reasoning_tokens ?? 0 },
  };
};

export const toChatCompletion = ({ response, outputItems }: CollectedResponse, meta: ChatMeta, textSeparator = '\n\n'): Json => {
  const text = outputItems
    .filter((item) => item.type === 'message')
    .map(getMessageText)
    .filter((itemText) => itemText !== '')
    .join(textSeparator);
  const toolCalls = outputItems.filter((item) => item.type === 'function_call').map(toChatToolCall);
  const usage = toChatUsage(response.usage as ResponsesUsage | undefined);
  return {
    id: meta.id,
    object: 'chat.completion',
    created: meta.created,
    model: meta.model,
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: text === '' ? null : text,
          ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
        },
        finish_reason: getFinishReason(response, toolCalls.length > 0),
        logprobs: null,
      },
    ],
    ...(usage ? { usage } : {}),
  };
};
