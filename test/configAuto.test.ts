import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { findAutoHomes, getConfig, parseCliArgs } from '../src/config.js';

// Project-owned --auto discovery of logged-in ~/.codex, ~/.codex-*, ~/.claude, ~/.claude-* homes;
// there is no official reference. Each test builds its own fake $HOME in a temp directory.
let homeDir: string;

const makeHome = (name: string, file?: string): string => {
  const homePath = path.join(homeDir, name);
  mkdirSync(homePath);
  if (file !== undefined) writeFileSync(path.join(homePath, file), '{}');
  return homePath;
};

beforeEach(() => {
  homeDir = mkdtempSync(path.join(os.tmpdir(), 'agent-gateway-auto-'));
});
afterEach(() => {
  rmSync(homeDir, { recursive: true, force: true });
});

describe('parseCliArgs --auto', () => {
  it('reads --auto and defaults to off', () => {
    expect(parseCliArgs(['--auto']).isAutoEnabled).toBe(true);
    expect(parseCliArgs([]).isAutoEnabled).toBe(false);
  });
});

describe('findAutoHomes', () => {
  it('returns logged-in homes in name order and skips homes without credentials', () => {
    const codexB = makeHome('.codex-b', 'auth.json');
    const codex = makeHome('.codex', 'auth.json');
    const codexA = makeHome('.codex-a');
    const claudeX = makeHome('.claude-x', '.credentials.json');
    const claude = makeHome('.claude', '.credentials.json');
    makeHome('.codexfoo', 'auth.json');
    makeHome('.agent-gateway', 'auth.json');
    writeFileSync(path.join(homeDir, '.claude.json'), '{}');
    writeFileSync(path.join(homeDir, '.claude-file'), '{}');

    expect(findAutoHomes(homeDir)).toEqual({
      codexHomes: [codex, codexB],
      claudeHomes: [claude, claudeX],
      skippedHomes: [{ homePath: codexA, reason: 'not logged in' }],
    });
  });

  it('keeps the first of homes that share one credentials file, through a home or a file symlink', () => {
    const codex = makeHome('.codex', 'auth.json');
    const codexLink = path.join(homeDir, '.codex-link');
    symlinkSync(codex, codexLink);
    const codexFile = makeHome('.codex-file');
    symlinkSync(path.join(codex, 'auth.json'), path.join(codexFile, 'auth.json'));
    expect(findAutoHomes(homeDir)).toEqual({
      codexHomes: [codex],
      claudeHomes: [],
      skippedHomes: [
        { homePath: codexFile, reason: `same home as ${codex}` },
        { homePath: codexLink, reason: `same home as ${codex}` },
      ],
    });
  });

  it('skips a home whose credentials path is not a file', () => {
    const codex = makeHome('.codex');
    mkdirSync(path.join(codex, 'auth.json'));
    expect(findAutoHomes(homeDir).skippedHomes).toEqual([{ homePath: codex, reason: 'not logged in' }]);
  });

  it('does not take a Claude credentials file as a Codex login or the reverse', () => {
    const codex = makeHome('.codex', '.credentials.json');
    const claude = makeHome('.claude', 'auth.json');
    expect(findAutoHomes(homeDir)).toEqual({
      codexHomes: [],
      claudeHomes: [],
      skippedHomes: [{ homePath: claude, reason: 'not logged in' }, { homePath: codex, reason: 'not logged in' }],
    });
  });
});

describe('getConfig with --auto homes', () => {
  it('uses the found homes in order for the aliases', () => {
    const config = getConfig({}, [], {
      autoHomes: { codexHomes: ['/h/.codex', '/h/.codex-b'], claudeHomes: ['/h/.claude'], skippedHomes: [] },
    });
    expect(config.codexHomes.map((home) => [home.alias, home.homePath])).toEqual([['codex1', '/h/.codex'], ['codex2', '/h/.codex-b']]);
    expect(config.claudeHomes.map((home) => [home.alias, home.homePath])).toEqual([['claude1', '/h/.claude']]);
  });

  it('allows Claude-only results', () => {
    const config = getConfig({}, [], { autoHomes: { codexHomes: [], claudeHomes: ['/h/.claude'], skippedHomes: [] } });
    expect(config.codexHomes).toEqual([]);
  });

  it('fails when no logged-in home was found', () => {
    expect(() => getConfig({}, [], { autoHomes: { codexHomes: [], claudeHomes: [], skippedHomes: [{ homePath: '/h/.codex', reason: 'not logged in' }] } })).toThrow(
      '--auto found no logged-in home',
    );
  });

  it.each([
    ['--codex-home', {}, ['/tmp/gw'], {}],
    ['--claude-home', {}, [], { claudeHomes: ['/tmp/ch'] }],
    ['AGENT_GATEWAY_CODEX_HOMES', { AGENT_GATEWAY_CODEX_HOMES: '/tmp/gw' }, [], {}],
    ['AGENT_GATEWAY_HOME', { AGENT_GATEWAY_HOME: '/tmp/gw' }, [], {}],
    ['AGENT_GATEWAY_CLAUDE_HOMES', { AGENT_GATEWAY_CLAUDE_HOMES: '/tmp/ch' }, [], {}],
    // An empty *_HOMES list is an error without --auto, so it stays one with --auto.
    ['an empty AGENT_GATEWAY_CODEX_HOMES', { AGENT_GATEWAY_CODEX_HOMES: '' }, [], {}],
    ['an empty AGENT_GATEWAY_CLAUDE_HOMES', { AGENT_GATEWAY_CLAUDE_HOMES: '' }, [], {}],
  ])('rejects --auto together with %s', (_name, env, cliHomes, cliOptions) => {
    const autoHomes = { codexHomes: ['/h/.codex'], claudeHomes: [], skippedHomes: [] };
    expect(() => getConfig(env, cliHomes, { ...cliOptions, autoHomes })).toThrow('--auto cannot be combined with');
  });

  it('suggests --auto when no home is configured', () => {
    expect(() => getConfig({})).toThrow('Or use --auto');
  });

  it('treats an empty AGENT_GATEWAY_HOME as unset, as without --auto', () => {
    const autoHomes = { codexHomes: ['/h/.codex'], claudeHomes: [], skippedHomes: [] };
    expect(getConfig({ AGENT_GATEWAY_HOME: '' }, [], { autoHomes }).codexHomes.map((home) => home.homePath)).toEqual(['/h/.codex']);
  });
});
