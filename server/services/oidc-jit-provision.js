/**
 * Just-in-time account creation on a first SSO sign-in (T-1939 slice 4).
 *
 * When an unknown IdP subject signs in, the /callback login branch may create
 * a local SSO-only account for it — but only when every gate holds:
 *   - OIDC is live AND OIDC_JIT_ENABLED is exactly 'true' (default off: the
 *     owner turns it on only after existing members have self-linked, so a
 *     member is never given a second, empty account);
 *   - OIDC_ALLOWED_ORG_IDS lists at least one organization (an empty list
 *     refuses — fail-closed), and the verified id_token carries a known
 *     project role granted BY one of those organizations;
 *   - the username derived from preferred_username is free (case-insensitive
 *     over every account, active or not) and not reserved. A clash is refused;
 *     there is no auto-suffix and never any linking by e-mail;
 *   - fewer than PROVISION_CAP_PER_HOUR accounts were created this hour.
 * The role comes from the shared mapper (never owner). HTTP wiring lives in
 * routes/oidc.js; this module holds the decisions and the atomic write.
 */
import crypto from 'crypto';

// Namespace import: route tests replace the database module with partial
// mocks, and a named import of an absent binding would fail at link time.
import * as databaseModule from '../modules/database/index.js';

import { extractZitadelRoleNames, extractZitadelRoleNamesFromOrgs, mapExternalRoles } from './external-role-mapper.js';
import { oidcEnabled } from './oidc-config.js';
import { SSO_ONLY_PASSWORD_HASH } from './sso-only-password.js';
import { isReservedUsername } from './username-policy.js';

/** Process-wide ceiling on JIT accounts per rolling hour (on top of per-IP limits). */
export const PROVISION_CAP_PER_HOUR = 20;
const HOUR_MS = 60 * 60_000;

const MIN_USERNAME_LENGTH = 3;
const MAX_USERNAME_LENGTH = 32;
const MAX_PREFERRED_USERNAME_LENGTH = 512;
const ORG_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const BASE32_ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';

/** Epoch-ms timestamps of this hour's provisions (bounded by the cap). */
const recentProvisions = [];

/** Whether JIT creation is switched on (explicit opt-in, default off). */
export function jitEnabled() {
  return oidcEnabled() && process.env.OIDC_JIT_ENABLED === 'true';
}

/**
 * The organizations allowed to provision accounts, from the comma-separated
 * OIDC_ALLOWED_ORG_IDS. Malformed entries are dropped; an empty set means JIT
 * refuses every sign-in. A non-empty set also filters the role of EVERY SSO
 * sign-in and self-link (see ssoRoleNames).
 * @returns {Set<string>}
 */
export function allowedOrgIds() {
  const raw = process.env.OIDC_ALLOWED_ORG_IDS;
  if (typeof raw !== 'string') {
    return new Set();
  }
  return new Set(raw.split(',').map((entry) => entry.trim()).filter((entry) => ORG_ID_PATTERN.test(entry)));
}

/**
 * The project role names an SSO sign-in or self-link may act on (qa veto on
 * slice 4). When OIDC_ALLOWED_ORG_IDS lists any organization, only roles
 * granted BY one of them count — for linked members exactly as for JIT — so a
 * foreign organization's grant can neither raise a role nor keep access once
 * the allowed organization revokes its own. An empty allowlist keeps the
 * unfiltered project-scoped roles for existing links (JIT refuses on its own).
 * @param {Record<string, unknown>} claims verified id_token claims
 * @param {string | undefined} projectId configured Zitadel project id
 * @returns {string[]}
 */
export function ssoRoleNames(claims, projectId) {
  const orgs = allowedOrgIds();
  return orgs.size === 0
    ? extractZitadelRoleNames(claims, projectId)
    : extractZitadelRoleNamesFromOrgs(claims, projectId, orgs);
}

/** RFC 4648 base32 (lower-case, unpadded) of the leading bytes of `buffer`. */
function base32(buffer, length) {
  let bits = 0;
  let value = 0;
  let output = '';
  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5 && output.length < length) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
    if (output.length >= length) break;
  }
  return output;
}

