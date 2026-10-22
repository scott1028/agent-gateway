import path from 'node:path';
import { OAUTH_CLIENT_ID } from '../constants.js';
import { createProxyError, isProxyError, type ProxyError } from '../errors.js';
import type { AuthFile, Credentials, Json, RefreshResult } from '../types.js';
import { applyRefreshResult, getCredentialsFromAuth, getRefreshReason, readAuthFile, writeAuthFile, type RefreshReason } from './authFile.js';

export type AuthManager = {
  getCredentials: () => Promise<Credentials>;
  recoverUnauthorized: (failedAccessToken: string) => Promise<Credentials>;
};

type AuthManagerDeps = {
  authPath: string;
  refreshUrl: string;
  fetchFn?: typeof fetch;
  now?: () => number;
};

const PERMANENT_REFRESH_CODES = ['refresh_token_expired', 'refresh_token_reused', 'refresh_token_invalidated'];

export const getLoginHint = (authPath: string): string => `Run: CODEX_HOME=${path.dirname(authPath)} codex login`;

// Error code lives in `error` (string), `error.code`, or `code` (login/src/oauth/error.rs).
export const getRefreshErrorCode = (body: unknown): string | undefined => {
  if (typeof body !== 'object' || body === null) return undefined;
  const { error, code } = body as Json;
  if (typeof error === 'string') return error;
  if (typeof error === 'object' && error !== null && typeof (error as Json).code === 'string') {
    return (error as Json).code as string;
  }
  return typeof code === 'string' ? code : undefined;
};

// Case-insensitive like references/codex @b4ad33d1 manager.rs classify_refresh_token_failure.
export const isPermanentRefreshFailure = (status: number, code?: string): boolean => {
  const normalized = code?.toLowerCase();
  return (
    status === 401 ||
    (normalized !== undefined && PERMANENT_REFRESH_CODES.includes(normalized)) ||
    (status === 400 && normalized === 'invalid_grant')
  );
};

const requestTokenRefresh = async (
  refreshToken: string,
  reason: RefreshReason,
  deps: { refreshUrl: string; fetchFn: typeof fetch; loginHint: string },
): Promise<RefreshResult> => {
  let response: Response;
  try {
    response = await deps.fetchFn(deps.refreshUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      // Mirrors references/codex @b4ad33d1 manager.rs request_chatgpt_token_refresh (JSON, reason always present).
      body: JSON.stringify({ client_id: OAUTH_CLIENT_ID, grant_type: 'refresh_token', refresh_token: refreshToken, refresh_reason: reason }),
      signal: AbortSignal.timeout(60_000),
    });
  } catch (error) {
    throw createProxyError({ status: 502, code: 'token_refresh_failed', message: `Token refresh failed: ${String(error)}` });
  }
  const bodyText = await response.text();
  let body: unknown;
  try {
    body = JSON.parse(bodyText);
  } catch {
    body = undefined;
  }
  if (response.ok) return (body ?? {}) as RefreshResult;
  const code = getRefreshErrorCode(body);
  if (isPermanentRefreshFailure(response.status, code)) {
    throw createProxyError({
      status: 401,
      code: code ?? 'token_refresh_rejected',
      message: `ChatGPT login is no longer valid (${code ?? `HTTP ${response.status}`}). ${deps.loginHint}`,
    });
  }
  throw createProxyError({
    status: 502,
    code: 'token_refresh_failed',
    message: `Token refresh failed with HTTP ${response.status}`,
  });
};

export const createAuthManager = ({ authPath, refreshUrl, fetchFn = fetch, now = Date.now }: AuthManagerDeps): AuthManager => {
  const loginHint = getLoginHint(authPath);
  let cachedAuth: AuthFile | undefined;
  let inflightRefresh: Promise<AuthFile> | undefined;
  let permanentFailure: { refreshToken: string; error: ProxyError } | undefined;

  const readAuth = async (): Promise<AuthFile> => {
    try {
      return await readAuthFile(authPath);
    } catch (error) {
      throw createProxyError({ status: 401, code: 'login_required', message: `Cannot read ${authPath} (${String(error)}). ${loginHint}` });
    }
  };

  const toCredentials = (auth: AuthFile): Credentials => {
    const credentials = getCredentialsFromAuth(auth);
    if (!credentials) {
      throw createProxyError({ status: 401, code: 'login_required', message: `${authPath} has no ChatGPT login. ${loginHint}` });
    }
    return credentials;
  };

  const loadAuth = async (): Promise<AuthFile> => {
    cachedAuth ??= await readAuth();
    return cachedAuth;
  };

  const runRefresh = async (reason: RefreshReason): Promise<AuthFile> => {
    const onDisk = await readAuth();
    // Tokens were rotated outside this process (e.g. `codex login`): adopt them.
    if (onDisk.tokens?.refresh_token !== cachedAuth?.tokens?.refresh_token) {
      cachedAuth = onDisk;
      return onDisk;
    }
    const refreshToken = onDisk.tokens?.refresh_token;
    if (!refreshToken) throw createProxyError({ status: 401, code: 'login_required', message: loginHint });
    if (permanentFailure?.refreshToken === refreshToken) throw permanentFailure.error;
    try {
      const result = await requestTokenRefresh(refreshToken, reason, { refreshUrl, fetchFn, loginHint });
      const nextAuth = applyRefreshResult(onDisk, result, new Date(now()));
      await writeAuthFile(authPath, nextAuth);
      cachedAuth = nextAuth;
      console.log('[auth] access token refreshed');
      return nextAuth;
    } catch (error) {
      if (isProxyError(error) && error.status === 401) permanentFailure = { refreshToken, error };
      throw error;
    }
  };

  // Single-flight: concurrent callers share one refresh (refresh tokens are single-use);
  // the starter's refresh_reason goes on the wire, like @b4ad33d1 manager.rs recovery reuse.
  const refreshOnce = (reason: RefreshReason): Promise<AuthFile> => {
    inflightRefresh ??= runRefresh(reason).finally(() => {
      inflightRefresh = undefined;
    });
    return inflightRefresh;
  };

  const getCredentials = async (): Promise<Credentials> => {
    const auth = await loadAuth();
    const reason = getRefreshReason(auth, now());
    if (!reason) return toCredentials(auth);
    try {
      return toCredentials(await refreshOnce(reason));
    } catch (error) {
      if (isProxyError(error) && error.status === 401) throw error;
      // Transient failure: keep the current token, like Codex does.
      console.warn(`[auth] proactive refresh failed: ${error instanceof Error ? error.message : String(error)}`);
      return toCredentials(auth);
    }
  };

  const recoverUnauthorized = async (failedAccessToken: string): Promise<Credentials> => {
    const auth = await loadAuth();
    // Another request already replaced the failed token.
    if (auth.tokens?.access_token !== failedAccessToken) return toCredentials(auth);
    const onDisk = await readAuth();
    if (onDisk.tokens?.access_token !== failedAccessToken) {
      cachedAuth = onDisk;
      return toCredentials(onDisk);
    }
    // 401 recovery: unauthorized_recovery, like manager.rs refresh_token_from_authority_with_reason.
    return toCredentials(await refreshOnce('unauthorized_recovery'));
  };

  return { getCredentials, recoverUnauthorized };
};
