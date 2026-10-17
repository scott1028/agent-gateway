// Native Codex CLI relay on /backend-api/codex/* (HTTP and WebSocket). Matches references/codex
// @0d58012: core/src/client.rs (handshake headers, reconnect and 401 recovery),
// codex-api/src/endpoint/responses_websocket.rs (101 headers such as x-codex-turn-state) and
// model-provider-info/src/lib.rs (the built-in openai provider cannot add a gateway key header;
// DEFAULT_WEBSOCKET_CONNECT_TIMEOUT_MS). Fixtures keep the header order and frame shape of the
// codex exec 0.163.0 official-route capture; every id, token and text in them is fake. All tests
// are wire-level: loopback upstreams record exactly what the gateway put on the socket.
import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, request, type Server, type ServerResponse } from 'node:http';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { type AddressInfo, connect, type Socket } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import WebSocket, { WebSocketServer } from 'ws';
import type { CodexAccount } from '../../src/accounts.js';
import { type AuthManager, createAuthManager } from '../../src/auth/authManager.js';
import { getConfig } from '../../src/config.js';
import { CODEX_WEBSOCKET_CONNECT_TIMEOUT_MS } from '../../src/constants.js';
import { createModelCatalog } from '../../src/models.js';
import { createProxyServer } from '../../src/server.js';
import { createCodexClient } from '../../src/upstream/codexClient.js';
import type { ProxyDeps } from '../../src/utils/http.js';
import { readFixture, toJwt } from '../helpers.js';

type FixtureRequest = { method: string; path: string; rawHeaders: string[]; body?: string };
const FIXTURE = JSON.parse(readFixture('codex-relay.json')) as {
  accountId: string;
  models: FixtureRequest;
  responses: FixtureRequest & { body: string };
  websocket: FixtureRequest;
  frames: { prewarm: string; incremental: string };
};
const ACCOUNT_ID = FIXTURE.accountId;
const OTHER_ACCOUNT_ID = '00000000-0000-4000-8000-0000000000bd';
const REFRESH_URL = 'https://auth.test/oauth/token';
const HOP_BY_HOP_RESPONSE_HEADERS = ['connection', 'keep-alive', 'transfer-encoding', 'date'];

const getAccessToken = (label: string): string => toJwt({ exp: Math.floor(Date.now() / 1000) + 3600, label });
const ACCESS_A1 = getAccessToken('a1');
const ACCESS_A2 = getAccessToken('a2');
const ACCESS_B1 = getAccessToken('b1');

// Within the 5-minute refresh window, so the first getCredentials refreshes proactively.
const getExpiringAccessToken = (): string => toJwt({ exp: Math.floor(Date.now() / 1000) + 60, label: 'expiring' });
const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
// The OAuth refresh endpoint answers A2 only after `delayMs`.
const getSlowRefresh = (delayMs: number) => async (): Promise<Response> => {
  await wait(delayMs);
  return new Response(JSON.stringify({ access_token: ACCESS_A2, refresh_token: 'rt-a2' }), { status: 200, headers: { 'content-type': 'application/json' } });
};
type RefreshCall = { atMs: number; refreshToken: string };
// The OAuth endpoint answers a transient 503 after `delayMs` (the auth manager then keeps the old
// token, its existing fallback), recording when each POST started and for which refresh token.
const getTransientRefresh = (delayMs: number, calls: RefreshCall[]) => async (_input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> => {
  calls.push({ atMs: Date.now(), refreshToken: (JSON.parse(String(init?.body)) as { refresh_token: string }).refresh_token });
  await wait(delayMs);
  return new Response('{"error":"temporarily_unavailable"}', { status: 503, headers: { 'content-type': 'application/json' } });
};
const getSavedAccessToken = async (authPath: string): Promise<string> =>
  ((JSON.parse(await readFile(authPath, 'utf8')) as { tokens: { access_token: string } }).tokens.access_token);

const writeLogin = async (authPath: string, accountId: string, accessToken: string, refreshToken: string): Promise<void> => {
  const idToken = toJwt({ 'https://api.openai.com/auth': { chatgpt_account_id: accountId } });
  await writeFile(authPath, JSON.stringify({ auth_mode: 'chatgpt', tokens: { id_token: idToken, access_token: accessToken, refresh_token: refreshToken, account_id: accountId } }));
};

// Replaces header values by lowercase name in a rawHeaders list, own keys only.
const setRawHeaderValues = (rawHeaders: string[], values: Map<string, string>): string[] =>
  rawHeaders.map((entry, index) => (index % 2 === 1 ? (values.get((rawHeaders[index - 1] ?? '').toLowerCase()) ?? entry) : entry));

const withoutHopByHop = (rawHeaders: string[]): string[] =>
  rawHeaders.filter((_, index) => !HOP_BY_HOP_RESPONSE_HEADERS.includes((rawHeaders[index - (index % 2)] ?? '').toLowerCase()));

const defaultRefresh = async (): Promise<Response> =>
  new Response(JSON.stringify({ access_token: ACCESS_A2, refresh_token: 'rt-a2' }), { status: 200, headers: { 'content-type': 'application/json' } });
const refreshFetch = vi.fn<typeof fetch>(defaultRefresh);

let upstream: Server;
let upstreamPort = 0;
type UpstreamRequest = { method: string; url: string; rawHeaders: string[]; body: Buffer };
let upstreamRequests: UpstreamRequest[] = [];
type UpstreamHandler = (req: IncomingMessage, res: ServerResponse, index: number) => void;
const sendModels: UpstreamHandler = (_req, res) => {
  res.writeHead(200, ['Content-Type', 'application/json', 'x-models-etag', 'etag-fixture', 'x-request-id', 'req-fixture-1']);
  res.end('{"models":[]}');
};
let upstreamHandler: UpstreamHandler = sendModels;
type UpgradeHandler = (req: IncomingMessage, socket: Socket, head: Buffer, index: number) => void;
let upstreamUpgrades: { url: string; rawHeaders: string[] }[] = [];
// Compression on, so compressed frames must cross the tunnel too.
const upstreamWss = new WebSocketServer({ noServer: true, perMessageDeflate: true });
upstreamWss.on('headers', (headers) => headers.push('x-codex-turn-state: turn-state-fixture', 'openai-model: gpt-6.1-sol', 'x-models-etag: etag-fixture', 'x-reasoning-included: true'));
let onUpstreamSocket: (ws: WebSocket) => void = () => undefined;
const acceptUpgrade: UpgradeHandler = (req, socket, head) => upstreamWss.handleUpgrade(req, socket, head, (ws) => onUpstreamSocket(ws));
let upgradeHandler: UpgradeHandler = acceptUpgrade;
let matchingAuthPath = '';
let otherAuthPath = '';
let closeGateway: (() => void) | undefined;

beforeAll(async () => {
  upstream = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      upstreamRequests.push({ method: req.method ?? '', url: req.url ?? '', rawHeaders: req.rawHeaders, body: Buffer.concat(chunks) });
      upstreamHandler(req, res, upstreamRequests.length - 1);
    });
  });
  upstream.on('upgrade', (req: IncomingMessage, socket: Socket, head: Buffer) => {
    upstreamUpgrades.push({ url: req.url ?? '', rawHeaders: req.rawHeaders });
    upgradeHandler(req, socket, head, upstreamUpgrades.length - 1);
  });
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  upstreamPort = (upstream.address() as AddressInfo).port;
});
afterAll(() => {
  upstreamWss.close();
  upstream.closeAllConnections();
  upstream.close();
});

