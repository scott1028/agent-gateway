// Project-owned relay fallback state; references/** does not track replayed reasoning this way.
import { describe, expect, it } from 'vitest';
import { RELAY_REASONING_MAX_ENTRIES } from '../../src/constants.js';
import { createReasoningStore } from '../../src/utils/reasoningStore.js';

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
});
