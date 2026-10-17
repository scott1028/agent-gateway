import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDebugFetch, getDebugPrefix, getDebugSeparator } from '../../src/utils/debugFetch.js';

// Project-owned debug tool: levels 0/2 print the request line only; levels 1/3 add headers and
// bodies, each hop opening with a blank line plus separator. Every line carries a UTC timestamp.
// There is no counterpart for this in references/codex.

const FIXED_TIME = '2026-10-15T11:56:40Z';
const PREFIX = `[debug:${FIXED_TIME}]`;
const SEPARATOR = `\n${PREFIX} ${'─'.repeat(40)}`;
const TIME_PREFIX_PATTERN = /^\[debug:\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z\]/;

const makeDebugFetch = (alias: string, lines: string[], debugLevel?: 0 | 1 | 2 | 3): typeof fetch =>
  createDebugFetch({ alias, debugLevel, fetchFn: async () => new Response('{}'), log: (message) => lines.push(message) });

const flushLogs = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

describe('debug prefix and separator', () => {
  it('prefixes with the current UTC time to the second', () => {
    expect(getDebugPrefix()).toMatch(/^\[debug:\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z\]$/);
  });

  it('opens a hop with a blank line and 40 box-drawing dashes', () => {
    expect(getDebugSeparator()).toMatch(/^\n\[debug:\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z\] ─{40}$/);
  });
});

describe('createDebugFetch', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(FIXED_TIME));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('passes the same input and init references to fetchFn', async () => {
    const calls: Array<{ input: Parameters<typeof fetch>[0]; init?: RequestInit }> = [];
    const debugFetch = createDebugFetch({
      alias: 'codex1',
      fetchFn: async (input, init) => {
        calls.push({ input, init });
        return new Response('{}');
      },
      log: () => undefined,
    });
    const init: RequestInit = { method: 'POST', headers: { accept: 'text/event-stream' } };
    await debugFetch('https://example.test/responses', init);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.input).toBe('https://example.test/responses');
    expect(calls[0]?.init).toBe(init);
  });

  it.each([undefined, 0, 2] as const)('prints only the method and URL at level %s', async (debugLevel) => {
    const lines: string[] = [];
    const debugFetch = makeDebugFetch('codex2', lines, debugLevel);
    await debugFetch('https://example.test/responses', {
      method: 'POST',
      headers: { originator: 'codex_cli_rs', 'content-type': 'application/json' },
      body: '{"input":"private prompt"}',
    });
    await flushLogs();
    expect(lines).toEqual([`${PREFIX} codex2 POST https://example.test/responses`]);
    expect(lines.join('\n')).not.toContain('─');
    expect(lines[0]).toMatch(TIME_PREFIX_PATTERN);
  });

  it.each([1, 3] as const)('prints the alias, method, URL, and every header at level %s', async (debugLevel) => {
    const lines: string[] = [];
    const debugFetch = makeDebugFetch('codex2', lines, debugLevel);
    await debugFetch('https://example.test/responses', {
      method: 'POST',
      headers: { originator: 'codex_cli_rs', 'content-type': 'application/json' },
    });
    expect(lines.slice(0, 4)).toEqual([
      SEPARATOR,
      `${PREFIX} codex2 POST https://example.test/responses`,
      `${PREFIX}   content-type: application/json`,
      `${PREFIX}   originator: codex_cli_rs`,
    ]);
    const responseLine = `${PREFIX} codex2 upstream POST https://example.test/responses response 200`;
    expect(lines).toContain(responseLine);
    expect(lines[lines.indexOf(responseLine) - 1]).toBe(SEPARATOR);
  });

  it('masks the authorization value and never prints the token', async () => {
    const lines: string[] = [];
    const debugFetch = makeDebugFetch('codex1', lines, 1);
    await debugFetch('https://example.test/responses', { method: 'POST', headers: { authorization: 'Bearer eyJhbGciOi.s3cr3t.payload' } });
    await debugFetch('https://example.test/responses', { method: 'POST', headers: { authorization: 's3cr3t-schemeless' } });
    expect(lines).toContain(`${PREFIX}   authorization: Bearer ***`);
    expect(lines).toContain(`${PREFIX}   authorization: ***`);
    expect(lines.join('\n')).not.toContain('s3cr3t');
  });

  it('prints GET when init has no method', async () => {
    const lines: string[] = [];
    const debugFetch = makeDebugFetch('codex1', lines);
    await debugFetch('https://example.test/models');
    expect(lines[0]).toBe(`${PREFIX} codex1 GET https://example.test/models`);
  });

  it('prints the headers carried by a Request input', async () => {
    const lines: string[] = [];
    const debugFetch = makeDebugFetch('codex1', lines, 1);
    const request = new Request('https://example.test/responses', {
      method: 'POST',
      headers: { authorization: 'Bearer s3cr3t', originator: 'codex_cli_rs' },
    });
    await debugFetch(request);
    expect(lines).toContain(`${PREFIX}   authorization: Bearer ***`);
    expect(lines).toContain(`${PREFIX}   originator: codex_cli_rs`);
    expect(lines.join('\n')).not.toContain('s3cr3t');
  });
});

