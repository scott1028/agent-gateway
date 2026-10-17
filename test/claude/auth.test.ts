// Claude subscription credential handling. Refresh request shape, expiry window, refresh-token
// reuse rules and the compare-and-swap save mirror the pinned official release 2.1.299:
// refresh at binary offset 217749927, expiry check at 217754567, file IO at 217333107,
// compare-and-swap save at 217983336, record merge at 217983010, refresh orchestration and the
// `.oauth_refresh.lock` handling at 218001100 (Za) with 217997780 (nGn) / 217998206 (pOs), and
// scope expansion at 214897545 (EHo).
import { mkdir, mkdtemp, readFile, rmdir, stat, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  createClaudeAuthManager,
  getClaudeLoginHint,
  getClaudeRefreshScopes,
  isClaudeTokenExpiring,
  readClaudeAccountMetadata,
  requestClaudeTokenRefresh,
} from '../../src/claude/auth.js';
import { CLAUDE_OAUTH_SCOPES, CLAUDE_REFRESH_LOCK_DIR } from '../../src/constants.js';
import type { ClaudeAuthFile } from '../../src/claude/types.js';

const NOW_MS = Date.parse('2026-10-13T00:00:00Z');
const TOKEN_URL = 'https://token.test/v1/oauth/token';
const BASE_SCOPES = 'user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload user:plugins';

const toAuth = (oauth: Partial<NonNullable<ClaudeAuthFile['claudeAiOauth']>> = {}): ClaudeAuthFile => ({
  project: 'keep-me',
  claudeAiOauth: {
    accessToken: 'at-1',
    refreshToken: 'rt-1',
    expiresAt: NOW_MS + 3_600_000,
    refreshTokenExpiresAt: NOW_MS + 2_592_000_000,
    scopes: ['user:profile', 'user:inference'],
    subscriptionType: 'max',
    rateLimitTier: null,
    clientId: 'client-1',
    ...oauth,
  },
});

const setup = async (auth: ClaudeAuthFile | undefined, fetchFn: typeof fetch) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'agent-gateway-claude-auth-'));
  const credentialsPath = path.join(dir, '.credentials.json');
  if (auth !== undefined) await writeFile(credentialsPath, JSON.stringify(auth));
  const manager = createClaudeAuthManager({
    credentialsPath,
    tokenUrl: TOKEN_URL,
    stateDir: path.join(dir, '.agent-gateway/claude-state'),
    fetchFn,
    now: () => NOW_MS,
    lockRetryLimit: 2,
    lockRetryBaseMs: 1,
  });
  return { dir, credentialsPath, manager };
};

const jsonResponse = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const readSaved = async (credentialsPath: string): Promise<ClaudeAuthFile> =>
  JSON.parse(await readFile(credentialsPath, 'utf8')) as ClaudeAuthFile;

const getRejection = async (promise: Promise<unknown>): Promise<Error & { status: number }> => {
  try {
    await promise;
  } catch (error) {
    return error as Error & { status: number };
  }
  throw new Error('expected the call to reject');
};

describe('isClaudeTokenExpiring', () => {
  it('matches the official five minute window and never refreshes a null expiry', () => {
    expect(isClaudeTokenExpiring(NOW_MS + 299_999, NOW_MS)).toBe(true);
    expect(isClaudeTokenExpiring(NOW_MS + 300_000, NOW_MS)).toBe(true);
    expect(isClaudeTokenExpiring(NOW_MS + 300_001, NOW_MS)).toBe(false);
    expect(isClaudeTokenExpiring(null, NOW_MS)).toBe(false);
    expect(isClaudeTokenExpiring(undefined, NOW_MS)).toBe(false);
  });
});

