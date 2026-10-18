// Claude Code subscription credentials: read/refresh `.credentials.json` in the selected home.
// Mirrors the pinned official release 2.1.299 (see docs/CLAUDE_UPSTREAM_PROTOCOL_DIFF.md):
// refresh request at binary offset 217749927 (vwe), expiry check at 217754567 (OH),
// file IO at 217333107, compare-and-swap save at 217983336 (KCr), record merge at 217983010 (uE),
// refresh orchestration and lock handling at 218001100 (Za) with 217997780 (nGn)/217998206 (pOs),
// scope expansion at 214897545 (EHo) chosen by the caller at 218003555. Credentials are re-read
// from disk on every use (the official flow reads the file per use), and losing the refresh lock
// aborts an in-flight refresh so rotated tokens are never written under another holder's lock.
import os from 'node:os';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import {
  CLAUDE_GLOBAL_CONFIG_FILES,
  CLAUDE_INFERENCE_SCOPE,
  CLAUDE_OAUTH_CLIENT_ID,
  CLAUDE_OAUTH_SCOPES,
  CLAUDE_PROJECTS_SCOPES,
  CLAUDE_REFRESH_BEFORE_EXPIRY_MS,
  CLAUDE_REFRESH_LOCK_RETRY_BASE_MS,
  CLAUDE_REFRESH_LOCK_RETRY_LIMIT,
  CLAUDE_REFRESH_TIMEOUT_MS,
} from '../constants.js';
import { createProxyError, isProxyError, type ProxyError } from '../errors.js';
import { writeAuthFile } from '../auth/authFile.js';
import { waitForClaudeRefreshLock } from './refreshLock.js';
import type { ClaudeAuthFile, ClaudeCredentials, ClaudeOauth } from './types.js';
import type { Json } from '../types.js';

export type ClaudeAuthManager = {
  getCredentials: () => Promise<ClaudeCredentials>;
  recoverUnauthorized: (failedAccessToken: string) => Promise<ClaudeCredentials>;
};

type ClaudeAuthManagerDeps = {
  credentialsPath: string;
  tokenUrl: string;
  // The official refresh lock lives next to the credentials file, not in this directory; the
  // option is kept so callers can pass the gateway state dir they already resolved.
  stateDir?: string;
  fetchFn?: typeof fetch;
  now?: () => number;
  // Test seams for the official retry cadence (Za at binary offset 218001100).
  lockRetryLimit?: number;
  lockRetryBaseMs?: number;
  // Heartbeat interval override for the refresh lock (proper-lockfile `update`); only used by
  // tests that need the compromise path to fire faster than the official 5000ms.
  lockUpdateMs?: number;
};

export const getClaudeLoginHint = (credentialsPath: string): string =>
  `Run: CLAUDE_CONFIG_DIR=${path.dirname(credentialsPath)} claude, then /login`;

// Binary offset 214971963 W_/_4n and 217653633: the account uuid lives in the home's global config
// (`oauthAccount`), preferring the legacy `.config.json` name. It is the stable per-login identity
// used to keep replay state from following an alias to a different account. organizationUuid is
// NOT a fallback: it names an organization, not the user, so a missing accountUuid stays undefined
// and the caller must fail rather than key signed state on an unproven identity.
// BO at 217681149 also reads a per-install `userID` (valid 64-hex, Rs at 217681129) from the same
// global config and nUe forwards it as metadata device_id. The gateway forwards an existing value
// but never generates or writes one: the official flow persists it into the official config, which
// the gateway must not touch.
export type ClaudeAccountMetadata = { accountUuid?: string; deviceId?: string };

const CLAUDE_USER_ID_PATTERN = /^[0-9a-f]{64}$/;

const readGlobalConfig = async (filePath: string): Promise<ClaudeAccountMetadata | undefined> => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(filePath, 'utf8'));
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined;
  const record = parsed as Json;
  const account = record.oauthAccount;
  const accountUuid = typeof account === 'object' && account !== null ? (account as Json).accountUuid : undefined;
  const deviceId = typeof record.userID === 'string' && CLAUDE_USER_ID_PATTERN.test(record.userID) ? record.userID : undefined;
  if (typeof accountUuid === 'string' && accountUuid !== '') return { accountUuid, ...(deviceId === undefined ? {} : { deviceId }) };
  return undefined;
};

