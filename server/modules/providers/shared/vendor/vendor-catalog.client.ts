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

export type VendorCatalogClientOptions = {
  /** Stable provider id used to key the per-provider breaker/in-flight state. */
  provider: string;
  /** Fully-qualified Anthropic-compatible models endpoint, e.g. `<base>/v1/models`. */
  modelsUrl: string;
  /** Returns the current user's API key (or null when none is configured). */
  getApiKey: () => string | null | Promise<string | null>;
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
  private readonly circuit: CircuitState = { consecutiveFailures: 0, openUntil: 0 };
  private inFlight: Promise<ProviderModelsDefinition> | null = null;

  constructor(options: VendorCatalogClientOptions) {
    this.options = options;
  }

  private degradedFallback(): ProviderModelsDefinition {
    return { ...this.options.fallback, degraded: true };
  }

  /** Resets breaker + in-flight state. Exported behavior for unit tests only. */
  reset(): void {
    this.circuit.consecutiveFailures = 0;
    this.circuit.openUntil = 0;
    this.inFlight = null;
  }

  private recordSuccess(): void {
    this.circuit.consecutiveFailures = 0;
    this.circuit.openUntil = 0;
  }

  private recordFailure(now: number): void {
    this.circuit.consecutiveFailures += 1;
    if (this.circuit.consecutiveFailures >= CIRCUIT_FAILURE_THRESHOLD) {
      this.circuit.openUntil = now + CIRCUIT_COOLDOWN_MS;
    }
  }

  /**
   * Performs the live fetch with an abort timeout. Returns the parsed catalog, or
   * `null` on any failure (no key, network/HTTP/parse error). Never throws.
   */
  private async fetchLive(): Promise<ProviderModelsDefinition | null> {
    const apiKey = await this.options.getApiKey();
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
  async getCatalog(): Promise<ProviderModelsDefinition> {
    const now = Date.now();
    if (this.circuit.openUntil > now) {
      return this.degradedFallback();
    }

    if (this.inFlight) {
      return this.inFlight;
    }

    this.inFlight = (async () => {
      try {
        const live = await this.fetchLive();
        if (live) {
          this.recordSuccess();
          return live;
        }
        this.recordFailure(Date.now());
        return this.degradedFallback();
      } finally {
        this.inFlight = null;
      }
    })();

    return this.inFlight;
  }
}
