/**
 * Unified external-role mapper (ADR-064, ADR-069 — T-957/T-958, T-1939).
 *
 * An external identity source (OIDC today, LDAP later) only ATTESTS coarse role
 * names; nassaj decides the local role. Rules, in order:
 *   1. No recognized name (claim absent, malformed or only unknown names) → NO
 *      role: the caller must refuse the login (T-1939). There is no downgrade
 *      to a lowest role — this applies to owners too.
 *   2. A local `owner` with a recognized name keeps `owner` (never changed).
 *   3. `owner` is never derived externally — an attested "owner" is ignored.
 *   4. Recognized names map through EXTERNAL_ROLE_MAP; the highest rank wins.
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

const LOCAL_ROLE_RANK = Object.freeze({ user: 1, admin: 2 });
const MAX_ROLE_NAMES = 64;
const MAX_ROLE_NAME_LENGTH = 128;
const PROJECT_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/** Denial reason when the roles claim was absent entirely (diagnosable). */
export const ROLES_CLAIM_ABSENT_REASON = 'roles_claim_absent';
/** Denial reason when the claim was present but carried no recognized role. */
export const NO_RECOGNIZED_ROLE_REASON = 'no_recognized_role';

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
 * Fail-closed (T-1939): null when no name is a known EXTERNAL_ROLE_MAP entry.
 * @param {unknown} externalRoles list of attested role names from any source
 * @returns {'admin' | 'user' | null}
 */
export function mapExternalRoles(externalRoles) {
  let best = null;
  if (!Array.isArray(externalRoles)) {
    return best;
  }
  for (const name of externalRoles.slice(0, MAX_ROLE_NAMES)) {
    const mapped = typeof name === 'string' && Object.hasOwn(EXTERNAL_ROLE_MAP, name)
      ? EXTERNAL_ROLE_MAP[name]
      : null;
    if (mapped && (best === null || LOCAL_ROLE_RANK[mapped] > LOCAL_ROLE_RANK[best])) {
      best = mapped;
    }
  }
  return best;
}

/**
 * Decides the local role for a user given an external attestation. `role` is
 * null when the attestation carries no recognized role (login must be refused).
 * @param {string} currentRole the user's stored local role
 * @param {unknown} externalRoles attested role names (see mapExternalRoles)
 * @returns {{ role: string | null, changed: boolean }}
 */
export function reconcileLocalRole(currentRole, externalRoles) {
  const mapped = mapExternalRoles(externalRoles);
  if (mapped === null) {
    return { role: null, changed: false };
  }
  if (currentRole === 'owner') {
    return { role: 'owner', changed: false };
  }
  return { role: mapped, changed: mapped !== currentRole };
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
 * Organization ids that granted `role` in Zitadel's native claim shape
 * `{ "<role>": { "<orgId>": "<orgDomain>" } }`. Any other shape (a bare array
 * of names, a string, a missing entry) carries no organization → [].
 */
function grantingOrgIds(grants) {
  if (!grants || typeof grants !== 'object' || Array.isArray(grants)) {
    return [];
  }
  return Object.keys(grants)
    .slice(0, MAX_ROLE_NAMES)
    .filter((orgId) => orgId.length > 0 && orgId.length <= MAX_ROLE_NAME_LENGTH);
}

/**
 * JIT source adapter (T-1939 slice 4): the project-scoped role names whose
 * grant was issued by at least one organization in `allowedOrgIds`. Same
 * fail-closed rules as extractZitadelRoleNames (scoped claim only), and
 * stricter: a claim without per-role organization keys grants nothing here,
 * because the granting organization cannot be proven.
 * @param {Record<string, unknown>} claims verified id_token claims
 * @param {string | undefined} projectId configured Zitadel project id
 * @param {ReadonlySet<string>} allowedOrgIds organizations allowed to provision
 * @returns {string[]} bounded role names granted by an allowed organization
 */
export function extractZitadelRoleNamesFromOrgs(claims, projectId, allowedOrgIds) {
  if (!(allowedOrgIds instanceof Set) || allowedOrgIds.size === 0) {
    return [];
  }
  const roleNames = extractZitadelRoleNames(claims, projectId);
  if (roleNames.length === 0) {
    return [];
  }
  const claim = claims[scopedRolesClaimName(projectId)];
  if (!claim || typeof claim !== 'object' || Array.isArray(claim)) {
    return [];
  }
  return roleNames.filter((name) => Object.hasOwn(claim, name)
    && grantingOrgIds(claim[name]).some((orgId) => allowedOrgIds.has(orgId)));
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
 * concurrent owner-side role change is not overwritten. An attestation with no
 * recognized role writes nothing and returns null: the caller refuses the login
 * (T-1939) and the stored role is left as is (re-granting in the IdP suffices).
 * @param {{ user: { id: number, role: string }, externalRoles: unknown,
 *           provider: string }} input
 * `onRoleApplied` (optional) runs only when the compare-and-set actually changed
 * the stored role, so the caller can revoke live work on a downgrade (B-1327).
 * @param {{ userDb: { setRoleIfUnchanged: Function, getUserById: Function },
 *           auditLogDb: { record: Function },
 *           onRoleApplied?: (change: { userId: number, from: string, to: string }) => void }} deps
 * @returns {object | null | undefined} the fresh active user row; null when no
 *   role was attested; undefined if the row vanished
 */
export function syncExternalRole(
  { user, externalRoles, provider },
  { userDb, auditLogDb, onRoleApplied },
) {
  const { role, changed } = reconcileLocalRole(user.role, externalRoles);
  if (role === null) {
    return null;
  }
  if (!changed) {
    return user;
  }
  const applied = userDb.setRoleIfUnchanged(user.id, user.role, role);
  if (applied) {
    auditLogDb.record('external_role_synced', {
      userId: user.id,
      metadata: { provider, from: user.role, to: role },
    });
    onRoleApplied?.({ userId: user.id, from: user.role, to: role });
  }
  // Re-read: generateToken must see the stored role (and the bumped
  // authorization_generation), including when a concurrent change won the CAS.
  return userDb.getUserById(user.id);
}
