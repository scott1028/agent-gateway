export const CODEX_BASE_URL = 'https://chatgpt.com/backend-api/codex';
export const REFRESH_URL = 'https://auth.openai.com/oauth/token';
export const OAUTH_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
export const ORIGINATOR = 'codex_cli_rs';
// Backend filters the model catalog by client version (0.100.0 only returns 1 model).
export const DEFAULT_CLIENT_VERSION = '0.162.1';
export const DEFAULT_PORT = 8765;
export const DEFAULT_HOST = '127.0.0.1';
// Only labels the context window we advertise in /v1/models; it never limits a request.
export const DEFAULT_CONTEXT_LENGTH = 250000;
// Project-owned multi-account routing: alias is `codex` + 1-based home order, model ids are `alias/slug`.
export const CODEX_HOME_ALIAS_PREFIX = 'codex';
export const MODEL_ID_SEPARATOR = '/';

export const RESPONSES_LITE_HEADER = 'x-openai-internal-codex-responses-lite';
export const TURN_STATE_HEADER = 'x-codex-turn-state';
export const DEFAULT_FUNCTION_NAMESPACE = 'functions';

export const REFRESH_BEFORE_EXPIRY_MS = 5 * 60 * 1000;
export const REFRESH_FALLBACK_AGE_MS = 8 * 24 * 60 * 60 * 1000;
export const MODEL_CATALOG_TTL_MS = 5 * 60 * 1000;
export const MAX_BODY_BYTES = 50 * 1024 * 1024;

// Verified by scripts/poc.ts: the backend accepts these fields and rejects most others
// (temperature, top_p, metadata, user, truncation, safety_identifier, top_logprobs, ...).
export const ALLOWED_RESPONSES_FIELDS = [
  'model',
  'input',
  'instructions',
  'tools',
  'tool_choice',
  'parallel_tool_calls',
  'reasoning',
  'include',
  'prompt_cache_key',
  'text',
  'service_tier',
  'max_output_tokens',
] as const;
export const REQUIRED_INCLUDE = 'reasoning.encrypted_content';
// Backend rejects `ultra`; Codex resolves it to `max` on the client side.
export const REASONING_EFFORT_ALIASES: Record<string, string> = { ultra: 'max' };

export const FORWARDED_RESPONSE_HEADERS = ['x-oai-request-id', 'openai-model', 'x-models-etag'];
export const FORWARDED_RESPONSE_HEADER_PREFIX = 'x-codex-';
export const LOCAL_HOSTNAMES = ['127.0.0.1', 'localhost', '[::1]'];
// Bind addresses that stay on this machine; any other --host needs AGENT_GATEWAY_API_KEY.
// No 'localhost': DNS or /etc/hosts decides where it binds.
export const LOOPBACK_BIND_HOSTS = ['127.0.0.1', '::1'];

