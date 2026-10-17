// Mirrors references/CLIProxyAPI v8.0.29 internal/runtime/executor/claude_signing{,_test}.go.
// Its literal vectors were captured from native Claude Code 2.1.220. The same seed also
// exists in the native 2.1.299 binary; references/claude-code only publishes plugin transport.
import { describe, expect, it, vi } from 'vitest';
import { createClaudeClient } from '../../src/claude/client.js';
import type { ClaudeRequest } from '../../src/claude/types.js';

const BASE = '{"model":"model-a","messages":[{"role":"user","content":[{"type":"text","text":"x"}]}],"system":[{"type":"text","text":"x-anthropic-billing-header: cc_version=2.1.220.test; cc_entrypoint=sdk-cli; cch=00000;"},{"type":"text","text":"system-x"}],"tools":[],"metadata":{"user_id":"meta-x"},"max_tokens":1,"thinking":{"type":"adaptive","display":"omitted"},"context_management":{"edits":[{"type":"clear_thinking_20251015","keep":"all"}]},"output_config":{"effort":"high"},"stream":true}';

const send = async (body: string, statuses = [200]): Promise<string[]> => {
  const sent: string[] = [];
  const client = createClaudeClient({
    baseUrl: 'https://api.anthropic.com',
    credentialsPath: '/unused/.credentials.json',
    auth: { getCredentials: async () => ({ accessToken: 'test' }), recoverUnauthorized: async () => ({ accessToken: 'renewed' }) },
    fetchFn: vi.fn<typeof fetch>(async (_url, init) => {
      sent.push(String(init?.body));
      return new Response('', { status: statuses.shift() ?? 200 });
    }),
  });
  const request = JSON.parse(body) as ClaudeRequest;
  await client.postMessages(request, { sessionId: 'test-session', betas: [] });
  expect(JSON.stringify(request)).toBe(body);
  return sent;
};

describe('final Claude request billing checksum', () => {
  it.each([
    ['base', BASE, '7ee87'],
    ['model ignored', BASE.replace('"model-a"', '"model-b"'), '7ee87'],
    ['max tokens ignored', BASE.replace('"max_tokens":1', '"max_tokens":2'), '7ee87'],
    ['message', BASE.replace('"text":"x"', '"text":"y"'), 'b9cc8'],
    ['system', BASE.replace('"system-x"', '"system-y"'), 'a30d3'],
    ['metadata', BASE.replace('"meta-x"', '"meta-y"'), '7a89d'],
    ['thinking', BASE.replace('{"type":"adaptive","display":"omitted"}', '{"type":"disabled"}'), '7205c'],
    ['context', BASE.replace('"edits":[{"type":"clear_thinking_20251015","keep":"all"}]', '"edits":[]'), '05073'],
    ['effort', BASE.replace('"high"', '"low"'), '12366'],
    ['stream', BASE.replace('"stream":true', '"stream":false'), '60400'],
    ['tool', BASE.replace('"tools":[]', '"tools":[{"name":"t","description":"d","input_schema":{"type":"object"}}]'), '3d78d'],
    ['nested model', BASE.replace('"user_id":"meta-x"', '"user_id":"meta-x","model":"a"'), '0601b'],
    ['nested dispatch', BASE.replace('"user_id":"meta-x"', '"user_id":"meta-x","max_tokens":2'), '7ee87'],
    ['fallbacks', BASE.replace('"stream":true}', '"stream":true,"fallbacks":[{"model":"fallback-a"}]}'), '7ee87'],
    ['credit', BASE.replace('"stream":true}', '"stream":true,"fallback_credit_token":"a"}'), '7ee87'],
    ['native trailing comma', BASE.replace('"user_id":"meta-x"', '"user_id":"meta-x","max_tokens":999,"fallbacks":[{"model":"fallback-model"}]'), '4589b'],
  ])('matches the independent native vector: %s', async (_name, body, checksum) => {
    expect(await send(body!)).toEqual([body!.replace('cch=00000;', `cch=${checksum};`)]);
  });

  it('keeps the signed body identical on a single 401 retry', async () => {
    const expected = BASE.replace('cch=00000;', 'cch=7ee87;');
    expect(await send(BASE, [401, 200])).toEqual([expected, expected]);
  });

  it('only replaces the billing checksum, preserving caller text and escaped Unicode', async () => {
    const body = BASE.replace('"text":"x"', '"text":"你好 😀 cch=00000; \\"quoted\\""');
    const [sent] = await send(body);
    const checksum = /cc_entrypoint=sdk-cli; cch=([0-9a-f]{5});/.exec(sent!)?.[1];
    expect(checksum).toBeDefined();
    expect(checksum).not.toBe('00000');
    expect(sent).toBe(body.replace('cc_entrypoint=sdk-cli; cch=00000;', `cc_entrypoint=sdk-cli; cch=${checksum};`));
  });

  it('does not add attribution when it was omitted', async () => {
    const request = JSON.parse(BASE) as ClaudeRequest;
    delete request.system;
    const body = JSON.stringify(request);
    expect(await send(body)).toEqual([body]);
  });
});
