// Pinned built-in model capability metadata.
// Source: official release /home/scott/.local/share/claude/versions/2.1.299
// (SHA256 2d894a4b1bfaaa9aab72aeff7803e3c73bc2510f279a171f6b8f59f72d17d077, GIT_SHA
// c416f56ec7eca27e49747c35af51d5c92c856ba1), built-in model table at byte offset 215969375.
// Extracted statically with .tmp/claude-upstream-workflow/evidence/models2.py; never executed.
import {
  CLAUDE_ADAPTIVE_THINKING_EXCLUSIONS,
  CLAUDE_EFFORT_UNSUPPORTED_NAMES,
  CLAUDE_LEGACY_EFFORT_MODELS,
  CLAUDE_MAX_EFFORT_UNSUPPORTED_NAMES,
  CLAUDE_STRUCTURED_OUTPUT_EXCLUDED_MODELS,
  CLAUDE_THINKING_UNSUPPORTED_MARKER,
  CLAUDE_XHIGH_EFFORT_UNSUPPORTED_NAMES,
} from '../constants.js';
import type { ClaudeModelMetadata } from './types.js';

// Tuple order: id, first-party provider id, context window (0 = the record omits it),
// max output default, max output upper limit, default effort ('' = the record omits it), capability flags.
const PINNED_MODELS: Array<[string, string, number, number, number, string, readonly string[]]> = [
  ['claude-3-5-haiku', 'claude-3-5-haiku-20241022', 0, 8192, 8192, '', []],
  ['claude-3-5-sonnet', 'claude-3-5-sonnet-20241022', 0, 8192, 8192, '', []],
  ['claude-3-7-sonnet', 'claude-3-7-sonnet-20250219', 0, 32000, 64000, '', []],
  ['claude-haiku-4-5', 'claude-haiku-4-5-20251001', 200000, 32000, 64000, '', ['context_management']],
  ['claude-sonnet-4-0', 'claude-sonnet-4-20250514', 200000, 32000, 64000, '', ['context_management']],
  ['claude-sonnet-4-5', 'claude-sonnet-4-5-20250929', 200000, 32000, 64000, '', ['context_management']],
  ['claude-sonnet-4-6', 'claude-sonnet-4-6', 200000, 32000, 128000, '', ['effort', 'max_effort', 'adaptive_thinking', 'context_management']],
  ['claude-opus-4-0', 'claude-opus-4-20250514', 200000, 32000, 32000, '', ['context_management']],
  ['claude-opus-4-1', 'claude-opus-4-1-20250805', 200000, 32000, 32000, '', ['context_management']],
  ['claude-opus-4-5', 'claude-opus-4-5-20251101', 200000, 32000, 64000, '', ['context_management']],
  ['claude-opus-4-6', 'claude-opus-4-6', 200000, 64000, 128000, '', ['effort', 'max_effort', 'adaptive_thinking', 'context_management']],
  ['claude-opus-4-7', 'claude-opus-4-7', 1000000, 64000, 128000, 'xhigh', ['effort', 'max_effort', 'xhigh_effort', 'adaptive_thinking', 'context_management']],
  ['claude-opus-4-8', 'claude-opus-4-8', 1000000, 64000, 128000, 'high', ['effort', 'max_effort', 'xhigh_effort', 'adaptive_thinking', 'mid_conv_tool_change', 'context_management', 'fast_mode', 'lean_prompt']],
  ['claude-opus-5', 'claude-opus-5', 1000000, 64000, 128000, 'high', ['effort', 'max_effort', 'xhigh_effort', 'adaptive_thinking', 'mid_conv_tool_change', 'context_management', 'thinking_disabled_effort_cap', 'fast_mode', 'lean_prompt', 'refusal_fallback', 'opus_5_prompt_bundle']],
  ['claude-opus-5-5', 'claude-opus-5-5', 1000000, 128000, 128000, 'medium', ['effort', 'max_effort', 'xhigh_effort', 'adaptive_thinking', 'rejects_disabled_thinking', 'mid_conv_tool_change', 'per_turn_effort', 'per_turn_timing', 'context_management', 'fast_mode', 'lean_prompt', 'refusal_fallback', 'opus_5_5_prompt_bundle']],
  ['claude-haiku-5-5', 'claude-haiku-5-5', 1000000, 128000, 128000, 'medium', ['effort', 'max_effort', 'xhigh_effort', 'adaptive_thinking', 'mid_conv_tool_change', 'context_management', 'rejects_disabled_thinking', 'per_turn_effort', 'lean_prompt', 'org_locked_thinking', 'haiku_5_5_early_stopping_guidance']],
  ['claude-sonnet-5', 'claude-sonnet-5', 1000000, 64000, 128000, 'high', ['effort', 'max_effort', 'xhigh_effort', 'adaptive_thinking', 'context_management']],
  ['claude-sonnet-5-5', 'claude-sonnet-5-5', 1000000, 128000, 128000, 'medium', ['effort', 'max_effort', 'xhigh_effort', 'adaptive_thinking', 'mid_conv_tool_change', 'context_management', 'rejects_disabled_thinking', 'per_turn_effort', 'per_turn_timing', 'lean_prompt', 'refusal_fallback', 'silent_turn_reminder', 'org_locked_thinking']],
  ['claude-fable-5', 'claude-fable-5', 1000000, 64000, 128000, 'high', ['effort', 'max_effort', 'xhigh_effort', 'adaptive_thinking', 'rejects_disabled_thinking', 'mid_conv_tool_change', 'context_management', 'lean_prompt', 'fable_5_mitigations', 'refusal_fallback']],
  ['claude-fable-5-1', 'claude-fable-5-1', 1000000, 64000, 128000, 'high', ['effort', 'max_effort', 'xhigh_effort', 'adaptive_thinking', 'rejects_disabled_thinking', 'mid_conv_tool_change', 'per_turn_effort', 'per_turn_timing', 'context_management', 'lean_prompt', 'fable_5_mitigations', 'refusal_fallback', 'fable_5_1_prompt_bundle']],
  ['claude-mythos-5', 'claude-mythos-5', 1000000, 64000, 128000, '', []],
  ['claude-mythos-5-1', 'claude-mythos-5-1', 1000000, 64000, 128000, 'high', ['effort', 'max_effort', 'xhigh_effort', 'adaptive_thinking', 'rejects_disabled_thinking', 'mid_conv_tool_change', 'per_turn_timing', 'context_management', 'lean_prompt', 'fable_5_mitigations', 'fable_5_1_prompt_bundle']],
];

