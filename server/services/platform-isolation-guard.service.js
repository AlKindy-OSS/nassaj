/**
 * Platform isolation boot guard (B-5, ADR-152 amendment 1 §3.6).
 *
 * In platform mode (`IS_PLATFORM`), `authenticateWebSocket(null)` bypasses JWT
 * and resolves EVERY session to the first active user (`getFirstUser`, see
 * server/middleware/auth.js). With more than one active account, everyone would
 * silently run on the FIRST user's credentials for every provider — credential
 * sharing without the owner's grant, and a violation of the vendors' terms for
 * individual subscriptions (memory: project_is_platform_shared_sub_risk).
 *
 * Policy: fail-closed. Platform mode with more than one active user refuses to
 * boot. No stored or injected sharing policy can make it pass: isolation is a
 * constant (the install-wide sharing policy is retired).
 *
 * Safe configurations that pass:
 *   - platform mode OFF (normal OSS JWT path — every session is its own user);
 *   - 0 or 1 active user (no one is folded onto another's credentials).
 */

import { IS_PLATFORM } from '../constants/config.js';
import { userDb } from '../modules/database/index.js';

/**
 * Error thrown when the guard refuses to boot. A distinct class so callers/tests
 * can assert on it without string matching.
 */
export class PlatformIsolationViolationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PlatformIsolationViolationError';
  }
}

/**
 * Enforces the platform-mode isolation invariant at boot. Throws
 * PlatformIsolationViolationError when platform mode is on with more than one
 * active user; returns silently otherwise.
 *
 * @param {object} [deps] injected for tests; production uses the defaults
 * @param {boolean} [deps.isPlatform]            platform-mode flag
 * @param {() => number} [deps.activeUserCount]  active-user counter
 * @returns {void}
 */
export function enforcePlatformIsolationGuard({
  isPlatform = IS_PLATFORM,
  activeUserCount = () => userDb.getActiveUserCount(),
} = {}) {
  // OSS JWT mode authenticates each user separately, so it is always safe.
  if (!isPlatform) {
    return;
  }

  const activeUsers = activeUserCount();
  if (activeUsers <= 1) {
    return;
  }

  throw new PlatformIsolationViolationError(
    `Refusing to boot: platform mode is ON and ${activeUsers} active users exist. ` +
      'In platform mode every session authenticates as the first active user, so ' +
      "all of them would silently run on the first user's provider credentials — " +
      'credential sharing without its owner\'s grant (B-5 / ADR-152 A1). Resolve by one of: ' +
      '(a) disable platform mode (unset VITE_IS_PLATFORM) so each user ' +
      'authenticates with their own JWT and credentials; or ' +
      '(b) reduce active users to at most one. ' +
      'See memory: project_is_platform_shared_sub_risk.'
  );
}
