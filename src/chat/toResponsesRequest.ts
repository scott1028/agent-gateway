import { createProxyError } from '../errors.js';
import type { ChatMessage, Json } from '../types.js';

// Chat fields with a Responses equivalent; everything else is ignored (the backend
// rejects temperature, top_p, user, metadata, ...).
const HANDLED_CHAT_KEYS = [
  'model',
  'messages',
  'stream',
  'stream_options',
  'tools',
  'tool_choice',
  'parallel_tool_calls',
  'reasoning_effort',
  'response_format',
  'verbosity',
  'max_tokens',
  'max_completion_tokens',
  'service_tier',
  'prompt_cache_key',
  'n',
];

const getTextParts = (content: ChatMessage['content']): string[] => {
  if (typeof content === 'string') return content === '' ? [] : [content];
  if (!Array.isArray(content)) return [];
  return content.flatMap((part) => (part.type === 'text' && typeof part.text === 'string' ? [part.text] : []));
};

const toUserContent = (content: ChatMessage['content']): Json[] => {
  if (typeof content === 'string') return [{ type: 'input_text', text: content }];
  if (!Array.isArray(content)) return [];
  return content.map((part) => {
    if (part.type === 'text') return { type: 'input_text', text: part.text };
    if (part.type === 'image_url') {
      const imageUrl = (part.image_url ?? {}) as Json;
      return { type: 'input_image', image_url: imageUrl.url, ...(imageUrl.detail ? { detail: imageUrl.detail } : {}) };
    }
    throw createProxyError({ status: 400, message: `Unsupported user content part type: ${String(part.type)}` });
  });
};

const toInputItems = (message: ChatMessage): Json[] => {
  if (message.role === 'system' || message.role === 'developer') {
    const text = getTextParts(message.content).join('\n');
    return [{ type: 'message', role: 'developer', content: [{ type: 'input_text', text }] }];
  }
  if (message.role === 'user') {
    return [{ type: 'message', role: 'user', content: toUserContent(message.content) }];
  }
  if (message.role === 'assistant') {
    const text = getTextParts(message.content).join('');
    const textItems = text === '' ? [] : [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }];
    const callItems = (message.tool_calls ?? []).map((toolCall) => ({
      type: 'function_call',
      call_id: toolCall.id,
      name: toolCall.function.name,
      arguments: toolCall.function.arguments,
    }));
    return [...textItems, ...callItems];
  }
  if (message.role === 'tool') {
    if (!message.tool_call_id) throw createProxyError({ status: 400, message: 'Tool messages require `tool_call_id`' });
    return [{ type: 'function_call_output', call_id: message.tool_call_id, output: getTextParts(message.content).join('\n') }];
  }
  throw createProxyError({ status: 400, message: `Unsupported message role: ${message.role}` });
};

const toResponsesTool = (tool: Json): Json => {
  const fn = tool.function as Json | undefined;
  if (tool.type !== 'function' || !fn || typeof fn.name !== 'string') {
    throw createProxyError({ status: 400, message: 'Only `function` tools are supported' });
  }
  return {
    type: 'function',
    name: fn.name,
    description: typeof fn.description === 'string' ? fn.description : '',
    strict: fn.strict === true,
    parameters: fn.parameters ?? { type: 'object', properties: {} },
  };
};

const toToolChoice = (toolChoice: unknown): unknown => {
  if (typeof toolChoice === 'object' && toolChoice !== null && (toolChoice as Json).type === 'function') {
    const fn = (toolChoice as Json).function as Json | undefined;
    return { type: 'function', name: fn?.name };
  }
  return toolChoice;
};

const toTextFormat = (responseFormat: unknown): Json | undefined => {
  if (typeof responseFormat !== 'object' || responseFormat === null) return undefined;
  const format = responseFormat as Json;
  if (format.type === 'json_object') return { type: 'json_object' };
  if (format.type !== 'json_schema') return undefined;
  const schema = (format.json_schema ?? {}) as Json;
  return {
    type: 'json_schema',
    name: schema.name,
    schema: schema.schema,
    strict: schema.strict === true,
    ...(typeof schema.description === 'string' ? { description: schema.description } : {}),
  };
};

export const toResponsesRequest = (chat: Json): { request: Json; ignoredKeys: string[] } => {
  if (typeof chat.model !== 'string' || chat.model === '') throw createProxyError({ status: 400, message: '`model` is required' });
  if (!Array.isArray(chat.messages) || chat.messages.length === 0) {
    throw createProxyError({ status: 400, message: '`messages` must be a non-empty array' });
  }
  if (typeof chat.n === 'number' && chat.n > 1) throw createProxyError({ status: 400, message: '`n` > 1 is not supported' });

  const request: Json = {
    model: chat.model,
    input: (chat.messages as ChatMessage[]).flatMap(toInputItems),
  };
  if (Array.isArray(chat.tools) && chat.tools.length > 0) request.tools = (chat.tools as Json[]).map(toResponsesTool);
  if (chat.tool_choice !== undefined) request.tool_choice = toToolChoice(chat.tool_choice);
  if (typeof chat.parallel_tool_calls === 'boolean') request.parallel_tool_calls = chat.parallel_tool_calls;
  if (typeof chat.reasoning_effort === 'string') request.reasoning = { effort: chat.reasoning_effort };

  const textFormat = toTextFormat(chat.response_format);
  const text: Json = {
    ...(textFormat ? { format: textFormat } : {}),
    ...(typeof chat.verbosity === 'string' ? { verbosity: chat.verbosity } : {}),
  };
  if (Object.keys(text).length > 0) request.text = text;

  const maxTokens = chat.max_completion_tokens ?? chat.max_tokens;
  if (typeof maxTokens === 'number') request.max_output_tokens = maxTokens;
  if (typeof chat.service_tier === 'string') request.service_tier = chat.service_tier;
  if (typeof chat.prompt_cache_key === 'string') request.prompt_cache_key = chat.prompt_cache_key;

  return { request, ignoredKeys: Object.keys(chat).filter((key) => !HANDLED_CHAT_KEYS.includes(key)) };
};
