// OpenAI Responses-shaped request -> Claude Messages request.
// Deliberately separate from responses/normalizeResponsesRequest.ts: none of the Codex
// Responses Lite wrappers, Codex headers, store/include/prompt-cache fields or ultra->max rules
// may reach Claude. Behaviour anchors are listed in docs/CLAUDE_UPSTREAM_PROTOCOL_DIFF.md.
import {
  CLAUDE_CODE_BETA,
  CLAUDE_CLI_SYSTEM_PREFIX,
  CLAUDE_CONTEXT_MANAGEMENT_BETA,
  CLAUDE_EFFORT_BETA,
  CLAUDE_INTERLEAVED_THINKING_BETA,
  CLAUDE_MIN_THINKING_BUDGET_TOKENS,
  CLAUDE_PROMPT_CACHING_SCOPE_BETA,
  CLAUDE_REDACT_THINKING_BETA,
  CLAUDE_STRUCTURED_OUTPUTS_BETA,
  CLAUDE_THINKING_TOKEN_COUNT_BETA,
} from '../constants.js';
import { createProxyError } from '../errors.js';
import type { Json } from '../types.js';
import { getClaudeBillingHeader, getClaudeEffectiveEntrypoint } from './attribution.js';
import { canonicalizeClaudeModelId, supportsClaudeEffort, supportsClaudeInterleavedThinking, supportsClaudeMidConversationSystem, supportsClaudeStructuredOutput } from './modelMetadata.js';
import { getClaudeThinkingBudget, getClaudeThinkingMode, resolveClaudeThinking } from './settings.js';
import { getClaudeAssistantBoundaries, getClaudeInputItems, isBoundaryNeutralItem, normalizeClaudeToolInput } from './state.js';
import type { ClaudeAssistantBoundary } from './state.js';
import type { ClaudeModelMetadata, ClaudeRequest, ClaudeSettings, ClaudeThinking, ClaudeTurnState } from './types.js';

export type PrepareClaudeRequestInput = {
  body: Json;
  modelId: string;
  alias: string;
  metadata?: ClaudeModelMetadata;
  liveModel?: Json;
  settings: ClaudeSettings;
  // Native content for the unfinished tool-use turn, resolved by the caller from state.
  state?: ClaudeTurnState;
  // Native content for earlier assistant boundaries, keyed by `prefixIdentity\u0000visibleIdentity`.
  boundaryStates?: ReadonlyMap<string, ClaudeTurnState>;
  // Gateway session identity and the home's account record, sent as the official `metadata.user_id`
  // JSON envelope (nUe at binary offset 218996645). Omitted when the caller has no session.
  session?: { sessionId: string; accountUuid: string; deviceId?: string };
};

export type PreparedClaudeRequest = {
  request: ClaudeRequest;
  betas: string[];
  // The configuration actually sent, including the final budget_tokens, so the next request of the
  // same turn replays it unchanged instead of re-deriving it from a different max_output_tokens.
  thinking: ClaudeThinking;
  maxTokens: number;
};

const SUPPORTED_IMAGE_MEDIA_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];

const getItemText = (item: Json): string => {
  if (typeof item.content === 'string') return item.content;
  if (!Array.isArray(item.content)) return '';
  return (item.content as Json[]).map((part) => (typeof part.text === 'string' ? part.text : '')).join('');
};

const toImageBlock = (part: Json): Json => {
  const url = typeof part.image_url === 'string' ? part.image_url : typeof part.url === 'string' ? part.url : '';
  if (url === '') throw createProxyError({ status: 400, message: 'Image content needs `image_url` or `url`' });
  const dataMatch = /^data:([^;,]+);base64,(.+)$/s.exec(url);
  if (dataMatch) {
    const mediaType = dataMatch[1] ?? '';
    if (!SUPPORTED_IMAGE_MEDIA_TYPES.includes(mediaType)) {
      throw createProxyError({ status: 400, message: `Unsupported image media type: ${mediaType}` });
    }
    return { type: 'image', source: { type: 'base64', media_type: mediaType, data: dataMatch[2] } };
  }
  if (!url.startsWith('https://')) throw createProxyError({ status: 400, message: 'Image URLs must be https:// or a base64 data URL' });
  return { type: 'image', source: { type: 'url', url } };
};

