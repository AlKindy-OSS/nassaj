/**
 * Deployment security posture (T-1085, revised 2026-07-29 after the first
 * revision still bricked a live node).
 *
 * WHAT THE FIRST ATTEMPT GOT WRONG: it keyed the strict posture on the ACCOUNT
 * COUNT — more than one account meant "shared" meant "refuse to boot". A fleet
 * node with two colleagues on it (both of whom have shell access to that host
 * anyway) was therefore still unbootable, which is exactly the failure this
 * work existed to remove. Account count measures how many people log in; it
 * says nothing about whether they are ALREADY trusted on the host.
 *
 * THE CORRECT QUESTION is a deployment fact only the operator knows, plus one
 * fact the server can prove about itself:
 *
 *   'shared'      → this instance serves people who are NOT trusted operators
 *                   of the host. Two ways to reach it, both explicit:
 *                     • NASSAJ_SECURITY_POSTURE=strict — the operator declares
 *                       it (multi-tenant, public, or untrusted-user instance);
 *                     • platform mode — authentication is DISABLED there (every
 *                       request resolves to the first user, see auth.js), so
 *                       "the users" are literally anyone who can reach the port.
 *                   Host-level guards stay FAIL-CLOSED in this posture.
 *   'trusted'     → the default. Everyone with an account here is an operator
 *                   of this machine. Anything the server can reach — docker.sock,
 *                   the home directory, sudo — those humans can already reach
 *                   from their own shell, so refusing to boot costs a working
 *                   install and buys nothing. Guards DEGRADE TO A LOUD WARNING
 *                   that is logged AND surfaced in the UI until it is fixed.
 *
 * The default is the permissive one on purpose: nassaj is installed by the
 * person who owns the machine. Making the SAFE-BUT-DEAD state the default was
 * the bug. An operator who runs an untrusted-user instance flips one env var
 * and gets the old fail-closed behavior back, unchanged.
 *
 * Platform mode cannot be downgraded by any env value — there, auth is off, so
 * "trusted accounts" is not a claim the operator is in a position to make.
 */

/** Env var an operator sets to declare the deployment's trust model. */
export const SECURITY_POSTURE_ENV = 'NASSAJ_SECURITY_POSTURE';

/**
 * Resolves the posture of this deployment.
 *
 * Dependencies are injectable for tests; production callers pass nothing and
 * get the live environment.
 *
 * @param {object} [deps]
 * @param {NodeJS.ProcessEnv} [deps.env]
 * @param {boolean} [deps.isPlatform]
 * @returns {{ posture: 'shared'|'trusted', shared: boolean, reason: string }}
 */
export function resolveSecurityPosture({
  env = process.env,
  // Read from the same raw source as server/constants/config.js IS_PLATFORM
  // rather than importing that constant: the isolation seam deliberately keeps
  // its dependency surface minimal (eslint boundaries classifies constants/ as
  // unknown from here), and a single env read cannot drift from a single env read.
  isPlatform = env?.VITE_IS_PLATFORM === 'true',
} = {}) {
  // Platform mode FIRST: it disables authentication, so no operator claim about
  // "trusted accounts" can be true there. Checked before the env override so
  // the override cannot weaken it.
  if (isPlatform) {
    return {
      posture: 'shared',
      shared: true,
      reason: 'platform mode is ON — authentication is disabled, so every caller is an untrusted user',
    };
  }

  const declared = String(env?.[SECURITY_POSTURE_ENV] ?? '').trim().toLowerCase();
  if (declared === 'strict' || declared === 'shared') {
    return {
      posture: 'shared',
      shared: true,
      reason: `${SECURITY_POSTURE_ENV}=${declared} (operator-declared untrusted-user instance)`,
    };
  }

  return {
    posture: 'trusted',
    shared: false,
    reason:
      declared === 'trusted'
        ? `${SECURITY_POSTURE_ENV}=trusted (operator-declared: every account here is an operator of this host)`
        : 'default posture: accounts on this instance are operators of this host ' +
          `(set ${SECURITY_POSTURE_ENV}=strict on an untrusted-user instance)`,
  };
}
