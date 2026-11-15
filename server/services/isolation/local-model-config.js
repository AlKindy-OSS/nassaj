import { appConfigDb, localModelServersDb } from '../../modules/database/index.js';

import { resolveCredentialPrincipal } from './credential-principal.js';
import { LOCAL_MODEL_PROVIDER_PREFIX, isLocalModelId } from './local-engine-pin.js';
import { getLocalModelSecret } from './provider-secrets-store.js';

export { LOCAL_MODEL_PROVIDER_PREFIX };
/** Default-off consent gate; no request may enable it implicitly. */
export function localModelsEnabled() {
  return appConfigDb.get('local_models.enabled') === 'true'
    && appConfigDb.get('local_models.consent_version') === '1';
}
/**
 * ADR-227 / T-2098: the Claude body on a local server has its OWN switch, off unless
 * `local_models.claude_enabled` is exactly 'true', and only under the master local
 * models consent above. Enabling OpenCode local models never enables it.
 * @returns {boolean}
 */
export function claudeLocalEngineEnabled() {
  return localModelsEnabled() && appConfigDb.get('local_models.claude_enabled') === 'true';
}
/**
 * ADR-227 extension / T-2107: the Codex body on a local server has its OWN switch,
 * `local_models.codex_enabled`, off unless exactly 'true', under the same master
 * consent. Neither the OpenCode nor the Claude local switch enables it.
 * @returns {boolean}
 */
export function codexLocalEngineEnabled() {
  return localModelsEnabled() && appConfigDb.get('local_models.codex_enabled') === 'true';
}
/**
 * ADR-227 "DSH local corrector" / T-2108: the DSH body on a local server has its OWN
 * switch, `local_models.dsh_enabled`, off unless exactly 'true', under the same
 * master consent. No other local switch enables it.
 * @returns {boolean}
 */
export function dshLocalEngineEnabled() {
  return localModelsEnabled() && appConfigDb.get('local_models.dsh_enabled') === 'true';
}
const LIST_PAGE_SIZE = 100;
/**
 * Caller-owned servers only, read fresh on every invocation and never from generated
 * files. B-1268: no union with the credential granter — sharing a granter's server
 * (and its key) with a grantee waits for T-1807, because B-1243 lets a grantee's agent
 * read anything materialized into its own config.
 */
export function authorizedLocalModelServers(callerId) {
  const id = Number(callerId);
  if (!Number.isSafeInteger(id) || id <= 0 || !localModelsEnabled()) return [];
  // T-2098 qa item 8: page through every row; a spawn that saw only the first page
  // refused a later server as `server_not_found`.
  const servers = [];
  for (let offset = 0; ; offset += LIST_PAGE_SIZE) {
    const page = localModelServersDb.list(id, LIST_PAGE_SIZE, offset);
    servers.push(...page);
    if (page.length < LIST_PAGE_SIZE) return servers;
  }
}
/**
 * Generated provider definitions; keys stay out of auth.json and DTOs. Only ids inside
 * the reserved namespace are emitted, so a stored row can never shadow `glm` or any
 * built-in provider block (ADR-163 §4).
 */
export function localModelProviderBlocks(callerId) {
  return Object.fromEntries(authorizedLocalModelServers(callerId).filter(server => isLocalModel(server.providerId)).map(server => [server.providerId, {
    npm: '@ai-sdk/openai-compatible', name: server.name,
    options: { baseURL: server.baseUrl, ...localKeyOption(server, callerId) },
    models: Object.fromEntries(server.models.map(model => [model.id, {
      name: model.name ?? model.id,
      ...(model.contextWindow ? { limit: { context: model.contextWindow, output: model.maxOutput ?? defaultLocalOutputLimit(model.contextWindow) } } : {}),
    }])),
  }]));
}
/**
 * B-1755: output reservation when the owner set none. A quarter of the window, capped
 * at 8192, so a small window is not consumed by the reply budget alone.
 * @param {number} contextWindow
 * @returns {number}
 */
function defaultLocalOutputLimit(contextWindow) {
  return Math.max(1, Math.min(8192, Math.floor(contextWindow / 4)));
}
/** B-1755: refusal code when a launch's fixed base prompt does not fit the window. */
export const LOCAL_MODEL_CONTEXT_EXCEEDED = 'LOCAL_MODEL_CONTEXT_EXCEEDED';
/**
 * B-1755: rough token estimate for prompt text (about four characters per token).
 * @param {string} text
 * @returns {number}
 */
export function estimatePromptTokens(text) {
  return Math.ceil(String(text ?? '').length / 4);
}
/**
 * B-1755: the stored context window of a caller-owned local model, or null when the
 * model is not local, not authorized for the caller, or its window is unknown.
 * @param {string|number|null|undefined} callerId
 * @param {string} model full `<providerId>/<modelId>` id
 * @returns {number|null}
 */
export function localModelContextWindow(callerId, model) {
  if (!isLocalModel(model)) return null;
  for (const server of authorizedLocalModelServers(callerId)) {
    const option = server.models.find(entry => `${server.providerId}/${entry.id}` === model);
    if (option) return Number.isSafeInteger(option.contextWindow) && option.contextWindow > 0 ? option.contextWindow : null;
  }
  return null;
}
/** I8: the least reply room counted for a local turn (the plan's per-model output). */
export const LOCAL_OUTPUT_RESERVE_TOKENS = 4096;
/** I8: the least room a fresh local turn must keep for tool output and replies. */
export const LOCAL_MIN_WORKING_MARGIN_TOKENS = 4096;

/**
 * I8: reply room a local model reserves — the output limit written into opencode.json
 * (declared maxOutput, else the generated default), never below
 * LOCAL_OUTPUT_RESERVE_TOKENS. An unknown model counts the floor.
 * @param {string|number|null|undefined} callerId
 * @param {string} model full `<providerId>/<modelId>` id
 * @returns {number}
 */
