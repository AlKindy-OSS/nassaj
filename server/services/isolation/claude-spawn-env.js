/**
 * claude-spawn-env — the ONE function behind the Claude spawn env and every harness that
 * mirrors Claude's policy (ADR-226 H3, B-1760). The Claude spawn (claude-sdk.js) and the
 * Claude-parity engine (dsh, OpenCode) both build Claude's env here, with credential grants
 * honoured, so a member on a granted Claude gets the grantor's settings, rules and hooks on
 * every harness exactly as on his Claude turn.
 *
 * It throws exactly where Claude's own spawn throws (no member, provider refused). A member
 * without Claude credentials gets an env all the same: resolveProviderEnv does not throw
 * for that. Side effect (inherited from resolveProviderEnv): the operator policy is seeded
 * into the Claude config dir, so call it once per turn and pass the env along.
 */
import { resolveProviderEnv } from './resolve-provider-env.js';

/**
 * Claude's spawn env for `actor`.
 * @param {unknown} actor the member id, passed to resolveProviderEnv unchanged
 * @param {NodeJS.ProcessEnv} [baseEnv] the env to build on (defaults to the server env)
 * @returns {NodeJS.ProcessEnv}
 */
export function claudeSpawnEnvFor(actor, baseEnv = process.env) {
  return resolveProviderEnv(actor, 'claude', baseEnv);
}
