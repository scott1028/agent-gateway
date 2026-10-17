export type Json = Record<string, unknown>;

export type DebugLevel = 0 | 1 | 2 | 3;

export type AuthTokens = Json & {
  id_token: string;
  access_token: string;
  refresh_token: string;
  account_id?: string;
};

export type AuthFile = Json & {
  auth_mode?: string;
  tokens?: AuthTokens;
  last_refresh?: string;
};

export type Credentials = {
  accessToken: string;
  accountId?: string;
  isFedramp: boolean;
};

export type RefreshResult = {
  id_token?: string;
  access_token?: string;
  refresh_token?: string;
};

export type CodexHome = {
  alias: string;
  homePath: string;
  authPath: string;
};

export type ClaudeHome = {
  alias: string;
  homePath: string;
  credentialsPath: string;
  settingsPath: string;
  stateDir: string;
};

export type Provider = 'codex' | 'claude';

// Homes found by --auto; skippedHomes matched the name but are not logged in or repeat an earlier home.
export type AutoHomes = { codexHomes: string[]; claudeHomes: string[]; skippedHomes: { homePath: string; reason: string }[] };

export type Config = {
  port: number;
  host: string;
  apiKey?: string;
  codexHomes: CodexHome[];
  claudeHomes: ClaudeHome[];
  baseUrl: string;
  refreshUrl: string;
  clientVersion: string;
  contextLength: number;
  defaultModelId?: string;
};

export type CodexModel = Json & {
  slug: string;
  visibility?: string;
  priority?: number;
  use_responses_lite?: boolean;
  default_reasoning_level?: string;
};

export type ResponsesRequest = Json & {
  model: string;
  input: Json[];
  stream: boolean;
  store: boolean;
};

export type ResponsesEvent = Json & { type: string };

export type ResponsesUsage = {
  input_tokens?: number;
  input_tokens_details?: { cached_tokens?: number } | null;
  output_tokens?: number;
  output_tokens_details?: { reasoning_tokens?: number } | null;
  total_tokens?: number;
};

export type CollectedResponse = {
  response: Json;
  outputItems: Json[];
};

export type ChatToolCall = {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
};

export type ChatMessage = {
  role: string;
  content?: string | Json[] | null;
  tool_calls?: ChatToolCall[];
  tool_call_id?: string;
};

export type ChatUsage = {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  prompt_tokens_details: { cached_tokens: number };
  completion_tokens_details: { reasoning_tokens: number };
};

export type ChatChunk = Json & { object: 'chat.completion.chunk' };

export type OpenAiErrorBody = {
  error: { message: string; type: string; param: string | null; code: string | null };
};

export type AnthropicErrorBody = {
  type: 'error';
  error: { type: string; message: string };
};
