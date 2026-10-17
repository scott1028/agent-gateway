import { randomUUID } from 'node:crypto';
import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import { REFRESH_BEFORE_EXPIRY_MS, REFRESH_FALLBACK_AGE_MS } from '../constants.js';
import type { AuthFile, Credentials, RefreshResult } from '../types.js';
import { getAuthClaims, getJwtExpiryMs } from './jwt.js';

export const readAuthFile = async (authPath: string): Promise<AuthFile> =>
  JSON.parse(await readFile(authPath, 'utf8')) as AuthFile;

// Write to a temp file and rename, so readers never see a half-written auth.json.
export const writeAuthFile = async (authPath: string, auth: AuthFile): Promise<void> => {
  const tmpPath = `${authPath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(tmpPath, `${JSON.stringify(auth, null, 2)}\n`, { mode: 0o600 });
    await rename(tmpPath, authPath);
  } catch (error) {
    await rm(tmpPath, { force: true });
    throw error;
  }
};

// Returns undefined when auth.json holds no ChatGPT tokens.
export const getCredentialsFromAuth = (auth: AuthFile): Credentials | undefined => {
  const tokens = auth.tokens;
  if (!tokens?.access_token) return undefined;
  const claims = getAuthClaims(tokens.id_token ?? '');
  return {
    accessToken: tokens.access_token,
    accountId: tokens.account_id ?? claims.accountId,
    isFedramp: claims.isFedramp,
  };
};

// Same rule as Codex: refresh 5 min before expiry, or after 8 days when exp is unknown.
export const shouldRefresh = (auth: AuthFile, nowMs: number): boolean => {
  const accessToken = auth.tokens?.access_token;
  if (!accessToken) return false;
  const expiryMs = getJwtExpiryMs(accessToken);
  if (expiryMs !== undefined) return expiryMs <= nowMs + REFRESH_BEFORE_EXPIRY_MS;
  const lastRefreshMs = auth.last_refresh ? Date.parse(auth.last_refresh) : Number.NaN;
  return Number.isFinite(lastRefreshMs) && lastRefreshMs < nowMs - REFRESH_FALLBACK_AGE_MS;
};

// Only overwrite returned tokens; keep account_id and unknown keys as they are.
export const applyRefreshResult = (auth: AuthFile, result: RefreshResult, now: Date): AuthFile => {
  if (!auth.tokens) throw new Error('auth.json has no tokens to refresh');
  const tokens = { ...auth.tokens };
  if (result.id_token) tokens.id_token = result.id_token;
  if (result.access_token) tokens.access_token = result.access_token;
  if (result.refresh_token) tokens.refresh_token = result.refresh_token;
  return { ...auth, tokens, last_refresh: now.toISOString() };
};
