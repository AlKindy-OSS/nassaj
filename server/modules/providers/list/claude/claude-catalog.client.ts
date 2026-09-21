import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { query, type ModelInfo, type Options } from '@anthropic-ai/claude-agent-sdk';

import { resolveClaudeCodeExecutablePath } from '@/shared/claude-cli-path.js';
import {
  assertAnthropicBaseUrlAllowed,
  assertSettingsEnvAllowed,
} from '@/services/isolation/anthropic-base-url-guard.js';
import { resolveProviderEnv } from '@/services/isolation/resolve-provider-env.js';
import { buildCagedSdkSpawn } from '@/services/isolation/provider-cage-wiring.js';
import type { ProviderModelOption, ProviderModelsDefinition } from '@/shared/types.js';

import {
  brokenModelsUserKey,
  getBrokenModels,
} from './claude-broken-models.store.js';
import { CLAUDE_FALLBACK_MODELS } from './claude-models.provider.js';

/**
 * Live Claude model-catalog client.
 *
 * Asks the installed Claude Code (via the Agent SDK control channel) for the
 * exact model list the user is entitled to under their current subscription,
 * then maps it into the provider-models `ProviderModelsDefinition` shape. The
 * live list automatically surfaces the newest model the account can use (e.g.
 * Opus 4.8 or later) without anyone editing a hand-maintained array.
 *
 * Real authentication (B-MODEL-DISCOVERY): the probe runs under the SAME
 * CLAUDE_CONFIG_DIR a real spawn for this user would use, resolved through
 * {@link resolveProviderEnv}(userId, 'claude', ...). That is what makes the list
 * TRUE per-subscription: an UNauthenticated probe (the old `{ ...process.env }`)
 * made `supportedModels()` answer from the CLI's static built-in list, which
 * includes models Anthropic has not released for the account (e.g.
 * claude-fable-5). Under the user's real credentials Anthropic's own filtering
 * returns only the entitled models, so the unreleased ones disappear at the
 * source — no hand-maintained hide-list is needed.
 *
 * Side-effect safety (the reason the original inline call was disabled):
 *  - The catalog is obtained from a control request (`supportedModels()`) that
 *    the SDK answers from its init handshake alone — no model turn, no token
 *    cost. We feed an async-generator prompt that yields NOTHING, so the SDK
 *    stays in streaming-input mode and never starts a conversation. This avoids
 *    the jsonl-session-creation / workspace-listing side effect that a plain
 *    string prompt (`query({ prompt: 'Get supported models' })`) triggered.
 *  - The query runs with `cwd` set to a throwaway temp dir, so even if a future
 *    SDK build did try to touch the workspace, it would touch an empty isolated
 *    directory, never the real project. The temp dir is removed afterwards.
 *  - The query instance is always closed/released in `finally`.
 *
 * Resilience (mirrors antigravity-catalog.client.ts):
 *  - Hard abort timeout so a hung probe never stalls a model lookup.
 *  - Process-level circuit breaker, KEYED PER USER: after repeated failures for a
 *    given subscription we stop spawning that user's probe for a cooldown window
 *    and serve the fallback immediately. One account's breaker never blocks
 *    another's live fetch.
 *  - Single-flight lock per user so concurrent callers share one in-flight probe.
 *  - Every failure mode degrades gracefully to {@link CLAUDE_FALLBACK_MODELS}
 *    flagged `degraded: true`. The live fetch is an enhancement, never a
 *    dependency — the UI must keep working with no Claude install at all.
 */

/** Hard cap on the live probe; the control request returns well under this. */
const PROBE_TIMEOUT_MS = 8_000;

/** Consecutive failures before the breaker opens. */
const CIRCUIT_FAILURE_THRESHOLD = 3;

/** How long the breaker stays open (serving fallback) before a half-open retry. */
const CIRCUIT_COOLDOWN_MS = 5 * 60 * 1000;

type CircuitState = {
  consecutiveFailures: number;
  openUntil: number;
};