/**
 * Local username for a JIT account (qa M4). preferred_username's part before
 * the first '@', lower-cased; every character outside [a-z0-9_] becomes '_';
 * trimmed to 32. A result shorter than 3 characters — or with no letter or
 * digit at all (e.g. an all-Arabic or all-emoji name) — falls back to
 * 'user_' + 8 base32 characters of sha256(subject), stable per identity.
 * @param {unknown} preferredUsername
 * @param {string} subject verified IdP subject
 * @returns {string}
 */
export function deriveUsername(preferredUsername, subject) {
  const raw = typeof preferredUsername === 'string'
    ? preferredUsername.slice(0, MAX_PREFERRED_USERNAME_LENGTH)
    : '';
  const cleaned = raw.split('@', 1)[0]
    .toLowerCase()
    .replace(/[^a-z0-9_]/gu, '_')
    .slice(0, MAX_USERNAME_LENGTH);
  if (cleaned.length >= MIN_USERNAME_LENGTH && /[a-z0-9]/.test(cleaned)) {
    return cleaned;
  }
  return `user_${base32(crypto.createHash('sha256').update(subject).digest(), 8)}`;
}

function pruneProvisions(nowMs) {
  while (recentProvisions.length > 0 && nowMs - recentProvisions[0] >= HOUR_MS) {
    recentProvisions.shift();
  }
}

/** Whether this hour's process-wide provision budget is spent. */
export function provisionCapReached(nowMs) {
  pruneProvisions(nowMs);
  return recentProvisions.length >= PROVISION_CAP_PER_HOUR;
}

/** Test seam: forget this hour's provisions. */
export function resetProvisionCap() {
  recentProvisions.length = 0;
}

/**
 * Decides whether an unknown subject may get an account, without writing.
 * @param {{ claims: Record<string, unknown>, subject: string, projectId: string | undefined,
 *           nowMs: number }} input
 * @returns {{ outcome: 'disabled' | 'allowlist_missing' | 'no_role' | 'org_not_allowed'
 *             | 'capped' } | { outcome: 'ready', role: 'admin' | 'user', username: string }}
 */
export function planJitProvision({ claims, subject, projectId, nowMs }) {
  if (!jitEnabled()) return { outcome: 'disabled' };
  const orgs = allowedOrgIds();
  if (orgs.size === 0) return { outcome: 'allowlist_missing' };
  if (mapExternalRoles(extractZitadelRoleNames(claims, projectId)) === null) {
    return { outcome: 'no_role' };
  }
  const role = mapExternalRoles(extractZitadelRoleNamesFromOrgs(claims, projectId, orgs));
  if (role === null) return { outcome: 'org_not_allowed' };
  if (provisionCapReached(nowMs)) return { outcome: 'capped' };
  return { outcome: 'ready', role, username: deriveUsername(claims.preferred_username, subject) };
}

/**
 * Per-user directory provisioning, loaded on demand: it pulls the isolation
 * stack, which only this rare path needs. Never throws or rejects.
 */
async function provisionDirsBestEffort(userId) {
  try {
    const { provisionUserDirs } = await import('./isolation/provision-user-dirs.js');
    provisionUserDirs(userId);
  } catch {
    process.stderr.write(`${JSON.stringify({ level: 'warn', scope: 'oidc', code: 'jit_user_dirs_failed' })}\n`);
    try {
      databaseModule.auditLogDb.record('user_dirs_provision_failed', {
        userId,
        metadata: { stage: 'oidc_jit' },
      });
    } catch {
      // Audit is best effort here; the WARN line above already records it.
    }
  }
}

/**
 * Creates the SSO-only account, its link and its attestation in one
 * transaction (users repository), counts it against the hourly cap, then
 * provisions the per-user directories best effort (a failure never undoes the
 * account; the lazy path on first spawn remains). Throws on a write failure.
 * @param {{ username: string, role: 'admin' | 'user', issuer: string, subject: string,
 *           nowMs: number }} input
 * @returns {{ created: true, userId: number, identityId: number }
 *   | { created: false, reason: 'username_taken' }}
 */
export function provisionSsoUser({ username, role, issuer, subject, nowMs }) {
  const result = databaseModule.userDb.createSsoUser({
    username,
    passwordHash: SSO_ONLY_PASSWORD_HASH,
    role,
    issuer,
    subject,
    attestedAtMs: nowMs,
    isReservedUsername,
  });
  if (!result.created) {
    return result;
  }
  recentProvisions.push(nowMs);
  void provisionDirsBestEffort(result.user.id);
  return { created: true, userId: result.user.id, identityId: result.identityId };
}
