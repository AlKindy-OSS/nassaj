import type { ProviderModelOption, ProviderModelsDefinition } from '@/shared/types.js';

/**
 * Shared live model-catalog client for hosted vendor providers (kimi/deepseek/
 * glm). It mirrors the Antigravity catalog client's resilience contract so a
 * model lookup never stalls a chat and never throws:
 *
 *  - Short abort timeout so a hung endpoint can't block a request.
 *  - Process-level circuit breaker per provider: after repeated failures it
 *    serves the fallback immediately for a cooldown window instead of hitting
 *    the network on every call.
 *  - Single-flight: concurrent callers for the same provider share one in-flight
 *    fetch rather than stampeding the endpoint.
 *  - Every failure mode degrades to the provider's `<ID>_FALLBACK_MODELS` flagged
 *    `degraded: true`, which tells the provider-models cache to keep the fallback
 *    only briefly and re-attempt the live fetch soon (SWR).
 *
 * The API key is read transiently to set the Authorization header and is never
 * logged or retained on the breaker state.
 *
 * These endpoints are Anthropic-compatible `GET <base>/v1/models` listings. The
 * base URL is supplied by each provider (hard-coded in the provider folder, not
 * an env var) to keep the iron-rule boundary explicit.
 */

const REQUEST_TIMEOUT_MS = 4_000;
const CIRCUIT_FAILURE_THRESHOLD = 3;
const CIRCUIT_COOLDOWN_MS = 5 * 60 * 1000;

type CircuitState = {
  consecutiveFailures: number;
  openUntil: number;
};

/**
 * Who a catalog lookup is for. Every key this client reads belongs to exactly one
 * identity, so every piece of state it keeps is bucketed by the same value.
 */
export type CatalogIdentity = string | number;

/**
 * The bucket for a caller with no authenticated user.
 *
 * T-1260: this used to be the store's `SYSTEM_SCOPE`, which quietly made "nobody
 * asked" and "read the operator's key" the same token — so a cache bucket and a
 * spending decision shared one value. This constant is a CACHE BUCKET and
 * nothing else; the catalog's key lookup maps it back to "no identity" and lets
 * `resolveSlotKey` decide whose key answers.
 */
export const ANONYMOUS_CATALOG_IDENTITY = '__anonymous__';

/** Bucket key for one identity. Normalizes number/string ids to one bucket. */
const identityKey = (identity: CatalogIdentity): string => `user:${String(identity)}`;

