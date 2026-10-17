import { createHash } from 'node:crypto';
import {
  ALLOWED_RESPONSES_FIELDS,
  DEFAULT_FUNCTION_NAMESPACE,
  REASONING_EFFORT_ALIASES,
  REQUIRED_INCLUDE,
} from '../constants.js';
import { createProxyError } from '../errors.js';
import type { CodexModel, Json, ResponsesRequest } from '../types.js';

export type NormalizedResponsesRequest = {
  request: ResponsesRequest;
  sessionId: string;
  isResponsesLite: boolean;
  strippedKeys: string[];
};

const FORCED_FIELDS = ['stream', 'store'];
const ALLOWED_FIELDS: readonly string[] = ALLOWED_RESPONSES_FIELDS;

const toInputItems = (input: unknown): Json[] => {
  if (typeof input === 'string') {
    return [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: input }] }];
  }
  if (!Array.isArray(input)) throw createProxyError({ status: 400, message: '`input` must be a string or an array' });
  // Backend rejects system messages ("System messages are not allowed").
  return (input as Json[]).map((item) => (item.role === 'system' ? { ...item, role: 'developer' } : item));
};

const getItemText = (item: Json | undefined): string => {
  if (!item) return '';
  if (typeof item.content === 'string') return item.content;
  if (!Array.isArray(item.content)) return '';
  return (item.content as Json[]).map((part) => (typeof part.text === 'string' ? part.text : '')).join('\n');
};

// Stable per conversation, so prompt caching keeps working across turns.
export const getSessionId = (seed: string): string => {
  const hex = createHash('sha256').update(seed).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
};

const getSessionSeed = (model: string, instructions: unknown, input: Json[]): string => {
  const firstDeveloper = input.find((item) => item.role === 'developer');
  const firstUser = input.find((item) => item.role === 'user');
  return JSON.stringify([model, typeof instructions === 'string' ? instructions : '', getItemText(firstDeveloper), getItemText(firstUser)]);
};

const toAdditionalToolsItem = (tools: Json[]): Json => {
  const namespaceTools: Json[] = [];
  const otherTools: Json[] = [];
  for (const tool of tools) {
    if (tool.type === 'function' || tool.type === 'custom') namespaceTools.push(tool);
    else if (tool.type === 'namespace' && tool.name === DEFAULT_FUNCTION_NAMESPACE) {
      namespaceTools.push(...((tool.tools ?? []) as Json[]));
    } else otherTools.push(tool);
  }
  const liteTools =
    namespaceTools.length === 0
      ? otherTools
      : [{ type: 'namespace', name: DEFAULT_FUNCTION_NAMESPACE, description: '', tools: namespaceTools }, ...otherTools];
  return { type: 'additional_tools', role: 'developer', tools: liteTools };
};

// Responses Lite shape used by Codex (core/src/client.rs build_responses_request).
export const applyResponsesLite = (request: ResponsesRequest): ResponsesRequest => {
  const { tools, ...rest } = request;
  const toolList = Array.isArray(tools) ? (tools as Json[]) : [];
  const hasAdditionalTools = request.input.some((item) => item.type === 'additional_tools');
  if (hasAdditionalTools && toolList.length > 0) {
    throw createProxyError({ status: 400, message: 'Send tools either top-level or as an additional_tools item, not both' });
  }
  return {
    ...rest,
    input: toolList.length === 0 ? request.input : [toAdditionalToolsItem(toolList), ...request.input],
    parallel_tool_calls: false,
    reasoning: { ...((request.reasoning ?? {}) as Json), context: 'all_turns' },
  };
};

export const normalizeResponsesRequest = (body: Json, model?: CodexModel): NormalizedResponsesRequest => {
  if (typeof body.model !== 'string' || body.model === '') {
    throw createProxyError({ status: 400, message: '`model` is required' });
  }
  const strippedKeys = Object.keys(body).filter((key) => !ALLOWED_FIELDS.includes(key) && !FORCED_FIELDS.includes(key));
  const allowed = Object.fromEntries(Object.entries(body).filter(([key]) => ALLOWED_FIELDS.includes(key)));
  const input = toInputItems(body.input ?? []);
  const include = Array.isArray(body.include) ? (body.include as string[]) : [];

  const reasoning = { ...((body.reasoning ?? {}) as Json) };
  if (reasoning.effort === undefined && model?.default_reasoning_level) reasoning.effort = model.default_reasoning_level;
  if (typeof reasoning.effort === 'string') reasoning.effort = REASONING_EFFORT_ALIASES[reasoning.effort] ?? reasoning.effort;

  const sessionId =
    typeof body.prompt_cache_key === 'string' && body.prompt_cache_key !== ''
      ? body.prompt_cache_key
      : getSessionId(getSessionSeed(body.model, body.instructions, input));

  const request: ResponsesRequest = {
    ...allowed,
    model: body.model,
    input,
    stream: true,
    store: false,
    include: include.includes(REQUIRED_INCLUDE) ? include : [...include, REQUIRED_INCLUDE],
    prompt_cache_key: sessionId,
  };
  if (Object.keys(reasoning).length > 0) request.reasoning = reasoning;

  const isResponsesLite = model?.use_responses_lite === true;
  return {
    request: isResponsesLite ? applyResponsesLite(request) : request,
    sessionId,
    isResponsesLite,
    strippedKeys,
  };
};
