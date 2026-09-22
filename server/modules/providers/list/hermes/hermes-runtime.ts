/**
 * hermes-runtime.ts — the ONE reader of Hermes' own on-disk truth (B-403/B-404).
 *
 * Hermes 0.17 resolves a run from THREE places, and nassaj used to model none of
 * them:
 *
 *   * `~/.hermes/config.yaml` → `model.provider` names the endpoint that will
 *     actually answer, and `model.default` the model it answers with. Every
 *     headless `hermes -z` without flags uses exactly this pair.
 *   * `--provider` is the ONLY way to switch endpoint. Measured on 0.17.0:
 *     `-m copilot/gpt-4o` and `-m copilot:gpt-4o` are BOTH ignored (the run still
 *     went to the configured nous endpoint and failed), and `-m gpt-4o` alone
 *     auto-detects `openai` — not copilot. A prefixed model id is not a thing.
 *   * `~/.hermes/provider_models_cache.json` is hermes' own live catalog per
 *     provider (bare ids, no prefix), refreshed by `hermes model --refresh`.
 *
 * The previous catalog was invented (`nous/deepseek-v4-pro`, `copilot/gpt-5.5`),
 * so every pick sent an id no endpoint knows. `hermes -z` swallows that into
 * "no final response was produced" with no other signal — which is why B-91 was
 * once filed as an exhausted free tier. Measured 2026-08-03: the same prompt
 * with a real id answers.
 *
 * Everything here is best-effort and never throws: a missing/garbled file
 * degrades to "unknown", and the caller falls back to hermes' own defaults.
 */

import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export type HermesRuntimeConfig = {
  /** `model.provider` — the endpoint that will answer. null when unreadable. */
  provider: string | null;
  /** `model.default` (or the legacy `model.model`). null when unreadable. */
  defaultModel: string | null;
};

/** `~/.hermes`. The home is injectable so tests read a temp tree, not the operator's. */
const hermesHome = (home?: string): string => path.join(home ?? os.homedir(), '.hermes');

/**
 * Minimal reader for the top-level `model:` block of hermes' config.yaml.
 *
 * A YAML dependency for three scalars is not worth the supply-chain surface:
 * the block is written by `hermes config set`, is always two-space indented
 * plain scalars, and anything unexpected simply yields null (never a throw, and
 * never a wrong-but-confident value).
 */
