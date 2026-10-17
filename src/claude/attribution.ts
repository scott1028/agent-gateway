// Startup entrypoint resolution and basic billing attribution, copied from the pinned native
// release 2.1.299: startup normalizer T at binary offset 215050094, env truthiness Le and
// opt-out ys at 214625500, billing builder wSo at 218606801, first-user extraction qB and
// fingerprint Im at 222259800. references/claude-code @9b4f0d6 plugin code is not the CLI
// transport; the offsets come from the local native release (SHA256 2d894a4b1bfaaa9a).
import { createHash } from 'node:crypto';
import xxhash from 'xxhash-wasm';
import { CLAUDE_BILLING_SALT, CLAUDE_CLI_VERSION } from '../constants.js';
import type { Json } from '../types.js';

// T at 215050094, interactive branch: a nonempty entrypoint is kept verbatim except the
// local_agent -> local-agent rename; missing or empty resolves via CLAUDE_CODE_ACTION. The
// gateway is always interactive, so the native cli -> sdk-cli rewrite and the mcp-serve argv
// probe do not apply. Reads env only; never mutates it.
export const getClaudeEffectiveEntrypoint = (): string => {
  const entrypoint = process.env.CLAUDE_CODE_ENTRYPOINT;
  if (entrypoint) return entrypoint === 'local_agent' ? 'local-agent' : entrypoint;
  // Le at 214625500: trim/lowercase membership in the truthy set.
  const action = process.env.CLAUDE_CODE_ACTION;
  if (action !== undefined && ['1', 'true', 'yes', 'on'].includes(action.toLowerCase().trim())) return 'claude-code-github-action';
  return 'cli';
};

// qB at 222259800 adapted to pre-normalization OpenAI items: the first user candidate decides
// the text; string content is used whole, an array only its first text block, and a candidate
// without a top-level text block (images only, tool results) yields empty instead of searching
// on. Computed before adjacent user items merge; system/developer are not user candidates.
const getFirstUserText = (items: Json[]): string => {
  for (const item of items) {
    if (item.type === 'function_call_output') return '';
    if (item.type !== 'message' || (item.role ?? 'user') !== 'user') continue;
    if (typeof item.content === 'string') return item.content;
    if (!Array.isArray(item.content)) return '';
    const firstText = (item.content as Json[]).find((part) => part.type === 'text' || part.type === 'input_text');
    return firstText === undefined ? '' : String(firstText.text ?? '');
  }
  return '';
};

// Im at 222259800: UTF-16 code units at 4/7/20 (missing -> "0"), salted SHA-256, first 3 hex
// characters. JS string indexing matches the native generator for surrogate pairs.
const getClaudeFingerprint = (text: string): string => {
  const chars = [4, 7, 20].map((index) => text[index] || '0').join('');
  return createHash('sha256').update(`${CLAUDE_BILLING_SALT}${chars}${CLAUDE_CLI_VERSION}`).digest('hex').slice(0, 3);
};

// wSo at 218606801, BASIC attribution: cch is a placeholder, signed after request shaping.
// The native signer lives outside the embedded JS. Lifecycle/workload/subagent fields are omitted.
// wSo alone falls back to
// "unknown" for the raw env, but production runs behind the startup normalizer T, so the shared
// effective entrypoint is used instead. The result is a system text block, never an HTTP header.
export const getClaudeBillingHeader = (items: Json[]): string => {
  // ys at 214625500: only an explicit falsy string opts out; unset and empty stay enabled.
  const optOut = process.env.CLAUDE_CODE_ATTRIBUTION_HEADER;
  if (optOut !== undefined && ['0', 'false', 'no', 'off'].includes(optOut.toLowerCase().trim())) return '';
  return `x-anthropic-billing-header: cc_version=${CLAUDE_CLI_VERSION}.${getClaudeFingerprint(getFirstUserText(items))}; cc_entrypoint=${getClaudeEffectiveEntrypoint()}; cch=00000;`;
};

let claudeHasher: ReturnType<typeof xxhash> | undefined;

// Mirrors references/CLIProxyAPI/internal/runtime/executor/claude_signing.go at v8.0.29.
// Input has already passed through JSON.stringify/parse, so order and escaping match the wire.
const getClaudeCchInput = (node: unknown): string => {
  if (Array.isArray(node)) return `[${node.map(getClaudeCchInput).join(',')}]`;
  if (node === null || typeof node !== 'object') return JSON.stringify(node) as string;
  const members: string[] = [];
  let trailingDispatchCount = 0;
  for (const [key, content] of Object.entries(node)) {
    if (key === 'max_tokens' || key === 'fallbacks' || key === 'fallback_credit_token') {
      trailingDispatchCount += 1;
      continue;
    }
    trailingDispatchCount = 0;
    members.push(`${JSON.stringify(key)}:${key === 'model' && typeof content === 'string' ? '""' : getClaudeCchInput(content)}`);
  }
  // The native hash view keeps this comma for a trailing run of multiple excluded members.
  const trailingComma = members.length > 0 && trailingDispatchCount > 1 ? ',' : '';
  return `{${members.join(',')}${trailingComma}}`;
};

// Sign the final serialized body; never mutate replay state or replace caller-authored text.
export const serializeClaudeRequest = async (request: Json): Promise<string> => {
  const body = JSON.stringify(request);
  const serialized = JSON.parse(body) as Json;
  const billing = Array.isArray(serialized.system) ? serialized.system[0] as Json | undefined : undefined;
  if (typeof billing?.text !== 'string' || !billing.text.startsWith('x-anthropic-billing-header:')) return body;
  const checksumPattern = /\bcch=[0-9a-f]{5};/;
  if (!checksumPattern.test(billing.text)) return body;
  const unsignedBilling = billing.text.replace(checksumPattern, 'cch=00000;');
  billing.text = unsignedBilling;
  const { h64 } = await (claudeHasher ??= xxhash());
  // Native 2.1.299 contains the same seed at file offset 0x3b012c9.
  const checksum = (h64(getClaudeCchInput(serialized), 0x4d659218e32a3268n) & 0xfffffn).toString(16).padStart(5, '0');
  billing.text = unsignedBilling.replace(checksumPattern, `cch=${checksum};`);
  return JSON.stringify(serialized);
};
