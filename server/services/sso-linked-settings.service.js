/**
 * Node settings for linked SSO sign-in and sign-out (ADR-H20 S6).
 *
 *   autoSignIn              N1: an unauthenticated visit goes straight to the IdP (default on;
 *                           an explicitly stored off is respected)
 *   ownerLoginHint          N3: static `login_hint` on an owner node (no "last user" cookie)
 *   postLogoutRedirectUri   N4: allow-listed return after the IdP end_session
 *   recheckIntervalHours    N8 / D9-1: silent prompt=none re-check, 1..24 h (default 12)
 *   idpSignOutAffectsOwner  N5 kill switch: an IdP sign-out ends the owner's browser session
 *                           (default on)
 *
 * There is no owner entry cap (ADR-194 A1 withdrawn 2026-10-18).
 * Writes are owner-only, behind step-up (the caller proves it), audited
 * strictly in the same transaction.
 */
// Namespace import: route tests replace the database barrel with partial mocks.
import * as databaseModule from '../modules/database/index.js';

const DEFAULTS = Object.freeze({
  autoSignIn: true,
  ownerLoginHint: null,
  postLogoutRedirectUri: null,
  recheckIntervalHours: 12,
  idpSignOutAffectsOwner: true,
});

export const INVALID_SSO_LINKED_SETTINGS_CODE = 'invalid_sso_linked_settings';

function logSettingsFailure(code) {
  process.stderr.write(`${JSON.stringify({ level: 'warn', scope: 'sso_linked_settings', code })}\n`);
}

/**
 * The effective settings. On a read failure the safe defaults apply (auto
 * sign-in on, no hint, no return URI, 12 h, kill switch on) and it is logged.
 * @returns {{ autoSignIn: boolean, ownerLoginHint: string | null, postLogoutRedirectUri: string | null,
 *   recheckIntervalHours: number, idpSignOutAffectsOwner: boolean }}
 */
export function readSsoLinkedSettings() {
  try {
    return databaseModule.ssoLinkedSettingsDb?.read() ?? { ...DEFAULTS };
  } catch {
    logSettingsFailure('read_failed');
    return { ...DEFAULTS };
  }
}

const VALIDATORS = Object.freeze({
  autoSignIn: (value) => (typeof value === 'boolean' ? value : undefined),
  idpSignOutAffectsOwner: (value) => (typeof value === 'boolean' ? value : undefined),
  ownerLoginHint: (value) => databaseModule.parseLoginHint(value),
  postLogoutRedirectUri: (value) => databaseModule.parsePostLogoutRedirectUri(value),
  recheckIntervalHours: (value) => databaseModule.parseRecheckIntervalHours(value),
});

/**
 * Merges a partial update into the current settings. Unknown fields and any
 * invalid value refuse the whole update.
 * @param {unknown} patch
 * @param {ReturnType<typeof readSsoLinkedSettings>} current
 * @returns {ReturnType<typeof readSsoLinkedSettings> | null}
 */
export function mergeSsoLinkedSettings(patch, current) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return null;
  const next = { ...current };
  const entries = Object.entries(patch);
  if (entries.length === 0) return null;
  for (const [field, value] of entries) {
    if (!Object.hasOwn(VALIDATORS, field)) return null;
    const parsed = VALIDATORS[field](value);
    if (parsed === undefined) return null;
    next[field] = parsed;
  }
  return next;
}

/**
 * Validates and stores an update; the write and the strict audit commit together.
 * @param {unknown} patch
 * @param {{ userId: number, ipAddress?: string | null, userAgent?: string | null }} actor
 * @returns {{ ok: true, settings: ReturnType<typeof readSsoLinkedSettings> } | { ok: false, code: string }}
 */
export function updateSsoLinkedSettings(patch, actor) {
  const db = databaseModule.getConnection();
  let result = { ok: false, code: INVALID_SSO_LINKED_SETTINGS_CODE };
  db.transaction(() => {
    const current = databaseModule.ssoLinkedSettingsDb.read();
    const next = mergeSsoLinkedSettings(patch, current);
    if (!next) return;
    databaseModule.ssoLinkedSettingsDb.write(next);
    const killSwitchChanged = next.idpSignOutAffectsOwner !== current.idpSignOutAffectsOwner;
    const changed = Object.keys(next).filter((field) => next[field] !== current[field]);
    if (changed.length > 0) {
      databaseModule.auditLogDb.recordStrict('sso_linked_settings_changed', {
        userId: actor.userId,
        metadata: {
          changed,
          ...(killSwitchChanged ? { idpSignOutAffectsOwner: next.idpSignOutAffectsOwner } : {}),
        },
        ipAddress: actor.ipAddress ?? null,
        userAgent: actor.userAgent ?? null,
      });
    }
    result = { ok: true, settings: next };
  })();
  return result;
}

/**
 * ADR-H20 N4 / D4: the IdP `end_session` URL the browser goes to after a
 * Nassaj sign-out, so every linked app of that browser signs out too. No
 * `id_token_hint`; `post_logout_redirect_uri` only when the owner set one
 * (it must be registered at the IdP). Null when SSO or the endpoint is
 * unavailable: the local sign-out still stands. Never throws.
 * @param {{ clientId: string, verifier: { endSessionEndpoint?: () => Promise<string | null> } } | null} client
 * @returns {Promise<string | null>}
 */
export async function endSessionUrlFor(client) {
  if (!client || typeof client.verifier?.endSessionEndpoint !== 'function') return null;
  try {
    const endpoint = await client.verifier.endSessionEndpoint();
    if (!endpoint) return null;
    const url = new URL(endpoint);
    url.searchParams.set('client_id', client.clientId);
    const { postLogoutRedirectUri } = readSsoLinkedSettings();
    if (postLogoutRedirectUri) url.searchParams.set('post_logout_redirect_uri', postLogoutRedirectUri);
    return url.toString();
  } catch {
    logSettingsFailure('end_session_url_failed');
    return null;
  }
}
