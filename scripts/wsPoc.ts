// Phase 1A-0 spike: replay the official Codex WebSocket handshake and frames against the
// ChatGPT backend with this login's own OAuth token. Spends quota, so only a human runs it.
// Standalone on purpose (imports nothing from src). Never prints tokens.
//   npm run poc:ws                                        # reads ~/.codex/auth.json
//   npm run poc:ws -- --codex-home <path> [--model gpt-6.1-sol] [--lite | --no-lite]
// Shapes mirror the Codex CLI 0.163.0 `codex exec` captures (.tmp/codex-ws-capture.md),
// checked against references/codex @ 0d58012ec2.
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import type { IncomingMessage } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import WebSocket from 'ws';

type Json = Record<string, unknown>;

type AuthFile = Json & {
  auth_mode?: string;
  tokens?: Json & {
    id_token: string;
    access_token: string;
    refresh_token?: string;
    account_id?: string;
  };
};

type WsEvent = Json & { type: string };

type Handshake = {
  status: number;
  hasTurnState: boolean;
  hasOpenaiModel: boolean;
  errorBody?: string;
  error?: string;
};

type Connection = { socket?: WebSocket; handshake: Handshake };

type Turn = { requestKind: 'prewarm' | 'turn'; turnId: string; startedAtMs?: number };

type StepPlan = {
  name: string;
  requestKind: Turn['requestKind'];
  input: Json[];
  // chain: the previous step's response id; missing: an id the backend never issued.
  previousResponse: 'none' | 'chain' | 'missing';
  expectedText?: string;
};

type StepResult = {
  name: string;
  connection: number;
  isNewConnection: boolean;
  skipReason?: string;
  endReason?: string;
  eventTypes: string[];
  finalStatus?: string;
  errorCode?: string;
  errorMessage?: string;
  responseId?: string;
  outputText?: string;
  expectedText?: string;
  isTextMatched?: boolean;
  cachedTokens?: number;
};

const WS_URL = 'wss://chatgpt.com/backend-api/codex/responses';
const CLIENT_VERSION = '0.163.0';
// Mirrors references/codex/codex-rs/exec/ default originator and app-server client name.
const ORIGINATOR = 'codex_exec';
// Mirrors references/codex/codex-rs/core/src/client.rs RESPONSES_WEBSOCKETS_V2_BETA_HEADER_VALUE.
const OPENAI_BETA = 'responses_websockets=2026-02-06';
// Mirrors references/codex/codex-rs/core/src/client.rs WS_REQUEST_HEADER_RESPONSES_LITE_CLIENT_METADATA_KEY.
const LITE_CLIENT_METADATA_KEY = 'ws_request_header_x_openai_internal_codex_responses_lite';
const REASONING_EFFORT = 'medium';
// Mirrors references/codex/codex-rs/model-provider-info/ DEFAULT_WEBSOCKET_CONNECT_TIMEOUT_MS.
const HANDSHAKE_TIMEOUT_MS = 15_000;
const STEP_TIMEOUT_MS = 120_000;
const CLOSE_TIMEOUT_MS = 5_000;
const MAX_REJECTED_BODY_BYTES = 16 * 1024;
// Mirrors references/codex/codex-rs/codex-api/src/ (sse/responses.rs, endpoint/responses_websocket.rs).
const TERMINAL_EVENT_TYPES = new Set(['response.completed', 'response.incomplete', 'response.failed', 'error']);
// Any other ending is an error there, and responses_websocket.rs drops that socket (`guard.take()`).
const REUSABLE_END_REASONS = new Set(['response.completed', 'response.incomplete']);
const ROOT_DIR = path.join(import.meta.dirname, '..');
const RESULT_PATH = path.join(ROOT_DIR, '.tmp', 'ws-poc-results.json');

const { values } = parseArgs({
  args: process.argv.slice(2),
  allowNegative: true,
  options: {
    'codex-home': { type: 'string' },
    model: { type: 'string' },
    lite: { type: 'boolean' },
  },
});
const codexHome = path.resolve(values['codex-home'] ?? path.join(os.homedir(), '.codex'));
const model = values.model ?? 'gpt-6.1-sol';
// The Lite families in this account's models_cache.json; --lite / --no-lite override.
const isLite = values.lite ?? /^gpt-(?:6|5\.6)/.test(model);
const authPath = path.join(codexHome, 'auth.json');

