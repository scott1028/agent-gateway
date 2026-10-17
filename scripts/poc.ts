// Phase 0 spike: probe the Codex ChatGPT backend with Codex-shaped requests.
// Standalone on purpose (imports nothing from src). Never prints tokens.
//   npm run poc                 # run all probes
//   npm run poc -- --refresh    # only run one real token refresh (no probes)
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

type Json = Record<string, unknown>;

type AuthFile = Json & {
  auth_mode?: string;
  tokens?: Json & {
    id_token: string;
    access_token: string;
    refresh_token: string;
    account_id?: string;
  };
  last_refresh?: string;
};

type SseEvent = Json & { type: string };

type ProbeCase = {
  name: string;
  model: string;
  isLite: boolean;
  input: Json[];
  tools?: Json[];
  mutateBody?: (body: Json) => void;
  dropHeaders?: string[];
  extraHeaders?: Record<string, string>;
  sessionId?: string;
  fixture?: string;
};

type ProbeResult = {
  name: string;
  status: number;
  isPassed: boolean;
  contentType: string;
  eventTypes: Record<string, number>;
  outputText: string;
  outputItems: Json[];
  completedResponse?: Json;
  errorBody?: string;
  headers: Record<string, string>;
};

const AGENT_GATEWAY_HOME = process.env.AGENT_GATEWAY_HOME ?? path.join(os.homedir(), '.agent-gateway');
const AUTH_PATH = path.join(AGENT_GATEWAY_HOME, 'auth.json');
const BASE_URL = 'https://chatgpt.com/backend-api/codex';
const REFRESH_URL = 'https://auth.openai.com/oauth/token';
const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const CLIENT_VERSION = process.env.CODEX_CLIENT_VERSION ?? '0.162.1';
const LITE_HEADER = 'x-openai-internal-codex-responses-lite';
const NON_LITE_MODEL = process.env.POC_NON_LITE_MODEL ?? 'gpt-5.5';
const LITE_MODEL = process.env.POC_LITE_MODEL ?? 'gpt-5.6-terra';
const USER_AGENT = `codex_cli_rs/${CLIENT_VERSION} (${os.type()} ${os.release()}; ${os.arch()}) agent-gateway`;
const ROOT_DIR = path.join(import.meta.dirname, '..');
const FIXTURE_DIR = path.join(ROOT_DIR, 'test', 'fixtures');
const RESULT_PATH = path.join(ROOT_DIR, '.tmp', 'poc-results.json');
const CAPTURED_HEADERS = [
  'content-type',
  'x-request-id',
  'x-oai-request-id',
  'x-codex-plan-type',
  'x-codex-active-limit',
  'openai-model',
  'x-reasoning-included',
  'x-codex-primary-used-percent',
  'x-codex-secondary-used-percent',
  'x-models-etag',
];
const TINY_PNG_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==';
const REMOTE_IMAGE_URL =
  'https://www.google.com/images/branding/googlelogo/1x/googlelogo_color_272x92dp.png';
const WEATHER_TOOL: Json = {
  type: 'function',
  name: 'get_weather',
  description: 'Get the current weather for a city.',
  strict: false,
  parameters: {
    type: 'object',
    properties: { city: { type: 'string' } },
    required: ['city'],
    additionalProperties: false,
  },
};
const WEATHER_PROMPT = 'What is the weather in Paris right now? Use the get_weather tool.';

const isRefreshRequested = process.argv.includes('--refresh');

const decodeJwtPayload = (jwt: string): Json => {
  const payload = jwt.split('.')[1] ?? '';
  return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Json;
};

const authFile = JSON.parse(await readFile(AUTH_PATH, 'utf8')) as AuthFile;
if (authFile.auth_mode !== 'chatgpt' || !authFile.tokens) {
  throw new Error(`${AUTH_PATH} is not a ChatGPT login; run: CODEX_HOME=${AGENT_GATEWAY_HOME} codex login`);
}
const tokens = authFile.tokens;
const idClaims = decodeJwtPayload(tokens.id_token);
const authClaims = (idClaims['https://api.openai.com/auth'] ?? {}) as Json;
const accountId = tokens.account_id ?? String(authClaims.chatgpt_account_id ?? '');
const accessExpMs = Number(decodeJwtPayload(tokens.access_token).exp ?? 0) * 1000;

