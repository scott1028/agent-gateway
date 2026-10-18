// Matches references/codex relay policy; degrade is the CLI default, reject opts back out.
import { describe, expect, it } from 'vitest';
import { parseCliArgs } from '../src/config.js';
import { RELAY_REASONING_MAX_ENTRIES } from '../src/constants.js';
import { createReasoningStore } from '../src/utils/reasoningStore.js';

describe('relay fallback state', () => {
  it('isolates aliases and servers, refreshes hits and evicts the oldest hash', () => {
    const store = createReasoningStore();
    store.record('claude1', 'first');
    store.record('claude1', 'second');
    expect(store.has('claude2', 'first')).toBe(false);
    expect(createReasoningStore().has('claude1', 'first')).toBe(false);
    for (let index = 2; index < RELAY_REASONING_MAX_ENTRIES; index++) store.record('claude1', String(index));
    expect(store.has('claude1', 'first')).toBe(true);
    store.record('claude1', 'overflow');
    expect(store.has('claude1', 'second')).toBe(false);
    expect(store.has('claude1', 'first')).toBe(true);
  });
  it('accepts degrade and explicit reject without changing absent-option output', () => {
    expect(parseCliArgs(['--relay-fallback=degrade'])).toMatchObject({ relayFallback: 'degrade' });
    expect(parseCliArgs(['--relay-fallback', 'reject'])).toMatchObject({ relayFallback: 'reject' });
    expect(parseCliArgs([]).relayFallback ?? 'degrade').toBe('degrade');
    expect(() => parseCliArgs(['--relay-fallback=other'])).toThrow('Invalid --relay-fallback');
  });
});
