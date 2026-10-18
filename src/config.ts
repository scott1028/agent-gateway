import { readdirSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import {
  CLAUDE_CREDENTIALS_FILE,
  CLAUDE_HOME_ALIAS_PREFIX,
  CLAUDE_SETTINGS_FILE,
  CLAUDE_STATE_DIR,
  CODEX_BASE_URL,
  CODEX_HOME_ALIAS_PREFIX,
  DEFAULT_CLIENT_VERSION,
  DEFAULT_CONTEXT_LENGTH,
  DEFAULT_HOST,
  DEFAULT_PORT,
  LOOPBACK_BIND_HOSTS,
  MODEL_ID_SEPARATOR,
  REFRESH_URL,
} from './constants.js';
import type { AutoHomes, ClaudeHome, CodexHome, Config, DebugLevel } from './types.js';

export const USAGE_TEXT = `Usage: agent-gateway [--auto] [--codex-home <path> ...] [--claude-home <path> ...]

Local OpenAI-compatible proxy for the Codex ChatGPT backend and the Claude Messages API.

Options:
  --codex-home <path>   Codex home that holds auth.json. Repeat for more accounts;
                        the order sets the model id prefix: codex1/, codex2/, ...
  --claude-home <path>  Claude home that holds .credentials.json. Repeat for more accounts;
                        the order sets the model id prefix: claude1/, claude2/, ...
  --auto                Use every logged-in ~/.codex, ~/.codex-*, ~/.claude, ~/.claude-* home, in name
                        order. Cannot be combined with other home flags or env. Do not run the codex CLI
                        on those homes at the same time: both would refresh the same token.
  --debug [0-3]        Print request/response logs; authorization always masked (default level: 0).
                        0: method + URL for incoming and upstream calls.
                        1: 0 plus full headers and request/response bodies for upstream calls.
                        2: 0 plus full headers and request/response bodies for incoming calls.
                        3: full headers and request/response bodies for both incoming and upstream calls.
  --relay-fallback <reject|degrade>  On relay account/shape mismatch (default: reject).
  --model <id>          Default model when a request has no model (default: first model in /v1/models).
  --context-length <n>  context_length reported in /v1/models (default ${DEFAULT_CONTEXT_LENGTH}).
  --host <addr>         Address to listen on (default ${DEFAULT_HOST}). Any address other than
                        127.0.0.1 or ::1, such as 0.0.0.0 or localhost, requires AGENT_GATEWAY_API_KEY.
  -h, --help            Show this help.

Environment (used only when the matching flag is not given):
  AGENT_GATEWAY_CODEX_HOMES   Codex homes separated by "${path.delimiter}" (absolute paths or $HOME; ~ is not expanded)
  AGENT_GATEWAY_HOME          One Codex home (cannot be combined with AGENT_GATEWAY_CODEX_HOMES)
  AGENT_GATEWAY_CLAUDE_HOMES  Claude homes separated by "${path.delimiter}" (absolute paths or $HOME; ~ is not expanded)
  AGENT_GATEWAY_HOST          Address to listen on (default ${DEFAULT_HOST})
  AGENT_GATEWAY_PORT          Port to listen on (default ${DEFAULT_PORT})
  AGENT_GATEWAY_API_KEY       Require "Authorization: Bearer <key>" on every request (printable ASCII,
                              no spaces); required when the host is not 127.0.0.1 or ::1
  CODEX_CLIENT_VERSION        Client version sent upstream (default ${DEFAULT_CLIENT_VERSION})

At least one provider home is required; there is no default directory unless --auto is given.
Log in each Codex home first: CODEX_HOME=<path> codex login
Log in each Claude home first: CLAUDE_CONFIG_DIR=<path> claude`;

export const parseCliArgs = (
  args: string[],
): {
  codexHomes: string[];
  claudeHomes: string[];
  contextLength?: string;
  relayFallback?: 'reject' | 'degrade';
  model?: string;
  host?: string;
  isAutoEnabled: boolean;
  isDebugEnabled: boolean;
  debugLevel: DebugLevel;
  isHelpRequested: boolean;
} => {
  const { values } = parseArgs({
    // node:util has no optional option values; a bare --debug keeps the original level 0.
    args: args.map((arg, index) => arg === '--debug' && (args[index + 1] === undefined || args[index + 1]!.startsWith('-'))
      ? '--debug=0'
      : arg),
    options: {
      auto: { type: 'boolean' },
      'claude-home': { type: 'string', multiple: true },
      'codex-home': { type: 'string', multiple: true },
      'context-length': { type: 'string' },
      debug: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
      host: { type: 'string' },
      model: { type: 'string' },
      'relay-fallback': { type: 'string' },
    },
  });
  if (values.debug !== undefined && !['0', '1', '2', '3'].includes(values.debug)) {
    throw new Error(`Invalid --debug: ${values.debug}; expected 0, 1, 2, or 3`);
  }
  const relayFallback = values['relay-fallback'];
  if (relayFallback !== undefined && relayFallback !== 'reject' && relayFallback !== 'degrade') {
    throw new Error(`Invalid --relay-fallback: ${relayFallback}; expected reject or degrade`);
  }
  return {
    ...(relayFallback === undefined ? {} : { relayFallback }),
    codexHomes: values['codex-home'] ?? [],
    claudeHomes: values['claude-home'] ?? [],
    contextLength: values['context-length'],
    model: values.model,
    host: values.host,
    isAutoEnabled: values.auto === true,
    isDebugEnabled: values.debug !== undefined,
    debugLevel: values.debug === undefined ? 0 : Number(values.debug) as DebugLevel,
    isHelpRequested: values.help === true,
  };
};

// Home order decides the alias, so --codex-home > AGENT_GATEWAY_CODEX_HOMES > AGENT_GATEWAY_HOME > error.
const getCodexHomePaths = (env: NodeJS.ProcessEnv, cliHomes: string[], hasClaudeHomes: boolean): string[] => {
  if (cliHomes.length > 0) return cliHomes.map((home) => path.resolve(home));
  const envHomes = env.AGENT_GATEWAY_CODEX_HOMES?.split(path.delimiter).filter((home) => home !== '');
  if (envHomes !== undefined) {
    if (env.AGENT_GATEWAY_HOME) {
      throw new Error('Set only one of AGENT_GATEWAY_CODEX_HOMES and AGENT_GATEWAY_HOME');
    }
    if (envHomes.length === 0) throw new Error('AGENT_GATEWAY_CODEX_HOMES must list at least one codex home');
    return envHomes.map((home) => path.resolve(home));
  }
  if (env.AGENT_GATEWAY_HOME) return [path.resolve(env.AGENT_GATEWAY_HOME)];
  // Claude-only runs are fine: no Codex home is needed then.
  if (hasClaudeHomes) return [];
  // No default home: the user must pick it explicitly or opt in with --auto. CODEX_HOME and ~/.codex are
  // not read otherwise, because sharing auth.json with the codex CLI would make both sides burn the same refresh token.
  throw new Error(`No Codex home configured. Set one of:
  --codex-home <path>                         (repeatable)
  AGENT_GATEWAY_CODEX_HOMES=<path>[${path.delimiter}<path>...]
  AGENT_GATEWAY_HOME=<path>
Or configure a Claude home: --claude-home <path> / AGENT_GATEWAY_CLAUDE_HOMES
Or use --auto to find logged-in ~/.codex, ~/.codex-*, ~/.claude, ~/.claude-* homes
Log in each home first: CODEX_HOME=<path> codex login / CLAUDE_CONFIG_DIR=<path> claude`);
};

// Claude CLI flags override the Claude env list only; there is no single-home Claude env var.
const getClaudeHomePaths = (env: NodeJS.ProcessEnv, cliHomes: string[]): string[] => {
  if (cliHomes.length > 0) return cliHomes.map((home) => path.resolve(home));
  const envHomes = env.AGENT_GATEWAY_CLAUDE_HOMES?.split(path.delimiter).filter((home) => home !== '');
  if (envHomes === undefined) return [];
  if (envHomes.length === 0) throw new Error('AGENT_GATEWAY_CLAUDE_HOMES must list at least one claude home');
  return envHomes.map((home) => path.resolve(home));
};

// --auto: logged-in .codex, .codex-*, .claude, .claude-* directly under homeDir. Name order keeps
// ~/.codex as codex1 and ~/.claude as claude1.
export const findAutoHomes = (homeDir: string): AutoHomes => {
  const autoHomes: AutoHomes = { codexHomes: [], claudeHomes: [], skippedHomes: [] };
  // Symlinked homes or credentials files would put two auth managers on one refresh token.
  const firstHomePaths = new Map<string, string>();
  for (const name of readdirSync(homeDir).sort()) {
    const isCodexHome = /^\.codex(-.+)?$/.test(name);
    if (!isCodexHome && !/^\.claude(-.+)?$/.test(name)) continue;
    const homePath = path.join(homeDir, name);
    if (statSync(homePath, { throwIfNoEntry: false })?.isDirectory() !== true) continue;
    const credentialsPath = path.join(homePath, isCodexHome ? 'auth.json' : CLAUDE_CREDENTIALS_FILE);
    if (statSync(credentialsPath, { throwIfNoEntry: false })?.isFile() !== true) {
      autoHomes.skippedHomes.push({ homePath, reason: 'not logged in' });
      continue;
    }
    const realCredentialsPath = realpathSync(credentialsPath);
    const firstHomePath = firstHomePaths.get(realCredentialsPath);
    if (firstHomePath !== undefined) {
      autoHomes.skippedHomes.push({ homePath, reason: `same home as ${firstHomePath}` });
      continue;
    }
    firstHomePaths.set(realCredentialsPath, homePath);
    (isCodexHome ? autoHomes.codexHomes : autoHomes.claudeHomes).push(homePath);
  }
  return autoHomes;
};

// --model without a prefix targets the first home of the provider the id belongs to;
// a prefix must name a configured home.
const getDefaultModelId = (model: string, aliases: string[], defaultAlias: string | undefined): string => {
  if (model === '') throw new Error('Invalid --model: must not be empty');
  const separatorIndex = model.indexOf(MODEL_ID_SEPARATOR);
  const alias = separatorIndex === -1 ? defaultAlias : model.slice(0, separatorIndex);
  if (alias === undefined || !aliases.includes(alias)) {
    throw new Error(`Unknown account prefix in --model "${alias}"; available: ${aliases.join(', ')}`);
  }
  if (separatorIndex !== -1 && model.slice(separatorIndex + 1) === '') {
    throw new Error(`Invalid --model: missing model name after "${alias}${MODEL_ID_SEPARATOR}"`);
  }
  return separatorIndex === -1 ? `${alias}${MODEL_ID_SEPARATOR}${model}` : model;
};

export const getConfig = (
  env: NodeJS.ProcessEnv,
  cliHomes: string[] = [],
  cliOptions: { contextLength?: string; model?: string; claudeHomes?: string[]; host?: string; autoHomes?: AutoHomes } = {},
): Config => {
  const { autoHomes } = cliOptions;
  if (autoHomes !== undefined) {
    // One source of homes keeps the alias order unambiguous.
    // Same "is set" rules as without --auto: an empty AGENT_GATEWAY_HOME is unset, an empty list is not.
    if (cliHomes.length > 0 || (cliOptions.claudeHomes ?? []).length > 0 || env.AGENT_GATEWAY_CODEX_HOMES !== undefined
      || env.AGENT_GATEWAY_HOME || env.AGENT_GATEWAY_CLAUDE_HOMES !== undefined) {
      throw new Error('--auto cannot be combined with --codex-home, --claude-home, AGENT_GATEWAY_CODEX_HOMES, AGENT_GATEWAY_HOME, or AGENT_GATEWAY_CLAUDE_HOMES');
    }
    if (autoHomes.codexHomes.length === 0 && autoHomes.claudeHomes.length === 0) {
      throw new Error('--auto found no logged-in home: no ~/.codex or ~/.codex-* with auth.json, no ~/.claude or ~/.claude-* with .credentials.json');
    }
  }
  const claudeHomePaths = autoHomes?.claudeHomes ?? getClaudeHomePaths(env, cliOptions.claudeHomes ?? []);
  const homePaths = autoHomes?.codexHomes ?? getCodexHomePaths(env, cliHomes, claudeHomePaths.length > 0);
  // Two AuthManagers on one auth.json would invalidate each other's refresh token.
  const seenPaths = new Set<string>();
  for (const homePath of homePaths) {
    if (seenPaths.has(homePath)) throw new Error(`Duplicate codex home: ${homePath}`);
    seenPaths.add(homePath);
  }
  const seenClaudePaths = new Set<string>();
  for (const homePath of claudeHomePaths) {
    if (seenClaudePaths.has(homePath)) throw new Error(`Duplicate claude home: ${homePath}`);
    seenClaudePaths.add(homePath);
  }

  const port = Number(env.AGENT_GATEWAY_PORT ?? DEFAULT_PORT);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`Invalid AGENT_GATEWAY_PORT: ${env.AGENT_GATEWAY_PORT}`);
  }
  // --host > AGENT_GATEWAY_HOST > loopback; an empty env value counts as unset, like AGENT_GATEWAY_HOME.
  const host = cliOptions.host ?? (env.AGENT_GATEWAY_HOST || DEFAULT_HOST);
  if (host === '') throw new Error('Invalid --host: must not be empty');
  const apiKey = env.AGENT_GATEWAY_API_KEY || undefined;
  // HTTP trims header whitespace and rejects control chars, so such a key could never match; never echo the key.
  if (apiKey !== undefined && !/^[\x21-\x7e]+$/.test(apiKey)) {
    throw new Error('Invalid AGENT_GATEWAY_API_KEY: use printable ASCII without spaces');
  }
  // Requests carry no other credential, so an address reachable from other machines must require a key.
  if (!LOOPBACK_BIND_HOSTS.includes(host) && apiKey === undefined) {
    throw new Error(`Listening on ${host} exposes your accounts to the network; set AGENT_GATEWAY_API_KEY to require "Authorization: Bearer <key>"`);
  }
  // Only plain decimal digits: Number() would also accept forms like 1e5 or 0x10.
  const contextLengthText = cliOptions.contextLength ?? String(DEFAULT_CONTEXT_LENGTH);
  if (!/^\d+$/.test(contextLengthText) || Number(contextLengthText) <= 0) {
    throw new Error(`Invalid --context-length: ${cliOptions.contextLength}`);
  }
  const contextLength = Number(contextLengthText);
  const codexHomes: CodexHome[] = homePaths.map((homePath, index) => ({
    alias: `${CODEX_HOME_ALIAS_PREFIX}${index + 1}`,
    homePath,
    authPath: path.join(homePath, 'auth.json'),
  }));
  const claudeHomes: ClaudeHome[] = claudeHomePaths.map((homePath, index) => ({
    alias: `${CLAUDE_HOME_ALIAS_PREFIX}${index + 1}`,
    homePath,
    credentialsPath: path.join(homePath, CLAUDE_CREDENTIALS_FILE),
    settingsPath: path.join(homePath, CLAUDE_SETTINGS_FILE),
    stateDir: path.join(homePath, CLAUDE_STATE_DIR),
  }));
  const aliases = [...codexHomes, ...claudeHomes].map((home) => home.alias);
  // Same routing rule as request bodies (accounts.ts): bare `claude-*` only the first Claude home,
  // everything else only the first Codex home; a missing provider is a configuration error.
  const isClaudeModelId = cliOptions.model !== undefined && !cliOptions.model.includes(MODEL_ID_SEPARATOR)
    && cliOptions.model.startsWith(`${CLAUDE_HOME_ALIAS_PREFIX}-`);
  const defaultAlias = isClaudeModelId ? claudeHomes[0]?.alias : codexHomes[0]?.alias;
  if (cliOptions.model !== undefined && !cliOptions.model.includes(MODEL_ID_SEPARATOR) && defaultAlias === undefined) {
    throw new Error(`No ${isClaudeModelId ? 'claude' : 'codex'} account is configured for --model "${cliOptions.model}"`);
  }
  const defaultModelId = cliOptions.model === undefined ? undefined : getDefaultModelId(cliOptions.model, aliases, defaultAlias);
  return {
    port,
    host,
    apiKey,
    codexHomes,
    claudeHomes,
    baseUrl: CODEX_BASE_URL,
    refreshUrl: REFRESH_URL,
    clientVersion: env.CODEX_CLIENT_VERSION ?? DEFAULT_CLIENT_VERSION,
    contextLength,
    defaultModelId,
  };
};
