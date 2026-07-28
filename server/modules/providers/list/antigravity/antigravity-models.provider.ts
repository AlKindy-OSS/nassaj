import { getAntigravityModelCatalog } from '@/modules/providers/list/antigravity/antigravity-catalog.client.js';
import { readAntigravityModelsFromCli } from '@/modules/providers/list/antigravity/antigravity-models-cli.client.js';
import type { IProviderModels } from '@/shared/interfaces.js';
import type {
  ProviderChangeActiveModelInput,
  ProviderCurrentActiveModel,
  ProviderModelsDefinition,
  ProviderSessionActiveModelChange,
} from '@/shared/types.js';
import {
  buildDefaultProviderCurrentActiveModel,
  writeProviderSessionActiveModelChange,
} from '@/shared/utils.js';

/**
 * Antigravity (agy CLI) model catalog.
 *
 * agy is a Google AI CLI built on top of Gemini. In non-interactive print
 * mode (`agy -p`) the CLI does NOT accept a model override flag — the active
 * model is chosen inside agy's own interactive settings and persisted there.
 *
 * The options below are exposed for UI parity and display only; selecting one
 * records the user's intended model and is forwarded to the backend, but the
 * agy CLI ignores it until/unless a model flag is added upstream. Keep "auto"
 * first so it remains the default "use agy's own setting" choice.
 *
 * NOTE (upstream sync v1.33): these values were preserved from the fork's
 * former `shared/modelConstants.js` (ANTIGRAVITY_MODELS) when upstream #762
 * migrated the model catalogs into the per-provider provider-models layer and
 * deleted that file. They now serve as the graceful fallback used by
 * {@link AntigravityProviderModels.getSupportedModels} whenever the live agy
 * catalog (see antigravity-catalog.client.ts) cannot be fetched.
 */
export const ANTIGRAVITY_FALLBACK_MODELS: ProviderModelsDefinition = {
  OPTIONS: [
    { value: 'auto', label: 'agy default' },
    { value: 'gemini-3.5-pro', label: 'Gemini 3.5 Pro' },
    { value: 'gemini-3.5-flash', label: 'Gemini 3.5 Flash' },
    { value: 'gemini-3-pro', label: 'Gemini 3 Pro' },
    { value: 'gemini-3-flash', label: 'Gemini 3 Flash' },
    { value: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro' },
    { value: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash' },
  ],
  DEFAULT: 'auto',
};

export class AntigravityProviderModels implements IProviderModels {
  /**
   * Resolves the Antigravity model catalog, most-authoritative source first:
   *   1. the local `agy models` command (T-875) — the exact labels agy's
   *      `--model` accepts, with no network or token dependency;
   *   2. the live Google CloudCode catalog (antigravity-catalog.client.ts);
   *   3. the preserved {@link ANTIGRAVITY_FALLBACK_MODELS} flagged degraded.
   *
   * Each layer degrades gracefully to the next and never throws. The
   * provider-models service caches a live/CLI catalog for the normal multi-day
   * TTL and a degraded fallback only briefly, so the authoritative source
   * recovers soon and the subprocess runs rarely (never on the chat hot path).
   */
  async getSupportedModels(): Promise<ProviderModelsDefinition> {
    const cliCatalog = await readAntigravityModelsFromCli();
    if (cliCatalog) {
      return cliCatalog;
    }
    return getAntigravityModelCatalog();
  }

  async getCurrentActiveModel(): Promise<ProviderCurrentActiveModel> {
    return buildDefaultProviderCurrentActiveModel(ANTIGRAVITY_FALLBACK_MODELS);
  }

  async changeActiveModel(
    input: ProviderChangeActiveModelInput,
  ): Promise<ProviderSessionActiveModelChange> {
    return writeProviderSessionActiveModelChange('antigravity', input);
  }
}
