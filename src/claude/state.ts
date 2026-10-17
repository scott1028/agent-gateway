// Gateway-owned thinking/signature replay state, stored under the selected Claude home so a
// restart can continue a tool-use turn. Records are keyed by account identity + model +
// (conversation prefix + visible assistant identity), so two branches of one prefix coexist and
// a copied or corrupt record is rejected before replay. Official Claude files are never touched,
// and nothing here is logged or echoed back in an error. Files are 0600 in a 0700 directory,
// written atomically, and only after a validated message_stop (never a partial turn).
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { CLAUDE_EFFORT_LEVELS, CLAUDE_MIN_THINKING_BUDGET_TOKENS, CLAUDE_STATE_VERSION } from '../constants.js';
import { createProxyError } from '../errors.js';
import type { Json } from '../types.js';
import type { ClaudeThinking, ClaudeTurnState } from './types.js';

export type ClaudeStateStore = {
  read: (stateKey: string) => Promise<ClaudeTurnState | undefined>;
  save: (input: {
    accountIdentity: string;
    alias: string;
    model: string;
    identity: string;
    thinking: ClaudeThinking;
    assistantContent: Json[];
    callIds: string[];
    nowMs?: number;
  }) => Promise<void>;
};

export type ClaudeConversationOptions = { instructions?: string };

// One assistant boundary: a run of client-visible assistant items (message + function_call) that
// came from a single native assistant turn, plus the conversation prefix that identifies it.
export type ClaudeAssistantBoundary = {
  start: number;
  end: number;
  callIds: string[];
  prefixIdentity: string;
  visibleIdentity: string;
  isPendingToolTurn: boolean;
};

const hash = (text: string): string => createHash('sha256').update(text).digest('hex');

// Canonical JSON: object keys sorted at every depth, so a client that reorders keys or changes
// spacing keeps the same identity and the same replay match.
const canonicalize = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize((value as Json)[key])]));
  }
  return value;
};

export const normalizeClaudeToolInput = (value: unknown): string => {
  if (typeof value === 'string') {
    if (value === '') return '{}';
    try {
      return JSON.stringify(canonicalize(JSON.parse(value)));
    } catch {
      return JSON.stringify(value);
    }
  }
  return JSON.stringify(canonicalize(value ?? {}));
};

// Structural canonical serialization: nested arrays are JSON encoded, so no text content can be
// forged into a boundary between two parts the way a joined string would allow.
const getPartStructure = (part: Json): unknown => {
  if (part.type === 'input_text' || part.type === 'output_text' || part.type === 'text') return ['t', String(part.text ?? '')];
  if (part.type === 'refusal') return ['r', String(part.refusal ?? '')];
  const image = typeof part.image_url === 'string' ? part.image_url : typeof part.url === 'string' ? part.url : '';
  return ['i', hash(String(image))];
};

const getContentStructure = (content: unknown): unknown[] => {
  if (typeof content === 'string') return content === '' ? [] : [['t', content]];
  if (!Array.isArray(content)) return [];
  return (content as Json[]).map(getPartStructure);
};

const getOutputStructure = (output: unknown): unknown => {
  if (typeof output === 'string') return ['s', output];
  if (Array.isArray(output)) return ['a', (output as Json[]).map(getPartStructure)];
  return ['j', normalizeClaudeToolInput(output)];
};

const getItemStructure = (item: Json): unknown => {
  switch (item.type) {
    // Codex-only items and client reasoning items are optional in a client echo, so they must not
    // change the identity of the turn being continued.
    case 'additional_tools':
    case 'reasoning':
      return undefined;
    case 'message':
      return ['m', String(item.role ?? ''), getContentStructure(item.content)];
    case 'function_call':
      return ['c', String(item.call_id ?? ''), String(item.name ?? ''), normalizeClaudeToolInput(item.arguments)];
    // Historical tool results stay in the identity: they are what separates two branches that
    // otherwise share the same assistant turn.
    case 'function_call_output':
      return ['o', String(item.call_id ?? ''), getOutputStructure(item.output)];
    default:
      return ['x', String(item.type)];
  }
};

