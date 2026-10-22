import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { getConfig, parseCliArgs, USAGE_TEXT } from '../src/config.js';

// Project-owned config; the auth.json home stores the file created by codex login,
// whose format mirrors references/codex/codex-rs/login. AGENT_GATEWAY_* env and --codex-home are our own.
describe('parseCliArgs', () => {
  it('reads repeated --codex-home and the --codex-home=path form', () => {
    expect(parseCliArgs(['--codex-home', '/tmp/gw1', '--codex-home=/tmp/gw2'])).toEqual({
      codexHomes: ['/tmp/gw1', '/tmp/gw2'],
      claudeHomes: [],
      isAutoEnabled: false,
      isDebugEnabled: false,
      debugLevel: 0,
      isHelpRequested: false,
    });
  });

  it('reads repeated --claude-home and the --claude-home=path form', () => {
    expect(parseCliArgs(['--claude-home', '/tmp/ch1', '--claude-home=/tmp/ch2'])).toEqual({
      codexHomes: [],
      claudeHomes: ['/tmp/ch1', '/tmp/ch2'],
      isAutoEnabled: false,
      isDebugEnabled: false,
      debugLevel: 0,
      isHelpRequested: false,
    });
  });

  it('reads --model and --context-length, also in the --flag=value form', () => {
    expect(parseCliArgs(['--model', 'gpt-x', '--context-length', '128000'])).toEqual({
      codexHomes: [],
      claudeHomes: [],
      contextLength: '128000',
      model: 'gpt-x',
      isAutoEnabled: false,
      isDebugEnabled: false,
      debugLevel: 0,
      isHelpRequested: false,
    });
    const equalsForm = parseCliArgs(['--model=codex2/gpt-x', '--context-length=200000']);
    expect(equalsForm.model).toBe('codex2/gpt-x');
    expect(equalsForm.contextLength).toBe('200000');
  });

  it('keeps bare --debug at level 0 and leaves debug disabled when absent', () => {
    expect(parseCliArgs(['--debug'])).toMatchObject({ isDebugEnabled: true, debugLevel: 0 });
    expect(parseCliArgs([])).toMatchObject({ isDebugEnabled: false, debugLevel: 0 });
  });

  it.each([0, 1, 2, 3])('accepts explicit debug level %i with space or equals', (debugLevel) => {
    for (const args of [['--debug', String(debugLevel)], [`--debug=${debugLevel}`]]) {
      expect(parseCliArgs(args)).toMatchObject({ isDebugEnabled: true, debugLevel });
    }
  });

  it('keeps following flags and their values intact after --debug', () => {
    expect(parseCliArgs(['--debug', '--model', 'gpt-x', '--codex-home', '/tmp/gw'])).toMatchObject({
      isDebugEnabled: true, debugLevel: 0, model: 'gpt-x', codexHomes: ['/tmp/gw'],
    });
    expect(parseCliArgs(['--debug', '-h'])).toMatchObject({ debugLevel: 0, isHelpRequested: true });
    expect(parseCliArgs(['--debug', '1', '--claude-home', '/tmp/ch'])).toMatchObject({
      debugLevel: 1, claudeHomes: ['/tmp/ch'],
    });
  });

  it.each(['4', '-1', 'true', '1.0', ''])('rejects invalid debug level %j', (debugLevel) => {
    expect(() => parseCliArgs([`--debug=${debugLevel}`])).toThrow(`Invalid --debug: ${debugLevel}; expected 0, 1, 2, or 3`);
  });

  it('rejects invalid space-separated debug levels and unrelated positional arguments', () => {
    expect(() => parseCliArgs(['--debug', '4'])).toThrow('Invalid --debug');
    expect(() => parseCliArgs(['--debug', 'verbose'])).toThrow('Invalid --debug');
    expect(() => parseCliArgs(['--debug', '1', 'extra'])).toThrow();
    expect(() => parseCliArgs(['--', '--debug'])).toThrow();
  });

  it('uses the last debug option when repeated', () => {
    expect(parseCliArgs(['--debug', '1', '--debug']).debugLevel).toBe(0);
    expect(parseCliArgs(['--debug', '--debug=3']).debugLevel).toBe(3);
  });

  it('flags --help and -h', () => {
    expect(parseCliArgs(['--help']).isHelpRequested).toBe(true);
    expect(parseCliArgs(['-h']).isHelpRequested).toBe(true);
  });

  it('rejects unknown CLI flags', () => {
    expect(() => parseCliArgs(['--codex-dir', '/tmp/gw'])).toThrow("Unknown option '--codex-dir'");
  });

  it('reads --host with space or equals and leaves it unset when absent', () => {
    expect(parseCliArgs(['--host', '0.0.0.0']).host).toBe('0.0.0.0');
    expect(parseCliArgs(['--host=::']).host).toBe('::');
    expect(parseCliArgs([]).host).toBeUndefined();
  });

  it('reads --relay-fallback in both forms and keeps degrade as the absent-option default', () => {
    expect(parseCliArgs(['--relay-fallback=degrade'])).toMatchObject({ relayFallback: 'degrade' });
    expect(parseCliArgs(['--relay-fallback', 'reject'])).toMatchObject({ relayFallback: 'reject' });
    expect(parseCliArgs([]).relayFallback ?? 'degrade').toBe('degrade');
    expect(() => parseCliArgs(['--relay-fallback=other'])).toThrow('Invalid --relay-fallback');
  });

  it('has no CLI flag for the API key, so it never shows up in the process list', () => {
    expect(() => parseCliArgs(['--api-key', 'secret'])).toThrow("Unknown option '--api-key'");
  });
});

