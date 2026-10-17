// previous_response_id over the Codex path. The expansion is project-owned; the upstream call must
// be the one the pinned Codex HTTP path sends for a full history: references/codex @0d58012ec2
// codex-rs/core/src/client.rs builds ResponsesApiRequest with the full input and store:false, and
// only the WebSocket path (codex-api/src/endpoint/responses_websocket.rs) carries the id.
// The upstream is a mocked fetch serving test/fixtures/text-nonlite.sse and tool-call-lite.sse.
// The login guard at send time mirrors the client.rs:1787 auth owner guard.
import { mkdtemp, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Account } from '../../src/accounts.js';
import { createAuthManager } from '../../src/auth/authManager.js';
import { getConfig } from '../../src/config.js';
import { RESPONSES_LITE_HEADER } from '../../src/constants.js';
import { createModelCatalog } from '../../src/models.js';
import { createProxyServer } from '../../src/server.js';
import type { AuthFile, Json, OpenAiErrorBody } from '../../src/types.js';
import { createCodexClient } from '../../src/upstream/codexClient.js';
import { readFixture, toJwt } from '../helpers.js';

const TEXT_RESPONSE_ID = 'resp_00b42bb7cb1eaf27016ace4f5f8bbc81918f4b069de93eb412';
const TOOL_RESPONSE_ID = 'resp_0d433a8d6ab108c2016ace4faa9ac0819187dc62f4fe860ae3';

const userMessage = (text: string): Json => ({ type: 'message', role: 'user', content: [{ type: 'input_text', text }] });
const WEATHER_TOOL: Json = { type: 'function', name: 'get_weather', parameters: { type: 'object', properties: { city: { type: 'string' } } } };

type UpstreamCall = { body: Json; headers: Record<string, string> };
const upstreamCalls: UpstreamCall[] = [];
// Upstream bodies served in order; once empty, every call gets the text fixture.
let upstreamBodies: Array<string | ReadableStream<Uint8Array>> = [];
// Login account of the mocked home; a test switches it to simulate a relogin without a restart.
let accountId: string | undefined;
const fetchFn = vi.fn<typeof fetch>(async (_input, init) => {
  upstreamCalls.push({ body: JSON.parse(String(init?.body)) as Json, headers: init?.headers as Record<string, string> });
  return new Response(upstreamBodies.shift() ?? readFixture('text-nonlite.sse'));
});

let server: Server;
let baseUrl = '';

// A fresh server per test: each server owns its store, so no record leaks between cases.
beforeEach(async () => {
  upstreamCalls.length = 0;
  upstreamBodies = [];
  accountId = undefined;
  const config = getConfig({}, ['/tmp/previous-response-test']);
  const account: Account = {
    provider: 'codex',
    alias: 'codex1',
    homePath: '/tmp/previous-response-test',
    catalog: createModelCatalog({ getModels: async () => [{ slug: 'gpt-x' }, { slug: 'gpt-lite', use_responses_lite: true }] }),
    client: createCodexClient({
      auth: {
        getCredentials: async () => ({ accessToken: 'test-token', accountId, isFedramp: false }),
        recoverUnauthorized: async () => ({ accessToken: 'test-token', isFedramp: false }),
      },
      config,
      authPath: '/tmp/previous-response-test/auth.json',
      fetchFn,
    }),
  };
  server = createProxyServer({ accounts: [account], contextLength: config.contextLength });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
});

afterEach(() => {
  server.closeAllConnections();
  server.close();
});