// Project-owned logging, not an upstream protocol change. Payload fields correspond to
// references/codex/codex-rs/codex-api/src/common.rs @0d58012ec2 and Claude Messages;
// references/claude-code @9b4f0d6 does not include the CLI transport source.
describe('debug level 1/3 upstream bodies', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(FIXED_TIME));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it.each([
    {
      alias: 'codex1',
      url: 'https://chatgpt.com/backend-api/codex/responses',
      body: {
        model: 'gpt-x',
        instructions: 'Follow the system instructions.',
        input: [
          { role: 'developer', content: 'Use Traditional Chinese.' },
          { role: 'user', content: 'Read the file.\nKeep every line.' },
          { type: 'function_call_output', call_id: 'call-1', output: 'file contents' },
        ],
        tools: [{ type: 'function', name: 'read_file', description: 'Read a file.', parameters: { type: 'object' } }],
      },
    },
    {
      alias: 'claude1',
      url: 'https://api.anthropic.com/v1/messages?beta=true',
      body: {
        model: 'claude-sonnet-5',
        system: [{ type: 'text', text: 'You are a coding assistant.', cache_control: { type: 'ephemeral' } }],
        messages: [{ role: 'user', content: [{ type: 'text', text: 'Read the file.' }] }],
        tools: [{ name: 'read_file', description: 'Read a file.', input_schema: { type: 'object' } }],
      },
    },
  ])('prints the complete $alias body without changing the request or response', async ({ alias, url, body }) => {
    const log = vi.fn();
    const response = new Response('{}');
    const fetchFn = vi.fn<typeof fetch>(async () => response);
    const debugFetch = createDebugFetch({ alias, debugLevel: 1, fetchFn, log });
    const init = {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer secret-token' },
      body: JSON.stringify(body),
    };
    expect(await debugFetch(url, init)).toBe(response);
    expect(log).toHaveBeenCalledWith(`${PREFIX} ${alias} upstream POST ${url} body:\n${JSON.stringify(body, null, 2)}`);
    expect(log).toHaveBeenCalledWith(`${PREFIX}   authorization: Bearer ***`);
    expect(log.mock.calls.flat().join('\n')).not.toContain('secret-token');
    expect(fetchFn.mock.calls[0]?.[0]).toBe(url);
    expect(fetchFn.mock.calls[0]?.[1]).toBe(init);
  });

  it.each([1, 3] as const)('prints the response status, headers, and indented JSON body at level %s', async (debugLevel) => {
    const log = vi.fn();
    const payload = { id: 'resp-1', status: 'completed' };
    const response = new Response(JSON.stringify(payload), { headers: { 'x-oai-request-id': 'req-1' } });
    const debugFetch = createDebugFetch({ alias: 'codex1', debugLevel, fetchFn: async () => response, log });
    const returned = await debugFetch('https://example.test/responses', { method: 'POST', body: '{"input":"prompt"}' });
    expect(await returned.json()).toEqual(payload);
    await flushLogs();
    expect(log).toHaveBeenCalledWith(`${PREFIX} codex1 upstream POST https://example.test/responses response 200`);
    expect(log).toHaveBeenCalledWith(`${PREFIX}   x-oai-request-id: req-1`);
    expect(log).toHaveBeenCalledWith(`${PREFIX} codex1 upstream POST https://example.test/responses response body:\n${JSON.stringify(payload, null, 2)}`);
    const calls = log.mock.calls.flat() as string[];
    const responseIndex = calls.indexOf(`${PREFIX} codex1 upstream POST https://example.test/responses response 200`);
    expect(calls[responseIndex - 1]).toBe(SEPARATOR);
  });

  it('keeps SSE response bodies raw and leaves the streamed response readable', async () => {
    const log = vi.fn();
    const sse = 'event: response.created\ndata: {"type":"response.created"}\n\nevent: response.completed\ndata: {"type":"response.completed"}\n\n';
    const response = new Response(sse, { headers: { 'content-type': 'text/event-stream' } });
    const debugFetch = createDebugFetch({ alias: 'codex1', debugLevel: 1, fetchFn: async () => response, log });
    const returned = await debugFetch('https://example.test/responses', { method: 'POST', body: '{"input":"prompt"}' });
    expect(await returned.text()).toBe(sse);
    await flushLogs();
    expect(log).toHaveBeenCalledWith(`${PREFIX} codex1 upstream POST https://example.test/responses response body:\n${sse}`);
    expect(log).toHaveBeenCalledWith(`${PREFIX}   content-type: text/event-stream`);
  });

  it.each([undefined, 0, 2] as const)('keeps bodies and response details hidden at level %s', async (debugLevel) => {
    const log = vi.fn();
    const debugFetch = createDebugFetch({ alias: 'codex1', debugLevel, log, fetchFn: async () => new Response('{}') });
    await debugFetch('https://example.test/responses', { method: 'POST', body: '{"input":"private prompt"}' });
    await flushLogs();
    expect(log.mock.calls).toEqual([[`${PREFIX} codex1 POST https://example.test/responses`]]);
  });

  it.each([
    'https://auth.openai.com/oauth/token',
    'https://platform.claude.com/v1/oauth/token',
    'https://example.test/models',
  ])('never prints non-inference bodies at %s', async (url) => {
    const log = vi.fn();
    const debugFetch = createDebugFetch({ alias: 'codex1', debugLevel: 3, log, fetchFn: async () => new Response('{"access_token":"secret-new-token"}') });
    await debugFetch(url, {
      method: 'POST',
      body: JSON.stringify({ refresh_token: 'secret-refresh-token', client_id: 'client' }),
    });
    await flushLogs();
    const logged = log.mock.calls.flat().join('\n');
    expect(logged).toContain(`${PREFIX} codex1 POST ${url}`);
    expect(logged).not.toContain('body:');
    expect(logged).not.toContain('secret');
  });

  it('reads a Request clone and leaves the original body available to fetch', async () => {
    const log = vi.fn();
    const body = { input: '完整 prompt\n'.repeat(2000) };
    const request = new Request('https://example.test/responses', { method: 'POST', body: JSON.stringify(body) });
    const fetchFn = vi.fn<typeof fetch>(async (input) => {
      expect(input).toBe(request);
      expect(request.bodyUsed).toBe(false);
      expect(await request.json()).toEqual(body);
      return new Response('{}');
    });
    await createDebugFetch({ alias: 'codex1', debugLevel: 1, log, fetchFn })(request);
    expect(log).toHaveBeenCalledWith(`${PREFIX} codex1 upstream POST ${request.url} body:\n${JSON.stringify(body, null, 2)}`);
    expect(fetchFn).toHaveBeenCalledOnce();
  });

  it('logs an init body override without reading the Request body', async () => {
    const log = vi.fn();
    const request = new Request('https://example.test/responses', { method: 'POST', body: '{"input":"original"}' });
    const fetchFn = vi.fn<typeof fetch>(async () => new Response('{}'));
    const init = { body: '{"input":"override"}' };
    await createDebugFetch({ alias: 'codex1', debugLevel: 1, log, fetchFn })(request, init);
    expect(log).toHaveBeenCalledWith(`${PREFIX} codex1 upstream POST ${request.url} body:\n{\n  "input": "override"\n}`);
    expect(request.bodyUsed).toBe(false);
    expect(fetchFn.mock.calls[0]?.[1]).toBe(init);
  });

  it('forwards non-JSON bodies unchanged', async () => {
    const log = vi.fn();
    const fetchFn = vi.fn<typeof fetch>(async () => new Response('{}'));
    const init = { method: 'POST', body: 'not JSON' };
    await createDebugFetch({ alias: 'codex1', debugLevel: 1, log, fetchFn })('https://example.test/responses', init);
    expect(log).toHaveBeenCalledWith(`${PREFIX} codex1 upstream POST https://example.test/responses body:\nnot JSON`);
    expect(fetchFn.mock.calls[0]?.[1]).toBe(init);
  });

  it('does not produce an unhandled rejection when the response stream aborts mid-stream', async () => {
    const log = vi.fn();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: partial\n\n'));
        controller.error(new Error('upstream aborted mid-stream'));
      },
    });
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);
    try {
      const returned = await createDebugFetch({ alias: 'codex1', debugLevel: 1, fetchFn: async () => new Response(stream), log })
        ('https://example.test/responses', { method: 'POST', body: '{"input":"prompt"}' });
      await expect(returned.text()).rejects.toThrow('upstream aborted mid-stream');
      await flushLogs();
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
    expect(unhandled).toEqual([]);
  });
});
