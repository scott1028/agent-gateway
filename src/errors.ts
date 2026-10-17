import type { AnthropicErrorBody, Json, OpenAiErrorBody, ResponsesEvent } from './types.js';

export type ProxyError = Error & {
  status: number;
  type: string;
  code?: string;
  headers?: Record<string, string>;
};

const QUOTA_CODES = [
  'insufficient_quota',
  'credit_balance_exhausted',
  'organization_spend_limit_exceeded',
  'project_spend_limit_exceeded',
  'organization_usage_limit_exceeded',
];
const POLICY_CODES = ['cyber_policy', 'bio_policy', 'misalignment_policy_violation', 'invalid_prompt'];

const getErrorType = (status: number): string => {
  if (status === 401) return 'authentication_error';
  if (status === 403) return 'permission_error';
  if (status === 404) return 'not_found_error';
  if (status === 429) return 'rate_limit_error';
  return status >= 400 && status < 500 ? 'invalid_request_error' : 'api_error';
};

export const createProxyError = (input: {
  status: number;
  message: string;
  type?: string;
  code?: string;
  headers?: Record<string, string>;
}): ProxyError =>
  Object.assign(new Error(input.message), {
    status: input.status,
    type: input.type ?? getErrorType(input.status),
    code: input.code,
    headers: input.headers,
  });

export const isProxyError = (error: unknown): error is ProxyError =>
  error instanceof Error && typeof (error as ProxyError).status === 'number';

export const toOpenAiErrorBody = (error: ProxyError): OpenAiErrorBody => ({
  error: { message: error.message, type: error.type, param: null, code: error.code ?? null },
});

// The native Claude relay answers its own errors in the Messages API shape Claude Code reads.
export const toAnthropicErrorBody = (error: ProxyError): AnthropicErrorBody => ({
  type: 'error',
  error: { type: error.type, message: error.message },
});

const parseJson = (text: string): Json | undefined => {
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === 'object' && parsed !== null ? (parsed as Json) : undefined;
  } catch {
    return undefined;
  }
};

const getUsageLimitError = (error: Json, nowMs: number): ProxyError => {
  const resetsAtSeconds = typeof error.resets_at === 'number' ? error.resets_at : undefined;
  const retryAfterSeconds =
    resetsAtSeconds === undefined ? undefined : Math.max(0, Math.ceil(resetsAtSeconds - nowMs / 1000));
  const planText = typeof error.plan_type === 'string' ? ` (plan: ${error.plan_type})` : '';
  const resetText =
    resetsAtSeconds === undefined ? '' : ` Resets at ${new Date(resetsAtSeconds * 1000).toISOString()}.`;
  return createProxyError({
    status: 429,
    type: 'rate_limit_error',
    code: 'usage_limit_reached',
    message: `ChatGPT usage limit reached${planText}.${resetText}`,
    headers: retryAfterSeconds === undefined ? undefined : { 'retry-after': String(retryAfterSeconds) },
  });
};

// Backend error bodies come as `{detail}` (validation, auth) or `{error:{type,code,message}}`.
export const fromUpstreamHttpError = (status: number, bodyText: string, nowMs: number): ProxyError => {
  const body = parseJson(bodyText);
  const upstreamError = typeof body?.error === 'object' && body.error !== null ? (body.error as Json) : undefined;
  const errorType = typeof upstreamError?.type === 'string' ? upstreamError.type : undefined;
  const errorCode = typeof upstreamError?.code === 'string' ? upstreamError.code : undefined;
  const message =
    (typeof body?.detail === 'string' && body.detail) ||
    (typeof upstreamError?.message === 'string' && upstreamError.message) ||
    bodyText.slice(0, 2000) ||
    `Upstream returned HTTP ${status}`;

  if (upstreamError && errorType === 'usage_limit_reached') return getUsageLimitError(upstreamError, nowMs);
  if (errorType === 'usage_not_included' || errorCode === 'usage_not_included') {
    return createProxyError({
      status: 403,
      code: 'usage_not_included',
      message: 'Your ChatGPT plan does not include Codex usage.',
    });
  }
  if (errorType === 'insufficient_quota' || (errorCode && QUOTA_CODES.includes(errorCode))) {
    return createProxyError({ status: 429, type: 'insufficient_quota', code: errorCode ?? errorType, message });
  }
  return createProxyError({ status, message, code: errorCode ?? errorType });
};

// Maps `response.failed` / `error` stream events (codex-api/src/sse/responses_error.rs).
export const fromFailedEvent = (event: ResponsesEvent): ProxyError => {
  const response = event.response as Json | undefined;
  const error = ((response?.error ?? event.error) ?? {}) as Json;
  const code = typeof error.code === 'string' ? error.code : undefined;
  const message = typeof error.message === 'string' && error.message ? error.message : 'Upstream response failed';
  if (code === 'context_length_exceeded') return createProxyError({ status: 400, code, message });
  if (code === 'usage_not_included') return createProxyError({ status: 403, code, message });
  if (code && QUOTA_CODES.includes(code)) {
    return createProxyError({ status: 429, type: 'insufficient_quota', code, message });
  }
  if (code && POLICY_CODES.includes(code)) return createProxyError({ status: 400, code, message });
  if (code === 'server_is_overloaded') return createProxyError({ status: 503, code, message });
  if (code === 'rate_limit_exceeded' || code === 'slow_down') return createProxyError({ status: 429, code, message });
  return createProxyError({ status: 500, code, message });
};
