/**
 * claudeModelSlot.ts — B-235: who governs the `claude-model` storage slot.
 *
 * `claude-model` does not always hold a Claude model id. On the engine axis
 * (ADR-037 / ADR-073) the body stays Claude Code while the model id belongs to
 * the engine that will actually answer — `glm-5.2` on z.ai, a Moonshot id on
 * Kimi. One slot, two possible vocabularies, chosen by whether an engine is
 * engaged.
 *
 * Every place that validates or normalizes that slot must ask this function
 * which catalog it is validating against. Skipping it is not a style slip: the
 * boot sanitizer and the reconcile effect both validated against the Claude
 * catalog unconditionally, so the vendor id the user had just picked failed the
 * check and was overwritten with the Claude default — in the same render as the
 * selection. The engine stamp survived and the model did not, so the run left as
 * "engine = GLM, model = a Claude id", the picker's check mark never matched its
 * own selection, and the chat claimed an engine it was not asking a model of.
 */
import {
  sanitizeStoredModel,
  type FallbackCatalogProvider,
} from '../../../constants/providerModelFallbacks';
import { LOCAL_ENGINE, isLocalModelId } from '../../../../shared/localEngine';

import type { EngineProvider } from './engineProviderSession';

/**
 * The provider whose model catalog governs the `claude-model` slot right now.
 *
 * @param engineProvider the engaged engine, or null on the official Claude path.
 * @returns the engine id while one is engaged, `'claude'` otherwise.
 */
export function claudeSlotCatalogProvider(engineProvider: EngineProvider): FallbackCatalogProvider | null {
  // ADR-227: a local server's models live in no shipped catalog — the overlay
  // route is their only source — so no catalog governs the slot (null).
  if (engineProvider === LOCAL_ENGINE) return null;
  return engineProvider ?? 'claude';
}

/**
 * Sanitizes a stored `claude-model` value for the engaged engine. On the local
 * engine (ADR-227) a local model id is kept as is (the spawn vets it); anything
 * else falls back to the Claude catalog, exactly like the official path.
 */
export function sanitizeClaudeSlotModel(engineProvider: EngineProvider, raw: string | null): string {
  const catalog = claudeSlotCatalogProvider(engineProvider);
  if (catalog === null) return isLocalModelId(raw) ? raw : sanitizeStoredModel('claude', raw);
  return sanitizeStoredModel(catalog, raw);
}
