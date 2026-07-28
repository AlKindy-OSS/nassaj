import { spawn } from 'node:child_process';

import Database from 'better-sqlite3';
import crossSpawn from 'cross-spawn';

import { GLM_CARRIER_MODELS } from '@/modules/providers/shared/vendor/vendor-config.js';
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
  getOpenCodeDatabasePath,
  readObjectRecord,
  readOptionalString,
  resolveOpenCodeBinaryPath,
  writeProviderSessionActiveModelChange,
} from '@/shared/utils.js';

export const OPENCODE_FALLBACK_MODELS: ProviderModelsDefinition = {
  OPTIONS: [
    {
      value: 'anthropic/claude-sonnet-4-5',
      label: 'Claude Sonnet 4.5',
      description: 'anthropic - anthropic/claude-sonnet-4-5',
    },
    {
      value: 'anthropic/claude-opus-4-1',
      label: 'Claude Opus 4.1',
      description: 'anthropic - anthropic/claude-opus-4-1',
    },
    {
      value: 'anthropic/claude-haiku-4-5',
      label: 'Claude Haiku 4.5',
      description: 'anthropic - anthropic/claude-haiku-4-5',
    },
    {
      value: 'openai/gpt-5.1',
      label: 'GPT-5.1',
      description: 'openai - openai/gpt-5.1',
    },
    {
      value: 'openai/gpt-5.1-codex',
      label: 'GPT-5.1 Codex',
      description: 'openai - openai/gpt-5.1-codex',
    },
    {
      value: 'openai/gpt-5.4-mini',
      label: 'GPT-5.4 Mini',
      description: 'openai - openai/gpt-5.4-mini',
    },
    {
      value: 'google/gemini-2.5-pro',
      label: 'Gemini 2.5 Pro',
      description: 'google - google/gemini-2.5-pro',
    },
    {
      value: 'google/gemini-2.5-flash',
      label: 'Gemini 2.5 Flash',
      description: 'google - google/gemini-2.5-flash',
    },
  ],
  DEFAULT: 'anthropic/claude-sonnet-4-5',
};

/**
 * GL-9 (ADR-062): the opencode provider id under which GLM runs as a carrier. Model
 * ids surface in opencode's `provider/model` shape, so a GLM carrier model reads as
 * `glm/<modelId>` — never `anthropic/*` (the built-in it must not collide with, OCC-2).
 */
export const OPENCODE_CARRIER_PROVIDER_ID = 'glm';

/**
 * GL-9: pure reader for the GLM OpenCode carrier fleet flag. Mirrors the byte-for-byte
 * normalization of the single source of truth (server/opencode-cli.js
 * isOpenCodeCarrierEnabled), duplicated here because this read-side provider stays
 * decoupled from the launcher. Default OFF: an unset/blank/non-truthy flag NEVER exposes
 * the carrier models, so with the flag off getSupportedModels is byte-for-byte the
 * pre-GL-9 catalog.
 */
export const isOpenCodeCarrierEnabled = (env: NodeJS.ProcessEnv = process.env): boolean => {
  const raw = env?.NASSAJ_OPENCODE_CARRIER;
  if (typeof raw !== 'string') {
    return false;
  }
  const normalized = raw.trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
};

/**
 * GL-9: the GLM carrier model catalog shaped as opencode `provider/model` options,
 * derived from the ONE source of truth (GLM_CARRIER_MODELS in vendor-config, itself
 * derived from the chat-path GLM_FALLBACK_MODELS). Each entry becomes `glm/<id>` so the
 * carrier models enumerate alongside opencode's own models without ever masquerading as
 * an Anthropic model. Descriptions follow the same `<provider> - <id>` shape the rest of
 * this provider emits.
 */
export const buildGlmCarrierModelOptions = (): ProviderModelOption[] => (
  Object.entries(GLM_CARRIER_MODELS).map(([modelId, { name }]) => {
    const value = `${OPENCODE_CARRIER_PROVIDER_ID}/${modelId}`;
    return {
      value,
      label: name,
      description: `${OPENCODE_CARRIER_PROVIDER_ID} - ${value}`,
    };
  })
);

