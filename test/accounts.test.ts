import { describe, expect, it, vi } from 'vitest';
import { findAccountForModel, getRequestModelId, listAccountModels, resolveAccount, type Account } from '../src/accounts.js';
import { createClaudeModelCatalog } from '../src/claude/models.js';
import { createClaudeStateStore } from '../src/claude/state.js';
import type { ClaudeClient } from '../src/claude/client.js';
import type { ClaudeModel } from '../src/claude/types.js';
import { createModelCatalog } from '../src/models.js';
import type { CodexModel } from '../src/types.js';
import type { CodexClient } from '../src/upstream/codexClient.js';
import type { ProxyDeps } from '../src/utils/http.js';

// Project-owned multi-account routing (model id prefixes pick the Codex home).
// There is no counterpart for this in references/codex.

const makeAccount = (alias: string, homePath: string, getModels: () => Promise<CodexModel[]>): Account => ({
  provider: 'codex',
  alias,
  homePath,
  client: {} as CodexClient,
  catalog: createModelCatalog({ getModels }),
});

const makeClaudeAccount = (alias: string, homePath: string, getModels: () => Promise<ClaudeModel[]>): Account => ({
  provider: 'claude',
  alias,
  homePath,
  settingsPath: `${homePath}/settings.json`,
  client: {} as ClaudeClient,
  catalog: createClaudeModelCatalog({ getModels }),
  state: createClaudeStateStore({ stateDir: `${homePath}/state` }),
});

const accounts = [
  makeAccount('codex1', '/tmp/gw1', async () => [{ slug: 'a', visibility: 'list' }]),
  makeAccount('codex2', '/tmp/gw2', async () => [{ slug: 'b', visibility: 'list' }]),
];

const deps: ProxyDeps = { accounts, contextLength: 250000 };

const getResolveAccountError = (modelId: unknown, candidates: Account[] = accounts): Error & { status: number } => {
  try {
    resolveAccount(candidates, modelId);
  } catch (error) {
    return error as Error & { status: number };
  }
  throw new Error('expected resolveAccount to throw');
};

describe('resolveAccount', () => {
  it('uses the account named by the id prefix', () => {
    expect(resolveAccount(accounts, 'codex2/gpt-5.6-terra')).toEqual({ account: accounts[1], slug: 'gpt-5.6-terra' });
  });

  it('falls back to codex1 when the id has no prefix', () => {
    expect(resolveAccount(accounts, 'gpt-5.6-terra')).toEqual({ account: accounts[0], slug: 'gpt-5.6-terra' });
  });

  it('rejects a missing or empty model', () => {
    for (const modelId of [undefined, '', 42]) {
      const error = getResolveAccountError(modelId);
      expect(error.status).toBe(400);
      expect(error.message).toBe('`model` is required');
    }
  });

  it('rejects an unknown prefix and lists the available accounts', () => {
    const error = getResolveAccountError('codex9/gpt-5.6-terra');
    expect(error.status).toBe(400);
    expect(error.message).toBe('Unknown account prefix "codex9"; available: codex1, codex2');
  });
});

describe('resolveAccount with both providers configured', () => {
  const mixed: Account[] = [
    makeAccount('codex1', '/tmp/gw1', async () => [{ slug: 'a', visibility: 'list' }]),
    makeClaudeAccount('claude1', '/tmp/ch1', async () => [{ id: 'claude-sonnet-5' }]),
    makeClaudeAccount('claude2', '/tmp/ch2', async () => [{ id: 'claude-opus-5' }]),
  ];

  it('routes a bare claude-* id to the first Claude account', () => {
    expect(resolveAccount(mixed, 'claude-sonnet-5')).toEqual({ account: mixed[1], slug: 'claude-sonnet-5' });
  });

  it('routes a bare non-claude id to the first Codex account', () => {
    expect(resolveAccount(mixed, 'gpt-5.6-terra')).toEqual({ account: mixed[0], slug: 'gpt-5.6-terra' });
  });

  it('uses the Claude account named by the id prefix', () => {
    expect(resolveAccount(mixed, 'claude2/claude-opus-5')).toEqual({ account: mixed[2], slug: 'claude-opus-5' });
  });

  it('lists both alias pools in the unknown-prefix error', () => {
    const error = getResolveAccountError('claude9/claude-opus-5', mixed);
    expect(error.status).toBe(400);
    expect(error.message).toBe('Unknown account prefix "claude9"; available: codex1, claude1, claude2');
  });

  it('rejects a bare id whose provider is not configured instead of switching providers', () => {
    const claudeOnly = [makeClaudeAccount('claude1', '/tmp/ch1', async () => [{ id: 'claude-sonnet-5' }])];
    const error = getResolveAccountError('gpt-x', claudeOnly);
    expect(error.status).toBe(400);
    expect(error.message).toBe('No codex account is configured for model "gpt-x"; available: claude1');
  });

  it('rejects a bare claude-* id when only Codex accounts are configured', () => {
    const error = getResolveAccountError('claude-sonnet-5', accounts);
    expect(error.status).toBe(400);
    expect(error.message).toBe('No claude account is configured for model "claude-sonnet-5"; available: codex1, codex2');
  });

  it('rejects a prefix with no model name after it', () => {
    const error = getResolveAccountError('claude1/', mixed);
    expect(error.status).toBe(400);
    expect(error.message).toBe('Missing model name after "claude1/"');
  });

  it('finds the routed account without throwing for the chat handler', () => {
    expect(findAccountForModel(mixed, 'claude2/claude-opus-5')).toBe(mixed[2]);
    expect(findAccountForModel(mixed, 'claude-sonnet-5')).toBe(mixed[1]);
    expect(findAccountForModel(mixed, 'gpt-5.6-terra')).toBe(mixed[0]);
    expect(findAccountForModel(mixed, 'codex9/gpt-5')).toBeUndefined();
    expect(findAccountForModel(mixed, undefined)).toBeUndefined();
  });
});