// Per-user breaker + single-flight maps. The key is the resolved user bucket
// (resolveProviderEnv's isolation scope), so each subscription has independent
// failure accounting and never shares an in-flight probe with another user.
const circuits = new Map<string, CircuitState>();
const inFlight = new Map<string, Promise<ProviderModelsDefinition>>();

function getCircuit(userKey: string): CircuitState {
  let circuit = circuits.get(userKey);
  if (!circuit) {
    circuit = { consecutiveFailures: 0, openUntil: 0 };
    circuits.set(userKey, circuit);
  }
  return circuit;
}

function isCircuitOpen(userKey: string, now: number): boolean {
  return getCircuit(userKey).openUntil > now;
}

function recordSuccess(userKey: string): void {
  const circuit = getCircuit(userKey);
  circuit.consecutiveFailures = 0;
  circuit.openUntil = 0;
}

function recordFailure(userKey: string, now: number): void {
  const circuit = getCircuit(userKey);
  circuit.consecutiveFailures += 1;
  if (circuit.consecutiveFailures >= CIRCUIT_FAILURE_THRESHOLD) {
    circuit.openUntil = now + CIRCUIT_COOLDOWN_MS;
  }
}

/** Resets breaker + single-flight state for ALL users. Exported for unit tests only. */
export function __resetClaudeCatalogCircuit(): void {
  circuits.clear();
  inFlight.clear();
}

/**
 * Builds the degraded/fallback catalog returned when the live probe is
 * unavailable. The `degraded: true` flag tells the provider-models cache layer
 * to store this under a short TTL and re-attempt the live probe soon, instead of
 * pinning the fallback for the normal multi-day TTL.
 */
