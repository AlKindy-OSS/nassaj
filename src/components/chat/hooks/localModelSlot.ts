/**
 * localModelSlot.ts — T-2107 stage 5 / T-2108: who governs the `codex-model` and
 * `dsh-model` storage slots.
 *
 * A new Codex or DeepSeek Harness chat on a local server is chosen by its local
 * model id alone (`nassaj_local_<hex>/<model>`). No shipped or live catalog of
 * those bodies lists such an id — the overlay route is its only source — so the
 * boot sanitizer and the catalog reconcile must leave it alone, exactly as the
 * Claude slot does on the local engine (claudeModelSlot.ts). The spawn vets it.
 */
import { sanitizeStoredModel } from '../../../constants/providerModelFallbacks';
import type { ProviderModelsDefinition } from '../../../types/app';
import { isLocalModelId } from '../../../../shared/localEngine';

/** The bodies whose model slot may hold a local model id with no engine stamp. */
export type LocalSlotBody = 'codex' | 'dsh';

/** A stored slot value: a local model id as is, anything else against the body catalog. */
export function sanitizeLocalSlotModel(body: LocalSlotBody, raw: string | null): string {
  return isLocalModelId(raw) ? raw : sanitizeStoredModel(body, raw);
}

/** The catalog that reconciles the slot: none for a local model id. */
export function localSlotCatalog(
  model: string,
  catalog: ProviderModelsDefinition | undefined,
): ProviderModelsDefinition | undefined {
  return isLocalModelId(model) ? undefined : catalog;
}
