import { ANTIGRAVITY_FALLBACK_MODELS } from '@/modules/providers/list/antigravity/antigravity-models.provider.js';
import { readAntigravityAccessToken } from '@/modules/providers/list/antigravity/antigravity-token-reader.js';
import type { ProviderModelOption, ProviderModelsDefinition } from '@/shared/types.js';

/**
 * Live Antigravity (agy) model-catalog client.
 *
 * Fetches the available-model list from Google's internal CloudCode endpoint
 * (the same one `agy` itself calls) and maps it into the provider-models
 * `ProviderModelsDefinition` shape. Every failure mode degrades gracefully to
 * {@link ANTIGRAVITY_FALLBACK_MODELS}; the live fetch is an enhancement, never a
 * dependency. agy sessions and the UI must keep working even if this endpoint,
 * the network, or the token are completely unavailable.
 *
 * Resilience (qa-critic / architect hard constraints):
 *  - Short abort timeout so a hung request never stalls a chat/model lookup.
 *  - Process-level circuit breaker: after repeated failures we stop hitting the
 *    network for a cooldown window and serve the fallback immediately, so a
 *    consumer (non-Antigravity) account that always 401s does not add latency to
 *    every request.
 *  - The OAuth token is read transiently to set the Authorization header and is
 *    never logged or retained.
 */

const FETCH_AVAILABLE_MODELS_URL =
  'https://daily-cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels';

/** Hard cap on the live request; agy's own calls return well under this. */
const REQUEST_TIMEOUT_MS = 4_000;

/** Consecutive failures before the breaker opens. */
const CIRCUIT_FAILURE_THRESHOLD = 3;

/** How long the breaker stays open (serving fallback) before a half-open retry. */
const CIRCUIT_COOLDOWN_MS = 5 * 60 * 1000;

type CircuitState = {
  consecutiveFailures: number;
  openUntil: number;
};

// Module-scoped breaker. Holds only counters/timestamps — never a token.
const circuit: CircuitState = {
  consecutiveFailures: 0,
  openUntil: 0,
};

function isCircuitOpen(now: number): boolean {
  return circuit.openUntil > now;
}

function recordSuccess(): void {
  circuit.consecutiveFailures = 0;
  circuit.openUntil = 0;
}

function recordFailure(now: number): void {
  circuit.consecutiveFailures += 1;
  if (circuit.consecutiveFailures >= CIRCUIT_FAILURE_THRESHOLD) {
    circuit.openUntil = now + CIRCUIT_COOLDOWN_MS;
  }
}

/**
 * Builds the degraded/fallback catalog returned when the live fetch is
 * unavailable. The `degraded: true` flag tells the provider-models cache layer
 * to store this under a short TTL and re-attempt the live fetch soon, instead
 * of pinning the fallback for the normal multi-day TTL. A successful live fetch
 * returns its parsed catalog without this flag, so the two cases stay distinct.
 */
function degradedFallbackCatalog(): ProviderModelsDefinition {
  return { ...ANTIGRAVITY_FALLBACK_MODELS, degraded: true };
}

/** Resets breaker state. Exported for unit tests only. */
export function __resetAntigravityCatalogCircuit(): void {
  circuit.consecutiveFailures = 0;
  circuit.openUntil = 0;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const readString = (value: unknown): string | null =>
  typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;

/**
 * Maps one raw model entry to a {@link ProviderModelOption}. The agy endpoint
 * has used a few field names across versions, so we accept the common aliases
 * (`modelId`/`model`/`name` for the value, `displayName`/`label` for the label)
 * and fall back to the value as the label. Entries with no usable id are
 * dropped.
 */
function toModelOption(entry: unknown): ProviderModelOption | null {
  if (!isRecord(entry)) {
    return null;
  }

  const value =
    readString(entry.modelId)
    ?? readString(entry.model)
    ?? readString(entry.id)
    ?? readString(entry.name);

  if (!value) {
    return null;
  }

  const label =
    readString(entry.displayName)
    ?? readString(entry.label)
    ?? readString(entry.description)
    ?? value;

  return { value, label };
}

/**
 * Extracts a model array from the response body under any of the field names the
 * endpoint is known to use, then maps and de-duplicates them. Returns `null`
 * when no usable model entries are found, so the caller falls back.
 *
 * Exported for unit testing.
 */
export function parseCatalog(body: unknown): ProviderModelsDefinition | null {
  if (!isRecord(body)) {
    return null;
  }

  const rawList =
    (Array.isArray(body.models) && body.models)
    || (Array.isArray(body.availableModels) && body.availableModels)
    || (Array.isArray(body.modelConfigs) && body.modelConfigs)
    || null;

  if (!rawList) {
    return null;
  }

  const seen = new Set<string>();
  const options: ProviderModelOption[] = [];
  for (const entry of rawList) {
    const option = toModelOption(entry);
    if (option && !seen.has(option.value)) {
      seen.add(option.value);
      options.push(option);
    }
  }

  if (options.length === 0) {
    return null;
  }

  // Keep agy's "auto" (use the CLI's own setting) as the first/default option so
  // the live catalog stays consistent with the fork's selection semantics.
  const autoOption: ProviderModelOption = { value: 'auto', label: 'agy default' };
  const hasAuto = options.some((option) => option.value === 'auto');

  return {
    OPTIONS: hasAuto ? options : [autoOption, ...options],
    DEFAULT: ANTIGRAVITY_FALLBACK_MODELS.DEFAULT,
  };
}

/**
 * Performs the live fetch with an abort timeout. Returns the parsed catalog, or
 * `null` on any failure (no token, breaker would have to be checked by caller,
 * network/HTTP/parse error). Never throws.
 */
async function fetchLiveCatalog(): Promise<ProviderModelsDefinition | null> {
  const token = await readAntigravityAccessToken();
  if (!token) {
    return null;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(FETCH_AVAILABLE_MODELS_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: '{}',
      signal: controller.signal,
    });

    if (!response.ok) {
      // Drain/cancel the undici response body so the connection is released
      // instead of leaving an unconsumed stream around (Node 24 fetch).
      await response.body?.cancel();
      return null;
    }

    const body = (await response.json()) as unknown;
    return parseCatalog(body);
  } catch {
    // Network failure, abort/timeout, or JSON parse error — all map to "no live
    // catalog". The token value never appears here.
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Returns the Antigravity model catalog: the live agy catalog when reachable,
 * otherwise {@link ANTIGRAVITY_FALLBACK_MODELS}. Honours a circuit breaker so a
 * persistently-failing endpoint (e.g. a consumer account that always 401s)
 * stops adding network latency.
 *
 * A successful live fetch returns its parsed catalog (no `degraded` flag) and is
 * cached by the provider-models service for the normal multi-day TTL. A fallback
 * result is flagged `degraded: true`, so the service caches it only briefly and
 * re-attempts the live fetch within minutes (around when the breaker reopens),
 * instead of pinning the fallback for days. This never throws.
 */
export async function getAntigravityModelCatalog(): Promise<ProviderModelsDefinition> {
  const now = Date.now();

  if (isCircuitOpen(now)) {
    return degradedFallbackCatalog();
  }

  const liveCatalog = await fetchLiveCatalog();
  if (liveCatalog) {
    recordSuccess();
    return liveCatalog;
  }

  recordFailure(Date.now());
  return degradedFallbackCatalog();
}
