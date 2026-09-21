/**
 * Platform isolation boot guard (B-5).
 *
 * Closes the silent shared-subscription hole flagged by qa-critic for the
 * ADR-023 platform-mode path. In platform mode (`IS_PLATFORM`),
 * `authenticateWebSocket(null)` bypasses JWT and resolves EVERY session to the
 * first active user (`getFirstUser`, see server/middleware/auth.js). If the
 * Claude provider is configured `isolated` (the default — per-user credential
 * isolation, ADR-023/ADR-016) AND more than one active account exists, then all
 * those people would silently run on the FIRST user's single Claude
 * subscription. That is a credential-sharing condition and a violation of
 * Anthropic's ToS for individual subscriptions (memory:
 * project_is_platform_shared_sub_risk).
 *
 * Policy: fail-closed. If platform mode is on AND Claude is isolated AND there
 * is more than one active user, refuse to boot with a loud, actionable fatal
 * error rather than serve a silently-shared subscription. The guard reads the
 * exact same sources the runtime uses (IS_PLATFORM, isProviderIsolated('claude'),
 * userDb.getActiveUserCount) so it cannot drift from real behavior.
 *
 * Safe configurations that pass:
 *   - platform mode OFF (normal OSS JWT path — every session is its own user);
 *   - Claude provider 'shared' (sharing is the explicit, intentional policy);
 *   - 0 or 1 active user (no one is being shared onto another's subscription).
 */

import { IS_PLATFORM } from '../constants/config.js';
import { userDb } from '../modules/database/index.js';
import { isProviderIsolated } from './provider-sharing.js';

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
 * PlatformIsolationViolationError when the unsafe combination is detected;
 * returns silently (no-op) for every safe configuration.
 *
 * Dependencies are injected for testability; production callers use the
 * defaults (the live IS_PLATFORM flag, the real provider-sharing check, and the
 * real userDb).
 *
 * @param {object} [deps]
 * @param {boolean} [deps.isPlatform]            platform-mode flag
 * @param {(p: string) => boolean} [deps.isIsolated]  provider-isolation check
 * @param {() => number} [deps.activeUserCount]  active-user counter
 * @returns {void}
 */
export function enforcePlatformIsolationGuard({
  isPlatform = IS_PLATFORM,
  isIsolated = isProviderIsolated,
  activeUserCount = () => userDb.getActiveUserCount(),
} = {}) {
  // Only platform mode collapses every session onto the first user; OSS JWT
  // mode authenticates each user separately, so it is always safe.
  if (!isPlatform) {
    return;
  }

  // If Claude is explicitly shared, running everyone on one subscription is the
  // intended, documented policy — not a silent leak. Nothing to guard.
  if (!isIsolated('claude')) {
    return;
  }

  const activeUsers = activeUserCount();

  // 0 or 1 active account: no second person is being folded onto the first
  // user's subscription, so the isolated policy is honored in practice.
  if (activeUsers <= 1) {
    return;
  }

  throw new PlatformIsolationViolationError(
    'Refusing to boot: platform mode is ON and the Claude provider is ' +
      `'isolated', but ${activeUsers} active users exist. In platform mode ` +
      'every session authenticates as the first active user, so all of them ' +
      "would silently share the first user's single Claude subscription — a " +
      'credential-sharing condition that violates Anthropic ToS for ' +
      'individual subscriptions (B-5 / ADR-023). Resolve by one of: ' +
      '(a) disable platform mode (unset VITE_IS_PLATFORM) so each user ' +
      'authenticates with their own JWT and credentials; ' +
      "(b) set the Claude provider sharing policy to 'shared' if a shared " +
      'operator subscription is genuinely intended and ToS-compliant; or ' +
      '(c) reduce active users to at most one. ' +
      'See memory: project_is_platform_shared_sub_risk.'
  );
}
