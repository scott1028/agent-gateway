// Home settings.json handling and thinking/effort resolution.
// Mirrors the pinned official release 2.1.299: settings schema at binary offset 215527644,
// effort merge at 218708338 (uEr) / 218709369 (pEr) with the Nyo whitelist at 218707546,
// settings effort filter at 218706528 (zSe), thinking support at 217930405 (WIs), adaptive switch
// at 217931450 ($Eo/K3e), disabled switch at 217932400 (FEo/b5), request shaping at 226633000 and
// the disabled-thinking effort clamp (Zdt) at 218703811 / 226635192. Capability predicates are
// name-based, not flag-only: effort bb at 218701764, max cse at 218702215, xhigh Qdt at 218702663;
// the default effort ends at pinned default_effort ?? 'high' (Je at 218713474) and each home
// candidate is validated against the model before use (jBn at 218712820).
import { readFile } from 'node:fs/promises';
import {
  CLAUDE_DISABLED_THINKING_EFFORT_CAP,
  CLAUDE_EFFORT_LEVELS,
  CLAUDE_MIN_THINKING_BUDGET_TOKENS,
  CLAUDE_SETTINGS_EFFORT_LEVELS,
} from '../constants.js';
import { createProxyError } from '../errors.js';
import {
  appliesClaudeLegacyEffort,
  canonicalizeClaudeModelId,
  capsClaudeEffortWhenThinkingDisabled,
  rejectsClaudeDisabledThinking,
  supportsClaudeAdaptiveThinking,
  supportsClaudeEffort,
  supportsClaudeMaxEffort,
  supportsClaudeThinking,
  supportsClaudeXhighEffort,
} from './modelMetadata.js';
import type { ClaudeModelMetadata, ClaudeModelSettings, ClaudeSettings, ClaudeThinking } from './types.js';