export function localModelOutputReserve(callerId, model) {
  if (!isLocalModel(model)) return LOCAL_OUTPUT_RESERVE_TOKENS;
  for (const server of authorizedLocalModelServers(callerId)) {
    const option = server.models.find(entry => `${server.providerId}/${entry.id}` === model);
    if (!option) continue;
    const window = Number.isSafeInteger(option.contextWindow) && option.contextWindow > 0 ? option.contextWindow : null;
    const output = option.maxOutput ?? (window ? defaultLocalOutputLimit(window) : 0);
    return Math.max(LOCAL_OUTPUT_RESERVE_TOKENS, Number(output) || 0);
  }
  return LOCAL_OUTPUT_RESERVE_TOKENS;
}

/**
 * B-1755 / I8 pre-launch guard. Refuses when
 *  - `base`: the fixed base prompt plus the reply reserve and the working margin
 *    reach the window (with no reserve/margin given: the base alone, as B-1755);
 *  - `history`: a resumed session's stored fill plus the reply reserve reaches it.
 * An unknown window passes (ADR-223: no window, no refusal); an unknown fill skips
 * the history check.
 * @param {{ contextWindow: number|null|undefined, basePromptTokens: number,
 *   outputReserveTokens?: number, marginTokens?: number, storedFillTokens?: number|null }} input
 * @returns {null | { code: string, reason: 'base'|'history', contextWindow: number,
 *   basePromptTokens: number, outputReserveTokens: number, marginTokens: number,
 *   storedFillTokens: number|null }} null to proceed, otherwise the refusal
 */
export function checkLocalModelContextFit(input) {
  const { contextWindow, basePromptTokens, outputReserveTokens = 0, marginTokens = 0 } = input;
  if (!Number.isSafeInteger(contextWindow) || contextWindow <= 0) return null;
  const storedFillTokens = Number.isFinite(input.storedFillTokens) && input.storedFillTokens > 0
    ? input.storedFillTokens : null;
  const refusal = (reason) => ({
    code: LOCAL_MODEL_CONTEXT_EXCEEDED, reason, contextWindow, basePromptTokens,
    outputReserveTokens, marginTokens, storedFillTokens,
  });
  if (basePromptTokens + outputReserveTokens + marginTokens >= contextWindow) return refusal('base');
  if (storedFillTokens !== null && storedFillTokens + outputReserveTokens >= contextWindow) return refusal('history');
  return null;
}
/**
 * Omits the API key entirely for unauthenticated local endpoints, and refuses to
 * materialize a key that is not the caller's own (B-1268 defence in depth: the row
 * scope above already excludes other owners).
 */
function localKeyOption(server, callerId) {
  if (Number(server.ownerId) !== Number(callerId)) return {};
  const apiKey = getLocalModelSecret(server.ownerId, server.id);
  return apiKey ? { apiKey } : {};
}
/** Sharing remains blocked by B-1243 until the T-1807 permission work is accepted. */
export function localModelsRunnable(callerId) {
  const id = Number(callerId);
  return Number.isSafeInteger(id) && id > 0 && resolveCredentialPrincipal(id, 'opencode').grantedBy === null;
}
/**
 * T-2098 stage 3b: the Claude body may use the caller's local servers only on the
 * caller's OWN Claude credential (no grant), as for OpenCode. One definition for the
 * spawn and the picker overlay.
 * @param {string|number|null|undefined} callerId
 * @returns {boolean}
 */
export function claudeLocalModelsRunnable(callerId) {
  return localModelsRunnable(callerId) && resolveCredentialPrincipal(Number(callerId), 'claude').grantedBy === null;
}
/**
 * T-2107: the Codex body may use the caller's local servers only on the caller's
 * OWN Codex tree (no grant), as for the Claude body.
 * @param {string|number|null|undefined} callerId
 * @returns {boolean}
 */
export function codexLocalModelsRunnable(callerId) {
  return localModelsRunnable(callerId) && resolveCredentialPrincipal(Number(callerId), 'codex').grantedBy === null;
}
/**
 * T-2108: the DSH body never honours a credential grant (it runs on the member's
 * own tree), so it may use the caller's local servers under the shared rule only.
 * @param {string|number|null|undefined} callerId
 * @returns {boolean}
 */
export function dshLocalModelsRunnable(callerId) {
  return localModelsRunnable(callerId);
}
/**
 * True ONLY when the activated feature leaves this caller with a local server they may
 * actually run. Every local-aware branch outside the local role itself is gated on this
 * so an untouched deployment keeps its previous behaviour exactly (B-1268).
 *
 * @param {string|number|null|undefined} callerId
 * @returns {boolean}
 */
export function hasRunnableLocalServers(callerId) {
  return localModelsRunnable(callerId) && authorizedLocalModelServers(callerId).length > 0;
}
/** Recognizes the reserved server namespace, even when activation has been revoked. */
export function isLocalModel(model) {
  return isLocalModelId(model);
}
/** ADR-088: absent/deleted/revoked local endpoints fail without fallback. */
export function assertLocalModelAvailable(callerId, model) {
  if (!isLocalModel(model)) return;
  const allowed = localModelsRunnable(callerId) && authorizedLocalModelServers(callerId).some(server =>
    server.models.some(option => `${server.providerId}/${option.id}` === model));
  if (!allowed) {
    const error = new Error('خادم النموذج المحلي غير متاح. راجع إعدادات الخادم وصلاحية الوصول.');
    error.code = 'ENGINE_PROVIDER_UNAVAILABLE';
    throw error;
  }
}
