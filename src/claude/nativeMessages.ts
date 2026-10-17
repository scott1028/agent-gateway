// Anthropic Messages request from a client that is not the official Claude Code -> normalized
// native input for the shared assembly layer (the downgrade path). The accepted surface mirrors the
// existing Claude support boundary (docs/CLAUDE_UPSTREAM_PROTOCOL_DIFF.md §10) and the rebuild
// mirrors references/CLIProxyAPI v8.0.29 claude_executor_cloaking.go: the client's own markers and
// metadata are dropped, and the gateway re-applies the official ones.
import { createProxyError, type ProxyError } from '../errors.js';
import type { Json } from '../types.js';
import type { ClaudeNativeInput, ClaudeRequestFieldNames } from './assembleRequest.js';

export type ClaudeNativeRequest = {
  model: string;
  native: ClaudeNativeInput;
  isStream: boolean;
  // Sampling knobs the official client never sends; dropped and logged as ignored=.
  ignoredKeys: string[];
  // The first raw message after block cleanup, before any merge: the stable part of the session seed.
  firstMessage: Json;
};

// Anthropic field names for the assembly layer's 400 messages.
export const ANTHROPIC_FIELD_NAMES: ClaudeRequestFieldNames = {
  maxTokens: '`max_tokens`',
  effort: '`output_config.effort`',
  disableThinking: '`thinking: {"type":"disabled"}`',
  autoToolChoice: '`tool_choice: {"type":"auto"}`',
};

const HANDLED_KEYS = new Set(['model', 'messages', 'system', 'tools', 'tool_choice', 'max_tokens', 'output_config', 'thinking', 'metadata', 'stream']);
const IGNORED_KEYS = new Set(['temperature', 'top_p', 'top_k']);
const SUPPORTED_IMAGE_MEDIA_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];

const toError = (message: string): ProxyError => createProxyError({ status: 400, type: 'invalid_request_error', message });

const getIsObject = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value);

const requireString = (value: unknown, label: string): string => {
  if (typeof value !== 'string') throw toError(`${label} must be a string`);
  return value;
};

// Same image rules as the OpenAI path: supported base64 media types or an https URL.
const toImageBlock = (block: Json, label: string): Json => {
  const source = block.source;
  if (!getIsObject(source)) throw toError(`${label}.source must be an object`);
  if (source.type === 'base64') {
    const mediaType = requireString(source.media_type, `${label}.source.media_type`);
    if (!SUPPORTED_IMAGE_MEDIA_TYPES.includes(mediaType)) throw toError(`Unsupported image media type: ${mediaType}`);
    return { type: 'image', source: { type: 'base64', media_type: mediaType, data: requireString(source.data, `${label}.source.data`) } };
  }
  if (source.type === 'url') {
    const url = requireString(source.url, `${label}.source.url`);
    if (!url.startsWith('https://')) throw toError('Image URLs must be https://');
    return { type: 'image', source: { type: 'url', url } };
  }
  throw toError(`${label}.source.type must be "base64" or "url"`);
};

const toToolResultContent = (content: unknown, label: string): string | Json[] => {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) throw toError(`${label}.content must be a string or an array`);
  return content.map((part: unknown, index) => {
    const partLabel = `${label}.content[${index}]`;
    if (!getIsObject(part)) throw toError(`${partLabel} must be an object`);
    if (part.type === 'text') return { type: 'text', text: requireString(part.text, `${partLabel}.text`) };
    if (part.type === 'image') return toImageBlock(part, partLabel);
    throw toError(`Unsupported tool_result content type "${String(part.type)}" in ${partLabel}`);
  });
};

// Blocks are rebuilt from their known fields, so a client cache_control (or an echoed
// `citations: null`) never reaches upstream; thinking blocks keep their signature for replay.
const toContentBlock = (block: unknown, role: string, label: string): Json => {
  if (!getIsObject(block)) throw toError(`${label} must be an object`);
  switch (block.type) {
    case 'text':
      return { type: 'text', text: requireString(block.text, `${label}.text`) };
    case 'image':
      if (role !== 'user') throw toError(`${label}: assistant messages cannot carry images for Claude`);
      return toImageBlock(block, label);
    case 'tool_use': {
      if (role !== 'assistant') throw toError(`${label}: tool_use blocks belong to assistant messages`);
      if (!getIsObject(block.input)) throw toError(`${label}.input must be an object`);
      return { type: 'tool_use', id: requireString(block.id, `${label}.id`), name: requireString(block.name, `${label}.name`), input: block.input };
    }
    case 'tool_result': {
      if (role !== 'user') throw toError(`${label}: tool_result blocks belong to user messages`);
      if (block.is_error !== undefined && typeof block.is_error !== 'boolean') throw toError(`${label}.is_error must be a boolean`);
      return {
        type: 'tool_result',
        tool_use_id: requireString(block.tool_use_id, `${label}.tool_use_id`),
        ...(block.content === undefined ? {} : { content: toToolResultContent(block.content, label) }),
        ...(block.is_error === undefined ? {} : { is_error: block.is_error }),
      };
    }
    case 'thinking':
      if (role !== 'assistant') throw toError(`${label}: thinking blocks belong to assistant messages`);
      return { type: 'thinking', thinking: requireString(block.thinking, `${label}.thinking`), signature: requireString(block.signature, `${label}.signature`) };
    case 'redacted_thinking':
      if (role !== 'assistant') throw toError(`${label}: redacted_thinking blocks belong to assistant messages`);
      return { type: 'redacted_thinking', data: requireString(block.data, `${label}.data`) };
    default:
      throw toError(`Unsupported content block type "${String(block.type)}" in ${label} for Claude`);
  }
};