const toContentParts = (item: Json): Json[] =>
  (Array.isArray(item.content) ? (item.content as Json[]) : [{ type: 'input_text', text: getItemText(item) }]).map((part) => {
    if (part.type === 'input_text' || part.type === 'text') return { type: 'text', text: String(part.text ?? '') };
    if (part.type === 'input_image' || part.type === 'image_url' || part.type === 'image') return toImageBlock(part);
    throw createProxyError({ status: 400, message: `Unsupported content part type: ${String(part.type)}` });
  });

const toToolResultContent = (output: unknown): Json[] => {
  if (typeof output === 'string') return [{ type: 'text', text: output }];
  if (Array.isArray(output)) {
    return (output as Json[]).map((part) => {
      if (part.type === 'input_text' || part.type === 'text') return { type: 'text', text: String(part.text ?? '') };
      if (part.type === 'input_image' || part.type === 'image') return toImageBlock(part);
      throw createProxyError({ status: 400, message: `Unsupported tool result part type: ${String(part.type)}` });
    });
  }
  return [{ type: 'text', text: JSON.stringify(output ?? '') }];
};

// The whole JSON Schema is forwarded: $defs, additionalProperties, combinators and constraints are
// part of the tool contract, and a dropped `$defs` entry leaves a dangling `$ref` upstream.
const toClaudeTool = (tool: Json): Json => {
  if (tool.type !== 'function') {
    throw createProxyError({ status: 400, message: `Only \`function\` tools are supported for Claude, got "${String(tool.type)}"` });
  }
  const parameters = tool.parameters ?? { type: 'object', properties: {} };
  if (typeof parameters !== 'object' || parameters === null || Array.isArray(parameters)) {
    throw createProxyError({ status: 400, message: '`tools[].parameters` must be a JSON Schema object' });
  }
  const schema = parameters as Json;
  if (schema.type !== undefined && schema.type !== 'object') {
    throw createProxyError({ status: 400, message: '`tools[].parameters` must describe an object' });
  }
  return {
    name: String(tool.name ?? ''),
    ...(typeof tool.description === 'string' && tool.description !== '' ? { description: tool.description } : {}),
    input_schema: { type: 'object', properties: {}, ...schema },
  };
};

// parallel_tool_calls:false is kept on every explicit choice (Claude's own flag name).
const toClaudeToolChoice = (toolChoice: unknown, parallelToolCalls: unknown): Json | undefined => {
  const noParallel = parallelToolCalls === false ? { disable_parallel_tool_use: true } : {};
  if (toolChoice === undefined || toolChoice === 'auto') {
    return parallelToolCalls === false ? { type: 'auto', ...noParallel } : undefined;
  }
  if (toolChoice === 'required') return { type: 'any', ...noParallel };
  if (typeof toolChoice === 'object' && toolChoice !== null && (toolChoice as Json).type === 'function') {
    const fn = (toolChoice as Json).function as Json | undefined;
    return { type: 'tool', name: String(fn?.name ?? (toolChoice as Json).name ?? ''), ...noParallel };
  }
  throw createProxyError({ status: 400, message: `Unsupported \`tool_choice\`: ${JSON.stringify(toolChoice)}` });
};

// OpenAI structured output -> Claude output_config.format (rNr at binary offset 226584124, format
// schema at 216817066). `json_object` has no equivalent in this release, so it stays rejected.
const getClaudeOutputFormat = (body: Json, modelId: string): Json | undefined => {
  const text = (body.text ?? {}) as Json;
  const format = text.format ?? body.response_format;
  if (format === undefined) return undefined;
  if (typeof format !== 'object' || format === null) {
    throw createProxyError({ status: 400, message: '`text.format` must be an object' });
  }
  const type = (format as Json).type;
  if (type !== 'json_schema') {
    throw createProxyError({ status: 400, message: `Only \`json_schema\` structured output is supported for Claude, got "${String(type)}"` });
  }
  const wrapper = (format as Json).json_schema ?? format;
  const schema = (wrapper as Json).schema;
  if (typeof schema !== 'object' || schema === null) {
    throw createProxyError({ status: 400, message: '`json_schema` structured output needs a `schema`' });
  }
  if (!supportsClaudeStructuredOutput(modelId)) {
    throw createProxyError({ status: 400, message: `Model "${modelId}" does not support structured output` });
  }
  return { type: 'json_schema', schema };
};

