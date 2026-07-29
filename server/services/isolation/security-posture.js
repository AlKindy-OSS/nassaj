/**
 * Deployment security posture (T-1085).
 *
 * Boot guards that protect *other people* on a shared host must not brick a
 * single-user install. This module answers one question for every such guard:
 * does this node serve anyone besides the human who owns the machine?
 *
 *   'shared'      → the server process is trusted by accounts OTHER than the
 *                   operating-system user running it (multi-user host, platform
 *                   mode, or an explicit operator declaration). Privilege the
 *                   process holds but its users do not is a real escalation
 *                   path → host-level guards stay FAIL-CLOSED here.
 *   'single-user' → exactly one account, no platform mode. The only human able
 *                   to drive the agents is the same human who owns the login
 *                   session; anything the server can reach (docker.sock, the
 *                   home directory, sudo) that person can already reach from
 *                   their own shell. Refusing to boot buys no security and only
 *                   costs a working install → guards DEGRADE TO A LOUD WARNING.
 *
 * Escalation is one-way BY DESIGN: `NASSAJ_SECURITY_POSTURE=strict` forces
 * 'shared' on a node that looks single-user, but NO environment value can force
 * 'single-user' on a node that is genuinely shared. A disable flag for the
 * shared case is exactly what the 2026-07-14 committee vetoed; this module
 * narrows *when* fail-closed applies, it never hands out an off switch.
 */

import { userDb } from '../../modules/database/index.js';

/** Env var an operator sets to force the strict (shared-host) posture. */
export const SECURITY_POSTURE_ENV = 'NASSAJ_SECURITY_POSTURE';

/**
 * Resolves the posture of this deployment.
 *
 * Dependencies are injectable for tests; production callers use the defaults
 * (the live env, the live IS_PLATFORM flag, the real userDb). A throwing or
 * unavailable user count is treated as 'shared' — an unknown user population is
 * indistinguishable from a shared one, and this module must never widen a
 * guard's blast radius on a state it cannot read.
 *
 * @param {object} [deps]
 * @param {NodeJS.ProcessEnv} [deps.env]
 * @param {boolean} [deps.isPlatform]
 * @param {() => number} [deps.activeUserCount]
 * @returns {{ posture: 'shared'|'single-user', shared: boolean, reason: string }}
 */
export function resolveSecurityPosture({
  env = process.env,
  // Read from the same raw source as server/constants/config.js IS_PLATFORM
  // rather than importing that constant: the isolation seam deliberately keeps
  // its dependency surface to the database barrel (eslint boundaries classifies
  // constants/ as unknown from here), and a single env read cannot drift from a
  // single env read.
  isPlatform = env?.VITE_IS_PLATFORM === 'true',
  activeUserCount = () => userDb.getActiveUserCount(),
} = {}) {
  const declared = String(env?.[SECURITY_POSTURE_ENV] ?? '').trim().toLowerCase();
  if (declared === 'strict' || declared === 'shared') {
    return {
      posture: 'shared',
      shared: true,
      reason: `${SECURITY_POSTURE_ENV}=${declared} (operator-declared shared host)`,
    };
  }

  if (isPlatform) {
    return {
      posture: 'shared',
      shared: true,
      reason: 'platform mode is ON (sessions are not per-OS-user)',
    };
  }

  let users;
  try {
    users = activeUserCount();
  } catch (err) {
    return {
      posture: 'shared',
      shared: true,
      reason: `active-user count unavailable (${err?.message || 'unknown error'}) — treated as shared`,
    };
  }

  if (!Number.isFinite(users)) {
    return {
      posture: 'shared',
      shared: true,
      reason: 'active-user count is not a number — treated as shared',
    };
  }

  if (users > 1) {
    return {
      posture: 'shared',
      shared: true,
      reason: `${users} active accounts share this server process`,
    };
  }

  return {
    posture: 'single-user',
    shared: false,
    reason: `${users} active account — the only operator is the OS user running this process`,
  };
}
