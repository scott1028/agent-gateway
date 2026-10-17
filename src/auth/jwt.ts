import type { Json } from '../types.js';

export const decodeJwtPayload = (jwt: string): Json | undefined => {
  const payload = jwt.split('.')[1];
  if (!payload) return undefined;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return typeof parsed === 'object' && parsed !== null ? (parsed as Json) : undefined;
  } catch {
    return undefined;
  }
};

export const getJwtExpiryMs = (jwt: string): number | undefined => {
  const exp = decodeJwtPayload(jwt)?.exp;
  return typeof exp === 'number' ? exp * 1000 : undefined;
};

export const getAuthClaims = (idToken: string): { accountId?: string; isFedramp: boolean } => {
  const claims = decodeJwtPayload(idToken)?.['https://api.openai.com/auth'];
  const authClaims = typeof claims === 'object' && claims !== null ? (claims as Json) : {};
  return {
    accountId: typeof authClaims.chatgpt_account_id === 'string' ? authClaims.chatgpt_account_id : undefined,
    isFedramp: authClaims.chatgpt_account_is_fedramp === true,
  };
};
