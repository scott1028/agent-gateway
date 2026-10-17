// Native Claude Code relay on POST /v1/messages. Matches the native 2.1.302 release (billing
// builder GPo at offset 237985931, first-party gate xi at 235237156, SDK client with custom
// headers at 238472365) and the client detection in references/CLIProxyAPI v8.0.29
// internal/runtime/executor/helps/claude_client_detection.go. Fixtures keep the header and body
// shape of a 2.1.302 subscriber capture; every id, token and text in them is fake. Relay tests are
// wire-level: a loopback upstream records exactly what the gateway put on the socket.
import { createServer, type IncomingMessage, request, type Server, type ServerResponse } from 'node:http';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { type AddressInfo, connect } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClaudeAccount } from '../../src/accounts.js';
import { type ClaudeAuthManager, createClaudeAuthManager } from '../../src/claude/auth.js';
import { createClaudeClient } from '../../src/claude/client.js';
import { createClaudeModelCatalog } from '../../src/claude/models.js';
import { getClaudeRelayRequest } from '../../src/claude/relayMessages.js';
import { createClaudeStateStore } from '../../src/claude/state.js';
import { CLAUDE_RELAY_SESSION_MAX_ENTRIES } from '../../src/constants.js';
import { createProxyServer } from '../../src/server.js';
import type { Json } from '../../src/types.js';
import { readFixture } from '../helpers.js';

const ACCOUNT_UUID = '11111111-2222-4333-8444-555555555555';
const OTHER_ACCOUNT_UUID = '99999999-8888-4777-8666-555555555555';
const FIXTURE_REQUEST = JSON.parse(readFixture('claude-relay-request.json')) as { path: string; headers: Record<string, string> };
const FIXTURE_BODY = readFixture('claude-relay-body.json');
const FIXTURE_RAW_HEADERS = Object.entries(FIXTURE_REQUEST.headers).flat();
const SSE_TEXT = readFixture('claude-text.sse');
const HOP_BY_HOP_RESPONSE_HEADERS = ['connection', 'keep-alive', 'transfer-encoding'];

// Sets (or with undefined removes) headers in a rawHeaders list, keeping every other position.
const withRawHeaders = (rawHeaders: string[], changes: Record<string, string | undefined>): string[] => {
  const result: string[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < rawHeaders.length; index += 2) {
    const name = rawHeaders[index] ?? '';
    const lowerName = name.toLowerCase();
    // Own properties only: a header named `constructor` must not match Object.prototype.
    if (!Object.hasOwn(changes, lowerName)) {
      result.push(name, rawHeaders[index + 1] ?? '');
      continue;
    }
    seen.add(lowerName);
    const headerValue = changes[lowerName];
    if (headerValue !== undefined) result.push(name, headerValue);
  }
  for (const [name, headerValue] of Object.entries(changes)) {
    if (!seen.has(name) && headerValue !== undefined) result.push(name, headerValue);
  }
  return result;
};

const fakeAuth = (alias: string): ClaudeAuthManager => ({
  getCredentials: async () => ({ accessToken: `${alias}-token` }),
  recoverUnauthorized: async () => ({ accessToken: `${alias}-token-2` }),
});

const makeAccount = (alias: string, homePath: string, baseUrl = 'http://127.0.0.1:1', auth = fakeAuth(alias)): ClaudeAccount => ({
  provider: 'claude',
  alias,
  homePath,
  settingsPath: path.join(homePath, 'settings.json'),
  client: createClaudeClient({ auth, baseUrl, credentialsPath: path.join(homePath, '.credentials.json') }),
  catalog: createClaudeModelCatalog({ getModels: async () => [] }),
  state: createClaudeStateStore({ stateDir: path.join(homePath, '.agent-gateway', 'claude-state') }),
});

const makeHome = async (accountUuid: string): Promise<string> => {
  const homePath = await mkdtemp(path.join(os.tmpdir(), 'agent-gateway-relay-'));
  await writeFile(path.join(homePath, '.claude.json'), JSON.stringify({ oauthAccount: { accountUuid } }));
  return homePath;
};

let otherHome = '';
let matchingHome = '';

beforeAll(async () => {
  otherHome = await makeHome(OTHER_ACCOUNT_UUID);
  matchingHome = await makeHome(ACCOUNT_UUID);
});

const withBody = (mutate: (body: Json) => void): string => {
  const body = JSON.parse(FIXTURE_BODY) as Json;
  mutate(body);
  return JSON.stringify(body);
};

const withUserId = (userId: Json): string =>
  withBody((body) => {
    body.metadata = { user_id: JSON.stringify(userId) };
  });

