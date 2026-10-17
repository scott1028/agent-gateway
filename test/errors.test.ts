import { describe, expect, it } from 'vitest';
import { fromFailedEvent, fromUpstreamHttpError, toOpenAiErrorBody } from '../src/errors.js';

const NOW_MS = 1_000_000_000_000;

describe('fromUpstreamHttpError', () => {
  it('uses `detail` bodies', () => {
    const error = fromUpstreamHttpError(400, '{"detail":"Unsupported parameter: temperature"}', NOW_MS);
    expect(toOpenAiErrorBody(error)).toEqual({
      error: { message: 'Unsupported parameter: temperature', type: 'invalid_request_error', param: null, code: null },
    });
  });

  it('maps usage_limit_reached to 429 with Retry-After', () => {
    const body = JSON.stringify({ error: { type: 'usage_limit_reached', plan_type: 'plus', resets_at: NOW_MS / 1000 + 120 } });
    const error = fromUpstreamHttpError(429, body, NOW_MS);
    expect(error).toMatchObject({ status: 429, code: 'usage_limit_reached', headers: { 'retry-after': '120' } });
    expect(error.message).toContain('plan: plus');
  });

  it('maps usage_not_included and quota codes', () => {
    expect(fromUpstreamHttpError(429, '{"error":{"type":"usage_not_included"}}', NOW_MS)).toMatchObject({ status: 403 });
    expect(fromUpstreamHttpError(429, '{"error":{"code":"credit_balance_exhausted","message":"m"}}', NOW_MS)).toMatchObject({
      status: 429,
      type: 'insufficient_quota',
    });
  });

  it('falls back to raw text', () => {
    expect(fromUpstreamHttpError(502, 'bad gateway', NOW_MS)).toMatchObject({ status: 502, message: 'bad gateway', type: 'api_error' });
  });
});

describe('fromFailedEvent', () => {
  it.each([
    ['context_length_exceeded', 400],
    ['usage_not_included', 403],
    ['insufficient_quota', 429],
    ['cyber_policy', 400],
    ['server_is_overloaded', 503],
    ['slow_down', 429],
    ['something_else', 500],
  ])('maps %s to %i', (code, status) => {
    expect(fromFailedEvent({ type: 'response.failed', response: { error: { code, message: 'm' } } })).toMatchObject({ status, code });
  });

  it('reads top-level `error` events', () => {
    expect(fromFailedEvent({ type: 'error', error: { code: 'rate_limit_exceeded', message: 'slow' } })).toMatchObject({ status: 429 });
  });
});