const toMessage = (role: string, text: string): Json => ({
  type: 'message',
  role,
  content: [{ type: role === 'assistant' ? 'output_text' : 'input_text', text }],
});

const toLiteToolsItem = (tools: Json[]): Json => ({
  type: 'additional_tools',
  role: 'developer',
  tools: [{ type: 'namespace', name: 'functions', description: '', tools }],
});

const getHeaders = (probe: ProbeCase, sessionId: string): Record<string, string> => {
  const headers: Record<string, string> = {
    authorization: `Bearer ${tokens.access_token}`,
    'chatgpt-account-id': accountId,
    originator: 'codex_cli_rs',
    'user-agent': USER_AGENT,
    version: CLIENT_VERSION,
    'session-id': sessionId,
    'thread-id': sessionId,
    'x-client-request-id': sessionId,
    accept: 'text/event-stream',
    'content-type': 'application/json',
    ...(probe.isLite ? { [LITE_HEADER]: 'true' } : {}),
    ...probe.extraHeaders,
  };
  for (const name of probe.dropHeaders ?? []) delete headers[name];
  return headers;
};

const getBody = (probe: ProbeCase, sessionId: string): Json => {
  const hasLiteTools = probe.isLite && probe.tools !== undefined;
  const body: Json = {
    model: probe.model,
    stream: true,
    input: hasLiteTools ? [toLiteToolsItem(probe.tools ?? []), ...probe.input] : probe.input,
    tool_choice: 'auto',
    parallel_tool_calls: false,
    reasoning: probe.isLite ? { effort: 'low', context: 'all_turns' } : { effort: 'low' },
    store: false,
    include: ['reasoning.encrypted_content'],
    prompt_cache_key: sessionId,
  };
  if (!probe.isLite) body.tools = probe.tools ?? [];
  probe.mutateBody?.(body);
  return body;
};

const parseSse = (text: string): SseEvent[] =>
  text
    .split(/\r?\n\r?\n/)
    .map((block) =>
      block
        .split(/\r?\n/)
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trimStart())
        .join('\n'),
    )
    .filter((data) => data !== '' && data !== '[DONE]')
    .flatMap((data) => {
      try {
        return [JSON.parse(data) as SseEvent];
      } catch {
        return [];
      }
    });

const redactEncrypted = (text: string): string =>
  text
    .replace(/"encrypted_content":"[^"]*"/g, '"encrypted_content":"<redacted>"')
    .replace(/"safety_identifier":"[^"]*"/g, '"safety_identifier":"<redacted>"');

const runProbe = async (probe: ProbeCase): Promise<ProbeResult> => {
  const sessionId = probe.sessionId ?? randomUUID();
  const response = await fetch(`${BASE_URL}/responses`, {
    method: 'POST',
    headers: getHeaders(probe, sessionId),
    body: JSON.stringify(getBody(probe, sessionId)),
    signal: AbortSignal.timeout(180_000),
  });
  const text = await response.text();
  const contentType = response.headers.get('content-type') ?? '';
  const headers = Object.fromEntries(
    CAPTURED_HEADERS.flatMap((name) => {
      const headerValue = response.headers.get(name);
      return headerValue === null ? [] : [[name, headerValue]];
    }),
  );
  if (response.headers.has('x-codex-turn-state')) headers['x-codex-turn-state'] = '<present>';

  // Backend omits content-type on SSE responses, so sniff the body too.
  const isSse = contentType.includes('text/event-stream') || /^(event|data):/.test(text.trimStart());
  const events = isSse ? parseSse(text) : [];
  const eventTypes: Record<string, number> = {};
  for (const event of events) eventTypes[event.type] = (eventTypes[event.type] ?? 0) + 1;
  const outputText = events
    .filter((event) => event.type === 'response.output_text.delta')
    .map((event) => String(event.delta ?? ''))
    .join('');
  const outputItems = events
    .filter((event) => event.type === 'response.output_item.done')
    .map((event) => event.item as Json);
  const completedResponse = events.find((event) => event.type === 'response.completed')
    ?.response as Json | undefined;

  // Non-stream JSON success counts as passed too (stream:false probe).
  let jsonResponse: Json | undefined;
  if (!isSse && response.ok) {
    try {
      jsonResponse = JSON.parse(text) as Json;
    } catch {
      jsonResponse = undefined;
    }
  }
  const isPassed = response.ok && (completedResponse !== undefined || jsonResponse?.status === 'completed');

  if (probe.fixture && isSse) {
    await writeFile(path.join(FIXTURE_DIR, probe.fixture), redactEncrypted(text));
  }

  return {
    name: probe.name,
    status: response.status,
    isPassed,
    contentType,
    eventTypes,
    outputText: outputText || String(jsonResponse?.output_text ?? ''),
    outputItems,
    completedResponse: completedResponse ?? jsonResponse,
    errorBody: isPassed ? undefined : redactEncrypted(text).slice(0, 600),
    headers,
  };
};