function degradedFallbackCatalog(): ProviderModelsDefinition {
  return { ...CLAUDE_FALLBACK_MODELS, degraded: true };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const readString = (value: unknown): string | null =>
  typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;

/**
 * Maps one SDK {@link ModelInfo} entry into a {@link ProviderModelOption}.
 * `value` is the model id used in API/CLI calls; `label`/`description` are the
 * human-facing strings the SDK already localizes for the picker. Entries with no
 * usable `value` are dropped by the caller.
 */
function toModelOption(entry: unknown): ProviderModelOption | null {
  if (!isRecord(entry)) {
    return null;
  }

  const value = readString(entry.value) ?? readString(entry.id) ?? readString(entry.model);
  if (!value) {
    return null;
  }

  const label = readString(entry.displayName) ?? readString(entry.label) ?? value;
  const description = readString(entry.description);

  return description ? { value, label, description } : { value, label };
}

/**
 * Converts the SDK `supportedModels()` array into a
 * {@link ProviderModelsDefinition}. De-duplicates by value, preserves order,
 * drops any model in `excluded` (the per-user lazy-detection broken set), and
 * keeps the existing fallback DEFAULT (`'default'`) when present so the picker's
 * default selection semantics never shift under the user. Returns `null` when no
 * usable model entries are found so the caller can fall back.
 *
 * Exported for unit testing.
 *
 * @param supportedModels Raw SDK ModelInfo[] (or partial records under test).
 * @param excluded Model values to drop (lazy-detected broken models). Optional.
 */
export function buildClaudeModelsDefinition(
  // Accepts the SDK's ModelInfo[] but typed loosely on purpose: the entries are
  // validated/normalized at runtime by toModelOption, and tests exercise partial
  // shapes (missing description, missing value) that ModelInfo would reject.
  supportedModels: readonly (ModelInfo | Record<string, unknown>)[] | null | undefined,
  excluded?: ReadonlySet<string>,
): ProviderModelsDefinition | null {
  if (!Array.isArray(supportedModels) || supportedModels.length === 0) {
    return null;
  }

  const seen = new Set<string>();
  const options: ProviderModelOption[] = [];
  for (const entry of supportedModels) {
    const option = toModelOption(entry);
    // Drop de-duplicates and any model lazy-detection has flagged broken for this
    // user (it advertised in supportedModels() but failed at real use).
    if (option && !seen.has(option.value) && !(excluded?.has(option.value))) {
      seen.add(option.value);
      options.push(option);
    }
  }

  if (options.length === 0) {
    return null;
  }

  // Keep the fallback DEFAULT only if the live catalog still offers it; otherwise
  // anchor on the first live option so DEFAULT is always a selectable value.
  const fallbackDefault = CLAUDE_FALLBACK_MODELS.DEFAULT;
  const hasFallbackDefault = options.some((option) => option.value === fallbackDefault);

  return {
    OPTIONS: options,
    DEFAULT: hasFallbackDefault ? fallbackDefault : options[0].value,
  };
}

/**
 * Runs the side-effect-free `supportedModels()` probe in an isolated temp cwd
 * with a zero-turn streaming-input prompt, UNDER the resolved per-user Claude
 * environment. Returns the parsed catalog, or `null` on any failure/timeout.
 * Never throws.
 *
 * @param userId Authenticated user whose CLAUDE_CONFIG_DIR the probe runs under.
 */
async function probeSupportedModels(
  userId: string | number | null,
): Promise<ProviderModelsDefinition | null> {
  // Isolated throwaway working directory: even if a future SDK build touched the
  // workspace, it would only touch this empty dir, never the real project.
  let probeCwd: string | null = null;
  try {
    probeCwd = await mkdtemp(path.join(os.tmpdir(), 'claude-models-probe-'));
  } catch {
    return null;
  }

  // Controls the async generator's lifetime. The generator awaits this promise
  // and yields nothing, so no turn is ever produced. Resolving it lets the
  // generator end (after we've already pulled supportedModels()).
  let releaseGenerator: (() => void) | null = null;
  const releasePromise = new Promise<void>((resolve) => {
    releaseGenerator = resolve;
  });

  // A streaming-input prompt emitting zero turns — keeps the session in
  // streaming-input mode without sending any user message to the model.
  async function* emptyPromptStream(): AsyncGenerator<never, void, unknown> {
    await releasePromise;
  }

  let queryInstance: ReturnType<typeof query> | null = null;
  let timeoutHandle: ReturnType<typeof setTimeout> | null = null;

  const cleanup = async (): Promise<void> => {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
      timeoutHandle = null;
    }
    if (releaseGenerator) {
      releaseGenerator();
      releaseGenerator = null;
    }
    if (queryInstance && typeof queryInstance.close === 'function') {
      try {
        // close() is the SDK's teardown for the child process: it delegates to
        // transport.close() synchronously. Unlike interrupt() (a round-trip
        // control message that can hang on the early-error path — e.g. a spawn
        // failure before init completes), close() never waits on a reply.
        queryInstance.close();
      } catch {
        // Defensive: close() is synchronous and shouldn't throw, but never let
        // a teardown error escape cleanup. The released generator + GC still
        // tears the SDK child process down as a backstop.
      }
    }
    if (probeCwd) {
      await rm(probeCwd, { recursive: true, force: true }).catch(() => {
        // Best-effort cleanup of the isolated temp dir.
      });
    }
  };

  try {
    // Resolve the SAME environment a real spawn for this user uses so the probe
    // reports the catalog for the user's authenticated subscription (their own
    // CLAUDE_CONFIG_DIR). When claude is admin-marked "shared", or userId is
    // null/anon/platform, resolveProviderEnv returns the operator base env
    // unchanged — identical to the previous behaviour for those cases. Held in a
    // definite local so the fail-closed guard below sees a concrete env
    // (Options.env is typed optional, which would otherwise widen to `| undefined`).
    let probeEnv: NodeJS.ProcessEnv;
    try {
      probeEnv = resolveProviderEnv(userId, 'claude', process.env);
    } catch {
      // Never let env resolution (e.g. a provisioning hiccup) break the probe —
      // fall back to the base env, which still yields a usable catalog.
      probeEnv = { ...process.env };
    }

    const options: Options = {
      env: probeEnv,
      cwd: probeCwd,
      pathToClaudeCodeExecutable: resolveClaudeCodeExecutablePath(process.env.CLAUDE_CLI_PATH),
      systemPrompt: { type: 'preset', preset: 'claude_code' },
    };

    // Vendor-resilience iron rule (fail-closed): refuse to spawn this catalog
    // probe if a competitor ANTHROPIC_BASE_URL (or any *_BASE_URL routing var) in
    // the operator OS env / per-user settings.json would route the Claude
    // subprocess to a non-Anthropic endpoint. No-op when unset (default
    // Anthropic). Mirrors the three spawn seams in server/claude-sdk.js. The
    // throw is caught by probeSupportedModels()'s catch and degrades to the
    // fallback catalog — never silently routes Claude traffic to an unknown
    // vendor. The settings.json check now targets the RESOLVED per-user config
    // dir, so a competitor base URL placed in a user's own settings.json is
    // caught too. See server/services/isolation/anthropic-base-url-guard.js.
    assertAnthropicBaseUrlAllowed(probeEnv);
    assertSettingsEnvAllowed(probeEnv.CLAUDE_CONFIG_DIR ?? '', probeEnv);

    // T-897: cage the catalog-probe Claude spawn (flag OFF ⇒ undefined ⇒ unset).
    const cagedProbeSpawn = buildCagedSdkSpawn({ userId, cwd: probeCwd });
    if (cagedProbeSpawn) {
      options.spawnClaudeCodeProcess = cagedProbeSpawn;
    }

    queryInstance = query({
      prompt: emptyPromptStream(),
      options,
    });

    const modelsPromise = queryInstance.supportedModels();
    const timeoutPromise = new Promise<'__probe_timeout__'>((resolve) => {
      timeoutHandle = setTimeout(() => resolve('__probe_timeout__'), PROBE_TIMEOUT_MS);
    });

    const result = await Promise.race([modelsPromise, timeoutPromise]);
    if (result === '__probe_timeout__' || !Array.isArray(result)) {
      return null;
    }

    // Lazy-detection backstop: hide any model this user already proved broken at
    // real use, even though the authenticated catalog still advertises it.
    const excluded = await getBrokenModels(userId).catch(() => new Set<string>());
    return buildClaudeModelsDefinition(result, excluded);
  } catch {
    // Old SDK without supportedModels, spawn error, not-installed, etc. → null.
    return null;
  } finally {
    await cleanup();
  }
}

