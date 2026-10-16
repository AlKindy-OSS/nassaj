/**
 * Owner SSO sign-in opt-in (ADR-194 Amendment A1).
 *
 * Each owner turns SSO sign-in on or off for THEIR OWN link to the active
 * issuer only. The flag lives on that identity row, so an unlink or a new
 * issuer drops it with the row, and agent links stay refused without any
 * extra rule. The write and its strict audit share one transaction. Turning
 * it on needs local `sso_config` step-up, which the route checks first.
 */
import { getConnection } from '../modules/database/connection.js';
import { recordStrictAuditOnConnection } from '../modules/database/repositories/audit-log.js';
import { readSlotOn } from '../modules/database/repositories/sso-oidc-config.js';
import { userIdentitiesDb } from '../modules/database/repositories/user-identities.js';
import { userDb } from '../modules/database/repositories/users.js';

import { notifyOwnerOfSsoEvent } from './oidc-self-link.js';
import { SsoSettingsError } from './sso-settings-error.js';

/** The caller's links for the active issuer; empty when no active config exists. */
function ownLinksForActiveIssuer(db, userId) {
  const issuer = readSlotOn(db, 'active')?.issuer;
  return typeof issuer === 'string' ? userIdentitiesDb.findForUserAndIssuer(userId, issuer) : [];
}

/**
 * `GET /api/settings/sso` → `ownerSignIn` for the caller. `enabled` is true
 * only for a single link carrying the opt-in (duplicates are refused at login).
 * @param {import('better-sqlite3').Database} db
 * @param {number} userId
 * @returns {{ linked: boolean, enabled: boolean }}
 */
export function ownerSignInView(db, userId) {
  const links = ownLinksForActiveIssuer(db, userId);
  return {
    linked: links.length > 0,
    enabled: links.length === 1 && links[0].owner_sso_opt_in_at !== null,
  };
}

/**
 * The caller's single link for the active issuer, or a coded refusal:
 * `owner_sso_not_linked` (none) or `oidc_duplicate_links` (several).
 * @param {number} userId
 */
export function ownLinkForOptIn(userId) {
  const links = ownLinksForActiveIssuer(getConnection(), userId);
  if (links.length === 0) throw new SsoSettingsError('owner_sso_not_linked', 409);
  if (links.length > 1) throw new SsoSettingsError('oidc_duplicate_links', 409);
  return links[0];
}

/** Alerts every active owner; best effort, never throws. */
function alertOwnersOfOptInChange(subjectUserId, changedAtMs) {
  let ownerIds = [];
  try {
    ownerIds = userDb.listActiveOwnerIds();
  } catch {
    process.stderr.write(`${JSON.stringify({ level: 'warn', scope: 'sso_settings', code: 'owner_alert_lookup_failed' })}\n`);
  }
  for (const ownerId of ownerIds) {
    void notifyOwnerOfSsoEvent(ownerId, 'owner_sso_opt_in_changed', subjectUserId, String(changedAtMs));
  }
}

/**
 * Writes the caller's opt-in on `link` with a same-transaction strict audit
 * (a failed audit rolls the write back), then alerts the owners.
 * @param {{ userId: number, link: { id: number }, enabled: boolean, nowMs?: number }} input
 * @returns {{ linked: true, enabled: boolean }}
 */
export function setOwnerSsoOptIn({ userId, link, enabled, nowMs = Date.now() }) {
  const db = getConnection();
  db.transaction(() => {
    if (!userIdentitiesDb.setOwnerSsoOptIn(link.id, userId, enabled ? nowMs : null)) {
      throw new SsoSettingsError('owner_sso_not_linked', 409);
    }
    recordStrictAuditOnConnection(db, 'sso_owner_sign_in_changed', {
      userId, metadata: { identityId: link.id, enabled },
    });
  }).immediate();
  alertOwnersOfOptInChange(userId, nowMs);
  return { linked: true, enabled };
}