export const getClaudeConversationIdentity = (items: Json[], options: ClaudeConversationOptions = {}): string =>
  hash(JSON.stringify([options.instructions ?? null, items.map(getItemStructure).filter((structure) => structure !== undefined)]));

// Shorthand Responses input: a bare string, or a message object without `type`, is a user message.
export const getClaudeInputItems = (body: Json): Json[] => {
  if (typeof body.input === 'string') return [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: body.input }] }];
  if (!Array.isArray(body.input)) return [];
  return (body.input as Json[]).map((item) =>
    typeof item === 'string'
      ? { type: 'message', role: 'user', content: [{ type: 'input_text', text: item }] }
      : typeof item?.type === 'string' || typeof item?.role !== 'string'
        ? item
        : { ...item, type: 'message' },
  );
};

const isAssistantItem = (item: Json): boolean =>
  item.type === 'function_call' || (item.type === 'message' && item.role === 'assistant');

// Client reasoning shells and Codex additional_tools items never reached the native turn, so they
// must not split one echoed assistant turn into two boundaries.
export const isBoundaryNeutralItem = (item: Json): boolean => item.type === 'reasoning' || item.type === 'additional_tools';

// Assistant boundaries are the units a native turn is replayed for. The last one is "pending" when
// the request ends with the tool results for its calls: that turn is still open, so its signed
// content must come back from state and its thinking configuration is pinned.
export const getClaudeAssistantBoundaries = (items: Json[], options: ClaudeConversationOptions = {}): ClaudeAssistantBoundary[] => {
  const boundaries: ClaudeAssistantBoundary[] = [];
  for (let index = 0; index < items.length; index += 1) {
    if (!isAssistantItem(items[index] as Json)) continue;
    const start = index;
    let end = index;
    let lastAssistantEnd = index;
    while (end < items.length && (isAssistantItem(items[end] as Json) || isBoundaryNeutralItem(items[end] as Json))) {
      if (isAssistantItem(items[end] as Json)) lastAssistantEnd = end + 1;
      end += 1;
    }
    end = lastAssistantEnd;
    const callIds = items
      .slice(start, end)
      .filter((item) => item.type === 'function_call')
      .map((item) => String(item.call_id ?? ''));
    const trailing = items.slice(end).filter((item) => !isBoundaryNeutralItem(item));
    boundaries.push({
      start,
      end,
      callIds,
      prefixIdentity: getClaudeConversationIdentity(items.slice(0, start), options),
      visibleIdentity: getClaudeVisibleAssistantIdentity(items.slice(start, end)),
      isPendingToolTurn: callIds.length > 0 && trailing.length > 0 && trailing.every((item) => item.type === 'function_call_output'),
    });
    index = end - 1;
  }
  return boundaries;
};

// Canonical visible identity of one assistant turn: the visible text flattened in order plus the
// ordered tool calls (id, name, canonical arguments). Chat's aggregated assistant message, the
// Responses item echo, and the native content saved when the turn was generated all produce the
// same structure, so two branches of the same prefix get two different state records and each
// continuation finds its own signed turn again.
const getVisibleAssistantStructure = (texts: string[], calls: [string, string, string][]): string =>
  hash(JSON.stringify([texts.join(''), calls]));

export const getClaudeVisibleAssistantIdentity = (boundaryItems: Json[]): string => {
  const texts: string[] = [];
  const calls: [string, string, string][] = [];
  for (const item of boundaryItems) {
    if (item.type === 'message' && item.role === 'assistant') {
      if (typeof item.content === 'string') texts.push(item.content);
      else if (Array.isArray(item.content)) {
        for (const part of item.content as Json[]) {
          if (part.type === 'refusal') continue;
          texts.push(typeof part.text === 'string' ? part.text : '');
        }
      }
    } else if (item.type === 'function_call') {
      calls.push([String(item.call_id ?? ''), String(item.name ?? ''), normalizeClaudeToolInput(item.arguments)]);
    }
  }
  return getVisibleAssistantStructure(texts, calls);
};