// Assistant tool-call arguments must describe an object on their own, independent of the canonical
// identity hashing: a truncated JSON string like `{"x":` would otherwise be re-encoded as a JSON
// string and reach upstream as a string `input`.
const parseToolCallArguments = (value: unknown, callId: string): Json => {
  if (value === undefined || value === null || value === '') return {};
  if (typeof value === 'object' && !Array.isArray(value)) return value as Json;
  if (typeof value === 'string') {
    let parsed: unknown;
    try {
      parsed = JSON.parse(value);
    } catch {
      throw createProxyError({ status: 400, message: `Tool call arguments are not valid JSON for "${callId}"` });
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw createProxyError({ status: 400, message: `Tool call arguments for "${callId}" must be a JSON object` });
    }
    return parsed as Json;
  }
  throw createProxyError({ status: 400, message: `Tool call arguments for "${callId}" must be a string or an object` });
};

const TEXT_PART_TYPES = ['input_text', 'text', 'output_text'];

const validateContentParts = (content: unknown, role: string): void => {
  if (content === undefined || content === null || typeof content === 'string') return;
  if (!Array.isArray(content)) {
    throw createProxyError({ status: 400, message: `\`content\` must be a string or an array for the "${role}" message` });
  }
  for (const part of content as Json[]) {
    if (typeof part !== 'object' || part === null || typeof part.type !== 'string') {
      throw createProxyError({ status: 400, message: 'Each `content` part needs a string `type`' });
    }
    if (TEXT_PART_TYPES.includes(part.type) && typeof part.text !== 'string') {
      throw createProxyError({ status: 400, message: `Each "${part.type}" content part needs a string \`text\`` });
    }
    // system/developer content becomes plain system text, so anything that is not text must be
    // rejected instead of silently dropped (same rule assertClaudeChatInput applies to Chat).
    if ((role === 'system' || role === 'developer') && part.type !== 'text' && part.type !== 'input_text') {
      throw createProxyError({ status: 400, message: `The "${role}" message cannot carry "${part.type}" content for Claude` });
    }
  }
};

const validateToolResultOutput = (output: unknown): void => {
  if (!Array.isArray(output)) return;
  for (const part of output as Json[]) {
    if (typeof part !== 'object' || part === null || typeof part.type !== 'string') {
      throw createProxyError({ status: 400, message: 'Each `output` part of a `function_call_output` needs a string `type`' });
    }
    if (TEXT_PART_TYPES.includes(part.type) && typeof part.text !== 'string') {
      throw createProxyError({ status: 400, message: `Each "${part.type}" tool result part needs a string \`text\`` });
    }
  }
};

// Malformed ordinary input must be a 400 before any state identity read, not a raw TypeError.
const validateInputItem = (item: unknown): void => {
  if (typeof item !== 'object' || item === null) {
    throw createProxyError({ status: 400, message: 'Each `input` item must be an object' });
  }
  const value = item as Json;
  if (typeof value.type !== 'string') {
    throw createProxyError({ status: 400, message: 'Each `input` item needs a string `type`' });
  }
  switch (value.type) {
    case 'message':
      if (value.role !== undefined && typeof value.role !== 'string') {
        throw createProxyError({ status: 400, message: 'A `message` item needs a string `role`' });
      }
      validateContentParts(value.content, typeof value.role === 'string' ? value.role : 'user');
      return;
    case 'function_call':
      if (value.call_id !== undefined && typeof value.call_id !== 'string') {
        throw createProxyError({ status: 400, message: 'A `function_call` item needs a string `call_id`' });
      }
      if (value.name !== undefined && typeof value.name !== 'string') {
        throw createProxyError({ status: 400, message: 'A `function_call` item needs a string `name`' });
      }
      parseToolCallArguments(value.arguments, String(value.call_id ?? ''));
      return;
    case 'function_call_output':
      if (value.call_id !== undefined && typeof value.call_id !== 'string') {
        throw createProxyError({ status: 400, message: 'A `function_call_output` item needs a string `call_id`' });
      }
      validateToolResultOutput(value.output);
      return;
    case 'reasoning':
    case 'additional_tools':
      return;
    default:
      throw createProxyError({ status: 400, message: `Unsupported input item type: ${String(value.type)}` });
  }
};

const getVisibleCalls = (items: Json[]): { id: string; name: string; arguments: string }[] =>
  items
    .filter((item) => item.type === 'function_call')
    .map((item) => ({ id: String(item.call_id ?? ''), name: String(item.name ?? ''), arguments: normalizeClaudeToolInput(item.arguments) }));

