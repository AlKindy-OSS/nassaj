/**
 * Owner SSO sign-in rule (ADR-194 Amendment A1, tiered by A2 / ADR-H20 D6).
 *
 * Pure decision for the `login` callback branch once `linkedLoginPrecheck`
 * resolved an active owner. The owner is admitted only when, in this order:
 *
 *   1. the account has no forced password change pending;
 *   2. the id_token `amr` proves the factor rule (`passkey_only` since A2:
 *      exactly { user, mfa });
 *   3. `auth_time` lies within the owner ENTRY cap (30 days, the IdP check
 *      lifetime; a code constant, never a setting) and at most 60 s in the
 *      future.
 *
 * Entry is the no-click tier (A2): it opens every read, while privileged
 * actions need a fresh passkey step-up (sso-device-session.service.js). An
 * entry whose auth_time is older than the step-up window is audited silently
 * (`authStale`). A sign-in that itself is a fresh passkey touch (auth_time at
 * most 120 s old and not before the request started) also carries the
 * privileged grant (`privileged: true`).
 *
 * Owner SSO sign-in is always on (owner decision 2026-10-16): there is no
 * per-owner opt-in any more; the factor and freshness rules are the gate.
 *
 * The first failure wins. Nothing here touches the database or the network;
 * the route writes the audit rows and the redirect.
 */

/**
 * Factor rules for owner SSO. `user` + `mfa` is the operator IdP's reading of
 * a user-verified WebAuthn key (A1.1); a provider for which it means
 * something else must not be used for owner sign-in.
 *
 * - `webauthn_key` (owner decision 2026-10-15, the default): `user` and `mfa`
 *   are both present. Other values may appear beside them, so a password
 *   followed by a security key (`["pwd","user","mfa"]`, origin-bound)
 *   qualifies. No WebAuthn factor (`["pwd"]`, `["pwd","otp","mfa"]`) refuses.
 * - `passkey_only`: the distinct `amr` values are exactly { user, mfa }; any
 *   `pwd` refuses (closes the stale-factor gap, A1.4 item 2).
 */
export const OWNER_SSO_FACTOR_RULES = Object.freeze({
  webauthn_key: Object.freeze({ allowed: null, required: ['user', 'mfa'] }),
  passkey_only: Object.freeze({ allowed: new Set(['user', 'mfa']), required: ['user', 'mfa'] }),
});

/**
 * The active rule. Changed ONLY by a recorded owner decision in ADR-194
 * (A1, then A2: `passkey_only` per ADR-H20 D6), never by a setting: this one
 * constant switches it.
 * @type {'webauthn_key' | 'passkey_only'}
 */
export const OWNER_SSO_FACTOR_RULE = 'passkey_only';

/**
 * Owner ENTRY cap (ADR-H20 D9 item 3): the oldest acceptable IdP sign-in for
 * no-click owner entry, before skew. Equal to the IdP check lifetime of the
 * owner's organization (30 days). A code constant, NOT a setting.
 */
export const OWNER_SSO_ENTRY_MAX_AUTH_AGE_MS = 30 * 24 * 60 * 60_000;
/** Back-compatible name for the entry cap. */
export const OWNER_SSO_MAX_AUTH_AGE_MS = OWNER_SSO_ENTRY_MAX_AUTH_AGE_MS;
/** A sign-in at most this old (skew included) counts as a fresh passkey touch (D9-4). */
export const OWNER_SSO_FRESH_TOUCH_MS = 120_000;
/** Clock skew tolerated between this server and the IdP, in either direction. */
export const OWNER_SSO_CLOCK_SKEW_MS = 60_000;

const MAX_AMR_ITEMS = 16;
const MAX_AMR_ITEM_LENGTH = 32;

/** Refusal per failed step: the audited reason and the return-page code. */
const REFUSALS = Object.freeze({
  password_change_required: 'password_change_required',
  amr_insufficient: 'owner_sso_key_required',
  auth_time_missing: 'owner_sso_reauth_required',
  auth_time_stale: 'owner_sso_reauth_required',
  auth_time_in_future: 'owner_sso_reauth_required',
  fresh_touch_required: 'owner_sso_reauth_required',
});

/** Refusals one automatic passkey step-up (prompt=login, max_age=0) can fix. */
const STEP_UP_REASONS = new Set([
  'amr_insufficient', 'auth_time_missing', 'auth_time_stale', 'auth_time_in_future', 'fresh_touch_required',
]);

const refusal = (reason) => ({ ok: false, reason, code: REFUSALS[reason], stepUp: STEP_UP_REASONS.has(reason) });

const MAX_LOGIN_HINT_LENGTH = 255;

/**
 * The owner's IdP login name for `login_hint` on the step-up, or null. Only a
 * bounded string without control characters or spaces is used.
 * @param {Record<string, unknown> | null | undefined} claims
 * @returns {string | null}
 */
export function ownerLoginHint(claims) {
  const name = claims?.preferred_username;
  if (typeof name !== 'string' || name.length === 0 || name.length > MAX_LOGIN_HINT_LENGTH) return null;
  return /[\u0000-\u0020\u007f]/.test(name) ? null : name;
}

