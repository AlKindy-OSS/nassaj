/**
 * codex-auth-shape — ADR-200 S3/G2: the auth.json shapes nassaj writes around
 * an OpenAI API key, shared by the credential writer and the backup restore so
 * both derive `auth_mode` the same way (see resolveCodexEffectiveAuth for the
 * measured precedence). Pure functions over a parsed object; no I/O.
 */

import { readObjectRecord, readOptionalString } from '@/shared/utils.js';

import { resolveCodexEffectiveAuth } from './codex-auth.provider.js';

type AuthObject = Record<string, unknown>;

/** auth.json field the Codex CLI stores an API-key login under. */
export const CODEX_API_KEY_FIELD = 'OPENAI_API_KEY';

const hasOwn = (value: AuthObject, field: string): boolean =>
  Object.prototype.hasOwnProperty.call(value, field);

/** The key merged in; auth_mode flips to "apikey" only where a mode is recorded. */
export function withCodexApiKey(auth: AuthObject, apiKey: string): AuthObject {
  const next: AuthObject = { ...auth };
  if (hasOwn(auth, 'auth_mode')) next.auth_mode = 'apikey';
  next[CODEX_API_KEY_FIELD] = apiKey;
  return next;
}

/** The `tokens` fields that make a ChatGPT login the CLI can resume (B-1575). */
const CODEX_LOGIN_TOKEN_FIELDS = ['refresh_token', 'id_token', 'access_token'] as const;

/**
 * B-1574/B-1575: a stored id, access or refresh token is a ChatGPT login the
 * CLI can resume, so a key delete hands the mode back to it. `account_id`
 * alone (or any other field) is not a login. One detector for the writer and
 * the restore.
 */
export function hasCodexLoginTokens(auth: AuthObject): boolean {
  const tokens = readObjectRecord(auth.tokens) ?? {};
  return CODEX_LOGIN_TOKEN_FIELDS.some((field) => readOptionalString(tokens[field]) !== undefined);
}

/** The key removed; with login tokens and a recorded mode, back to the CLI's ChatGPT shape. */
export function withoutCodexApiKey(auth: AuthObject): AuthObject {
  const next: AuthObject = { ...auth };
  if (hasCodexLoginTokens(auth) && hasOwn(auth, 'auth_mode')) {
    next.auth_mode = 'chatgpt';
    next[CODEX_API_KEY_FIELD] = null;
    return next;
  }
  delete next[CODEX_API_KEY_FIELD];
  if (next.auth_mode === 'apikey') delete next.auth_mode;
  return next;
}

/**
 * `auth_mode` after a key-fields restore (G2 N-2). `merged` is `current` with
 * the backup's OPENAI_API_KEY put back. A restore never moves a working
 * ChatGPT login onto the key: with login tokens present (hasCodexLoginTokens)
 * and the login in effect, the mode is pinned to "chatgpt". Otherwise the writer's own shapes
 * apply — a key without tokens is "apikey", no key with tokens is "chatgpt".
 */
export function codexAuthAfterKeyRestore(current: AuthObject, merged: AuthObject): AuthObject {
  const key = readOptionalString(merged[CODEX_API_KEY_FIELD]);
  if (!key) return withoutCodexApiKey(merged);
  if (!hasCodexLoginTokens(merged)) return withCodexApiKey(merged, key);
  if (resolveCodexEffectiveAuth(current) === 'subscription') return { ...merged, auth_mode: 'chatgpt' };
  return merged;
}
