import type { AuthManager } from '../auth/authManager.js';
import { getLoginHint } from '../auth/authManager.js';
import { createProxyError, fromUpstreamHttpError, isProxyError } from '../errors.js';
import type { CodexModel, Config, Credentials, ResponsesRequest } from '../types.js';
import { buildUpstreamHeaders, getUserAgent } from './headers.js';

export type PostResponsesOptions = {
  sessionId: string;
  isResponsesLite: boolean;
  turnState?: string;
  signal?: AbortSignal;
};

export type CodexClient = {
  postResponses: (request: ResponsesRequest, options: PostResponsesOptions) => Promise<Response>;
  getModels: () => Promise<CodexModel[]>;
};

type CodexClientDeps = {
  auth: AuthManager;
  config: Config;
  authPath: string;
  fetchFn?: typeof fetch;
  now?: () => number;
};

export const createCodexClient = ({ auth, config, authPath, fetchFn = fetch, now = Date.now }: CodexClientDeps): CodexClient => {
  const userAgent = getUserAgent(config.clientVersion);

  // Sends once; on 401 recovers credentials and retries once. Non-2xx becomes a ProxyError.
  const sendWithAuth = async (send: (credentials: Credentials) => Promise<Response>): Promise<Response> => {
    let credentials = await auth.getCredentials();
    let response: Response;
    try {
      response = await send(credentials);
      if (response.status === 401) {
        await response.body?.cancel();
        credentials = await auth.recoverUnauthorized(credentials.accessToken);
        response = await send(credentials);
      }
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') throw error;
      if (isProxyError(error)) throw error;
      throw createProxyError({ status: 502, code: 'upstream_unreachable', message: `Upstream request failed: ${String(error)}` });
    }
    if (response.ok) return response;
    const proxyError = fromUpstreamHttpError(response.status, await response.text(), now());
    if (response.status === 401) proxyError.message = `${proxyError.message} ${getLoginHint(authPath)}`;
    throw proxyError;
  };

  const postResponses = (request: ResponsesRequest, options: PostResponsesOptions): Promise<Response> =>
    sendWithAuth((credentials) =>
      fetchFn(`${config.baseUrl}/responses`, {
        method: 'POST',
        headers: {
          ...buildUpstreamHeaders({
            credentials,
            clientVersion: config.clientVersion,
            userAgent,
            sessionId: options.sessionId,
            isResponsesLite: options.isResponsesLite,
            turnState: options.turnState,
          }),
          accept: 'text/event-stream',
          'content-type': 'application/json',
        },
        body: JSON.stringify(request),
        signal: options.signal,
      }),
    );

  const getModels = async (): Promise<CodexModel[]> => {
    const response = await sendWithAuth((credentials) =>
      fetchFn(`${config.baseUrl}/models?client_version=${encodeURIComponent(config.clientVersion)}`, {
        headers: buildUpstreamHeaders({ credentials, clientVersion: config.clientVersion, userAgent }),
        signal: AbortSignal.timeout(60_000),
      }),
    );
    const body = (await response.json()) as { models?: CodexModel[] };
    return body.models ?? [];
  };

  return { postResponses, getModels };
};