const getUsage = (result: ProbeResult): Json => (result.completedResponse?.usage ?? {}) as Json;

const summarizeItem = (item: Json): Json =>
  Object.fromEntries(
    Object.entries(item).map(([key, itemValue]) => [
      key,
      key === 'encrypted_content' ? '<redacted>' : itemValue,
    ]),
  );

const results: ProbeResult[] = [];
const notes: string[] = [];

const probeAndRecord = async (probe: ProbeCase): Promise<ProbeResult> => {
  process.stdout.write(`- ${probe.name} ... `);
  try {
    const result = await runProbe(probe);
    results.push(result);
    console.log(`${result.status} ${result.isPassed ? 'PASS' : 'FAIL'}`);
    return result;
  } catch (error) {
    const result: ProbeResult = {
      name: probe.name,
      status: 0,
      isPassed: false,
      contentType: '',
      eventTypes: {},
      outputText: '',
      outputItems: [],
      errorBody: String(error),
      headers: {},
    };
    results.push(result);
    console.log(`ERROR ${String(error)}`);
    return result;
  }
};

const runModelsProbe = async (clientVersion: string): Promise<Json[]> => {
  const response = await fetch(`${BASE_URL}/models?client_version=${clientVersion}`, {
    headers: {
      authorization: `Bearer ${tokens.access_token}`,
      'chatgpt-account-id': accountId,
      originator: 'codex_cli_rs',
      'user-agent': USER_AGENT,
      version: CLIENT_VERSION,
    },
    signal: AbortSignal.timeout(60_000),
  });
  const text = await response.text();
  if (!response.ok) {
    console.log(`models?client_version=${clientVersion}: ${response.status} ${text.slice(0, 300)}`);
    return [];
  }
  return ((JSON.parse(text) as Json).models ?? []) as Json[];
};

