// Packaging checks only. Existing SSE fixtures match the pinned upstream protocols in references/**.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { serializeClaudeRequest } from '../src/claude/attribution.js';
import type { Json } from '../src/types.js';

if (!process.argv[2]) throw new Error('Usage: npm run verify:binary -- <binary or AppRun>');
const binary = path.resolve(process.argv[2]);
const root = path.resolve(import.meta.dirname, '..');
// Use the OS temp directory to test outside the checkout and its parent node_modules.
const workDir = await mkdtemp(path.join(os.tmpdir(), 'agent-gateway-smoke-'));
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
  !key.startsWith('AGENT_GATEWAY_') && !key.startsWith('CLAUDE_') && key !== 'NODE_OPTIONS'));
// A copied executable outside the repository cannot resolve node_modules from its location.
const isolatedBinary = path.join(workDir, path.basename(binary));
const isAppRun = path.basename(binary) === 'AppRun';
if (isAppRun) {
  const appImageIcon = await readFile(path.join(path.dirname(binary), 'agent-gateway.png')).catch(() => undefined);
  assert.ok(appImageIcon, 'AppImage must include the finalized agent-gateway.png icon');
  assert.ok(appImageIcon.equals(await readFile(path.join(root, 'assets', 'icon.png'))),
    'AppImage icon must match assets/icon.png');
}
if (!isAppRun) {
  await copyFile(binary, isolatedBinary);
  await chmod(isolatedBinary, 0o755);
}
const executable = isAppRun ? binary : isolatedBinary;
for (const [args, status, text] of [
  [['--help'], 0, 'Usage: agent-gateway'],
  [[], 1, 'No Codex home configured'],
] as const) {
  const child = spawnSync(executable, [...args], { cwd: workDir, env: { ...env, PATH: isAppRun ? env.PATH : '' }, encoding: 'utf8', timeout: 15_000 });
  assert.equal(child.error, undefined);
  assert.equal(child.status, status, child.stderr);
  assert.ok(`${child.stdout}${child.stderr}`.includes(text));
}

const requests: { url: string; body: Json }[] = [];
const mock = createServer(async (req, res) => {
  let body = '';
  for await (const chunk of req) body += chunk;
  if (req.method === 'POST') requests.push({ url: req.url!, body: JSON.parse(body) as Json });
  if (req.url?.includes('/models')) {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(req.url.includes('api.anthropic.com')
      ? { data: [{ id: 'claude-sonnet-5', type: 'model', display_name: 'Smoke Claude' }], has_more: false }
      : { models: [{ slug: 'gpt-5.5', visibility: 'list', priority: 0 }] }));
  } else if (req.url?.includes('/messages') || req.url?.includes('/responses')) {
    res.setHeader('content-type', 'text/event-stream');
    res.end(await readFile(path.join(root, 'test', 'fixtures', req.url.includes('/messages') ? 'claude-text.sse' : 'text-nonlite.sse')));
  } else {
    res.writeHead(500).end('Unexpected upstream call');
  }
});
await new Promise<void>((resolve) => mock.listen(0, '127.0.0.1', resolve));
const address = mock.address();
assert.ok(address && typeof address === 'object');
const mockUrl = `http://127.0.0.1:${address.port}`;
const preload = path.join(workDir, 'mock.cjs');
// Test-only preload redirects every upstream fetch to loopback; production has no test flags.
await writeFile(preload, `const originalFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = new URL(input);
  if (!['chatgpt.com', 'api.anthropic.com'].includes(url.hostname)) throw new Error('Unexpected network: ' + url);
  return originalFetch(${JSON.stringify(mockUrl)} + '/' + url.hostname + url.pathname + url.search, init);
};\n`);
const codexHome = path.join(workDir, 'codex home');
const claudeHome = path.join(workDir, 'claude home');
await mkdir(codexHome);
await mkdir(claudeHome);
await writeFile(path.join(codexHome, 'auth.json'), JSON.stringify({ tokens: { access_token: 'smoke-token' } }));
await writeFile(path.join(claudeHome, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'smoke-token', expiresAt: Date.now() + 86_400_000 } }));
await writeFile(path.join(claudeHome, '.claude.json'), JSON.stringify({ userID: 'a'.repeat(64), oauthAccount: { accountUuid: '11111111-2222-4333-8444-555555555555' } }));
const child = spawn(executable, ['--codex-home', codexHome, '--claude-home', claudeHome], {
  cwd: workDir,
  env: { ...env, AGENT_GATEWAY_PORT: '0', NODE_OPTIONS: `--require ${JSON.stringify(preload)}` },
  stdio: ['ignore', 'pipe', 'pipe'],
});
const exited = once(child, 'exit');
let output = '';
child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString(); });
child.stderr.on('data', (chunk: Buffer) => { output += chunk.toString(); });
try {
  let port: string | undefined;
  for (let attempt = 0; attempt < 150; attempt += 1) {
    port = /listening on http:\/\/127\.0\.0\.1:(\d+)/.exec(output)?.[1];
    if (port || child.exitCode !== null) break;
    await delay(100);
  }
  assert.ok(port, `Binary failed to start: ${output}`);
  for (const model of ['codex1/gpt-5.5', 'claude1/claude-sonnet-5']) {
    const response = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: 'Hello' }] }),
      signal: AbortSignal.timeout(15_000),
    });
    const text = await response.text();
    assert.equal(response.status, 200, text);
    assert.ok(JSON.parse(text).choices[0].message.content.length > 0, text);
  }
  assert.ok(requests.some(({ url }) => url.includes('/responses')));
  const claude = requests.find(({ url }) => url.includes('/messages'));
  assert.ok(claude, 'Claude request did not reach mock upstream');
  assert.match(JSON.stringify(claude.body), /cch=[0-9a-f]{5};/);
  assert.ok(!JSON.stringify(claude.body).includes('cch=00000;'), 'Bundled WASM signer was not run');
  assert.equal(await serializeClaudeRequest(claude.body), JSON.stringify(claude.body), 'Bundled checksum differs from the source implementation');
  console.log(`PASS: ${path.basename(binary)} (help, missing home, Codex/Claude mock requests, WASM checksum${isAppRun ? ', finalized icon' : ''})`);
} finally {
  child.kill('SIGTERM');
  const forcedKill = setTimeout(() => child.kill('SIGKILL'), 5000);
  await exited;
  clearTimeout(forcedKill);
  mock.closeAllConnections();
  await new Promise<void>((resolve, reject) => mock.close((error) => error ? reject(error) : resolve()));
  await rm(workDir, { recursive: true, force: true });
}