/**
 * Returns the Claude model catalog for one user: the live subscription catalog
 * when the probe succeeds, otherwise {@link CLAUDE_FALLBACK_MODELS} flagged
 * `degraded: true`. Honours a per-user circuit breaker and a per-user
 * single-flight lock. Never throws.
 *
 * A successful live fetch returns its parsed catalog (no `degraded` flag) and is
 * cached by the provider-models service for the normal multi-day TTL. A fallback
 * result is flagged `degraded: true`, so the service caches it only briefly and
 * re-attempts the live probe within minutes (around when the breaker reopens),
 * instead of pinning the fallback for days.
 *
 * @param userId Authenticated user whose subscription the catalog reflects.
 *   `null`/`undefined` (system/anon/platform) uses the operator's shared env.
 */
export async function getClaudeModelCatalog(
  userId: string | number | null = null,
): Promise<ProviderModelsDefinition> {
  const userKey = brokenModelsUserKey(userId);
  const now = Date.now();

  if (isCircuitOpen(userKey, now)) {
    return degradedFallbackCatalog();
  }

  // Single-flight per user: join an in-progress probe for the SAME user instead
  // of spawning a second one. Different users still probe independently.
  const existing = inFlight.get(userKey);
  if (existing) {
    return existing;
  }

  const probe = (async (): Promise<ProviderModelsDefinition> => {
    const liveCatalog = await probeSupportedModels(userId);
    if (liveCatalog) {
      recordSuccess(userKey);
      return liveCatalog;
    }

    recordFailure(userKey, Date.now());
    return degradedFallbackCatalog();
  })().finally(() => {
    inFlight.delete(userKey);
  });

  inFlight.set(userKey, probe);
  return probe;
}