// Same structure derived from the native assistant content that is being saved.
export const getClaudeNativeVisibleIdentity = (assistantContent: Json[]): string => {
  const texts: string[] = [];
  const calls: [string, string, string][] = [];
  for (const block of assistantContent) {
    if (block.type === 'text') texts.push(typeof block.text === 'string' ? block.text : '');
    else if (block.type === 'tool_use') {
      calls.push([String(block.id ?? ''), String(block.name ?? ''), normalizeClaudeToolInput(block.input ?? {})]);
    }
  }
  return getVisibleAssistantStructure(texts, calls);
};

// Account identity is more than the alias: re-logging a home into another account must not reuse
// the previous account's signed state. The uuid comes from the home's global config file and is
// REQUIRED: without a proven account identity, two different logins of one home would share one
// state key, so the caller must fail instead of keying signed replay on an unproven identity.
// organizationUuid is deliberately NOT a substitute: it names an organization, not the user.
export const getClaudeAccountIdentity = (homePath: string, accountUuid: string): string =>
  hash(`claude-account\u0000${homePath}\u0000${accountUuid}`);

export const getClaudeStateKey = (accountIdentity: string, model: string, identity: string): string =>
  hash(`${accountIdentity}\u0000${model}\u0000${identity}`);

const THINKING_TYPES = ['adaptive', 'enabled', 'disabled'];

const getCorruptStateError = (reason: string): Error =>
  createProxyError({ status: 400, message: `Claude turn state is corrupt and cannot be replayed (${reason}); start a new conversation` });

// Stored blocks are replayed verbatim upstream, so every required native field is validated here;
// a corrupt budget/signature or a record copied from another turn must never reach the network.
const parseNativeBlock = (block: Json): void => {
  switch (block.type) {
    case 'text':
      if (typeof block.text !== 'string') throw getCorruptStateError('text block without string text');
      return;
    case 'tool_use':
      if (typeof block.id !== 'string' || block.id === '') throw getCorruptStateError('tool_use block without id');
      if (typeof block.name !== 'string' || block.name === '') throw getCorruptStateError('tool_use block without name');
      if (typeof block.input !== 'object' || block.input === null || Array.isArray(block.input)) {
        throw getCorruptStateError('tool_use block without object input');
      }
      return;
    case 'thinking':
      if (typeof block.thinking !== 'string') throw getCorruptStateError('thinking block without thinking text');
      if (typeof block.signature !== 'string' || block.signature === '') throw getCorruptStateError('thinking block without signature');
      return;
    case 'redacted_thinking':
      if (typeof block.data !== 'string' || block.data === '') throw getCorruptStateError('redacted_thinking block without data');
      return;
    case 'compaction':
      if (typeof block.content !== 'string') throw getCorruptStateError('compaction block without content');
      return;
    default:
      throw getCorruptStateError(`unknown block type "${String(block.type)}"`);
  }
};

const parseThinking = (thinking: unknown): void => {
  if (typeof thinking !== 'object' || thinking === null) throw getCorruptStateError('missing thinking configuration');
  const record = thinking as ClaudeThinking;
  if (!THINKING_TYPES.includes(record.type)) throw getCorruptStateError(`unsupported thinking type ${String(record.type)}`);
  // The stored budget is replayed as the pinned configuration, so it must already satisfy the
  // official 1024-token floor (226635226); a smaller value is corrupt, never silently raised.
  if (record.type === 'enabled' && (typeof record.budgetTokens !== 'number' || !Number.isInteger(record.budgetTokens) || record.budgetTokens < CLAUDE_MIN_THINKING_BUDGET_TOKENS)) {
    throw getCorruptStateError(`enabled thinking without a budgetTokens at or above ${CLAUDE_MIN_THINKING_BUDGET_TOKENS}`);
  }
  if (record.type !== 'enabled' && record.budgetTokens !== undefined) throw getCorruptStateError('budgetTokens on non-budgeted thinking');
  if (record.effort !== undefined && !(CLAUDE_EFFORT_LEVELS as readonly string[]).includes(record.effort)) {
    throw getCorruptStateError(`unknown effort level ${String(record.effort)}`);
  }
  // requestedEffort is the explicit word the turn was created with, so it must come from the
  // supported domain (the effort levels plus "none"); anything else is forged or corrupt.
  if (record.requestedEffort !== undefined && ![...(CLAUDE_EFFORT_LEVELS as readonly string[]), 'none'].includes(record.requestedEffort)) {
    throw getCorruptStateError(`unknown requestedEffort ${String(record.requestedEffort)}`);
  }
};

