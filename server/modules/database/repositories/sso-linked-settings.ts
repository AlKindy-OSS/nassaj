/**
 * Per-node settings for linked SSO sign-in and sign-out (ADR-H20 S6).
 *
 * Stored in app_config under the reserved `sso.linked.` namespace, which only
 * this repository writes (the generic app_config writer refuses `sso.`). A
 * missing or corrupt value reads as its safe default: auto sign-in off, no
 * login hint, no post-logout URI, a 12 h re-check, and the owner kill switch
 * on ("IdP sign-out affects the owner").
 *
 * The owner entry cap is NOT a setting: it is OWNER_SSO_ENTRY_MAX_AUTH_AGE_MS,
 * a code constant (ADR-H20 D9 item 3).
 */
import { getConnection } from '@/modules/database/connection.js';

export const SSO_LINKED_KEYS = Object.freeze({
  autoSignIn: 'sso.linked.auto_sign_in',
  ownerLoginHint: 'sso.linked.owner_login_hint',
  postLogoutRedirectUri: 'sso.linked.post_logout_redirect_uri',
  recheckIntervalHours: 'sso.linked.recheck_interval_hours',
  idpSignOutAffectsOwner: 'sso.linked.idp_signout_affects_owner',
});

export const RECHECK_DEFAULT_HOURS = 12;
export const RECHECK_MIN_HOURS = 1;
export const RECHECK_MAX_HOURS = 24;
const MAX_LOGIN_HINT_LENGTH = 255;
const MAX_URI_LENGTH = 2048;

export type SsoLinkedSettings = {
  autoSignIn: boolean;
  ownerLoginHint: string | null;
  postLogoutRedirectUri: string | null;
  recheckIntervalHours: number;
  idpSignOutAffectsOwner: boolean;
};

export const SSO_LINKED_DEFAULTS: Readonly<SsoLinkedSettings> = Object.freeze({
  autoSignIn: false,
  ownerLoginHint: null,
  postLogoutRedirectUri: null,
  recheckIntervalHours: RECHECK_DEFAULT_HOURS,
  idpSignOutAffectsOwner: true,
});

/** A login name usable as `login_hint`: 1–255 characters, no spaces or control characters. */
export function parseLoginHint(value: unknown): string | null | undefined {
  if (value === null || value === '') return null;
  if (typeof value !== 'string' || value.length > MAX_LOGIN_HINT_LENGTH) return undefined;
  return /[\u0000- \u007f]/.test(value) ? undefined : value;
}

/** An absolute https URL without credentials or fragment, or null to clear. */
export function parsePostLogoutRedirectUri(value: unknown): string | null | undefined {
  if (value === null || value === '') return null;
  if (typeof value !== 'string' || value.length > MAX_URI_LENGTH) return undefined;
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.hash) return undefined;
    return parsed.toString() === value ? value : undefined;
  } catch {
    return undefined;
  }
}

/** A whole number of hours in 1..24. */
export function parseRecheckIntervalHours(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value)
    && value >= RECHECK_MIN_HOURS && value <= RECHECK_MAX_HOURS ? value : undefined;
}

function readRaw(): Map<string, string> {
  const rows = getConnection()
    .prepare("SELECT key, value FROM app_config WHERE key LIKE 'sso.linked.%'")
    .all() as Array<{ key: string; value: unknown }>;
  return new Map(rows.filter((row) => typeof row.value === 'string').map((row) => [row.key, row.value as string]));
}

function readFlag(raw: Map<string, string>, key: string, fallback: boolean): boolean {
  const value = raw.get(key);
  if (value === '1') return true;
  if (value === '0') return false;
  return fallback;
}

export const ssoLinkedSettingsDb = {
  /** Effective settings; read errors propagate so callers fail closed. */
  read(): SsoLinkedSettings {
    const raw = readRaw();
    const hours = Number(raw.get(SSO_LINKED_KEYS.recheckIntervalHours));
    return {
      autoSignIn: readFlag(raw, SSO_LINKED_KEYS.autoSignIn, SSO_LINKED_DEFAULTS.autoSignIn),
      ownerLoginHint: parseLoginHint(raw.get(SSO_LINKED_KEYS.ownerLoginHint) ?? null) ?? null,
      postLogoutRedirectUri: parsePostLogoutRedirectUri(raw.get(SSO_LINKED_KEYS.postLogoutRedirectUri) ?? null) ?? null,
      recheckIntervalHours: parseRecheckIntervalHours(hours) ?? SSO_LINKED_DEFAULTS.recheckIntervalHours,
      // Corrupt reads as ON: the owner stays reachable by an IdP sign-out.
      idpSignOutAffectsOwner: readFlag(raw, SSO_LINKED_KEYS.idpSignOutAffectsOwner, true),
    };
  },

  /** Persists already-validated settings in the caller's transaction. */
  write(settings: SsoLinkedSettings): void {
    const db = getConnection();
    const upsert = db.prepare(`INSERT INTO app_config (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value`);
    const remove = db.prepare('DELETE FROM app_config WHERE key = ?');
    upsert.run(SSO_LINKED_KEYS.autoSignIn, settings.autoSignIn ? '1' : '0');
    upsert.run(SSO_LINKED_KEYS.idpSignOutAffectsOwner, settings.idpSignOutAffectsOwner ? '1' : '0');
    upsert.run(SSO_LINKED_KEYS.recheckIntervalHours, String(settings.recheckIntervalHours));
    for (const [key, value] of [
      [SSO_LINKED_KEYS.ownerLoginHint, settings.ownerLoginHint],
      [SSO_LINKED_KEYS.postLogoutRedirectUri, settings.postLogoutRedirectUri],
    ] as const) {
      if (value === null) remove.run(key);
      else upsert.run(key, value);
    }
  },
};
