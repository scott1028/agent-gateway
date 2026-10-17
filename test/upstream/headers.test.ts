import { describe, expect, it } from 'vitest';
import os from 'node:os';
import { buildUpstreamHeaders, getUserAgent } from '../../src/upstream/headers.js';

// Mirrors the UA shape from references/codex/codex-rs/login/src/auth/default_client.rs
// (originator/version/os/arch); the trailing "agent-gateway" suffix is our own name.
describe('getUserAgent', () => {
  it('ends with the full agent-gateway suffix', () => {
    const expectedPrefix = `codex_cli_rs/9.9.9 (${os.type()} ${os.release()}; ${os.arch()})`;
    expect(getUserAgent('9.9.9')).toBe(`${expectedPrefix} agent-gateway`);
  });
});

describe('buildUpstreamHeaders', () => {
  it('builds the Codex header set', () => {
    expect(
      buildUpstreamHeaders({
        credentials: { accessToken: 'at', accountId: 'acct', isFedramp: true },
        clientVersion: '1.2.3',
        userAgent: 'ua',
        sessionId: 'sid',
        isResponsesLite: true,
        turnState: 'ts',
      }),
    ).toEqual({
      authorization: 'Bearer at',
      originator: 'codex_cli_rs',
      'user-agent': 'ua',
      version: '1.2.3',
      'chatgpt-account-id': 'acct',
      'x-openai-fedramp': 'true',
      'session-id': 'sid',
      'thread-id': 'sid',
      'x-client-request-id': 'sid',
      'x-openai-internal-codex-responses-lite': 'true',
      'x-codex-turn-state': 'ts',
    });
  });

  it('omits optional headers', () => {
    expect(
      Object.keys(buildUpstreamHeaders({ credentials: { accessToken: 'at', isFedramp: false }, clientVersion: '1', userAgent: 'ua' })),
    ).toEqual(['authorization', 'originator', 'user-agent', 'version']);
  });
});
