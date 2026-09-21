/**
 * provider-anthropic-endpoints — the Anthropic-compatible base URLs for the
 * "Claude engine on a vendor endpoint" path (ADR-037).
 *
 * Distinct from the hosted-vendor RUN seam (kimi/deepseek/glm independent HTTP
 * clients, ADR-036): here the Claude Agent SDK itself is pointed at a vendor's
 * Anthropic-compatible endpoint by setting ANTHROPIC_BASE_URL + ANTHROPIC_AUTH_TOKEN
 * on the spawn env. That is the OPPOSITE of the iron rule's default posture, so it
 * is only ever done for an explicit, per-user-keyed engine provider and is fenced
 * by anthropic-base-url-guard.js.
 *
 * The endpoint table itself now lives in `shared/engineProviders.ts` — the one
 * declaration compiled into BOTH bundles — so the client's engine surface and the
 * server's injection seam can never disagree about which engines exist or which
 * host each one means (B-218 was exactly such a drift). This module stays the
 * server-side face of that data plus the official-host constant the guard needs.
 *
 * TWO SETS, DELIBERATELY DIFFERENT (do not merge them):
 *   • ENGINE_PROVIDERS          — every engine that HAS an Anthropic-compatible
 *                                 endpoint. Membership means "this id names a
 *                                 known endpoint", nothing more. The
 *                                 vendor-delegate MCP gates on this.
 *   • ELIGIBLE_ENGINE_PROVIDERS — engines that may actually DRIVE the Claude
 *                                 body today. This is what the injection seam
 *                                 gates on; anything outside it is refused
 *                                 loudly, never downgraded to official Anthropic.
 *
 * @typedef {import('../../../shared/engineProviders.js').EngineProviderId} EngineProvider
 */

import {
  ELIGIBLE_ENGINE_PROVIDERS as SHARED_ELIGIBLE_ENGINE_PROVIDERS,
  ENGINE_ANTHROPIC_ENDPOINT,
  ENGINE_PROVIDER_IDS,
} from '../../../shared/engineProviders.js';

/**
 * Maps each engine provider to its Anthropic-compatible base URL. The Claude
 * Agent SDK reads ANTHROPIC_BASE_URL to choose the endpoint; these are the only
 * non-official hosts the guard will accept when the provider is engaged.
 * @type {Readonly<Record<EngineProvider, string>>}
 */
export const PROVIDER_ANTHROPIC_ENDPOINT = ENGINE_ANTHROPIC_ENDPOINT;

/**
 * Provider ids that have an Anthropic-compatible endpoint. NOT an eligibility
 * list — see ELIGIBLE_ENGINE_PROVIDERS below.
 * @type {ReadonlySet<string>}
 */
export const ENGINE_PROVIDERS = new Set(ENGINE_PROVIDER_IDS);

/**
 * Provider ids that may drive the Claude engine for a run right now (ADR-073).
 * Sourced from the shared declaration so the picker, the session stamp and this
 * seam agree by construction.
 * @type {ReadonlySet<string>}
 */
export const ELIGIBLE_ENGINE_PROVIDERS = new Set(SHARED_ELIGIBLE_ENGINE_PROVIDERS);

/**
 * The hostnames that are always allowed for any *_BASE_URL: the official
 * Anthropic API. Any other host must be explicitly justified (an engaged engine
 * provider, a Bedrock/Vertex escape hatch, or the operator allow-list) or the
 * guard rejects it fail-closed.
 * @type {ReadonlySet<string>}
 */
export const OFFICIAL_ANTHROPIC_HOSTS = new Set(['api.anthropic.com']);