export type VendorCatalogClientOptions = {
  /** Stable provider id used to key the per-provider breaker/in-flight state. */
  provider: string;
  /** Fully-qualified Anthropic-compatible models endpoint, e.g. `<base>/v1/models`. */
  modelsUrl: string;
  /** Returns THIS identity's API key (or null when none is configured). */
  getApiKey: (identity: CatalogIdentity) => string | null | Promise<string | null>;
  /** Built-in catalog served (flagged degraded) on any failure. */
  fallback: ProviderModelsDefinition;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const readString = (value: unknown): string | null =>
  typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;

/**
 * Maps one raw model entry to a {@link ProviderModelOption}. Anthropic-compatible
 * `/v1/models` rows expose `id`; some gateways also use `name`/`model` and a
 * `display_name`/`displayName` label. Entries with no usable id are dropped.
 */
function toModelOption(entry: unknown): ProviderModelOption | null {
  if (!isRecord(entry)) {
    return null;
  }

  const value =
    readString(entry.id)
    ?? readString(entry.model)
    ?? readString(entry.name);

  if (!value) {
    return null;
  }

  const label =
    readString(entry.display_name)
    ?? readString(entry.displayName)
    ?? readString(entry.description)
    ?? value;

  return { value, label };
}

/**
 * Extracts and de-duplicates the model array from an Anthropic-compatible models
 * response body. Anthropic returns `{ data: [...] }`; OpenAI-style gateways also
 * use that shape, and some use `{ models: [...] }`. Returns `null` when no usable
 * entries are found so the caller falls back. Exported for unit testing.
 */
export function parseVendorCatalog(
  body: unknown,
  fallback: ProviderModelsDefinition,
): ProviderModelsDefinition | null {
  if (!isRecord(body)) {
    return null;
  }

  const rawList =
    (Array.isArray(body.data) && body.data)
    || (Array.isArray(body.models) && body.models)
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

  // Keep the provider's documented DEFAULT when the live list still contains it;
  // otherwise fall back to the first live option so DEFAULT always resolves to a
  // selectable id.
  const hasFallbackDefault = options.some((option) => option.value === fallback.DEFAULT);
  return {
    OPTIONS: options,
    DEFAULT: hasFallbackDefault ? fallback.DEFAULT : options[0].value,
  };
}

/**
 * A self-contained live catalog fetcher for one vendor provider. Construct once
 * per provider module (so the breaker/in-flight state is process-scoped) and call
 * {@link getCatalog} from the provider's `getSupportedModels`.
 */
export class VendorCatalogClient {
  private readonly options: VendorCatalogClientOptions;

  /**
   * Breaker and single-flight state, bucketed PER IDENTITY (B-342).
   *
   * Both used to be single fields on a module-level instance, which was harmless
   * only while `getApiKey` ignored who was asking. The moment the key became
   * per-user, one shared bucket meant two concrete failures:
   *
   *  - single-flight: user B arriving during user A's fetch would be handed A's
   *    promise and would receive — and cache for three days — a catalog built
   *    from A's key, disclosing A's plan tier.
   *  - breaker: three failures for a user with no key would open the circuit for
   *    EVERY user for five minutes.
   *
   * Buckets are keyed by identity, and the in-flight entry is deleted in a
   * `finally`, so only the breaker map persists — bounded by the member count.
   */
  private readonly circuits = new Map<string, CircuitState>();
  private readonly inFlight = new Map<string, Promise<ProviderModelsDefinition>>();

  constructor(options: VendorCatalogClientOptions) {
    this.options = options;
  }

  private degradedFallback(): ProviderModelsDefinition {
    return { ...this.options.fallback, degraded: true };
  }

  /** Resets breaker + in-flight state for ALL identities. Unit tests only. */
  reset(): void {
    this.circuits.clear();
    this.inFlight.clear();
  }

  private circuitFor(key: string): CircuitState {
    const existing = this.circuits.get(key);
    if (existing) {
      return existing;
    }
    const fresh: CircuitState = { consecutiveFailures: 0, openUntil: 0 };
    this.circuits.set(key, fresh);
    return fresh;
  }

  private recordSuccess(key: string): void {
    // A healthy identity keeps no breaker entry at all — this is also what keeps
    // the map from growing one dead entry per identity that ever succeeded.
    this.circuits.delete(key);
  }

  private recordFailure(key: string, now: number): void {
    const circuit = this.circuitFor(key);
    circuit.consecutiveFailures += 1;
    if (circuit.consecutiveFailures >= CIRCUIT_FAILURE_THRESHOLD) {
      circuit.openUntil = now + CIRCUIT_COOLDOWN_MS;
    }
  }

  /**
   * Performs the live fetch with an abort timeout. Returns the parsed catalog, or
   * `null` on any failure (no key, network/HTTP/parse error). Never throws.
   */
  private async fetchLive(identity: CatalogIdentity): Promise<ProviderModelsDefinition | null> {
    const apiKey = await this.options.getApiKey(identity);
    if (!apiKey) {
      return null;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const response = await fetch(this.options.modelsUrl, {
        method: 'GET',
        headers: {
          // Both header forms are accepted by these Anthropic-compatible gateways;
          // sending both keeps the client tolerant of either expectation. Neither
          // is an ANTHROPIC_* env var — the key is a transient header value only.
          Authorization: `Bearer ${apiKey}`,
          'x-api-key': apiKey,
          'Content-Type': 'application/json',
        },
        signal: controller.signal,
      });

      if (!response.ok) {
        await response.body?.cancel();
        return null;
      }

      const body = (await response.json()) as unknown;
      return parseVendorCatalog(body, this.options.fallback);
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Returns the vendor model catalog: the live list when reachable, otherwise the
   * provider fallback flagged `degraded: true`. Honours the circuit breaker and
   * coalesces concurrent calls. Never throws.
   */
  async getCatalog(identity: CatalogIdentity): Promise<ProviderModelsDefinition> {
    const key = identityKey(identity);
    const now = Date.now();
    // Read without creating: a lookup must not leave a breaker entry behind, or
    // the map would grow one row per identity that ever asked.
    if ((this.circuits.get(key)?.openUntil ?? 0) > now) {
      return this.degradedFallback();
    }

    const existing = this.inFlight.get(key);
    if (existing) {
      return existing;
    }

    const probe = (async () => {
      try {
        const live = await this.fetchLive(identity);
        if (live) {
          this.recordSuccess(key);
          return live;
        }
        this.recordFailure(key, Date.now());
        return this.degradedFallback();
      } finally {
        this.inFlight.delete(key);
      }
    })();

    this.inFlight.set(key, probe);
    return probe;
  }
}