describe('getConfig', () => {
  it('uses the default port and client version', () => {
    const config = getConfig({ AGENT_GATEWAY_HOME: '/tmp/gw' });
    expect(config.port).toBe(8765);
    expect(config.clientVersion).toBe('0.163.0');
    expect(config.codexHomes).toEqual([{ alias: 'codex1', homePath: '/tmp/gw', authPath: '/tmp/gw/auth.json' }]);
  });

  it('reads AGENT_GATEWAY_PORT and AGENT_GATEWAY_HOME', () => {
    const config = getConfig({ AGENT_GATEWAY_PORT: '9000', AGENT_GATEWAY_HOME: '/tmp/gw' });
    expect(config.port).toBe(9000);
    expect(config.codexHomes).toEqual([{ alias: 'codex1', homePath: '/tmp/gw', authPath: '/tmp/gw/auth.json' }]);
  });

  it('splits AGENT_GATEWAY_CODEX_HOMES and numbers aliases in order', () => {
    expect(getConfig({ AGENT_GATEWAY_CODEX_HOMES: '/tmp/gw1:/tmp/gw2' }).codexHomes).toEqual([
      { alias: 'codex1', homePath: '/tmp/gw1', authPath: '/tmp/gw1/auth.json' },
      { alias: 'codex2', homePath: '/tmp/gw2', authPath: '/tmp/gw2/auth.json' },
    ]);
  });

  it('uses the cliHomes argument in order', () => {
    expect(getConfig({}, ['/tmp/gw1', '/tmp/gw2']).codexHomes).toEqual([
      { alias: 'codex1', homePath: '/tmp/gw1', authPath: '/tmp/gw1/auth.json' },
      { alias: 'codex2', homePath: '/tmp/gw2', authPath: '/tmp/gw2/auth.json' },
    ]);
  });

  it('lets cliHomes override AGENT_GATEWAY_CODEX_HOMES', () => {
    expect(getConfig({ AGENT_GATEWAY_CODEX_HOMES: '/tmp/env' }, ['/tmp/cli']).codexHomes).toEqual([
      { alias: 'codex1', homePath: '/tmp/cli', authPath: '/tmp/cli/auth.json' },
    ]);
  });

  it('resolves a relative codex home', () => {
    expect(getConfig({}, ['gw']).codexHomes[0]?.homePath).toBe(path.join(process.cwd(), 'gw'));
  });

  it('rejects AGENT_GATEWAY_HOME together with AGENT_GATEWAY_CODEX_HOMES', () => {
    expect(() => getConfig({ AGENT_GATEWAY_HOME: '/tmp/gw', AGENT_GATEWAY_CODEX_HOMES: '/tmp/gw2' })).toThrow(
      'Set only one of AGENT_GATEWAY_CODEX_HOMES and AGENT_GATEWAY_HOME',
    );
  });

  it('lets cliHomes win over conflicting AGENT_GATEWAY_HOME and AGENT_GATEWAY_CODEX_HOMES', () => {
    const env = { AGENT_GATEWAY_HOME: '/tmp/gw', AGENT_GATEWAY_CODEX_HOMES: '/tmp/gw2' };
    expect(getConfig(env, ['/tmp/cli']).codexHomes).toEqual([
      { alias: 'codex1', homePath: '/tmp/cli', authPath: '/tmp/cli/auth.json' },
    ]);
  });

  it('rejects duplicate codex homes', () => {
    expect(() => getConfig({}, ['/tmp/gw', '/tmp/gw/'])).toThrow('Duplicate codex home: /tmp/gw');
  });

  it('rejects an empty AGENT_GATEWAY_CODEX_HOMES list', () => {
    expect(() => getConfig({ AGENT_GATEWAY_CODEX_HOMES: ':' })).toThrow('AGENT_GATEWAY_CODEX_HOMES must list at least one codex home');
  });

  it('rejects a run without any codex home', () => {
    expect(() => getConfig({})).toThrow('No Codex home configured');
  });

  it('does not read CODEX_HOME or legacy CODEX_PROXY_HOME as a codex home', () => {
    expect(() => getConfig({ CODEX_HOME: '/tmp/codex', CODEX_PROXY_HOME: '/tmp/legacy' })).toThrow('No Codex home configured');
  });

  it('treats an empty AGENT_GATEWAY_HOME as unset', () => {
    expect(() => getConfig({ AGENT_GATEWAY_HOME: '' })).toThrow('No Codex home configured');
  });

  it('keeps CODEX_CLIENT_VERSION working', () => {
    const config = getConfig({ AGENT_GATEWAY_HOME: '/tmp/gw', CODEX_CLIENT_VERSION: '1.2.3' });
    expect(config.clientVersion).toBe('1.2.3');
  });

  it('ignores legacy CODEX_PROXY_* env vars', () => {
    const config = getConfig({ AGENT_GATEWAY_HOME: '/tmp/gw', CODEX_PROXY_PORT: '9000', CODEX_PROXY_HOME: '/tmp/legacy' });
    expect(config.port).toBe(8765);
    expect(config.codexHomes[0]?.homePath).toBe('/tmp/gw');
  });

  it('rejects invalid AGENT_GATEWAY_PORT', () => {
    expect(() => getConfig({ AGENT_GATEWAY_HOME: '/tmp/gw', AGENT_GATEWAY_PORT: 'abc' })).toThrow('Invalid AGENT_GATEWAY_PORT: abc');
    expect(() => getConfig({ AGENT_GATEWAY_HOME: '/tmp/gw', AGENT_GATEWAY_PORT: '70000' })).toThrow('Invalid AGENT_GATEWAY_PORT: 70000');
  });

  it('listens on loopback without an API key by default', () => {
    const config = getConfig({ AGENT_GATEWAY_HOME: '/tmp/gw' });
    expect(config.host).toBe('127.0.0.1');
    expect(config.apiKey).toBeUndefined();
  });

  it('lets --host override AGENT_GATEWAY_HOST and treats an empty AGENT_GATEWAY_HOST as unset', () => {
    const env = { AGENT_GATEWAY_HOME: '/tmp/gw', AGENT_GATEWAY_HOST: '::1' };
    expect(getConfig(env).host).toBe('::1');
    expect(getConfig(env, [], { host: '127.0.0.1' }).host).toBe('127.0.0.1');
    expect(getConfig({ AGENT_GATEWAY_HOME: '/tmp/gw', AGENT_GATEWAY_HOST: '' }).host).toBe('127.0.0.1');
  });

  it('rejects an empty --host', () => {
    expect(() => getConfig({ AGENT_GATEWAY_HOME: '/tmp/gw' }, [], { host: '' })).toThrow('Invalid --host: must not be empty');
  });

  // localhost too: DNS or /etc/hosts decides where it binds.
  it.each(['0.0.0.0', '::', '192.168.1.10', 'localhost'])('requires AGENT_GATEWAY_API_KEY to listen on %s', (host) => {
    expect(() => getConfig({ AGENT_GATEWAY_HOME: '/tmp/gw' }, [], { host })).toThrow(
      `Listening on ${host} exposes your accounts to the network; set AGENT_GATEWAY_API_KEY`,
    );
    expect(() => getConfig({ AGENT_GATEWAY_HOME: '/tmp/gw', AGENT_GATEWAY_HOST: host })).toThrow('set AGENT_GATEWAY_API_KEY');
    expect(() => getConfig({ AGENT_GATEWAY_HOME: '/tmp/gw', AGENT_GATEWAY_API_KEY: '' }, [], { host })).toThrow('set AGENT_GATEWAY_API_KEY');
    const config = getConfig({ AGENT_GATEWAY_HOME: '/tmp/gw', AGENT_GATEWAY_API_KEY: 'secret' }, [], { host });
    expect(config).toMatchObject({ host, apiKey: 'secret' });
  });

  it('keeps an API key on a loopback host so every request still needs it', () => {
    expect(getConfig({ AGENT_GATEWAY_HOME: '/tmp/gw', AGENT_GATEWAY_API_KEY: 'secret' }).apiKey).toBe('secret');
  });

  it.each(['secret ', ' secret', '   ', 'sec\nret', 'sec\tret'])(
    'rejects an API key that HTTP clients cannot send unchanged (%j) without echoing it',
    (apiKey) => {
      // An exact message match also proves the key is not echoed.
      expect(() => getConfig({ AGENT_GATEWAY_HOME: '/tmp/gw', AGENT_GATEWAY_API_KEY: apiKey })).toThrow(
        new Error('Invalid AGENT_GATEWAY_API_KEY: use printable ASCII without spaces'),
      );
    },
  );

  it('defaults contextLength and leaves defaultModelId unset', () => {
    const config = getConfig({ AGENT_GATEWAY_HOME: '/tmp/gw' });
    expect(config.contextLength).toBe(250000);
    expect(config.defaultModelId).toBeUndefined();
  });

  it('reads --context-length', () => {
    expect(getConfig({ AGENT_GATEWAY_HOME: '/tmp/gw' }, [], { contextLength: '128000' }).contextLength).toBe(128000);
  });

  it('rejects a --context-length that is not a positive integer', () => {
    for (const contextLength of ['abc', '0', '-1', '1.5', '1e5', '0x10']) {
      expect(() => getConfig({ AGENT_GATEWAY_HOME: '/tmp/gw' }, [], { contextLength })).toThrow(`Invalid --context-length: ${contextLength}`);
    }
  });

  it('prefixes a bare --model with the first home alias', () => {
    expect(getConfig({ AGENT_GATEWAY_HOME: '/tmp/gw' }, [], { model: 'gpt-x' }).defaultModelId).toBe('codex1/gpt-x');
  });

  it('keeps a --model whose prefix is a configured home', () => {
    expect(getConfig({}, ['/tmp/gw1', '/tmp/gw2'], { model: 'codex2/gpt-x' }).defaultModelId).toBe('codex2/gpt-x');
  });

  it('rejects a --model with an unknown account prefix', () => {
    expect(() => getConfig({}, ['/tmp/gw1', '/tmp/gw2'], { model: 'codex9/gpt-x' })).toThrow(
      'Unknown account prefix in --model "codex9"; available: codex1, codex2',
    );
  });

  it('rejects an empty --model', () => {
    expect(() => getConfig({ AGENT_GATEWAY_HOME: '/tmp/gw' }, [], { model: '' })).toThrow('Invalid --model: must not be empty');
  });

  it('rejects a --model whose model name after the prefix is empty', () => {
    expect(() => getConfig({ AGENT_GATEWAY_HOME: '/tmp/gw' }, [], { model: 'codex1/' })).toThrow(
      'Invalid --model: missing model name after "codex1/"',
    );
  });

  it('numbers claude home aliases in --claude-home order', () => {
    expect(getConfig({}, [], { claudeHomes: ['/tmp/ch1', '/tmp/ch2'] }).claudeHomes).toEqual([
      {
        alias: 'claude1',
        homePath: '/tmp/ch1',
        credentialsPath: '/tmp/ch1/.credentials.json',
        settingsPath: '/tmp/ch1/settings.json',
        stateDir: '/tmp/ch1/.agent-gateway/claude-state',
      },
      {
        alias: 'claude2',
        homePath: '/tmp/ch2',
        credentialsPath: '/tmp/ch2/.credentials.json',
        settingsPath: '/tmp/ch2/settings.json',
        stateDir: '/tmp/ch2/.agent-gateway/claude-state',
      },
    ]);
  });

  it('splits AGENT_GATEWAY_CLAUDE_HOMES', () => {
    expect(getConfig({ AGENT_GATEWAY_CLAUDE_HOMES: '/tmp/ch1:/tmp/ch2' }).claudeHomes.map((home) => home.alias)).toEqual([
      'claude1',
      'claude2',
    ]);
  });

  it('runs with Claude homes and no Codex home', () => {
    const config = getConfig({ AGENT_GATEWAY_CLAUDE_HOMES: '/tmp/ch1' });
    expect(config.codexHomes).toEqual([]);
    expect(config.claudeHomes[0]?.alias).toBe('claude1');
  });

  it('lets --claude-home override AGENT_GATEWAY_CLAUDE_HOMES without touching the Codex list', () => {
    const config = getConfig({ AGENT_GATEWAY_HOME: '/tmp/gw', AGENT_GATEWAY_CLAUDE_HOMES: '/tmp/env' }, [], { claudeHomes: ['/tmp/cli'] });
    expect(config.codexHomes[0]?.homePath).toBe('/tmp/gw');
    expect(config.claudeHomes[0]?.homePath).toBe('/tmp/cli');
  });

  it('rejects duplicate claude homes', () => {
    expect(() => getConfig({}, [], { claudeHomes: ['/tmp/ch', '/tmp/ch/'] })).toThrow('Duplicate claude home: /tmp/ch');
  });

  it('rejects an empty AGENT_GATEWAY_CLAUDE_HOMES list', () => {
    expect(() => getConfig({ AGENT_GATEWAY_CLAUDE_HOMES: ':' })).toThrow('AGENT_GATEWAY_CLAUDE_HOMES must list at least one claude home');
  });

  it('routes a bare claude-* --model to the first Claude home', () => {
    expect(getConfig({ AGENT_GATEWAY_CLAUDE_HOMES: '/tmp/ch1' }, [], { model: 'claude-sonnet-5' }).defaultModelId).toBe('claude1/claude-sonnet-5');
  });

  it('rejects a bare non-claude --model when no Codex home is configured', () => {
    // Supervisor config probe: --model must use the same provider routing as request bodies.
    expect(() => getConfig({ AGENT_GATEWAY_CLAUDE_HOMES: '/tmp/ch1' }, [], { model: 'gpt-x' })).toThrow(
      'No codex account is configured for --model "gpt-x"',
    );
    expect(() => getConfig({}, ['/tmp/ch1'], { model: 'claude-opus-4-6' })).toThrow(
      'No claude account is configured for --model "claude-opus-4-6"',
    );
  });

  it('keeps a bare non-claude --model on the first Codex home when both providers are configured', () => {
    const config = getConfig({ AGENT_GATEWAY_HOME: '/tmp/gw' }, [], { claudeHomes: ['/tmp/ch1'], model: 'gpt-x' });
    expect(config.defaultModelId).toBe('codex1/gpt-x');
  });

  it('validates --model prefixes against both alias pools', () => {
    const env = { AGENT_GATEWAY_HOME: '/tmp/gw' };
    expect(getConfig(env, [], { claudeHomes: ['/tmp/ch1'], model: 'claude1/claude-sonnet-5' }).defaultModelId).toBe('claude1/claude-sonnet-5');
    expect(() => getConfig(env, [], { claudeHomes: ['/tmp/ch1'], model: 'claude9/claude-sonnet-5' })).toThrow(
      'Unknown account prefix in --model "claude9"; available: codex1, claude1',
    );
  });
});

describe('USAGE_TEXT', () => {
  it('documents the home options and the login step', () => {
    for (const expected of [
      '--codex-home',
      '--claude-home',
      '--debug',
      '--model',
      '--context-length',
      '--host <addr>',
      '--auto',
      '-h, --help',
      'AGENT_GATEWAY_CODEX_HOMES',
      'AGENT_GATEWAY_HOME',
      'AGENT_GATEWAY_CLAUDE_HOMES',
      'AGENT_GATEWAY_HOST',
      'AGENT_GATEWAY_API_KEY',
      'CODEX_HOME=<path> codex login',
      'CLAUDE_CONFIG_DIR=<path> claude',
    ]) {
      expect(USAGE_TEXT).toContain(expected);
    }
  });
});
