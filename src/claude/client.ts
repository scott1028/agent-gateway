// Claude Messages API client. Header set and conditional headers mirror the pinned official
// release 2.1.299: Nl() at binary offset 219076570, subscriber auth (wRs) at 218608550,
// models.list betas/limit at 233338777, the beta messages resource at 218933955 and the
// paginated list resource plus Page shape at 218976383 / 218854348. The User-Agent mirrors the
// official $0() generator at 218027148 (user-approved exception for the Claude path), and the
// common Accept mirrors the SDK buildHeaders default at 218991503.
import { randomUUID } from 'node:crypto';
import type { ClaudeAuthManager } from './auth.js';
import { getClaudeLoginHint } from './auth.js';
import { getClaudeEffectiveEntrypoint, serializeClaudeRequest } from './attribution.js';
import {
  CLAUDE_ANTHROPIC_VERSION,
  CLAUDE_BASE_URL,
  CLAUDE_CLI_VERSION,
  CLAUDE_CODE_BETA,
  CLAUDE_MESSAGES_PATH,
  CLAUDE_MODELS_PAGE_LIMIT,
  CLAUDE_OAUTH_BETA,
  CLAUDE_REQUEST_TIMEOUT_MS,
  CLAUDE_SDK_VERSION,
} from '../constants.js';
import { createProxyError, fromUpstreamHttpError, isProxyError } from '../errors.js';
import type { Json } from '../types.js';
import type { ClaudeModel, ClaudeRequest } from './types.js';

export type PostMessagesOptions = {
  sessionId: string;
  betas: string[];
  signal?: AbortSignal;
};

export type ClaudeClient = {
  postMessages: (request: ClaudeRequest, options: PostMessagesOptions) => Promise<Response>;
  getModels: () => Promise<ClaudeModel[]>;
};

type ClaudeClientDeps = {
  auth: ClaudeAuthManager;
  baseUrl: string;
  credentialsPath: string;
  fetchFn?: typeof fetch;
  now?: () => number;
};

// Mirrors the official $0() at binary offset 218027148 fed by the startup normalizer T at
// 215050094 (see attribution.ts): the agent-sdk and client-app suffixes are truthy-gated, in
// that order. The workload suffix comes from an internal async context the gateway has no
// equivalent of, so the official absent-context branch applies and the suffix stays empty.
export const getClaudeUserAgent = (): string => {
  const sdk = process.env.CLAUDE_AGENT_SDK_VERSION ? `, agent-sdk/${process.env.CLAUDE_AGENT_SDK_VERSION}` : '';
  const clientApp = process.env.CLAUDE_AGENT_SDK_CLIENT_APP ? `, client-app/${process.env.CLAUDE_AGENT_SDK_CLIENT_APP}` : '';
  return `claude-cli/${CLAUDE_CLI_VERSION} (external, ${getClaudeEffectiveEntrypoint()}${sdk}${clientApp})`;
};

// OS mapper x() at binary offset 218716552 (bundled SDK 0.128.0, YT at 218715152).
export const getClaudeStainlessOs = (platform: string): string => {
  const lower = platform.toLowerCase();
  if (lower.includes('ios')) return 'iOS';
  if (lower === 'android') return 'Android';
  if (lower === 'darwin') return 'MacOS';
  if (lower === 'win32') return 'Windows';
  if (lower === 'freebsd') return 'FreeBSD';
  if (lower === 'openbsd') return 'OpenBSD';
  if (lower === 'linux') return 'Linux';
  if (lower) return `Other:${lower}`;
  return 'Unknown';
};

// Arch mapper D() at binary offset 218716552: case-sensitive comparisons, the fallback echoes
// the raw value (no lowercase step, unlike the OS mapper x()).
export const getClaudeStainlessArch = (arch: string): string => {
  if (arch === 'x32') return 'x32';
  if (arch === 'x86_64' || arch === 'x64') return 'x64';
  if (arch === 'arm') return 'arm';
  if (arch === 'aarch64' || arch === 'arm64') return 'arm64';
  if (arch) return `other:${arch}`;
  return 'unknown';
};

// te()/Djn at binary offset 218716552: the platform snapshot is computed once and cached.
// Node-only scope; the gateway never runs Deno or a browser runtime.
let stainlessPlatformHeaders: Record<string, string> | undefined;
const getStainlessPlatformHeaders = (): Record<string, string> =>
  stainlessPlatformHeaders ?? (stainlessPlatformHeaders = {
    'x-stainless-lang': 'js',
    'x-stainless-package-version': CLAUDE_SDK_VERSION,
    'x-stainless-os': getClaudeStainlessOs(process.platform ?? 'unknown'),
    'x-stainless-arch': getClaudeStainlessArch(process.arch ?? 'unknown'),
    'x-stainless-runtime': 'node',
    'x-stainless-runtime-version': process.version ?? 'unknown',
  });

