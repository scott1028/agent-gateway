import os from 'node:os';
import { ORIGINATOR, RESPONSES_LITE_HEADER, TURN_STATE_HEADER } from '../constants.js';
import type { Credentials } from '../types.js';

// Mirrors references/codex/codex-rs/login/src/auth/default_client.rs get_codex_user_agent format.
// Keeps the `agent-gateway` suffix on purpose: match manners, not identity (see AGENTS.md).
export const getUserAgent = (clientVersion: string): string =>
  `${ORIGINATOR}/${clientVersion} (${os.type()} ${os.release()}; ${os.arch()}) agent-gateway`;

// Mirrors the header set Codex sends on POST /responses (all optional except auth, per PoC).
export const buildUpstreamHeaders = (input: {
  credentials: Credentials;
  clientVersion: string;
  userAgent: string;
  sessionId?: string;
  isResponsesLite?: boolean;
  turnState?: string;
}): Record<string, string> => {
  const headers: Record<string, string> = {
    authorization: `Bearer ${input.credentials.accessToken}`,
    originator: ORIGINATOR,
    'user-agent': input.userAgent,
    version: input.clientVersion,
  };
  if (input.credentials.accountId) headers['chatgpt-account-id'] = input.credentials.accountId;
  if (input.credentials.isFedramp) headers['x-openai-fedramp'] = 'true';
  if (input.sessionId) {
    headers['session-id'] = input.sessionId;
    headers['thread-id'] = input.sessionId;
    headers['x-client-request-id'] = input.sessionId;
  }
  if (input.isResponsesLite) headers[RESPONSES_LITE_HEADER] = 'true';
  if (input.turnState) headers[TURN_STATE_HEADER] = input.turnState;
  return headers;
};