// V8 parse errors quote their input, so never let one escape with token text in it.
const parseSecretJson = (text: string, label: string): Json => {
  try {
    return JSON.parse(text) as Json;
  } catch {
    throw new Error(`${label} is not valid JSON`);
  }
};

const decodeJwtPayload = (jwt: string): Json =>
  parseSecretJson(Buffer.from(jwt.split('.')[1] ?? '', 'base64url').toString('utf8'), 'token payload');

const authFile = parseSecretJson(await readFile(authPath, 'utf8'), authPath) as AuthFile;
if (authFile.auth_mode !== 'chatgpt' || !authFile.tokens) {
  throw new Error(`${authPath} is not a ChatGPT login; run: CODEX_HOME=${codexHome} codex login`);
}
const tokens = authFile.tokens;
const secrets = [tokens.access_token, tokens.id_token, tokens.refresh_token].filter(
  (secret): secret is string => typeof secret === 'string' && secret !== '',
);

// Exact tokens first, then any JWT-shaped run, so a server-clipped echo is masked too.
// External strings go through this before any clipping; every output goes through it again.
const redact = (text: string): string =>
  secrets
    .reduce((masked, secret) => masked.replaceAll(secret, '<redacted>'), text)
    .replace(/eyJ[\w-]{10,}(?:\.[\w-]*){0,2}/g, '<redacted>');

const log = (text: string): void => {
  console.log(redact(text));
};

const authClaims = (decodeJwtPayload(tokens.id_token)['https://api.openai.com/auth'] ?? {}) as Json;
const accountId = tokens.account_id ?? String(authClaims.chatgpt_account_id ?? '');
const isFedramp = authClaims.chatgpt_account_is_fedramp === true;
const accessExpMs = Number(decodeJwtPayload(tokens.access_token).exp ?? 0) * 1000;

log('## Auth');
log(`auth file: ${authPath}`);
log(`account id present: ${accountId !== ''}`);
log(`fedramp: ${isFedramp}`);
log(`access token expires: ${new Date(accessExpMs).toISOString()}`);
if (accessExpMs <= Date.now()) {
  console.error('Access token has expired; refresh this login first, then rerun.');
  process.exit(1);
}

// Mirrors references/codex/codex-rs/core/src/installation_id.rs file name.
const installationId =
  (await readFile(path.join(codexHome, 'installation_id'), 'utf8').catch(() => '')).trim() || randomUUID();

// Mirrors os_info in references/codex/codex-rs/login/src/auth/default_client.rs ("Ubuntu 26.4.0").
const osRelease = process.platform === 'linux' ? await readFile('/etc/os-release', 'utf8').catch(() => '') : '';
const osName = /^NAME="?([^"\n]*)"?$/m.exec(osRelease)?.[1];
const osVersionId = /^VERSION_ID="?([^"\n]*)"?$/m.exec(osRelease)?.[1];
const osVersion =
  osVersionId && /^\d+(\.\d+)*$/.test(osVersionId)
    ? [...osVersionId.split('.').map(Number), 0, 0].slice(0, 3).join('.')
    : osVersionId;
const osLabel = osName && osVersion ? `${osName} ${osVersion}` : `${os.type()} ${os.release()}`;
// Mirrors only the TERM_PROGRAM / TERM branches of references/codex/codex-rs/terminal-detection/.
const termProgram = process.env.TERM_PROGRAM?.toLowerCase() === 'tmux' ? undefined : process.env.TERM_PROGRAM;
const terminal = termProgram
  ? [termProgram, process.env.TERM_PROGRAM_VERSION].filter(Boolean).join('/')
  : process.env.TERM || 'unknown';
// Suffix comes from the app-server client info `codex exec` registers (name; version).
const userAgent = `${ORIGINATOR}/${CLIENT_VERSION} (${osLabel}; ${os.machine()}) ${terminal} (${ORIGINATOR}; ${CLIENT_VERSION})`.replace(
  /[^ -~]/g,
  '_',
);

const sessionId = randomUUID();
const windowId = `${sessionId}:0`;
const contextWindowId = randomUUID();