beforeEach(async () => {
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  upstreamRequests = [];
  upstreamHandler = sendModels;
  upstreamUpgrades = [];
  upgradeHandler = acceptUpgrade;
  onUpstreamSocket = () => undefined;
  refreshFetch.mockClear();
  matchingAuthPath = path.join(await mkdtemp(path.join(os.tmpdir(), 'agent-gateway-codex-relay-')), 'auth.json');
  otherAuthPath = path.join(await mkdtemp(path.join(os.tmpdir(), 'agent-gateway-codex-relay-')), 'auth.json');
  await writeLogin(matchingAuthPath, ACCOUNT_ID, ACCESS_A1, 'rt-a1');
  await writeLogin(otherAuthPath, OTHER_ACCOUNT_ID, ACCESS_B1, 'rt-b1');
});
afterEach(() => {
  for (const client of upstreamWss.clients) client.terminate();
  closeGateway?.();
  closeGateway = undefined;
  vi.restoreAllMocks();
});

const getUpstreamBaseUrl = (): string => `http://127.0.0.1:${upstreamPort}/backend-api/codex`;

const makeCodexAccount = (alias: string, authPath: string, wrap: (auth: AuthManager) => AuthManager = (auth) => auth): CodexAccount => {
  const homePath = path.dirname(authPath);
  const config = { ...getConfig({}, [homePath]), baseUrl: getUpstreamBaseUrl() };
  const auth = wrap(createAuthManager({ authPath, refreshUrl: REFRESH_URL, fetchFn: refreshFetch }));
  const client = createCodexClient({ auth, config, authPath });
  return { provider: 'codex', alias, homePath, client, catalog: createModelCatalog({ getModels: client.getModels }) };
};

const startGateway = async (options: Partial<ProxyDeps> & { wrapMatching?: (auth: AuthManager) => AuthManager } = {}): Promise<number> => {
  const { wrapMatching, ...deps } = options;
  const accounts = [makeCodexAccount('codex1', otherAuthPath), makeCodexAccount('codex2', matchingAuthPath, wrapMatching)];
  const server = createProxyServer({ accounts, contextLength: 200000, ...deps });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  closeGateway = () => {
    server.closeAllConnections();
    server.close();
  };
  return (server.address() as AddressInfo).port;
};

type HttpReply = { status: number; statusMessage: string; rawHeaders: string[]; body: Buffer };

// Raw node:http client with setDefaultHeaders:false, so the gateway sees exactly this header list:
// nothing grouped and, like Codex, no Connection when the list has none.
const sendHttp = (
  port: number,
  input: { method: string; path: string; rawHeaders: string[]; body?: string; onFirstChunk?: (destroy: () => void) => void },
): Promise<HttpReply> =>
  new Promise((resolve, reject) => {
    const body = Buffer.from(input.body ?? '');
    const lengthValues = body.length > 0 ? [['content-length', String(body.length)] as [string, string]] : [];
    const headers = setRawHeaderValues(input.rawHeaders, new Map([['host', `127.0.0.1:${port}`], ...lengthValues]));
    const req = request({ host: '127.0.0.1', port, method: input.method, path: input.path, headers, setDefaultHeaders: false, agent: false }, (res) => {
      const chunks: Buffer[] = [];
      const toReply = (): HttpReply => ({ status: res.statusCode ?? 0, statusMessage: res.statusMessage ?? '', rawHeaders: res.rawHeaders, body: Buffer.concat(chunks) });
      res.on('data', (chunk: Buffer) => {
        chunks.push(chunk);
        input.onFirstChunk?.(() => req.destroy());
      });
      res.on('end', () => resolve(toReply()));
      res.on('error', () => resolve(toReply()));
    });
    req.on('error', (error) => (input.onFirstChunk ? resolve({ status: 0, statusMessage: '', rawHeaders: [], body: Buffer.alloc(0) }) : reject(error)));
    req.end(body.length > 0 ? body : undefined);
  });

// The responses fixture ends with a host placeholder and needs a content-length for its body.
const RESPONSES_HEADERS = [...FIXTURE.responses.rawHeaders, 'content-length', '0'];

// What upstream must see: the client's own list with only host, token and length set for this hop.
const getExpectedUpstreamHeaders = (port: number, clientHeaders: string[], accessToken: string, body = ''): string[] => {
  const values = new Map([['host', `127.0.0.1:${port}`], ...(body.length > 0 ? [['content-length', String(Buffer.byteLength(body))] as [string, string]] : [])]);
  return setRawHeaderValues(setRawHeaderValues(clientHeaders, values), new Map([['host', `127.0.0.1:${upstreamPort}`], ['authorization', `Bearer ${accessToken}`]]));
};

