/**
 * Shared OIDC configuration predicates (single source of truth).
 *
 * Both the OIDC RP routes (routes/oidc.js) and the public auth-status route
 * (routes/auth.js) gate on the SAME oidcEnabled() so the SPA never advertises a
 * login path the server would 501, and the server never mints a role from OIDC
 * unless role mapping is safely configured.
 *
 * Fail-closed role scoping (ADR-064/069): OIDC role mapping reads ONLY the
 * project-scoped Zitadel claim `urn:zitadel:iam:org:project:<id>:roles`. If
 * OIDC_ENABLED=true but OIDC_ROLE_PROJECT_ID is missing or invalid, there is no
 * safe claim to read (the generic cross-project claim is never trusted), so OIDC
 * is treated as NOT configured: oidcEnabled() returns false and a single, secret
 * free warning is logged.
 */

import { isValidRoleProjectId } from './external-role-mapper.js';

/** The configured Zitadel project id (raw), or undefined when unset/empty. */
export function roleProjectId() {
  const raw = process.env.OIDC_ROLE_PROJECT_ID;
  return typeof raw === 'string' && raw.length > 0 ? raw : undefined;
}

// Log the misconfiguration warning at most once per misconfiguration episode
// (avoids flooding the log on every request); re-armed once config is corrected.
let warnedMisconfig = false;

function warnMissingRoleProjectId() {
  if (warnedMisconfig) {
    return;
  }
  warnedMisconfig = true;
  process.stderr.write(`${JSON.stringify({
    level: 'warn',
    scope: 'oidc',
    code: 'oidc_disabled_missing_role_project_id',
    message: 'OIDC_ENABLED=true but OIDC_ROLE_PROJECT_ID is missing or invalid; OIDC is disabled (fail-closed)',
  })}\n`);
}

/**
 * Feature flag — OIDC is live only when it is explicitly enabled AND role
 * mapping is safely scoped to a valid project id. Every IdP/browser route and
 * the status flag share this predicate.
 * @returns {boolean}
 */
export function oidcEnabled() {
  if (process.env.OIDC_ENABLED !== 'true') {
    warnedMisconfig = false;
    return false;
  }
  if (!isValidRoleProjectId(roleProjectId())) {
    warnMissingRoleProjectId();
    return false;
  }
  warnedMisconfig = false;
  return true;
}
