import { appConfigDb, localModelServersDb } from '../../modules/database/index.js';

import { resolveCredentialPrincipal } from './credential-principal.js';
import { getNamespacedSecret } from './provider-secrets-store.js';

export const LOCAL_MODEL_PROVIDER_PREFIX = 'nassaj_local_';
/** Default-off consent gate; no request may enable it implicitly. */
export function localModelsEnabled() {
  return appConfigDb.get('local_models.enabled') === 'true'
    && appConfigDb.get('local_models.consent_version') === '1';
}
/**
 * Caller-owned servers only, read fresh on every invocation and never from generated
 * files. B-1268: no union with the credential granter — sharing a granter's server
 * (and its key) with a grantee waits for T-1807, because B-1243 lets a grantee's agent
 * read anything materialized into its own config.
 */
export function authorizedLocalModelServers(callerId) {
  const id = Number(callerId);
  if (!Number.isSafeInteger(id) || id <= 0 || !localModelsEnabled()) return [];
  return localModelServersDb.list(id, 100, 0);
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
      ...(model.contextWindow ? { limit: { context: model.contextWindow, output: model.maxOutput ?? Math.min(8192, model.contextWindow) } } : {}),
    }])),
  }]));
}
/**
 * Omits the API key entirely for unauthenticated local endpoints, and refuses to
 * materialize a key that is not the caller's own (B-1268 defence in depth: the row
 * scope above already excludes other owners).
 */
function localKeyOption(server, callerId) {
  if (Number(server.ownerId) !== Number(callerId)) return {};
  const apiKey = getNamespacedSecret(server.ownerId, 'local-model', server.id);
  return apiKey ? { apiKey } : {};
}
/** Sharing remains blocked by B-1243 until the T-1807 permission work is accepted. */
export function localModelsRunnable(callerId) {
  const id = Number(callerId);
  return Number.isSafeInteger(id) && id > 0 && resolveCredentialPrincipal(id, 'opencode').grantedBy === null;
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
  return typeof model === 'string' && model.startsWith(LOCAL_MODEL_PROVIDER_PREFIX);
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
