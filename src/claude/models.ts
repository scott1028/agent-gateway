// Claude model catalog: the live `/v1/models` list, cached like the Codex catalog.
// Request shaping adds the pinned capability metadata from ./modelMetadata.ts; the live list
// alone is not used to decide thinking or effort.
import { MODEL_CATALOG_TTL_MS } from '../constants.js';
import { createCachedList } from '../models.js';
import type { ClaudeModel } from './types.js';

export type ClaudeModelCatalog = {
  listModels: () => Promise<ClaudeModel[]>;
  findModel: (slug: string) => Promise<ClaudeModel | undefined>;
};

export const createClaudeModelCatalog = ({
  getModels,
  ttlMs = MODEL_CATALOG_TTL_MS,
  now = Date.now,
}: {
  getModels: () => Promise<ClaudeModel[]>;
  ttlMs?: number;
  now?: () => number;
}): ClaudeModelCatalog => {
  const { list } = createCachedList<ClaudeModel>({ getModels, ttlMs, now });

  // Lookup failure must not block the request: request shaping falls back to pinned metadata.
  const findModel = async (slug: string): Promise<ClaudeModel | undefined> => {
    try {
      return (await list()).find((model) => model.id === slug);
    } catch (error) {
      console.warn(`[claude] catalog lookup failed: ${error instanceof Error ? error.message : String(error)}`);
      return undefined;
    }
  };

  return { listModels: list, findModel };
};