// Field set and order follow the captured x-codex-turn-metadata (prewarm vs turn).
const getTurnMetadata = (turn: Turn): string => {
  const isTurn = turn.requestKind === 'turn';
  return JSON.stringify({
    installation_id: installationId,
    session_id: sessionId,
    thread_id: sessionId,
    agent_name: '/root',
    turn_id: turn.turnId,
    window_id: windowId,
    window_number: 0,
    context_window_id: contextWindowId,
    request_kind: turn.requestKind,
    history_initialization: 'new',
    ...(isTurn ? { root_turn_id: turn.turnId } : {}),
    thread_source: 'user',
    ...(isTurn ? { turn_trigger: 'exec' } : {}),
    sandbox: 'seccomp',
    sandbox_mode: 'read-only',
    auto_review_enabled: false,
    node_repl_auto_review_required: false,
    node_repl_disabled: false,
    ...(isTurn ? { turn_started_at_unix_ms: turn.startedAtMs } : {}),
    analytics_enabled: true,
    model,
    reasoning_effort: REASONING_EFFORT,
  });
};

// Order follows the official-route capture. Like core/src/client.rs connect_websocket, every
// connect (prewarm or a later reconnect) carries the metadata of the request that opened it.
const getHandshakeHeaders = (turn: Turn): Record<string, string> => ({
  ...(accountId ? { 'chatgpt-account-id': accountId } : {}),
  ...(isFedramp ? { 'x-openai-fedramp': 'true' } : {}),
  authorization: `Bearer ${tokens.access_token}`,
  'user-agent': userAgent,
  originator: ORIGINATOR,
  'openai-beta': OPENAI_BETA,
  // Mirrors references/codex/codex-rs/model-provider-info/ OpenAI provider http_headers.
  version: CLIENT_VERSION,
  'x-codex-beta-features': 'remote_compaction_v2',
  'x-client-request-id': sessionId,
  'session-id': sessionId,
  'thread-id': sessionId,
  'x-codex-window-id': windowId,
  'x-codex-turn-metadata': getTurnMetadata(turn),
  // Mirrors references/codex/codex-rs/core/src/client.rs build_routing_hint_header (no service tier).
  'x-codex-routing-hint': `model=${model}`,
});

const toMessage = (role: string, text: string): Json => ({
  type: 'message',
  role,
  content: [{ type: 'input_text', text }],
});

// Lite rules mirror references/codex/codex-rs/core/src/client.rs build_responses_request and
// build_ws_client_metadata: no top-level tools (additional_tools only when tools exist),
// parallel_tool_calls off, reasoning.context all_turns, and the Lite client_metadata flag.
const getFrame = (turn: Turn, input: Json[], previousResponseId: string | undefined): Json => {
  const isPrewarm = turn.requestKind === 'prewarm';
  return {
    type: 'response.create',
    model,
    stream: true,
    ...(previousResponseId === undefined ? {} : { previous_response_id: previousResponseId }),
    input,
    ...(isLite ? {} : { tools: [] }),
    tool_choice: 'auto',
    parallel_tool_calls: !isLite,
    reasoning: isLite ? { effort: REASONING_EFFORT, context: 'all_turns' } : { effort: REASONING_EFFORT },
    store: false,
    include: ['reasoning.encrypted_content'],
    prompt_cache_key: sessionId,
    text: { verbosity: 'low' },
    ...(isPrewarm ? { generate: false } : {}),
    client_metadata: {
      'x-codex-installation-id': installationId,
      session_id: sessionId,
      thread_id: sessionId,
      'x-codex-window-id': windowId,
      turn_id: turn.turnId,
      ...(isPrewarm ? {} : { root_turn_id: turn.turnId }),
      'x-codex-turn-metadata': getTurnMetadata(turn),
      'x-codex-ws-stream-request-start-ms': String(Date.now()),
      ...(isLite ? { [LITE_CLIENT_METADATA_KEY]: 'true' } : {}),
    },
  };
};

const sockets: WebSocket[] = [];

const toHandshake = (response: IncomingMessage): Handshake => ({
  status: response.statusCode ?? 0,
  hasTurnState: response.headers['x-codex-turn-state'] !== undefined,
  hasOpenaiModel: response.headers['openai-model'] !== undefined,
});

