import { describe, expect, it, vi } from 'vitest';
import { createModelCatalog, toOpenAiModelList } from '../src/models.js';

// Project-owned model listing: the `codexN/` id prefix and the description field come from
// our multi-account routing, not from references/codex.
describe('toOpenAiModelList', () => {
  it('keeps listed models sorted by priority', () => {
    expect(
      toOpenAiModelList(
        [
          {
            alias: 'codex1',
            homePath: '/tmp/gw1',
            models: [
              { slug: 'b', visibility: 'list', priority: 2 },
              { slug: 'hidden', visibility: 'hide', priority: 0 },
              { slug: 'a', visibility: 'list', priority: 1 },
            ],
          },
        ],
        250000,
      ).data.map((model) => model.id),
    ).toEqual(['codex1/a', 'codex1/b']);
  });

  it('reports the configured context_length on every entry', () => {
    const list = toOpenAiModelList(
      [
        { alias: 'codex1', homePath: '/tmp/gw1', models: [{ slug: 'x', visibility: 'list' }] },
        { alias: 'codex2', homePath: '/tmp/gw2', models: [{ slug: 'y', visibility: 'list' }] },
      ],
      128000,
    );
    expect(list.data.map((model) => model.context_length)).toEqual([128000, 128000]);
  });

  it('prefixes ids per account, describes the home, and filters and sorts per account', () => {
    expect(
      toOpenAiModelList(
        [
          { alias: 'codex1', homePath: '/tmp/gw1', models: [{ slug: 'x', visibility: 'list', priority: 5 }] },
          {
            alias: 'codex2',
            homePath: '/tmp/gw2',
            models: [
              { slug: 'x', visibility: 'list', priority: 9 },
              { slug: 'y', visibility: 'list', priority: 1 },
              { slug: 'hidden', visibility: 'hide' },
            ],
          },
        ],
        250000,
      ).data,
    ).toEqual([
      {
        id: 'codex1/x',
        object: 'model',
        created: 0,
        owned_by: 'openai',
        description: 'Codex home: /tmp/gw1',
        context_length: 250000,
      },
      {
        id: 'codex2/y',
        object: 'model',
        created: 0,
        owned_by: 'openai',
        description: 'Codex home: /tmp/gw2',
        context_length: 250000,
      },
      {
        id: 'codex2/x',
        object: 'model',
        created: 0,
        owned_by: 'openai',
        description: 'Codex home: /tmp/gw2',
        context_length: 250000,
      },
    ]);
  });
});

describe('createModelCatalog', () => {
  it('caches within the TTL and refetches after', async () => {
    let nowMs = 0;
    const getModels = vi.fn(async () => [{ slug: 'a' }]);
    const catalog = createModelCatalog({ getModels, ttlMs: 1000, now: () => nowMs });
    await catalog.listModels();
    await catalog.findModel('a');
    expect(getModels).toHaveBeenCalledTimes(1);
    nowMs = 1500;
    await catalog.listModels();
    expect(getModels).toHaveBeenCalledTimes(2);
  });

  it('findModel returns undefined when the catalog fails', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const catalog = createModelCatalog({ getModels: async () => Promise.reject(new Error('down')) });
    expect(await catalog.findModel('a')).toBeUndefined();
  });
});