export const CLAUDE_MODEL_METADATA: readonly ClaudeModelMetadata[] = PINNED_MODELS.map(
  ([id, firstPartyId, contextWindow, maxOutputDefault, maxOutputUpper, defaultEffort, capabilities]) => ({
    id,
    firstPartyId,
    ...(contextWindow === 0 ? {} : { contextWindow }),
    maxOutputDefault,
    maxOutputUpper,
    ...(defaultEffort === '' ? {} : { defaultEffort }),
    capabilities,
  }),
);

const BY_ID = new Map(CLAUDE_MODEL_METADATA.flatMap((model) => [[model.id, model], [model.firstPartyId, model]] as const));

// Matches dated, aliased and `[1m]` spellings to the pinned record, the way the CLI canonicalizes ids.
export const findClaudeModelMetadata = (modelId: string): ClaudeModelMetadata | undefined =>
  BY_ID.get(modelId) ?? BY_ID.get(modelId.replace(/\[1m\]$/i, '').replace(/-\d{8}$/, ''));

export const hasClaudeCapability = (metadata: ClaudeModelMetadata | undefined, capability: string): boolean =>
  getClaudeCapability(metadata, capability) === true;

// Tri-state so a model can fall back to the release's name-based rules when the pinned table
// carries no entry for that capability: MPe/X_ return undefined for a missing entry, not false.
export const getClaudeCapability = (metadata: ClaudeModelMetadata | undefined, capability: string): boolean | undefined => {
  if (metadata === undefined) return undefined;
  return metadata.capabilities.includes(capability) ? true : undefined;
};

// Canonical id used by the release's name-based predicates (Ke() at 217930405 and nearby).
export const canonicalizeClaudeModelId = (modelId: string): string => findClaudeModelMetadata(modelId)?.id ?? modelId;

// Native 2.1.299 bL/cr @217933672/@217928457: pre-4.8 models reject role=system.
// Matches references/CLIProxyAPI's legacy gate, also covering native aliases and claude-3-*.
export const supportsClaudeMidConversationSystem = (modelId: string): boolean => {
  const canonical = canonicalizeClaudeModelId(modelId.replace(/\[1m\]$/i, '').replace(/-latest$/, ''));
  return !canonical.includes('claude-3-') && ![
    'claude-opus-4', 'claude-opus-4-0', 'claude-sonnet-4', 'claude-sonnet-4-0',
    'claude-opus-4-1', 'claude-sonnet-4-5', 'claude-haiku-4-5', 'claude-opus-4-5',
    'claude-opus-4-6', 'claude-sonnet-4-6', 'claude-opus-4-7',
  ].includes(canonical);
};

const ADAPTIVE_EXCLUSIONS: readonly string[] = CLAUDE_ADAPTIVE_THINKING_EXCLUSIONS;
const LEGACY_EFFORT_MODEL_IDS: readonly string[] = CLAUDE_LEGACY_EFFORT_MODELS;
const STRUCTURED_OUTPUT_EXCLUSIONS: readonly string[] = CLAUDE_STRUCTURED_OUTPUT_EXCLUDED_MODELS;

// WIs at binary offset 217930405: capability, otherwise every non claude-3-* model thinks.
export const supportsClaudeThinking = (modelId: string, metadata?: ClaudeModelMetadata): boolean =>
  getClaudeCapability(metadata, 'thinking') ?? !canonicalizeClaudeModelId(modelId).includes(CLAUDE_THINKING_UNSUPPORTED_MARKER);

