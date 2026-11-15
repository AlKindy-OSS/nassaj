/**
 * apply-codex-local-engine-env — runs the Codex body on a local model server the
 * CALLER registered (ADR-227 "Codex and DSH bodies", T-2107). The vetting, the
 * pin and the refusals are the Claude body's (resolveLocalEngine); this module
 * adds only what is Codex's own: its switch, grant rule and CLI version gate, its
 * context fit, and the provider config handed to `new Codex({ config })`.
 *
 * Measured on codex-cli 0.166.0 (T-2107 stage 3, header-echo + netns):
 *   - the CLI speaks the Responses protocol only (`wire_api = "chat"` is
 *     rejected), at `<origin>/v1`;
 *   - a provider whose `env_key` names a set variable sends exactly that value as
 *     the bearer; a stored ChatGPT login, an API-key auth.json, OPENAI_API_KEY and
 *     CODEX_API_KEY never reached the local URL;
 *   - the apps feature sent the ChatGPT token to chatgpt.com during a local turn
 *     unless `features.apps = false` or the home holds no auth.json; both apply
 *     here (codex-local-home.js gives the run a credential-free home).
 *
 * @typedef {import('./apply-claude-local-engine-env.js').LocalEngine} LocalEngine
 * @typedef {{ local: LocalEngine, config: Record<string, string|number|boolean> }} CodexLocalApplied
 */

import { LOCAL_ENGINE_ROUTE_OVERRIDE_KEYS } from './engine-anthropic-credential-guard.js';
import {
  CLAUDE_LOCAL_CONTEXT_MARGIN_TOKENS,
  CLAUDE_LOCAL_OUTPUT_CAP_TOKENS,
  LOCAL_NO_KEY_PLACEHOLDER,
  localEngineUnavailableError,
  localModelOutputTokens,
  resolveLocalEngine,
  resolveVersionGatedDeps,
  versionGatedLocalDeps,
} from './apply-claude-local-engine-env.js';

/**
 * Codex's fixed first request on a local server, rounded up: base instructions,
 * tool schemas, the nassaj governance AGENTS.md and the role roster. Measured on
 * gpt-oss-20b with the full governance and 29 roles: 13,764 input tokens; the
 * other tokenizers measured for the Claude body counted up to 1.51x more, so
 * 22,000 is that measurement scaled by 1.51 plus ~6% for growth.
 */
export const CODEX_LOCAL_BASE_PROMPT_TOKENS = 22000;
/** The nassaj-generated provider id inside the Codex config. */
export const CODEX_LOCAL_PROVIDER_ID = 'nassaj_local';
/** The variable the generated provider reads its bearer from (`env_key`). */
export const CODEX_LOCAL_KEY_ENV = 'NASSAJ_LOCAL_API_KEY';

/**
 * Inherited variables that would carry an OpenAI credential or route the run
 * anywhere but the server. Removed from the child env of every local run.
 */
export const CODEX_LOCAL_STRIPPED_ENV_KEYS = Object.freeze([
  'OPENAI_API_KEY', 'CODEX_API_KEY', 'OPENAI_BASE_URL', 'OPENAI_ORG_ID', 'OPENAI_ORGANIZATION',
  'OPENAI_PROJECT', 'CODEX_INTERNAL_ORIGINATOR_OVERRIDE', ...LOCAL_ENGINE_ROUTE_OVERRIDE_KEYS,
]);

/**
 * Features that contact a vendor host during a local turn, measured in the sealed
 * namespace (codex-local-engine.header-echo.test.ts): `apps` sent the ChatGPT token
 * to chatgpt.com (stage 3); the plugin features fetch marketplaces from github.com
 * and chatgpt.com.
 */
export const CODEX_LOCAL_DISABLED_FEATURES = Object.freeze([
  'apps', 'plugins', 'remote_plugin', 'plugin_discovery_prefetch', 'plugin_sharing',
]);