export const buildClaudeHeaders = (input: {
  accessToken: string;
  sessionId?: string;
  betas?: string[];
  // buildRequest at 218990687 adds the default timeout to a COPY but calls buildHeaders with the
  // original options, so x-stainless-timeout appears only for an explicitly supplied truthy
  // timeout: Messages passes 600000 (-> 600), Models passes none.
  timeoutMs?: number;
}): Record<string, string> => {
  const headers: Record<string, string> = {
    authorization: `Bearer ${input.accessToken}`,
    // SDK buildHeaders at 218991503 start with Accept:"application/json"; the beta messages
    // resource at 218933955 keeps that default even when the body asks for stream:true.
    accept: 'application/json',
    'anthropic-version': CLAUDE_ANTHROPIC_VERSION,
    'x-app': 'cli',
    'user-agent': getClaudeUserAgent(),
    ...getStainlessPlatformHeaders(),
    // maxRetries:0 at 226673293: every send is attempt 0, including 401 recovery and each
    // Models page; the gateway adds no SDK-level retries of its own.
    'x-stainless-retry-count': '0',
    ...(input.timeoutMs ? { 'x-stainless-timeout': String(Math.trunc(input.timeoutMs / 1000)) } : {}),
    // The native client sets dangerouslyAllowBrowser (buildHeaders at 218991503).
    'anthropic-dangerous-direct-browser-access': 'true',
  };
  // references/CLIProxyAPI claudeCodeCLIBetas: CLI marker precedes the OAuth marker.
  const betas = [...new Set([
    ...(input.betas?.includes(CLAUDE_CODE_BETA) ? [CLAUDE_CODE_BETA] : []),
    CLAUDE_OAUTH_BETA,
    ...(input.betas ?? []),
  ])];
  if (betas.length > 0) headers['anthropic-beta'] = betas.join(',');
  if (input.sessionId) headers['x-claude-code-session-id'] = input.sessionId;
  return headers;
};

export const createClaudeClient = ({
  auth,
  baseUrl,
  credentialsPath,
  fetchFn = fetch,
  now = Date.now,
}: ClaudeClientDeps): ClaudeClient => {
  const loginHint = getClaudeLoginHint(credentialsPath);

  // Sends once; on 401 recovers credentials and retries once. Inference requests are never retried
  // beyond that, so a partial stream can never be duplicated.
  const sendWithAuth = async (send: (accessToken: string) => Promise<Response>): Promise<Response> => {
    let accessToken = (await auth.getCredentials()).accessToken;
    let response: Response;
    try {
      response = await send(accessToken);
      if (response.status === 401) {
        await response.body?.cancel();
        accessToken = (await auth.recoverUnauthorized(accessToken)).accessToken;
        response = await send(accessToken);
      }
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') throw error;
      if (isProxyError(error)) throw error;
      throw createProxyError({ status: 502, code: 'upstream_unreachable', message: `Upstream request failed: ${String(error)}` });
    }
    if (response.ok) return response;
    const proxyError = fromUpstreamHttpError(response.status, await response.text(), now());
    if (response.status === 401) proxyError.message = `${proxyError.message} ${loginHint}`;
    throw proxyError;
  };

  const postMessages = async (request: ClaudeRequest, options: PostMessagesOptions): Promise<Response> => {
    const body = await serializeClaudeRequest(request);
    return sendWithAuth((accessToken) =>
      fetchFn(`${baseUrl}${CLAUDE_MESSAGES_PATH}`, {
        method: 'POST',
        headers: {
          ...buildClaudeHeaders({ accessToken, sessionId: options.sessionId, betas: options.betas, timeoutMs: CLAUDE_REQUEST_TIMEOUT_MS }),
          // Mirrors references/CLIProxyAPI applyClaudeHeaders and native fetch @219095310.
          ...(new URL(baseUrl).origin === CLAUDE_BASE_URL ? { 'x-client-request-id': randomUUID() } : {}),
          'content-type': 'application/json',
        },
        body,
        // Binary offset 219078970: SDK client timeout `skr() ?? 600000`.
        signal: options.signal
          ? AbortSignal.any([options.signal, AbortSignal.timeout(CLAUDE_REQUEST_TIMEOUT_MS)])
          : AbortSignal.timeout(CLAUDE_REQUEST_TIMEOUT_MS),
      }),
    );
  };

  // Binary offset 233338777: models.list({ betas: [oauth-2025-04-20], limit: 1000 }). The SDK Page
  // at 218854348 reads `data`/`has_more`/`last_id`, so pagination stops only on `has_more` and a
  // stuck or missing cursor is an error instead of a silently shortened model list.
  const getModels = async (): Promise<ClaudeModel[]> => {
    const models: ClaudeModel[] = [];
    let afterId: string | undefined;
    for (;;) {
      const query = new URLSearchParams({ limit: String(CLAUDE_MODELS_PAGE_LIMIT) });
      if (afterId) query.set('after_id', afterId);
      const response = await sendWithAuth((accessToken) =>
        fetchFn(`${baseUrl}/v1/models?${query.toString()}`, {
          headers: buildClaudeHeaders({ accessToken }),
          signal: AbortSignal.timeout(CLAUDE_REQUEST_TIMEOUT_MS),
        }),
      );
      const body = (await response.json()) as Json;
      if (!Array.isArray(body.data)) {
        throw createProxyError({ status: 502, code: 'bad_upstream', message: 'Claude /v1/models returned no `data` array' });
      }
      for (const model of body.data) {
        if (typeof model !== 'object' || model === null || typeof (model as ClaudeModel).id !== 'string') {
          throw createProxyError({ status: 502, code: 'bad_upstream', message: 'Claude /v1/models returned a model without an `id`' });
        }
        models.push(model as ClaudeModel);
      }
      if (body.has_more !== true) return models;
      const lastId = body.last_id;
      if (typeof lastId !== 'string' || lastId === '' || lastId === afterId) {
        throw createProxyError({ status: 502, code: 'bad_upstream', message: 'Claude /v1/models pagination cursor is missing or stuck' });
      }
      afterId = lastId;
    }
  };

  return { postMessages, getModels };
};
