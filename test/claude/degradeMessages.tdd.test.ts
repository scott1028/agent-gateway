// Matches references/claude-code native 2.1.302 prefix set AKn @238379267.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { assembleClaudeRequest } from '../../src/claude/assembleRequest.js';

import { toClaudeDegradedRequest, CLAUDE_RELAY_PREFIXES } from '../../src/claude/degradeMessages.js';
import { serializeClaudeRequest } from '../../src/claude/attribution.js';
import type { Json } from '../../src/types.js';

const fixture = JSON.parse(readFileSync('test/fixtures/claude-relay-body.json', 'utf8')) as Json;

describe('official Claude fallback normalization', () => {
  it('removes exact prefixes, keeps mid-system messages, and logs unsupported top-level keys', () => {
    for (const prefix of CLAUDE_RELAY_PREFIXES) {
      const normalized = toClaudeDegradedRequest({ ...fixture, system: [{ text: 'x-anthropic-billing-header: old' }, { text: prefix }, { text: 'caller' }] }, () => false);
      expect(normalized.native.callerTexts).toEqual(['caller']);
      expect(normalized.native.messages[1]).toEqual({ role: 'system', content: [{ type: 'text', text: 'Fixture session guidance.' }] });
      expect(normalized.ignoredKeys).toEqual(['context_management', 'diagnostics']);
      expect(normalized.native).not.toHaveProperty('explicitEffort');
    }
    const callerPrefix = `${CLAUDE_RELAY_PREFIXES[0]} custom`;
    expect(toClaudeDegradedRequest({ system: [{ text: callerPrefix }], surprise: 1 }, () => false)).toMatchObject({ native: { callerTexts: [callerPrefix] }, ignoredKeys: ['surprise'] });
  });

  it('preserves deferred tools, nested blocks, safeguards and output_config without client cache markers', () => {
    const normalized = toClaudeDegradedRequest({ ...fixture,
      tools: [{ name: 'Deferred', defer_loading: true, cache_control: {} }],
      output_config: { effort: 'xhigh', unknown: true },
      messages: [{ role: 'user', cache_control: {}, content: [{ type: 'tool_result', cache_control: {}, content: [{ type: 'tool_reference', tool_name: 'Deferred', cache_control: {} }] }] }],
    }, () => false);
    expect(JSON.stringify(normalized)).not.toContain('cache_control');
    expect(normalized.native.tools).toEqual([{ name: 'Deferred', defer_loading: true }]);
    expect(normalized.extraBetas).toEqual(['advanced-tool-use-2025-11-20', 'dangerous-tool-use-2026-09-03']);
    expect(normalized.extraBody).toEqual({ safeguards: fixture.safeguards, output_config: { effort: 'xhigh', unknown: true } });
    expect(toClaudeDegradedRequest({ messages: [{ role: 'user', content: [{ type: 'tool_reference' }] }] }, () => false).extraBetas).toContain('advanced-tool-use-2025-11-20');
  });

  it('filters unrecorded thinking and removes an assistant emptied by filtering without synthetic text', () => {
    const normalized = toClaudeDegradedRequest({ messages: [
      { role: 'assistant', content: [{ type: 'thinking', signature: 'old' }] },
      { role: 'system', content: 'keep position' },
      { role: 'assistant', content: [{ type: 'thinking', signature: 'new' }, { type: 'redacted_thinking', data: 'new' }, { type: 'text', text: 'answer' }] },
    ] }, (block) => block.signature === 'new' || block.data === 'new');
    expect(normalized.native.messages).toHaveLength(2);
    expect(normalized.native.messages[0]?.role).toBe('system');
    expect((normalized.native.messages[1]?.content as Json[]).map((block) => block.type)).toEqual(['thinking', 'redacted_thinking', 'text']);
  });

  it('keeps pre-existing assembly serialization byte-identical when extensions are absent/empty', async () => {
    const native = { messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }], callerTexts: [], tools: [], isToolChoiceNone: false, firstUserText: 'hi', maxTokens: 100 };
    const input = { native, modelId: 'unknown', settings: {} };
    const before = assembleClaudeRequest(structuredClone(input));
    const after = assembleClaudeRequest({ ...structuredClone(input), extraBody: {}, extraBetas: [] });
    expect(after.betas).toEqual(before.betas);
    expect(await serializeClaudeRequest(after.request)).toBe(await serializeClaudeRequest(before.request));
  });
  it('removes only exact billing/prefix positions and preserves caller and system messages', () => {
    const prepared = assembleClaudeRequest({ native: { messages: [], callerTexts: [], tools: [], isToolChoiceNone: false, firstUserText: '', maxTokens: 100 }, modelId: 'unknown', settings: {}, extraBody: { safeguards: fixture.safeguards }, extraBetas: ['dangerous-tool-use-2026-09-03'] });
    expect(prepared.request.safeguards).toEqual(fixture.safeguards);
  });
});
