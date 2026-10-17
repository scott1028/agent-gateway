import os from 'node:os';
import type { Account } from './accounts.js';
import { createAuthManager } from './auth/authManager.js';
import { createClaudeAccount } from './claude/index.js';
import { findAutoHomes, getConfig, parseCliArgs, USAGE_TEXT } from './config.js';
import { createModelCatalog } from './models.js';
import { createProxyServer } from './server.js';
import type { AutoHomes, Config, DebugLevel } from './types.js';
import { createCodexClient } from './upstream/codexClient.js';
import { createDebugFetch } from './utils/debugFetch.js';

const main = async (): Promise<void> => {
  let config: Config;
  let isDebugEnabled = false;
  let debugLevel: DebugLevel = 0;
  let autoHomes: AutoHomes | undefined;
  try {
    const cliArgs = parseCliArgs(process.argv.slice(2));
    if (cliArgs.isHelpRequested) {
      console.log(USAGE_TEXT);
      process.exit(0);
    }
    isDebugEnabled = cliArgs.isDebugEnabled;
    debugLevel = cliArgs.debugLevel;
    autoHomes = cliArgs.isAutoEnabled ? findAutoHomes(os.homedir()) : undefined;
    // Before getConfig, which fails when every match was skipped.
    for (const skippedHome of autoHomes?.skippedHomes ?? []) console.log(`--auto skipped ${skippedHome.homePath}: ${skippedHome.reason}`);
    config = getConfig(process.env, cliArgs.codexHomes, {
      claudeHomes: cliArgs.claudeHomes,
      contextLength: cliArgs.contextLength,
      model: cliArgs.model,
      host: cliArgs.host,
      autoHomes,
    });
  } catch (error) {
    console.error(`${error instanceof Error ? error.message : String(error)}\nRun with --help for usage.`);
    process.exit(1);
  }

  if (autoHomes !== undefined) {
    // ~/.codex* homes usually belong to the codex CLI as well.
    for (const home of config.codexHomes) {
      console.warn(`warning: ${home.alias} (${home.homePath}): do not run the codex CLI on this home while the gateway runs; both would refresh the same token and log one side out.`);
    }
  }

  const accounts: Account[] = [];
  for (const home of config.codexHomes) {
    const fetchFn = isDebugEnabled ? createDebugFetch({ alias: home.alias, debugLevel }) : undefined;
    const auth = createAuthManager({ authPath: home.authPath, refreshUrl: config.refreshUrl, fetchFn });
    try {
      await auth.getCredentials();
    } catch (error) {
      console.error(`[${home.alias}] ${error instanceof Error ? error.message : String(error)}`);
      process.exit(1);
    }
    const client = createCodexClient({ auth, config, authPath: home.authPath, fetchFn });
    accounts.push({
      provider: 'codex',
      alias: home.alias,
      homePath: home.homePath,
      client,
      catalog: createModelCatalog({ getModels: client.getModels }),
    });
  }

  for (const home of config.claudeHomes) {
    const fetchFn = isDebugEnabled ? createDebugFetch({ alias: home.alias, debugLevel }) : undefined;
    try {
      accounts.push(await createClaudeAccount(home, fetchFn));
    } catch (error) {
      console.error(`[${home.alias}] ${error instanceof Error ? error.message : String(error)}`);
      process.exit(1);
    }
  }

  const server = createProxyServer({ accounts, contextLength: config.contextLength, defaultModelId: config.defaultModelId, debugLevel: isDebugEnabled ? debugLevel : undefined, apiKey: config.apiKey });

  // A bad --host or a busy port would otherwise crash with an unhandled 'error' event.
  server.on('error', (error) => {
    console.error(`Cannot listen on ${config.host}:${config.port}: ${error.message}`);
    process.exit(1);
  });
  server.listen(config.port, config.host, () => {
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : config.port;
    // IPv6 literals need brackets in a URL.
    const urlHost = config.host.includes(':') ? `[${config.host}]` : config.host;
    console.log(`agent-gateway listening on http://${urlHost}:${port}/v1`);
    if (config.apiKey !== undefined) console.log('  api key: required');
    for (const account of accounts) console.log(`  ${account.alias} -> ${account.homePath}`);
    console.log(`  default model: ${config.defaultModelId ?? 'first in /v1/models'}`);
  });

  const shutdown = (): void => {
    server.close(() => process.exit(0));
    server.closeAllConnections();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
};

void main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
