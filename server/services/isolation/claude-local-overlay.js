/**
 * claude-local-overlay — the block of the caller's own local model servers shown
 * under the Claude body in the model picker (ADR-227 Decision 10, T-2098 stage 3b).
 *
 * Static checks only: no DNS and no network per request. The model vetting is the
 * spawn's own (claudeLocalModelEligibility), and the server checks are the spawn's
 * own predicates, so a row offered as eligible is a row the spawn's static checks
 * pass (claude-local-overlay.parity.test.ts). The spawn's live address check stays
 * final. Nothing that locates or unlocks a server (address, base URL, key, owner,
 * runtime) is ever part of a row.
 *
 * @typedef {'ok'|'model_id_reserved'|'context_unknown'|'context_too_small'
 *   |'base_url_unsupported'|'tls_name_requires_relay'|'address_untested'} OverlayEligibility
 * @typedef {{ value: string, label: string, contextWindow: number|null,
 *   eligibility: OverlayEligibility }} OverlayModel
 * @typedef {{ serverId: string, providerId: string, label: string,
 *   models: OverlayModel[] }} OverlayServer
 */

import { isLocalModelId } from '../../../shared/localEngine.js';

import {
  claudeLocalModelEligibility,
  isUnusableLocalModelId,
  localServerOrigin,
  requiresTlsRelay,
} from './apply-claude-local-engine-env.js';

/**
 * The spawn's server-level static refusal, or null. `address_untested` is what the
 * spawn reports as `address_changed`: no address was ever vetted for the server.
 * @param {{ baseUrl: string, verifiedAddresses?: unknown }} server
 * @returns {OverlayEligibility|null}
 */
function serverRefusal(server) {
  const origin = localServerOrigin(server.baseUrl);
  if (origin === null) return 'base_url_unsupported';
  if (requiresTlsRelay(origin)) return 'tls_name_requires_relay';
  const verified = Array.isArray(server.verifiedAddresses) ? server.verifiedAddresses : [];
  return verified.length === 0 ? 'address_untested' : null;
}

/**
 * One picker row per usable model. The model refusal wins over the server's, in
 * the spawn's order.
 * @param {{ providerId: string, models: Array<{id: string, name?: string, contextWindow?: unknown}> }} server
 * @param {OverlayEligibility|null} refusal
 * @returns {OverlayModel[]}
 */
function overlayModels(server, refusal) {
  return server.models
    .filter((model) => typeof model?.id === 'string' && model.id !== '' && !isUnusableLocalModelId(model.id))
    .map((model) => {
      const eligibility = claudeLocalModelEligibility(model);
      return {
        value: `${server.providerId}/${model.id}`,
        label: typeof model.name === 'string' && model.name.trim() !== '' ? model.name : model.id,
        contextWindow: Number.isSafeInteger(model.contextWindow) ? model.contextWindow : null,
        eligibility: eligibility === 'ok' && refusal ? refusal : eligibility,
      };
    });
}

/**
 * Builds the overlay rows of already-authorized server rows (the caller's own).
 * @param {Array<object>} servers
 * @returns {OverlayServer[]}
 */
export function claudeLocalOverlayRows(servers) {
  return servers
    .filter((server) => isLocalModelId(server.providerId) && Array.isArray(server.models))
    .map((server) => ({
      serverId: server.id,
      providerId: server.providerId,
      label: server.name,
      models: overlayModels(server, serverRefusal(server)),
    }));
}

/**
 * The overlay for a caller: empty while the Claude local switch is off or the
 * caller is under a credential grant; otherwise the caller's own servers.
 * @param {number} callerId identity from the authenticated session only
 * @param {{ enabled: () => boolean, runnable: (id: number) => boolean,
 *   listServers: (id: number) => Array<object> }} deps
 * @returns {OverlayServer[]}
 */
export function claudeLocalOverlayForCaller(callerId, deps) {
  if (!deps.enabled() || !deps.runnable(callerId)) return [];
  const own = deps.listServers(callerId).filter((server) => Number(server.ownerId) === Number(callerId));
  return claudeLocalOverlayRows(own);
}
