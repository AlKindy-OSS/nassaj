/**
 * Unified external-role mapper (ADR-064, ADR-069, ADR-194 D4 — T-957/T-958,
 * T-1939, T-1962).
 *
 * An external identity source only ATTESTS a role; nassaj decides the local
 * role. The attestation is first turned into a mapped role ('admin' | 'user'
 * | null) by the active SSO config's claim path and rules
 * (services/sso-role-mapping.ts: exact match, highest rank wins). From there:
 *   1. No mapped role → NO role: the caller must refuse the login (T-1939).
 *      There is no downgrade to a lowest role — this applies to owners too.
 *   2. A local `owner` with a mapped role keeps `owner` (never changed).
 *   3. `owner` is never derived externally — anything but admin/user is ignored.
 */

const MAPPABLE_ROLES = new Set(['admin', 'user']);

/**
 * Decides the local role for a user given a mapped external role. `role` is
 * null when the attestation carries no recognized role (login must be refused).
 * @param {string} currentRole the user's stored local role
 * @param {unknown} mappedRole 'admin' | 'user' from the SSO mapping, or null
 * @returns {{ role: string | null, changed: boolean }}
 */
export function reconcileLocalRole(currentRole, mappedRole) {
  if (typeof mappedRole !== 'string' || !MAPPABLE_ROLES.has(mappedRole)) {
    return { role: null, changed: false };
  }
  if (currentRole === 'owner') {
    return { role: 'owner', changed: false };
  }
  return { role: mappedRole, changed: mappedRole !== currentRole };
}

/**
 * Applies an external attestation to a stored user and audits real changes.
 * The write is a compare-and-set that can never touch an owner row, so a
 * concurrent owner-side role change is not overwritten. An attestation with no
 * recognized role writes nothing and returns null: the caller refuses the login
 * (T-1939) and the stored role is left as is (re-granting in the IdP suffices).
 * @param {{ user: { id: number, role: string }, mappedRole: unknown,
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
  { user, mappedRole, provider },
  { userDb, auditLogDb, onRoleApplied },
) {
  const { role, changed } = reconcileLocalRole(user.role, mappedRole);
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
