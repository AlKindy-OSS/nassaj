import { execFile } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import type { ProviderModelOption, ProviderModelsDefinition } from '@/shared/types.js';

import { ANTIGRAVITY_FALLBACK_MODELS } from '@/modules/providers/list/antigravity/antigravity-models.provider.js';

/**
 * Local `agy models` catalog reader (T-875).
 *
 * The Antigravity binary ships an authoritative model-inventory subcommand:
 *
 *   $ agy models
 *   Gemini 3.5 Flash (Medium)
 *   Gemini 3.5 Flash (High)
 *   Claude Sonnet 4.6 (Thinking)
 *   GPT-OSS 120B (Medium)
 *   ...
 *
 * Each printed line is a model DISPLAY LABEL — and agy's `--model` flag expects
 * exactly that label (see agy-cli.js `pickAgyModelLabel`: `agy --model "<label>"`
 * logs "Propagating selected model override to backend"). So this is the single
 * most accurate source for BOTH the picker's option list AND the `--model`
 * argument: we set each option's `value` equal to its `label`, which pickAgyModelLabel
 * already accepts (its by-value and by-label matches converge to the label).
 *
 * This local, no-network, no-token source is preferred over the Google
 * CloudCode endpoint (antigravity-catalog.client.ts) which (a) can 401 for a
 * consumer account and (b) returns catalog modelIds, not the labels `--model`
 * wants. Both remain as graceful fallbacks in
 * {@link AntigravityProviderModels.getSupportedModels}; this reader only ever
 * returns a parsed catalog or `null`, never throwing.
 *
 * The provider-models service caches whatever this yields for the normal
 * multi-day TTL, so the subprocess runs rarely (a cold catalog fetch), never on
 * the chat hot path.
 *
 * TODO(T-875, picker wave): once the UI picker consumes this source, drift-check
 * ANTIGRAVITY_FALLBACK_MODELS (server + src/constants/providerModelFallbacks.ts)
 * against a snapshot of `agy models` so the static fallback (used only when the
 * binary cannot be run) does not diverge from the live label set.
 */

const execFileAsync = promisify(execFile);

/** Resolve the agy binary the same way agy-cli.js does. */
const getAgyPath = (): string =>
  process.env.AGY_PATH || path.join(os.homedir(), '.local', 'bin', 'agy');

/** Hard cap on the subprocess so a hung binary never stalls a model lookup. */
const AGY_MODELS_TIMEOUT_MS = 6_000;

/** Bounded stdout buffer; the model list is a handful of short lines. */
const AGY_MODELS_MAX_BUFFER = 256 * 1024;

/**
 * Runner seam. Defaults to spawning `agy models`; overridable in tests so the
 * parser and the getSupportedModels CLI-first wiring stay hermetic (no real
 * subprocess). Returns the raw stdout, or `null` on any failure.
 */
type AgyModelsRunner = () => Promise<string | null>;

const defaultRunner: AgyModelsRunner = async () => {
  try {
    const { stdout } = await execFileAsync(getAgyPath(), ['models'], {
      timeout: AGY_MODELS_TIMEOUT_MS,
      maxBuffer: AGY_MODELS_MAX_BUFFER,
      // The catalog is operator-global (agy prints the models the installed
      // binary/account can drive); the base env is enough to run the subcommand.
      env: process.env,
    });
    return typeof stdout === 'string' ? stdout : null;
  } catch {
    // Binary missing, timeout, non-zero exit, or oversized output — all map to
    // "no CLI catalog", so the caller falls back to the network/static source.
    return null;
  }
};

let runner: AgyModelsRunner = defaultRunner;

/** Test-only: swap (or reset with `null`) the `agy models` runner. */
export function __setAgyModelsRunnerForTests(next: AgyModelsRunner | null): void {
  runner = next ?? defaultRunner;
}

/**
 * Parses `agy models` stdout into a {@link ProviderModelsDefinition}. Pure and
 * synchronous so it is unit-testable without a subprocess.
 *
 * Rules:
 *   * one model per non-empty line; the trimmed line is BOTH the value and the
 *     label (agy's `--model` takes the label);
 *   * duplicates are dropped, order preserved;
 *   * `auto` (agy's "use the CLI's own default") is prepended and is the DEFAULT,
 *     matching the fork's selection semantics and the other antigravity sources;
 *   * returns `null` when no usable model line is found so the caller falls back.
 */
export function parseAgyModelsOutput(stdout: unknown): ProviderModelsDefinition | null {
  if (typeof stdout !== 'string') {
    return null;
  }

  const seen = new Set<string>();
  const options: ProviderModelOption[] = [];
  for (const rawLine of stdout.split('\n')) {
    const label = rawLine.trim();
    if (!label) {
      continue;
    }
    // agy prints only labels; skip a stray "auto" line so the canonical
    // auto option below is not duplicated.
    if (label.toLowerCase() === 'auto') {
      continue;
    }
    if (seen.has(label)) {
      continue;
    }
    seen.add(label);
    options.push({ value: label, label });
  }

  if (options.length === 0) {
    return null;
  }

  return {
    OPTIONS: [{ value: 'auto', label: 'agy default' }, ...options],
    DEFAULT: ANTIGRAVITY_FALLBACK_MODELS.DEFAULT,
  };
}

/**
 * Runs `agy models` and returns the parsed catalog, or `null` on any failure
 * (binary missing, timeout, empty/garbled output). Never throws — the CLI
 * catalog is an enhancement, not a dependency.
 */
export async function readAntigravityModelsFromCli(): Promise<ProviderModelsDefinition | null> {
  try {
    const stdout = await runner();
    return parseAgyModelsOutput(stdout);
  } catch {
    // Even a misbehaving (rejecting) runner degrades to "no CLI catalog".
    return null;
  }
}
