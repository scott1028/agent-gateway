// Only for already-identified official Claude Code; nativeMessages.ts stays strict for 2b.
// Mirrors references/claude-code native 2.1.302 AKn @238379267 (exact prefix set).
import type { Json } from '../types.js';
import type { ClaudeNativeRequest } from './nativeMessages.js';

export const CLAUDE_RELAY_PREFIXES = [
  "You are Claude Code, Anthropic's official CLI for Claude.",
  "You are Claude Code, Anthropic's official CLI for Claude, running within the Claude Agent SDK.",
  "You are a Claude agent, built on Anthropic's Claude Agent SDK.",
];
const HANDLED_KEYS = new Set(['model', 'messages', 'system', 'tools', 'tool_choice', 'max_tokens', 'stream', 'output_config', 'thinking', 'metadata', 'safeguards']);
const getIsObject = (block: unknown): block is Json => typeof block === 'object' && block !== null && !Array.isArray(block);

export const toClaudeDegradedRequest = (body: Json, shouldKeepThinking: (block: Json) => boolean): ClaudeNativeRequest & { extraBody: Json; extraBetas: string[] } => {
  let hasToolReference = false;
  // Recurse through content, not tool inputs or schemas: their property names belong to callers.
  const cleanBlock = (block: Json): Json => {
    const { cache_control: _cacheControl, ...cleaned } = block;
    if (block.type === 'tool_reference') hasToolReference = true;
    if (Array.isArray(block.content)) cleaned.content = cleanBlocks(block.content);
    return cleaned;
  };
  const cleanBlocks = (blocks: unknown[]): unknown[] => blocks.flatMap((block) => {
    if (!getIsObject(block)) return [block];
    if ((block.type === 'thinking' || block.type === 'redacted_thinking') && !shouldKeepThinking(block)) return [];
    return [cleanBlock(block)];
  });
  const messages = (Array.isArray(body.messages) ? body.messages : []).filter(getIsObject).map(cleanBlock).filter((message) =>
    // Anthropic forbids empty content. Dropping a thinking-only assistant avoids inventing text;
    // adjacent same-role messages are accepted and combined by the Messages API.
    !(message.role === 'assistant' && Array.isArray(message.content) && message.content.length === 0));
  const system = typeof body.system === 'string' ? [{ text: body.system }] : Array.isArray(body.system) ? [...body.system] as Json[] : [];
  if (typeof system[0]?.text === 'string' && system[0].text.startsWith('x-anthropic-billing-header:')) system.shift();
  if (typeof system[0]?.text === 'string' && CLAUDE_RELAY_PREFIXES.includes(system[0].text)) system.shift();
  const tools = (Array.isArray(body.tools) ? body.tools : []).filter(getIsObject).map(({ cache_control: _cacheControl, ...tool }) => tool);
  const firstMessage = messages[0] ?? {};
  const firstUser = messages.find((message) => message.role === 'user');
  const firstUserText = typeof firstUser?.content === 'string' ? firstUser.content : Array.isArray(firstUser?.content)
    ? firstUser.content.filter(getIsObject).filter((block) => block.type === 'text').map((block) => String(block.text ?? '')).join('\n') : '';
  const extraBetas: string[] = [];
  // Native 2.1.302 ToolSearch beta and safeguards beta; see protocol diff §13.
  if (hasToolReference || tools.some((tool) => tool.defer_loading === true)) extraBetas.push('advanced-tool-use-2025-11-20');
  if (body.safeguards !== undefined) extraBetas.push('dangerous-tool-use-2026-09-03');
  return {
    model: typeof body.model === 'string' ? body.model : 'claude',
    isStream: body.stream === true,
    ignoredKeys: Object.keys(body).filter((key) => !HANDLED_KEYS.has(key)),
    firstMessage,
    native: {
      messages, callerTexts: system.map((block) => String(block.text ?? '')), tools,
      isToolChoiceNone: false,
      ...(getIsObject(body.tool_choice) ? { toolChoice: body.tool_choice } : {}),
      ...(typeof body.max_tokens === 'number' ? { maxTokens: body.max_tokens } : {}),
      firstUserText,
    },
    extraBody: {
      ...(body.safeguards === undefined ? {} : { safeguards: body.safeguards }),
      ...(getIsObject(body.output_config) ? { output_config: body.output_config } : {}),
    },
    extraBetas,
  };
};
