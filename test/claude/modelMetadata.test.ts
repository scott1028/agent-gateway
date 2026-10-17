// Pinned built-in model capability metadata, extracted statically from the official release
// 2.1.299 (built-in model table at binary offset 215969375). These assertions keep the table and
// the id canonicalization honest.
import { describe, expect, it } from 'vitest';
import {
  appliesClaudeLegacyEffort,
  capsClaudeEffortWhenThinkingDisabled,
  CLAUDE_MODEL_METADATA,
  findClaudeModelMetadata,
  getClaudeCapability,
  hasClaudeCapability,
  supportsClaudeInterleavedThinking,
  supportsClaudeStructuredOutput,
} from '../../src/claude/modelMetadata.js';

describe('findClaudeModelMetadata', () => {
  it('matches the bare id and the dated first-party spelling', () => {
    expect(findClaudeModelMetadata('claude-sonnet-4-5')?.id).toBe('claude-sonnet-4-5');
    expect(findClaudeModelMetadata('claude-sonnet-4-5-20250929')?.id).toBe('claude-sonnet-4-5');
    expect(findClaudeModelMetadata('claude-opus-4-1-20250805')?.id).toBe('claude-opus-4-1');
    expect(findClaudeModelMetadata('claude-3-5-sonnet-20241022')?.id).toBe('claude-3-5-sonnet');
  });

  it('ignores a [1m] context suffix', () => {
    expect(findClaudeModelMetadata('claude-sonnet-5[1m]')?.id).toBe('claude-sonnet-5');
  });

  it('returns undefined for models the pinned release does not know', () => {
    expect(findClaudeModelMetadata('gpt-5.6-terra')).toBeUndefined();
    expect(findClaudeModelMetadata('claude-not-a-model')).toBeUndefined();
  });
});

describe('CLAUDE_MODEL_METADATA', () => {
  it('pins the capability flags the gateway acts on', () => {
    const opus5 = findClaudeModelMetadata('claude-opus-5');
    expect(opus5?.capabilities).toContain('adaptive_thinking');
    expect(opus5?.capabilities).toContain('thinking_disabled_effort_cap');
    expect(hasClaudeCapability(opus5, 'rejects_disabled_thinking')).toBe(false);
    const fable5 = findClaudeModelMetadata('claude-fable-5');
    expect(hasClaudeCapability(fable5, 'rejects_disabled_thinking')).toBe(true);
    expect(hasClaudeCapability(fable5, 'xhigh_effort')).toBe(true);
  });

  it('pins the output-token limits used for request shaping', () => {
    expect(findClaudeModelMetadata('claude-sonnet-4-5')).toMatchObject({ maxOutputDefault: 32000, maxOutputUpper: 64000 });
    expect(findClaudeModelMetadata('claude-3-5-haiku')).toMatchObject({ maxOutputDefault: 8192, maxOutputUpper: 8192 });
    expect(findClaudeModelMetadata('claude-haiku-5-5')).toMatchObject({ maxOutputDefault: 128000, maxOutputUpper: 128000 });
  });

  it('keeps every record self-consistent', () => {
    for (const model of CLAUDE_MODEL_METADATA) {
      expect(model.maxOutputUpper).toBeGreaterThanOrEqual(model.maxOutputDefault);
      expect(model.firstPartyId).toMatch(/^claude-/);
    }
    expect(CLAUDE_MODEL_METADATA.length).toBeGreaterThan(20);
  });
});

describe('capability predicates', () => {
  it('treats a missing table entry as undefined so the name rules apply', () => {
    expect(getClaudeCapability(findClaudeModelMetadata('claude-opus-5'), 'adaptive_thinking')).toBe(true);
    expect(getClaudeCapability(findClaudeModelMetadata('claude-opus-5'), 'rejects_disabled_thinking')).toBeUndefined();
    expect(getClaudeCapability(undefined, 'adaptive_thinking')).toBeUndefined();
  });

  it('sends the interleaved thinking beta by model capability, not by thinking state', () => {
    // Bzn at 217932522: first-party provider, capability, else every non claude-3-* model.
    expect(supportsClaudeInterleavedThinking('claude-opus-5')).toBe(true);
    expect(supportsClaudeInterleavedThinking('claude-haiku-4-5')).toBe(true);
    expect(supportsClaudeInterleavedThinking('claude-3-7-sonnet')).toBe(false);
    expect(supportsClaudeInterleavedThinking('claude-next-9')).toBe(true);
  });

  it('excludes claude-opus-4-1 from structured output', () => {
    // jzn at 217932900.
    expect(supportsClaudeStructuredOutput('claude-opus-4-1-20250805')).toBe(false);
    expect(supportsClaudeStructuredOutput('claude-opus-5')).toBe(true);
    expect(supportsClaudeStructuredOutput('claude-sonnet-4-6')).toBe(true);
  });

  it('caps effort while thinking is disabled only where the release says so', () => {
    // lEr at 218703866: capability, otherwise only claude-opus-5.
    expect(capsClaudeEffortWhenThinkingDisabled('claude-opus-5')).toBe(true);
    expect(capsClaudeEffortWhenThinkingDisabled('claude-opus-5-5')).toBe(false);
    expect(capsClaudeEffortWhenThinkingDisabled('claude-sonnet-4-6')).toBe(false);
  });

  it('applies the legacy top-level effort only through the Nyo whitelist', () => {
    // Nyo at 218707546 with the Te list at 218707300.
    expect(appliesClaudeLegacyEffort('claude-sonnet-4-6')).toBe(true);
    expect(appliesClaudeLegacyEffort('claude-opus-5-5')).toBe(false);
    expect(appliesClaudeLegacyEffort('claude-not-a-model')).toBe(true);
  });
});