export const readClaudeAccountMetadata = async (homeDir: string): Promise<ClaudeAccountMetadata> => {
  for (const fileName of CLAUDE_GLOBAL_CONFIG_FILES) {
    const metadata = await readGlobalConfig(path.join(homeDir, fileName));
    if (metadata !== undefined) return metadata;
  }
  // Mirrors references/claude-code v2.1.299 mods/telemetry/hooks/context/identity/global-config-path.ts:
  // the official global config lives under `<CLAUDE_CONFIG_DIR || home>/.claude.json`, so a login
  // without CLAUDE_CONFIG_DIR records oauthAccount in the user's home, not inside the default
  // `~/.claude` directory. Only that default home may fall back here: a CLAUDE_CONFIG_DIR home must
  // never pair its token with another account's identity.
  if (path.resolve(homeDir) === path.join(os.homedir(), '.claude')) {
    const metadata = await readGlobalConfig(path.join(os.homedir(), '.claude.json'));
    if (metadata !== undefined) return metadata;
  }
  return {};
};

// Binary offset 217754567 OH(): a null (or missing) expiry is never treated as expiring.
export const isClaudeTokenExpiring = (expiresAt: number | null | undefined, nowMs: number): boolean =>
  typeof expiresAt === 'number' && nowMs + CLAUDE_REFRESH_BEFORE_EXPIRY_MS >= expiresAt;

const getRefreshErrorCode = (body: unknown): string | undefined => {
  if (typeof body !== 'object' || body === null) return undefined;
  const { error, code } = body as Json;
  if (typeof error === 'string') return error;
  if (typeof error === 'object' && error !== null && typeof (error as Json).code === 'string') return (error as Json).code as string;
  return typeof code === 'string' ? code : undefined;
};

export type ClaudeRefreshedTokens = {
  accessToken: string;
  refreshToken: string;
  expiresAt: number | null;
  refreshTokenExpiresAt?: number;
  scopes: string[];
  clientId?: string;
};

// Binary offset 214897545 EHo(): a default subscriber refresh sends the base CLI scopes plus only
// the projects scopes it already held. An explicit clientId keeps the stored scopes untouched.
export const getClaudeRefreshScopes = (oauth: ClaudeOauth): { scopes: string[]; isExpanded: boolean; hasInferenceScope: boolean } => {
  const stored = Array.isArray(oauth.scopes) ? oauth.scopes.filter((scope): scope is string => typeof scope === 'string') : [];
  const hasInferenceScope = stored.includes(CLAUDE_INFERENCE_SCOPE);
  const isEligible = (hasInferenceScope || Boolean(oauth.subscriptionType)) && oauth.clientId === undefined;
  if (!isEligible) return { scopes: stored.length > 0 ? stored : [...CLAUDE_OAUTH_SCOPES], isExpanded: false, hasInferenceScope };
  const keptProjects = stored.filter((scope) => (CLAUDE_PROJECTS_SCOPES as readonly string[]).includes(scope));
  return { scopes: [...new Set([...CLAUDE_OAUTH_SCOPES, ...keptProjects])], isExpanded: true, hasInferenceScope };
};

const toRefreshBody = (oauth: ClaudeOauth, scopes: string[]): Json => ({
  grant_type: 'refresh_token',
  refresh_token: oauth.refreshToken,
  client_id: oauth.clientId ?? CLAUDE_OAUTH_CLIENT_ID,
  scope: scopes.join(' '),
});

const postClaudeRefresh = async (
  body: Json,
  deps: { tokenUrl: string; fetchFn: typeof fetch; signal?: AbortSignal },
): Promise<{ ok: boolean; status: number; code?: string; data: Json }> => {
  let response: Response;
  try {
    response = await deps.fetchFn(deps.tokenUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.any([AbortSignal.timeout(CLAUDE_REFRESH_TIMEOUT_MS), ...(deps.signal ? [deps.signal] : [])]),
    });
  } catch (error) {
    if (deps.signal?.aborted) {
      throw createProxyError({ status: 502, code: 'token_refresh_failed', message: 'Claude refresh lock was lost during refresh' });
    }
    throw createProxyError({ status: 502, code: 'token_refresh_failed', message: `Token refresh failed: ${String(error)}` });
  }
  const text = await response.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = {};
  }
  const data = (typeof parsed === 'object' && parsed !== null ? parsed : {}) as Json;
  return { ok: response.ok, status: response.status, code: getRefreshErrorCode(data), data };
};

