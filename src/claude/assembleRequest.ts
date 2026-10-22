// Assembly layer shared by every gateway-built Claude request (the OpenAI-compatible endpoints and
// the Anthropic downgrade path): normalized native input -> the official request shape. Official
// anchors (native release 2.1.299) are listed in docs/CLAUDE_UPSTREAM_PROTOCOL_DIFF.md; the caller
// placement follows references/CLIProxyAPI v8.0.29 claude_executor_cloaking.go.
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
import { getClaudeBillingHeaderFromText, getClaudeEffectiveEntrypoint } from './attribution.js';
import { canonicalizeClaudeModelId, supportsClaudeEffort, supportsClaudeInterleavedThinking, supportsClaudeMidConversationSystem, supportsClaudeStructuredOutput } from './modelMetadata.js';
import { getClaudeThinkingBudget, getClaudeThinkingMode, resolveClaudeThinking } from './settings.js';
import type { ClaudeModelMetadata, ClaudeRequest, ClaudeSettings, ClaudeThinking } from './types.js';

// What a client asked for, already in native Claude form and validated for shape.
export type ClaudeNativeInput = {
  // Native messages: user first, adjacent same-role messages merged, no cache markers yet.
  messages: Json[];
  // Caller system texts in order; they join into one cached block.
  callerTexts: string[];
  tools: Json[];
  // Native tool_choice for a non-empty tool list; `none` drops the tools instead.
  toolChoice?: Json;
  isToolChoiceNone: boolean;
  explicitEffort?: string;
  maxTokens?: number;
  // Native output_config.format, e.g. { type: 'json_schema', schema }.
  format?: Json;
  // Billing fingerprint source (qB at 222259800).
  firstUserText: string;
  // Thinking configuration pinned by an unfinished, stored tool turn.
  pinnedThinking?: ClaudeThinking;
};

// Field names of the caller's API, so a 400 points at what the client actually sent.
export type ClaudeRequestFieldNames = { maxTokens: string; effort: string; disableThinking: string; autoToolChoice: string };

const OPENAI_FIELD_NAMES: ClaudeRequestFieldNames = {
  maxTokens: '`max_output_tokens`',
  effort: '`reasoning.effort`',
  disableThinking: '`reasoning.effort: "none"`',
  autoToolChoice: '`tool_choice: "auto"`',
};

export type AssembleClaudeRequestInput = {
  native: ClaudeNativeInput;
  modelId: string;
  metadata?: ClaudeModelMetadata;
  liveModel?: Json;
  settings: ClaudeSettings;
  // Gateway session identity and the home's account record, sent as the official `metadata.user_id`
  // JSON envelope (nUe at binary offset 218996645). Omitted when the caller has no session.
  session?: { sessionId: string; accountUuid: string; deviceId?: string };
  fieldNames?: ClaudeRequestFieldNames;
  extraBody?: Json;
  extraBetas?: string[];
};

