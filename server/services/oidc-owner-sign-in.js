/**
 * Owner SSO sign-in rule (ADR-194 Amendment A1).
 *
 * Pure decision for the `login` callback branch once `linkedLoginPrecheck`
 * resolved an active owner. The owner is admitted only when, in this order:
 *
 *   1. the account has no forced password change pending;
 *   2. the identity row carries the owner's own opt-in;
 *   3. the id_token `amr` proves the factor rule (default: a WebAuthn key,
 *      with or without a password);
 *   4. `auth_time` is at most 5 minutes old (plus 60 s skew) and at most
 *      60 s in the future.
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
 * The active rule. Changed ONLY by a recorded owner decision in ADR-194 A1,
 * never by a setting: this one constant switches it.
 * @type {'webauthn_key' | 'passkey_only'}
 */
export const OWNER_SSO_FACTOR_RULE = 'webauthn_key';

/** Oldest acceptable IdP sign-in for an owner, before skew. Fixed, not attestation_max_age_hours. */
export const OWNER_SSO_MAX_AUTH_AGE_MS = 5 * 60_000;
/** Clock skew tolerated between this server and the IdP, in either direction. */
export const OWNER_SSO_CLOCK_SKEW_MS = 60_000;

const MAX_AMR_ITEMS = 16;
const MAX_AMR_ITEM_LENGTH = 32;

/** Refusal per failed step: the audited reason and the return-page code. */
const REFUSALS = Object.freeze({
  password_change_required: 'password_change_required',
  not_opted_in: 'owner_must_sign_in_locally',
  amr_insufficient: 'owner_sso_key_required',
  auth_time_missing: 'owner_sso_reauth_required',
  auth_time_stale: 'owner_sso_reauth_required',
  auth_time_in_future: 'owner_sso_reauth_required',
});

/** Refusals one automatic passkey step-up (prompt=login, max_age=0) can fix. */
const STEP_UP_REASONS = new Set(['amr_insufficient', 'auth_time_missing', 'auth_time_stale', 'auth_time_in_future']);

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
  if (nowMs - authTimeMs > OWNER_SSO_MAX_AUTH_AGE_MS + OWNER_SSO_CLOCK_SKEW_MS) return 'auth_time_stale';
  return null;
}

/**
 * The owner admission decision, in the A1.2 order.
 * @param {{
 *   account: { must_change_password?: number },
 *   identity: { owner_sso_opt_in_at?: number | null } | null | undefined,
 *   claims: Record<string, unknown> | null | undefined,
 *   nowMs: number,
 *   rule?: string,
 * }} input
 * @returns {{ ok: true, amr: string[], authAgeSec: number }
 *   | { ok: false, reason: keyof typeof REFUSALS, code: string, stepUp: boolean }}
 *   `stepUp` is true when one fresh IdP sign-in with the key can fix it.
 */
export function decideOwnerSignIn({ account, identity, claims, nowMs, rule = OWNER_SSO_FACTOR_RULE }) {
  const refuse = (reason) => ({ ok: false, reason, code: REFUSALS[reason], stepUp: STEP_UP_REASONS.has(reason) });
  if (account?.must_change_password === 1) return refuse('password_change_required');
  if (identity?.owner_sso_opt_in_at === null || identity?.owner_sso_opt_in_at === undefined) {
    return refuse('not_opted_in');
  }
  if (!amrSatisfiesRule(claims?.amr, rule)) return refuse('amr_insufficient');
  const authFailure = ownerAuthTimeFailure(claims?.auth_time, nowMs);
  if (authFailure) return refuse(authFailure);
  const authAgeSec = Math.max(0, Math.round((nowMs - Number(claims.auth_time) * 1000) / 1000));
  return { ok: true, amr: normalizedAmr(claims.amr) ?? [], authAgeSec };
}