// Binary offset 217749927: grant_type/refresh_token/client_id/scope, optional expires_in, 30s timeout,
// and the previous refresh token is kept when the response omits a new one.
export const requestClaudeTokenRefresh = async (
  oauth: ClaudeOauth,
  deps: { tokenUrl: string; fetchFn: typeof fetch; loginHint: string; now: () => number; signal?: AbortSignal },
): Promise<ClaudeRefreshedTokens> => {
  const { scopes, isExpanded, hasInferenceScope } = getClaudeRefreshScopes(oauth);
  let result = await postClaudeRefresh(toRefreshBody(oauth, scopes), deps);
  // Za at 218003400 sets `invalidScopeRetried` from the STORED scopes (k4n), and Gvo at 217759664
  // retries the request once with those stored scopes ONLY on an HTTP 400 `invalid_scope`; other
  // statuses must not spend a second refresh attempt.
  if (!result.ok && result.status === 400 && result.code === 'invalid_scope' && isExpanded && hasInferenceScope) {
    const stored = Array.isArray(oauth.scopes) ? (oauth.scopes as string[]) : [];
    result = await postClaudeRefresh(toRefreshBody(oauth, stored), deps);
  }
  if (!result.ok) {
    if (result.status === 401 || result.status === 403 || (result.status === 400 && result.code === 'invalid_grant')) {
      throw createProxyError({
        status: 401,
        code: result.code ?? 'token_refresh_rejected',
        message: `Claude login is no longer valid (${result.code ?? `HTTP ${result.status}`}). ${deps.loginHint}`,
      });
    }
    throw createProxyError({ status: 502, code: 'token_refresh_failed', message: `Token refresh failed with HTTP ${result.status}` });
  }
  if (typeof result.data.access_token !== 'string') {
    throw createProxyError({ status: 502, code: 'token_refresh_failed', message: 'Token refresh returned no access token' });
  }
  const expiresIn = typeof result.data.expires_in === 'number' ? result.data.expires_in : undefined;
  return {
    accessToken: result.data.access_token,
    refreshToken: typeof result.data.refresh_token === 'string' ? result.data.refresh_token : (oauth.refreshToken ?? ''),
    expiresAt: expiresIn === undefined ? (oauth.expiresAt ?? null) : deps.now() + expiresIn * 1000,
    ...(typeof result.data.refresh_token_expires_in === 'number'
      ? { refreshTokenExpiresAt: deps.now() + result.data.refresh_token_expires_in * 1000 }
      : {}),
    scopes: typeof result.data.scope === 'string' ? result.data.scope.split(' ').filter(Boolean) : scopes,
    ...(oauth.clientId === undefined ? {} : { clientId: oauth.clientId }),
  };
};

// Merge that keeps unknown top-level fields, like the official mutate() of the stored file.
export const applyClaudeRefreshResult = (auth: ClaudeAuthFile, tokens: ClaudeRefreshedTokens): ClaudeAuthFile => ({
  ...auth,
  claudeAiOauth: {
    ...auth.claudeAiOauth,
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    expiresAt: tokens.expiresAt,
    ...(tokens.refreshTokenExpiresAt === undefined ? {} : { refreshTokenExpiresAt: tokens.refreshTokenExpiresAt }),
    scopes: tokens.scopes,
    ...(tokens.clientId === undefined ? {} : { clientId: tokens.clientId }),
  },
});