/**
 * The distinct `amr` values when the claim has a valid shape (an array of at
 * most 16 strings of 1–32 characters), else null.
 * @param {unknown} amr
 * @returns {string[] | null}
 */
export function normalizedAmr(amr) {
  if (!Array.isArray(amr) || amr.length > MAX_AMR_ITEMS) return null;
  const valid = amr.every((item) => typeof item === 'string' && item.length > 0 && item.length <= MAX_AMR_ITEM_LENGTH);
  return valid ? [...new Set(amr)] : null;
}

/**
 * Whether `amr` proves the factor rule. A bad shape or an unknown rule fails.
 * @param {unknown} amr
 * @param {string} [ruleName]
 * @returns {boolean}
 */
export function amrSatisfiesRule(amr, ruleName = OWNER_SSO_FACTOR_RULE) {
  const rule = Object.prototype.hasOwnProperty.call(OWNER_SSO_FACTOR_RULES, ruleName)
    ? OWNER_SSO_FACTOR_RULES[ruleName] : null;
  const values = normalizedAmr(amr);
  if (!rule || !values) return false;
  if (rule.allowed && !values.every((value) => rule.allowed.has(value))) return false;
  return rule.required.every((value) => values.includes(value));
}

/**
 * Why `auth_time` (id_token seconds) cannot prove a fresh owner sign-in, or null.
 * @param {unknown} authTime
 * @param {number} nowMs
 * @returns {'auth_time_missing' | 'auth_time_stale' | 'auth_time_in_future' | null}
 */
export function ownerAuthTimeFailure(authTime, nowMs) {
  if (!Number.isInteger(authTime) || authTime <= 0) return 'auth_time_missing';
  const authTimeMs = authTime * 1000;
  if (authTimeMs > nowMs + OWNER_SSO_CLOCK_SKEW_MS) return 'auth_time_in_future';
  if (nowMs - authTimeMs > OWNER_SSO_ENTRY_MAX_AUTH_AGE_MS + OWNER_SSO_CLOCK_SKEW_MS) return 'auth_time_stale';
  return null;
}

/**
 * Whether an admitted owner sign-in is itself a fresh passkey touch: auth_time
 * at most OWNER_SSO_FRESH_TOUCH_MS old and, when the request start is known,
 * not before it (minus skew). Checked on the server; never inferred from the
 * request having been sent with prompt=login (D9-4).
 * @param {number} authTimeMs
 * @param {number} nowMs
 * @param {number | undefined} requestedAtMs
 */
export function ownerSignInIsFreshTouch(authTimeMs, nowMs, requestedAtMs) {
  if (nowMs - authTimeMs > OWNER_SSO_FRESH_TOUCH_MS) return false;
  return !Number.isFinite(requestedAtMs) || authTimeMs >= requestedAtMs - OWNER_SSO_CLOCK_SKEW_MS;
}

/**
 * The owner admission decision, in the A1.2 order.
 * @param {{
 *   account: { must_change_password?: number },
 *   claims: Record<string, unknown> | null | undefined,
 *   nowMs: number,
 *   requestedAtMs?: number,
 *   rule?: string,
 * }} input
 * @returns {{ ok: true, amr: string[], authAgeSec: number, authStale: boolean, privileged: boolean }
 *   | { ok: false, reason: keyof typeof REFUSALS, code: string, stepUp: boolean }}
 *   `stepUp` is true when one fresh IdP sign-in with the key can fix it.
 */
export function decideOwnerSignIn({ account, claims, nowMs, requestedAtMs, rule = OWNER_SSO_FACTOR_RULE }) {
  if (account?.must_change_password === 1) return refusal('password_change_required');
  if (!amrSatisfiesRule(claims?.amr, rule)) return refusal('amr_insufficient');
  const authFailure = ownerAuthTimeFailure(claims?.auth_time, nowMs);
  if (authFailure) return refusal(authFailure);
  const authTimeMs = Number(claims.auth_time) * 1000;
  const authAgeSec = Math.max(0, Math.round((nowMs - authTimeMs) / 1000));
  const privileged = ownerSignInIsFreshTouch(authTimeMs, nowMs, requestedAtMs);
  return { ok: true, amr: normalizedAmr(claims.amr) ?? [], authAgeSec, authStale: !privileged, privileged };
}

/**
 * Wallet mode (MULTI_ACCOUNT_SWITCHING) issues device sessions with no SSO
 * binding, so the no-click tier and its later step-up cannot exist there: an
 * owner is admitted only by a sign-in that is itself a fresh passkey touch
 * (ADR-194 A2, fail-closed). Any other admitted decision becomes a refusal
 * that one automatic step-up can fix; a refusal passes through unchanged.
 * @param {ReturnType<typeof decideOwnerSignIn>} decision
 * @returns {ReturnType<typeof decideOwnerSignIn>}
 */
export function requireFreshOwnerTouch(decision) {
  if (!decision.ok || decision.privileged === true) return decision;
  return refusal('fresh_touch_required');
}