const getVisibleText = (items: Json[]): string =>
  items.filter((item) => item.type === 'message' && item.role === 'assistant').map(getItemText).join('');

// A stored native turn is replayed verbatim; the client-visible echo must still describe the same
// turn, otherwise the signed blocks no longer match what is being continued.
const assertBoundaryMatches = (state: ClaudeTurnState, boundaryItems: Json[]): void => {
  const visibleCalls = getVisibleCalls(boundaryItems);
  const nativeCalls = state.assistantContent
    .filter((block) => block.type === 'tool_use')
    .map((block) => ({ id: String(block.id ?? ''), name: String(block.name ?? ''), arguments: normalizeClaudeToolInput(block.input ?? {}) }));
  if (visibleCalls.length !== nativeCalls.length) {
    throw createProxyError({
      status: 400,
      message: `Claude turn state does not match the request: expected ${nativeCalls.length} tool call(s), got ${visibleCalls.length}`,
    });
  }
  nativeCalls.forEach((nativeCall, index) => {
    const visible = visibleCalls[index];
    if (visible === undefined || visible.id !== nativeCall.id) {
      throw createProxyError({ status: 400, message: `Claude turn state does not match the request: tool call "${nativeCall.id}" is missing` });
    }
    if (visible.name !== nativeCall.name || visible.arguments !== nativeCall.arguments) {
      throw createProxyError({
        status: 400,
        message: `Assistant tool call "${nativeCall.id}" changed since it was generated; thinking cannot be replayed`,
      });
    }
  });
  if (getVisibleText(boundaryItems) !== state.assistantContent.filter((block) => block.type === 'text').map((block) => String(block.text ?? '')).join('')) {
    throw createProxyError({ status: 400, message: 'Assistant text changed since it was generated; thinking cannot be replayed' });
  }
};

export const getClaudeBoundaryStateKey = (boundary: ClaudeAssistantBoundary): string =>
  `${boundary.prefixIdentity}\u0000${boundary.visibleIdentity}`;

const getBoundaryState = (
  boundary: ClaudeAssistantBoundary,
  items: Json[],
  state: ClaudeTurnState | undefined,
  boundaryStates: ReadonlyMap<string, ClaudeTurnState> | undefined,
): ClaudeTurnState | undefined => {
  const found = boundaryStates?.get(getClaudeBoundaryStateKey(boundary));
  const resolved = found ?? (boundary.callIds.length > 0 && boundary.callIds.every((callId) => state?.callIds.includes(callId)) ? state : undefined);
  if (resolved === undefined) return undefined;
  assertBoundaryMatches(resolved, items.slice(boundary.start, boundary.end));
  return resolved;
};

// The official cache builder (NNr at 226725197) marks ONE message: ryn at 226486727 scans
// backwards for the last eligible message via oyn at 226486225. A user message is always
// eligible; an assistant message only when its LAST block passes E7e at 226486043 (empty text,
// thinking, redacted_thinking and fallback blocks are ineligible, tool_use IS eligible). An
// assistant ending in thinking is skipped whole, so the marker moves to an EARLIER message,
// never to an earlier block inside that same assistant. sNr at 226585288 / iNr at 226586013
// then mark that message's last block with the default z4 marker at 226582681
// ({type:"ephemeral"}; a ttl is only added as "1h" for allowlisted subscriber contexts, which
// the gateway does not model). Tools carry no marker; the system side carries its own markers
// on the prefix and joined-caller blocks ($Nr at 226727459 over the K_o mapping at 218995076).
const isStampableLastBlock = (block: Json): boolean => {
  if (block.type === 'text') return typeof block.text === 'string' && block.text !== '';
  return block.type !== 'thinking' && block.type !== 'redacted_thinking' && block.type !== 'fallback';
};

const markTailBlock = (blocks: Json[], index: number): void => {
  blocks[index] = { ...blocks[index], cache_control: { type: 'ephemeral' } };
};

const markLastEligibleMessage = (messages: Json[]): void => {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const content = messages[index]?.content;
    if (!Array.isArray(content) || content.length === 0) continue;
    const blocks = content as Json[];
    if (messages[index]?.role === 'assistant') {
      const last = blocks[blocks.length - 1] as Json | undefined;
      if (last !== undefined && typeof last === 'object' && last !== null && isStampableLastBlock(last)) {
        markTailBlock(blocks, blocks.length - 1);
        return;
      }
      continue;
    }
    // sNr marks the last block after rkn at 226585570 drops empty/whitespace text blocks.
    for (let block = blocks.length - 1; block >= 0; block -= 1) {
      const candidate = blocks[block] as Json | undefined;
      if (candidate?.type === 'text' && String(candidate.text ?? '').trim() === '') continue;
      markTailBlock(blocks, block);
      return;
    }
  }
};

