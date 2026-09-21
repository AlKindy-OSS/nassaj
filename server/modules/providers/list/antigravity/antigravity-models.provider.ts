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
 * agy is a Google AI CLI built on top of Gemini. It DOES accept `--model` in
 * non-interactive print mode: measured against agy 1.1.9 on 2026-08-01,
 * `agy --model gemini-3.6-flash-low -p ...` logs
 * `model_config_manager.go: Propagating selected model override to backend:
 * label="Gemini 3.6 Flash (Low)"` and answers on that model. So the picker in
 * this UI is authoritative; `auto` stays first and means "omit --model and let
 * agy use its own persisted setting".
 *
 * The options below are only the graceful fallback used by
 * {@link AntigravityProviderModels.getSupportedModels} when neither the local
 * `agy models` subcommand (antigravity-models-cli.client.ts, the authoritative
 * source) nor the live CloudCode catalog (antigravity-catalog.client.ts) can be
 * read. They are a snapshot of `agy models` output taken on 2026-08-01, so the
 * degraded picker still offers identifiers `--model` actually accepts; re-snap
 * them (here AND in src/constants/providerModelFallbacks.ts) when agy ships a
 * new model set.
 */
export const ANTIGRAVITY_FALLBACK_MODELS: ProviderModelsDefinition = {
  OPTIONS: [
    { value: 'auto', label: 'agy default' },
    { value: 'gemini-3.6-flash-high', label: 'gemini-3.6-flash-high' },
    { value: 'gemini-3.6-flash-medium', label: 'gemini-3.6-flash-medium' },
    { value: 'gemini-3.6-flash-low', label: 'gemini-3.6-flash-low' },
    { value: 'gemini-3.5-flash-high', label: 'gemini-3.5-flash-high' },
    { value: 'gemini-3.5-flash-medium', label: 'gemini-3.5-flash-medium' },
    { value: 'gemini-3.5-flash-low', label: 'gemini-3.5-flash-low' },
    { value: 'gemini-3.1-pro-high', label: 'gemini-3.1-pro-high' },
    { value: 'gemini-3.1-pro-low', label: 'gemini-3.1-pro-low' },
    { value: 'claude-sonnet-4-6', label: 'claude-sonnet-4-6' },
    { value: 'claude-opus-4-6-thinking', label: 'claude-opus-4-6-thinking' },
    { value: 'gpt-oss-120b-medium', label: 'gpt-oss-120b-medium' },
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