// qB at 222259800 (attribution.ts getClaudeFirstUserText): string content is used whole, an array
// only its first text block; a first message without a text block yields empty.
const getFirstUserText = (message: Json): string => {
  if (typeof message.content === 'string') return message.content;
  const firstText = (message.content as Json[]).find((block) => getIsObject(block) && block.type === 'text');
  return typeof firstText?.text === 'string' ? firstText.text : '';
};

const toMessages = (value: unknown): { messages: Json[]; firstMessage: Json } => {
  if (!Array.isArray(value) || value.length === 0) throw toError('`messages` must be a non-empty array');
  const messages: Json[] = [];
  let firstMessage: Json = {};
  value.forEach((message: unknown, index) => {
    const label = `messages[${index}]`;
    if (!getIsObject(message)) throw toError(`${label} must be an object`);
    const role = message.role;
    if (role !== 'user' && role !== 'assistant') throw toError(`${label}.role must be "user" or "assistant"`);
    const blocks =
      typeof message.content === 'string'
        ? [{ type: 'text', text: message.content }]
        : Array.isArray(message.content)
          ? message.content.map((block: unknown, blockIndex) => toContentBlock(block, role, `${label}.content[${blockIndex}]`))
          : undefined;
    if (blocks === undefined) throw toError(`${label}.content must be a string or an array`);
    // A copy taken before the merge below, so a later adjacent user message keeps the session.
    if (index === 0) firstMessage = structuredClone({ role, content: blocks });
    // Adjacent same-role messages merge, as the assembly layer expects.
    const last = messages[messages.length - 1];
    if (last?.role === role) (last.content as Json[]).push(...blocks);
    else messages.push({ role, content: blocks });
  });
  if (messages[0]?.role !== 'user') throw toError('Claude requires the first message to come from the user');
  return { messages, firstMessage };
};

const toCallerTexts = (system: unknown): string[] => {
  if (system === undefined) return [];
  if (typeof system === 'string') return system === '' ? [] : [system];
  if (!Array.isArray(system)) throw toError('`system` must be a string or an array of text blocks');
  return system.flatMap((block: unknown, index) => {
    if (!getIsObject(block) || block.type !== 'text') throw toError(`system[${index}] must be a text block`);
    const text = requireString(block.text, `system[${index}].text`);
    return text === '' ? [] : [text];
  });
};

// Custom tools only, rebuilt to the official tool shape (name, description, input_schema).
const toTools = (tools: unknown): Json[] => {
  if (tools === undefined) return [];
  if (!Array.isArray(tools)) throw toError('`tools` must be an array');
  return tools.map((tool: unknown, index) => {
    const label = `tools[${index}]`;
    if (!getIsObject(tool)) throw toError(`${label} must be an object`);
    if (tool.type !== undefined && tool.type !== 'custom') {
      throw toError(`Only custom tools are supported for Claude, got "${String(tool.type)}" in ${label}`);
    }
    const schema = tool.input_schema;
    if (!getIsObject(schema) || (schema.type !== undefined && schema.type !== 'object')) throw toError(`${label}.input_schema must describe an object`);
    return {
      name: requireString(tool.name, `${label}.name`),
      ...(typeof tool.description === 'string' && tool.description !== '' ? { description: tool.description } : {}),
      input_schema: { type: 'object', properties: {}, ...schema },
    };
  });
};