describe('createClaudeAuthManager', () => {
  it('returns the stored access token without refreshing while it is valid', async () => {
    const fetchFn = vi.fn<typeof fetch>();
    const { manager } = await setup(toAuth(), fetchFn);
    expect(await manager.getCredentials()).toEqual({ accessToken: 'at-1' });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('refreshes when the token expires within five minutes', async () => {
    const fetchFn = vi.fn<typeof fetch>(async () => jsonResponse(200, { access_token: 'at-2', refresh_token: 'rt-2', expires_in: 3600 }));
    const { credentialsPath, manager } = await setup(toAuth({ expiresAt: NOW_MS + 299_000 }), fetchFn);
    expect(await manager.getCredentials()).toEqual({ accessToken: 'at-2' });
    const [url, init] = fetchFn.mock.calls[0] ?? [];
    expect(url).toBe(TOKEN_URL);
    expect(init?.method).toBe('POST');
    expect((init?.headers as Record<string, string>)['content-type']).toBe('application/json');
    expect(JSON.parse(String(init?.body))).toEqual({
      grant_type: 'refresh_token',
      refresh_token: 'rt-1',
      client_id: 'client-1',
      scope: 'user:profile user:inference',
    });
    const saved = await readSaved(credentialsPath);
    expect(saved.claudeAiOauth).toMatchObject({ accessToken: 'at-2', refreshToken: 'rt-2', expiresAt: NOW_MS + 3_600_000 });
    expect(saved.project).toBe('keep-me');
  });

  it('keeps the previous refresh token and expiry when the response omits them', async () => {
    const fetchFn = vi.fn<typeof fetch>(async () => jsonResponse(200, { access_token: 'at-2' }));
    const { credentialsPath, manager } = await setup(toAuth({ expiresAt: NOW_MS + 60_000 }), fetchFn);
    await manager.getCredentials();
    const saved = await readSaved(credentialsPath);
    expect(saved.claudeAiOauth).toMatchObject({ accessToken: 'at-2', refreshToken: 'rt-1', expiresAt: NOW_MS + 60_000 });
  });

  it('records a new refresh-token expiry when upstream returns one', async () => {
    const fetchFn = vi.fn<typeof fetch>(async () =>
      jsonResponse(200, { access_token: 'at-2', refresh_token: 'rt-2', expires_in: 3600, refresh_token_expires_in: 7200 }),
    );
    const { credentialsPath, manager } = await setup(toAuth({ expiresAt: NOW_MS + 60_000 }), fetchFn);
    await manager.getCredentials();
    expect((await readSaved(credentialsPath)).claudeAiOauth?.refreshTokenExpiresAt).toBe(NOW_MS + 7_200_000);
  });

  it('falls back to the official scope list when the file records none', async () => {
    const fetchFn = vi.fn<typeof fetch>(async () => jsonResponse(200, { access_token: 'at-2', expires_in: 3600 }));
    const auth = toAuth({ expiresAt: NOW_MS + 60_000, scopes: undefined, clientId: undefined });
    const { manager } = await setup(auth, fetchFn);
    await manager.getCredentials();
    const body = JSON.parse(String(fetchFn.mock.calls[0]?.[1]?.body)) as { scope: string; client_id: string };
    expect(body.scope).toBe(BASE_SCOPES);
    expect(body.client_id).toBe('9d1c250a-e61b-44d9-88ed-5944d1962f5e');
  });

  it('refreshes once for concurrent callers', async () => {
    const fetchFn = vi.fn<typeof fetch>(async () => jsonResponse(200, { access_token: 'at-2', refresh_token: 'rt-2', expires_in: 3600 }));
    const { manager } = await setup(toAuth({ expiresAt: NOW_MS + 60_000 }), fetchFn);
    const results = await Promise.all(Array.from({ length: 8 }, () => manager.getCredentials()));
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(results.every((credentials) => credentials.accessToken === 'at-2')).toBe(true);
  });

  it('adopts tokens rotated by another process instead of clobbering them', async () => {
    const fetchFn = vi.fn<typeof fetch>(async () => {
      await writeFile(credentialsPath, JSON.stringify(toAuth({ accessToken: 'at-sibling', refreshToken: 'rt-sibling' })));
      return jsonResponse(200, { access_token: 'at-2', refresh_token: 'rt-2', expires_in: 3600 });
    });
    const { credentialsPath, manager } = await setup(toAuth({ expiresAt: NOW_MS + 60_000 }), fetchFn);
    expect(await manager.getCredentials()).toEqual({ accessToken: 'at-sibling' });
    expect((await readSaved(credentialsPath)).claudeAiOauth?.refreshToken).toBe('rt-sibling');
  });

  it('adopts a credential file that changed on disk before refreshing', async () => {
    const fetchFn = vi.fn<typeof fetch>();
    const { credentialsPath, manager } = await setup(toAuth(), fetchFn);
    expect(await manager.getCredentials()).toEqual({ accessToken: 'at-1' });
    await writeFile(credentialsPath, JSON.stringify(toAuth({ accessToken: 'at-2', refreshToken: 'rt-2' })));
    expect(await manager.recoverUnauthorized('at-1')).toEqual({ accessToken: 'at-2' });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('refreshes when a 401 comes back for the token we still hold', async () => {
    const fetchFn = vi.fn<typeof fetch>(async () => jsonResponse(200, { access_token: 'at-2', refresh_token: 'rt-2', expires_in: 3600 }));
    const { manager } = await setup(toAuth(), fetchFn);
    expect(await manager.recoverUnauthorized('at-1')).toEqual({ accessToken: 'at-2' });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('reports a rejected refresh as a login problem and stops retrying that token', async () => {
    const fetchFn = vi.fn<typeof fetch>(async () => jsonResponse(400, { error: 'invalid_grant' }));
    const { manager } = await setup(toAuth({ expiresAt: NOW_MS + 60_000 }), fetchFn);
    const first = await getRejection(manager.getCredentials());
    expect(first.status).toBe(401);
    expect(first.message).toContain('invalid_grant');
    const second = await getRejection(manager.getCredentials());
    expect(second.status).toBe(401);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('keeps serving the old token when refresh fails transiently', async () => {
    const fetchFn = vi.fn<typeof fetch>(async () => jsonResponse(503, { error: 'overloaded' }));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { manager } = await setup(toAuth({ expiresAt: NOW_MS + 60_000 }), fetchFn);
    expect(await manager.getCredentials()).toEqual({ accessToken: 'at-1' });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('proactive claude refresh failed'));
  });

  it('takes over a stale official lock directory and releases it afterwards', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'agent-gateway-claude-auth-'));
    const credentialsPath = path.join(dir, '.credentials.json');
    await writeFile(credentialsPath, JSON.stringify(toAuth({ expiresAt: NOW_MS + 60_000 })));
    // nGn at 217997780: the official lock is a directory next to the credentials file, stale after
    // 60000ms. A stale one is stolen, a fresh one is never touched.
    const lockPath = path.join(dir, CLAUDE_REFRESH_LOCK_DIR);
    await mkdir(lockPath);
    const stale = new Date(NOW_MS - 60_001);
    await utimes(lockPath, stale, stale);

    const fetchFn = vi.fn<typeof fetch>(async () => jsonResponse(200, { access_token: 'at-2', refresh_token: 'rt-2', expires_in: 3600 }));
    const manager = createClaudeAuthManager({ credentialsPath, tokenUrl: TOKEN_URL, fetchFn, now: () => NOW_MS, lockRetryLimit: 2, lockRetryBaseMs: 1 });
    expect(await manager.getCredentials()).toEqual({ accessToken: 'at-2' });
    await expect(stat(lockPath)).rejects.toThrow();
  });

  it('does not post a refresh while a fresh official lock is held elsewhere', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'agent-gateway-claude-auth-'));
    const credentialsPath = path.join(dir, '.credentials.json');
    await writeFile(credentialsPath, JSON.stringify(toAuth({ expiresAt: NOW_MS + 60_000 })));
    const lockPath = path.join(dir, CLAUDE_REFRESH_LOCK_DIR);
    await mkdir(lockPath);

    const fetchFn = vi.fn<typeof fetch>(async () => jsonResponse(200, { access_token: 'at-2', expires_in: 3600 }));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const manager = createClaudeAuthManager({ credentialsPath, tokenUrl: TOKEN_URL, fetchFn, now: () => NOW_MS, lockRetryLimit: 2, lockRetryBaseMs: 1 });
    expect(await manager.getCredentials()).toEqual({ accessToken: 'at-1' });
    expect(fetchFn).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('locked by another process'));
    // Za returns lock_busy/lock_timeout without POSTing, so the holder keeps its lock.
    await expect(stat(lockPath)).resolves.toBeTruthy();
  });

  it('adopts a rotation another process wrote while it held the lock instead of posting', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'agent-gateway-claude-auth-'));
    const credentialsPath = path.join(dir, '.credentials.json');
    await writeFile(credentialsPath, JSON.stringify(toAuth({ expiresAt: NOW_MS + 60_000 })));
    await mkdir(path.join(dir, CLAUDE_REFRESH_LOCK_DIR));

    const fetchFn = vi.fn<typeof fetch>(async () => jsonResponse(200, { access_token: 'at-2', expires_in: 3600 }));
    const manager = createClaudeAuthManager({ credentialsPath, tokenUrl: TOKEN_URL, fetchFn, now: () => NOW_MS, lockRetryLimit: 0, lockRetryBaseMs: 1 });
    await writeFile(credentialsPath, JSON.stringify(toAuth({ accessToken: 'at-sibling', expiresAt: NOW_MS + 60_000 })));
    expect(await manager.getCredentials()).toEqual({ accessToken: 'at-sibling' });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('adopts a replacement login from disk before the old token expires', async () => {
    // Review round 1 / F + supervisor relogin probe: the official client reads the credentials
    // file on every use, so a relogin without a restart must not keep the old account's token.
    const never = vi.fn<typeof fetch>(async () => {
      throw new Error('this test must never refresh');
    });
    const { credentialsPath, manager } = await setup(toAuth({}), never);
    expect(await manager.getCredentials()).toEqual({ accessToken: 'at-1' });
    await writeFile(credentialsPath, JSON.stringify(toAuth({ accessToken: 'at-2', refreshToken: 'rt-2' })));
    expect(await manager.getCredentials()).toEqual({ accessToken: 'at-2' });
    expect(never).not.toHaveBeenCalled();
  });

  it('aborts an in-flight refresh and never writes rotated tokens when the lock is stolen', async () => {
    // Review round 1 / F: the native wrapper cancels the refresh on lock loss.
    const dir = await mkdtemp(path.join(os.tmpdir(), 'agent-gateway-claude-auth-'));
    const credentialsPath = path.join(dir, '.credentials.json');
    await writeFile(credentialsPath, JSON.stringify(toAuth({ expiresAt: 1 })));
    const lockPath = path.join(dir, CLAUDE_REFRESH_LOCK_DIR);

    let postedSignal: AbortSignal | undefined;
    const fetchFn = vi.fn<typeof fetch>(async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      postedSignal = init?.signal ?? undefined;
      // Hang like a real in-flight POST until the signal aborts.
      await new Promise<never>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('The operation was aborted')));
      });
      throw new Error('unreachable: the signal always aborts first');
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const manager = createClaudeAuthManager({
      credentialsPath,
      tokenUrl: TOKEN_URL,
      fetchFn,
      now: () => NOW_MS,
      lockRetryLimit: 2,
      lockRetryBaseMs: 1,
      lockUpdateMs: 1_000,
    });
    const pending = manager.getCredentials();
    await vi.waitFor(() => expect(fetchFn).toHaveBeenCalled());
    // A sibling steals the lock while the POST is in flight: replace the directory.
    await rmdir(lockPath);
    await mkdir(lockPath);
    // The heartbeat notices, aborts the POST, and the rotated tokens are never written; the
    // transient path keeps serving the old token.
    expect(await pending).toEqual({ accessToken: 'at-1' });
    expect(postedSignal?.aborted).toBe(true);
    expect((await readSaved(credentialsPath)).claudeAiOauth?.accessToken).toBe('at-1');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('proactive claude refresh failed'));
  });

  it('holds the official lock and the legacy lock while refreshing, then releases both', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'agent-gateway-claude-auth-'));
    const credentialsPath = path.join(dir, '.credentials.json');
    await writeFile(credentialsPath, JSON.stringify(toAuth({ expiresAt: NOW_MS + 60_000 })));
    const lockPath = path.join(dir, CLAUDE_REFRESH_LOCK_DIR);
    const legacyLockPath = `${dir}.lock`;

    const seen: boolean[] = [];
    const fetchFn = vi.fn<typeof fetch>(async () => {
      seen.push((await stat(lockPath)).isDirectory(), (await stat(legacyLockPath)).isDirectory());
      return jsonResponse(200, { access_token: 'at-2', refresh_token: 'rt-2', expires_in: 3600 });
    });
    const manager = createClaudeAuthManager({ credentialsPath, tokenUrl: TOKEN_URL, fetchFn, now: () => NOW_MS, lockRetryLimit: 2, lockRetryBaseMs: 1 });
    expect(await manager.getCredentials()).toEqual({ accessToken: 'at-2' });
    // pOs at 217998206 acquires `<home>/.oauth_refresh.lock` and `realpath(home) + ".lock"`.
    expect(seen).toEqual([true, true]);
    await expect(stat(lockPath)).rejects.toThrow();
    await expect(stat(legacyLockPath)).rejects.toThrow();
  });

  it('asks the user to log in when the credential file is missing', async () => {
    const { dir, manager } = await setup(undefined, vi.fn<typeof fetch>());
    const error = await getRejection(manager.getCredentials());
    expect(error.status).toBe(401);
    expect(error.message).toContain(`CLAUDE_CONFIG_DIR=${dir}`);
    expect(error.message).toContain(getClaudeLoginHint(path.join(dir, '.credentials.json')));
  });

  it('never echoes credential content when the file cannot be parsed', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'agent-gateway-claude-auth-'));
    const credentialsPath = path.join(dir, '.credentials.json');
    await writeFile(credentialsPath, '{"claudeAiOauth":{"accessToken":"secret-token-value"');
    const manager = createClaudeAuthManager({ credentialsPath, tokenUrl: TOKEN_URL, fetchFn: vi.fn<typeof fetch>(), now: () => NOW_MS });
    const error = await getRejection(manager.getCredentials());
    expect(error.status).toBe(401);
    expect(error.message).toContain('is not valid JSON');
    expect(error.message).not.toContain('secret-token-value');
  });

  it('writes the credential file with owner-only permissions', async () => {
    const fetchFn = vi.fn<typeof fetch>(async () => jsonResponse(200, { access_token: 'at-2', refresh_token: 'rt-2', expires_in: 3600 }));
    const { credentialsPath, manager } = await setup(toAuth({ expiresAt: NOW_MS + 60_000 }), fetchFn);
    await manager.getCredentials();
    expect(((await stat(credentialsPath)).mode & 0o777).toString(8)).toBe('600');
  });
});

