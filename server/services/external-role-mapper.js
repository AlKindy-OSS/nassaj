/**
 * Unified external-role mapper (ADR-064, ADR-069 — T-957/T-958).
 *
 * An external identity source (OIDC today, LDAP later) only ATTESTS coarse role
 * names; nassaj decides the local role. Rules, in order:
 *   1. A local `owner` is never changed by an external attestation.
 *   2. `owner` is never derived externally — an attested "owner" is ignored.
 *   3. Recognized names map through EXTERNAL_ROLE_MAP; the highest rank wins.
 *   4. No recognized name (claim absent, malformed or unknown) → LOWEST_LOCAL_ROLE.
 *
 * Source adapters (e.g. extractZitadelRoleNames) turn a raw assertion into a
 * bounded list of role-name strings; everything after that is source-neutral.
 */

/** Attested external role name → local role. `owner` is deliberately absent. */
export const EXTERNAL_ROLE_MAP = Object.freeze({
  admin: 'admin',
  member: 'user',
  // nassaj has no read-only role; `user` is the lowest existing local role.
  viewer: 'user',
});

export const LOWEST_LOCAL_ROLE = 'user';

const LOCAL_ROLE_RANK = Object.freeze({ user: 1, admin: 2 });
const MAX_ROLE_NAMES = 64;
const MAX_ROLE_NAME_LENGTH = 128;
const PROJECT_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/** Distinct audit reason when the roles claim was absent entirely (diagnosable). */
export const ROLES_CLAIM_ABSENT_REASON = 'roles_claim_absent';

/**
 * True only when `projectId` is a syntactically valid Zitadel project id. OIDC
 * role mapping is fail-closed: without a valid id there is no scoped claim to
 * read, so no role can be attested (see ADR-064/069 and finding T-* fail-closed).
 * @param {unknown} projectId
 * @returns {boolean}
 */
export function isValidRoleProjectId(projectId) {
  return typeof projectId === 'string' && PROJECT_ID_PATTERN.test(projectId);
}

/** The project-scoped Zitadel roles claim name, or null when the id is invalid. */
function scopedRolesClaimName(projectId) {
  return isValidRoleProjectId(projectId)
    ? `urn:zitadel:iam:org:project:${projectId}:roles`
    : null;
}

/**
 * Maps attested role names to a single local role (never `owner`).
 * @param {unknown} externalRoles list of attested role names from any source
 * @returns {'admin' | 'user'}
 */
export function mapExternalRoles(externalRoles) {
  let best = LOWEST_LOCAL_ROLE;
  if (!Array.isArray(externalRoles)) {
    return best;
  }
  for (const name of externalRoles.slice(0, MAX_ROLE_NAMES)) {
    const mapped = typeof name === 'string' && Object.hasOwn(EXTERNAL_ROLE_MAP, name)
      ? EXTERNAL_ROLE_MAP[name]
      : null;
    if (mapped && LOCAL_ROLE_RANK[mapped] > LOCAL_ROLE_RANK[best]) {
      best = mapped;
    }
  }
  return best;
}

/**
 * Decides the local role for a user given an external attestation.
 * @param {string} currentRole the user's stored local role
 * @param {unknown} externalRoles attested role names (see mapExternalRoles)
 * @returns {{ role: string, changed: boolean }}
 */
export function reconcileLocalRole(currentRole, externalRoles) {
  if (currentRole === 'owner') {
    return { role: 'owner', changed: false };
  }
  const role = mapExternalRoles(externalRoles);
  return { role, changed: role !== currentRole };
}

function boundedRoleNames(value) {
  let names = [];
  if (Array.isArray(value)) {
    names = value;
  } else if (value && typeof value === 'object') {
    // Zitadel's native shape: { "<role>": { "<orgId>": "<orgDomain>" } }.
    names = Object.keys(value);
  }
  return names
    .slice(0, MAX_ROLE_NAMES)
    .filter((name) => typeof name === 'string' && name.length > 0 && name.length <= MAX_ROLE_NAME_LENGTH);
}

/**
 * OIDC source adapter: reads Zitadel project-role claims from VERIFIED id_token
 * claims. Fail-closed: it reads ONLY the project-scoped claim
 * `urn:zitadel:iam:org:project:<projectId>:roles`. The generic
 * `urn:zitadel:iam:org:project:roles` claim (which aggregates roles across every
 * project the user touches) is NEVER consulted, and an absent/invalid projectId
 * grants nothing — preventing a cross-project role leak.
 * @param {Record<string, unknown>} claims verified id_token claims
 * @param {string | undefined} projectId configured Zitadel project id
 * @returns {string[]} bounded role names ([] when absent, invalid or malformed)
 */
export function extractZitadelRoleNames(claims, projectId) {
  if (!claims || typeof claims !== 'object') {
    return [];
  }
  const scopedClaim = scopedRolesClaimName(projectId);
  if (!scopedClaim || !Object.hasOwn(claims, scopedClaim)) {
    return [];
  }
  return boundedRoleNames(claims[scopedClaim]);
}

/**
 * Whether the VERIFIED claims carry the project-scoped roles claim at all. Lets
 * the caller distinguish "claim absent entirely" (misconfigured IdP / user has
 * no grant on this project) from "claim present but no recognized role", so the
 * two are separately diagnosable in the audit log. A key present with an empty
 * or malformed value still counts as present.
 * @param {Record<string, unknown>} claims verified id_token claims
 * @param {string | undefined} projectId configured Zitadel project id
 * @returns {boolean}
 */
export function hasZitadelRolesClaim(claims, projectId) {
  if (!claims || typeof claims !== 'object') {
    return false;
  }
  const scopedClaim = scopedRolesClaimName(projectId);
  return scopedClaim !== null && Object.hasOwn(claims, scopedClaim);
}

/**
 * Applies an external attestation to a stored user and audits real changes.
 * The write is a compare-and-set that can never touch an owner row, so a
 * concurrent owner-side role change is not overwritten.
 * When `claimPresent` is explicitly `false` (the roles claim was absent entirely,
 * not merely present-with-no-recognized-role), the audit metadata carries a
 * distinct `reason` so a demotion driven by a missing claim is diagnosable.
 * @param {{ user: { id: number, role: string }, externalRoles: unknown,
 *           provider: string, claimPresent?: boolean }} input
 * `onRoleApplied` (optional) runs only when the compare-and-set actually changed
 * the stored role, so the caller can revoke live work on a downgrade (B-1327).
 * @param {{ userDb: { setRoleIfUnchanged: Function, getUserById: Function },
 *           auditLogDb: { record: Function },
 *           onRoleApplied?: (change: { userId: number, from: string, to: string }) => void }} deps
 * @returns {object | undefined} the fresh active user row, or undefined if it vanished
 */
export function syncExternalRole(
  { user, externalRoles, provider, claimPresent },
  { userDb, auditLogDb, onRoleApplied },
) {
  const { role, changed } = reconcileLocalRole(user.role, externalRoles);
  if (!changed) {
    return user;
  }
  const applied = userDb.setRoleIfUnchanged(user.id, user.role, role);
  if (applied) {
    const metadata = { provider, from: user.role, to: role };
    if (claimPresent === false) {
      metadata.reason = ROLES_CLAIM_ABSENT_REASON;
    }
    auditLogDb.record('external_role_synced', {
      userId: user.id,
      metadata,
    });
    onRoleApplied?.({ userId: user.id, from: user.role, to: role });
  }
  // Re-read: generateToken must see the stored role (and the bumped
  // authorization_generation), including when a concurrent change won the CAS.
  return userDb.getUserById(user.id);
}