describe('getClaudeRelayRequest', () => {
  const getRelayRequest = (rawHeaders: string[] = FIXTURE_RAW_HEADERS, body: string = FIXTURE_BODY, url: string = FIXTURE_REQUEST.path) =>
    getClaudeRelayRequest({
      accounts: [makeAccount('claude1', otherHome), makeAccount('claude2', matchingHome)],
      rawHeaders,
      rawBody: Buffer.from(body),
      url,
    });

  const getRejection = async (promise: Promise<unknown>): Promise<Error & { status: number; type: string }> => {
    try {
      await promise;
    } catch (error) {
      return error as Error & { status: number; type: string };
    }
    throw new Error('expected the relay request to be rejected');
  };

  it('keeps every body byte and every header in arrival order, and picks the home of the same account', async () => {
    const relay = await getRelayRequest(withRawHeaders(FIXTURE_RAW_HEADERS, { 'x-agent-gateway-api-key': 'gateway-key' }));
    expect(relay.account.alias).toBe('claude2');
    expect(relay.model).toBe('claude-opus-5');
    expect(Buffer.from(relay.body).equals(Buffer.from(FIXTURE_BODY))).toBe(true);
    expect(relay.headers).toEqual(FIXTURE_RAW_HEADERS);
    expect(relay.pathAndQuery).toBe(FIXTURE_REQUEST.path);
  });

  it.each(['transfer-encoding', 'keep-alive', 'upgrade', 'X-Agent-Gateway-Api-Key'])('drops the %s header in any casing', async (name) => {
    const relay = await getRelayRequest([...FIXTURE_RAW_HEADERS, name, 'x']);
    expect(relay.headers).toEqual(FIXTURE_RAW_HEADERS);
  });

  it('keeps the raw request target without re-encoding it', async () => {
    const relay = await getRelayRequest(FIXTURE_RAW_HEADERS, FIXTURE_BODY, "/v1/messages?literal=a'b&escaped=%2f");
    expect(relay.pathAndQuery).toBe("/v1/messages?literal=a'b&escaped=%2f");
  });

  it('never re-serializes the body: non-canonical JSON passes through byte for byte', async () => {
    const body = FIXTURE_BODY.replace('{"model":', '{ "model" : ').replace('"say ok"', '"say \\u006fk"');
    const relay = await getRelayRequest(FIXTURE_RAW_HEADERS, body);
    expect(Buffer.from(relay.body).equals(Buffer.from(body))).toBe(true);
  });

  describe('rejects with a 400 before any upstream call', () => {
    it('when the request target is not a path', async () => {
      const error = await getRejection(getRelayRequest(FIXTURE_RAW_HEADERS, FIXTURE_BODY, 'http://127.0.0.1:8765/v1/messages'));
      expect(error.status).toBe(400);
    });

    it.each([
      ['x-app is missing', { 'x-app': undefined }, FIXTURE_BODY],
      ['the User-Agent is not claude-cli/', { 'user-agent': 'opencode/1.0' }, FIXTURE_BODY],
      ['metadata.user_id is missing', {}, withBody((body) => { delete body.metadata; })],
      ['metadata.user_id is not JSON', {}, withBody((body) => { body.metadata = { user_id: 'user_abc' }; })],
      ['metadata.user_id has no session_id', {}, withUserId({ device_id: 'd'.repeat(64), account_uuid: ACCOUNT_UUID })],
    ])('when the client is not Claude Code: %s', async (_name, headerChanges, body) => {
      const error = await getRejection(getRelayRequest(withRawHeaders(FIXTURE_RAW_HEADERS, headerChanges), body));
      expect(error).toMatchObject({ status: 400, type: 'invalid_request_error' });
      expect(error.message).toContain('only for the official Claude Code CLI');
    });

    it.each([
      ['the billing block has no cch', withBody((body) => { (body.system as Json[])[0] = { type: 'text', text: 'x-anthropic-billing-header: cc_version=2.1.302.804; cc_entrypoint=sdk-cli;' }; })],
      ['system[0] is not the billing block', withBody((body) => { (body.system as Json[]).shift(); })],
      ['system is a string', withBody((body) => { body.system = 'x-anthropic-billing-header: cch=00000;'; })],
    ])('when the request is not first-party shaped: %s', async (_name, body) => {
      const error = await getRejection(getRelayRequest(FIXTURE_RAW_HEADERS, body));
      expect(error.status).toBe(400);
      expect(error.message).toContain('_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL=1');
    });

    it('when anthropic-beta lacks oauth-2025-04-20', async () => {
      const betas = FIXTURE_REQUEST.headers['anthropic-beta']?.replace('oauth-2025-04-20,', '');
      const error = await getRejection(getRelayRequest(withRawHeaders(FIXTURE_RAW_HEADERS, { 'anthropic-beta': betas })));
      expect(error.status).toBe(400);
      expect(error.message).toContain('oauth-2025-04-20');
    });

    it.each([
      ['another account', '00000000-0000-4000-8000-000000000000'],
      ['no account (logged out)', ''],
    ])('when the client is logged in to %s', async (_name, accountUuid) => {
      const body = withUserId({ device_id: 'd'.repeat(64), account_uuid: accountUuid, session_id: '00000000-0000-4000-8000-00000000c0de' });
      const error = await getRejection(getRelayRequest(FIXTURE_RAW_HEADERS, body));
      expect(error.status).toBe(400);
      expect(error.message).toContain('same account as a gateway Claude home (claude1, claude2)');
    });

    it.each(['claude1/claude-opus-5', 'codex1/gpt-5.5'])('when the model alias %s points at another home', async (model) => {
      const error = await getRejection(getRelayRequest(FIXTURE_RAW_HEADERS, FIXTURE_BODY.replace('"model":"claude-opus-5"', `"model":"${model}"`)));
      expect(error.status).toBe(400);
      expect(error.message).toContain('(claude2)');
    });
  });

  it('strips a matching alias from model and leaves every other byte unchanged', async () => {
    const relay = await getRelayRequest(FIXTURE_RAW_HEADERS, FIXTURE_BODY.replace('"model":"claude-opus-5"', '"model":"claude2/claude-opus-5"'));
    expect(relay.model).toBe('claude-opus-5');
    expect(Buffer.from(relay.body).toString('utf8')).toBe(FIXTURE_BODY);
  });

  it('rewrites only the top-level model value, even in non-canonical JSON with nested model keys', async () => {
    const original = FIXTURE_BODY.replace('"properties":{"file_path"', '"properties":{"model":{"type":"string"},"file_path"');
    const client = original.replace('{"model":"claude-opus-5"', '{ "model" : "claude2\\/claude-opus-5"');
    const relay = await getRelayRequest(FIXTURE_RAW_HEADERS, client);
    expect(Buffer.from(relay.body).toString('utf8')).toBe(original.replace('{"model":"claude-opus-5"', '{ "model" : "claude-opus-5"'));
  });
});

