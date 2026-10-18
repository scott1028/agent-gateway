// Mirrors references/CLIProxyAPI v8.0.29 internal/runtime/executor/claude_executor_request.go
// and native Claude Code 2.1.299 SL @217935458, fetch wrapper @219095310.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildClaudeHeaders, createClaudeClient } from '../../src/claude/client.js';
import { prepareClaudeRequest } from '../../src/claude/normalizeRequest.js';
import { findClaudeModelMetadata } from '../../src/claude/modelMetadata.js';

afterEach(() => vi.unstubAllEnvs());

const getBetas = (modelId: string): string => {
  const { betas } = prepareClaudeRequest({
    body: { input: 'hi' }, modelId, alias: 'claude1', metadata: findClaudeModelMetadata(modelId), settings: {},
  });
  return buildClaudeHeaders({ accessToken: 'test', betas })['anthropic-beta']!;
};

describe('subscription request defaults', () => {
  it('includes the native subscription beta baseline in wire order', () => {
    vi.stubEnv('CLAUDE_CODE_ENTRYPOINT', 'cli');
    expect(getBetas('claude-opus-5')).toBe([
      'claude-code-20250219', 'oauth-2025-04-20', 'interleaved-thinking-2025-05-14',
      'redact-thinking-2026-02-12', 'thinking-token-count-2026-05-13',
      'context-management-2025-06-27', 'prompt-caching-scope-2026-01-05', 'effort-2025-11-24',
    ].join(','));
  });

  it('keeps capability gates for legacy models and noninteractive thinking visibility', () => {
    vi.stubEnv('CLAUDE_CODE_ENTRYPOINT', 'cli');
    expect(getBetas('claude-3-5-haiku')).toBe('oauth-2025-04-20,prompt-caching-scope-2026-01-05');
    vi.stubEnv('CLAUDE_CODE_ENTRYPOINT', 'sdk-cli');
    expect(getBetas('claude-opus-5')).not.toContain('redact-thinking-2026-02-12');
    expect(getBetas('claude-opus-5')).toContain('thinking-token-count-2026-05-13');
  });

  it('gives each first-party send a fresh request UUID, including a 401 retry', async () => {
    const sent: Headers[] = [];
    const client = createClaudeClient({
      baseUrl: 'https://api.anthropic.com', credentialsPath: '/unused/.credentials.json',
      auth: { getCredentials: async () => ({ accessToken: 'test' }), recoverUnauthorized: async () => ({ accessToken: 'renewed' }) },
      fetchFn: vi.fn<typeof fetch>(async (_url, init) => {
        sent.push(new Headers(init?.headers));
        return new Response('', { status: sent.length === 1 ? 401 : 200 });
      }),
    });
    await client.postMessages({ model: 'claude-opus-5', messages: [], max_tokens: 1 }, { sessionId: 'conversation', betas: [] });
    const ids = sent.map((headers) => headers.get('x-client-request-id'));
    for (const id of ids) expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(new Set(ids).size).toBe(2);
    expect(sent.every((headers) => headers.get('x-claude-code-session-id') === 'conversation')).toBe(true);
  });
});