// One absolute deadline covers the whole connect, including reading a rejected body; the
// result settles once and a failed connect tears down its request, response and socket.
const connect = (turn: Turn): Promise<Connection> =>
  new Promise((resolve) => {
    const socket = new WebSocket(WS_URL, {
      headers: getHandshakeHeaders(turn),
      // Same offer as the raw capture: "permessage-deflate; client_max_window_bits". ws offers the
      // bare parameter for `true`; @types/ws only types the numeric form.
      perMessageDeflate: { clientMaxWindowBits: true as unknown as number },
    });
    sockets.push(socket);
    let isSettled = false;
    let rejectedResponse: IncomingMessage | undefined;
    const bodyChunks: Buffer[] = [];
    let bodyBytes = 0;

    const settle = (connection: Connection): void => {
      if (isSettled) return;
      isSettled = true;
      clearTimeout(deadline);
      if (!connection.socket) {
        // terminate() aborts the pending upgrade request and destroys the TCP socket.
        socket.terminate();
        rejectedResponse?.destroy();
      }
      resolve(connection);
    };
    const fail = (note?: string): void => {
      settle({
        handshake: {
          ...(rejectedResponse
            ? {
                ...toHandshake(rejectedResponse),
                errorBody: redact(Buffer.concat(bodyChunks).toString('utf8')).slice(0, 600),
              }
            : { status: 0, hasTurnState: false, hasOpenaiModel: false }),
          ...(note === undefined ? {} : { error: redact(note) }),
        },
      });
    };

    const deadline = setTimeout(() => fail('handshake deadline exceeded'), HANDSHAKE_TIMEOUT_MS);
    // Kept for the socket's whole life so late errors never crash the process.
    socket.on('error', (error) => fail(String(error)));
    socket.once('close', (code) => fail(`closed ${code} before open`));
    socket.once('upgrade', (response) => {
      socket.once('open', () => settle({ socket, handshake: toHandshake(response) }));
    });
    // Rejected upgrade (401, 426, ...): keep a capped body for the report.
    socket.once('unexpected-response', (_request, response) => {
      rejectedResponse = response;
      response.on('data', (chunk: Buffer) => {
        bodyChunks.push(chunk.subarray(0, Math.max(0, MAX_REJECTED_BODY_BYTES - bodyBytes)));
        bodyBytes += chunk.length;
        if (bodyBytes >= MAX_REJECTED_BODY_BYTES) fail('rejected body exceeded size cap');
      });
      response.once('end', () => fail());
      response.once('aborted', () => fail('rejected body aborted'));
      response.once('error', (error) => fail(String(error)));
      response.once('close', () => fail('rejected body closed before end'));
    });
  });

const sendFrame = (socket: WebSocket, frame: Json): Promise<{ events: WsEvent[]; endReason: string }> =>
  new Promise((resolve) => {
    const events: WsEvent[] = [];
    const finish = (endReason: string): void => {
      clearTimeout(timer);
      socket.off('message', handleMessage);
      socket.off('close', handleClose);
      // Retired sockets also keep late events from leaking into the next step.
      if (!REUSABLE_END_REASONS.has(endReason)) socket.terminate();
      resolve({ events, endReason });
    };
    const handleMessage = (data: WebSocket.RawData, isBinary: boolean): void => {
      if (isBinary) {
        finish('unexpected binary frame');
        return;
      }
      let event: WsEvent;
      try {
        event = JSON.parse(data.toString()) as WsEvent;
      } catch {
        return;
      }
      events.push(event);
      if (TERMINAL_EVENT_TYPES.has(event.type)) finish(event.type);
    };
    const handleClose = (code: number, reason: Buffer): void => {
      finish(`closed ${code} ${reason.toString()}`.trim());
    };
    const timer = setTimeout(() => finish('timeout'), STEP_TIMEOUT_MS);
    socket.on('message', handleMessage);
    socket.on('close', handleClose);
    socket.send(JSON.stringify(frame), (error) => {
      if (error) finish(`send failed: ${error.message}`);
    });
  });