/**
 * GL-9: merges the GLM carrier catalog into a resolved opencode model definition WHEN
 * the carrier flag is on. Existing options win on a value collision (opencode's live
 * catalog is authoritative for any id it already lists), and carrier models are appended
 * after them so the default selection is never disturbed. Flag OFF ⇒ the input definition
 * is returned untouched (backward-compatible identity).
 */
export const withGlmCarrierModels = (
  definition: ProviderModelsDefinition,
  env: NodeJS.ProcessEnv = process.env,
): ProviderModelsDefinition => {
  if (!isOpenCodeCarrierEnabled(env)) {
    return definition;
  }

  const existingValues = new Set(definition.OPTIONS.map((option) => option.value));
  const carrierOptions = buildGlmCarrierModelOptions().filter(
    (option) => !existingValues.has(option.value),
  );
  if (carrierOptions.length === 0) {
    return definition;
  }

  return {
    // B-219: the merge is exactly where a cross-provider label collision is born (a
    // carrier `glm/<id>` landing beside opencode's own `opencode/<id>`), so uniqueness
    // is re-established over the COMBINED list, never over either half alone.
    OPTIONS: disambiguateModelLabels([...definition.OPTIONS, ...carrierOptions]),
    DEFAULT: definition.DEFAULT,
  };
};

const OPEN_CODE_MODELS_TIMEOUT_MS = 20_000;
/**
 * A `provider/model` line from `opencode models`, optionally carrying a
 * bracketed variant suffix — opencode's own notation for a context/tier
 * variant (`glm/glm-5.2[1m]`, `anthropic/claude-opus-4-5[1m]`). The brackets
 * were previously unmatched, so every `[…]` variant was silently dropped from
 * the LIVE catalog and could only ever surface from a pinned fallback list.
 */
const MODEL_ID_LINE = /^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*(?:\[[a-z0-9._-]+\])?$/i;
/** Trailing `[variant]` suffix on a model slug, captured without its brackets. */
const BRACKET_VARIANT_SUFFIX = /\[([a-z0-9._-]+)\]$/i;
const spawnFunction = process.platform === 'win32' ? crossSpawn : spawn;
const DATE_TOKEN = /^\d{8}$/;
const SIMPLE_NUMBER_TOKEN = /^\d$/;
const VERSION_TOKEN = /^[a-z]\d+$/i;
const NUMERIC_TOKEN = /^\d+(?:\.\d+)*$/;
const SHORT_ACRONYM_TOKEN = /^[a-z]{2,3}$/;

export const parseOpenCodeModelsStdout = (stdout: string): string[] => {
  const ids: string[] = [];

  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('{') || line.startsWith('[')) {
      continue;
    }

    if (MODEL_ID_LINE.test(line)) {
      ids.push(line);
    }
  }

  return [...new Set(ids)];
};

const formatDateToken = (token: string): string => (
  `${token.slice(0, 4)}-${token.slice(4, 6)}-${token.slice(6, 8)}`
);

const formatModelToken = (token: string, nextToken?: string): string => {
  const lower = token.toLowerCase();

  if (VERSION_TOKEN.test(token)) {
    return token.toUpperCase();
  }

  if (SHORT_ACRONYM_TOKEN.test(lower) && nextToken && NUMERIC_TOKEN.test(nextToken)) {
    return token.toUpperCase();
  }

  return lower.charAt(0).toUpperCase() + lower.slice(1);
};

const formatOpenCodeModelSlug = (slug: string): string => {
  const labelParts: string[] = [];
  const dateParts: string[] = [];
  // Peel the bracketed variant off before tokenizing: '-' splitting would
  // otherwise weld it onto the last token ('5.2[1m]') and defeat both the
  // acronym rule ('glm' → GLM) and the version formatting.
  const variantMatch = slug.match(BRACKET_VARIANT_SUFFIX);
  const variant = variantMatch?.[1] ?? null;
  const baseSlug = variantMatch ? slug.slice(0, variantMatch.index) : slug;
  const tokens = baseSlug.split('-').filter(Boolean);

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    const nextToken = tokens[index + 1];

    if (DATE_TOKEN.test(token)) {
      dateParts.push(formatDateToken(token));
      continue;
    }

    if (SIMPLE_NUMBER_TOKEN.test(token) && nextToken && SIMPLE_NUMBER_TOKEN.test(nextToken)) {
      labelParts.push(`${token}.${nextToken}`);
      index += 1;
      continue;
    }

    labelParts.push(formatModelToken(token, nextToken));
  }

  const label = (labelParts.join(' ').trim() || baseSlug || slug).replace(/^GPT\s+/, 'GPT-');
  const dated = dateParts.length === 0 ? label : `${label} (${dateParts.join(', ')})`;

  return variant ? `${dated} (${variant.toUpperCase()})` : dated;
};

