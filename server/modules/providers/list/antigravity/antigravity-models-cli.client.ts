import { spawn } from 'node:child_process';

import { resolveHarnessBinary } from '@/shared/harness-binaries.js';
import { beginHarnessLaunch } from '@/modules/providers/harness-update/spawn-admission.js';
import { createIdentityCircuit } from '@/modules/providers/list/antigravity/antigravity-identity-circuit.js';
import { resolveCatalogEnv } from '@/services/isolation/resolve-provider-env.js';
import type { ProviderModelOption, ProviderModelsDefinition } from '@/shared/types.js';
import { ANTIGRAVITY_FALLBACK_MODELS } from '@/modules/providers/list/antigravity/antigravity-models.provider.js';

/**
 * Local `agy models` catalog reader (T-875).
 *
 * The Antigravity binary ships an authoritative model-inventory subcommand:
 *
 *   $ agy models
 *   gemini-3.8-flash-high<TAB>Gemini 3.8 Flash (High)
 *   claude-opus-4-6-thinking<TAB>Claude Opus 4.6 (Thinking)
 *   ...
 *
 * Current agy versions print a model identifier and display label separated by
 * a tab. Older versions printed one value per line. The parser accepts both:
 * the identifier becomes the option value and the display name becomes its
 * label, while legacy lines use the same string for both fields.
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

/** Hard cap on the subprocess so a hung binary never stalls a model lookup. */
const AGY_MODELS_TIMEOUT_MS = 6_000;

/** Bounded stdout buffer; the model list is a handful of short lines. */
const AGY_MODELS_MAX_BUFFER = 256 * 1024;

/** Consecutive CLI failures for one caller before their breaker opens. */
const AGY_MODELS_FAILURE_THRESHOLD = 3;

/** How long one caller's open CLI breaker suppresses the spawn. */
const AGY_MODELS_COOLDOWN_MS = 5 * 60 * 1000;

/**
 * B-1284: per-identity CLI breaker. A member who never signed in to agy makes
 * `agy models` exit 1 ("Please sign in") every time; without this, each of their
 * degraded-TTL retries spawned a live `agy` child that safe-restart counts as a
 * session. After three failures their spawn stops for the cooldown — theirs only.
 */
const cliCircuit = createIdentityCircuit(AGY_MODELS_FAILURE_THRESHOLD, AGY_MODELS_COOLDOWN_MS);

/**
 * Runner seam. Defaults to spawning `agy models` under the env it is handed;
 * overridable in tests so the parser and the getSupportedModels CLI-first wiring
 * stay hermetic. Returns the raw stdout, or `null` on any failure.
 */
type AgyModelsRunner = (env: NodeJS.ProcessEnv) => Promise<string | null>;

const defaultRunner: AgyModelsRunner = (env) =>
  new Promise((resolve) => {
    let releaseLaunch: (() => void) | undefined;
    let child;
    try {
      releaseLaunch = beginHarnessLaunch('antigravity');
      child = spawn(resolveHarnessBinary('antigravity'), ['models'], {
        // stdin MUST be 'ignore' (/dev/null), NEVER a pipe. `agy models` blocks
        // reading stdin to EOF before printing anything, so an open stdin pipe
        // hangs it forever: measured 2.9s + exit 0 with 'ignore', vs no output
        // at all until the timeout kills it with 'pipe'. This is why `execFile`
        // (which always pipes stdin, and silently ignores a `stdio` option) made
        // EVERY catalog read fail — never intermittently — leaving the catalog
        // permanently `degraded` on the 5-minute retry TTL and spawning a live
        // `agy` process every few minutes. Those processes are OS children of
        // the server, so safe-restart.sh counted each one as a live interactive
        // session and deferred deploys against a probe that never had a chance
        // of succeeding. Raising the timeout does NOT help: the read never
        // returns, so a longer cap only widens the collision window.
        stdio: ['ignore', 'pipe', 'ignore'],
        // B-1284/B-1375: the catalog is NOT operator-global — measured: under an
        // empty HOME `agy models` exits 1 "Please sign in". So it runs under the
        // caller's resolved, host-secret-stripped env (resolveCatalogEnv), never
        // the raw server env (which carried JWT_SECRET into the child).
        env,
      });
    } catch {
      releaseLaunch?.();
      // Binary missing / not executable — no CLI catalog.
      resolve(null);
      return;
    }
    child.once('error', releaseLaunch);
    child.once('close', releaseLaunch);

    let stdout = '';
    let truncated = false;
    let settled = false;
    const finish = (value: string | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(null);
    }, AGY_MODELS_TIMEOUT_MS);

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      if (truncated) return;
      stdout += chunk;
      if (stdout.length > AGY_MODELS_MAX_BUFFER) {
        // Oversized output is treated as garbage, matching the previous
        // maxBuffer behaviour: drop it and fall back.
        truncated = true;
        child.kill('SIGKILL');
        finish(null);
      }
    });

    // Spawn/stream errors (ENOENT, EACCES) map to "no CLI catalog", never throw.
    child.on('error', () => finish(null));
    child.stdout.on('error', () => finish(null));
    child.on('close', (code) => finish(code === 0 ? stdout : null));
  });

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
 *   * one model per non-empty line, either `<id>\t<label>` or a legacy value;
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
    const trimmedLine = rawLine.trim();
    if (!trimmedLine || trimmedLine.toLowerCase() === 'auto') {
      continue;
    }

    let value = trimmedLine;
    let label = trimmedLine;
    const tabIndex = rawLine.indexOf('\t');
    if (tabIndex !== -1) {
      value = rawLine.slice(0, tabIndex).trim();
      label = rawLine.slice(tabIndex + 1).trim() || value;
    } else {
      const columns = trimmedLine.split(/\s{2,}/);
      if (columns.length >= 2) {
        value = columns[0].trim();
        label = columns.slice(1).join(' ').trim() || value;
      }
    }

    if (!value || value.toLowerCase() === 'auto') {
      continue;
    }
    if (seen.has(value)) {
      continue;
    }
    seen.add(value);
    options.push({ value, label });
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
 * Runs `agy models` for `userId` and returns the parsed catalog, or `null` on
 * any failure (isolation unavailable, breaker open, binary missing, timeout,
 * empty/garbled output). Never throws — the CLI catalog is an enhancement.
 *
 * `userId` is positionally required (B-1284): the command runs under that
 * caller's own agy tree. When isolation is unavailable for them the answer is
 * `null` with NO spawn — never the operator's environment.
 */
export async function readAntigravityModelsFromCli(
  userId: string | number | null,
): Promise<ProviderModelsDefinition | null> {
  if (cliCircuit.isOpen(userId, Date.now())) {
    return null;
  }
  let catalog: ProviderModelsDefinition | null = null;
  try {
    const env = resolveCatalogEnv(userId, 'agy', process.env);
    if (!env) {
      return null;
    }
    catalog = parseAgyModelsOutput(await runner(env));
  } catch {
    // A provisioning error or a misbehaving (rejecting) runner degrades to
    // "no CLI catalog", like any other failure.
    catalog = null;
  }
  if (catalog) {
    cliCircuit.recordSuccess(userId);
  } else {
    cliCircuit.recordFailure(userId, Date.now());
  }
  return catalog;
}

/** Resets the CLI breaker. Exported for unit tests only. */
export function __resetAgyModelsCliCircuit(): void {
  cliCircuit.reset();
}

/** Number of callers with a failing CLI breaker. Exported for unit tests only. */
export function __agyModelsCliCircuitSize(): number {
  return cliCircuit.size();
}