export const readClaudeSettings = async (settingsPath: string): Promise<ClaudeSettings> => {
  let text: string;
  try {
    text = await readFile(settingsPath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') console.warn(`[claude] settings read failed: ${String(error)}`);
    return {};
  }
  try {
    return JSON.parse(text) as ClaudeSettings;
  } catch (error) {
    console.warn(`[claude] ${settingsPath} is not valid JSON, ignoring it: ${String(error)}`);
    return {};
  }
};

// WIs at 217930405 plus K3e/$Eo at 217931450: adaptive form for capable models, budget form
// otherwise, none for models this release says cannot think at all.
export const getClaudeThinkingMode = (modelId: string, metadata?: ClaudeModelMetadata): 'adaptive' | 'enabled' | undefined => {
  if (!supportsClaudeThinking(modelId, metadata)) return undefined;
  return supportsClaudeAdaptiveThinking(modelId, metadata) ? 'adaptive' : 'enabled';
};

// Effort predicates are model-aware (bb/cse/Qdt at 218701764 / 218702215 / 218702663): pinned
// capability flags plus the release's name-based fallbacks, not a flag-only lookup.
export const getClaudeEffortLevels = (modelId: string, metadata: ClaudeModelMetadata | undefined): string[] => {
  if (!supportsClaudeEffort(modelId, metadata)) return [];
  return CLAUDE_EFFORT_LEVELS.filter(
    (level) =>
      level === 'low' ||
      level === 'medium' ||
      level === 'high' ||
      (level === 'xhigh' && supportsClaudeXhighEffort(modelId, metadata)) ||
      (level === 'max' && supportsClaudeMaxEffort(modelId, metadata)),
  );
};

// Je at binary offset 218713474: the resolved default ends at the pinned default_effort, or "high".
export const getClaudeDefaultEffort = (modelId: string, metadata?: ClaudeModelMetadata): string | undefined =>
  supportsClaudeEffort(modelId, metadata) ? metadata?.defaultEffort ?? 'high' : undefined;

const getEffortRank = (level: string): number => CLAUDE_EFFORT_LEVELS.indexOf(level as (typeof CLAUDE_EFFORT_LEVELS)[number]);

// U at binary offset 218711050: after the cap clamp, a level the model cannot run falls back to
// "high" (max without cse, xhigh without Qdt). No unsupported effort may reach upstream.
const normalizeEffortForModel = (level: string | undefined, modelId: string, metadata?: ClaudeModelMetadata): string | undefined => {
  if (level === 'max' && !supportsClaudeMaxEffort(modelId, metadata)) return 'high';
  if (level === 'xhigh' && !supportsClaudeXhighEffort(modelId, metadata)) return 'high';
  return level;
};

// Settings keys are canonical model ids (lK at binary offset 218709369), so a dated or aliased
// key in the home file still matches the requested model.
const getPerModelSettings = (settings: ClaudeSettings, modelId: string): ClaudeModelSettings | undefined => {
  const canonical = canonicalizeClaudeModelId(modelId);
  return Object.entries(settings.modelSettings ?? {}).find(([key]) => canonicalizeClaudeModelId(key) === canonical)?.[1];
};

const fromSettingsFile = (level: string | undefined): string | undefined =>
  level !== undefined && (CLAUDE_SETTINGS_EFFORT_LEVELS as readonly string[]).includes(level) ? level : undefined;

// uEr at 218708338: the home top-level `effortLevel` is the "legacy user effort" and pEr at
// 218709369 applies it only through the Nyo whitelist, never to a known model outside it.
const getHomeEffort = (settings: ClaudeSettings, modelId: string): string | undefined => {
  const perModel = fromSettingsFile(getPerModelSettings(settings, modelId)?.effortLevel);
  if (perModel !== undefined) return perModel;
  const top = fromSettingsFile(settings.effortLevel);
  return top !== undefined && appliesClaudeLegacyEffort(modelId) ? top : undefined;
};

// de at 218703900: the lowest applicable maxEffortLevel wins, per-model before the top level.
const getMaxEffortLevel = (settings: ClaudeSettings, modelId: string): string | undefined => {
  const candidate = fromSettingsFile(getPerModelSettings(settings, modelId)?.maxEffortLevel) ?? fromSettingsFile(settings.maxEffortLevel);
  if (candidate === undefined || !CLAUDE_EFFORT_LEVELS.includes(candidate as (typeof CLAUDE_EFFORT_LEVELS)[number])) return undefined;
  return candidate;
};

export type ResolveClaudeThinkingInput = {
  modelId: string;
  metadata?: ClaudeModelMetadata;
  settings: ClaudeSettings;
  explicitEffort?: string;
  pinned?: ClaudeThinking;
};

// One thinking configuration per tool-use turn: a pinned turn config wins, and a different
// explicit request mid-turn is rejected instead of silently re-shaping the conversation.
// The comparison runs on the RESOLVED request: the same 'none' or the same clamped level must
// round-trip, while a genuine mid-turn change still fails.
const resolveRequested = ({
  modelId,
  metadata,
  settings,
  explicitEffort,
}: Omit<ResolveClaudeThinkingInput, 'pinned'>): ClaudeThinking => {
  const mode = getClaudeThinkingMode(modelId, metadata);
  const levels = getClaudeEffortLevels(modelId, metadata);
  if (explicitEffort !== undefined && explicitEffort !== 'none' && !levels.includes(explicitEffort)) {
    if (mode === undefined) throw createProxyError({ status: 400, message: `Model "${modelId}" does not support reasoning effort` });
    throw createProxyError({
      status: 400,
      message: `Unsupported reasoning effort "${explicitEffort}" for "${modelId}"; available: ${[...levels, 'none'].join(', ')}`,
    });
  }

  const isDisableRequested = explicitEffort === 'none' || settings.alwaysThinkingEnabled === false;
  const isRejectingDisabled = rejectsClaudeDisabledThinking(metadata);
  if (isDisableRequested && isRejectingDisabled && explicitEffort === 'none') {
    throw createProxyError({ status: 400, message: `Model "${modelId}" does not allow disabling thinking` });
  }
  // V3e at 217930405: a home setting cannot turn thinking off on a model that rejects it, so the
  // gateway keeps thinking on and says so instead of failing the request.
  if (isDisableRequested && isRejectingDisabled) {
    console.warn(`[claude] ${modelId} keeps thinking enabled: this model rejects disabled thinking`);
  }

  // `reasoning.effort: "none"` only switches thinking off; the effort value itself keeps coming
  // from the home settings or the model default, like the official client's separate effort state.
  // jBn at 218712820 validates each home candidate against the model and U at 218711050 normalizes
  // it: a home max/xhigh the model cannot run falls back to "high", any other unsupported home
  // level is dropped, so home `xhigh` on claude-opus-4-6 never sends xhigh.
  const homeEffort = getHomeEffort(settings, modelId);
  const fitHomeEffort = (level: string | undefined): string | undefined => {
    if (level === undefined) return undefined;
    const normalized = normalizeEffortForModel(level, modelId, metadata);
    return normalized !== undefined && levels.includes(normalized) ? normalized : undefined;
  };
  const effort = (explicitEffort === 'none' ? undefined : explicitEffort) ?? fitHomeEffort(homeEffort) ?? getClaudeDefaultEffort(modelId, metadata);
  // maxEffortLevel clamps instead of rejecting (K8 at 218704757), for thinking on and off alike,
  // and the clamped level goes through the same model normalization (U at 218711050): a HOME cap
  // the model cannot run (xhigh on claude-opus-4-6) never puts an unsupported level on the wire.
  const maxEffort = getMaxEffortLevel(settings, modelId);
  const capped = maxEffort === undefined || effort === undefined || getEffortRank(effort) <= getEffortRank(maxEffort) ? effort : maxEffort;
  const clamped = normalizeEffortForModel(capped, modelId, metadata);

  if (mode === undefined || (isDisableRequested && !isRejectingDisabled)) {
    // Zdt at 218703811 applied at 226635192: effort above `high` is clamped for models that reject
    // higher effort while thinking is disabled; other models keep the requested effort.
    const isCapped = clamped !== undefined && capsClaudeEffortWhenThinkingDisabled(modelId, metadata) && getEffortRank(clamped) > getEffortRank(CLAUDE_DISABLED_THINKING_EFFORT_CAP);
    const finalEffort = isCapped ? CLAUDE_DISABLED_THINKING_EFFORT_CAP : clamped;
    return { type: 'disabled', ...(finalEffort === undefined ? {} : { effort: finalEffort }), ...(requestedEffortTag(explicitEffort)) };
  }
  return { type: mode, ...(clamped === undefined ? {} : { effort: clamped }), ...(requestedEffortTag(explicitEffort)) };
};

const requestedEffortTag = (explicitEffort: string | undefined): { requestedEffort?: string } =>
  explicitEffort === undefined ? {} : { requestedEffort: explicitEffort };

export const resolveClaudeThinking = (input: ResolveClaudeThinkingInput): ClaudeThinking => {
  const { modelId, metadata, settings, explicitEffort, pinned } = input;
  if (pinned === undefined) return resolveRequested(input);
  // A stored configuration is only usable when this model can still run it. parseThinking already
  // checked the effort domain; this checks the model. A mismatch is corrupt-for-this-turn state:
  // fail instead of silently repairing the stored pinned configuration.
  const levels = getClaudeEffortLevels(modelId, metadata);
  const rejectPinned = (label: string, value: string): never => {
    throw createProxyError({
      status: 400,
      message: `Stored Claude thinking state is not supported on "${modelId}" (${label} "${value}"); start a new conversation`,
    });
  };
  if (pinned.effort !== undefined && !levels.includes(pinned.effort)) rejectPinned('effort', pinned.effort);
  if (pinned.requestedEffort !== undefined && pinned.requestedEffort !== 'none' && !levels.includes(pinned.requestedEffort)) {
    rejectPinned('requested effort', pinned.requestedEffort);
  }
  if (explicitEffort === undefined) return pinned;
  // The pinned turn remembers the explicit word it was created with: repeating that word keeps the
  // pin even when home settings changed since, while a different word is a genuine mid-turn change.
  if (pinned.requestedEffort !== undefined) {
    if (explicitEffort === pinned.requestedEffort) return pinned;
  } else {
    // Records without a stored word (or home-resolved turns): compare the resolved configuration.
    // budgetTokens is derived from max_output_tokens per request, so it is not part of the identity.
    const requested = resolveRequested({ modelId, metadata, settings, explicitEffort });
    if (requested.type === pinned.type && requested.effort === pinned.effort) return pinned;
  }
  const pinnedLabel = pinned.type === 'disabled' ? 'thinking disabled' : `effort "${pinned.effort ?? 'none'}"`;
  throw createProxyError({
    status: 400,
    message: `Cannot change reasoning effort mid-turn: this turn already uses ${pinnedLabel}`,
  });
};

// Budget floor and ceiling from binary offset 226635226: Math.max(1024, Math.min(upper - 1, budget)),
// where the default budget is the model's upper output limit minus one (FIs at 217926958).
export const getClaudeThinkingBudget = (
  thinking: ClaudeThinking,
  metadata: ClaudeModelMetadata | undefined,
  maxTokens: number,
): number => {
  const ceiling = Math.min((metadata?.maxOutputUpper ?? maxTokens) - 1, maxTokens - 1);
  return Math.max(CLAUDE_MIN_THINKING_BUDGET_TOKENS, Math.min(ceiling, thinking.budgetTokens ?? ceiling));
};
