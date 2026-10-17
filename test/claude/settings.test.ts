// Home settings.json handling and thinking/effort resolution. Anchors are the pinned official
// release 2.1.299: settings schema at binary offset 215527644, effort merge at 218708338/218709369,
// settings effort filter at 218706528, thinking switch at 217931896/217932200.
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  getClaudeDefaultEffort,
  getClaudeEffortLevels,
  getClaudeThinkingBudget,
  getClaudeThinkingMode,
  readClaudeSettings,
  resolveClaudeThinking,
} from '../../src/claude/settings.js';
import { findClaudeModelMetadata } from '../../src/claude/modelMetadata.js';
import type { ClaudeSettings } from '../../src/claude/types.js';

const metadataFor = (modelId: string) => findClaudeModelMetadata(modelId);

const resolve = (modelId: string, settings: ClaudeSettings = {}, explicitEffort?: string) =>
  resolveClaudeThinking({ modelId, metadata: metadataFor(modelId), settings, explicitEffort });

const getError = (run: () => unknown): Error & { status: number } => {
  try {
    run();
  } catch (error) {
    return error as Error & { status: number };
  }
  throw new Error('expected resolveClaudeThinking to throw');
};

describe('readClaudeSettings', () => {
  it('returns an empty object when the home has no settings.json', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'agent-gateway-claude-settings-'));
    expect(await readClaudeSettings(path.join(dir, 'settings.json'))).toEqual({});
  });

  it('ignores a settings.json that is not valid JSON', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'agent-gateway-claude-settings-'));
    const settingsPath = path.join(dir, 'settings.json');
    await writeFile(settingsPath, '{ nope');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(await readClaudeSettings(settingsPath)).toEqual({});
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('not valid JSON'));
  });

  it('reads the settings the gateway honours', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'agent-gateway-claude-settings-'));
    const settingsPath = path.join(dir, 'settings.json');
    await writeFile(settingsPath, JSON.stringify({ alwaysThinkingEnabled: false, effortLevel: 'high' }));
    expect(await readClaudeSettings(settingsPath)).toEqual({ alwaysThinkingEnabled: false, effortLevel: 'high' });
  });
});

describe('getClaudeThinkingMode', () => {
  // WIs at 217930405 and $Eo at 217931450 of the pinned release.
  it('uses adaptive thinking for adaptive-capable models and the budget form for legacy ones', () => {
    expect(getClaudeThinkingMode('claude-opus-5', metadataFor('claude-opus-5'))).toBe('adaptive');
    expect(getClaudeThinkingMode('claude-sonnet-4-6', metadataFor('claude-sonnet-4-6'))).toBe('adaptive');
    expect(getClaudeThinkingMode('claude-sonnet-4-5-20250929', metadataFor('claude-sonnet-4-5-20250929'))).toBe('enabled');
    expect(getClaudeThinkingMode('claude-haiku-4-5', metadataFor('claude-haiku-4-5'))).toBe('enabled');
  });

  it('gives no thinking to the claude-3 family and adaptive thinking to mythos-5', () => {
    // WIs at 217930405 uses the name rule `!canonical.includes("claude-3-")` unless an env override
    // (MPe at 217927847) says otherwise, so this release treats the whole 3.x family as non-thinking.
    expect(getClaudeThinkingMode('claude-3-5-haiku', metadataFor('claude-3-5-haiku'))).toBeUndefined();
    expect(getClaudeThinkingMode('claude-3-7-sonnet', metadataFor('claude-3-7-sonnet'))).toBeUndefined();
    expect(getClaudeThinkingMode('claude-mythos-5', metadataFor('claude-mythos-5'))).toBe('adaptive');
  });

  it('falls back to the name-based rules for models the pinned table does not know', () => {
    expect(getClaudeThinkingMode('claude-next-9')).toBe('adaptive');
    expect(getClaudeThinkingMode('claude-3-9-legacy')).toBeUndefined();
  });
});

describe('getClaudeEffortLevels', () => {
  it('gates xhigh and max behind the pinned capability flags and the name fallbacks', () => {
    // bb/cse/Qdt at 218701764 / 218702215 / 218702663.
    expect(getClaudeEffortLevels('claude-opus-5', metadataFor('claude-opus-5'))).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
    expect(getClaudeEffortLevels('claude-sonnet-4-6', metadataFor('claude-sonnet-4-6'))).toEqual(['low', 'medium', 'high', 'max']);
    expect(getClaudeEffortLevels('claude-sonnet-4-5', metadataFor('claude-sonnet-4-5'))).toEqual([]);
    // claude-opus-4-5 has no effort flag in the raw table but bb does not exclude its name.
    expect(getClaudeEffortLevels('claude-opus-4-5', metadataFor('claude-opus-4-5'))).toEqual(['low', 'medium', 'high']);
    // Unknown ids default to supported on a first-party provider (fG(cd())).
    expect(getClaudeEffortLevels('claude-next-9', undefined)).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
  });
});

