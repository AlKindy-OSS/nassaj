/**
 * Owner setting: how many days an SSO-linked member's API keys keep working
 * after their last SSO sign-in (T-1946, owner decision 2026-09-29).
 *
 * Enforcement lives in the API key repository (api-key-sso-window.ts), which
 * reads the stored value on every key check, so a change here applies to the
 * very next request. The owner and unlinked (local-only) accounts are never
 * governed; an expired key is refused, not deleted, and works again after the
 * member's next SSO sign-in.
 */
import { auditLogDb, getConnection } from '../modules/database/index.js';
// Direct import: suites that stub the database index (e.g. branding-logo) still link.
import {
  API_KEY_SSO_WINDOW_DEFAULT_DAYS,
  API_KEY_SSO_WINDOW_MAX_DAYS,
  API_KEY_SSO_WINDOW_MIN_DAYS,
  apiKeySsoWindowDb,
  parseApiKeySsoWindowDays,
} from '../modules/database/repositories/api-key-sso-window.js';

/** Error code for a PUT whose windowDays is not a whole number in range. */
export const INVALID_WINDOW_DAYS_CODE = 'invalid_window_days';

/**
 * Current window plus its bounds, for the Settings UI.
 * @returns {{ windowDays: number, defaultDays: number, minDays: number, maxDays: number }}
 */
export function getApiKeySsoWindowSettings() {
  return {
    windowDays: apiKeySsoWindowDb.getDays(),
    defaultDays: API_KEY_SSO_WINDOW_DEFAULT_DAYS,
    minDays: API_KEY_SSO_WINDOW_MIN_DAYS,
    maxDays: API_KEY_SSO_WINDOW_MAX_DAYS,
  };
}

/**
 * Validates and stores a new window. The write and its audit record commit
 * together (a failed audit rolls the change back); an unchanged effective
 * value is stored but not audited. Callers authorize the actor (owner only).
 * @param {unknown} rawDays
 * @param {{ userId: number, ipAddress?: string | null, userAgent?: string | null }} actor
 * @returns {{ ok: true, settings: ReturnType<typeof getApiKeySsoWindowSettings> }
 *   | { ok: false, code: string }}
 */
export function updateApiKeySsoWindow(rawDays, actor) {
  const days = parseApiKeySsoWindowDays(rawDays);
  if (days === null) return { ok: false, code: INVALID_WINDOW_DAYS_CODE };
  getConnection().transaction(() => {
    const previous = apiKeySsoWindowDb.getDays();
    apiKeySsoWindowDb.setDays(days);
    if (previous === days) return;
    auditLogDb.recordStrict('api_key_sso_window_changed', {
      userId: actor.userId,
      metadata: { from: previous, to: days },
      ipAddress: actor.ipAddress ?? null,
      userAgent: actor.userAgent ?? null,
    });
  })();
  return { ok: true, settings: getApiKeySsoWindowSettings() };
}
