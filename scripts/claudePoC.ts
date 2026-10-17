// Manual Claude PoC: runs the real gateway code path against the Claude Messages API so a human
// can confirm the pinned protocol still holds. It spends real account quota, so npm test never
// runs it and it refuses the everyday login home.
//   npm run poc:claude -- --claude-home ~/.agent-gateway-claude-1 [--model claude-sonnet-5] [--debug]
// What this script actually exercises: the /v1/models list call, one text turn, one tool-call
// turn plus its continuation (native replay) and one following user turn. It does NOT exercise
// output_config.format / JSON Schema requests, real refresh contention or CAS rotation, or
// prompt-cache hit behaviour; passing here does not verify those (docs §11).
// Never prints tokens, credential contents or stored thinking text.
import { parseArgs } from 'node:util';
import os from 'node:os';
import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { createClaudeAccount, parseClaudeSseStream, startClaudeCall, translateClaudeStream } from '../src/claude/index.js';
import { getConfig } from '../src/config.js';
import { collectResponse } from '../src/responses/collectResponse.js';
import type { Json } from '../src/types.js';
import { createDebugFetch } from '../src/utils/debugFetch.js';

const ROOT_DIR = path.join(import.meta.dirname, '..');
const RESULT_PATH = path.join(ROOT_DIR, '.tmp', 'claude-poc-results.json');

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    'claude-home': { type: 'string' },
    model: { type: 'string' },
    debug: { type: 'boolean' },
  },
});

const home = values['claude-home'];
if (!home) {
  console.error('Claude PoC needs an explicit --claude-home <path> that is already logged in.');
  process.exit(1);
}
const homePath = path.resolve(home);
if (homePath === path.join(os.homedir(), '.claude')) {
  console.error('Refusing the default Claude login home. Make a dedicated home and log in there:');
  console.error('  mkdir -p <home> && chmod 700 <home> && CLAUDE_CONFIG_DIR=<home> claude   # then /login');
  process.exit(1);
}
// Same home, alias and state directory layout the gateway itself uses.
const config = getConfig(process.env, [], { claudeHomes: [homePath], ...(values.model ? { model: values.model } : {}) });
const claudeHome = config.claudeHomes[0];
if (claudeHome === undefined) {
  console.error('No Claude home was configured.');
  process.exit(1);
}
const slug = (config.defaultModelId ?? `${claudeHome.alias}/claude-sonnet-5`).split('/').slice(1).join('/');
const fetchFn = values.debug ? createDebugFetch({ alias: claudeHome.alias }) : undefined;
const account = await createClaudeAccount(claudeHome, fetchFn);

const deps = { accounts: [account], contextLength: config.contextLength };
const log: { model?: string; upstreamRequestId?: string } = {};

const runTurn = async (
  items: Json[],
  tools?: Json[],
): Promise<{ response: Json; outputItems: Json[]; request: Json; betas: string[] }> => {
  const call = await startClaudeCall({
    account,
    slug,
    body: { model: slug, input: items, ...(tools ? { tools } : {}) },
    signal: new AbortController().signal,
    deps,
    log,
  });
  if (!call.upstream.body) throw new Error('Upstream response has no body');
  const events = translateClaudeStream({ events: parseClaudeSseStream(call.upstream.body), meta: call.meta, saveState: call.saveState });
  const { response, outputItems } = await collectResponse(events);
  return { response, outputItems, request: call.prepared.request, betas: call.prepared.betas };
};

const getText = (items: Json[]): string =>
  items
    .filter((item) => item.type === 'message')
    .flatMap((item) => (Array.isArray(item.content) ? (item.content as Json[]) : []))
    .map((part) => String(part.text ?? ''))
    .join('');

const results: Json = { model: slug, home: homePath, probes: [] };
const record = (name: string, value: Json): void => {
  results.probes = [...(results.probes as Json[]), { name, ...value }];
  console.log(`${name}: ${JSON.stringify(value)}`);
};

const userText = (text: string): Json => ({ type: 'message', role: 'user', content: [{ type: 'input_text', text }] });

const getAssistantBlocks = (request: Json): Json[] =>
  (request.messages as Json[]).flatMap((message) => (message.role === 'assistant' && Array.isArray(message.content) ? (message.content as Json[]) : []));

const main = async (): Promise<void> => {
  const models = await account.client.getModels();
  record('models', { count: models.length, ids: models.map((entry) => entry.id) });

  const textTurn = await runTurn([userText('Reply with exactly: gateway-ok')]);
  record('text', {
    status: textTurn.response.status,
    text: getText(textTurn.outputItems),
    usage: textTurn.response.usage ?? null,
  });

  const tools: Json[] = [
    {
      type: 'function',
      name: 'get_utc_time',
      description: 'Return the current UTC time.',
      parameters: { type: 'object', additionalProperties: false, properties: { zone: { type: 'string' } }, required: [] },
    },
  ];
  const items = [userText('Call get_utc_time once, then answer with the time it returned.')];
  const first = await runTurn(items, tools);
  const call = first.outputItems.find((item) => item.type === 'function_call');
  record('tool_call', {
    status: first.response.status,
    isStreamingRequested: first.request.stream === true,
    isThinkingRequested: first.request.thinking !== undefined,
    betas: first.betas,
    callId: call?.call_id ?? null,
    name: call?.name ?? null,
    arguments: call?.arguments ?? null,
  });
  if (!call) throw new Error('Expected a tool call from the first turn; the round trip cannot continue.');

  // A real client echoes the whole `output` array, so the continuation does the same.
  const continuation = [...items, ...first.outputItems, { type: 'function_call_output', call_id: call.call_id, output: '2026-10-14T00:00:00Z' }];
  const second = await runTurn(continuation, tools);
  const replayed = getAssistantBlocks(second.request);
  record('tool_round_trip', {
    status: second.response.status,
    replayedBlockTypes: replayed.map((block) => block.type),
    isThinkingReplayed: replayed.some((block) => block.type === 'thinking' || block.type === 'redacted_thinking'),
    toolUseCount: replayed.filter((block) => block.type === 'tool_use').length,
    answer: getText(second.outputItems),
  });

  // The tool cycle is finished here, so this turn must work from the client echo alone.
  const third = await runTurn([...continuation, ...second.outputItems, userText('Say only: second-turn-ok')], tools);
  record('next_user_turn', {
    status: third.response.status,
    replayedBlockTypes: getAssistantBlocks(third.request).map((block) => block.type),
    answer: getText(third.outputItems),
  });

  await mkdir(path.dirname(RESULT_PATH), { recursive: true });
  await writeFile(RESULT_PATH, `${JSON.stringify(results, null, 2)}\n`);
  console.log(`results written to ${RESULT_PATH}`);
};

await main().catch(async (error: Error & { status?: number }) => {
  console.error(`PoC failed: ${error.message}${error.status === undefined ? '' : ` (HTTP ${error.status})`}`);
  await mkdir(path.dirname(RESULT_PATH), { recursive: true });
  await writeFile(RESULT_PATH, `${JSON.stringify({ ...results, error: error.message }, null, 2)}\n`);
  process.exit(1);
});