const runStep = async (
  socket: WebSocket,
  plan: StepPlan,
  turn: Turn,
  previousResponseId: string | undefined,
  connection: Pick<StepResult, 'connection' | 'isNewConnection'>,
): Promise<StepResult> => {
  process.stdout.write(`- ${plan.name} ... `);
  const { events, endReason } = await sendFrame(socket, getFrame(turn, plan.input, previousResponseId));

  const eventTypes = events
    .reduce<Array<[string, number]>>((runs, event) => {
      const lastRun = runs.at(-1);
      if (lastRun?.[0] === event.type) lastRun[1] += 1;
      else runs.push([event.type, 1]);
      return runs;
    }, [])
    .map(([type, count]) => (count === 1 ? type : `${type} x${count}`));
  const terminalEvent = events.find((event) => TERMINAL_EVENT_TYPES.has(event.type));
  const response = terminalEvent?.type === 'error' ? undefined : (terminalEvent?.response as Json | undefined);
  // Wrapped WS errors nest under `error`; plain stream errors carry code/message at the top.
  const error = (terminalEvent?.type === 'error' ? (terminalEvent.error ?? terminalEvent) : response?.error) as
    | Json
    | undefined;
  const usage = response?.usage as Json | undefined;
  const cachedTokens = (usage?.input_tokens_details as Json | undefined)?.cached_tokens;
  const outputText = events
    .filter((event) => event.type === 'response.output_text.delta')
    .map((event) => String(event.delta ?? ''))
    .join('');
  const finalStatus = terminalEvent?.type === 'error' ? 'error' : String(response?.status ?? endReason);
  log(finalStatus);

  return {
    name: plan.name,
    ...connection,
    expectedText: plan.expectedText,
    endReason,
    eventTypes,
    finalStatus,
    errorCode: error?.code === undefined ? undefined : String(error.code),
    errorMessage: error?.message === undefined ? undefined : redact(String(error.message)).slice(0, 300),
    // Mirrors references/codex/codex-rs/core/src/client.rs: the next previous_response_id is Completed's id.
    responseId: terminalEvent?.type === 'response.completed' && typeof response?.id === 'string' ? response.id : undefined,
    outputText,
    isTextMatched: plan.expectedText === undefined ? undefined : outputText.trim() === plan.expectedText,
    cachedTokens: typeof cachedTokens === 'number' ? cachedTokens : undefined,
  };
};

const closeSocket = async (socket: WebSocket): Promise<void> => {
  if (socket.readyState === WebSocket.CLOSED) return;
  const closed = new Promise<void>((resolve) => socket.once('close', () => resolve()));
  socket.close(1000);
  await Promise.race([closed, new Promise<void>((resolve) => setTimeout(resolve, CLOSE_TIMEOUT_MS).unref())]);
  socket.terminate();
};

log(`model: ${model}`);
log(`lite: ${isLite}`);
log(`user-agent: ${userAgent}`);

const stepPlans: StepPlan[] = [
  {
    name: 'prewarm',
    requestKind: 'prewarm',
    previousResponse: 'none',
    input: [toMessage('developer', 'You are a concise assistant.')],
  },
  {
    name: 'turn 1',
    requestKind: 'turn',
    previousResponse: 'chain',
    input: [toMessage('user', 'Reply with exactly: ws-ok')],
    expectedText: 'ws-ok',
  },
  {
    name: 'turn 2',
    requestKind: 'turn',
    previousResponse: 'chain',
    input: [toMessage('user', 'Reply with exactly: ws-ok-2')],
    expectedText: 'ws-ok-2',
  },
  {
    name: 'previous_response_not_found',
    requestKind: 'turn',
    previousResponse: 'missing',
    input: [toMessage('user', 'Reply with exactly: ws-ok-3')],
  },
];

// Mirrors references/codex/codex-rs/core/src/client.rs:1684-1700 and :478-489: a rebuilt
// connection resets the continuation and Codex then sends the full request. This PoC only probes
// the incremental chain, so chain steps stop there instead of replaying old ids on a new socket.
const CONTINUATION_RESET_REASON = '連線已重建；官方做法是先 reset 續接狀態再送完整請求，見 `core/src/client.rs:478-489,1684-1700`';

