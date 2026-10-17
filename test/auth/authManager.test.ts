import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createAuthManager, getRefreshErrorCode, isPermanentRefreshFailure } from '../../src/auth/authManager.js';
import type { AuthFile } from '../../src/types.js';
import { toJwt } from '../helpers.js';

const NOW_MS = Date.parse('2026-10-13T00:00:00Z');
const EXPIRED_ACCESS = toJwt({ exp: NOW_MS / 1000 - 60 });
const VALID_ACCESS = toJwt({ exp: NOW_MS / 1000 + 3600 });

const toAuth = (accessToken: string, refreshToken: string): AuthFile => ({
  auth_mode: 'chatgpt',
  tokens: { id_token: toJwt({}), access_token: accessToken, refresh_token: refreshToken, account_id: 'acct-1' },
});

const setup = async (auth: AuthFile, fetchFn: typeof fetch) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'agent-gateway-auth-'));
  const authPath = path.join(dir, 'auth.json');
  await writeFile(authPath, JSON.stringify(auth));
  const manager = createAuthManager({ authPath, refreshUrl: 'https://auth.test/token', fetchFn, now: () => NOW_MS });
  return { authPath, manager };
};

const jsonResponse = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('getRefreshErrorCode / isPermanentRefreshFailure', () => {
  it('reads code from the known shapes', () => {
    expect(getRefreshErrorCode({ error: 'invalid_grant' })).toBe('invalid_grant');
    expect(getRefreshErrorCode({ error: { code: 'refresh_token_reused' } })).toBe('refresh_token_reused');
    expect(getRefreshErrorCode({ code: 'refresh_token_expired' })).toBe('refresh_token_expired');
    expect(getRefreshErrorCode('x')).toBeUndefined();
  });

  it('classifies permanent failures like Codex', () => {
    expect(isPermanentRefreshFailure(401)).toBe(true);
    expect(isPermanentRefreshFailure(400, 'refresh_token_reused')).toBe(true);
    expect(isPermanentRefreshFailure(400, 'invalid_grant')).toBe(true);
    expect(isPermanentRefreshFailure(500)).toBe(false);
    expect(isPermanentRefreshFailure(400, 'other')).toBe(false);
  });
});

describe('createAuthManager', () => {
  it('returns current credentials without refreshing when the token is valid', async () => {
    const fetchFn = vi.fn<typeof fetch>();
    const { manager } = await setup(toAuth(VALID_ACCESS, 'rt-1'), fetchFn);
    expect(await manager.getCredentials()).toMatchObject({ accessToken: VALID_ACCESS, accountId: 'acct-1' });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('refreshes once for concurrent callers and writes the result back', async () => {
    const fetchFn = vi.fn<typeof fetch>(async () => jsonResponse(200, { access_token: VALID_ACCESS, refresh_token: 'rt-2' }));
    const { authPath, manager } = await setup(toAuth(EXPIRED_ACCESS, 'rt-1'), fetchFn);
    const results = await Promise.all(Array.from({ length: 10 }, () => manager.getCredentials()));
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(results.every((credentials) => credentials.accessToken === VALID_ACCESS)).toBe(true);
    const saved = JSON.parse(await readFile(authPath, 'utf8')) as AuthFile;
    expect(saved.tokens?.refresh_token).toBe('rt-2');
    expect(saved.last_refresh).toBe('2026-10-13T00:00:00.000Z');
    const requestBody = JSON.parse(String(fetchFn.mock.calls[0]?.[1]?.body)) as Record<string, string>;
    expect(requestBody).toMatchObject({ grant_type: 'refresh_token', refresh_token: 'rt-1' });
  });

  it('adopts tokens rotated on disk without calling the network', async () => {
    const fetchFn = vi.fn<typeof fetch>();
    const { authPath, manager } = await setup(toAuth(EXPIRED_ACCESS, 'rt-1'), fetchFn);
    await manager.getCredentials().catch(() => undefined);
    fetchFn.mockClear();
    await writeFile(authPath, JSON.stringify(toAuth(VALID_ACCESS, 'rt-from-login')));
    const credentials = await manager.recoverUnauthorized(EXPIRED_ACCESS);
    expect(credentials.accessToken).toBe(VALID_ACCESS);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('caches a permanent refresh failure as a 401 with a login hint', async () => {
    const fetchFn = vi.fn<typeof fetch>(async () => jsonResponse(400, { error: { code: 'refresh_token_reused' } }));
    const { manager } = await setup(toAuth(EXPIRED_ACCESS, 'rt-1'), fetchFn);
    await expect(manager.getCredentials()).rejects.toMatchObject({ status: 401, code: 'refresh_token_reused' });
    await expect(manager.recoverUnauthorized(EXPIRED_ACCESS)).rejects.toThrow(/codex login/);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('keeps the old token when a proactive refresh fails transiently', async () => {
    const fetchFn = vi.fn<typeof fetch>(async () => jsonResponse(503, {}));
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { manager } = await setup(toAuth(EXPIRED_ACCESS, 'rt-1'), fetchFn);
    expect((await manager.getCredentials()).accessToken).toBe(EXPIRED_ACCESS);
  });

  it('does not refresh again when another request already replaced the failed token', async () => {
    const fetchFn = vi.fn<typeof fetch>(async () => jsonResponse(200, { access_token: VALID_ACCESS, refresh_token: 'rt-2' }));
    const { manager } = await setup(toAuth(EXPIRED_ACCESS, 'rt-1'), fetchFn);
    await manager.getCredentials();
    const credentials = await manager.recoverUnauthorized(EXPIRED_ACCESS);
    expect(credentials.accessToken).toBe(VALID_ACCESS);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('reports a missing auth file as login_required', async () => {
    const manager = createAuthManager({ authPath: '/nonexistent/auth.json', refreshUrl: 'x', fetchFn: vi.fn<typeof fetch>() });
    await expect(manager.getCredentials()).rejects.toMatchObject({ status: 401, code: 'login_required' });
  });
});
