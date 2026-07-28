/**
 * apply-claude-engine-provider-env — points the Claude Agent SDK at a vendor's
 * Anthropic-compatible endpoint for the "Claude engine on a vendor" path (ADR-037,
 * B-ENG-2).
 *
 * This is the one place that may set ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN to
 * a non-official host, and it does so under tight constraints:
 *
 *   - Only for a provider in ELIGIBLE_ENGINE_PROVIDERS; anything else is refused.
 *   - Only when a per-user key actually exists; with no key we inject NOTHING, so
 *     we never produce a half-injected env (base URL set but no token, or
 *     vice-versa) that could silently break or leak.
 *   - It mutates ONLY the env object handed to it. It never reads or writes
 *     process.env — the caller owns the (already-cloned) spawn env.
 *
 * B-222 — WHY THIS RETURNS A VERDICT, NOT `null`:
 * the previous shape returned `null` for BOTH "no engine was requested" and
 * "an engine was requested but cannot be honoured". The call sites could not
 * tell those apart, so a chat pinned to a vendor engine with no stored key ran
 * on official Anthropic — the user's payload went to a vendor they did not
 * choose, with no error anywhere. Silently substituting a different vendor is
 * never an acceptable degradation, so the two cases are now distinct values and
 * the failing one is unignorable (`applyClaudeEngineProviderEnvOrThrow`).
 *
 * @typedef {import('../../../shared/engineProviders.js').EngineProviderId} EngineProvider
 * @typedef {{status:'none'}} EngineNotRequested
 * @typedef {{status:'applied', provider:string, hosts:Set<string>}} EngineApplied
 * @typedef {{status:'unavailable', provider:string, reason:'not_an_engine'|'not_eligible'|'missing_key'}} EngineUnavailable
 * @typedef {EngineNotRequested|EngineApplied|EngineUnavailable} EngineEnvVerdict
 */

import {
  engineProviderLabel,
  isEngineProvider,
  isEngineProviderEligible,
} from '../../../shared/engineProviders.js';

import { getProviderKey } from './provider-secrets-store.js';
import { ELIGIBLE_ENGINE_PROVIDERS, PROVIDER_ANTHROPIC_ENDPOINT } from './provider-anthropic-endpoints.js';

/**
 * Default request timeout for an engine-driven run, in milliseconds.
 *
 * Z.AI's own Claude Code integration guide asks for `API_TIMEOUT_MS: 3000000`
 * because a long GLM stream can idle well past the SDK's default before the
 * first token arrives, and the client aborts a run that is in fact healthy.
 * Applied ONLY when an engine is actually engaged (the official Anthropic path
 * is left byte-for-byte untouched) and ONLY when the operator has not already
 * set a value — an inherited API_TIMEOUT_MS always wins.
 */
export const ENGINE_API_TIMEOUT_MS = '3000000';

/**
 * Decides — without throwing — what the engine-provider seam does for a spawn,
 * and applies it to `env` when it can be honoured.
 *
 * @param {NodeJS.ProcessEnv} env spawn env to mutate IN PLACE (already cloned by the caller)
 * @param {string|number|null} userId authenticated user id (null = shared single-user store)
 * @param {string|null|undefined} provider engine provider id (kimi/glm)
 * @returns {EngineEnvVerdict} `none` when no engine was asked for, `applied` with
 *   the authorized hostname set, or `unavailable` with the reason. Nothing is
 *   written to `env` unless the verdict is `applied`.
 */
export function applyClaudeEngineProviderEnv(env, userId, provider) {
  // (a) No engine requested: the official Claude path. Leave env untouched.
  const requested = typeof provider === 'string' ? provider.trim() : '';
  if (!requested) {
    return { status: 'none' };
  }

  // (b) Requested but unknown / not eligible to drive the body: REFUSE. Running
  // on Anthropic instead would send the payload to a vendor the user did not
  // pick, which is the failure mode this seam exists to prevent.
  if (!isEngineProvider(requested)) {
    return { status: 'unavailable', provider: requested, reason: 'not_an_engine' };
  }
  if (!isEngineProviderEligible(requested) || !ELIGIBLE_ENGINE_PROVIDERS.has(requested)) {
    return { status: 'unavailable', provider: requested, reason: 'not_eligible' };
  }

  // (c) No per-user key: inject nothing and refuse. Returning early here is what
  // prevents a half-injected env (base URL without a matching token) — both
  // values are set together below or not at all.
  const token = getProviderKey(userId, requested);
  if (!token) {
    return { status: 'unavailable', provider: requested, reason: 'missing_key' };
  }

  // (d) Inject BOTH the endpoint and the token, on the passed env object only.
  // process.env is never touched.
  const endpoint = PROVIDER_ANTHROPIC_ENDPOINT[requested];
  env.ANTHROPIC_BASE_URL = endpoint;
  env.ANTHROPIC_AUTH_TOKEN = token;
  if (typeof env.API_TIMEOUT_MS !== 'string' || env.API_TIMEOUT_MS.trim() === '') {
    env.API_TIMEOUT_MS = ENGINE_API_TIMEOUT_MS;
  }

  // (e) Report the single hostname we authorized so the guard can fence to it.
  return {
    status: 'applied',
    provider: requested,
    hosts: new Set([new URL(endpoint).hostname]),
  };
}

/**
 * Builds the user-facing error for an engine that could not be honoured. The
 * message names the engine and the way out, because the only alternative the
 * code has is to run somewhere the user did not choose.
 *
 * @param {EngineUnavailable} verdict
 * @returns {Error & {code:string, engineProvider:string, reason:string}}
 */
export function engineProviderUnavailableError(verdict) {
  const label = engineProviderLabel(verdict.provider);
  const detail =
    verdict.reason === 'missing_key'
      ? `This chat runs on the ${label} engine, but no ${label} API key is stored for your account. ` +
        'Add it in Settings → Engines, or switch this chat back to the official Claude engine.'
      : verdict.reason === 'not_eligible'
        ? `The ${label} engine is not enabled for runs. Switch this chat back to the official Claude engine.`
        : `"${verdict.provider}" is not a known engine. Switch this chat back to the official Claude engine.`;

  const error = new Error(
    `Refusing to run on a different provider than the one you chose. ${detail}`,
  );
  error.code = 'ENGINE_PROVIDER_UNAVAILABLE';
  error.engineProvider = verdict.provider;
  error.reason = verdict.reason;
  return error;
}

/**
 * Call-site helper: applies the engine env, or throws when an engine WAS asked
 * for and cannot be honoured. Returns the authorized hostname set to hand to
 * `assertAnthropicBaseUrlAllowed` as `ctx.engineProviderHosts`, or null on the
 * official path (no engine requested) — which keeps that path unchanged.
 *
 * Prefer this at every spawn: it makes "engine requested but unavailable"
 * impossible to ignore by accident, which is precisely how B-222 survived.
 *
 * @param {NodeJS.ProcessEnv} env spawn env to mutate IN PLACE
 * @param {string|number|null} userId authenticated user id
 * @param {string|null|undefined} provider engine provider id
 * @returns {Set<string>|null}
 * @throws {Error} code ENGINE_PROVIDER_UNAVAILABLE when the engine cannot be honoured
 */
export function applyClaudeEngineProviderEnvOrThrow(env, userId, provider) {
  const verdict = applyClaudeEngineProviderEnv(env, userId, provider);
  if (verdict.status === 'unavailable') {
    throw engineProviderUnavailableError(verdict);
  }
  return verdict.status === 'applied' ? verdict.hosts : null;
}
