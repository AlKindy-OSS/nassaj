/**
 * resolvedKnob — reads the tree knob a resolved provider environment carries
 * (CLAUDE_CONFIG_DIR, CODEX_HOME, HOME, XDG_DATA_HOME, XDG_CONFIG_HOME).
 * ADR-152 A1 §3.4: resolveProviderEnv sets one for every
 * accepted actor, so a missing knob is a bug — refused, never replaced by the
 * operator's own tree (the `?? operatorHome()` fallbacks this replaces).
 *
 * Kept out of resolve-provider-env.js so test files that mock the resolver with
 * a partial export set still link.
 */

// Namespace import: some test files mock shared/utils with a partial export set.
import * as utils from '../../shared/utils.js';

/**
 * @param {NodeJS.ProcessEnv} env an environment returned by resolveProviderEnv
 * @param {string} name the knob
 * @returns {string}
 */
export function resolvedKnob(env, name) {
  const value = env?.[name];
  if (typeof value === 'string' && value.trim() !== '') return value;
  const message = `The resolved environment has no ${name}.`;
  const options = { code: 'PROVIDER_ISOLATION_UNAVAILABLE', statusCode: 501 };
  throw utils.AppError ? new utils.AppError(message, options) : Object.assign(new Error(message), options);
}
