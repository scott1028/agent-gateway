import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  applyRefreshResult,
  getCredentialsFromAuth,
  readAuthFile,
  shouldRefresh,
  writeAuthFile,
} from '../../src/auth/authFile.js';
import { decodeJwtPayload, getAuthClaims, getJwtExpiryMs } from '../../src/auth/jwt.js';
import type { AuthFile } from '../../src/types.js';
import { toJwt } from '../helpers.js';

const NOW_MS = Date.parse('2026-10-13T00:00:00Z');

const toAuth = (accessPayload: Record<string, unknown>, lastRefresh?: string): AuthFile => ({
  auth_mode: 'chatgpt',
  OPENAI_API_KEY: null,
  tokens: {
    id_token: toJwt({ 'https://api.openai.com/auth': { chatgpt_account_id: 'acct-from-claim', chatgpt_account_is_fedramp: true } }),
    access_token: toJwt(accessPayload),
    refresh_token: 'rt-1',
    account_id: 'acct-1',
  },
  last_refresh: lastRefresh,
});

describe('jwt', () => {
  it('decodes payload, expiry and auth claims', () => {
    expect(decodeJwtPayload(toJwt({ a: 1 }))).toEqual({ a: 1 });
    expect(decodeJwtPayload('not-a-jwt')).toBeUndefined();
    expect(getJwtExpiryMs(toJwt({ exp: 10 }))).toBe(10_000);
    expect(getJwtExpiryMs(toJwt({}))).toBeUndefined();
    expect(getAuthClaims(toJwt({ 'https://api.openai.com/auth': { chatgpt_account_id: 'a' } }))).toEqual({
      accountId: 'a',
      isFedramp: false,
    });
  });
});

describe('shouldRefresh', () => {
  it('refreshes within 5 minutes of expiry', () => {
    expect(shouldRefresh(toAuth({ exp: NOW_MS / 1000 + 4 * 60 }), NOW_MS)).toBe(true);
    expect(shouldRefresh(toAuth({ exp: NOW_MS / 1000 + 6 * 60 }), NOW_MS)).toBe(false);
  });

  it('falls back to 8-day last_refresh age when exp is missing', () => {
    expect(shouldRefresh(toAuth({}, '2026-10-01T00:00:00Z'), NOW_MS)).toBe(true);
    expect(shouldRefresh(toAuth({}, '2026-10-10T00:00:00Z'), NOW_MS)).toBe(false);
    expect(shouldRefresh(toAuth({}), NOW_MS)).toBe(false);
  });
});

describe('applyRefreshResult', () => {
  it('replaces only returned tokens and keeps other keys', () => {
    const auth = { ...toAuth({ exp: 1 }), custom_key: 'kept' };
    const next = applyRefreshResult(auth, { access_token: 'new-access' }, new Date(NOW_MS));
    expect(next.tokens?.access_token).toBe('new-access');
    expect(next.tokens?.refresh_token).toBe('rt-1');
    expect(next.tokens?.account_id).toBe('acct-1');
    expect(next.custom_key).toBe('kept');
    expect(next.OPENAI_API_KEY).toBeNull();
    expect(next.last_refresh).toBe('2026-10-13T00:00:00.000Z');
  });
});

describe('getCredentialsFromAuth', () => {
  it('prefers tokens.account_id and reads fedramp from id_token', () => {
    expect(getCredentialsFromAuth(toAuth({ exp: 1 }))).toMatchObject({ accountId: 'acct-1', isFedramp: true });
    expect(getCredentialsFromAuth({ auth_mode: 'apikey' })).toBeUndefined();
  });
});

describe('writeAuthFile', () => {
  it('writes atomically with mode 0600', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'agent-gateway-'));
    const authPath = path.join(dir, 'auth.json');
    await writeFile(authPath, '{}', { mode: 0o644 });
    await writeAuthFile(authPath, toAuth({ exp: 1 }));
    expect((await stat(authPath)).mode & 0o777).toBe(0o600);
    expect((await readAuthFile(authPath)).tokens?.refresh_token).toBe('rt-1');
    expect(await readFile(authPath, 'utf8')).toMatch(/\n$/);
  });
});