describe('getClaudeDefaultEffort', () => {
  it('ends at the pinned default_effort, or "high" (Je at 218713474)', () => {
    expect(getClaudeDefaultEffort('claude-sonnet-4-6', metadataFor('claude-sonnet-4-6'))).toBe('high');
    expect(getClaudeDefaultEffort('claude-sonnet-5-5', metadataFor('claude-sonnet-5-5'))).toBe('medium');
    expect(getClaudeDefaultEffort('claude-sonnet-4-5', metadataFor('claude-sonnet-4-5'))).toBeUndefined();
  });
});

describe('resolveClaudeThinking', () => {
  it('uses the pinned model default effort when nothing else is set', () => {
    expect(resolve('claude-opus-5')).toEqual({ type: 'adaptive', effort: 'high' });
    expect(resolve('claude-sonnet-5-5')).toEqual({ type: 'adaptive', effort: 'medium' });
  });

  it('omits effort for models that have no effort capability', () => {
    expect(resolve('claude-sonnet-4-5-20250929')).toEqual({ type: 'enabled' });
  });

  it('disables thinking when alwaysThinkingEnabled is false', () => {
    // Zdt at 218703811: claude-opus-5 caps effort at `high` while thinking is disabled, and its
    // default effort is already `high`, so only the thinking form changes.
    expect(resolve('claude-opus-5', { alwaysThinkingEnabled: false })).toEqual({ type: 'disabled', effort: 'high' });
  });

  it('clamps effort to high when thinking is disabled on a capped model', () => {
    expect(resolve('claude-opus-5', { alwaysThinkingEnabled: false }, 'xhigh')).toEqual({ type: 'disabled', effort: 'high', requestedEffort: 'xhigh' });
    expect(resolve('claude-opus-5', {}, 'none')).toEqual({ type: 'disabled', effort: 'high', requestedEffort: 'none' });
  });

  it('keeps effort when thinking is off on a model without the cap', () => {
    expect(resolve('claude-sonnet-4-6', { alwaysThinkingEnabled: false, effortLevel: 'high' })).toEqual({
      type: 'disabled',
      effort: 'high',
    });
    expect(resolve('claude-sonnet-4-6', { alwaysThinkingEnabled: false }, 'max')).toEqual({ type: 'disabled', effort: 'max', requestedEffort: 'max' });
  });

  it('keeps an explicit effort above the cap when thinking stays on', () => {
    // Supervisor probe case: an explicit `high` survives a home that disabled thinking.
    expect(resolve('claude-opus-4-6', { alwaysThinkingEnabled: false }, 'high')).toEqual({ type: 'disabled', effort: 'high', requestedEffort: 'high' });
    expect(resolve('claude-opus-5', {}, 'xhigh')).toEqual({ type: 'adaptive', effort: 'xhigh', requestedEffort: 'xhigh' });
  });

  it('honours an explicit effort over the home settings', () => {
    expect(resolve('claude-opus-5', { effortLevel: 'low' }, 'xhigh')).toEqual({ type: 'adaptive', effort: 'xhigh', requestedEffort: 'xhigh' });
  });

  it('applies maxEffortLevel while thinking is disabled as well', () => {
    expect(resolve('claude-sonnet-4-6', { alwaysThinkingEnabled: false, effortLevel: 'xhigh', maxEffortLevel: 'high' })).toEqual({
      type: 'disabled',
      effort: 'high',
    });
  });

  it('prefers modelSettings over the top-level effortLevel', () => {
    expect(
      resolve('claude-opus-5', { effortLevel: 'low', modelSettings: { 'claude-opus-5': { effortLevel: 'xhigh' } } }),
    ).toEqual({ type: 'adaptive', effort: 'xhigh' });
    // Settings keys are canonical ids, so a dated key still matches the requested model.
    expect(
      resolve('claude-opus-5', { modelSettings: { 'claude-opus-5-20251101': { effortLevel: 'xhigh' } } }),
    ).toEqual({ type: 'adaptive', effort: 'xhigh' });
  });

  it('does not apply the top-level effortLevel to a known model outside the legacy list', () => {
    // Supervisor probe case: Nyo at 218707546 keeps claude-opus-5-5 on its own default effort.
    expect(resolve('claude-opus-5-5', { effortLevel: 'high' })).toEqual({ type: 'adaptive', effort: 'medium' });
  });

  it('applies the top-level effortLevel to models this release does not know', () => {
    expect(resolveClaudeThinking({ modelId: 'claude-next-9', settings: { effortLevel: 'medium' } })).toEqual({
      type: 'adaptive',
      effort: 'medium',
    });
  });

  it('clamps to maxEffortLevel instead of rejecting', () => {
    expect(resolve('claude-opus-5', { effortLevel: 'xhigh', maxEffortLevel: 'high' })).toEqual({
      type: 'adaptive',
      effort: 'high',
    });
    expect(
      resolve('claude-opus-5', {
        maxEffortLevel: 'high',
        modelSettings: { 'claude-opus-5': { maxEffortLevel: 'medium' } },
      }),
    ).toEqual({ type: 'adaptive', effort: 'medium' });
  });

  it('normalizes a HOME cap the model cannot run through the model-supported levels (U at 218711050)', () => {
    // Supervisor probe case: claude-opus-4-6 explicit max + HOME maxEffortLevel xhigh. Qdt at
    // 218702663 excludes claude-opus-4-6 from xhigh, so the clamp result normalizes to "high":
    // the cap is honoured (never above it) and no unsupported effort reaches upstream.
    expect(resolve('claude-opus-4-6', { maxEffortLevel: 'xhigh' }, 'max')).toEqual({ type: 'adaptive', effort: 'high', requestedEffort: 'max' });
    // A home effortLevel the model cannot run goes through the same normalization. Qdt at
    // 218702663 excludes claude-opus-4-5, claude-opus-4-6 and claude-sonnet-4-6 from xhigh in
    // this release, so a home xhigh on those models never reaches upstream.
    expect(resolve('claude-opus-4-6', { effortLevel: 'xhigh' })).toEqual({ type: 'adaptive', effort: 'high' });
    expect(resolve('claude-opus-4-5', { effortLevel: 'xhigh' })).toEqual({ type: 'enabled', effort: 'high' });
    // A cap the model supports is honoured as requested: explicit high under an xhigh cap stays high.
    expect(resolve('claude-opus-4-5', { maxEffortLevel: 'xhigh' }, 'high')).toEqual({ type: 'enabled', effort: 'high', requestedEffort: 'high' });
  });

  it('rejects a stored thinking configuration the model cannot run instead of repairing it', () => {
    const error = getError(() =>
      resolveClaudeThinking({ modelId: 'claude-opus-4-6', metadata: metadataFor('claude-opus-4-6'), settings: {}, pinned: { type: 'adaptive', effort: 'xhigh' } }),
    );
    expect(error.status).toBe(400);
    expect(error.message).toContain('not supported on "claude-opus-4-6"');
    const requestedError = getError(() =>
      resolveClaudeThinking({
        modelId: 'claude-opus-4-6',
        metadata: metadataFor('claude-opus-4-6'),
        settings: {},
        explicitEffort: 'xhigh',
        pinned: { type: 'adaptive', effort: 'high', requestedEffort: 'xhigh' },
      }),
    );
    expect(requestedError.status).toBe(400);
    expect(requestedError.message).toContain('not supported on "claude-opus-4-6"');
  });

  it('ignores settings effort values the official schema does not accept', () => {
    expect(resolve('claude-opus-5', { effortLevel: 'max' })).toEqual({ type: 'adaptive', effort: 'high' });
  });

  it('rejects an explicit effort the model does not support', () => {
    const error = getError(() => resolve('claude-sonnet-4-6', {}, 'xhigh'));
    expect(error.status).toBe(400);
    expect(error.message).toBe('Unsupported reasoning effort "xhigh" for "claude-sonnet-4-6"; available: low, medium, high, max, none');
    expect(getError(() => resolve('claude-sonnet-4-5', {}, 'high')).status).toBe(400);
  });

  it('rejects an explicit request to disable thinking on models that refuse it', () => {
    const error = getError(() => resolve('claude-fable-5', {}, 'none'));
    expect(error.status).toBe(400);
    expect(error.message).toBe('Model "claude-fable-5" does not allow disabling thinking');
  });

  it('keeps thinking on when only the home setting disables it on such a model', () => {
    // V3e at 217930405: `n !== false || uS(e)` — a home setting cannot switch thinking off here.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(resolve('claude-fable-5', { alwaysThinkingEnabled: false })).toEqual({ type: 'adaptive', effort: 'high' });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('keeps thinking enabled'));
  });

  it('keeps the pinned turn configuration and rejects a change mid-turn', () => {
    const pinned = { type: 'enabled', effort: 'medium' } as const;
    expect(resolveClaudeThinking({ modelId: 'claude-opus-5', metadata: metadataFor('claude-opus-5'), settings: {}, pinned })).toEqual(
      pinned,
    );
    const error = getError(() =>
      resolveClaudeThinking({
        modelId: 'claude-opus-5',
        metadata: metadataFor('claude-opus-5'),
        settings: {},
        explicitEffort: 'high',
        pinned,
      }),
    );
    expect(error.status).toBe(400);
    expect(error.message).toContain('Cannot change reasoning effort mid-turn');
  });

  it('accepts a repeated identical explicit request after clamping (supervisor settings probe)', () => {
    // initial 'none' resolves disabled+effort high; repeating 'none' must not 400.
    const disabledPinned = resolve('claude-opus-4-6', {}, 'none');
    expect(disabledPinned).toEqual({ type: 'disabled', effort: 'high', requestedEffort: 'none' });
    expect(
      resolveClaudeThinking({ modelId: 'claude-opus-4-6', metadata: metadataFor('claude-opus-4-6'), settings: {}, explicitEffort: 'none', pinned: disabledPinned }),
    ).toEqual(disabledPinned);
    // initial 'max' with home maxEffortLevel low resolves low; repeating 'max' must not 400.
    const clampedPinned = resolve('claude-opus-4-6', { maxEffortLevel: 'low' }, 'max');
    expect(clampedPinned).toEqual({ type: 'adaptive', effort: 'low', requestedEffort: 'max' });
    expect(
      resolveClaudeThinking({
        modelId: 'claude-opus-4-6',
        metadata: metadataFor('claude-opus-4-6'),
        settings: { maxEffortLevel: 'low' },
        explicitEffort: 'max',
        pinned: clampedPinned,
      }),
    ).toEqual(clampedPinned);
    // A changed HOME cap must keep the pin for the same explicit word (supervisor probe).
    expect(
      resolveClaudeThinking({
        modelId: 'claude-opus-4-6',
        metadata: metadataFor('claude-opus-4-6'),
        settings: { maxEffortLevel: 'xhigh', effortLevel: 'low' },
        explicitEffort: 'none',
        pinned: disabledPinned,
      }),
    ).toEqual(disabledPinned);
    expect(
      resolveClaudeThinking({
        modelId: 'claude-opus-4-6',
        metadata: metadataFor('claude-opus-4-6'),
        settings: { maxEffortLevel: 'xhigh', effortLevel: 'low' },
        explicitEffort: 'max',
        pinned: clampedPinned,
      }),
    ).toEqual(clampedPinned);
    // A genuine change still fails: 'none' pinned, then 'max'.
    expect(
      getError(() =>
        resolveClaudeThinking({ modelId: 'claude-opus-4-6', metadata: metadataFor('claude-opus-4-6'), settings: {}, explicitEffort: 'max', pinned: disabledPinned }),
      ).status,
    ).toBe(400);
    // And a different word fails even when the home cap changed in the request's favour.
    expect(
      getError(() =>
        resolveClaudeThinking({
          modelId: 'claude-opus-4-6',
          metadata: metadataFor('claude-opus-4-6'),
          settings: { maxEffortLevel: 'xhigh' },
          explicitEffort: 'xhigh',
          pinned: clampedPinned,
        }),
      ).status,
    ).toBe(400);
  });
});

describe('getClaudeThinkingBudget', () => {
  it('clamps the budget like the official client: at least 1024 and below max_tokens', () => {
    const metadata = metadataFor('claude-sonnet-4-5');
    expect(getClaudeThinkingBudget({ type: 'enabled' }, metadata, 32000)).toBe(31999);
    expect(getClaudeThinkingBudget({ type: 'enabled', budgetTokens: 10 }, metadata, 32000)).toBe(1024);
    expect(getClaudeThinkingBudget({ type: 'enabled', budgetTokens: 999999 }, metadata, 4000)).toBe(3999);
  });
});