// $Eo at binary offset 217931450: capability, then the explicit exclusions; claude-mythos-5 stays
// adaptive even though its table row has no capabilities.
export const supportsClaudeAdaptiveThinking = (modelId: string, metadata?: ClaudeModelMetadata): boolean => {
  const capability = getClaudeCapability(metadata, 'adaptive_thinking');
  if (capability !== undefined) return capability;
  const canonical = canonicalizeClaudeModelId(modelId);
  if (canonical.includes(CLAUDE_THINKING_UNSUPPORTED_MARKER)) return false;
  return !ADAPTIVE_EXCLUSIONS.includes(canonical);
};

// Bzn at binary offset 217932522 on a first-party provider: capability, else non claude-3-*.
export const supportsClaudeInterleavedThinking = (modelId: string, metadata?: ClaudeModelMetadata): boolean =>
  getClaudeCapability(metadata, 'interleaved_thinking') ?? !canonicalizeClaudeModelId(modelId).includes(CLAUDE_THINKING_UNSUPPORTED_MARKER);

// uS at binary offset 217930405: only the explicit capability refuses disabled thinking.
export const rejectsClaudeDisabledThinking = (metadata: ClaudeModelMetadata | undefined): boolean =>
  hasClaudeCapability(metadata, 'rejects_disabled_thinking');

// lEr at binary offset 218703866: capability, otherwise only claude-opus-5 caps effort when
// thinking is disabled.
export const capsClaudeEffortWhenThinkingDisabled = (modelId: string, metadata?: ClaudeModelMetadata): boolean =>
  getClaudeCapability(metadata, 'thinking_disabled_effort_cap') ?? canonicalizeClaudeModelId(modelId) === 'claude-opus-5';

// jzn at binary offset 217932900: first-party provider (the gateway only talks to api.anthropic.com)
// minus the excluded models. tge at 224806672 adds runtime "this model refused" latches, which the
// gateway does not keep, so an unsupported model surfaces as an upstream 400.
export const supportsClaudeStructuredOutput = (modelId: string): boolean =>
  !STRUCTURED_OUTPUT_EXCLUSIONS.includes(canonicalizeClaudeModelId(modelId));

// Nyo at binary offset 218707546: the home top-level effortLevel applies to the legacy compatible
// ids and to models this release does not know, never to a known model outside that list.
export const appliesClaudeLegacyEffort = (modelId: string): boolean => {
  const canonical = canonicalizeClaudeModelId(modelId);
  return LEGACY_EFFORT_MODEL_IDS.includes(canonical) || findClaudeModelMetadata(canonical) === undefined;
};

// Effort capability predicates. bb at 218701764, cse at 218702215 and Qdt at 218702663 each check
// the pinned table (X_/Oxo) but FIRST reject a fixed set of canonical model names, and on a
// first-party provider (fG(cd()) — the gateway only talks to api.anthropic.com) default to true
// for everything else. So claude-opus-4-5 supports effort even though its table row has no flag,
// and unknown ids support it too. The env/runtime overrides (MPe/ymt/mCr) are not modelled here.
const EFFORT_UNSUPPORTED_NAMES: readonly string[] = CLAUDE_EFFORT_UNSUPPORTED_NAMES;
const MAX_EFFORT_UNSUPPORTED_NAMES: readonly string[] = CLAUDE_MAX_EFFORT_UNSUPPORTED_NAMES;
const XHIGH_EFFORT_UNSUPPORTED_NAMES: readonly string[] = CLAUDE_XHIGH_EFFORT_UNSUPPORTED_NAMES;

const supportsClaudeEffortLevel = (
  modelId: string,
  metadata: ClaudeModelMetadata | undefined,
  capability: string,
  unsupportedNames: readonly string[],
): boolean => {
  const canonical = canonicalizeClaudeModelId(modelId);
  if (canonical.includes(CLAUDE_THINKING_UNSUPPORTED_MARKER) || unsupportedNames.includes(canonical)) return false;
  return getClaudeCapability(metadata, capability) ?? true;
};

export const supportsClaudeEffort = (modelId: string, metadata?: ClaudeModelMetadata): boolean =>
  supportsClaudeEffortLevel(modelId, metadata, 'effort', EFFORT_UNSUPPORTED_NAMES);

export const supportsClaudeMaxEffort = (modelId: string, metadata?: ClaudeModelMetadata): boolean =>
  supportsClaudeEffortLevel(modelId, metadata, 'max_effort', MAX_EFFORT_UNSUPPORTED_NAMES);

export const supportsClaudeXhighEffort = (modelId: string, metadata?: ClaudeModelMetadata): boolean =>
  supportsClaudeEffortLevel(modelId, metadata, 'xhigh_effort', XHIGH_EFFORT_UNSUPPORTED_NAMES);