const runRefresh = async (): Promise<void> => {
  const response = await fetch(REFRESH_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      client_id: CLIENT_ID,
      grant_type: 'refresh_token',
      refresh_token: tokens.refresh_token,
    }),
    signal: AbortSignal.timeout(60_000),
  });
  const text = await response.text();
  if (!response.ok) {
    console.log(`refresh FAIL ${response.status} ${text.slice(0, 300)}`);
    return;
  }
  const refreshed = JSON.parse(text) as Json;
  console.log(`refresh OK; response keys: ${Object.keys(refreshed).join(', ')}`);
  // Write back immediately: refresh tokens rotate and the old one is now spent.
  const latest = JSON.parse(await readFile(AUTH_PATH, 'utf8')) as AuthFile;
  const nextTokens = { ...latest.tokens } as NonNullable<AuthFile['tokens']>;
  for (const key of ['id_token', 'access_token', 'refresh_token'] as const) {
    if (typeof refreshed[key] === 'string') nextTokens[key] = refreshed[key];
  }
  const next: AuthFile = { ...latest, tokens: nextTokens, last_refresh: new Date().toISOString() };
  const tmpPath = `${AUTH_PATH}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(tmpPath, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  await rename(tmpPath, AUTH_PATH);
  console.log('auth.json updated');
};

await mkdir(FIXTURE_DIR, { recursive: true });
await mkdir(path.dirname(RESULT_PATH), { recursive: true });

console.log('## Auth');
console.log(`auth file: ${AUTH_PATH}`);
console.log(`account id present: ${accountId !== ''}`);
console.log(`plan type: ${String(authClaims.chatgpt_plan_type ?? 'unknown')}`);
console.log(`fedramp: ${String(authClaims.chatgpt_account_is_fedramp ?? false)}`);
console.log(`access token expires: ${new Date(accessExpMs).toISOString()}`);
console.log(`last_refresh: ${authFile.last_refresh ?? 'missing'}`);

if (isRefreshRequested) {
  console.log('\n## Refresh');
  await runRefresh();
  process.exit(0);
}

console.log('\n## Models');
const models = await runModelsProbe(CLIENT_VERSION);
for (const model of models) {
  console.log(
    `${String(model.slug)} visibility=${String(model.visibility)} lite=${String(model.use_responses_lite)} default_effort=${String(model.default_reasoning_level)} priority=${String(model.priority)}`,
  );
}
const oldModels = await runModelsProbe('0.100.0');
console.log(`count @${CLIENT_VERSION}=${models.length}, @0.100.0=${oldModels.length}`);
const modelKeys = models[0] ? Object.keys(models[0]).sort().join(', ') : '';
notes.push(`model keys: ${modelKeys}`);

const textInput = [toMessage('developer', 'You are a concise assistant.'), toMessage('user', 'Reply with exactly: pong')];
const weatherInput = [toMessage('developer', 'You are a concise assistant.'), toMessage('user', WEATHER_PROMPT)];

console.log('\n## Baseline');
await probeAndRecord({ name: 'baseline/non-lite', model: NON_LITE_MODEL, isLite: false, input: textInput, fixture: 'text-nonlite.sse' });
await probeAndRecord({ name: 'baseline/lite', model: LITE_MODEL, isLite: true, input: textInput, fixture: 'text-lite.sse' });

console.log('\n## Header matrix (lite)');
const droppableHeaders = ['originator', 'user-agent', 'version', 'session-id', 'thread-id', 'x-client-request-id', 'chatgpt-account-id', LITE_HEADER];
for (const header of droppableHeaders) {
  await probeAndRecord({ name: `headers/drop ${header}`, model: LITE_MODEL, isLite: true, input: textInput, dropHeaders: [header] });
}
await probeAndRecord({
  name: 'headers/minimal (auth + account only)',
  model: LITE_MODEL,
  isLite: true,
  input: textInput,
  dropHeaders: droppableHeaders.filter((header) => header !== 'chatgpt-account-id'),
});

console.log('\n## Instructions matrix (lite)');
await probeAndRecord({ name: 'instructions/none', model: LITE_MODEL, isLite: true, input: [toMessage('user', 'Reply with exactly: pong')] });
await probeAndRecord({
  name: 'instructions/top-level',
  model: LITE_MODEL,
  isLite: true,
  input: [toMessage('user', 'Reply with exactly: pong')],
  mutateBody: (body) => {
    body.instructions = 'You are a concise assistant.';
  },
});
await probeAndRecord({
  name: 'instructions/system role',
  model: LITE_MODEL,
  isLite: true,
  input: [toMessage('system', 'You are a concise assistant.'), toMessage('user', 'Reply with exactly: pong')],
});

console.log('\n## Parameter matrix (lite)');
const jsonInput = [toMessage('developer', 'Answer in JSON.'), toMessage('user', 'Return a JSON object with key "answer" set to "pong".')];
const paramProbes: Array<[string, (body: Json) => void, Json[]?]> = [
  ['temperature', (body) => { body.temperature = 0.2; }],
  ['top_p', (body) => { body.top_p = 0.9; }],
  ['max_output_tokens', (body) => { body.max_output_tokens = 256; }],
  ['metadata', (body) => { body.metadata = { probe: '1' }; }],
  ['user', (body) => { body.user = 'probe'; }],
  ['truncation', (body) => { body.truncation = 'auto'; }],
  ['safety_identifier', (body) => { body.safety_identifier = 'probe'; }],
  ['top_logprobs', (body) => { body.top_logprobs = 2; }],
  ['service_tier priority', (body) => { body.service_tier = 'priority'; }],
  ['store true', (body) => { body.store = true; }],
  ['stream false', (body) => { body.stream = false; }],
  ['previous_response_id', (body) => { body.previous_response_id = 'resp_does_not_exist'; }],
  ['reasoning.summary auto', (body) => { body.reasoning = { ...(body.reasoning as Json), summary: 'auto' }; }],
  ['reasoning.effort ultra', (body) => { body.reasoning = { ...(body.reasoning as Json), effort: 'ultra' }; }],
  ['no include', (body) => { delete body.include; }],
  ['no reasoning', (body) => { delete body.reasoning; }],
  ['no prompt_cache_key', (body) => { delete body.prompt_cache_key; }],
  ['text.verbosity low', (body) => { body.text = { verbosity: 'low' }; }],
  [
    'text.format json_schema',
    (body) => {
      body.text = {
        format: {
          type: 'json_schema',
          name: 'answer',
          strict: true,
          schema: { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'], additionalProperties: false },
        },
      };
    },
    jsonInput,
  ],
  ['text.format json_object', (body) => { body.text = { format: { type: 'json_object' } }; }, jsonInput],
];
for (const [name, mutateBody, input] of paramProbes) {
  await probeAndRecord({ name: `params/${name}`, model: LITE_MODEL, isLite: true, input: input ?? textInput, mutateBody });
}

console.log('\n## Tools');
const nonLiteTool = await probeAndRecord({
  name: 'tools/non-lite top-level',
  model: NON_LITE_MODEL,
  isLite: false,
  input: weatherInput,
  tools: [WEATHER_TOOL],
  fixture: 'tool-call-nonlite.sse',
});
await probeAndRecord({
  name: 'tools/lite top-level, no lite header',
  model: LITE_MODEL,
  isLite: true,
  input: weatherInput,
  dropHeaders: [LITE_HEADER],
  mutateBody: (body) => {
    body.tools = [WEATHER_TOOL];
  },
});
await probeAndRecord({
  name: 'tools/lite top-level, with lite header',
  model: LITE_MODEL,
  isLite: true,
  input: weatherInput,
  mutateBody: (body) => {
    body.tools = [WEATHER_TOOL];
  },
});
const liteTool = await probeAndRecord({
  name: 'tools/lite additional_tools',
  model: LITE_MODEL,
  isLite: true,
  input: weatherInput,
  tools: [WEATHER_TOOL],
  fixture: 'tool-call-lite.sse',
});
await probeAndRecord({
  name: 'tools/lite tool_choice none',
  model: LITE_MODEL,
  isLite: true,
  input: weatherInput,
  tools: [WEATHER_TOOL],
  mutateBody: (body) => {
    body.tool_choice = 'none';
  },
});
await probeAndRecord({
  name: 'tools/lite tool_choice required',
  model: LITE_MODEL,
  isLite: true,
  input: [toMessage('user', 'Say hi.')],
  tools: [WEATHER_TOOL],
  mutateBody: (body) => {
    body.tool_choice = 'required';
  },
});
await probeAndRecord({
  name: 'tools/lite tool_choice function',
  model: LITE_MODEL,
  isLite: true,
  input: [toMessage('user', 'Say hi.')],
  tools: [WEATHER_TOOL],
  mutateBody: (body) => {
    body.tool_choice = { type: 'function', name: 'get_weather' };
  },
});

for (const toolResult of [nonLiteTool, liteTool]) {
  const call = toolResult.outputItems.find((item) => item.type === 'function_call');
  notes.push(`${toolResult.name} function_call item: ${call ? JSON.stringify(summarizeItem(call)) : 'none'}`);
  notes.push(`${toolResult.name} event types: ${JSON.stringify(toolResult.eventTypes)}`);
}

console.log('\n## Tool round-trip');
const toolOutput = JSON.stringify({ temp_c: 18, condition: 'sunny' });
const buildRoundTripInput = (result: ProbeResult, transform: (item: Json) => Json | undefined): Json[] | undefined => {
  const call = result.outputItems.find((item) => item.type === 'function_call');
  if (!call) return undefined;
  const replayed = result.outputItems.flatMap((item) => {
    const transformed = transform(item);
    return transformed ? [transformed] : [];
  });
  return [...weatherInput, ...replayed, { type: 'function_call_output', call_id: call.call_id, output: toolOutput }];
};
const stripKeys = (item: Json, keys: string[]): Json =>
  Object.fromEntries(Object.entries(item).filter(([key]) => !keys.includes(key)));
const roundTripVariants: Array<[string, ProbeResult, boolean, (item: Json) => Json | undefined]> = [
  ['lite as returned', liteTool, true, (item) => item],
  ['lite no namespace', liteTool, true, (item) => (item.type === 'function_call' ? stripKeys(item, ['namespace']) : item)],
  ['lite no ids', liteTool, true, (item) => stripKeys(item, ['id'])],
  [
    'lite chat-style (no reasoning, no ids, no namespace)',
    liteTool,
    true,
    (item) => (item.type === 'function_call' ? stripKeys(item, ['id', 'namespace', 'status']) : undefined),
  ],
  [
    'non-lite chat-style (no reasoning, no ids)',
    nonLiteTool,
    false,
    (item) => (item.type === 'function_call' ? stripKeys(item, ['id', 'status']) : undefined),
  ],
];
for (const [name, toolResult, isLite, transform] of roundTripVariants) {
  const input = buildRoundTripInput(toolResult, transform);
  if (!input) {
    console.log(`- roundtrip/${name} ... SKIP (no function_call)`);
    continue;
  }
  await probeAndRecord({
    name: `roundtrip/${name}`,
    model: isLite ? LITE_MODEL : NON_LITE_MODEL,
    isLite,
    input,
    tools: [WEATHER_TOOL],
    fixture: name === 'lite chat-style (no reasoning, no ids, no namespace)' ? 'roundtrip-lite.sse' : undefined,
  });
}

console.log('\n## Prompt cache (lite)');
const longRules = Array.from({ length: 400 }, (_, index) => `Rule ${index + 1}: keep answers short and factual.`).join('\n');
const cacheInput = [toMessage('developer', longRules), toMessage('user', 'Reply with exactly: pong')];
const cacheSessionId = randomUUID();
const cacheFirst = await probeAndRecord({ name: 'cache/first', model: LITE_MODEL, isLite: true, input: cacheInput, sessionId: cacheSessionId });
const cacheSecond = await probeAndRecord({ name: 'cache/same session', model: LITE_MODEL, isLite: true, input: cacheInput, sessionId: cacheSessionId });
const cacheThird = await probeAndRecord({ name: 'cache/new session', model: LITE_MODEL, isLite: true, input: cacheInput });
for (const result of [cacheFirst, cacheSecond, cacheThird]) {
  notes.push(`${result.name} usage: ${JSON.stringify(getUsage(result))}`);
}

console.log('\n## Images (lite)');
const toImageInput = (imageUrl: string): Json[] => [
  {
    type: 'message',
    role: 'user',
    content: [
      { type: 'input_text', text: 'Describe this image in at most five words.' },
      { type: 'input_image', image_url: imageUrl },
    ],
  },
];
await probeAndRecord({ name: 'images/data url', model: LITE_MODEL, isLite: true, input: toImageInput(TINY_PNG_DATA_URL) });
await probeAndRecord({ name: 'images/https url', model: LITE_MODEL, isLite: true, input: toImageInput(REMOTE_IMAGE_URL) });

console.log('\n## Bad token');
await probeAndRecord({
  name: 'auth/invalid bearer',
  model: LITE_MODEL,
  isLite: true,
  input: textInput,
  extraHeaders: { authorization: 'Bearer invalid-token' },
});

const endTurnValues = results
  .map((result) => result.completedResponse?.end_turn)
  .filter((endTurn) => endTurn !== undefined);
notes.push(`end_turn values seen: ${JSON.stringify(endTurnValues)}`);

console.log('\n## Results');
console.log('| probe | status | result | output / error |');
console.log('|---|---|---|---|');
for (const result of results) {
  const detail = result.isPassed
    ? JSON.stringify(result.outputText.slice(0, 60))
    : (result.errorBody ?? '').replace(/\s+/g, ' ').slice(0, 160);
  console.log(`| ${result.name} | ${result.status} | ${result.isPassed ? 'PASS' : 'FAIL'} | ${detail} |`);
}

console.log('\n## Notes');
for (const note of notes) console.log(`- ${note}`);
console.log(`- baseline/lite headers: ${JSON.stringify(results.find((result) => result.name === 'baseline/lite')?.headers ?? {})}`);

await writeFile(RESULT_PATH, `${JSON.stringify({ results, notes }, null, 2)}\n`);
console.log(`\nfull results: ${RESULT_PATH}`);
