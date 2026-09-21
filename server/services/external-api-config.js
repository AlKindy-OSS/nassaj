import { appConfigDb } from '../modules/database/index.js';

/**
 * ADR-102 / T-1242 — the master switch for the PROGRAMMATIC ACCESS surface
 * (`POST /api/agent` + the `ck_…` API keys that authenticate it).
 *
 * WHY A SWITCH AT ALL. That endpoint is inherited from upstream
 * (claudecodeui / CloudCLI.ai), not built for this deployment, and it was
 * measured unused: zero rows in `api_keys`, and no script, cron or CI in this
 * repo ever calls it. What it DOES carry is the largest blast radius in the
 * app — it runs an agent with `permissionMode:'bypassPermissions'`, spawns
 * `git`, clones repositories and can push branches and open pull requests —
 * behind a PERMANENT credential with no expiry, no rotation and no scopes.
 * Every hardening pass it has cost us (SEC-APIKEY-QS, SEC-AGENT-RL,
 * SEC-GIT-URL, SEC-APIKEY-STATUS, SEC-SSE-ABORT, B-36) was spent defending a
 * door nobody walks through.
 *
 * Deleting it outright would break `fork` alignment with upstream on a file we
 * still merge, so the surface stays in the tree and is gated instead.
 *
 * FAIL-CLOSED IS THE POINT. The flag lives in `app_config` (not the env) so the
 * owner can flip it from Settings without a redeploy; the cost of that choice
 * is that a missing row, an unreadable database or a garbage value must all
 * mean OFF. `appConfigDb.get` already swallows its own errors and returns null,
 * and null is not '1' — so every failure mode lands on disabled. Only the exact
 * string '1' opens the door.
 */
export const EXTERNAL_API_ENABLED_KEY = 'external_api.enabled';

/**
 * True only when the owner has explicitly enabled programmatic access.
 * Unset, malformed, or unreadable ⇒ false.
 *
 * @returns {boolean}
 */
export function isExternalApiEnabled() {
  return appConfigDb.get(EXTERNAL_API_ENABLED_KEY) === '1';
}

/**
 * Persists the switch. Callers are responsible for authorizing the change
 * (owner-only) and for recording it in the audit log.
 *
 * @param {boolean} enabled
 */
export function setExternalApiEnabled(enabled) {
  appConfigDb.set(EXTERNAL_API_ENABLED_KEY, enabled ? '1' : '0');
}

/**
 * Express gate for the programmatic-access surface.
 *
 * It lives here, as its own middleware, rather than as the first lines of
 * `validateExternalApiKey`, for one reason: ORDER IS THE SECURITY PROPERTY.
 * The authentication middleware's very first branch (`IS_PLATFORM`) accepts a
 * request as the first user WITHOUT inspecting any credential, so a check
 * placed even one line below it would leave the most dangerous path ungated.
 * As a separate middleware the ordering is declared at the route — visible,
 * reviewable, and testable — instead of resting on a comment inside a function.
 *
 * 404 rather than 403: a disabled surface should be indistinguishable from a
 * route that was never mounted, so probing cannot confirm the endpoint exists.
 */
export function requireExternalApiEnabled(req, res, next) {
  if (!isExternalApiEnabled()) {
    return res.status(404).json({ error: 'Not found' });
  }
  return next();
}