// Malformed ordinary input must be a 400 before any state identity read, not a raw TypeError.
// handleClaude runs this before computing conversation identities; prepareClaudeRequest runs it
// again so direct callers get the same guarantee.
export const validateClaudeResponsesInput = (body: Json): void => {
  if (body.previous_response_id !== undefined && body.previous_response_id !== null) {
    throw createProxyError({ status: 400, message: '`previous_response_id` is not supported: send the full input' });
  }
  if (body.instructions !== undefined && body.instructions !== null && typeof body.instructions !== 'string') {
    throw createProxyError({ status: 400, message: '`instructions` must be a string' });
  }
  for (const item of getClaudeInputItems(body)) validateInputItem(item);
  if (body.tools !== undefined) {
    if (!Array.isArray(body.tools)) throw createProxyError({ status: 400, message: '`tools` must be an array' });
    for (const tool of body.tools as Json[]) {
      if (typeof tool !== 'object' || tool === null) throw createProxyError({ status: 400, message: 'Each `tools` entry must be an object' });
    }
  }
};

export const prepareClaudeRequest = (input: PrepareClaudeRequestInput): PreparedClaudeRequest => {
  const { body, modelId, metadata, liveModel, settings, state, boundaryStates, session } = input;
  validateClaudeResponsesInput(body);
  const items = getClaudeInputItems(body);
  const instructions = typeof body.instructions === 'string' ? body.instructions : undefined;
  const boundaries = getClaudeAssistantBoundaries(items, { instructions });
  const resolvedBoundaries = new Map<ClaudeAssistantBoundary, ClaudeTurnState>();
  for (const boundary of boundaries) {
    const record = getBoundaryState(boundary, items, state, boundaryStates);
    if (record !== undefined) resolvedBoundaries.set(boundary, record);
  }

  // The unfinished tool-use turn is the only one whose thinking configuration is pinned. Without
  // its stored state the signed blocks cannot be restored, and a thinking-capable model must not
  // silently continue with unsigned content.
  const pending = boundaries.find((boundary) => boundary.isPendingToolTurn);
  const pinned = pending === undefined ? undefined : resolvedBoundaries.get(pending);
  if (pending !== undefined && pinned === undefined && getClaudeThinkingMode(modelId, metadata) !== undefined) {
    throw createProxyError({
      status: 400,
      message: 'No stored Claude thinking state for this conversation, so thinking blocks cannot be replayed; start a new turn',
    });
  }
  // A stored thinking configuration is only replayable on a model that can actually run it; a
  // record copied from another model must not smuggle thinking into an unsigned conversation.
  if (pinned !== undefined) {
    const mode = getClaudeThinkingMode(modelId, metadata);
    if (mode === undefined) {
      throw createProxyError({ status: 400, message: `Stored Claude thinking state cannot be replayed on "${modelId}"; start a new conversation` });
    }
    if (pinned.thinking.type === 'adaptive' && mode !== 'adaptive') {
      throw createProxyError({ status: 400, message: `Stored adaptive thinking state cannot be replayed on "${modelId}"; start a new conversation` });
    }
  }

  const callerTexts: string[] = [];
  if (instructions !== undefined && instructions !== '') callerTexts.push(instructions);

  const messages: Json[] = [];
  const appendBlock = (role: string, block: Json): void => {
    const last = messages[messages.length - 1];
    if (last?.role === role) (last.content as Json[]).push(block);
    else messages.push({ role, content: [block] });
  };
  const appendVisibleAssistant = (item: Json): void => {
    if (item.type === 'function_call') {
      const callId = String(item.call_id ?? '');
      appendBlock('assistant', { type: 'tool_use', id: callId, name: String(item.name ?? ''), input: parseToolCallArguments(item.arguments, callId) });
      return;
    }
    for (const part of Array.isArray(item.content) ? (item.content as Json[]) : []) {
      if (part.type === 'refusal') continue;
      if (part.type !== 'output_text' && part.type !== 'text') {
        throw createProxyError({ status: 400, message: `Assistant messages cannot contain "${String(part.type)}" content for Claude` });
      }
    }
    const textValue = getItemText(item);
    if (textValue !== '') appendBlock('assistant', { type: 'text', text: textValue });
  };

  for (let index = 0; index < items.length; index += 1) {
    const item = items[index] as Json;
    const boundary = boundaries.find((candidate) => candidate.start === index);
    if (boundary !== undefined) {
      const record = resolvedBoundaries.get(boundary);
      if (record !== undefined) {
        // The complete native assistant content, exactly once, in its original position.
        for (const block of record.assistantContent) appendBlock('assistant', block);
      } else {
        for (const assistantItem of items.slice(boundary.start, boundary.end)) {
          if (isBoundaryNeutralItem(assistantItem)) continue;
          appendVisibleAssistant(assistantItem);
        }
      }
      index = boundary.end - 1;
      continue;
    }
    switch (item.type) {
      case 'additional_tools':
      case 'reasoning':
        continue;
      case 'message': {
        const role = String(item.role ?? 'user');
        if (role === 'system' || role === 'developer') {
          const textValue = getItemText(item);
          if (textValue !== '') callerTexts.push(textValue);
          continue;
        }
        if (role === 'assistant') {
          appendVisibleAssistant(item);
          continue;
        }
        if (role !== 'user') throw createProxyError({ status: 400, message: `Unsupported message role: ${role}` });
        for (const part of toContentParts(item)) appendBlock('user', part);
        continue;
      }
      case 'function_call':
        appendVisibleAssistant(item);
        continue;
      case 'function_call_output':
        appendBlock('user', { type: 'tool_result', tool_use_id: String(item.call_id ?? ''), content: toToolResultContent(item.output) });
        continue;
      default:
        throw createProxyError({ status: 400, message: `Unsupported input item type: ${String(item.type)}` });
    }
  }

  if (messages.length === 0) throw createProxyError({ status: 400, message: '`input` must contain at least one message' });
  if (messages[0]?.role !== 'user') {
    throw createProxyError({ status: 400, message: 'Claude requires the first message to come from the user' });
  }

  const tools = Array.isArray(body.tools) ? (body.tools as Json[]).map(toClaudeTool) : [];
  const isToolChoiceNone = body.tool_choice === 'none';
  const reasoning = (body.reasoning ?? {}) as Json;
  const explicitEffort = typeof reasoning.effort === 'string' ? reasoning.effort : undefined;
  const thinking = resolveClaudeThinking({ modelId, metadata, settings, explicitEffort, pinned: pinned?.thinking });
  const isThinkingEnabled = thinking.type !== 'disabled';

  // The official client demotes a forced tool choice while thinking is active (binary offset
  // 226635226). The gateway keeps the caller's explicit semantics instead, so the combination that
  // upstream rejects is reported rather than silently rewritten.
  let toolChoice = isToolChoiceNone || tools.length === 0 ? undefined : toClaudeToolChoice(body.tool_choice, body.parallel_tool_calls);
  if (isThinkingEnabled && (toolChoice?.type === 'any' || toolChoice?.type === 'tool')) {
    throw createProxyError({
      status: 400,
      message: `\`tool_choice\` "${String(toolChoice.type)}" cannot be combined with thinking on this model; send \`reasoning.effort: "none"\` or \`tool_choice: "auto"\``,
    });
  }

  if (body.max_output_tokens !== undefined && (typeof body.max_output_tokens !== 'number' || !Number.isInteger(body.max_output_tokens) || body.max_output_tokens <= 0)) {
    throw createProxyError({ status: 400, message: '`max_output_tokens` must be a positive integer' });
  }
  const maxTokens =
    typeof body.max_output_tokens === 'number'
      ? body.max_output_tokens
      : typeof liveModel?.max_tokens === 'number'
        ? liveModel.max_tokens
        : metadata?.maxOutputDefault ?? metadata?.maxOutputUpper;
  if (maxTokens === undefined) {
    throw createProxyError({ status: 400, message: `Unknown Claude model "${modelId}"; send \`max_output_tokens\`` });
  }
  if (metadata !== undefined && maxTokens > metadata.maxOutputUpper) {
    throw createProxyError({ status: 400, message: `\`max_output_tokens\` exceeds the ${modelId} limit of ${metadata.maxOutputUpper}` });
  }

  const request: ClaudeRequest = { model: modelId, messages, max_tokens: maxTokens, stream: true };
  // K_o tail branch at binary offset 218995076 via the $Nr block mapping at 226727459: the
  // billing text (wSo at 218606801) carries no cache marker, the interactive CLI prefix (el at
  // 218994031) is cached, and the remaining caller texts join with two newlines into ONE cached
  // block. The gateway always sends the default ephemeral marker without a ttl (see doc §8).
  const systemBlocks: Json[] = [];
  const billingHeader = getClaudeBillingHeader(items);
  if (billingHeader !== '') systemBlocks.push({ type: 'text', text: billingHeader });
  systemBlocks.push({ type: 'text', text: CLAUDE_CLI_SYSTEM_PREFIX, cache_control: { type: 'ephemeral' } });
  const callerText = callerTexts.join('\n\n');
  request.system = systemBlocks;
  markLastEligibleMessage(messages);
  if (callerText !== '') {
    const callerBlock = { type: 'text', text: callerText, cache_control: { type: 'ephemeral' } };
    if (supportsClaudeMidConversationSystem(modelId)) {
      // Mirrors references/CLIProxyAPI insertClaudeMidConversationSystemBlocks. Adjacent users
      // are already merged. Native 2.1.299 marks this feature GA, so no beta header is needed.
      messages.splice(1, 0, { role: 'system', content: [callerBlock] });
    } else {
      // Preserve system authority on legacy models instead of lowering it to a user reminder.
      systemBlocks.push(callerBlock);
    }
  }
  if (!isToolChoiceNone && tools.length > 0) request.tools = tools;
  if (toolChoice !== undefined) request.tool_choice = toolChoice;
  if (session !== undefined) {
    // nUe at binary offset 218996645: metadata.user_id is a JSON string carrying device_id,
    // account_uuid and session_id. device_id is the home's persisted `userID` (BO at 217681149);
    // it is forwarded when the config has one and omitted when it does not, because the official
    // fallback GENERATES and persists a new id into the official config, which the gateway never
    // writes (see the protocol diff doc).
    request.metadata = {
      user_id: JSON.stringify({
        ...(session.deviceId === undefined ? {} : { device_id: session.deviceId }),
        account_uuid: session.accountUuid,
        session_id: session.sessionId,
      }),
    };
  }

  const betas: string[] = [];
  // SL at 217935458: the claude-code beta goes out for every canonical id that is not a haiku.
  if (!canonicalizeClaudeModelId(modelId).includes('haiku')) betas.push(CLAUDE_CODE_BETA);
  // references/CLIProxyAPI's subscription baseline, retaining native 2.1.299 model gates.
  if (supportsClaudeInterleavedThinking(modelId, metadata)) {
    betas.push(CLAUDE_INTERLEAVED_THINKING_BETA);
    if (getClaudeEffectiveEntrypoint() === 'cli') betas.push(CLAUDE_REDACT_THINKING_BETA);
    betas.push(CLAUDE_THINKING_TOKEN_COUNT_BETA, CLAUDE_CONTEXT_MANAGEMENT_BETA);
  }
  betas.push(CLAUDE_PROMPT_CACHING_SCOPE_BETA);
  if (isThinkingEnabled) {
    if (thinking.type === 'adaptive') {
      request.thinking = { type: 'adaptive' };
    } else {
      // The budget floor is 1024 (226635226), so a smaller max_output_tokens can never leave room
      // for thinking on a budget-form model; reject it before spending a network call.
      if (maxTokens <= CLAUDE_MIN_THINKING_BUDGET_TOKENS) {
        throw createProxyError({
          status: 400,
          message: `\`max_output_tokens\` must exceed the ${CLAUDE_MIN_THINKING_BUDGET_TOKENS}-token thinking budget floor on "${modelId}"; lower \`reasoning.effort\` or raise \`max_output_tokens\``,
        });
      }
      const ceiling = Math.min(metadata?.maxOutputUpper ?? maxTokens, maxTokens) - 1;
      if (pinned !== undefined && thinking.budgetTokens !== undefined && thinking.budgetTokens > ceiling) {
        throw createProxyError({
          status: 400,
          message: `Cannot lower \`max_output_tokens\` mid-turn: this turn already budgets ${thinking.budgetTokens} thinking tokens`,
        });
      }
      const budget = getClaudeThinkingBudget(thinking, metadata, maxTokens);
      request.thinking = { type: 'enabled', budget_tokens: budget };
      thinking.budgetTokens = budget;
    }
  } else if (getClaudeThinkingMode(modelId, metadata) !== undefined) {
    // Binary offset 226633000: a model that allows disabling thinking gets an explicit disabled
    // thinking block instead of an omitted one.
    request.thinking = { type: 'disabled' };
  }

  const outputConfig: Json = {};
  // tGe at 226583782: whenever the model supports effort (bb), the effort beta goes out, and a
  // resolved effort string is sent as output_config.effort.
  if (supportsClaudeEffort(modelId, metadata)) {
    betas.push(CLAUDE_EFFORT_BETA);
    if (thinking.effort !== undefined) outputConfig.effort = thinking.effort;
  }
  const format = getClaudeOutputFormat(body, modelId);
  if (format !== undefined) {
    outputConfig.format = format;
    betas.push(CLAUDE_STRUCTURED_OUTPUTS_BETA);
  }
  if (Object.keys(outputConfig).length > 0) request.output_config = outputConfig;

  return { request, betas, thinking, maxTokens };
};