const parseState = (text: string): ClaudeTurnState => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw getCorruptStateError('not valid JSON');
  }
  if (typeof parsed !== 'object' || parsed === null) throw getCorruptStateError('not an object');
  const state = parsed as ClaudeTurnState;
  if (state.version !== CLAUDE_STATE_VERSION) throw getCorruptStateError(`unsupported version ${String(state.version)}`);
  if (typeof state.alias !== 'string' || typeof state.model !== 'string') throw getCorruptStateError('missing alias or model');
  if (typeof state.accountIdentity !== 'string' || state.accountIdentity === '') throw getCorruptStateError('missing account identity');
  if (typeof state.identity !== 'string' || state.identity === '') throw getCorruptStateError('missing conversation identity');
  if (typeof state.savedAtMs !== 'number') throw getCorruptStateError('missing savedAtMs');
  parseThinking(state.thinking);
  if (!Array.isArray(state.assistantContent)) throw getCorruptStateError('assistantContent is not a block array');
  for (const block of state.assistantContent) {
    if (typeof block !== 'object' || block === null || typeof block.type !== 'string') throw getCorruptStateError('assistantContent is not a block array');
    parseNativeBlock(block);
  }
  if (!Array.isArray(state.callIds) || !state.callIds.every((callId) => typeof callId === 'string')) {
    throw getCorruptStateError('callIds is not a string array');
  }
  const nativeCallIds = state.assistantContent.filter((block) => block.type === 'tool_use').map((block) => String(block.id));
  if (nativeCallIds.length !== state.callIds.length || nativeCallIds.some((callId, index) => callId !== state.callIds[index])) {
    throw getCorruptStateError('callIds do not match the stored tool_use blocks');
  }
  return state;
};

export const createClaudeStateStore = ({ stateDir }: { stateDir: string }): ClaudeStateStore => {
  const getFilePath = (stateKey: string): string => path.join(stateDir, `${stateKey}.json`);

  const read = async (stateKey: string): Promise<ClaudeTurnState | undefined> => {
    let text: string;
    try {
      text = await readFile(getFilePath(stateKey), 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw createProxyError({ status: 400, message: `Cannot read Claude turn state (${String((error as NodeJS.ErrnoException).code ?? 'error')})` });
    }
    const state = parseState(text);
    // A record copied or renamed under another key must not replay into the wrong turn.
    if (getClaudeStateKey(state.accountIdentity, state.model, state.identity) !== stateKey) {
      throw getCorruptStateError('record does not match the key it is stored under');
    }
    return state;
  };

  const save = async (input: {
    accountIdentity: string;
    alias: string;
    model: string;
    identity: string;
    thinking: ClaudeThinking;
    assistantContent: Json[];
    callIds: string[];
    nowMs?: number;
  }): Promise<void> => {
    const stateKey = getClaudeStateKey(input.accountIdentity, input.model, input.identity);
    const filePath = getFilePath(stateKey);
    const tmpPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
    const state: ClaudeTurnState = {
      version: CLAUDE_STATE_VERSION,
      alias: input.alias,
      model: input.model,
      accountIdentity: input.accountIdentity,
      identity: input.identity,
      thinking: input.thinking,
      savedAtMs: input.nowMs ?? Date.now(),
      assistantContent: input.assistantContent,
      callIds: input.callIds,
    };
    await mkdir(stateDir, { recursive: true, mode: 0o700 });
    try {
      await writeFile(tmpPath, `${JSON.stringify(state)}\n`, { mode: 0o600 });
      await rename(tmpPath, filePath);
    } catch (error) {
      await unlink(tmpPath).catch(() => undefined);
      throw createProxyError({ status: 500, code: 'state_write_failed', message: `Cannot write Claude turn state (${String((error as NodeJS.ErrnoException).code ?? 'error')})` });
    }
  };

  return { read, save };
};