export function parseHermesModelBlock(yaml: string): HermesRuntimeConfig {
  const lines = yaml.split(/\r?\n/);
  const start = lines.findIndex((line) => /^model:\s*$/.test(line));
  if (start < 0) {
    return { provider: null, defaultModel: null };
  }

  const values = new Map<string, string>();
  for (const line of lines.slice(start + 1)) {
    if (!/^\s/.test(line)) {
      break; // dedent — the model block ended.
    }
    const match = /^\s+([A-Za-z0-9_]+):\s*(.*)$/.exec(line);
    if (!match) {
      continue;
    }
    const value = match[2].trim().replace(/^['"]|['"]$/g, '');
    if (value && !value.startsWith('#')) {
      values.set(match[1], value);
    }
  }

  return {
    provider: values.get('provider') ?? null,
    defaultModel: values.get('default') ?? values.get('model') ?? null,
  };
}

export async function readHermesRuntimeConfig(home?: string): Promise<HermesRuntimeConfig> {
  try {
    return parseHermesModelBlock(await readFile(path.join(hermesHome(home), 'config.yaml'), 'utf8'));
  } catch {
    return { provider: null, defaultModel: null };
  }
}

/**
 * Outcome of reading hermes' own model cache for one provider.
 *
 * `failed` separates a REAL read failure (the file is missing, unreadable, or
 * holds corrupt JSON) from a LEGITIMATE empty (a valid file that simply does not
 * list this provider yet). The catalog builder needs the distinction: an empty
 * built on top of a read failure is an incomplete catalog and must be flagged
 * `degraded` so it is re-fetched on a short TTL, whereas a legitimate empty over
 * a live config default is a genuine result that keeps the normal long TTL.
 */
export type HermesCachedModelsResult = {
  /** Bare model ids, exactly as they must be passed to `-m`. */
  models: string[];
  /** true when the cache file could not be read/parsed (missing, I/O error, or corrupt JSON). */
  failed: boolean;
};

/**
 * The model ids hermes itself last saw for `provider`, from its own cache.
 * Bare ids exactly as they must be passed to `-m`.
 *
 * Returns `failed: true` when the cache file is missing, unreadable, or corrupt;
 * `failed: false` with an empty list when the file is valid but never listed this
 * provider (or when no provider is supplied — there is nothing to look up). Never
 * throws: the caller decides what an unreadable cache means for the catalog.
 */
export async function readHermesCachedModels(
  provider: string | null,
  home?: string,
): Promise<HermesCachedModelsResult> {
  if (!provider) {
    // No provider to look up. This is not a cache read failure — the config-read
    // failure that produced a null provider is judged by the catalog builder.
    return { models: [], failed: false };
  }

  let raw: string;
  try {
    raw = await readFile(path.join(hermesHome(home), 'provider_models_cache.json'), 'utf8');
  } catch {
    // Missing file or I/O error: a real read failure. On a machine where the
    // operator never ran `hermes model --refresh` the file is legitimately
    // absent, but the catalog it would have contributed is still missing, so the
    // result is incomplete and treated as a failure (short-TTL degraded).
    return { models: [], failed: true };
  }

  let parsed: Record<string, { models?: unknown } | undefined>;
  try {
    parsed = JSON.parse(raw) as Record<string, { models?: unknown } | undefined>;
  } catch {
    // The file exists but its contents cannot be trusted — a real failure, not a
    // legitimate empty.
    return { models: [], failed: true };
  }

  const models = parsed?.[provider]?.models;
  if (!Array.isArray(models)) {
    // Valid file that simply does not list this provider yet: a legitimate empty.
    return { models: [], failed: false };
  }

  return {
    models: models.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0),
    failed: false,
  };
}

export type HermesCredentialVerdict = {
  authenticated: boolean;
  email: string | null;
  method: string | null;
  error?: string;
};

/**
 * Judges `~/.hermes/auth.json` AGAINST THE PROVIDER THAT WILL RUN (B-404).
 *
 * Pure: the caller owns the file read. `runtimeProvider` null means the config
 * was unreadable, and only then does any credential count — refusing on a fact
 * we could not establish would be its own kind of lie.
 */
export function selectHermesCredential(
  auth: Record<string, unknown>,
  runtimeProvider: string | null,
): HermesCredentialVerdict {
  const asRecord = (value: unknown): Record<string, unknown> =>
    (value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {});

  const providers = asRecord(auth.providers);
  const pool = asRecord(auth.credential_pool);

  const candidates = runtimeProvider
    ? [runtimeProvider]
    : [...new Set([...Object.keys(providers), ...Object.keys(pool)])];

  for (const id of candidates) {
    const record = asRecord(providers[id]);
    const token = typeof record.access_token === 'string' ? record.access_token.trim() : '';
    const entries = pool[id];
    if (token || (Array.isArray(entries) && entries.length > 0)) {
      return { authenticated: true, email: `${id} credentials`, method: 'oauth' };
    }
  }

  if (!runtimeProvider) {
    return { authenticated: false, email: null, method: null, error: 'Hermes not configured' };
  }

  // The stored failure reason is the whole diagnosis — a bare "not
  // authenticated" sends the owner hunting inside nassaj instead.
  //
  // Provider truth ONLY, in hermes' own wording and language: this string is
  // rendered verbatim next to the account card's Login button, so any advice we
  // appended here ("re-login") both duplicated that button and hard-coded ONE
  // language into a server layer the UI translates around it. It read as a
  // stray Arabic sentence inside an English settings page.
  const lastError = asRecord(asRecord(providers[runtimeProvider]).last_auth_error);
  const message = typeof lastError.message === 'string' ? lastError.message : null;
  return {
    authenticated: false,
    email: null,
    method: null,
    error: message
      ? `${runtimeProvider}: ${message}`
      : `${runtimeProvider}: no stored credential for the running provider`,
  };
}