const post = (body: Json, base = baseUrl): Promise<Response> =>
  fetch(`${base}/responses`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

const getErrorBody = async (response: Response): Promise<OpenAiErrorBody['error']> => ((await response.json()) as OpenAiErrorBody).error;

describe('previous_response_id on the Codex path', () => {
  it('sends the same upstream request as a client that resends the full history', async () => {
    const firstInput = [userMessage('ping')];
    const first = (await (await post({ model: 'codex1/gpt-x', instructions: 'Be brief.', input: firstInput })).json()) as Json;
    expect(first.id).toBe(TEXT_RESPONSE_ID);
    const firstOutput = first.output as Json[];
    expect(firstOutput.map((item) => item.type)).toEqual(['reasoning', 'message']);

    const second = await post({ model: 'codex1/gpt-x', instructions: 'Be brief.', previous_response_id: TEXT_RESPONSE_ID, input: 'again' });
    expect(second.status).toBe(200);
    const expanded = upstreamCalls[1];
    expect(expanded?.body.input).toEqual([...firstInput, ...firstOutput, userMessage('again')]);
    expect(expanded?.body.store).toBe(false);
    expect(expanded?.body).not.toHaveProperty('previous_response_id');

    await post({ model: 'codex1/gpt-x', instructions: 'Be brief.', input: [...firstInput, ...firstOutput, userMessage('again')] });
    expect(upstreamCalls[2]).toEqual(expanded);
  });

  it('keeps the record before the client sees response.completed on a stream', async () => {
    const fixture = readFixture('text-nonlite.sse');
    let closeUpstream = (): void => undefined;
    upstreamBodies = [
      new ReadableStream<Uint8Array>({
        start: (controller) => {
          controller.enqueue(new TextEncoder().encode(fixture));
          closeUpstream = () => controller.close();
        },
      }),
    ];
    const first = await post({ model: 'codex1/gpt-x', input: 'ping', stream: true });
    const reader = (first.body as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    let streamed = '';
    while (!streamed.includes('event: response.completed\n') || !streamed.endsWith('\n\n')) {
      const { value } = await reader.read();
      streamed += decoder.decode(value, { stream: true });
    }

    // The upstream stream is still open, so only a save made before the write can serve this.
    const second = await post({ model: 'codex1/gpt-x', previous_response_id: TEXT_RESPONSE_ID, input: 'again' });
    expect(second.status).toBe(200);
    expect((upstreamCalls[1]?.body.input as Json[]).at(-1)).toEqual(userMessage('again'));

    closeUpstream();
    for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) streamed += decoder.decode(chunk.value, { stream: true });
    // Raw passthrough stays byte for byte.
    expect(streamed).toBe(fixture);
  });

  it('continues a Responses Lite tool call with additional_tools still first', async () => {
    upstreamBodies = [readFixture('tool-call-lite.sse')];
    const firstInput = [userMessage('weather?')];
    const first = (await (await post({ model: 'codex1/gpt-lite', input: firstInput, tools: [WEATHER_TOOL] })).json()) as Json;
    expect(first.id).toBe(TOOL_RESPONSE_ID);
    const functionCall = (first.output as Json[])[0] as Json;
    expect(functionCall.type).toBe('function_call');

    const toolOutput = { type: 'function_call_output', call_id: functionCall.call_id, output: 'sunny' };
    const second = await post({ model: 'codex1/gpt-lite', previous_response_id: TOOL_RESPONSE_ID, input: [toolOutput], tools: [WEATHER_TOOL] });
    expect(second.status).toBe(200);
    const expanded = upstreamCalls[1];
    expect((expanded?.body.input as Json[]).map((item) => item.type)).toEqual(['additional_tools', 'message', 'function_call', 'function_call_output']);
    expect(expanded?.body.store).toBe(false);
    expect(expanded?.body).not.toHaveProperty('previous_response_id');
    expect(expanded?.headers[RESPONSES_LITE_HEADER]).toBe('true');

    await post({ model: 'codex1/gpt-lite', input: [...firstInput, functionCall, toolOutput], tools: [WEATHER_TOOL] });
    expect(upstreamCalls[2]).toEqual(expanded);
  });

  // Cache stability across a continuation: the official client treats a changed prompt_cache_key as
  // a reason the previous turn cannot be reused (references/codex @0d58012ec2
  // codex-rs/core/src/client.rs:448), so the key, the session headers and the request properties
  // must stay the same while turn 1's input stays a prefix of turn 2's.
  const expectStableCachePrefix = (first: UpstreamCall | undefined, second: UpstreamCall | undefined): void => {
    expect(typeof first?.body.prompt_cache_key).toBe('string');
    expect(second?.body.prompt_cache_key).toBe(first?.body.prompt_cache_key);
    for (const name of ['session-id', 'thread-id', 'x-client-request-id']) {
      expect(first?.headers[name]).toBe(first?.body.prompt_cache_key);
      expect(second?.headers[name]).toBe(first?.headers[name]);
    }
    const firstInput = first?.body.input as Json[];
    const secondInput = second?.body.input as Json[];
    expect(secondInput.length).toBeGreaterThan(firstInput.length);
    expect(secondInput.slice(0, firstInput.length)).toEqual(firstInput);
    for (const key of ['instructions', 'tools', 'reasoning', 'include']) expect(second?.body[key]).toEqual(first?.body[key]);
  };

  it('keeps the cache key, session headers and input prefix stable across a continuation', async () => {
    const turn = { model: 'codex1/gpt-x', instructions: 'Be brief.', tools: [WEATHER_TOOL], reasoning: { effort: 'low' } };
    expect((await post({ ...turn, input: [userMessage('ping')] })).status).toBe(200);
    expect((await post({ ...turn, previous_response_id: TEXT_RESPONSE_ID, input: 'again' })).status).toBe(200);
    expect(upstreamCalls[0]?.body.instructions).toBe('Be brief.');
    expect(upstreamCalls[0]?.body.tools).toEqual([WEATHER_TOOL]);
    // The prefix must be the real first turn, never an empty input.
    expect(upstreamCalls[0]?.body.input).toEqual([userMessage('ping')]);
    expectStableCachePrefix(upstreamCalls[0], upstreamCalls[1]);
  });

  it('keeps the Responses Lite cache prefix stable with additional_tools first in both turns', async () => {
    upstreamBodies = [readFixture('tool-call-lite.sse')];
    const turn = { model: 'codex1/gpt-lite', instructions: 'Be brief.', tools: [WEATHER_TOOL] };
    const first = (await (await post({ ...turn, input: [userMessage('weather?')] })).json()) as Json;
    const functionCall = (first.output as Json[])[0] as Json;
    const toolOutput = { type: 'function_call_output', call_id: functionCall.call_id, output: 'sunny' };
    expect((await post({ ...turn, previous_response_id: TOOL_RESPONSE_ID, input: [toolOutput] })).status).toBe(200);
    const [firstTools, ...firstUserItems] = upstreamCalls[0]?.body.input as Json[];
    const secondTools = (upstreamCalls[1]?.body.input as Json[])[0];
    expect(firstTools?.type).toBe('additional_tools');
    expect(firstUserItems).toEqual([userMessage('weather?')]);
    expect(secondTools).toEqual(firstTools);
    expectStableCachePrefix(upstreamCalls[0], upstreamCalls[1]);
  });

  it('rejects a continuation after the home relogs into another account, before any upstream call', async () => {
    accountId = 'acct-A';
    expect((await post({ model: 'codex1/gpt-x', input: 'private prompt of A' })).status).toBe(200);
    expect(upstreamCalls[0]?.headers['chatgpt-account-id']).toBe('acct-A');

    accountId = 'acct-B';
    const relogin = await post({ model: 'codex1/gpt-x', previous_response_id: TEXT_RESPONSE_ID, input: 'again' });
    expect(relogin.status).toBe(400);
    expect((await getErrorBody(relogin)).message).toBe(`Previous response with id '${TEXT_RESPONSE_ID}' was created under another login; start a new conversation.`);
    expect(upstreamCalls).toHaveLength(1);
  });

  it('rejects a continuation of a store:false response and an unknown id before any upstream call', async () => {
    expect((await post({ model: 'codex1/gpt-x', input: 'ping', store: false })).status).toBe(200);
    const afterUnstored = await post({ model: 'codex1/gpt-x', previous_response_id: TEXT_RESPONSE_ID, input: 'again' });
    expect(afterUnstored.status).toBe(400);
    expect(await getErrorBody(afterUnstored)).toEqual({
      message: `Previous response with id '${TEXT_RESPONSE_ID}' not found.`,
      code: 'previous_response_not_found',
      type: 'invalid_request_error',
      param: null,
    });

    const unknown = await post({ model: 'codex1/gpt-x', previous_response_id: 'resp_unknown', input: 'again' });
    expect(unknown.status).toBe(400);
    expect((await getErrorBody(unknown)).code).toBe('previous_response_not_found');
    expect(upstreamCalls).toHaveLength(1);
  });
});

// The real auth manager over a temp auth.json, so credential caching, refresh and the 401
// recovery all run as in production; only OAuth and inference are mocked.
describe('previous_response_id with the real Codex auth manager', () => {
  const REFRESH_URL = 'https://auth.test/oauth/token';
  const config = getConfig({}, ['/tmp/previous-response-auth-test']);
  const realServers: Server[] = [];
  afterEach(() => {
    for (const realServer of realServers.splice(0)) {
      realServer.closeAllConnections();
      realServer.close();
    }
  });

  // 3600s stays clear of refresh; 60s is inside the 5-minute refresh window.
  const toAccessToken = (owner: string, expiresInSeconds = 3600): string => toJwt({ owner, exp: Math.floor(Date.now() / 1000) + expiresInSeconds });
  const toAuthFile = (accessToken: string, accountId: string): AuthFile => ({
    auth_mode: 'chatgpt',
    tokens: { id_token: toJwt({}), access_token: accessToken, refresh_token: `rt-${accountId}`, account_id: accountId },
  });

  // OAuth always answers 503 (a transient refresh failure); inference is answered by the test.
  const startRealAuthServer = async (auth: AuthFile, answerInference: (accessToken: string) => Response) => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'agent-gateway-previous-auth-'));
    const authPath = path.join(home, 'auth.json');
    await writeFile(authPath, JSON.stringify(auth));
    const calls = { oauth: 0, inferenceAccountIds: [] as Array<string | undefined> };
    const realFetch = async (input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> => {
      if (String(input) === REFRESH_URL) {
        calls.oauth += 1;
        return new Response('unavailable', { status: 503 });
      }
      const headers = init?.headers as Record<string, string>;
      calls.inferenceAccountIds.push(headers['chatgpt-account-id']);
      return answerInference(headers.authorization?.replace(/^Bearer /, '') ?? '');
    };
    const account: Account = {
      provider: 'codex',
      alias: 'codex1',
      homePath: home,
      catalog: createModelCatalog({ getModels: async () => [{ slug: 'gpt-x' }] }),
      client: createCodexClient({ auth: createAuthManager({ authPath, refreshUrl: REFRESH_URL, fetchFn: realFetch }), config, authPath, fetchFn: realFetch }),
    };
    const realServer = createProxyServer({ accounts: [account], contextLength: config.contextLength });
    await new Promise<void>((resolve) => realServer.listen(0, '127.0.0.1', resolve));
    realServers.push(realServer);
    return { url: `http://127.0.0.1:${(realServer.address() as AddressInfo).port}/v1`, authPath, calls };
  };

  it('aborts instead of resending the history when the 401 recovery picks up another login', async () => {
    const tokenA = toAccessToken('A');
    let isTokenARevoked = false;
    const { url, authPath, calls } = await startRealAuthServer(toAuthFile(tokenA, 'acct-A'), (accessToken) =>
      accessToken === tokenA && isTokenARevoked ? new Response('unauthorized', { status: 401 }) : new Response(readFixture('text-nonlite.sse')),
    );
    expect((await post({ model: 'codex1/gpt-x', input: 'private prompt of A' }, url)).status).toBe(200);

    // The home relogs into B on disk while the gateway still caches A; then A's token is revoked.
    await writeFile(authPath, JSON.stringify(toAuthFile(toAccessToken('B'), 'acct-B')));
    isTokenARevoked = true;
    const relogin = await post({ model: 'codex1/gpt-x', previous_response_id: TEXT_RESPONSE_ID, input: 'again' }, url);
    expect(relogin.status).toBe(400);
    expect((await getErrorBody(relogin)).message).toBe(`Previous response with id '${TEXT_RESPONSE_ID}' was created under another login; start a new conversation.`);
    // The first send used cached A and got 401; the retry with B was stopped before fetch.
    expect(calls.inferenceAccountIds).toEqual(['acct-A', 'acct-A']);
    expect(calls.oauth).toBe(0);
  });

  it('keeps one OAuth call per request when the token is in the refresh window and OAuth fails', async () => {
    const { url, calls } = await startRealAuthServer(toAuthFile(toAccessToken('A', 60), 'acct-A'), () => new Response(readFixture('text-nonlite.sse')));
    expect((await post({ model: 'codex1/gpt-x', input: 'ping' }, url)).status).toBe(200);
    expect(calls.oauth).toBe(1);
    expect(calls.inferenceAccountIds).toEqual(['acct-A']);
  });

  it('rejects invalid input with 400 before any OAuth or inference call', async () => {
    // The token is in the refresh window, so any credential read would show up as an OAuth call.
    const { url, calls } = await startRealAuthServer(toAuthFile(toAccessToken('A', 60), 'acct-A'), () => new Response(readFixture('text-nonlite.sse')));
    expect((await post({ model: 'codex1/gpt-x', input: 7 }, url)).status).toBe(400);
    expect(calls.oauth).toBe(0);
    expect(calls.inferenceAccountIds).toEqual([]);
  });
});