const readOpenCodeModelParts = (id: string): { upstreamProvider: string; slug: string } => {
  const separatorIndex = id.indexOf('/');
  if (separatorIndex < 0) {
    return {
      upstreamProvider: '',
      slug: id,
    };
  }

  return {
    upstreamProvider: id.slice(0, separatorIndex),
    slug: id.slice(separatorIndex + 1),
  };
};

const labelForOpenCodeModelId = (id: string): string => {
  const fallbackLabel = OPENCODE_FALLBACK_MODELS.OPTIONS.find((option) => option.value === id)?.label;
  if (fallbackLabel) {
    return fallbackLabel;
  }

  const { slug } = readOpenCodeModelParts(id);
  return formatOpenCodeModelSlug(slug);
};

const descriptionForOpenCodeModelId = (id: string): string => {
  const { upstreamProvider } = readOpenCodeModelParts(id);
  return upstreamProvider ? `${upstreamProvider} - ${id}` : id;
};

/** Appends the upstream provider segment to a label: `GLM 5.2` → `GLM 5.2 (glm)`. */
const qualifyLabelWithProvider = (option: ProviderModelOption): string => {
  const { upstreamProvider } = readOpenCodeModelParts(option.value);
  return upstreamProvider ? `${option.label} (${upstreamProvider})` : option.value;
};

/**
 * B-219: makes every label in a catalog UNIQUE, so two different models can never be
 * indistinguishable in the picker.
 *
 * WHY THIS IS A GENERAL RULE AND NOT A GLM SPECIAL CASE: `labelForOpenCodeModelId`
 * deliberately drops the provider half of a `provider/model` id (nobody wants to read
 * "anthropic/claude-sonnet-4-5" in a dropdown). That is lossy, so ANY two providers
 * shipping the same model slug collapse to one label — the provider half survived only
 * in the small description line. It bit the owner for real: opencode's paid Zen route
 * `opencode/glm-5.2` (answers 401 "No payment method") and our z.ai carrier
 * `glm/glm-5.2` both rendered as plain "GLM 5.2", and the paid one was picked by
 * mistake. The same trap is waiting for every future slug two providers share
 * (`zai/glm-5.2`, `openrouter/gpt-5.1`, …), so the fix is collision DETECTION over the
 * final catalog rather than a rule about GLM.
 *
 * Only colliding labels are touched; a unique label is returned byte-for-byte, and a
 * collision-free catalog is returned by reference (no allocation, no churn).
 *
 * @param options the FINAL option list (live catalog + any merged carrier models)
 */
export const disambiguateModelLabels = (
  options: ProviderModelOption[],
): ProviderModelOption[] => {
  const countLabels = (list: ProviderModelOption[]): Map<string, number> => {
    const counts = new Map<string, number>();
    for (const option of list) {
      counts.set(option.label, (counts.get(option.label) ?? 0) + 1);
    }
    return counts;
  };

  // Pass 1 qualifies each member of a colliding group with its provider. Pass 2 covers
  // the residual case — two ids under the SAME provider that format to one label, or a
  // qualified label that now clashes with an unrelated one — by falling back to the raw
  // model value, which is unique by construction (the catalog is value-deduped).
  const resolvers: Array<(option: ProviderModelOption) => string> = [
    qualifyLabelWithProvider,
    (option) => option.value,
  ];

  let current = options;
  for (const resolve of resolvers) {
    const counts = countLabels(current);
    if (![...counts.values()].some((count) => count > 1)) {
      return current;
    }
    current = current.map((option) => (
      (counts.get(option.label) ?? 0) > 1
        ? { ...option, label: resolve(option) }
        : option
    ));
  }

  return current;
};