/** Codex-worded refusals; the other reasons keep the shared wording. */
const CODEX_REASON_DETAIL = Object.freeze({
  feature_disabled: 'Codex on local model servers is turned off on this installation.',
  cli_version_unproven: 'The installed Codex version has not passed the local-server credential proof yet.',
  context_too_small: "The model's context window is smaller than Codex needs "
    + `(${minimumCodexLocalContextWindow(CLAUDE_LOCAL_OUTPUT_CAP_TOKENS)} tokens).`,
});

/**
 * Smallest context window a Codex-body run accepts for a given output reservation.
 * @param {number} outputTokens
 * @returns {number}
 */
export function minimumCodexLocalContextWindow(outputTokens) {
  return CODEX_LOCAL_BASE_PROMPT_TOKENS + outputTokens + CLAUDE_LOCAL_CONTEXT_MARGIN_TOKENS;
}

/**
 * The ONE static vetting of a local model for the Codex body. No I/O.
 * @param {{id: string, contextWindow?: unknown, maxOutput?: unknown}} model
 * @returns {'ok'|'context_unknown'|'context_too_small'}
 */
export function codexLocalModelEligibility(model) {
  const window = model.contextWindow;
  if (!Number.isSafeInteger(window) || window <= 0) return 'context_unknown';
  if (window < minimumCodexLocalContextWindow(localModelOutputTokens(model))) return 'context_too_small';
  return 'ok';
}

/** Production dependencies (switch and grant rule of the Codex body), loaded on first local use. */
const loadDefaultDeps = versionGatedLocalDeps('codex', (config) => ({
  enabled: config.codexLocalEngineEnabled, runnable: config.codexLocalModelsRunnable,
}));

/**
 * Config overrides of a local run (SDK `config`, dotted keys so they merge with
 * the launch's other overrides instead of replacing a whole table).
 * @param {LocalEngine} local
 * @returns {Record<string, string|number|boolean>}
 */
export function codexLocalConfig(local) {
  const provider = `model_providers.${CODEX_LOCAL_PROVIDER_ID}`;
  return {
    model_provider: CODEX_LOCAL_PROVIDER_ID,
    [`${provider}.name`]: 'Nassaj local model server',
    [`${provider}.base_url`]: `${local.connectOrigin}/v1`,
    [`${provider}.env_key`]: CODEX_LOCAL_KEY_ENV,
    [`${provider}.wire_api`]: 'responses',
    model_context_window: local.contextWindow,
    ...Object.fromEntries(CODEX_LOCAL_DISABLED_FEATURES.map((name) => [`features.${name}`, false])),
    // Measured in the sealed namespace on a full tool turn: the metrics exporter
    // resolves ab.chatgpt.com (OTLP) unless analytics is off.
    'analytics.enabled': false,
  };
}

/**
 * Applies a local Codex engine or throws ENGINE_PROVIDER_UNAVAILABLE (no fallback).
 * `env` is mutated only when a local engine is applied. Returns null when none
 * was requested.
 * @param {NodeJS.ProcessEnv} env spawn env (already cloned)
 * @param {{ userId: string|number, requestedModel?: string|null, storedPin?: string|null,
 *   cliVersion?: string|null, qualifyBareModel?: boolean }} input `cliVersion` is the
 *   launch identity's version; `qualifyBareModel` see resolveLocalEngine
 * @param {Record<string, Function>} [deps] test seam (enabled, runnable, listServers,
 *   getSecret, resolvePrivate, isVersionProven)
 * @returns {Promise<CodexLocalApplied|null>}
 */
export async function applyCodexLocalEngineEnvOrThrow(env, input, deps = {}) {
  const resolved = await resolveLocalEngine(input, () => resolveVersionGatedDeps(deps, loadDefaultDeps, input.cliVersion), codexLocalModelEligibility);
  if (resolved.status === 'none') return null;
  if (resolved.status !== 'resolved') throw localEngineUnavailableError(resolved, CODEX_REASON_DETAIL);
  for (const key of CODEX_LOCAL_STRIPPED_ENV_KEYS) delete env[key];
  env[CODEX_LOCAL_KEY_ENV] = resolved.secret || LOCAL_NO_KEY_PLACEHOLDER;
  return { local: resolved.local, config: codexLocalConfig(resolved.local) };
}