describe('getClaudeRefreshScopes', () => {
  // EHo at 214897545, chosen by the caller at 218003555: a default subscriber refresh expands to
  // the base CLI scopes and keeps only the projects scopes it already held.
  it('expands a default subscriber credential to the base CLI scopes', () => {
    const { scopes, isExpanded } = getClaudeRefreshScopes({
      accessToken: 'at-1',
      refreshToken: 'rt-1',
      expiresAt: NOW_MS,
      scopes: ['user:profile', 'user:inference', 'user:projects:read'],
      subscriptionType: 'max',
    });
    expect(isExpanded).toBe(true);
    expect(scopes).toEqual([...CLAUDE_OAUTH_SCOPES, 'user:projects:read']);
  });

  it('keeps the stored scopes when an explicit client id is recorded', () => {
    const { scopes, isExpanded } = getClaudeRefreshScopes({
      accessToken: 'at-1',
      refreshToken: 'rt-1',
      expiresAt: NOW_MS,
      scopes: ['user:profile', 'user:inference'],
      clientId: 'client-1',
    });
    expect(isExpanded).toBe(false);
    expect(scopes).toEqual(['user:profile', 'user:inference']);
  });

  it('keeps the stored scopes for a credential without inference scope or subscription type', () => {
    const { scopes, isExpanded } = getClaudeRefreshScopes({
      accessToken: 'at-1',
      refreshToken: 'rt-1',
      expiresAt: NOW_MS,
      scopes: ['user:profile'],
    });
    expect(isExpanded).toBe(false);
    expect(scopes).toEqual(['user:profile']);
  });
});