// auto without disable_parallel_tool_use is the upstream default and stays omitted, as on the
// OpenAI path; `none` drops the tools there too.
const toToolChoice = (toolChoice: unknown): { toolChoice?: Json; isToolChoiceNone: boolean } => {
  if (toolChoice === undefined) return { isToolChoiceNone: false };
  if (!getIsObject(toolChoice)) throw toError('`tool_choice` must be an object');
  if (toolChoice.disable_parallel_tool_use !== undefined && typeof toolChoice.disable_parallel_tool_use !== 'boolean') {
    throw toError('`tool_choice.disable_parallel_tool_use` must be a boolean');
  }
  const noParallel = toolChoice.disable_parallel_tool_use === true ? { disable_parallel_tool_use: true } : {};
  switch (toolChoice.type) {
    case 'none':
      return { isToolChoiceNone: true };
    case 'auto':
      return toolChoice.disable_parallel_tool_use === true ? { toolChoice: { type: 'auto', ...noParallel }, isToolChoiceNone: false } : { isToolChoiceNone: false };
    case 'any':
      return { toolChoice: { type: 'any', ...noParallel }, isToolChoiceNone: false };
    case 'tool':
      return { toolChoice: { type: 'tool', name: requireString(toolChoice.name, '`tool_choice.name`'), ...noParallel }, isToolChoiceNone: false };
    default:
      throw toError(`Unsupported \`tool_choice.type\`: ${JSON.stringify(toolChoice.type)}`);
  }
};

const toOutputConfig = (outputConfig: unknown): { effort?: string; format?: Json } => {
  if (outputConfig === undefined) return {};
  if (!getIsObject(outputConfig)) throw toError('`output_config` must be an object');
  const unsupported = Object.keys(outputConfig).filter((key) => key !== 'effort' && key !== 'format');
  if (unsupported.length > 0) throw toError(`Unsupported \`output_config\` field(s) for Claude: ${unsupported.join(', ')}`);
  const effort = outputConfig.effort === undefined ? undefined : requireString(outputConfig.effort, '`output_config.effort`');
  let format: Json | undefined;
  if (outputConfig.format !== undefined) {
    const value = outputConfig.format;
    if (!getIsObject(value) || value.type !== 'json_schema') throw toError('Only `json_schema` structured output is supported for Claude');
    if (!getIsObject(value.schema)) throw toError('`json_schema` structured output needs a `schema`');
    format = { type: 'json_schema', schema: value.schema };
  }
  return { ...(effort === undefined ? {} : { effort }), ...(format === undefined ? {} : { format }) };
};

export const toClaudeNativeRequest = (body: Json): ClaudeNativeRequest => {
  const unsupportedKeys = Object.keys(body).filter((key) => !HANDLED_KEYS.has(key) && !IGNORED_KEYS.has(key));
  if (unsupportedKeys.length > 0) {
    throw toError(`Unsupported field(s) for Claude: ${unsupportedKeys.join(', ')}; they change the request semantics or the official client never sends them`);
  }
  const model = requireString(body.model, '`model`');
  if (body.stream !== undefined && typeof body.stream !== 'boolean') throw toError('`stream` must be a boolean');
  if (typeof body.max_tokens !== 'number' || !Number.isInteger(body.max_tokens) || body.max_tokens <= 0) {
    throw toError('`max_tokens` must be a positive integer');
  }
  const { messages, firstMessage } = toMessages(body.messages);
  const firstUserText = getFirstUserText((body.messages as Json[])[0] as Json);
  const tools = toTools(body.tools);
  // Like the OpenAI path, a tool_choice without tools is dropped.
  const { toolChoice, isToolChoiceNone } = tools.length === 0 ? { toolChoice: undefined, isToolChoiceNone: false } : toToolChoice(body.tool_choice);
  const { effort, format } = toOutputConfig(body.output_config);

  // thinking:{type:"disabled"} is the effort "none"; any other thinking shape is not forwarded:
  // the gateway derives thinking from the home settings and the effort, as on the OpenAI path.
  const ignoredKeys = Object.keys(body).filter((key) => IGNORED_KEYS.has(key));
  let explicitEffort = effort;
  if (body.thinking !== undefined) {
    if (getIsObject(body.thinking) && body.thinking.type === 'disabled') {
      if (effort !== undefined && effort !== 'none') throw toError('Send either `thinking: {"type":"disabled"}` or `output_config.effort`, not both');
      explicitEffort = 'none';
    } else {
      ignoredKeys.push('thinking');
    }
  }

  return {
    model,
    native: {
      messages,
      callerTexts: toCallerTexts(body.system),
      tools,
      ...(toolChoice === undefined ? {} : { toolChoice }),
      isToolChoiceNone,
      ...(explicitEffort === undefined ? {} : { explicitEffort }),
      maxTokens: body.max_tokens,
      ...(format === undefined ? {} : { format }),
      firstUserText,
    },
    isStream: body.stream === true,
    ignoredKeys,
    firstMessage,
  };
};