describe('POST /v1/messages on the wire', () => {
  type UpstreamRequest = { url: string; rawHeaders: string[]; body: Buffer };
  type RelayReply = { status: number; statusMessage: string; rawHeaders: string[]; body: Buffer };
  type UpstreamHandler = (req: IncomingMessage, res: ServerResponse, index: number) => void;

  const API_KEY = 'gateway-test-key';
  const SSE_RESPONSE_HEADERS = ['Content-Type', 'text/event-stream; charset=utf-8', 'request-id', 'req_fixture_0001', 'Set-Cookie', 'a=1', 'Set-Cookie', 'b=2'];
  const sendSse: UpstreamHandler = (_req, res) => {
    res.writeHead(200, SSE_RESPONSE_HEADERS);
    res.end(SSE_TEXT);
  };

  let upstream: Server;
  let upstreamPort = 0;
  let upstreamRequests: UpstreamRequest[] = [];
  let upstreamHandler: UpstreamHandler = sendSse;
  let closeGateway: (() => void) | undefined;

  beforeAll(async () => {
    upstream = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        upstreamRequests.push({ url: req.url ?? '', rawHeaders: req.rawHeaders, body: Buffer.concat(chunks) });
        upstreamHandler(req, res, upstreamRequests.length - 1);
      });
    });
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    upstreamPort = (upstream.address() as AddressInfo).port;
  });
  afterAll(() => {
    upstream.closeAllConnections();
    upstream.close();
  });

  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    upstreamRequests = [];
    upstreamHandler = sendSse;
  });
  afterEach(() => {
    closeGateway?.();
    closeGateway = undefined;
    vi.restoreAllMocks();
  });

  const startGateway = async (options: { apiKey?: string; accounts?: ClaudeAccount[]; debugLevel?: 2 | 3 } = {}): Promise<number> => {
    const baseUrl = `http://127.0.0.1:${upstreamPort}`;
    const accounts = options.accounts ?? [makeAccount('claude1', otherHome, baseUrl), makeAccount('claude2', matchingHome, baseUrl)];
    const server = createProxyServer({ accounts, contextLength: 200000, apiKey: options.apiKey, debugLevel: options.debugLevel });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    closeGateway = () => {
      server.closeAllConnections();
      server.close();
    };
    return (server.address() as AddressInfo).port;
  };

  // Raw node:http client with setHost:false, so the gateway sees exactly this header list.
  const getClientHeaders = (port: number, body: string, changes: Record<string, string | undefined> = {}): string[] =>
    withRawHeaders(FIXTURE_RAW_HEADERS, { host: `127.0.0.1:${port}`, 'content-length': String(Buffer.byteLength(body)), ...changes });

  const sendRelay = (
    port: number,
    input: {
      path?: string;
      headerChanges?: Record<string, string | undefined>;
      // Appended as-is after the fixture headers, without going through withRawHeaders.
      extraRawHeaders?: string[];
      body?: string;
      onFirstChunk?: (destroy: () => void) => void;
    } = {},
  ): Promise<RelayReply> =>
    new Promise((resolve, reject) => {
      const body = input.body ?? FIXTURE_BODY;
      const headers = [...getClientHeaders(port, body, input.headerChanges), ...(input.extraRawHeaders ?? [])];
      const req = request({ host: '127.0.0.1', port, method: 'POST', path: input.path ?? FIXTURE_REQUEST.path, headers, setHost: false, agent: false }, (res) => {
        const chunks: Buffer[] = [];
        const toReply = (): RelayReply => ({ status: res.statusCode ?? 0, statusMessage: res.statusMessage ?? '', rawHeaders: res.rawHeaders, body: Buffer.concat(chunks) });
        res.on('data', (chunk: Buffer) => {
          chunks.push(chunk);
          input.onFirstChunk?.(() => req.destroy());
        });
        res.on('end', () => resolve(toReply()));
        res.on('error', () => resolve(toReply()));
      });
      req.on('error', (error) => (input.onFirstChunk ? resolve({ status: 0, statusMessage: '', rawHeaders: [], body: Buffer.alloc(0) }) : reject(error)));
      req.end(body);
    });

  // What upstream must see: the client's list with only host, token and length set for this hop.
  const getExpectedUpstreamHeaders = (port: number, accessToken: string, body = FIXTURE_BODY): string[] =>
    withRawHeaders(getClientHeaders(port, FIXTURE_BODY), {
      host: `127.0.0.1:${upstreamPort}`,
      authorization: `Bearer ${accessToken}`,
      'content-length': String(Buffer.byteLength(body)),
    });

  // Both servers add their own connection framing; everything else must match name for name.
  const withoutHopByHop = (rawHeaders: string[]): string[] =>
    rawHeaders.filter((_, index) => !HOP_BY_HOP_RESPONSE_HEADERS.includes((rawHeaders[index - (index % 2)] ?? '').toLowerCase()));
  const withoutDate = (rawHeaders: string[]): string[] => rawHeaders.filter((_, index) => (rawHeaders[index - (index % 2)] ?? '').toLowerCase() !== 'date');

  it('puts the client request on the wire byte for byte and streams the SSE reply back unchanged', async () => {
    const port = await startGateway();
    const reply = await sendRelay(port);
    expect(upstreamRequests).toHaveLength(1);
    const [received] = upstreamRequests;
    expect(received?.url).toBe(FIXTURE_REQUEST.path);
    expect(received?.body.equals(Buffer.from(FIXTURE_BODY))).toBe(true);
    expect(received?.rawHeaders).toEqual(getExpectedUpstreamHeaders(port, 'claude2-token'));
    const receivedNames = (received?.rawHeaders ?? []).filter((_, index) => index % 2 === 0).map((name) => name.toLowerCase());
    expect(receivedNames).not.toContain('accept-language');
    expect(receivedNames).not.toContain('sec-fetch-mode');
    expect(reply.status).toBe(200);
    expect(reply.body.toString('utf8')).toBe(SSE_TEXT);
    expect(withoutDate(withoutHopByHop(reply.rawHeaders))).toEqual(SSE_RESPONSE_HEADERS);
    expect(reply.rawHeaders.filter((name) => name.toLowerCase() === 'date')).toHaveLength(1);
  });

  it('keeps repeated headers in their original order and casing and adds no Connection header', async () => {
    const port = await startGateway();
    const clientHeaders = [...withRawHeaders(getClientHeaders(port, FIXTURE_BODY), { connection: undefined }), 'X-Dup', 'first', 'X-Middle', 'middle', 'x-dup', 'second'];
    // Raw socket, so no client library can regroup or add headers on the way in.
    const socket = connect(port, '127.0.0.1');
    const lines = [`POST ${FIXTURE_REQUEST.path} HTTP/1.1`];
    for (let index = 0; index < clientHeaders.length; index += 2) lines.push(`${clientHeaders[index]}: ${clientHeaders[index + 1]}`);
    socket.write(`${lines.join('\r\n')}\r\n\r\n${FIXTURE_BODY}`);
    socket.resume();
    await vi.waitFor(() => expect(upstreamRequests).toHaveLength(1));
    socket.destroy();
    expect(upstreamRequests[0]?.rawHeaders).toEqual(withRawHeaders(clientHeaders, { host: `127.0.0.1:${upstreamPort}`, authorization: 'Bearer claude2-token' }));
    expect(upstreamRequests[0]?.body.equals(Buffer.from(FIXTURE_BODY))).toBe(true);
  });

  it('keeps the value of headers named like Object.prototype members', async () => {
    const marker = 'client-supplied-marker';
    const extraRawHeaders = ['Constructor', marker, '__proto__', marker, 'X-Ordinary', marker];
    const port = await startGateway();
    const reply = await sendRelay(port, { extraRawHeaders });
    expect(reply.status).toBe(200);
    expect(upstreamRequests[0]?.rawHeaders).toEqual([...getExpectedUpstreamHeaders(port, 'claude2-token'), 'Constructor', marker, '__proto__', marker, 'X-Ordinary', marker]);
  });

  it('forwards the raw query without re-encoding it', async () => {
    const port = await startGateway();
    await sendRelay(port, { path: "/v1/messages?literal=a'b&escaped=%2f" });
    expect(upstreamRequests[0]?.url).toBe("/v1/messages?literal=a'b&escaped=%2f");
  });

  it('returns a gzip error body byte for byte with its content-encoding and content-length', async () => {
    const gzipped = gzipSync('{"type":"error","error":{"type":"rate_limit_error","message":"upstream says no"}}');
    const errorHeaders = ['Content-Type', 'application/json', 'Content-Encoding', 'gzip', 'Content-Length', String(gzipped.length), 'retry-after', '7'];
    upstreamHandler = (_req, res) => {
      res.writeHead(429, errorHeaders);
      res.end(gzipped);
    };
    const port = await startGateway();
    const reply = await sendRelay(port);
    expect(reply.status).toBe(429);
    expect(reply.body.equals(gzipped)).toBe(true);
    expect(withoutDate(withoutHopByHop(reply.rawHeaders))).toEqual(errorHeaders);
  });

  it('returns a redirect as sent instead of following it', async () => {
    upstreamHandler = (_req, res) => {
      res.writeHead(302, 'Found', ['Location', '/elsewhere', 'Content-Length', '5']);
      res.end('moved');
    };
    const port = await startGateway();
    const reply = await sendRelay(port);
    expect(reply).toMatchObject({ status: 302, statusMessage: 'Found' });
    expect(withoutDate(withoutHopByHop(reply.rawHeaders))).toEqual(['Location', '/elsewhere', 'Content-Length', '5']);
    expect(reply.body.toString('utf8')).toBe('moved');
    expect(upstreamRequests).toHaveLength(1);
  });

  it('sends the alias-free model with every other byte unchanged and the matching content-length', async () => {
    const port = await startGateway();
    const clientBody = FIXTURE_BODY.replace('"model":"claude-opus-5"', '"model":"claude2/claude-opus-5"');
    await sendRelay(port, { body: clientBody });
    expect(upstreamRequests[0]?.body.toString('utf8')).toBe(FIXTURE_BODY);
    expect(upstreamRequests[0]?.rawHeaders).toEqual(getExpectedUpstreamHeaders(port, 'claude2-token'));
  });

  it.each([
    ['no cch', {}, FIXTURE_BODY.replace(' cch=a1b2c;', ''), '_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL=1'],
    ['no oauth beta', { 'anthropic-beta': 'claude-code-20250219,interleaved-thinking-2025-05-14' }, FIXTURE_BODY, 'oauth-2025-04-20'],
    ['another account', {}, FIXTURE_BODY.replace(ACCOUNT_UUID, '00000000-0000-4000-8000-000000000000'), 'same account'],
    ['a mismatched alias', {}, FIXTURE_BODY.replace('"model":"claude-opus-5"', '"model":"claude1/claude-opus-5"'), 'does not match'],
  ])('answers %s with an Anthropic 400 and nothing reaches upstream', async (_name, headerChanges, body, messagePart) => {
    const port = await startGateway();
    const reply = await sendRelay(port, { headerChanges, body });
    expect(reply.status).toBe(400);
    expect(JSON.parse(reply.body.toString('utf8'))).toEqual({ type: 'error', error: { type: 'invalid_request_error', message: expect.stringContaining(messagePart) } });
    expect(upstreamRequests).toHaveLength(0);
  });

  it('recovers from a 401 and resends the same body bytes once', async () => {
    upstreamHandler = (req, res, index) => (index === 0 ? res.writeHead(401).end('{"type":"error"}') : sendSse(req, res, index));
    const port = await startGateway();
    const reply = await sendRelay(port);
    expect(reply.status).toBe(200);
    expect(upstreamRequests.map((received) => received.rawHeaders)).toEqual([
      getExpectedUpstreamHeaders(port, 'claude2-token'),
      getExpectedUpstreamHeaders(port, 'claude2-token-2'),
    ]);
    expect(upstreamRequests[1]?.body.equals(Buffer.from(FIXTURE_BODY))).toBe(true);
  });

  it('returns a 401 that survives recovery as sent', async () => {
    upstreamHandler = (_req, res, index) => res.writeHead(401, ['Content-Type', 'application/json']).end(`{"attempt":${index}}`);
    const port = await startGateway();
    const reply = await sendRelay(port);
    expect(reply.status).toBe(401);
    expect(reply.body.toString('utf8')).toBe('{"attempt":1}');
    expect(upstreamRequests).toHaveLength(2);
  });

  it('closes the upstream request when the client disconnects', async () => {
    let upstreamClosed: Promise<void> = Promise.resolve();
    upstreamHandler = (_req, res) => {
      upstreamClosed = new Promise((resolve) => res.on('close', () => resolve()));
      res.writeHead(200, ['Content-Type', 'text/event-stream']);
      res.write('event: ping\n\n');
    };
    const port = await startGateway();
    await sendRelay(port, { onFirstChunk: (destroy) => destroy() });
    await upstreamClosed;
    expect(upstreamRequests).toHaveLength(1);
  });

  it.each([2, 3] as const)('prints response headers named like Object.prototype members with their real values at debug level %s', async (debugLevel) => {
    const marker = 'upstream-supplied-marker';
    upstreamHandler = (_req, res) => {
      res.writeHead(200, ['Content-Type', 'text/event-stream', 'Constructor', marker, '__proto__', marker]);
      res.end(SSE_TEXT);
    };
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const port = await startGateway({ debugLevel });
    const reply = await sendRelay(port);
    expect(reply.status).toBe(200);
    await vi.waitFor(() => expect(log.mock.calls.flat().join('\n')).toContain('response 200'));
    const logged = log.mock.calls.flat().join('\n');
    expect(logged).toMatch(new RegExp(`\\]   constructor: ${marker}$`, 'm'));
    expect(logged).toMatch(new RegExp(`\\]   __proto__: ${marker}$`, 'm'));
    expect(logged).not.toContain('function Object');
    expect(logged).not.toContain('[object Object]');
  });

  describe('re-checks the home account before every send (real auth manager, fake home)', () => {
    const TOKEN_URL = 'https://token.test/v1/oauth/token';
    let home = '';
    const refreshFetch = vi.fn<typeof fetch>(async () =>
      new Response(JSON.stringify({ access_token: 'at-A2', refresh_token: 'rt-A2', expires_in: 3600 }), { status: 200, headers: { 'content-type': 'application/json' } }),
    );

    // A relogin rewrites both the credentials and the account record of the home.
    const writeLogin = async (accountUuid: string, accessToken: string, refreshToken: string): Promise<void> => {
      await writeFile(path.join(home, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken, refreshToken, expiresAt: Date.now() + 3_600_000, scopes: ['user:inference'] } }));
      await writeFile(path.join(home, '.claude.json'), JSON.stringify({ oauthAccount: { accountUuid } }));
    };

    const startWithRealAuth = (wrap: (auth: ClaudeAuthManager) => ClaudeAuthManager = (auth) => auth): Promise<number> => {
      const auth = createClaudeAuthManager({ credentialsPath: path.join(home, '.credentials.json'), tokenUrl: TOKEN_URL, fetchFn: refreshFetch });
      return startGateway({ accounts: [makeAccount('claude1', home, `http://127.0.0.1:${upstreamPort}`, wrap(auth))] });
    };

    const getSentTokens = (): (string | undefined)[] =>
      upstreamRequests.map((received) => received.rawHeaders[received.rawHeaders.findIndex((name, index) => index % 2 === 0 && name.toLowerCase() === 'authorization') + 1]);

    beforeEach(async () => {
      home = await mkdtemp(path.join(os.tmpdir(), 'agent-gateway-relay-login-'));
      await writeLogin(ACCOUNT_UUID, 'at-A1', 'rt-A1');
      refreshFetch.mockClear();
    });

    it('refuses when the home switches to another login after the entry check, before the first send', async () => {
      const port = await startWithRealAuth((auth) => ({
        ...auth,
        getCredentials: async () => {
          await writeLogin(OTHER_ACCOUNT_UUID, 'at-B1', 'rt-B1');
          return auth.getCredentials();
        },
      }));
      const reply = await sendRelay(port);
      expect(reply.status).toBe(400);
      expect(JSON.parse(reply.body.toString('utf8'))).toEqual({ type: 'error', error: { type: 'invalid_request_error', message: expect.stringContaining('different account') } });
      expect(upstreamRequests).toHaveLength(0);
    });

    it('refuses when the home switches during a 401, before the resend', async () => {
      upstreamHandler = (_req, res) => {
        void writeLogin(OTHER_ACCOUNT_UUID, 'at-B1', 'rt-B1').then(() => res.writeHead(401).end('{"type":"error"}'));
      };
      const port = await startWithRealAuth();
      const reply = await sendRelay(port);
      expect(reply.status).toBe(400);
      expect(getSentTokens()).toEqual(['Bearer at-A1']);
      expect(getSentTokens()).not.toContain('Bearer at-B1');
      expect(refreshFetch).not.toHaveBeenCalled();
    });

    it('still resends once with the same body after a normal same-account refresh', async () => {
      upstreamHandler = (req, res, index) => (index === 0 ? res.writeHead(401).end() : sendSse(req, res, index));
      const port = await startWithRealAuth();
      const reply = await sendRelay(port);
      expect(reply.status).toBe(200);
      expect(getSentTokens()).toEqual(['Bearer at-A1', 'Bearer at-A2']);
      expect(refreshFetch).toHaveBeenCalledTimes(1);
      expect(upstreamRequests.map((received) => received.body.equals(Buffer.from(FIXTURE_BODY)))).toEqual([true, true]);
    });
  });

  // Native 2.1.302 DFe (offset 243429208) sends count_tokens through the GU client, whose Wl()
  // headers (238462490) carry X-Claude-Code-Session-Id but whose body has no metadata.user_id.
  describe('POST /v1/messages/count_tokens', () => {
    const COUNT_PATH = '/v1/messages/count_tokens?beta=true';
    const COUNT_BODY = '{"model":"claude-opus-5","messages":[{"role":"user","content":"foo"}],"tools":[]}';
    const COUNT_RESPONSE_HEADERS = ['Content-Type', 'application/json', 'request-id', 'req_fixture_0002'];
    const getFakeSessionId = (index: number): string => `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;

    beforeEach(() => {
      upstreamHandler = (req, res, index) => {
        if (!req.url?.startsWith('/v1/messages/count_tokens')) return sendSse(req, res, index);
        res.writeHead(200, COUNT_RESPONSE_HEADERS);
        res.end('{"input_tokens":42}');
      };
    });

    // A relayed /v1/messages binds its session (the fixture one by default) to the home it matched.
    const bindSession = async (port: number, sessionId?: string): Promise<void> => {
      const reply = await sendRelay(port, sessionId === undefined ? {} : { headerChanges: { 'x-claude-code-session-id': sessionId } });
      expect(reply.status).toBe(200);
    };

    const sendCountTokens = (port: number, input: { headerChanges?: Record<string, string | undefined>; body?: string } = {}): Promise<RelayReply> =>
      sendRelay(port, { path: COUNT_PATH, body: input.body ?? COUNT_BODY, headerChanges: input.headerChanges });

    const getErrorMessage = (reply: RelayReply): unknown => (JSON.parse(reply.body.toString('utf8')) as { error: Json }).error;

    it('relays a bound session byte for byte, swapping only the token, and returns the reply as sent', async () => {
      const port = await startGateway();
      await bindSession(port);
      const reply = await sendCountTokens(port);
      expect(upstreamRequests).toHaveLength(2);
      const received = upstreamRequests[1];
      expect(received?.url).toBe(COUNT_PATH);
      expect(received?.body.equals(Buffer.from(COUNT_BODY))).toBe(true);
      expect(received?.rawHeaders).toEqual(getExpectedUpstreamHeaders(port, 'claude2-token', COUNT_BODY));
      expect(reply.status).toBe(200);
      expect(reply.body.toString('utf8')).toBe('{"input_tokens":42}');
      expect(withoutDate(withoutHopByHop(reply.rawHeaders))).toEqual(COUNT_RESPONSE_HEADERS);
    });

    it('strips a model alias only when it names the bound home', async () => {
      const port = await startGateway();
      await bindSession(port);
      await sendCountTokens(port, { body: COUNT_BODY.replace('"claude-opus-5"', '"claude2/claude-opus-5"') });
      expect(upstreamRequests[1]?.body.toString('utf8')).toBe(COUNT_BODY);
      const reply = await sendCountTokens(port, { body: COUNT_BODY.replace('"claude-opus-5"', '"claude1/claude-opus-5"') });
      expect(reply.status).toBe(400);
      expect(getErrorMessage(reply)).toEqual({ type: 'invalid_request_error', message: expect.stringContaining('does not match') });
      expect(upstreamRequests).toHaveLength(2);
    });

    it.each([
      ['a session never bound', false, {}, 'same-account check'],
      ['another session than the bound one', true, { 'x-claude-code-session-id': getFakeSessionId(7) }, 'same-account check'],
      ['no session header', true, { 'x-claude-code-session-id': undefined }, 'same-account check'],
      ['no oauth beta', true, { 'anthropic-beta': 'claude-code-20250219,interleaved-thinking-2025-05-14' }, 'oauth-2025-04-20'],
      ['a client that is not Claude Code', true, { 'user-agent': 'opencode/1.0' }, 'does not serve /v1/messages/count_tokens'],
    ])('answers %s with an Anthropic 400 and sends nothing upstream', async (_name, isBound, headerChanges, messagePart) => {
      const port = await startGateway();
      if (isBound) await bindSession(port);
      const reply = await sendCountTokens(port, { headerChanges });
      expect(reply.status).toBe(400);
      expect(getErrorMessage(reply)).toEqual({ type: 'invalid_request_error', message: expect.stringContaining(messagePart) });
      expect(upstreamRequests).toHaveLength(isBound ? 1 : 0);
    });

    it('does not bind a session whose /v1/messages was refused', async () => {
      const port = await startGateway();
      expect((await sendRelay(port, { body: FIXTURE_BODY.replace(' cch=a1b2c;', '') })).status).toBe(400);
      expect((await sendCountTokens(port)).status).toBe(400);
      expect(upstreamRequests).toHaveLength(0);
    });

    it('keeps the 403 gateway key rule of Claude Code and never relays the key', async () => {
      const port = await startGateway({ apiKey: API_KEY });
      await sendRelay(port, { headerChanges: { 'x-agent-gateway-api-key': API_KEY } });
      expect((await sendCountTokens(port)).status).toBe(403);
      const reply = await sendCountTokens(port, { headerChanges: { 'x-agent-gateway-api-key': API_KEY } });
      expect(reply.status).toBe(200);
      expect(upstreamRequests[1]?.rawHeaders).toEqual(getExpectedUpstreamHeaders(port, 'claude2-token', COUNT_BODY));
    });

    describe('re-checks the bound account before every send', () => {
      let home = '';
      const switchHome = (): Promise<void> => writeFile(path.join(home, '.claude.json'), JSON.stringify({ oauthAccount: { accountUuid: OTHER_ACCOUNT_UUID } }));

      beforeEach(async () => {
        home = await makeHome(ACCOUNT_UUID);
      });

      it('refuses when the home is logged in to another account after the binding', async () => {
        const port = await startGateway({ accounts: [makeAccount('claude1', home, `http://127.0.0.1:${upstreamPort}`)] });
        await bindSession(port);
        await switchHome();
        const reply = await sendCountTokens(port);
        expect(reply.status).toBe(400);
        expect(getErrorMessage(reply)).toEqual({ type: 'invalid_request_error', message: expect.stringContaining('different account') });
        expect(upstreamRequests).toHaveLength(1);
      });

      it('refuses the resend when the home switches during a 401', async () => {
        upstreamHandler = (req, res, index) => {
          if (index === 0) return sendSse(req, res, index);
          void switchHome().then(() => res.writeHead(401).end('{"type":"error"}'));
        };
        const port = await startGateway({ accounts: [makeAccount('claude1', home, `http://127.0.0.1:${upstreamPort}`)] });
        await bindSession(port);
        const reply = await sendCountTokens(port);
        expect(reply.status).toBe(400);
        expect(getErrorMessage(reply)).toEqual({ type: 'invalid_request_error', message: expect.stringContaining('different account') });
        expect(upstreamRequests).toHaveLength(2);
      });
    });

    it(`keeps the ${CLAUDE_RELAY_SESSION_MAX_ENTRIES} most recently used sessions`, async () => {
      const port = await startGateway();
      await bindSession(port, getFakeSessionId(0));
      await bindSession(port, getFakeSessionId(1));
      for (let start = 2; start < CLAUDE_RELAY_SESSION_MAX_ENTRIES; start += 50) {
        const count = Math.min(50, CLAUDE_RELAY_SESSION_MAX_ENTRIES - start);
        await Promise.all(Array.from({ length: count }, (_, offset) => bindSession(port, getFakeSessionId(start + offset))));
      }
      const getCountStatus = async (index: number): Promise<number> =>
        (await sendCountTokens(port, { headerChanges: { 'x-claude-code-session-id': getFakeSessionId(index) } })).status;
      // Using session 0 leaves session 1 as the least recently used one.
      expect(await getCountStatus(0)).toBe(200);
      await bindSession(port, getFakeSessionId(CLAUDE_RELAY_SESSION_MAX_ENTRIES));
      expect([await getCountStatus(1), await getCountStatus(0), await getCountStatus(2), await getCountStatus(CLAUDE_RELAY_SESSION_MAX_ENTRIES)]).toEqual([400, 200, 200, 200]);
    });
  });

  describe('with AGENT_GATEWAY_API_KEY', () => {
    it('accepts the key from x-agent-gateway-api-key and never relays that header', async () => {
      const port = await startGateway({ apiKey: API_KEY });
      const reply = await sendRelay(port, { headerChanges: { 'x-agent-gateway-api-key': API_KEY } });
      expect(reply.status).toBe(200);
      expect(upstreamRequests[0]?.rawHeaders).toEqual(getExpectedUpstreamHeaders(port, 'claude2-token'));
    });

    it.each([
      ['no key header', {}],
      ['a wrong key', { 'x-agent-gateway-api-key': 'wrong-key' }],
      ['the key only in Authorization', { authorization: `Bearer ${API_KEY}` }],
    ])('rejects %s with an Anthropic 403 (never 401, which the client reads as its own OAuth failure)', async (_name, headerChanges) => {
      const port = await startGateway({ apiKey: API_KEY });
      const reply = await sendRelay(port, { headerChanges });
      expect(reply.status).toBe(403);
      expect(JSON.parse(reply.body.toString('utf8'))).toEqual({ type: 'error', error: { type: 'permission_error', message: expect.stringContaining('x-agent-gateway-api-key') } });
      expect(upstreamRequests).toHaveLength(0);
    });

    describe.each([2, 3] as const)('at debug level %s', (debugLevel) => {
      it.each([
        ['accepted', API_KEY, 200],
        ['rejected', 'wrong-gateway-key-value', 403],
      ])('masks the whole x-agent-gateway-api-key value when the key is %s', async (_name, key, status) => {
        const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
        const port = await startGateway({ apiKey: API_KEY, debugLevel });
        const reply = await sendRelay(port, { headerChanges: { 'x-agent-gateway-api-key': key } });
        expect(reply.status).toBe(status);
        // The downstream response is printed once the gateway side closes.
        await vi.waitFor(() => expect(log.mock.calls.flat().join('\n')).toContain(`response ${status}`));
        const logged = log.mock.calls.flat().join('\n');
        expect(logged).toContain('x-agent-gateway-api-key: ***');
        expect(logged).not.toContain(key);
        expect(logged).not.toContain(API_KEY);
      });
    });
  });
});
