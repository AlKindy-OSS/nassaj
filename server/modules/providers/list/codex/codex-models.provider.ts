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

export const CODEX_FALLBACK_MODELS: ProviderModelsDefinition = {
  OPTIONS: [
    { value: 'gpt-5.5', label: 'gpt-5.5' },
    { value: 'gpt-5.4', label: 'gpt-5.4' },
    { value: 'gpt-5.4-mini', label: 'gpt-5.4-mini' },
    { value: 'gpt-5.3-codex', label: 'gpt-5.3-codex' },
    { value: 'gpt-5.2', label: 'gpt-5.2' },
  ],
  DEFAULT: 'gpt-5.4',
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

const buildCodexModelsDefinition = (models: CodexCachedModel[]): ProviderModelsDefinition => {
  const sortedModels = [...models]
    .filter((model) => model.visibility !== 'hidden' && model.supported_in_api !== false)
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
      const raw = await readFile(path.join(resolveCodexHome(userId), CODEX_MODELS_CACHE_FILE), 'utf8');
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