const getSentTokens = (): (string | undefined)[] =>
  upstreamRequests.map((received) => received.rawHeaders[received.rawHeaders.findIndex((name, index) => index % 2 === 0 && name.toLowerCase() === 'authorization') + 1]);

describe('HTTP relay', () => {
  it('relays GET /models with only authorization changed and returns the reply as sent', async () => {
    const port = await startGateway();
    const reply = await sendHttp(port, FIXTURE.models);
    expect(upstreamRequests).toHaveLength(1);
    expect(upstreamRequests[0]).toMatchObject({ method: 'GET', url: FIXTURE.models.path });
    expect(upstreamRequests[0]?.rawHeaders).toEqual(getExpectedUpstreamHeaders(port, FIXTURE.models.rawHeaders, ACCESS_A1));
    const receivedNames = (upstreamRequests[0]?.rawHeaders ?? []).filter((_, index) => index % 2 === 0).map((name) => name.toLowerCase());
    expect(receivedNames).not.toContain('accept-language');
    expect(receivedNames).not.toContain('sec-fetch-mode');
    expect(receivedNames).not.toContain('content-length');
    expect(reply.status).toBe(200);
    expect(withoutHopByHop(reply.rawHeaders)).toEqual(['Content-Type', 'application/json', 'x-models-etag', 'etag-fixture', 'x-request-id', 'req-fixture-1']);
    expect(reply.body.toString('utf8')).toBe('{"models":[]}');
  });

  it('relays POST /responses byte for byte, including headers named like Object.prototype members', async () => {
    upstreamHandler = (_req, res) => {
      res.writeHead(200, ['Content-Type', 'text/event-stream']);
      res.end('event: response.completed\ndata: {"type":"response.completed"}\n\n');
    };
    const port = await startGateway();
    const clientHeaders = [...RESPONSES_HEADERS, 'Constructor', 'client-marker', '__proto__', 'client-marker', 'X-Ordinary', 'client-marker'];
    const reply = await sendHttp(port, { ...FIXTURE.responses, rawHeaders: clientHeaders });
    expect(upstreamRequests[0]?.body.toString('utf8')).toBe(FIXTURE.responses.body);
    expect(upstreamRequests[0]?.rawHeaders).toEqual(getExpectedUpstreamHeaders(port, clientHeaders, ACCESS_A1, FIXTURE.responses.body));
    expect(upstreamRequests[0]?.rawHeaders.slice(-6)).toEqual(['Constructor', 'client-marker', '__proto__', 'client-marker', 'X-Ordinary', 'client-marker']);
    expect(reply.body.toString('utf8')).toBe('event: response.completed\ndata: {"type":"response.completed"}\n\n');
  });

  it('keeps repeated headers in their original order and casing and adds no Connection header', async () => {
    const port = await startGateway();
    const clientHeaders = setRawHeaderValues(
      [...FIXTURE.models.rawHeaders.slice(0, 4), 'X-Dup', 'first', 'X-Middle', 'middle', 'x-dup', 'second', ...FIXTURE.models.rawHeaders.slice(4)],
      new Map([['host', `127.0.0.1:${port}`]]),
    );
    // Raw socket, so no client library can regroup or add headers on the way in.
    const socket = connect(port, '127.0.0.1');
    const lines = [`GET ${FIXTURE.models.path} HTTP/1.1`];
    for (let index = 0; index < clientHeaders.length; index += 2) lines.push(`${clientHeaders[index]}: ${clientHeaders[index + 1]}`);
    // write, not end: a half-closed client counts as gone and aborts the relay.
    socket.write(`${lines.join('\r\n')}\r\n\r\n`);
    socket.resume();
    await vi.waitFor(() => expect(upstreamRequests).toHaveLength(1));
    socket.destroy();
    const received = upstreamRequests[0]?.rawHeaders ?? [];
    expect(received).toEqual(getExpectedUpstreamHeaders(port, clientHeaders, ACCESS_A1));
    expect(received.slice(4, 10)).toEqual(['X-Dup', 'first', 'X-Middle', 'middle', 'x-dup', 'second']);
  });

  it('forwards the raw query without re-encoding it', async () => {
    const port = await startGateway();
    await sendHttp(port, { ...FIXTURE.models, path: "/backend-api/codex/models?literal=a'b&escaped=%2f" });
    expect(upstreamRequests[0]?.url).toBe("/backend-api/codex/models?literal=a'b&escaped=%2f");
  });

  it('returns a gzip error body byte for byte with its content-encoding and content-length', async () => {
    const gzipped = gzipSync('{"detail":"upstream says no"}');
    const errorHeaders = ['Content-Type', 'application/json', 'Content-Encoding', 'gzip', 'Content-Length', String(gzipped.length)];
    upstreamHandler = (_req, res) => {
      res.writeHead(429, errorHeaders);
      res.end(gzipped);
    };
    const port = await startGateway();
    const reply = await sendHttp(port, FIXTURE.models);
    expect(reply.status).toBe(429);
    expect(reply.body.equals(gzipped)).toBe(true);
    expect(withoutHopByHop(reply.rawHeaders)).toEqual(errorHeaders);
  });

  it('returns a redirect as sent instead of following it', async () => {
    upstreamHandler = (_req, res) => {
      res.writeHead(302, 'Found', ['Location', '/elsewhere', 'Content-Length', '5']);
      res.end('moved');
    };
    const port = await startGateway();
    const reply = await sendHttp(port, FIXTURE.models);
    expect(reply).toMatchObject({ status: 302, statusMessage: 'Found' });
    expect(withoutHopByHop(reply.rawHeaders)).toEqual(['Location', '/elsewhere', 'Content-Length', '5']);
    expect(upstreamRequests).toHaveLength(1);
  });

  it('recovers from a 401 with a refreshed token of the same account and resends the same body', async () => {
    upstreamHandler = (req, res, index) => (index === 0 ? res.writeHead(401).end() : sendModels(req, res, index));
    const port = await startGateway();
    const reply = await sendHttp(port, { ...FIXTURE.responses, rawHeaders: RESPONSES_HEADERS });
    expect(reply.status).toBe(200);
    expect(getSentTokens()).toEqual([`Bearer ${ACCESS_A1}`, `Bearer ${ACCESS_A2}`]);
    expect(refreshFetch).toHaveBeenCalledTimes(1);
    expect(upstreamRequests.map((received) => received.body.toString('utf8'))).toEqual([FIXTURE.responses.body, FIXTURE.responses.body]);
  });

  it('returns a 401 that survives recovery as sent', async () => {
    upstreamHandler = (_req, res, index) => res.writeHead(401, ['Content-Type', 'application/json']).end(`{"attempt":${index}}`);
    const port = await startGateway();
    const reply = await sendHttp(port, FIXTURE.models);
    expect(reply.status).toBe(401);
    expect(reply.body.toString('utf8')).toBe('{"attempt":1}');
    expect(upstreamRequests).toHaveLength(2);
  });

  it.each([
    ['another account', setRawHeaderValues(FIXTURE.models.rawHeaders, new Map([['chatgpt-account-id', '00000000-0000-4000-8000-0000000000ff']]))],
    ['no chatgpt-account-id', FIXTURE.models.rawHeaders.filter((_, index, all) => (all[index - (index % 2)] ?? '').toLowerCase() !== 'chatgpt-account-id')],
  ])('answers %s with 400 account_mismatch and nothing reaches upstream', async (_name, rawHeaders) => {
    const port = await startGateway();
    const reply = await sendHttp(port, { ...FIXTURE.models, rawHeaders });
    expect(reply.status).toBe(400);
    expect(JSON.parse(reply.body.toString('utf8'))).toMatchObject({ error: { code: 'account_mismatch', message: expect.stringContaining('same ChatGPT account') } });
    expect(upstreamRequests).toHaveLength(0);
  });

  it('refuses when the home holds another account by the first send', async () => {
    // The first getCredentials picks the home; the next one (the send) sees a switched login.
    let calls = 0;
    const port = await startGateway({
      wrapMatching: (auth) => ({
        ...auth,
        getCredentials: async () => {
          calls += 1;
          return calls === 1 ? auth.getCredentials() : { accessToken: ACCESS_B1, accountId: OTHER_ACCOUNT_ID, isFedramp: false };
        },
      }),
    });
    const reply = await sendHttp(port, FIXTURE.models);
    expect(reply.status).toBe(400);
    expect(JSON.parse(reply.body.toString('utf8'))).toMatchObject({ error: { code: 'account_mismatch', message: expect.stringContaining('different ChatGPT account') } });
    expect(upstreamRequests).toHaveLength(0);
  });

  it('refuses when the home switches to another login during a 401, before the resend', async () => {
    upstreamHandler = (_req, res) => {
      void writeLogin(matchingAuthPath, OTHER_ACCOUNT_ID, ACCESS_B1, 'rt-b1').then(() => res.writeHead(401).end());
    };
    const port = await startGateway();
    const reply = await sendHttp(port, FIXTURE.models);
    expect(reply.status).toBe(400);
    expect(getSentTokens()).toEqual([`Bearer ${ACCESS_A1}`]);
    expect(refreshFetch).not.toHaveBeenCalled();
  });

  it('destroys a first 401 whose body never ends and still succeeds on the retry', async () => {
    let firstClosed: Promise<void> = new Promise(() => undefined);
    upstreamHandler = (req, res, index) => {
      if (index > 0) {
        sendModels(req, res, index);
        return;
      }
      firstClosed = new Promise((resolve) => res.on('close', () => resolve()));
      res.writeHead(401, ['Content-Length', '100']);
      res.write('x');
    };
    const port = await startGateway();
    const reply = await sendHttp(port, FIXTURE.models);
    expect(reply.status).toBe(200);
    expect(getSentTokens()).toEqual([`Bearer ${ACCESS_A1}`, `Bearer ${ACCESS_A2}`]);
    await firstClosed;
  });

  it('sends nothing upstream when the client leaves during a proactive refresh', async () => {
    await writeLogin(matchingAuthPath, ACCOUNT_ID, getExpiringAccessToken(), 'rt-a1');
    refreshFetch.mockImplementationOnce(getSlowRefresh(350));
    const port = await startGateway();
    const socket = connect(port, '127.0.0.1');
    const headers = setRawHeaderValues(FIXTURE.models.rawHeaders, new Map([['host', `127.0.0.1:${port}`]]));
    const lines = [`GET ${FIXTURE.models.path} HTTP/1.1`];
    for (let index = 0; index < headers.length; index += 2) lines.push(`${headers[index]}: ${headers[index + 1]}`);
    socket.write(`${lines.join('\r\n')}\r\n\r\n`);
    await wait(50);
    socket.destroy();
    await wait(600);
    expect(refreshFetch).toHaveBeenCalledTimes(1);
    expect(upstreamRequests).toHaveLength(0);
    // The refresh was not cut short: its rotated token is on disk.
    expect(await getSavedAccessToken(matchingAuthPath)).toBe(ACCESS_A2);
  });

  it('starts no new OAuth refresh after the client resets during a transient-503 refresh', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const refreshCalls: RefreshCall[] = [];
    refreshFetch.mockImplementation(getTransientRefresh(170, refreshCalls));
    try {
      await writeLogin(matchingAuthPath, ACCOUNT_ID, getExpiringAccessToken(), 'rt-a1');
      const port = await startGateway({ accounts: [makeCodexAccount('codex1', matchingAuthPath)] });
      const socket = connect(port, '127.0.0.1');
      const headers = setRawHeaderValues(FIXTURE.models.rawHeaders, new Map([['host', `127.0.0.1:${port}`]]));
      const lines = [`GET ${FIXTURE.models.path} HTTP/1.1`];
      for (let index = 0; index < headers.length; index += 2) lines.push(`${headers[index]}: ${headers[index + 1]}`);
      socket.write(`${lines.join('\r\n')}\r\n\r\n`);
      await wait(50);
      socket.destroy();
      const endedAtMs = Date.now();
      await wait(450);
      expect(refreshCalls.map((call) => call.refreshToken)).toEqual(['rt-a1']);
      expect(refreshCalls.every((call) => call.atMs <= endedAtMs)).toBe(true);
      expect(upstreamRequests).toHaveLength(0);
    } finally {
      refreshFetch.mockImplementation(defaultRefresh);
    }
  });

  it.each([
    ['GET /models', FIXTURE.models],
    ['POST /responses', { ...FIXTURE.responses, rawHeaders: RESPONSES_HEADERS }],
  ])('answers %s with 403 permission_error when AGENT_GATEWAY_API_KEY is set', async (_name, fixtureRequest) => {
    const port = await startGateway({ apiKey: 'gateway-test-key' });
    const reply = await sendHttp(port, fixtureRequest);
    expect(reply.status).toBe(403);
    expect(JSON.parse(reply.body.toString('utf8'))).toMatchObject({ error: { type: 'permission_error', code: 'api_key_unsupported' } });
    expect(upstreamRequests).toHaveLength(0);
  });

  it('rejects an absolute-form request target', async () => {
    const port = await startGateway();
    const reply = await sendHttp(port, { ...FIXTURE.models, path: `http://127.0.0.1:${port}/backend-api/codex/models` });
    expect(reply.status).toBe(400);
    expect(upstreamRequests).toHaveLength(0);
  });

  it('closes the upstream request when the client disconnects', async () => {
    let upstreamClosed: Promise<void> = Promise.resolve();
    upstreamHandler = (_req, res) => {
      upstreamClosed = new Promise((resolve) => res.on('close', () => resolve()));
      res.writeHead(200, ['Content-Type', 'text/event-stream']);
      res.write('event: ping\n\n');
    };
    const port = await startGateway();
    await sendHttp(port, { ...FIXTURE.responses, rawHeaders: RESPONSES_HEADERS, onFirstChunk: (destroy) => destroy() });
    await upstreamClosed;
    expect(upstreamRequests).toHaveLength(1);
  });

  it.each([2, 3] as const)('never prints a bearer token at debug level %s', async (debugLevel) => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const port = await startGateway({ debugLevel });
    await sendHttp(port, FIXTURE.models);
    await vi.waitFor(() => expect(log.mock.calls.flat().join('\n')).toContain('response 200'));
    const logged = log.mock.calls.flat().join('\n');
    expect(logged).toContain('authorization: Bearer ***');
    expect(logged).not.toContain('client-chatgpt-token-fixture');
    expect(logged).not.toContain(ACCESS_A1);
  });
});

