// Claude upstream types. The credential record mirrors the official release's
// `.credentials.json` `claudeAiOauth` shape (binary offset 217983010 uE).
import type { Json } from '../types.js';

export type ClaudeOauth = Json & {
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: number | null;
  refreshTokenExpiresAt?: number | null;
  scopes?: string[];
  subscriptionType?: string | null;
  rateLimitTier?: string | null;
  clientId?: string;
};

export type ClaudeAuthFile = Json & { claudeAiOauth?: ClaudeOauth | null };

export type ClaudeCredentials = { accessToken: string };

export type ClaudeModel = Json & { id: string };

export type ClaudeModelMetadata = {
  id: string;
  firstPartyId: string;
  contextWindow?: number;
  maxOutputDefault: number;
  maxOutputUpper: number;
  defaultEffort?: string;
  capabilities: readonly string[];
};

// Home settings.json subset that the gateway honours (binary offset 215527644 settings schema).
export type ClaudeModelSettings = { effortLevel?: string; maxEffortLevel?: string };

export type ClaudeSettings = {
  alwaysThinkingEnabled?: boolean;
  effortLevel?: string;
  maxEffortLevel?: string;
  modelSettings?: Record<string, ClaudeModelSettings>;
};

// `requestedEffort` is gateway-internal (never upstream): the explicit word the client sent when
// the turn was created, so a repeated request stays pinned when home settings change mid-turn.
export type ClaudeThinking = { type: 'adaptive' | 'enabled' | 'disabled'; effort?: string; budgetTokens?: number; requestedEffort?: string };

// Gateway-owned replay state for one assistant turn: the native assistant content blocks
// (thinking/signature/redacted_thinking/text/tool_use) kept verbatim, plus the call ids they answer.
// accountIdentity/identity are stored so a record copied under another key is detected, not replayed.
export type ClaudeTurnState = {
  version: number;
  alias: string;
  model: string;
  accountIdentity: string;
  identity: string;
  thinking: ClaudeThinking;
  savedAtMs: number;
  assistantContent: Json[];
  callIds: string[];
};

export type ClaudeRequest = Json & {
  model: string;
  messages: Json[];
  max_tokens: number;
};
