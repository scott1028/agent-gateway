// Claude Messages API client. Header names, conditional headers, the OAuth beta, the beta messages
// path and the models pagination mirror the pinned official release 2.1.299: Nl() at binary offset
// 219076570, subscriber auth at 218608550, models.list at 233338777, the beta messages resource at
// 218933955 and the SDK Page shape at 218854348. The User-Agent mirrors the official $0() generator
// at 218027148 (user-approved exception), and Accept mirrors the SDK buildHeaders at 218991503.
// Sources: references/claude-code @9b4f0d6 (v2.1.299-1-g9b4f0d6, public plugin code is NOT the
// full CLI transport) plus the supplemental native release 2.1.299 SHA256 2d894a4b1bfaaa9a.
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CLAUDE_CLI_VERSION } from '../../src/constants.js';
import { buildClaudeHeaders, createClaudeClient, getClaudeUserAgent } from '../../src/claude/client.js';
import type { ClaudeAuthManager } from '../../src/claude/auth.js';
import type { ClaudeModel, ClaudeRequest } from '../../src/claude/types.js';

// File-level isolation: the UA generator and attribution read these env vars, so every test in
// this file runs with them cleared; the originals are restored after the file finishes.
const CLAUDE_ENV_KEYS = ['CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_AGENT_SDK_VERSION', 'CLAUDE_AGENT_SDK_CLIENT_APP', 'CLAUDE_CODE_ACTION', 'CLAUDE_CODE_ATTRIBUTION_HEADER'] as const;
const savedUaEnv = Object.fromEntries(CLAUDE_ENV_KEYS.map((key) => [key, process.env[key]]));
for (const key of CLAUDE_ENV_KEYS) delete process.env[key];
afterAll(() => {
  for (const [key, value] of Object.entries(savedUaEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

const BASE_URL = 'https://api.anthropic.test';
const REQUEST: ClaudeRequest = { model: 'claude-opus-5', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }], max_tokens: 1024 };

const makeAuth = (overrides: Partial<ClaudeAuthManager> = {}): ClaudeAuthManager => ({
  getCredentials: async () => ({ accessToken: 'at-1' }),
  recoverUnauthorized: async () => ({ accessToken: 'at-2' }),
  ...overrides,
});

const sseResponse = (): Response =>
  new Response('event: message_stop\ndata: {"type":"message_stop"}\n\n', { status: 200, headers: { 'content-type': 'text/event-stream' } });

const setup = (fetchFn: typeof fetch, auth: ClaudeAuthManager = makeAuth()) =>
  createClaudeClient({ auth, baseUrl: BASE_URL, credentialsPath: '/tmp/ch1/.credentials.json', fetchFn });

const getRejection = async (promise: Promise<unknown>): Promise<Error & { status: number }> => {
  try {
    await promise;
  } catch (error) {
    return error as Error & { status: number };
  }
  throw new Error('expected the call to reject');
};

describe('getClaudeUserAgent', () => {
  const UA_ENV_KEYS = ['CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_AGENT_SDK_VERSION', 'CLAUDE_AGENT_SDK_CLIENT_APP', 'CLAUDE_CODE_ACTION'] as const;
  let savedEnv: Record<string, string | undefined>;

  // Mirrors the official $0() at binary offset 218027148 fed by the startup normalizer T at
  // 215050094: the agent-sdk and client-app suffixes are truthy-gated, and the order is fixed.
  beforeEach(() => {
    savedEnv = Object.fromEntries(UA_ENV_KEYS.map((key) => [key, process.env[key]]));
    for (const key of UA_ENV_KEYS) delete process.env[key];
  });
  afterEach(() => {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('builds the official default shape with the pinned reference version', () => {
    // Literal pin: an accidental constant change must fail here (AGENTS copied-values rule).
    expect(CLAUDE_CLI_VERSION).toBe('2.1.299');
    expect(getClaudeUserAgent()).toBe('claude-cli/2.1.299 (external, cli)');
  });

  it('uses CLAUDE_CODE_ENTRYPOINT when set', () => {
    process.env.CLAUDE_CODE_ENTRYPOINT = 'sdk-ts';
    expect(getClaudeUserAgent()).toBe(`claude-cli/${CLAUDE_CLI_VERSION} (external, sdk-ts)`);
  });

  it('resolves an empty CLAUDE_CODE_ENTRYPOINT to cli via the startup normalizer', () => {
    // Approved startup behavior: T at 215050094 rewrites the empty value before $0() reads it.
    process.env.CLAUDE_CODE_ENTRYPOINT = '';
    expect(getClaudeUserAgent()).toBe(`claude-cli/${CLAUDE_CLI_VERSION} (external, cli)`);
  });

  it('renames local_agent and honors the GitHub action startup branch', () => {
    process.env.CLAUDE_CODE_ENTRYPOINT = 'local_agent';
    expect(getClaudeUserAgent()).toBe(`claude-cli/${CLAUDE_CLI_VERSION} (external, local-agent)`);
    delete process.env.CLAUDE_CODE_ENTRYPOINT;
    process.env.CLAUDE_CODE_ACTION = '1';
    expect(getClaudeUserAgent()).toBe(`claude-cli/${CLAUDE_CLI_VERSION} (external, claude-code-github-action)`);
  });

  it('appends the agent-sdk suffix only when the version is truthy', () => {
    process.env.CLAUDE_AGENT_SDK_VERSION = '0.1.2';
    expect(getClaudeUserAgent()).toBe(`claude-cli/${CLAUDE_CLI_VERSION} (external, cli, agent-sdk/0.1.2)`);
    process.env.CLAUDE_AGENT_SDK_VERSION = '';
    expect(getClaudeUserAgent()).toBe(`claude-cli/${CLAUDE_CLI_VERSION} (external, cli)`);
  });

  it('appends the client-app suffix only when it is truthy', () => {
    process.env.CLAUDE_AGENT_SDK_CLIENT_APP = 'my-app';
    expect(getClaudeUserAgent()).toBe(`claude-cli/${CLAUDE_CLI_VERSION} (external, cli, client-app/my-app)`);
    process.env.CLAUDE_AGENT_SDK_CLIENT_APP = '';
    expect(getClaudeUserAgent()).toBe(`claude-cli/${CLAUDE_CLI_VERSION} (external, cli)`);
  });

  it('keeps the official suffix order when all parts are set', () => {
    process.env.CLAUDE_CODE_ENTRYPOINT = 'sdk-ts';
    process.env.CLAUDE_AGENT_SDK_VERSION = '0.1.2';
    process.env.CLAUDE_AGENT_SDK_CLIENT_APP = 'my-app';
    expect(getClaudeUserAgent()).toBe(`claude-cli/${CLAUDE_CLI_VERSION} (external, sdk-ts, agent-sdk/0.1.2, client-app/my-app)`);
  });

  it('omits the workload suffix (official absent-context branch)', () => {
    expect(getClaudeUserAgent()).not.toContain('workload');
  });
});

describe('buildClaudeHeaders', () => {
  it('sends the OAuth bearer, version, app and session headers', () => {
    const headers = buildClaudeHeaders({ accessToken: 'at-1', sessionId: 'sess-1' });
    expect(headers.authorization).toBe('Bearer at-1');
    expect(headers['anthropic-version']).toBe('2023-06-01');
    expect(headers['x-app']).toBe('cli');
    expect(headers['x-claude-code-session-id']).toBe('sess-1');
    expect(headers['anthropic-beta']).toBe('oauth-2025-04-20');
    expect(headers['user-agent']).toBe(`claude-cli/${CLAUDE_CLI_VERSION} (external, cli)`);
    // SDK buildHeaders at 218991503 start with Accept:"application/json"; the beta messages
    // resource at 218933955 keeps that default for streaming calls too.
    expect(headers.accept).toBe('application/json');
    // Attribution is a system text block (wSo at 218606801), never an HTTP header.
    expect(Object.keys(headers).join(',')).not.toContain('billing');
  });

  it('merges extra betas without duplicating them', () => {
    expect(buildClaudeHeaders({ accessToken: 'at-1', betas: ['interleaved-thinking-2025-05-14', 'oauth-2025-04-20'] })['anthropic-beta']).toBe(
      'oauth-2025-04-20,interleaved-thinking-2025-05-14',
    );
  });

  it('omits the session header when there is no session', () => {
    expect('x-claude-code-session-id' in buildClaudeHeaders({ accessToken: 'at-1' })).toBe(false);
  });
});

describe('postMessages', () => {
  it('posts the streaming request to the beta messages path', async () => {
    const fetchFn = vi.fn<typeof fetch>(async () => sseResponse());
    await setup(fetchFn).postMessages({ ...REQUEST, stream: true }, { sessionId: 'sess-1', betas: ['interleaved-thinking-2025-05-14'] });
    const [url, init] = fetchFn.mock.calls[0] ?? [];
    // The beta resource at 218933955 posts /v1/messages?beta=true; the main inference call sets
    // stream:true in the body (226675303).
    expect(url).toBe(`${BASE_URL}/v1/messages?beta=true`);
    expect(init?.method).toBe('POST');
    const headers = init?.headers as Record<string, string>;
    // The official SDK keeps Accept:"application/json" (218991503) even for stream:true bodies.
    expect(headers.accept).toBe('application/json');
    expect(headers['content-type']).toBe('application/json');
    expect(headers['user-agent']).toBe(`claude-cli/${CLAUDE_CLI_VERSION} (external, cli)`);
    // buildRequest at 218990687: the Messages call supplies the timeout explicitly, so the
    // header carries trunc(600000/1000); the retry count stays 0 (maxRetries:0 at 226673293).
    expect(headers['x-stainless-timeout']).toBe('600');
    expect(headers['x-stainless-retry-count']).toBe('0');
    expect(headers['anthropic-beta']).toBe('oauth-2025-04-20,interleaved-thinking-2025-05-14');
    expect(JSON.parse(String(init?.body))).toEqual({ ...REQUEST, stream: true });
  });

  it('recovers once from a 401 and never retries a second time', async () => {
    const auth = makeAuth();
    const recover = vi.spyOn(auth, 'recoverUnauthorized');
    const fetchFn = vi.fn<typeof fetch>(async () => new Response('{"type":"error"}', { status: 401 }));
    const error = await getRejection(setup(fetchFn, auth).postMessages(REQUEST, { sessionId: 's', betas: [] }));
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(recover).toHaveBeenCalledWith('at-1');
    expect(error.status).toBe(401);
    expect(error.message).toContain('CLAUDE_CONFIG_DIR=/tmp/ch1');
  });

  it('retries once with the refreshed token and succeeds', async () => {
    const responses = [new Response('{"type":"error"}', { status: 401 }), sseResponse()];
    const fetchFn = vi.fn<typeof fetch>(async () => responses.shift() ?? sseResponse());
    const response = await setup(fetchFn).postMessages(REQUEST, { sessionId: 's', betas: [] });
    expect(response.status).toBe(200);
    const secondHeaders = fetchFn.mock.calls[1]?.[1]?.headers as Record<string, string>;
    expect(secondHeaders.authorization).toBe('Bearer at-2');
    // The 401 recovery is a fresh send, not an SDK retry: the retry-count header stays 0.
    expect(secondHeaders['x-stainless-retry-count']).toBe('0');
  });

  it('maps upstream failures to OpenAI-shaped errors', async () => {
    const fetchFn = vi.fn<typeof fetch>(async () => new Response('{"error":{"type":"rate_limit_error","message":"slow down"}}', { status: 429 }));
    const error = await getRejection(setup(fetchFn).postMessages(REQUEST, { sessionId: 's', betas: [] }));
    expect(error.status).toBe(429);
  });

  it('reports an unreachable upstream as a 502', async () => {
    const fetchFn = vi.fn<typeof fetch>(async () => {
      throw new TypeError('fetch failed');
    });
    const error = await getRejection(setup(fetchFn).postMessages(REQUEST, { sessionId: 's', betas: [] }));
    expect(error.status).toBe(502);
    expect(error.message).toContain('Upstream request failed');
  });
});

describe('getModels', () => {
  it('requests the official page size and follows has_more/last_id', async () => {
    const pages = [
      { data: [{ type: 'model', id: 'claude-opus-5' }], has_more: true, last_id: 'claude-opus-5' },
      { data: [{ type: 'model', id: 'claude-sonnet-5' }], has_more: false, last_id: 'claude-sonnet-5' },
    ];
    const fetchFn = vi.fn<typeof fetch>(async (input: Parameters<typeof fetch>[0]) => {
      const page = String(input).includes('after_id=') ? pages[1] : pages[0];
      return new Response(JSON.stringify(page), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    const models = await setup(fetchFn).getModels();
    expect(models.map((model) => model.id)).toEqual(['claude-opus-5', 'claude-sonnet-5']);
    const firstUrl = String(fetchFn.mock.calls[0]?.[0]);
    expect(firstUrl).toBe(`${BASE_URL}/v1/models?limit=1000`);
    expect(String(fetchFn.mock.calls[1]?.[0])).toBe(`${BASE_URL}/v1/models?limit=1000&after_id=claude-opus-5`);
    const firstHeaders = fetchFn.mock.calls[0]?.[1]?.headers as Record<string, string>;
    expect(firstHeaders['anthropic-beta']).toBe('oauth-2025-04-20');
    // Models calls share the same builder: official UA and the SDK's JSON Accept default.
    expect(firstHeaders['user-agent']).toBe(`claude-cli/${CLAUDE_CLI_VERSION} (external, cli)`);
    expect(firstHeaders.accept).toBe('application/json');
    // Models.list passes no explicit timeout, so the SDK omits x-stainless-timeout even though
    // the transport still enforces its own deadline; every page is a fresh send at retry 0.
    expect(firstHeaders['x-stainless-timeout']).toBeUndefined();
    expect(firstHeaders['x-stainless-retry-count']).toBe('0');
    const secondHeaders = fetchFn.mock.calls[1]?.[1]?.headers as Record<string, string>;
    expect(secondHeaders['x-stainless-timeout']).toBeUndefined();
    expect(secondHeaders['x-stainless-retry-count']).toBe('0');
  });

  it('keeps paginating past ten pages while has_more stays true', async () => {
    // The SDK Page at 218854348 has no page cap, so a long catalog is not silently truncated.
    const fetchFn = vi.fn<typeof fetch>(async (input: Parameters<typeof fetch>[0]) => {
      const after = new URL(String(input)).searchParams.get('after_id');
      const index = after === null ? 0 : Number(after.replace('m', ''));
      const id = `m${index + 1}`;
      const hasMore = index < 10;
      return new Response(JSON.stringify({ data: [{ type: 'model', id }], has_more: hasMore, last_id: id }), { status: 200 });
    });
    const models = await setup(fetchFn).getModels();
    expect(fetchFn).toHaveBeenCalledTimes(11);
    expect(models).toHaveLength(11);
  });

  it('fails instead of returning a short list when the cursor repeats', async () => {
    const fetchFn = vi.fn<typeof fetch>(async () =>
      new Response(JSON.stringify({ data: [{ type: 'model', id: 'a' }], has_more: true, last_id: 'a' }), { status: 200 }),
    );
    const error = await getRejection(setup(fetchFn).getModels());
    expect(error.status).toBe(502);
    expect(error.message).toContain('pagination cursor');
  });

  it('fails when has_more is true but no cursor is given', async () => {
    const fetchFn = vi.fn<typeof fetch>(async () =>
      new Response(JSON.stringify({ data: [{ type: 'model', id: 'a' }], has_more: true, last_id: null }), { status: 200 }),
    );
    await expect(setup(fetchFn).getModels()).rejects.toThrow('pagination cursor');
  });

  it('fails when the response has no data array or a model without an id', async () => {
    const noData = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ has_more: false }), { status: 200 }));
    await expect(setup(noData).getModels()).rejects.toThrow('no `data` array');
    const noId = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ data: [{ type: 'model' }], has_more: false }), { status: 200 }));
    await expect(setup(noId).getModels()).rejects.toThrow('without an `id`');
  });

  it('surfaces a catalog failure as an error the caller can isolate', async () => {
    const fetchFn = vi.fn<typeof fetch>(async () => new Response('{}', { status: 500 }));
    await expect(setup(fetchFn).getModels()).rejects.toThrow();
  });
});

describe('Claude model catalog', () => {
  it('caches the live list and finds models by id', async () => {
    const { createClaudeModelCatalog } = await import('../../src/claude/models.js');
    const getModels = vi.fn<() => Promise<ClaudeModel[]>>().mockResolvedValue([{ id: 'claude-opus-5', max_tokens: 128000 }]);
    const catalog = createClaudeModelCatalog({ getModels });
    expect((await catalog.findModel('claude-opus-5'))?.max_tokens).toBe(128000);
    await catalog.listModels();
    expect(getModels).toHaveBeenCalledTimes(1);
  });

  it('keeps serving requests when the catalog lookup fails', async () => {
    const { createClaudeModelCatalog } = await import('../../src/claude/models.js');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const catalog = createClaudeModelCatalog({ getModels: async () => Promise.reject(new Error('down')) as never });
    expect(await catalog.findModel('claude-opus-5')).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('catalog lookup failed'));
  });
});