describe('WebSocket relay', () => {
  type UpgradeReply = { status: number; statusMessage: string; rawHeaders: string[]; headBytes: Buffer; body: Buffer; socket: Socket };
  const WEBSOCKET_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
  const NON_HANDSHAKE_NAMES = ['host', 'connection', 'upgrade', 'sec-websocket-version', 'sec-websocket-key', 'sec-websocket-extensions'];
  const sockets: Socket[] = [];
  const clients: WebSocket[] = [];
  afterEach(() => {
    for (const socket of sockets.splice(0)) socket.destroy();
    for (const client of clients.splice(0)) client.terminate();
  });

  const getHeaderValue = (rawHeaders: string[], name: string): string | undefined =>
    rawHeaders[rawHeaders.findIndex((entry, index) => index % 2 === 0 && entry.toLowerCase() === name) + 1];

  // Raw TCP client: writes the captured handshake byte for byte and reads the status line and
  // headers back; a non-101 reply is read until the gateway ends the socket.
  const sendRawUpgrade = (port: number, rawHeaders: string[] = FIXTURE.websocket.rawHeaders, requestPath = FIXTURE.websocket.path): Promise<UpgradeReply> =>
    new Promise((resolve, reject) => {
      const socket = connect(port, '127.0.0.1');
      sockets.push(socket);
      const headers = setRawHeaderValues(rawHeaders, new Map([['host', `127.0.0.1:${port}`]]));
      const lines = [`GET ${requestPath} HTTP/1.1`];
      for (let index = 0; index < headers.length; index += 2) lines.push(`${headers[index]}: ${headers[index + 1]}`);
      socket.write(`${lines.join('\r\n')}\r\n\r\n`);
      let buffer = Buffer.alloc(0);
      let head: Omit<UpgradeReply, 'body' | 'socket'> | undefined;
      const finish = (): void => resolve({ ...(head ?? { status: 0, statusMessage: '', rawHeaders: [], headBytes: Buffer.alloc(0) }), body: buffer, socket });
      socket.on('data', (chunk: Buffer) => {
        buffer = Buffer.concat([buffer, chunk]);
        if (head !== undefined) return;
        const headEnd = buffer.indexOf('\r\n\r\n');
        if (headEnd === -1) return;
        const [statusLine = '', ...headerLines] = buffer.subarray(0, headEnd).toString('latin1').split('\r\n');
        const [, status = '0', ...statusWords] = statusLine.split(' ');
        head = {
          status: Number(status),
          statusMessage: statusWords.join(' '),
          rawHeaders: headerLines.flatMap((line) => [line.slice(0, line.indexOf(':')), line.slice(line.indexOf(':') + 1).trim()]),
          headBytes: buffer.subarray(0, headEnd + 4),
        };
        buffer = buffer.subarray(headEnd + 4);
        if (head.status === 101) finish();
      });
      socket.on('end', finish);
      // A socket the test destroys itself only emits close.
      socket.on('close', finish);
      socket.on('error', reject);
    });

  const openClient = (port: number): Promise<WebSocket> =>
    new Promise((resolve, reject) => {
      const appHeaders = FIXTURE.websocket.rawHeaders.flatMap((entry, index, all) =>
        index % 2 === 0 && !NON_HANDSHAKE_NAMES.includes(entry.toLowerCase()) ? [[entry, all[index + 1] ?? ''] as const] : [],
      );
      const client = new WebSocket(`ws://127.0.0.1:${port}${FIXTURE.websocket.path}`, {
        headers: Object.fromEntries(appHeaders),
        perMessageDeflate: { clientMaxWindowBits: true as unknown as number },
      });
      clients.push(client);
      client.once('open', () => resolve(client));
      client.once('error', reject);
    });

  const getSentHandshakeTokens = (): (string | undefined)[] => upstreamUpgrades.map((upgrade) => getHeaderValue(upgrade.rawHeaders, 'authorization'));

  it('relays the client handshake with only host and authorization changed and returns the upstream 101 as sent', async () => {
    const port = await startGateway();
    const reply = await sendRawUpgrade(port);
    expect(reply.status).toBe(101);
    expect(upstreamUpgrades).toHaveLength(1);
    expect(upstreamUpgrades[0]?.url).toBe(FIXTURE.websocket.path);
    const clientHeaders = setRawHeaderValues(FIXTURE.websocket.rawHeaders, new Map([['host', `127.0.0.1:${port}`]]));
    expect(upstreamUpgrades[0]?.rawHeaders).toEqual(setRawHeaderValues(clientHeaders, new Map([['host', `127.0.0.1:${upstreamPort}`], ['authorization', `Bearer ${ACCESS_A1}`]])));
    const key = getHeaderValue(FIXTURE.websocket.rawHeaders, 'sec-websocket-key') ?? '';
    expect(getHeaderValue(reply.rawHeaders, 'sec-websocket-accept')).toBe(createHash('sha1').update(`${key}${WEBSOCKET_GUID}`).digest('base64'));
    // Negotiated end to end: this is the upstream's own answer to the client's offer.
    expect(getHeaderValue(reply.rawHeaders, 'sec-websocket-extensions')).toBe('permessage-deflate');
    const relayedHeaders: [string, string][] = [['x-codex-turn-state', 'turn-state-fixture'], ['openai-model', 'gpt-6.1-sol'], ['x-models-etag', 'etag-fixture'], ['x-reasoning-included', 'true']];
    for (const [name, value] of relayedHeaders) expect(getHeaderValue(reply.rawHeaders, name)).toBe(value);
  });

  it('passes text and binary messages both ways byte for byte, including the incremental frame', async () => {
    const received: { data: Buffer; isBinary: boolean }[] = [];
    const binary = Buffer.from([0, 1, 2, 250, 251, 252, 253, 254, 255]);
    onUpstreamSocket = (ws) => {
      ws.on('message', (data: Buffer, isBinary: boolean) => {
        received.push({ data, isBinary });
        if (received.length === 3) {
          ws.send('{"type":"response.created","response":{"id":"resp_fixture_1"}}');
          ws.send(binary);
        }
      });
    };
    const port = await startGateway();
    const client = await openClient(port);
    const replies: { data: Buffer; isBinary: boolean }[] = [];
    client.on('message', (data: Buffer, isBinary: boolean) => replies.push({ data, isBinary }));
    client.send(FIXTURE.frames.prewarm);
    client.send(FIXTURE.frames.incremental);
    client.send(binary);
    await vi.waitFor(() => expect(replies).toHaveLength(2));
    expect(received.map((message) => [message.data.toString('utf8'), message.isBinary])).toEqual([
      [FIXTURE.frames.prewarm, false],
      [FIXTURE.frames.incremental, false],
      [binary.toString('utf8'), true],
    ]);
    expect(received[2]?.data.equals(binary)).toBe(true);
    expect(JSON.parse(received[1]?.data.toString('utf8') ?? '{}')).toMatchObject({ previous_response_id: 'resp_fixture_prewarm' });
    expect(replies[0]?.data.toString('utf8')).toBe('{"type":"response.created","response":{"id":"resp_fixture_1"}}');
    expect(replies[1]?.data.equals(binary)).toBe(true);
  });

  it('returns a rejected upgrade (426) with its status and body and never upgrades', async () => {
    upgradeHandler = (_req, socket) => {
      socket.end('HTTP/1.1 426 Upgrade Required\r\ncontent-type: application/json\r\ncontent-length: 29\r\n\r\n{"detail":"upgrade required"}');
    };
    const port = await startGateway();
    const reply = await sendRawUpgrade(port);
    expect(reply).toMatchObject({ status: 426, statusMessage: 'Upgrade Required' });
    expect(reply.body.toString('utf8')).toBe('{"detail":"upgrade required"}');
    expect(getHeaderValue(reply.rawHeaders, 'content-type')).toBe('application/json');
  });

  it('caps the relayed body of a rejected upgrade at 16 KB', async () => {
    upgradeHandler = (_req, socket) => {
      socket.end(`HTTP/1.1 429 Too Many Requests\r\ncontent-length: 40000\r\n\r\n${'x'.repeat(40000)}`);
    };
    const port = await startGateway();
    const reply = await sendRawUpgrade(port);
    expect(reply.status).toBe(429);
    expect(reply.body.length).toBe(16 * 1024);
    expect(getHeaderValue(reply.rawHeaders, 'content-length')).toBe(String(16 * 1024));
  });

  it('recovers from a 401 with a refreshed token of the same account and handshakes again', async () => {
    upgradeHandler = (req, socket, head, index) => (index === 0 ? socket.end('HTTP/1.1 401 Unauthorized\r\ncontent-length: 0\r\n\r\n') : acceptUpgrade(req, socket, head, index));
    const port = await startGateway();
    const reply = await sendRawUpgrade(port);
    expect(reply.status).toBe(101);
    expect(getSentHandshakeTokens()).toEqual([`Bearer ${ACCESS_A1}`, `Bearer ${ACCESS_A2}`]);
    expect(refreshFetch).toHaveBeenCalledTimes(1);
  });

  it('refuses the upgrade when the home switches to another login during a 401', async () => {
    upgradeHandler = (_req, socket) => {
      void writeLogin(matchingAuthPath, OTHER_ACCOUNT_ID, ACCESS_B1, 'rt-b1').then(() => socket.end('HTTP/1.1 401 Unauthorized\r\ncontent-length: 0\r\n\r\n'));
    };
    const port = await startGateway();
    const reply = await sendRawUpgrade(port);
    expect(reply.status).toBe(400);
    expect(JSON.parse(reply.body.toString('utf8'))).toMatchObject({ error: { code: 'account_mismatch' } });
    expect(getSentHandshakeTokens()).toEqual([`Bearer ${ACCESS_A1}`]);
  });

  it('refuses the upgrade for another account before contacting upstream', async () => {
    const port = await startGateway();
    const reply = await sendRawUpgrade(port, setRawHeaderValues(FIXTURE.websocket.rawHeaders, new Map([['chatgpt-account-id', '00000000-0000-4000-8000-0000000000ff']])));
    expect(reply.status).toBe(400);
    expect(JSON.parse(reply.body.toString('utf8'))).toMatchObject({ error: { code: 'account_mismatch' } });
    expect(upstreamUpgrades).toHaveLength(0);
  });

  it('closes the client with the same code and reason when upstream closes', async () => {
    onUpstreamSocket = (ws) => setTimeout(() => ws.close(4001, 'upstream-bye'), 10);
    const port = await startGateway();
    const client = await openClient(port);
    const closed = await new Promise<[number, string]>((resolve) => client.on('close', (code, reason) => resolve([code, reason.toString()])));
    expect(closed).toEqual([4001, 'upstream-bye']);
  });

  it('closes upstream with the same code and reason when the client closes', async () => {
    let upstreamClosed: Promise<[number, string]> = new Promise(() => undefined);
    let upstreamSocketClosed: Promise<void> = new Promise(() => undefined);
    const connected = new Promise<void>((resolve) => {
      onUpstreamSocket = (ws) => {
        upstreamClosed = new Promise((done) => ws.on('close', (code, reason) => done([code, reason.toString()])));
        resolve();
      };
    });
    upgradeHandler = (req, socket, head, index) => {
      upstreamSocketClosed = new Promise((resolve) => socket.on('close', () => resolve()));
      acceptUpgrade(req, socket, head, index);
    };
    const port = await startGateway();
    const client = await openClient(port);
    await connected;
    client.close(4002, 'client-bye');
    expect(await upstreamClosed).toEqual([4002, 'client-bye']);
    await upstreamSocketClosed;
  });

  it('answers 504 when the upstream handshake does not finish in time, and closes the upstream attempt', async () => {
    let upstreamSocketClosed: Promise<void> = new Promise(() => undefined);
    upgradeHandler = (_req, socket) => {
      // Half-open server socket: the gateway closing its side shows up as 'end'.
      upstreamSocketClosed = new Promise((resolve) => {
        socket.on('end', () => resolve());
        socket.on('close', () => resolve());
      });
    };
    const port = await startGateway({ codexWebSocketConnectTimeoutMs: 200 });
    const reply = await sendRawUpgrade(port);
    expect(reply.status).toBe(504);
    expect(JSON.parse(reply.body.toString('utf8'))).toMatchObject({ error: { code: 'upstream_timeout' } });
    await upstreamSocketClosed;
  });

  it('uses the official 15000 ms handshake deadline in production', () => {
    expect(CODEX_WEBSOCKET_CONNECT_TIMEOUT_MS).toBe(15_000);
  });

  it('destroys a first 401 attempt whose body never ends and still upgrades on the retry', async () => {
    let firstClosed: Promise<void> = new Promise(() => undefined);
    upgradeHandler = (req, socket, head, index) => {
      if (index > 0) {
        acceptUpgrade(req, socket, head, index);
        return;
      }
      // Half-open server socket: the gateway destroying its side shows up as 'end' or 'close'.
      firstClosed = new Promise((resolve) => {
        socket.on('end', () => resolve());
        socket.on('close', () => resolve());
      });
      socket.write('HTTP/1.1 401 Unauthorized\r\nContent-Length: 100\r\n\r\nx');
    };
    const port = await startGateway();
    const reply = await sendRawUpgrade(port);
    expect(reply.status).toBe(101);
    expect(getSentHandshakeTokens()).toEqual([`Bearer ${ACCESS_A1}`, `Bearer ${ACCESS_A2}`]);
    await firstClosed;
  });

  it('answers 504 at the deadline while a slow refresh after a 401 keeps running, then sends nothing', async () => {
    upgradeHandler = (_req, socket) => socket.end('HTTP/1.1 401 Unauthorized\r\ncontent-length: 0\r\n\r\n');
    refreshFetch.mockImplementationOnce(getSlowRefresh(450));
    const port = await startGateway({ codexWebSocketConnectTimeoutMs: 80 });
    const startedAtMs = Date.now();
    const reply = await sendRawUpgrade(port);
    expect(reply.status).toBe(504);
    expect(Date.now() - startedAtMs).toBeLessThan(300);
    await wait(600);
    expect(refreshFetch).toHaveBeenCalledTimes(1);
    expect(upstreamUpgrades).toHaveLength(1);
    expect(await getSavedAccessToken(matchingAuthPath)).toBe(ACCESS_A2);
  });

  it('sends no upgrade when the client resets during a proactive refresh', async () => {
    await writeLogin(matchingAuthPath, ACCOUNT_ID, getExpiringAccessToken(), 'rt-a1');
    refreshFetch.mockImplementationOnce(getSlowRefresh(350));
    const port = await startGateway();
    const pending = sendRawUpgrade(port);
    await wait(50);
    for (const socket of sockets) socket.destroy();
    await pending;
    await wait(600);
    expect(refreshFetch).toHaveBeenCalledTimes(1);
    expect(upstreamUpgrades).toHaveLength(0);
    expect(await getSavedAccessToken(matchingAuthPath)).toBe(ACCESS_A2);
  });

  it('cancels the pending upstream handshake as soon as the client sends FIN', async () => {
    let upstreamAttemptClosed: Promise<void> = new Promise(() => undefined);
    upgradeHandler = (_req, socket) => {
      upstreamAttemptClosed = new Promise((resolve) => {
        socket.on('end', () => resolve());
        socket.on('close', () => resolve());
      });
    };
    const port = await startGateway({ codexWebSocketConnectTimeoutMs: 600 });
    const pending = sendRawUpgrade(port);
    await vi.waitFor(() => expect(upstreamUpgrades).toHaveLength(1));
    const finAtMs = Date.now();
    sockets.at(-1)?.end();
    await upstreamAttemptClosed;
    expect(Date.now() - finAtMs).toBeLessThan(300);
    await pending;
  });

  it('returns the upstream 101 head byte for byte, including a latin1 obs-text header', async () => {
    let upstreamHead = Buffer.alloc(0);
    upgradeHandler = (req, socket) => {
      const accept = createHash('sha1').update(`${req.headers['sec-websocket-key'] ?? ''}${WEBSOCKET_GUID}`).digest('base64');
      upstreamHead = Buffer.from(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\nX-Review-Text: caf\u00e9\r\n\r\n`, 'latin1');
      socket.write(upstreamHead);
    };
    const port = await startGateway();
    const reply = await sendRawUpgrade(port);
    expect(reply.status).toBe(101);
    expect(upstreamHead.includes(Buffer.from([0x63, 0x61, 0x66, 0xe9]))).toBe(true);
    expect(reply.headBytes.equals(upstreamHead)).toBe(true);
  });

  it('keeps a latin1 obs-text header byte for byte in a rejected upgrade, body unchanged', async () => {
    const body = Buffer.from('{"detail":"upgrade required"}');
    upgradeHandler = (_req, socket) => {
      socket.write(Buffer.from(`HTTP/1.1 426 Upgrade Required\r\nX-Review-Text: caf\u00e9\r\nContent-Type: application/json\r\nContent-Length: ${body.length}\r\n\r\n`, 'latin1'));
      socket.end(body);
    };
    const port = await startGateway();
    const reply = await sendRawUpgrade(port);
    expect(reply.status).toBe(426);
    expect(reply.headBytes.includes(Buffer.from('X-Review-Text: caf\u00e9\r\n', 'latin1'))).toBe(true);
    expect(reply.headBytes.includes(Buffer.from([0xc3, 0xa9]))).toBe(false);
    expect(reply.body.equals(body)).toBe(true);
  });

  describe('after the request is over, starts no new OAuth refresh (transient 503 on refresh)', () => {
    let refreshCalls: RefreshCall[] = [];
    beforeEach(() => {
      vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      refreshCalls = [];
      refreshFetch.mockImplementation(getTransientRefresh(170, refreshCalls));
    });
    afterEach(() => {
      refreshFetch.mockImplementation(defaultRefresh);
    });

    it('single home, the deadline passes during the refresh', async () => {
      await writeLogin(matchingAuthPath, ACCOUNT_ID, getExpiringAccessToken(), 'rt-a1');
      const port = await startGateway({ accounts: [makeCodexAccount('codex1', matchingAuthPath)], codexWebSocketConnectTimeoutMs: 80 });
      const reply = await sendRawUpgrade(port);
      const endedAtMs = Date.now();
      expect(reply.status).toBe(504);
      await wait(450);
      expect(refreshCalls.map((call) => call.refreshToken)).toEqual(['rt-a1']);
      expect(refreshCalls.every((call) => call.atMs <= endedAtMs)).toBe(true);
      expect(upstreamUpgrades).toHaveLength(0);
    });

    it('single home, the client resets during the refresh', async () => {
      await writeLogin(matchingAuthPath, ACCOUNT_ID, getExpiringAccessToken(), 'rt-a1');
      const port = await startGateway({ accounts: [makeCodexAccount('codex1', matchingAuthPath)] });
      const pending = sendRawUpgrade(port);
      await wait(50);
      for (const socket of sockets) socket.destroy();
      const endedAtMs = Date.now();
      await pending;
      await wait(450);
      expect(refreshCalls.map((call) => call.refreshToken)).toEqual(['rt-a1']);
      expect(refreshCalls.every((call) => call.atMs <= endedAtMs)).toBe(true);
      expect(upstreamUpgrades).toHaveLength(0);
    });

    it('two homes, the deadline passes while the first (non-matching) home refreshes', async () => {
      await writeLogin(otherAuthPath, OTHER_ACCOUNT_ID, getExpiringAccessToken(), 'rt-b1');
      await writeLogin(matchingAuthPath, ACCOUNT_ID, getExpiringAccessToken(), 'rt-a1');
      const port = await startGateway({ codexWebSocketConnectTimeoutMs: 80 });
      const reply = await sendRawUpgrade(port);
      const endedAtMs = Date.now();
      expect(reply.status).toBe(504);
      await wait(450);
      // The scan stops at the first home: the second home is never read, let alone refreshed.
      expect(refreshCalls.map((call) => call.refreshToken)).toEqual(['rt-b1']);
      expect(refreshCalls.every((call) => call.atMs <= endedAtMs)).toBe(true);
      expect(upstreamUpgrades).toHaveLength(0);
    });
  });

  it('refuses the upgrade with 403 when AGENT_GATEWAY_API_KEY is set', async () => {
    const port = await startGateway({ apiKey: 'gateway-test-key' });
    const reply = await sendRawUpgrade(port);
    expect(reply.status).toBe(403);
    expect(JSON.parse(reply.body.toString('utf8'))).toMatchObject({ error: { type: 'permission_error', code: 'api_key_unsupported' } });
    expect(upstreamUpgrades).toHaveLength(0);
  });

  it.each([
    ['a path outside the relay', '/v1/responses', FIXTURE.websocket.rawHeaders, 404],
    ['a non-loopback Host', FIXTURE.websocket.path, FIXTURE.websocket.rawHeaders.map((entry, index, all) => (index % 2 === 1 && all[index - 1] === 'host' ? 'evil.example' : entry)), 403],
  ])('refuses an upgrade on %s', async (_name, requestPath, rawHeaders, status) => {
    const port = await startGateway();
    const socket = connect(port, '127.0.0.1');
    sockets.push(socket);
    const lines = [`GET ${requestPath} HTTP/1.1`];
    const headers = requestPath === FIXTURE.websocket.path ? rawHeaders : setRawHeaderValues(rawHeaders, new Map([['host', `127.0.0.1:${port}`]]));
    for (let index = 0; index < headers.length; index += 2) lines.push(`${headers[index]}: ${headers[index + 1]}`);
    socket.write(`${lines.join('\r\n')}\r\n\r\n`);
    const replyText = await new Promise<string>((resolve) => {
      let text = '';
      socket.on('data', (chunk: Buffer) => (text += chunk.toString('utf8')));
      socket.on('end', () => resolve(text));
    });
    expect(replyText.startsWith(`HTTP/1.1 ${status} `)).toBe(true);
    expect(upstreamUpgrades).toHaveLength(0);
  });
});