export type PreparedClaudeRequest = {
  request: ClaudeRequest;
  betas: string[];
  // The configuration actually sent, including the final budget_tokens, so the next request of the
  // same turn replays it unchanged instead of re-deriving it from a different max_output_tokens.
  thinking: ClaudeThinking;
  maxTokens: number;
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

// Mirrors native 2.1.307 Ahn (static read of the official binary, byte 250597395): user-array
// text blocks with non-string or blank text are dropped; an emptied list becomes the exact
// [{type:"text",text:"(no content)"}] placeholder. Returns undefined when nothing is removed.
const cleanUserTextBlocks = (blocks: Json[]): Json[] | undefined => {
  let kept: Json[] | undefined;
  for (let index = 0; index < blocks.length; index += 1) {
    const block = blocks[index] as Json | undefined;
    if (block?.type === 'text' && (typeof block.text !== 'string' || (block.text as string).trim() === '')) kept ??= blocks.slice(0, index);
    else kept?.push(block as Json);
  }
  if (kept === undefined) return undefined;
  return kept.length > 0 ? kept : [{ type: 'text', text: '(no content)' }];
};

export const markLastEligibleMessage = (messages: Json[]): void => {
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

export const assembleClaudeRequest = (input: AssembleClaudeRequestInput): PreparedClaudeRequest => {
  const { native, modelId, metadata, liveModel, settings, session, fieldNames = OPENAI_FIELD_NAMES } = input;
  const { messages, callerTexts, tools, toolChoice, isToolChoiceNone, explicitEffort, format, firstUserText, pinnedThinking } = native;
  const thinking = resolveClaudeThinking({ modelId, metadata, settings, explicitEffort, pinned: pinnedThinking });
  const isThinkingEnabled = thinking.type !== 'disabled';

  // The official client demotes a forced tool choice while thinking is active (binary offset
  // 226635226). The gateway keeps the caller's explicit semantics instead, so the combination that
  // upstream rejects is reported rather than silently rewritten.
  if (isThinkingEnabled && (toolChoice?.type === 'any' || toolChoice?.type === 'tool')) {
    throw createProxyError({
      status: 400,
      message: `\`tool_choice\` "${String(toolChoice.type)}" cannot be combined with thinking on this model; send ${fieldNames.disableThinking} or ${fieldNames.autoToolChoice}`,
    });
  }

  const maxTokens = native.maxTokens ?? (typeof liveModel?.max_tokens === 'number' ? liveModel.max_tokens : metadata?.maxOutputDefault ?? metadata?.maxOutputUpper);
  if (maxTokens === undefined) {
    throw createProxyError({ status: 400, message: `Unknown Claude model "${modelId}"; send ${fieldNames.maxTokens}` });
  }
  if (metadata !== undefined && maxTokens > metadata.maxOutputUpper) {
    throw createProxyError({ status: 400, message: `${fieldNames.maxTokens} exceeds the ${modelId} limit of ${metadata.maxOutputUpper}` });
  }

  const request: ClaudeRequest = { model: modelId, messages, max_tokens: maxTokens, stream: true };
  // K_o tail branch at binary offset 218995076 via the $Nr block mapping at 226727459: the
  // billing text (wSo at 218606801) carries no cache marker, the interactive CLI prefix (el at
  // 218994031) is cached, and the remaining caller texts join with two newlines into ONE cached
  // block. The gateway always sends the default ephemeral marker without a ttl (see doc §8).
  const systemBlocks: Json[] = [];
  const billingHeader = getClaudeBillingHeaderFromText(firstUserText);
  if (billingHeader !== '') systemBlocks.push({ type: 'text', text: billingHeader });
  systemBlocks.push({ type: 'text', text: CLAUDE_CLI_SYSTEM_PREFIX, cache_control: { type: 'ephemeral' } });
  const callerText = callerTexts.join('\n\n');
  request.system = systemBlocks;
  // Ahn cleanup first: the native user builder applies cache markers to Ahn's output, so the
  // marker below always lands on a surviving block. Signed assistant content is untouched.
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (message?.role !== 'user' || !Array.isArray(message.content)) continue;
    const cleanedBlocks = cleanUserTextBlocks(message.content as Json[]);
    if (cleanedBlocks !== undefined) messages[index] = { ...message, content: cleanedBlocks };
  }
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
          message: `${fieldNames.maxTokens} must exceed the ${CLAUDE_MIN_THINKING_BUDGET_TOKENS}-token thinking budget floor on "${modelId}"; lower ${fieldNames.effort} or raise ${fieldNames.maxTokens}`,
        });
      }
      const ceiling = Math.min(metadata?.maxOutputUpper ?? maxTokens, maxTokens) - 1;
      if (pinnedThinking !== undefined && thinking.budgetTokens !== undefined && thinking.budgetTokens > ceiling) {
        throw createProxyError({
          status: 400,
          message: `Cannot lower ${fieldNames.maxTokens} mid-turn: this turn already budgets ${thinking.budgetTokens} thinking tokens`,
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
  // rNr at binary offset 226584124, format schema at 216817066.
  if (format !== undefined) {
    if (!supportsClaudeStructuredOutput(modelId)) {
      throw createProxyError({ status: 400, message: `Model "${modelId}" does not support structured output` });
    }
    outputConfig.format = format;
    betas.push(CLAUDE_STRUCTURED_OUTPUTS_BETA);
  }
  if (Object.keys(outputConfig).length > 0) request.output_config = outputConfig;

  if (input.extraBody !== undefined) Object.assign(request, input.extraBody);
  if (input.extraBetas !== undefined) betas.push(...input.extraBetas.filter((beta) => !betas.includes(beta)));
  return { request, betas, thinking, maxTokens };
};
