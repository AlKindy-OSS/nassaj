import { readFile } from 'node:fs/promises';
import path from 'node:path';

import TOML from '@iarna/toml';

import { resolveProviderEnv } from '@/services/isolation/resolve-provider-env.js';
import type { IProviderModels } from '@/shared/interfaces.js';
import type {
  ProviderChangeActiveModelInput,
  ProviderCurrentActiveModel,
  ProviderModelOption,
  ProviderModelsDefinition,
  ProviderSessionActiveModelChange,
} from '@/shared/types.js';
import {
  buildDefaultProviderCurrentActiveModel,
  readObjectRecord,
  readOptionalString,
  writeProviderSessionActiveModelChange,
} from '@/shared/utils.js';

import { operatorCodexHome } from './codex-home.js';
import { codexModelsRefresher, ownCodexRefreshTarget } from './codex-models-refresh.js';

// Snapshot of the locally installed `codex` CLI's own live catalog
// (~/.codex/models_cache.json, client_version 0.156.0, 2026-09-27), used only
// when reading that file fails (Codex not installed, cache not yet fetched).
// `gpt-reserve` and `codex-auto-review` are omitted: their `visibility` is
// `hide` in the live cache, same filter `buildCodexModelsDefinition` applies.
export const CODEX_FALLBACK_MODELS: ProviderModelsDefinition = {
  OPTIONS: [
    { value: 'gpt-6-astra', label: 'GPT-6-Astra' },
    { value: 'gpt-6-sol', label: 'gpt-6-sol' },
    { value: 'gpt-6-luna', label: 'gpt-6-luna' },
    { value: 'gpt-5.6-sol', label: 'gpt-5.6-sol' },
    { value: 'gpt-5.6-terra', label: 'gpt-5.6-terra' },
    { value: 'gpt-5.6-luna', label: 'gpt-5.6-luna' },
    { value: 'gpt-5.5', label: 'gpt-5.5' },
  ],
  DEFAULT: 'gpt-5.6-sol',
  degraded: true,
};

type CodexCachedModel = {
  slug?: string;
  display_name?: string;
  description?: string;
  priority?: number;
  visibility?: string;
  supported_in_api?: boolean;
};

const CODEX_MODELS_CACHE_FILE = 'models_cache.json';
const CODEX_CONFIG_FILE = 'config.toml';

/**
 * Resolves the Codex home for the given user via the central B-136 resolver
 * (B-152). Isolated → ~/.nassaj-users/<userId>/.codex; shared/anonymous → the
 * operator ~/.codex, so the model catalog reflects THAT user's own cached models
 * and configured default instead of the operator's.
 */
const resolveCodexHome = (userId?: string | number | null): string => {
  const env = resolveProviderEnv(userId ?? null, 'codex', process.env);
  return readOptionalString(env.CODEX_HOME) ?? operatorCodexHome();
};

const isCodexCachedModel = (value: unknown): value is CodexCachedModel => {
  const record = readObjectRecord(value);
  return Boolean(record && readOptionalString(record.slug));
};

const readCodexPriority = (value: unknown): number => (
  typeof value === 'number' && Number.isFinite(value) ? value : Number.MAX_SAFE_INTEGER
);

const mapCodexModel = (model: CodexCachedModel): ProviderModelOption => ({
  value: model.slug as string,
  label: readOptionalString(model.display_name) ?? (model.slug as string),
  description: readOptionalString(model.description),
});

/**
 * Whether a cached Codex model belongs in the picker. The live models_cache.json
 * marks internal models with `visibility: 'hide'` (e.g. gpt-reserve); older
 * shapes used 'hidden', so both are excluded.
 */
export const isListedCodexModel = (model: CodexCachedModel): boolean =>
  model.visibility !== 'hidden' && model.visibility !== 'hide' && model.supported_in_api !== false;

const buildCodexModelsDefinition = (models: CodexCachedModel[]): ProviderModelsDefinition => {
  const sortedModels = [...models]
    .filter(isListedCodexModel)
    .sort((left, right) => readCodexPriority(left.priority) - readCodexPriority(right.priority));

  const options: ProviderModelOption[] = [];
  const seenValues = new Set<string>();

  for (const model of sortedModels) {
    const mappedModel = mapCodexModel(model);
    if (seenValues.has(mappedModel.value)) {
      continue;
    }

    seenValues.add(mappedModel.value);
    options.push(mappedModel);
  }

  if (options.length === 0) {
    return CODEX_FALLBACK_MODELS;
  }

  return {
    OPTIONS: options,
    DEFAULT: options[0]?.value ?? CODEX_FALLBACK_MODELS.DEFAULT,
  };
};

export class CodexProviderModels implements IProviderModels {
  /**
   * Reads the user's cached Codex model catalog. `userId` is resolved through the
   * central B-136 resolver so an isolated user's OWN models_cache.json is read
   * (B-152); omitted/null (system/anon/platform) reads the operator ~/.codex —
   * unchanged from the single-user behavior.
   */
  async getSupportedModels(userId?: string | number | null): Promise<ProviderModelsDefinition> {
    try {
      const env = resolveProviderEnv(userId ?? null, 'codex', process.env);
      const codexHome = readOptionalString(env.CODEX_HOME) ?? operatorCodexHome();
      // Only a real user whose resolved home is their OWN isolated CODEX_HOME
      // triggers a refresh (same env for spawn); granted/shared/anonymous reads stay read-only.
      const target = ownCodexRefreshTarget(userId, env);
      if (target && userId !== null && userId !== undefined) {
        await codexModelsRefresher.ensureFresh(userId, target);
      }
      const raw = await readFile(path.join(codexHome, CODEX_MODELS_CACHE_FILE), 'utf8');
      const parsed = readObjectRecord(JSON.parse(raw));
      const models = Array.isArray(parsed?.models)
        ? parsed.models.filter(isCodexCachedModel)
        : [];

      return buildCodexModelsDefinition(models);
    } catch {
      return CODEX_FALLBACK_MODELS;
    }
  }

  async getCurrentActiveModel(): Promise<ProviderCurrentActiveModel> {
    try {
      // No userId is carried on the active-model interface, so this reads the
      // operator config.toml (safe fallback, unchanged pre-B-152 behavior). The
      // per-user config is honored on getSupportedModels, which the picker uses.
      const raw = await readFile(path.join(resolveCodexHome(null), CODEX_CONFIG_FILE), 'utf8');
      const parsed = readObjectRecord(TOML.parse(raw));
      const model = readOptionalString(parsed?.model);
      if (!model) {
        return buildDefaultProviderCurrentActiveModel(await this.getSupportedModels());
      }

      return {
        model,
      };
    } catch {
      return buildDefaultProviderCurrentActiveModel(await this.getSupportedModels());
    }
  }

  async changeActiveModel(
    input: ProviderChangeActiveModelInput,
  ): Promise<ProviderSessionActiveModelChange> {
    return writeProviderSessionActiveModelChange('codex', input);
  }
}
