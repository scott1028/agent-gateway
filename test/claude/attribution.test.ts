// Entrypoint resolution, billing attribution and fingerprint. Copied from the pinned native
// release 2.1.299 (SHA256 2d894a4b1bfaaa9a): startup normalizer T at 215050094, env helpers
// Le/ys at 214625500, billing builder wSo at 218606801, first-user extraction qB and fingerprint
// Im at 222259800. references/claude-code @9b4f0d6 plugin code is not the CLI transport.
// Fingerprint expectations are literal vectors precomputed from the native algorithm, not
// re-derived through the production helper.
// This builder emits cch=00000; signing.tdd.test.ts covers the final request checksum.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getClaudeBillingHeader, getClaudeEffectiveEntrypoint } from '../../src/claude/attribution.js';
import type { Json } from '../../src/types.js';

const ATTRIBUTION_ENV_KEYS = ['CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_ACTION', 'CLAUDE_CODE_ATTRIBUTION_HEADER'] as const;
let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  savedEnv = Object.fromEntries(ATTRIBUTION_ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of ATTRIBUTION_ENV_KEYS) delete process.env[key];
});
afterEach(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

const userText = (text: string): Json => ({ type: 'message', role: 'user', content: [{ type: 'input_text', text }] });

describe('getClaudeEffectiveEntrypoint', () => {
  it('defaults to cli when nothing is set (interactive branch of T)', () => {
    expect(getClaudeEffectiveEntrypoint()).toBe('cli');
  });

  it('resolves an empty entrypoint through the startup normalizer, not the raw nullish fallback', () => {
    process.env.CLAUDE_CODE_ENTRYPOINT = '';
    expect(getClaudeEffectiveEntrypoint()).toBe('cli');
  });

  it('keeps a nonempty entrypoint verbatim', () => {
    process.env.CLAUDE_CODE_ENTRYPOINT = 'sdk-ts';
    expect(getClaudeEffectiveEntrypoint()).toBe('sdk-ts');
  });

  it('preserves a whitespace-only entrypoint verbatim', () => {
    process.env.CLAUDE_CODE_ENTRYPOINT = ' ';
    expect(getClaudeEffectiveEntrypoint()).toBe(' ');
  });

  it('renames local_agent to local-agent (T at 215050094)', () => {
    process.env.CLAUDE_CODE_ENTRYPOINT = 'local_agent';
    expect(getClaudeEffectiveEntrypoint()).toBe('local-agent');
  });

  it('never converts cli to sdk-cli: the gateway is always interactive', () => {
    process.env.CLAUDE_CODE_ENTRYPOINT = 'cli';
    expect(getClaudeEffectiveEntrypoint()).toBe('cli');
  });

  it('resolves missing or empty entrypoint to the GitHub action when CLAUDE_CODE_ACTION is truthy', () => {
    for (const value of ['1', 'true', 'YES', ' on ']) {
      process.env.CLAUDE_CODE_ACTION = value;
      expect(getClaudeEffectiveEntrypoint()).toBe('claude-code-github-action');
      process.env.CLAUDE_CODE_ENTRYPOINT = '';
      expect(getClaudeEffectiveEntrypoint()).toBe('claude-code-github-action');
      delete process.env.CLAUDE_CODE_ACTION;
      delete process.env.CLAUDE_CODE_ENTRYPOINT;
    }
  });

  it('keeps cli when CLAUDE_CODE_ACTION is falsy per Le', () => {
    for (const value of ['0', 'false', 'no', 'off', '']) {
      process.env.CLAUDE_CODE_ACTION = value;
      expect(getClaudeEffectiveEntrypoint()).toBe('cli');
      delete process.env.CLAUDE_CODE_ACTION;
    }
  });

  it('a nonempty entrypoint wins over CLAUDE_CODE_ACTION', () => {
    process.env.CLAUDE_CODE_ENTRYPOINT = 'sdk-ts';
    process.env.CLAUDE_CODE_ACTION = '1';
    expect(getClaudeEffectiveEntrypoint()).toBe('sdk-ts');
  });
});

describe('billing attribution (wSo BASIC)', () => {
  it('builds the exact basic shape with the literal fingerprint for "weather?"', () => {
    // Literal vector from the native algorithm: chars "h?0" -> sha256("59cf53e54c78h?02.1.299") -> "205".
    expect(getClaudeBillingHeader([userText('weather?')])).toBe('x-anthropic-billing-header: cc_version=2.1.299.205; cc_entrypoint=cli; cch=00000;');
  });

  it('uses the effective entrypoint in cc_entrypoint', () => {
    process.env.CLAUDE_CODE_ENTRYPOINT = 'local_agent';
    expect(getClaudeBillingHeader([userText('weather?')])).toContain('cc_entrypoint=local-agent;');
    process.env.CLAUDE_CODE_ACTION = '1';
    delete process.env.CLAUDE_CODE_ENTRYPOINT;
    expect(getClaudeBillingHeader([userText('weather?')])).toContain('cc_entrypoint=claude-code-github-action;');
  });

  it('omits every optional lifecycle/workload/subagent field (BASIC attribution)', () => {
    const header = getClaudeBillingHeader([userText('weather?')]);
    for (const omitted of ['cc_workload', 'cc_is_subagent', 'cc_prev_req', 'cc_prompt_id', 'cc_turn_origin', 'cc_prompt_index', 'cc_turn_index', 'cc_gateway']) {
      expect(header).not.toContain(omitted);
    }
  });

  it('opts out only on the native ys values, with trim and lowercase', () => {
    for (const value of ['0', 'false', 'NO', ' off ']) {
      process.env.CLAUDE_CODE_ATTRIBUTION_HEADER = value;
      expect(getClaudeBillingHeader([userText('weather?')])).toBe('');
    }
  });

  it('stays enabled for unset, empty or other values', () => {
    for (const value of ['', '1', 'yes', 'banana']) {
      process.env.CLAUDE_CODE_ATTRIBUTION_HEADER = value;
      expect(getClaudeBillingHeader([userText('weather?')])).not.toBe('');
    }
  });
});

describe('fingerprint first-user extraction (qB adapted to OpenAI items)', () => {
  // Literal vectors precomputed from the native algorithm (Im at 222259800):
  // "" and "ab" -> chars "000" -> "fa6"; "abcdefghijklmnopqrstuvwxyz" -> chars "ehu" -> "aad";
  // "你好世界你好世界" -> chars "你界0" -> "c6f"; 21 emoji -> chars <lone surrogates> -> "e8e".
  const billingFp = (items: Json[]): string => /cc_version=2\.1\.299\.([0-9a-f]{3});/.exec(getClaudeBillingHeader(items))?.[1] ?? '';

  it('uses a string content whole', () => {
    expect(billingFp([{ type: 'message', role: 'user', content: 'abcdefghijklmnopqrstuvwxyz' }])).toBe('aad');
  });

  it('uses only the first text block of an array content', () => {
    const items = [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'abcdefghijklmnopqrstuvwxyz' }, { type: 'input_text', text: 'zzzzzzzzzzzzzzzzzzzzzzzzzz' }] }];
    expect(billingFp(items)).toBe('aad');
  });

  it('short and empty first text fall back to the 0 padding', () => {
    expect(billingFp([userText('ab')])).toBe('fa6');
    expect(billingFp([userText('')])).toBe('fa6');
  });

  it('handles Unicode beyond BMP by UTF-16 code units', () => {
    expect(billingFp([userText('你好世界你好世界')])).toBe('c6f');
    expect(billingFp([userText('😀'.repeat(21))])).toBe('e8e');
  });

  it('an image-only first user message yields empty and does not search on', () => {
    const items = [
      { type: 'message', role: 'user', content: [{ type: 'input_image', image_url: 'https://example.com/a.png' }] },
      userText('abcdefghijklmnopqrstuvwxyz'),
    ];
    expect(billingFp(items)).toBe('fa6');
  });

  it('a tool result is a user candidate whose tool_result block is not text', () => {
    const items = [
      { type: 'function_call_output', call_id: 'call_1', output: 'abcdefghijklmnopqrstuvwxyz' },
      userText('abcdefghijklmnopqrstuvwxyz'),
    ];
    expect(billingFp(items)).toBe('fa6');
  });

  it('system and developer messages are not user candidates', () => {
    const items = [
      { type: 'message', role: 'system', content: [{ type: 'text', text: 'abcdefghijklmnopqrstuvwxyz' }] },
      { type: 'message', role: 'developer', content: [{ type: 'text', text: 'abcdefghijklmnopqrstuvwxyz' }] },
      userText('ab'),
    ];
    expect(billingFp(items)).toBe('fa6');
  });

  it('computes before adjacent user items merge', () => {
    const items = [
      { type: 'message', role: 'user', content: [] },
      userText('abcdefghijklmnopqrstuvwxyz'),
    ];
    expect(billingFp(items)).toBe('fa6');
  });

  it('no user message at all yields the empty-text fingerprint', () => {
    expect(billingFp([{ type: 'function_call', call_id: 'call_1', name: 'x', arguments: '{}' }])).toBe('fa6');
  });
});