const handshakes: Handshake[] = [];
const steps: StepResult[] = [];
try {
  let socket: WebSocket | undefined;
  let previousResponseId: string | undefined;
  // Set once the connection that issued previousResponseId is gone.
  let isContinuationReset = false;
  for (const plan of stepPlans) {
    const turn: Turn =
      plan.requestKind === 'prewarm'
        ? { requestKind: 'prewarm', turnId: '' }
        : { requestKind: 'turn', turnId: randomUUID(), startedAtMs: Date.now() };
    const skippedStep: StepResult = {
      name: plan.name,
      connection: handshakes.length,
      isNewConnection: false,
      expectedText: plan.expectedText,
      eventTypes: [],
    };
    if (plan.previousResponse === 'chain') {
      if (previousResponseId !== undefined && socket?.readyState !== WebSocket.OPEN) {
        isContinuationReset = true;
        previousResponseId = undefined;
      }
      if (isContinuationReset) {
        steps.push({ ...skippedStep, skipReason: CONTINUATION_RESET_REASON });
        continue;
      }
      if (previousResponseId === undefined) {
        steps.push({ ...skippedStep, skipReason: 'previous step returned no response id' });
        continue;
      }
    }
    // A failed handshake ends the run instead of retrying it on every step.
    if (handshakes.length > 0 && !socket) {
      steps.push({ ...skippedStep, skipReason: 'no usable connection' });
      continue;
    }
    // Reconnect before any step whose socket the server closed or this script retired.
    let isNewConnection = false;
    if (socket?.readyState !== WebSocket.OPEN) {
      const connection = await connect(turn);
      handshakes.push(connection.handshake);
      socket = connection.socket;
      isNewConnection = handshakes.length > 1;
      if (isNewConnection) {
        isContinuationReset = true;
        previousResponseId = undefined;
      }
      if (!socket) {
        steps.push({
          ...skippedStep,
          connection: handshakes.length,
          isNewConnection,
          skipReason: `handshake failed with status ${connection.handshake.status}`,
        });
        continue;
      }
    }
    const step = await runStep(
      socket,
      plan,
      turn,
      plan.previousResponse === 'missing' ? `resp_${randomUUID().replaceAll('-', '')}` : previousResponseId,
      { connection: handshakes.length, isNewConnection },
    );
    steps.push(step);
    previousResponseId = step.responseId;
  }
} finally {
  await Promise.all(sockets.map(closeSocket));
}

const findStep = (name: string): StepResult | undefined => steps.find((step) => step.name === name);
const prewarmStep = findStep('prewarm');
const conclusion = {
  isHandshakeAccepted: handshakes[0]?.status === 101,
  isPrewarmCompleted: prewarmStep?.finalStatus === 'completed' && prewarmStep.responseId !== undefined,
  isTurn1Matched: findStep('turn 1')?.isTextMatched === true,
  isTurn2Matched: findStep('turn 2')?.isTextMatched === true,
  isPreviousResponseNotFound: findStep('previous_response_not_found')?.errorCode === 'previous_response_not_found',
  connectionCount: handshakes.length,
};

log('\n## Handshakes');
for (const [index, handshake] of handshakes.entries()) {
  log(`- #${index + 1}: status ${handshake.status}`);
  log(`  x-codex-turn-state present: ${handshake.hasTurnState}`);
  log(`  openai-model present: ${handshake.hasOpenaiModel}`);
  if (handshake.error) log(`  error: ${handshake.error}`);
  if (handshake.errorBody) log(`  body: ${handshake.errorBody.replace(/\s+/g, ' ')}`);
}

log('\n## Steps');
for (const step of steps) {
  const connectionLabel = `connection #${step.connection}${step.isNewConnection ? ', new' : ''}`;
  log(`- ${step.name} [${connectionLabel}]: ${step.skipReason ? `SKIP (${step.skipReason})` : step.finalStatus}`);
  if (step.skipReason) continue;
  log(`  events: ${step.eventTypes.join(', ') || '(none)'}`);
  if (step.errorCode || step.errorMessage) log(`  error: ${step.errorCode ?? '-'} ${step.errorMessage ?? ''}`.trimEnd());
  if (step.expectedText !== undefined) {
    log(`  text: ${JSON.stringify(step.outputText)} ${step.isTextMatched ? 'matches' : 'MISMATCH'}`);
  }
  log(`  cached_tokens: ${step.cachedTokens ?? 'n/a'}`);
}

log('\n## Conclusion');
log(JSON.stringify(conclusion, null, 2));

await mkdir(path.dirname(RESULT_PATH), { recursive: true });
const pocResults = { ranAt: new Date().toISOString(), model, isLite, clientVersion: CLIENT_VERSION, userAgent, handshakes, steps, conclusion };
await writeFile(RESULT_PATH, `${redact(JSON.stringify(pocResults, null, 2))}\n`);
log(`\nfull results: ${RESULT_PATH}`);
