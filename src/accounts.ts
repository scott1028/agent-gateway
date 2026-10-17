// Project-owned multi-account routing: model ids are `<alias>/<provider model id>`, aliases are
// numbered per provider in configured order (`codex1`, `claude1`, ...). There is no counterpart
// for this in references/codex or the Claude release.
import { CLAUDE_HOME_ALIAS_PREFIX, MODEL_ID_SEPARATOR } from './constants.js';
import type { Provider } from './types.js';
import type { ClaudeClient } from './claude/client.js';
import type { ClaudeModelCatalog } from './claude/models.js';
import type { ClaudeStateStore } from './claude/state.js';
import { createProxyError } from './errors.js';
import { type ModelCatalog, type ModelListEntry, toOpenAiModelList } from './models.js';
import type { CodexClient } from './upstream/codexClient.js';
import type { ProxyDeps } from './utils/http.js';

export type CodexAccount = {
  provider: 'codex';
  alias: string;
  homePath: string;
  client: CodexClient;
  catalog: ModelCatalog;
};

export type ClaudeAccount = {
  provider: 'claude';
  alias: string;
  homePath: string;
  settingsPath: string;
  client: ClaudeClient;
  catalog: ClaudeModelCatalog;
  state: ClaudeStateStore;
};

export type Account = CodexAccount | ClaudeAccount;

const getProviderOfBareModelId = (modelId: string): Provider => (modelId.startsWith(`${CLAUDE_HOME_ALIAS_PREFIX}-`) ? 'claude' : 'codex');

// Bare ids: `claude-*` belongs to the first Claude account, everything else to the first Codex
// account. A missing provider is an error, never a silent switch to the other provider.
const getBareAlias = (accounts: Account[], modelId: string): string | undefined =>
  accounts.find((account) => account.provider === getProviderOfBareModelId(modelId))?.alias;

// Non-throwing lookup: the chat handler needs the provider before it converts the body, because
// Claude rejects input shapes the shared Chat -> Responses conversion would silently drop.
export const findAccountForModel = (accounts: Account[], modelId: unknown): Account | undefined => {
  if (typeof modelId !== 'string' || modelId === '') return undefined;
  const separatorIndex = modelId.indexOf(MODEL_ID_SEPARATOR);
  const alias = separatorIndex === -1 ? getBareAlias(accounts, modelId) : modelId.slice(0, separatorIndex);
  return accounts.find((candidate) => candidate.alias === alias);
};

export const resolveAccount = (accounts: Account[], modelId: unknown): { account: Account; slug: string } => {
  if (typeof modelId !== 'string' || modelId === '') {
    throw createProxyError({ status: 400, message: '`model` is required' });
  }
  const account = findAccountForModel(accounts, modelId);
  if (account === undefined) {
    const available = accounts.map((candidate) => candidate.alias).join(', ');
    const isBare = !modelId.includes(MODEL_ID_SEPARATOR);
    throw createProxyError({
      status: 400,
      message: isBare
        ? `No ${getProviderOfBareModelId(modelId)} account is configured for model "${modelId}"; available: ${available}`
        : `Unknown account prefix "${modelId.slice(0, modelId.indexOf(MODEL_ID_SEPARATOR))}"; available: ${available}`,
    });
  }
  const slug = modelId.slice(modelId.indexOf(MODEL_ID_SEPARATOR) + 1);
  if (slug === '') throw createProxyError({ status: 400, message: `Missing model name after "${account.alias}/"` });
  return { account, slug };
};

const getProviderRank = (account: Account): number => (account.provider === 'codex' ? 0 : 1);

// One home being unreachable must not hide the other homes' models.
export const listAccountModels = async (
  accounts: Account[],
  { contextLength, defaultModelId }: { contextLength: number; defaultModelId?: string },
): Promise<ReturnType<typeof toOpenAiModelList>> => {
  const ordered = [...accounts].sort((left, right) => getProviderRank(left) - getProviderRank(right));
  const settled = await Promise.allSettled(
    ordered.map(async (account) => ({
      alias: account.alias,
      homePath: account.homePath,
      provider: account.provider,
      models: await account.catalog.listModels(),
    })),
  );
  const entries: ModelListEntry[] = [];
  let firstError: unknown;
  for (const [index, result] of settled.entries()) {
    if (result.status === 'fulfilled') {
      entries.push(result.value);
      continue;
    }
    firstError ??= result.reason;
    const reason = result.reason instanceof Error ? result.reason.message : String(result.reason);
    console.warn(`[models] ${ordered[index]?.alias} skipped: ${reason}`);
  }
  // Single home: same behavior as before, the error reaches the client.
  if (entries.length === 0) throw firstError;
  const list = toOpenAiModelList(entries, contextLength);
  // Clients that read data[0] should get the default model.
  const defaultIndex = defaultModelId === undefined ? -1 : list.data.findIndex((model) => model.id === defaultModelId);
  if (defaultIndex > 0) list.data.unshift(...list.data.splice(defaultIndex, 1));
  return list;
};

// A request without a model falls back to --model, then to the first model in /v1/models.
// Anything else is passed through so resolveAccount still reports the 400 for it.
export const getRequestModelId = async (deps: ProxyDeps, modelId: unknown): Promise<unknown> => {
  if (modelId !== undefined && modelId !== null && modelId !== '') return modelId;
  if (deps.defaultModelId !== undefined) return deps.defaultModelId;
  const firstModelId = (await listAccountModels(deps.accounts, { contextLength: deps.contextLength })).data[0]?.id;
  if (firstModelId === undefined) {
    throw createProxyError({ status: 400, message: 'No model available; send `model` or start with --model' });
  }
  return firstModelId;
};