export const buildOpenCodeDefinitionFromIds = (ids: string[]): ProviderModelsDefinition => {
  const options: ProviderModelOption[] = disambiguateModelLabels(ids.map((value) => ({
    value,
    label: labelForOpenCodeModelId(value),
    description: descriptionForOpenCodeModelId(value),
  })));

  const defaultValue = options.find((option) => option.value === OPENCODE_FALLBACK_MODELS.DEFAULT)?.value
    ?? options[0]?.value
    ?? OPENCODE_FALLBACK_MODELS.DEFAULT;

  return {
    OPTIONS: options,
    DEFAULT: defaultValue,
  };
};

/**
 * Reads the model a session is running on, out of the `session.model` column of
 * opencode.db, as a **wire id** — the exact string `opencode run --model` accepts.
 *
 * B-239 — WHY THE PROVIDER HALF IS REASSEMBLED HERE. opencode stores the model
 * split in two: `{"id":"glm-5.2","providerID":"glm","variant":"default"}`. This
 * function used to return `record.id` alone, and its ONE production caller is
 * `resolveResumeModel`, which feeds it straight to `--model` on every resume of
 * an existing session. So every second turn onward went out as `--model glm-5.2`
 * with the provider half amputated.
 *
 * That is latent for opencode's own models and fatal for ours. Given a bare id,
 * opencode resolves it against its built-in catalog, so `big-pickle` survives.
 * `glm` is OUR provider block in opencode.json, and a bare `glm-5.2` resolves
 * against nothing — opencode reads the whole string as a PROVIDER name and
 * records `{"providerID":"glm-5.2","modelID":""}`, then exits 1. Measured on the
 * owner's session ses_05aab10c: turn 1 (new session, id passed through intact)
 * answered on GLM; turn 2 (first resume) died with no reply at all; turn 3 came
 * back silently on `opencode/big-pickle`. And measured directly on the CLI:
 * `--model glm/glm-5.2` answers, `--model glm-5.2` returns UnknownError.
 *
 * This is also why the carrier looked ✅ in ADR-073: it was proven with a single
 * one-shot `opencode run`, and a one-shot run is the only case that never reads
 * this function. A resume is a different code path, and it was never exercised.
 *
 * The same value is displayed by the `/model` panel, where it is matched against
 * the catalog option values (`opencode/big-pickle`, `glm/glm-5.2`). A bare id
 * matched none of them, so the active-model marker never appeared either — the
 * qualified form repairs both readings at once.
 *
 * VARIANT IS DELIBERATELY NOT ENCODED. Every session in the operator's database
 * carries `variant: "default"`, and no code in this repo reconstructs a variant
 * suffix; opencode's bracket notation (`…[1m]`) is its own display form, not a
 * vendor wire id (B-220). Inventing a suffix here would be a guess, so a
 * non-default variant is knowingly not represented rather than mis-encoded.
 *
 * @param rawModel the `session.model` column value (JSON text, object, or a
 *   plain id string already in wire form).
 * @returns a wire-ready model id, or null when the row names no usable model.
 */
export const parseOpenCodeSessionModelValue = (rawModel: unknown): string | null => {
  if (typeof rawModel === 'string') {
    const trimmed = rawModel.trim();
    if (!trimmed) {
      return null;
    }

    try {
      return parseOpenCodeSessionModelValue(JSON.parse(trimmed));
    } catch {
      // Not JSON: an id already in wire form. Returned untouched.
      return trimmed;
    }
  }

  const record = readObjectRecord(rawModel);
  if (!record) {
    return null;
  }

  const modelId = readOptionalString(record.id)
    ?? readOptionalString(record.model)
    ?? readOptionalString(record.name)
    ?? readOptionalString(record.value);

  // No usable id — including the corrupted `{"id":"","providerID":"glm-5.2"}`
  // row a failed run leaves behind. Returning null lets the caller fall back to
  // the catalog default instead of emitting `glm-5.2/`, a string that names
  // nothing and would fail the next resume for a brand-new reason.
  if (!modelId) {
    return null;
  }

  // Already qualified (older rows stored a plain `provider/model` string): keep
  // it verbatim rather than prefixing a second provider onto it.
  if (modelId.includes('/')) {
    return modelId;
  }

  const providerId = readOptionalString(record.providerID) ?? readOptionalString(record.providerId);
  return providerId ? `${providerId}/${modelId}` : modelId;
};

