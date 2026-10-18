import { createHash } from 'node:crypto';
import { RELAY_REASONING_MAX_ENTRIES } from '../constants.js';

export type ReasoningStore = {
  record: (alias: string, reasoning: string) => void;
  has: (alias: string, reasoning: string) => boolean;
};

// Same bounded Map-order LRU as createClaudeRelaySessions; only hashes are retained.
export const createReasoningStore = (): ReasoningStore => {
  const hashes = new Set<string>();
  const getKey = (alias: string, reasoning: string): string =>
    JSON.stringify([alias, createHash('sha256').update(reasoning).digest('hex')]);
  return {
    record: (alias, reasoning) => {
      const key = getKey(alias, reasoning);
      hashes.delete(key);
      hashes.add(key);
      if (hashes.size > RELAY_REASONING_MAX_ENTRIES) hashes.delete(hashes.values().next().value!);
    },
    has: (alias, reasoning) => {
      const key = getKey(alias, reasoning);
      if (!hashes.has(key)) return false;
      hashes.delete(key);
      hashes.add(key);
      return true;
    },
  };
};
