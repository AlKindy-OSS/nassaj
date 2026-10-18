/**
 * Owner SSO sign-in rule (ADR-194 Amendment A1, as withdrawn on 2026-10-18).
 *
 * Pure decision for the `login` callback branch once `linkedLoginPrecheck`
 * resolved an active owner whose identity is linked to the active issuer.
 * The id_token signature, nonce, state, issuer and audience are already
 * verified by then.
 *
 * The A1 factor rule (`amr` exactly { user, mfa }), the 30-day `auth_time`
 * entry cap, the fresh-touch rule and the automatic passkey step-up were
 * withdrawn by owner decision 2026-10-18 (ADR-194 A2.5): an SSO sign-in gives
 * the owner full access directly. The one refusal left is a forced password
 * change still pending on the account.
 *
 * Nothing here touches the database or the network; the route writes the
 * audit rows and the redirect.
 */

const MAX_AMR_ITEMS = 16;
const MAX_AMR_ITEM_LENGTH = 32;

/**
 * The distinct `amr` values when the claim has a valid shape (an array of at
 * most 16 strings of 1–32 characters), else null. Used for the audit only.
 * @param {unknown} amr
 * @returns {string[] | null}
 */
export function normalizedAmr(amr) {
  if (!Array.isArray(amr) || amr.length > MAX_AMR_ITEMS) return null;
  const valid = amr.every((item) => typeof item === 'string' && item.length > 0 && item.length <= MAX_AMR_ITEM_LENGTH);
  return valid ? [...new Set(amr)] : null;
}

/**
 * Age of the IdP sign-in in whole seconds for the audit, or null when
 * `auth_time` is missing or malformed (never a refusal).
 * @param {unknown} authTime id_token seconds
 * @param {number} nowMs
 * @returns {number | null}
 */
export function authAgeSeconds(authTime, nowMs) {
  if (!Number.isInteger(authTime) || authTime <= 0) return null;
  return Math.max(0, Math.round((nowMs - authTime * 1000) / 1000));
}

/**
 * The owner admission decision.
 * @param {{
 *   account: { must_change_password?: number },
 *   claims: Record<string, unknown> | null | undefined,
 *   nowMs: number,
 * }} input
 * @returns {{ ok: true, amr: string[], authAgeSec: number | null }
 *   | { ok: false, reason: 'password_change_required', code: 'password_change_required' }}
 */
export function decideOwnerSignIn({ account, claims, nowMs }) {
  if (account?.must_change_password === 1) {
    return { ok: false, reason: 'password_change_required', code: 'password_change_required' };
  }
  return { ok: true, amr: normalizedAmr(claims?.amr) ?? [], authAgeSec: authAgeSeconds(claims?.auth_time, nowMs) };
}