const runOpenCodeModelsCommand = (): Promise<string> => new Promise((resolve, reject) => {
  // OC-06: OPENCODE_PATH knob → ~/.opencode/bin/opencode → PATH fallback.
  const openCodeProcess = spawnFunction(resolveOpenCodeBinaryPath(), ['models'], {
    cwd: process.cwd(),
    env: { ...process.env },
  });

  let stdout = '';
  let stderr = '';
  let settled = false;

  const timer = setTimeout(() => {
    openCodeProcess.kill('SIGTERM');
    if (!settled) {
      settled = true;
      reject(new Error('opencode models timed out'));
    }
  }, OPEN_CODE_MODELS_TIMEOUT_MS);

  const finish = (error: Error | null, output: string) => {
    if (settled) {
      return;
    }

    settled = true;
    clearTimeout(timer);

    if (error) {
      reject(error);
      return;
    }

    resolve(output);
  };

  openCodeProcess.stdout?.on('data', (chunk: Buffer) => {
    stdout += chunk.toString();
  });

  openCodeProcess.stderr?.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });

  openCodeProcess.on('error', (error) => {
    finish(error instanceof Error ? error : new Error(String(error)), '');
  });

  openCodeProcess.on('close', (code) => {
    if (code !== 0) {
      finish(new Error(stderr.trim() || `opencode models exited with code ${code}`), '');
      return;
    }

    finish(null, stdout);
  });
});

export class OpenCodeProviderModels implements IProviderModels {
  async getSupportedModels(): Promise<ProviderModelsDefinition> {
    // GL-9: the GLM carrier catalog is merged in (flag-gated, default OFF) so a GLM
    // carrier model is selectable even before opencode's live catalog lists it. With
    // the carrier flag off, withGlmCarrierModels is an identity — the returned catalog
    // is byte-for-byte the pre-GL-9 behavior on every branch.
    try {
      const stdout = await runOpenCodeModelsCommand();
      const ids = parseOpenCodeModelsStdout(stdout);
      if (ids.length === 0) {
        return withGlmCarrierModels(OPENCODE_FALLBACK_MODELS);
      }

      return withGlmCarrierModels(buildOpenCodeDefinitionFromIds(ids));
    } catch {
      return withGlmCarrierModels(OPENCODE_FALLBACK_MODELS);
    }
  }

  async getCurrentActiveModel(sessionId?: string): Promise<ProviderCurrentActiveModel> {
    if (!sessionId?.trim()) {
      return buildDefaultProviderCurrentActiveModel(await this.getSupportedModels());
    }

    try {
      const dbPath = getOpenCodeDatabasePath();
      const db = new Database(dbPath, { readonly: true, fileMustExist: true });

      try {
        const row = db.prepare(`
          SELECT
            s.id AS sessionId,
            s.model AS model,
            s.agent AS agent,
            s.directory AS directory,
            s.time_updated AS timeUpdated,
            s.time_created AS timeCreated
          FROM session s
          WHERE s.id = ?
          ORDER BY COALESCE(s.time_updated, s.time_created, 0) DESC
          LIMIT 1
        `).get(sessionId) as {
          sessionId?: string;
          model?: unknown;
          agent?: string | null;
          directory?: string | null;
          timeUpdated?: number | null;
          timeCreated?: number | null;
        } | undefined;

        const model = parseOpenCodeSessionModelValue(row?.model);
        if (model) {
          return {
            model,
          };
        }
      } finally {
        db.close();
      }
    } catch {
      // Fall through to the provider default when OpenCode session lookup fails.
    }

    return buildDefaultProviderCurrentActiveModel(await this.getSupportedModels());
  }

  async changeActiveModel(
    input: ProviderChangeActiveModelInput,
  ): Promise<ProviderSessionActiveModelChange> {
    return writeProviderSessionActiveModelChange('opencode', input);
  }
}