// Chat -> Responses conversion (chat/toResponsesRequest.ts) keeps only the text parts of system,
// assistant and tool messages. For Claude that lossy draft would change the conversation, so the
// original chat body is checked first and anything the conversion would drop or crash on is a 400.
// The shared converter itself stays untouched, so Codex behaviour is unchanged.
export const assertClaudeChatInput = (body: Json): void => {
  if (body.tools !== undefined && !Array.isArray(body.tools)) {
    throw createProxyError({ status: 400, message: '`tools` must be an array' });
  }
  for (const tool of (body.tools as Json[] | undefined) ?? []) {
    if (typeof tool !== 'object' || tool === null) {
      throw createProxyError({ status: 400, message: 'Each `tools` entry must be an object' });
    }
  }
  const maxTokens = body.max_completion_tokens ?? body.max_tokens;
  if (maxTokens !== undefined && (!Number.isInteger(maxTokens) || (maxTokens as number) < 1)) {
    throw createProxyError({ status: 400, message: '`max_completion_tokens` must be a positive integer' });
  }
  if (body.response_format !== undefined && body.response_format !== null) {
    if (typeof body.response_format !== 'object' || Array.isArray(body.response_format)) {
      throw createProxyError({ status: 400, message: '`response_format` must be an object' });
    }
    const formatType = String((body.response_format as Json).type ?? '');
    if (!['text', 'json_object', 'json_schema'].includes(formatType)) {
      throw createProxyError({ status: 400, message: `Unsupported \`response_format.type\` "${formatType}" for Claude` });
    }
  }
  if (!Array.isArray(body.messages)) return;
  for (const message of body.messages as Json[]) {
    if (typeof message !== 'object' || message === null) {
      throw createProxyError({ status: 400, message: 'Each `messages` entry must be an object' });
    }
    if (message.tool_calls !== undefined) {
      if (!Array.isArray(message.tool_calls)) {
        throw createProxyError({ status: 400, message: '`tool_calls` must be an array' });
      }
      for (const toolCall of message.tool_calls as Json[]) {
        if (typeof toolCall !== 'object' || toolCall === null) {
          throw createProxyError({ status: 400, message: 'Each `tool_calls` entry must be an object' });
        }
        const fn = toolCall.function;
        if (typeof fn !== 'object' || fn === null || typeof (fn as Json).name !== 'string') {
          throw createProxyError({ status: 400, message: 'Each `tool_calls` entry needs a `function.name`' });
        }
      }
    }
    const role = String(message.role ?? '');
    if (message.content === undefined || message.content === null || typeof message.content === 'string') continue;
    if (!Array.isArray(message.content)) {
      throw createProxyError({ status: 400, message: `\`content\` must be a string or an array for the "${role}" message` });
    }
    for (const part of message.content as Json[]) {
      if (typeof part !== 'object' || part === null || typeof part.type !== 'string') {
        throw createProxyError({ status: 400, message: 'Each `content` part needs a `type`' });
      }
      if (part.type === 'text' && typeof part.text !== 'string') {
        throw createProxyError({ status: 400, message: 'Each `text` content part needs a string `text`' });
      }
      if (role === 'user') continue;
      if (part.type !== 'text') {
        throw createProxyError({ status: 400, message: `The "${role}" message cannot carry "${part.type}" content for Claude` });
      }
    }
  }
};
