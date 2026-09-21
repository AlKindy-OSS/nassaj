/**
 * resolveProviderEnvStrict(userId, provider) — the FAIL-CLOSED wrapper around the
 * shared resolveProviderEnv (ADR-053 §هـ-1, the ToS blocker; T-820 critic fix).
 *
 * THE HOLE IT CLOSES
 * ------------------
 * The shared `resolveProviderEnv` is fail-OPEN by design: `userId ===
 * null/undefined/''` returns the base (operator) environment UNCHANGED — a
 * legitimate "system/anonymous" semantics for its other callers. But on the
 * BACKGROUND-TASK path (the launch route, and later the handoff injector /
 * result-capture that may resolve env OUTSIDE GATE2), a null/unknown id must
 * NEVER silently fall back to the OWNER's subscription (silent subscription
 * sharing, memory project_is_platform_shared_sub_risk). Those paths call THIS
 * wrapper, which THROWS on any non-positive-integer id instead of falling open.
 *
 * WHY A WRAPPER, NOT AN EDIT TO resolveProviderEnv
 * ------------------------------------------------
 * `resolveProviderEnv`'s null=system behavior is correct and relied upon by other
 * callers; changing it would break them. The strict contract belongs ONLY to the
 * background/isolated spawn paths, so it lives in a wrapper they call explicitly.
 */

import { resolveProviderEnv } from './resolve-provider-env.js';

/**
 * Builds the isolated provider env for `userId`, or THROWS if `userId` is not a
 * positive integer. There is no fallback-to-owner branch: an unresolved identity
 * is a hard failure on the background path.
 *
 * @param {number} userId authenticated integer user id (> 0)
 * @param {import('./resolve-provider-env.js').ProviderName} provider
 * @param {NodeJS.ProcessEnv} [baseEnv] base environment to extend
 * @returns {NodeJS.ProcessEnv} isolated env (with per-user CLAUDE_CONFIG_DIR)
 * @throws {Error} when userId is not a positive integer (fail-closed)
 */
export function resolveProviderEnvStrict(userId, provider, baseEnv = process.env) {
  if (!Number.isInteger(userId) || userId <= 0) {
    throw new Error(
      'resolveProviderEnvStrict: refusing to build a provider env for a ' +
        'non-integer/non-positive userId (fail-closed — no fall-through to the ' +
        'owner/system subscription).',
    );
  }
  return resolveProviderEnv(userId, provider, baseEnv);
}