// Claude upstream. Values marked "binary" come from the pinned official release
// /home/scott/.local/share/claude/versions/2.1.299 (SHA256 2d894a4b...d077,
// GIT_SHA c416f56ec7eca27e49747c35af51d5c92c856ba1) read statically; offsets are in docs/CLAUDE_UPSTREAM_PROTOCOL_DIFF.md.
// Binary offset 214897810 OAuth prod constants.
export const CLAUDE_BASE_URL = 'https://api.anthropic.com';
export const CLAUDE_TOKEN_URL = 'https://platform.claude.com/v1/oauth/token';
export const CLAUDE_OAUTH_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
// Pinned Claude reference release, matching references/claude-code (v2.1.299-1-g9b4f0d6) and the
// native binary VERSION at 218027148. The User-Agent mirrors the official $0() generator with this
// version (user-approved exception to the own-identity UA rule for the Claude path only).
export const CLAUDE_CLI_VERSION = '2.1.299';
// Project-owned multi-account routing for Claude homes, mirroring the Codex alias scheme.
export const CLAUDE_HOME_ALIAS_PREFIX = 'claude';
// references/claude-code/plugins/security-guidance/hooks/llm.py:195 anthropic-version.
export const CLAUDE_ANTHROPIC_VERSION = '2023-06-01';
// llm.py:199 and binary offset 214896989 (Ap) / 233338777 (models.list betas for OAuth).
export const CLAUDE_OAUTH_BETA = 'oauth-2025-04-20';
// Beta constant `ion` at binary offset 216789191; SL predicate at 217935646 sends it from the
// model capability Bzn(model), not from "thinking is on and tools exist".
export const CLAUDE_INTERLEAVED_THINKING_BETA = 'interleaved-thinking-2025-05-14';
// Beta constant `_ie` at binary offset 216789360; pushed by rNr at 226584124 only together with
// output_config.format. The plugin path uses a different date (llm.py) and is not used here.
export const CLAUDE_STRUCTURED_OUTPUTS_BETA = 'structured-outputs-2025-12-15';
// Beta constant `T8e` at binary offset 216789567; tGe at 226583782 pushes it whenever the model
// supports effort (bb), together with output_config.effort.
export const CLAUDE_EFFORT_BETA = 'effort-2025-11-24';
// Beta constant `R0t` at binary offset 216789124; the SL table at 217935458 sends it for every
// canonical model id that does not include "haiku".
export const CLAUDE_CODE_BETA = 'claude-code-20250219';
// references/CLIProxyAPI v8.0.29 claude_executor_request.go; native 2.1.299 SL @217935458.
export const CLAUDE_REDACT_THINKING_BETA = 'redact-thinking-2026-02-12';
export const CLAUDE_THINKING_TOKEN_COUNT_BETA = 'thinking-token-count-2026-05-13';
export const CLAUDE_CONTEXT_MANAGEMENT_BETA = 'context-management-2025-06-27';
export const CLAUDE_PROMPT_CACHING_SCOPE_BETA = 'prompt-caching-scope-2026-01-05';
// Binary offset 226675303: the main inference call is beta.messages.create({...stream:true}) and the
// beta resource at 218933955 posts this path. Plain /v1/messages is the regular/plugin resource.
export const CLAUDE_MESSAGES_PATH = '/v1/messages?beta=true';
// Binary offset 214896969: scope list n plus Dgt when PLUGINS_SCOPE_REGISTERED (true in prod).
export const CLAUDE_OAUTH_SCOPES = [
  'user:profile',
  'user:inference',
  'user:sessions:claude_code',
  'user:mcp_servers',
  'user:file_upload',
  'user:plugins',
] as const;
// Binary offset 217754567 OH(): Date.now() + 300000 >= expiresAt; null expiry never refreshes.
export const CLAUDE_REFRESH_BEFORE_EXPIRY_MS = 300_000;
// Binary offset 217749927 vwe: refresh request timeout 30000.
export const CLAUDE_REFRESH_TIMEOUT_MS = 30_000;
// Binary offset 219078970: SDK client timeout `skr() ?? 600000`.
export const CLAUDE_REQUEST_TIMEOUT_MS = 600_000;
// Binary offset 233338777: models.list({ limit: 1000 }) with pagination.
export const CLAUDE_MODELS_PAGE_LIMIT = 1000;
// Binary offset 217333107: credential file name under the config dir, written with mode 0600.
export const CLAUDE_CREDENTIALS_FILE = '.credentials.json';
export const CLAUDE_SETTINGS_FILE = 'settings.json';
// Gateway-owned state; never touches official Claude files.
export const CLAUDE_STATE_DIR = '.agent-gateway/claude-state';
export const CLAUDE_STATE_VERSION = 1;
// Native release 2.1.299 el at binary offset 218994031: the interactive CLI system prefix
// (T1n at 218994320 returns it for interactive sessions). Exact string, sent as a system block.
export const CLAUDE_CLI_SYSTEM_PREFIX = "You are Claude Code, Anthropic's official CLI for Claude.";
// The Anthropic SDK bundled inside native 2.1.299 (YT at binary offset 218715152). Separate from
// the CLI version: it drives the X-Stainless-Package-Version header only.
export const CLAUDE_SDK_VERSION = '0.128.0';
// Im at binary offset 222259800: salt for the billing fingerprint (XB constant).
export const CLAUDE_BILLING_SALT = '59cf53e54c78';
// Binary offset 215322655 (ua) and 215527644 (settings schema zSe at 218706528).
export const CLAUDE_EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export const CLAUDE_SETTINGS_EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh'] as const;
// Binary offset 226635226: budget thinking floor `Math.max(1024, Math.min(upper - 1, budget))`.
export const CLAUDE_MIN_THINKING_BUDGET_TOKENS = 1024;
// Binary offset 218703811 Zdt: effort above this level is clamped, not dropped, when thinking is
// disabled for a model that caps it (applied at 226635192).
export const CLAUDE_DISABLED_THINKING_EFFORT_CAP = 'high';
// Binary offset 218707300 `Te`: canonical ids the home top-level `effortLevel` may still apply to.
// pEr at 218709369 also applies it to models the release does not know (Nyo at 218707546).
export const CLAUDE_LEGACY_EFFORT_MODELS = [
  'claude-3-5-haiku',
  'claude-3-5-sonnet',
  'claude-3-7-sonnet',
  'claude-haiku-4-5',
  'claude-sonnet-4-0',
  'claude-sonnet-4-5',
  'claude-sonnet-4-6',
  'claude-sonnet-5',
  'claude-opus-4-0',
  'claude-opus-4-1',
  'claude-opus-4-5',
  'claude-opus-4-6',
  'claude-opus-4-7',
  'claude-opus-4-8',
  'claude-opus-5',
  'claude-fable-5',
  'claude-fable-5-1',
  'claude-mythos-5',
  'claude-mythos-5-1',
] as const;
// Binary offset 217931450 $Eo(): canonical ids that never take the adaptive thinking form.
export const CLAUDE_ADAPTIVE_THINKING_EXCLUSIONS = [
  'claude-opus-4-0',
  'claude-opus-4-1',
  'claude-opus-4-5',
  'claude-sonnet-4-0',
  'claude-sonnet-4-5',
  'claude-haiku-4-5',
] as const;
// Binary offset 217930405 WIs / 217932522 Bzn: in this release the 3.5 family is the only
// canonical family without thinking and without interleaved thinking on a first-party provider.
export const CLAUDE_THINKING_UNSUPPORTED_MARKER = 'claude-3-';
// Binary offset 217932900 jzn(): structured output is excluded for this model.
export const CLAUDE_STRUCTURED_OUTPUT_EXCLUDED_MODELS = ['claude-opus-4-1'] as const;
// Binary offsets 218701764 (bb), 218702215 (cse) and 218702663 (Qdt): canonical names that never
// take effort / max effort / xhigh effort on this release, whatever the pinned table says.
export const CLAUDE_EFFORT_UNSUPPORTED_NAMES = [
  'claude-opus-4-0',
  'claude-opus-4-1',
  'claude-sonnet-4-0',
  'claude-sonnet-4-5',
  'claude-haiku-4-5',
] as const;
export const CLAUDE_MAX_EFFORT_UNSUPPORTED_NAMES = [
  'claude-opus-4-0',
  'claude-opus-4-1',
  'claude-opus-4-5',
  'claude-sonnet-4-0',
  'claude-sonnet-4-5',
  'claude-haiku-4-5',
] as const;
export const CLAUDE_XHIGH_EFFORT_UNSUPPORTED_NAMES = [
  'claude-opus-4-0',
  'claude-opus-4-1',
  'claude-opus-4-5',
  'claude-opus-4-6',
  'claude-sonnet-4-0',
  'claude-sonnet-4-5',
  'claude-sonnet-4-6',
  'claude-haiku-4-5',
] as const;
// Binary offset 217997780 nGn: the official refresh lock is a directory, stale after 60000ms and
// kept fresh every 5000ms; pOs at 217998206 also holds the legacy `realpath(home) + ".lock"`.
export const CLAUDE_REFRESH_LOCK_DIR = '.oauth_refresh.lock';
export const CLAUDE_REFRESH_LOCK_STALE_MS = 60_000;
export const CLAUDE_REFRESH_LOCK_UPDATE_MS = 5_000;
// Binary offset 218001100 Za(): five retries spaced 1000ms + jitter, then one 7500ms busy wait.
export const CLAUDE_REFRESH_LOCK_RETRY_LIMIT = 5;
export const CLAUDE_REFRESH_LOCK_RETRY_BASE_MS = 1_000;
export const CLAUDE_REFRESH_LOCK_BUSY_WAIT_MS = 7_500;
// Binary offset 214897007: EHo() keeps only these previously held scopes when it expands a
// default subscriber refresh to the base CLI scopes (Lgt at 214897267).
export const CLAUDE_PROJECTS_SCOPES = ['user:projects:read', 'user:projects:write'] as const;
export const CLAUDE_INFERENCE_SCOPE = 'user:inference';
// Binary offset 214971963 W_/_4n and 217653633: `oauthAccount` (accountUuid/organizationUuid)
// lives in the global config file, preferred legacy name first.
export const CLAUDE_GLOBAL_CONFIG_FILES = ['.config.json', '.claude.json'] as const;