const wait = async (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export const createClaudeAuthManager = ({
  credentialsPath,
  tokenUrl,
  fetchFn = fetch,
  now = Date.now,
  lockRetryLimit = CLAUDE_REFRESH_LOCK_RETRY_LIMIT,
  lockRetryBaseMs = CLAUDE_REFRESH_LOCK_RETRY_BASE_MS,
  lockUpdateMs,
}: ClaudeAuthManagerDeps): ClaudeAuthManager => {
  const loginHint = getClaudeLoginHint(credentialsPath);
  const homeDir = path.dirname(credentialsPath);
  let cachedAuth: ClaudeAuthFile | undefined;
  let inflightRefresh: Promise<ClaudeAuthFile> | undefined;
  let permanentFailure: { refreshToken: string; error: ProxyError } | undefined;

  // Never echo file content: a JSON parse error can quote part of the token it choked on.
  const readAuth = async (): Promise<ClaudeAuthFile> => {
    let text: string;
    try {
      text = await readFile(credentialsPath, 'utf8');
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      throw createProxyError({
        status: 401,
        code: 'login_required',
        message: `Cannot read ${credentialsPath}${code === undefined ? '' : ` (${code})`}. ${loginHint}`,
      });
    }
    try {
      return JSON.parse(text) as ClaudeAuthFile;
    } catch {
      throw createProxyError({ status: 401, code: 'login_required', message: `${credentialsPath} is not valid JSON. ${loginHint}` });
    }
  };

  const toCredentials = (auth: ClaudeAuthFile): ClaudeCredentials => {
    const accessToken = auth.claudeAiOauth?.accessToken;
    if (typeof accessToken !== 'string' || accessToken === '') {
      throw createProxyError({ status: 401, code: 'login_required', message: `${credentialsPath} has no Claude login. ${loginHint}` });
    }
    return { accessToken };
  };

  const adopt = (auth: ClaudeAuthFile): ClaudeAuthFile => {
    cachedAuth = auth;
    return auth;
  };

  // Refresh tokens are single-use, so the official release holds a cross-process lock and always
  // re-reads under it. The same lock directory (`<home>/.oauth_refresh.lock`) is used here so the
  // official CLI and the gateway cannot race each other.
  const runRefresh = async (force: boolean): Promise<ClaudeAuthFile> => {
    const before = await readAuth();
    const expectedAccessToken = before.claudeAiOauth?.accessToken;
    const refreshToken = before.claudeAiOauth?.refreshToken;
    // Tokens were rotated outside this process (e.g. `claude /login`): adopt them. Only compare
    // once this process has actually read the file; a first-ever call must be able to refresh.
    if (cachedAuth !== undefined && refreshToken !== cachedAuth.claudeAiOauth?.refreshToken) return adopt(before);
    if (!refreshToken) throw createProxyError({ status: 401, code: 'login_required', message: loginHint });
    if (permanentFailure?.refreshToken === refreshToken) throw permanentFailure.error;

    // The native wrapper aborts an in-flight refresh when the lock is stolen; mirror that: the
    // POST is cancelled and the rotated tokens can never be written under someone else's lock.
    const lockLost = new AbortController();
    const lock = await waitForClaudeRefreshLock(homeDir, {
      retryLimit: lockRetryLimit,
      retryBaseMs: lockRetryBaseMs,
      ...(lockUpdateMs === undefined ? {} : { updateMs: lockUpdateMs }),
      onCompromised: (reason) => {
        console.warn(`[auth] claude refresh lock compromised: ${reason}`);
        lockLost.abort();
      },
    });
    if (lock === undefined) {
      // Za returns lock_busy/lock_timeout without POSTing: a sibling owns the rotation, so only
      // adopt what it wrote and never burn the single-use refresh token.
      const adopted = await readAuth();
      if (adopted.claudeAiOauth?.accessToken !== expectedAccessToken) return adopt(adopted);
      console.warn(`[auth] claude token refresh is locked by another process; using the on-disk token`);
      return adopt(adopted);
    }

    try {
      const onDisk = await readAuth();
      if (onDisk.claudeAiOauth?.accessToken !== expectedAccessToken) return adopt(onDisk);
      if (!force && !isClaudeTokenExpiring(onDisk.claudeAiOauth?.expiresAt, now())) return adopt(onDisk);
      const postedRefreshToken = onDisk.claudeAiOauth?.refreshToken ?? refreshToken;
      if (!postedRefreshToken) throw createProxyError({ status: 401, code: 'login_required', message: loginHint });
      if (lock.isCompromised()) {
        const adopted = await readAuth();
        return adopt(adopted);
      }

      const tokens = await requestClaudeTokenRefresh({ ...(onDisk.claudeAiOauth ?? {}), refreshToken: postedRefreshToken }, {
        tokenUrl,
        fetchFn,
        loginHint,
        now,
        signal: lockLost.signal,
      });

      // A lock stolen while the POST was in flight means another holder owns the file now.
      if (lock.isCompromised()) {
        const adopted = await readAuth();
        if (adopted.claudeAiOauth?.accessToken !== expectedAccessToken) return adopt(adopted);
        throw createProxyError({ status: 502, code: 'token_refresh_failed', message: 'Claude refresh lock was lost during refresh' });
      }

      // Compare-and-swap save (offset 217983336): if the file already holds a different refresh
      // token, a sibling rotated it, so adopt that instead of clobbering it. A lock stolen while
      // the POST was in flight means the new holder owns the file: never write under it.
      for (let attempt = 0; attempt < 3; attempt += 1) {
        if (attempt > 0) await wait(100 * attempt);
        if (lock.isCompromised()) {
          const adopted = await readAuth();
          if (adopted.claudeAiOauth?.accessToken !== expectedAccessToken) return adopt(adopted);
          throw createProxyError({ status: 502, code: 'token_refresh_failed', message: 'Claude refresh lock was lost during refresh' });
        }
        const current = await readAuth();
        const currentRefreshToken = current.claudeAiOauth?.refreshToken;
        if (current.claudeAiOauth != null && currentRefreshToken !== '' && currentRefreshToken !== postedRefreshToken) {
          return adopt(current);
        }
        const nextAuth = applyClaudeRefreshResult(current, tokens);
        try {
          await writeAuthFile(credentialsPath, nextAuth);
        } catch {
          continue;
        }
        cachedAuth = nextAuth;
        console.log('[auth] claude access token refreshed');
        return nextAuth;
      }
      throw createProxyError({ status: 502, code: 'token_refresh_failed', message: `Cannot write ${credentialsPath}` });
    } catch (error) {
      if (lock.isCompromised()) {
        const adopted = await readAuth();
        if (adopted.claudeAiOauth?.accessToken !== expectedAccessToken) return adopt(adopted);
      }
      if (isProxyError(error) && error.status === 401) permanentFailure = { refreshToken, error };
      throw error;
    } finally {
      await lock.release();
    }
  };

  // Single-flight: concurrent callers share one refresh (refresh tokens are single-use).
  const refreshOnce = (force: boolean): Promise<ClaudeAuthFile> => {
    inflightRefresh ??= runRefresh(force).finally(() => {
      inflightRefresh = undefined;
    });
    return inflightRefresh;
  };

  // The official client reads the credentials file on every use, so a relogin on disk is picked
  // up without a restart. cachedAuth tracks what this process last read,
  // wrote or adopted, which is what the rotation checks in runRefresh compare against.
  const loadAuth = async (): Promise<ClaudeAuthFile> => {
    const auth = await readAuth();
    cachedAuth = auth;
    return auth;
  };

  const getCredentials = async (): Promise<ClaudeCredentials> => {
    const auth = await loadAuth();
    if (!isClaudeTokenExpiring(auth.claudeAiOauth?.expiresAt, now())) return toCredentials(auth);
    try {
      return toCredentials(await refreshOnce(false));
    } catch (error) {
      if (isProxyError(error) && error.status === 401) throw error;
      // Transient failure: keep the current token, like the official client does.
      console.warn(`[auth] proactive claude refresh failed: ${error instanceof Error ? error.message : String(error)}`);
      return toCredentials(auth);
    }
  };

  const recoverUnauthorized = async (failedAccessToken: string): Promise<ClaudeCredentials> => {
    const onDisk = await readAuth();
    if (onDisk.claudeAiOauth?.accessToken !== failedAccessToken) return toCredentials(adopt(onDisk));
    return toCredentials(await refreshOnce(true));
  };

  return { getCredentials, recoverUnauthorized };
};
