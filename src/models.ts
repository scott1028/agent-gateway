// Model catalogs and the OpenAI-shaped model list. The `codexN/` id prefix and the description
// field come from our multi-account routing, not from references/codex or the Claude release.
import { MODEL_CATALOG_TTL_MS, MODEL_ID_SEPARATOR } from './constants.js';
import type { ClaudeModel } from './claude/types.js';
import type { CodexModel, Provider } from './types.js';

export type ModelCatalog = {
  listModels: () => Promise<CodexModel[]>;
  findModel: (slug: string) => Promise<CodexModel | undefined>;
};

// Shared TTL cache so every provider catalog behaves the same way on refresh storms.
export const createCachedList = <Model>(input: {
  getModels: () => Promise<Model[]>;
  ttlMs?: number;
  now?: () => number;
}): { list: () => Promise<Model[]> } => {
  const { getModels, ttlMs = MODEL_CATALOG_TTL_MS, now = Date.now } = input;
  let cache: { models: Model[]; fetchedAtMs: number } | undefined;
  let inflight: Promise<Model[]> | undefined;

  const list = async (): Promise<Model[]> => {
    if (cache && now() - cache.fetchedAtMs < ttlMs) return cache.models;
    inflight ??= getModels()
      .then((models) => {
        cache = { models, fetchedAtMs: now() };
        return models;
      })
      .finally(() => {
        inflight = undefined;
      });
    return inflight;
  };

  return { list };
};

export const createModelCatalog = ({
  getModels,
  ttlMs = MODEL_CATALOG_TTL_MS,
  now = Date.now,
}: {
  getModels: () => Promise<CodexModel[]>;
  ttlMs?: number;
  now?: () => number;
}): ModelCatalog => {
  const { list } = createCachedList<CodexModel>({ getModels, ttlMs, now });

  // Lookup failure must not block the request: it only decides Responses Lite shaping.
  const findModel = async (slug: string): Promise<CodexModel | undefined> => {
    try {
      return (await list()).find((model) => model.slug === slug);
    } catch (error) {
      console.warn(`[models] catalog lookup failed: ${error instanceof Error ? error.message : String(error)}`);
      return undefined;
    }
  };

  return { listModels: list, findModel };
};

export type ModelListEntry = {
  alias: string;
  homePath: string;
  provider?: Provider;
  models: Array<CodexModel | ClaudeModel>;
};

// One entry per account: ids are prefixed with the account alias so clients pick the account.
// context_length is a label for agent CLIs; the gateway never enforces it.
export const toOpenAiModelList = (
  entries: ModelListEntry[],
  contextLength: number,
): {
  object: 'list';
  data: Array<{ id: string; object: 'model'; created: number; owned_by: string; description: string; context_length: number }>;
} => ({
  object: 'list',
  data: entries.flatMap((entry) => {
    if (entry.provider === 'claude') {
      return (entry.models as ClaudeModel[]).map((model) => ({
        id: `${entry.alias}${MODEL_ID_SEPARATOR}${model.id}`,
        object: 'model' as const,
        created: 0,
        owned_by: 'anthropic',
        description: `Claude home: ${entry.homePath}`,
        context_length: contextLength,
      }));
    }
    return (entry.models as CodexModel[])
      .filter((model) => model.visibility === 'list')
      .sort((left, right) => (left.priority ?? Number.MAX_SAFE_INTEGER) - (right.priority ?? Number.MAX_SAFE_INTEGER))
      .map((model) => ({
        id: `${entry.alias}${MODEL_ID_SEPARATOR}${model.slug}`,
        object: 'model' as const,
        created: 0,
        owned_by: 'openai',
        description: `Codex home: ${entry.homePath}`,
        context_length: contextLength,
      }));
  }),
});
