/**
 * apply-dsh-local-engine-env — resolves the local model server of a DeepSeek
 * Harness turn (ADR-227 "DSH local corrector", T-2108). The vetting, the pin and
 * the refusals are the shared ones (resolveLocalEngine); this module adds only
 * what is DSH's own: its switch (`local_models.dsh_enabled`), its CLI version gate
 * (dsh-local-proven-versions.json, bound to the exact dsh entry the launch runs)
 * and its context fit. It never touches an env: the server key stays in the
 * nassaj process, inside the turn's corrector (dsh-local-corrector.js).
 *
 * @typedef {import('./apply-claude-local-engine-env.js').LocalEngine} LocalEngine
 */

import {
  CLAUDE_LOCAL_CONTEXT_MARGIN_TOKENS,
  CLAUDE_LOCAL_OUTPUT_CAP_TOKENS,
  localEngineUnavailableError,
  localModelOutputTokens,
  resolveLocalEngine,
  resolveVersionGatedDeps,
  versionGatedLocalDeps,
} from './apply-claude-local-engine-env.js';
import { LOCAL_ENGINE, isLocalModelId, parseLocalEnginePin } from './local-engine-pin.js';

/**
 * DSH's fixed first request on a local server (acp profile, the Nassaj policy
 * plugin's tool set, system prompt, the full nassaj governance AGENTS.md and the
 * runtime instructions), rounded up. Measured on the first request of a fresh
 * session (T-2108, dsh 0.2.2-rc.1, llama.cpp): gpt-oss-20b 12,560, gemma-4-26b
 * 14,044, qwen3.6-35b 14,192 tokens; 16,000 is the largest plus ~13% for tokenizer
 * variance and governance growth.
 */
export const DSH_LOCAL_BASE_PROMPT_TOKENS = 16000;

/** DSH-worded refusals; the other reasons keep the shared wording. */
const DSH_REASON_DETAIL = Object.freeze({
  feature_disabled: 'DeepSeek Harness on local model servers is turned off on this installation.',
  cli_version_unproven: 'The installed DeepSeek Harness version has not passed the local-server credential proof yet.',
  context_too_small: "The model's context window is smaller than DeepSeek Harness needs "
    + `(${minimumDshLocalContextWindow(CLAUDE_LOCAL_OUTPUT_CAP_TOKENS)} tokens).`,
});

/**
 * Smallest context window a DSH run accepts for a given output reservation.
 * @param {number} outputTokens
 * @returns {number}
 */
export function minimumDshLocalContextWindow(outputTokens) {
  return DSH_LOCAL_BASE_PROMPT_TOKENS + outputTokens + CLAUDE_LOCAL_CONTEXT_MARGIN_TOKENS;
}

/**
 * The ONE static vetting of a local model for the DSH body (spawn and picker). No I/O.
 * @param {{id: string, contextWindow?: unknown, maxOutput?: unknown}} model
 * @returns {'ok'|'context_unknown'|'context_too_small'}
 */
export function dshLocalModelEligibility(model) {
  const window = model.contextWindow;
  if (!Number.isSafeInteger(window) || window <= 0) return 'context_unknown';
  if (window < minimumDshLocalContextWindow(localModelOutputTokens(model))) return 'context_too_small';
  return 'ok';
}

/** Production dependencies (switch and grant rule of the DSH body), loaded on first local use. */
const loadDefaultDeps = versionGatedLocalDeps('dsh', (config) => ({
  enabled: config.dshLocalEngineEnabled, runnable: config.dshLocalModelsRunnable,
}));

/**
 * T-2108 qa HIGH 4 / round 2: the model a DSH turn asks for. The server is the
 * single source of a local chat's model: on a locally pinned chat it is always the
 * model recorded at the chat's creation, whatever id the client sends; null when
 * none is recorded (refused, never the server's first model). A new chat asks for
 * the model it names.
 * @param {{ storedPin?: string|null, requestedModel?: string|null, recordedModel?: string|null }} input
 * @returns {string|null}
 */
export function dshLocalRequestedModel({ storedPin = null, requestedModel = null, recordedModel = null }) {
  if (!parseLocalEnginePin(storedPin)) return requestedModel;
  return isLocalModelId(recordedModel) ? recordedModel : null;
}

/**
 * The local engine of a DSH turn, or a typed refusal (never a cloud fallback).
 * Null when the turn asks for no local engine.
 * @param {{ userId: string|number, requestedModel?: string|null, storedPin?: string|null,
 *   recordedModel?: string|null, cliVersion?: string|null }} input `cliVersion` is the
 *   version of the dsh entry the launch resolved (dshInstalledVersion); `recordedModel`
 *   the chat's recorded model (readDshSessionRecord)
 * @param {Record<string, Function>} [deps] test seam (enabled, runnable, listServers,
 *   getSecret, resolvePrivate, isVersionProven)
 * @returns {Promise<{ local: LocalEngine, secret: string }|null>}
 * @throws {Error} ENGINE_PROVIDER_UNAVAILABLE
 */
export async function resolveDshLocalEngineOrThrow(input, deps = {}) {
  const requestedModel = dshLocalRequestedModel(input);
  if (input.storedPin && requestedModel === null) {
    throw localEngineUnavailableError({ status: 'unavailable', provider: LOCAL_ENGINE, reason: 'model_not_found' }, DSH_REASON_DETAIL);
  }
  const resolved = await resolveLocalEngine(
    { userId: input.userId, storedPin: input.storedPin, requestedModel, qualifyBareModel: false },
    () => resolveVersionGatedDeps(deps, loadDefaultDeps, input.cliVersion),
    dshLocalModelEligibility,
  );
  if (resolved.status === 'none') return null;
  if (resolved.status !== 'resolved') throw localEngineUnavailableError(resolved, DSH_REASON_DETAIL);
  return { local: resolved.local, secret: resolved.secret };
}