describe('refresh scope retry', () => {
  // Za at 218003400 passes `invalidScopeRetried: ae` into the refresh request, where Gvo at
  // 217759664 recognises a 400 `invalid_scope` and retries once with the stored scopes. Only
  // `invalid_grant` (Ewe at 217759471) marks the refresh token itself as dead, so an invalid_scope
  // failure stays a transient refresh failure here as well.
  it('retries an expanded scope set once with the original scopes on invalid_scope', async () => {
    const fetchFn = vi.fn<typeof fetch>(async () => jsonResponse(400, { error: 'invalid_scope' }));
    const auth = toAuth({ expiresAt: NOW_MS + 60_000, clientId: undefined, scopes: ['user:profile', 'user:inference'] });
    const { manager } = await setup(auth, fetchFn);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(await manager.getCredentials()).toEqual({ accessToken: 'at-1' });
    expect(fetchFn).toHaveBeenCalledTimes(2);
    const first = JSON.parse(String(fetchFn.mock.calls[0]?.[1]?.body)) as { scope: string };
    const second = JSON.parse(String(fetchFn.mock.calls[1]?.[1]?.body)) as { scope: string };
    expect(first.scope).toBe(BASE_SCOPES);
    expect(second.scope).toBe('user:profile user:inference');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('proactive claude refresh failed'));
  });

  // Gvo at 217759664 retries ONLY on an HTTP 400 invalid_scope; any other status must not spend
  // a second single-use refresh token (supervisor-refresh-status-probe).
  it('does not retry an invalid_scope failure that did not come with HTTP 400', async () => {
    const fetchFn = vi.fn<typeof fetch>(async () => jsonResponse(503, { error: 'invalid_scope' }));
    await expect(
      requestClaudeTokenRefresh(
        { accessToken: 'synthetic', refreshToken: 'synthetic', scopes: ['user:inference'], subscriptionType: 'max' },
        { tokenUrl: 'https://synthetic.invalid/oauth/token', loginHint: 'synthetic login', now: () => 1, fetchFn },
      ),
    ).rejects.toThrow(/HTTP 503/);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
});

describe('readClaudeAccountMetadata', () => {
  // oauthAccount lives in the home's global config (214971963 / 217653633); BO at 217681149 reads
  // the per-install userID (valid 64-hex, Rs at 217681129) from the same file.
  it('reads accountUuid from the legacy config name first', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'agent-gateway-claude-account-'));
    await writeFile(path.join(dir, '.config.json'), JSON.stringify({ oauthAccount: { accountUuid: 'acct-1', organizationUuid: 'org-1' } }));
    await writeFile(path.join(dir, '.claude.json'), JSON.stringify({ oauthAccount: { accountUuid: 'acct-2' } }));
    expect(await readClaudeAccountMetadata(dir)).toEqual({ accountUuid: 'acct-1' });
  });

  it('does not substitute organizationUuid and reads the newer config file', async () => {
    // organizationUuid names an organization, not the user.
    const dir = await mkdtemp(path.join(os.tmpdir(), 'agent-gateway-claude-account-'));
    await writeFile(path.join(dir, '.claude.json'), JSON.stringify({ oauthAccount: { organizationUuid: 'org-1' } }));
    expect(await readClaudeAccountMetadata(dir)).toEqual({});
    await writeFile(path.join(dir, '.claude.json'), JSON.stringify({ oauthAccount: { accountUuid: 'acct-9' } }));
    expect((await readClaudeAccountMetadata(dir)).accountUuid).toBe('acct-9');
  });

  it('forwards a valid 64-hex userID as deviceId and rejects malformed ones', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'agent-gateway-claude-account-'));
    await writeFile(path.join(dir, '.claude.json'), JSON.stringify({ userID: 'a'.repeat(64), oauthAccount: { accountUuid: 'acct-1' } }));
    expect(await readClaudeAccountMetadata(dir)).toEqual({ accountUuid: 'acct-1', deviceId: 'a'.repeat(64) });
    await writeFile(path.join(dir, '.claude.json'), JSON.stringify({ userID: 'short', oauthAccount: { accountUuid: 'acct-1' } }));
    expect(await readClaudeAccountMetadata(dir)).toEqual({ accountUuid: 'acct-1' });
    await writeFile(path.join(dir, '.claude.json'), JSON.stringify({ userID: 'A'.repeat(64), oauthAccount: { accountUuid: 'acct-1' } }));
    expect((await readClaudeAccountMetadata(dir)).deviceId).toBeUndefined();
  });

  it('is empty when the home has no recorded account', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'agent-gateway-claude-account-'));
    expect(await readClaudeAccountMetadata(dir)).toEqual({});
  });
});
