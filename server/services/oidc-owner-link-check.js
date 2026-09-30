/**
 * B-1410 boot check. Before the admin link route was removed, any admin could
 * attach an IdP subject they control to an owner account. At startup this
 * warns once when an owner holds an SSO link, so the owner can review it and
 * remove it (DELETE /api/auth/oidc/link/self). Logs a count only — never ids,
 * issuers or subjects. Never throws.
 *
 * T-1939 slice 5: the same boot pass reports users holding more than one link
 * for one issuer (they blocked the UNIQUE(user_id, issuer) index and are
 * refused at SSO login until the owner removes the extras) as a WARN plus an
 * `oidc_duplicate_links_detected` audit row carrying the count only.
 */
import { auditLogDb, userIdentitiesDb } from '../modules/database/index.js';

function warn(fields) {
  process.stderr.write(`${JSON.stringify({ level: 'warn', scope: 'oidc', ...fields })}\n`);
}

function reportDuplicateIssuerLinks() {
  let duplicateUsers = 0;
  try {
    duplicateUsers = userIdentitiesDb.countUsersWithDuplicateIssuerLinks();
    if (duplicateUsers > 0) {
      auditLogDb.record('oidc_duplicate_links_detected', { userId: null, metadata: { duplicateUsers } });
    }
  } catch {
    warn({ code: 'duplicate_link_check_failed' });
    return;
  }
  if (duplicateUsers > 0) {
    warn({ code: 'users_with_duplicate_sso_links', duplicateUsers });
  }
}

export function warnOnOwnerOidcLinks() {
  reportDuplicateIssuerLinks();
  let ownerCount = 0;
  try {
    ownerCount = userIdentitiesDb.countLinkedUsersWithRole('owner');
  } catch {
    warn({ code: 'owner_link_check_failed' });
    return;
  }
  if (ownerCount > 0) {
    warn({ code: 'owner_account_has_sso_link', ownerCount });
  }
}
