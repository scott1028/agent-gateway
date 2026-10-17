// Claude upstream module boundary. The composition root gets one factory per configured home and
// the endpoint handlers get the request path; everything else in this folder stays internal.
import type { ClaudeAccount } from '../accounts.js';
import { CLAUDE_BASE_URL, CLAUDE_TOKEN_URL } from '../constants.js';
import type { ClaudeHome } from '../types.js';
import { createClaudeAuthManager, readClaudeAccountMetadata } from './auth.js';
import { createClaudeClient } from './client.js';
import { cloakClaudeMessages, getClaudeCloakBody } from './cloakMessages.js';
import { startClaudeCall } from './handleClaude.js';
import { createClaudeModelCatalog } from './models.js';
import { assertClaudeChatInput } from './normalizeRequest.js';
import { createClaudeRelaySessions, relayClaudeCountTokens, relayClaudeMessages } from './relayMessages.js';
import { createClaudeStateStore } from './state.js';
import { parseClaudeSseStream } from './sse.js';
import { translateClaudeStream } from './toResponsesEvents.js';

export { startClaudeCall, assertClaudeChatInput, parseClaudeSseStream, translateClaudeStream, readClaudeAccountMetadata, relayClaudeMessages, relayClaudeCountTokens, createClaudeRelaySessions, cloakClaudeMessages, getClaudeCloakBody };
export type { ClaudeRelaySessions } from './relayMessages.js';

// Reads the login once so a missing or dead credential fails at startup with the login hint,
// exactly like the Codex home check does. The account uuid is deliberately NOT captured here:
// startClaudeCall re-reads it per request so a re-login cannot keep replaying the old account.
export const createClaudeAccount = async (home: ClaudeHome, fetchFn?: typeof fetch): Promise<ClaudeAccount> => {
  const auth = createClaudeAuthManager({
    credentialsPath: home.credentialsPath,
    tokenUrl: CLAUDE_TOKEN_URL,
    stateDir: home.stateDir,
    fetchFn,
  });
  await auth.getCredentials();
  const client = createClaudeClient({ auth, baseUrl: CLAUDE_BASE_URL, credentialsPath: home.credentialsPath, fetchFn });
  return {
    provider: 'claude',
    alias: home.alias,
    homePath: home.homePath,
    settingsPath: home.settingsPath,
    client,
    catalog: createClaudeModelCatalog({ getModels: client.getModels }),
    state: createClaudeStateStore({ stateDir: home.stateDir }),
  };
};