describe('listAccountModels', () => {
  it('merges every account with prefixed ids', async () => {
    const list = await listAccountModels(accounts, { contextLength: 250000 });
    expect(list.data.map((model) => model.id)).toEqual(['codex1/a', 'codex2/b']);
    expect(list.data.every((model) => model.context_length === 250000)).toBe(true);
  });

  it('moves the default model to the first entry', async () => {
    const list = await listAccountModels(accounts, { contextLength: 250000, defaultModelId: 'codex2/b' });
    expect(list.data.map((model) => model.id)).toEqual(['codex2/b', 'codex1/a']);
  });

  it('lists Codex accounts before Claude accounts and labels the owner', async () => {
    const mixed = [
      makeClaudeAccount('claude1', '/tmp/ch1', async () => [{ id: 'claude-sonnet-5' }]),
      makeAccount('codex1', '/tmp/gw1', async () => [{ slug: 'a', visibility: 'list' }]),
    ];
    const list = await listAccountModels(mixed, { contextLength: 200000 });
    expect(list.data).toEqual([
      { id: 'codex1/a', object: 'model', created: 0, owned_by: 'openai', description: 'Codex home: /tmp/gw1', context_length: 200000 },
      {
        id: 'claude1/claude-sonnet-5',
        object: 'model',
        created: 0,
        owned_by: 'anthropic',
        description: 'Claude home: /tmp/ch1',
        context_length: 200000,
      },
    ]);
  });

  it('keeps Claude models when a Codex catalog fails', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const mixed = [
      makeAccount('codex1', '/tmp/gw1', async () => Promise.reject(new Error('down'))),
      makeClaudeAccount('claude1', '/tmp/ch1', async () => [{ id: 'claude-sonnet-5' }]),
    ];
    const list = await listAccountModels(mixed, { contextLength: 250000 });
    expect(list.data.map((model) => model.id)).toEqual(['claude1/claude-sonnet-5']);
  });

  it('keeps the order when the default model is not listed', async () => {
    const list = await listAccountModels(accounts, { contextLength: 250000, defaultModelId: 'codex9/missing' });
    expect(list.data.map((model) => model.id)).toEqual(['codex1/a', 'codex2/b']);
  });

  it('warns and skips an account whose catalog fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const mixed = [
      makeAccount('codex1', '/tmp/gw1', async () => Promise.reject(new Error('down'))),
      makeAccount('codex2', '/tmp/gw2', async () => [{ slug: 'b', visibility: 'list' }]),
    ];
    const list = await listAccountModels(mixed, { contextLength: 250000 });
    expect(list.data.map((model) => model.id)).toEqual(['codex2/b']);
    expect(warn).toHaveBeenCalledWith('[models] codex1 skipped: down');
  });

  it('throws the first error when every account fails', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const failing = [
      makeAccount('codex1', '/tmp/gw1', async () => Promise.reject(new Error('first'))),
      makeAccount('codex2', '/tmp/gw2', async () => Promise.reject(new Error('second'))),
    ];
    await expect(listAccountModels(failing, { contextLength: 250000 })).rejects.toThrow('first');
  });
});

describe('getRequestModelId', () => {
  it('passes a model from the request through', async () => {
    expect(await getRequestModelId(deps, 'codex2/b')).toBe('codex2/b');
    expect(await getRequestModelId(deps, 42)).toBe(42);
  });

  it('uses defaultModelId when the request has no model', async () => {
    for (const modelId of [undefined, null, '']) {
      expect(await getRequestModelId({ ...deps, defaultModelId: 'codex2/b' }, modelId)).toBe('codex2/b');
    }
  });

  it('uses the first listed model when there is no defaultModelId', async () => {
    expect(await getRequestModelId(deps, undefined)).toBe('codex1/a');
  });

  it('rejects when no model is available', async () => {
    const emptyDeps: ProxyDeps = { accounts: [makeAccount('codex1', '/tmp/gw1', async () => [])], contextLength: 250000 };
    await expect(getRequestModelId(emptyDeps, undefined)).rejects.toThrow('No model available; send `model` or start with --model');
  });
});
