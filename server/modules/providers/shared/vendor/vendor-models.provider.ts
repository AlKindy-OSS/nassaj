import type { IProviderModels } from '@/shared/interfaces.js';
import type {
  LLMProvider,
  ProviderChangeActiveModelInput,
  ProviderCurrentActiveModel,
  ProviderModelsDefinition,
  ProviderSessionActiveModelChange,
} from '@/shared/types.js';
import {
  buildDefaultProviderCurrentActiveModel,
  writeProviderSessionActiveModelChange,
} from '@/shared/utils.js';

import { ANONYMOUS_CATALOG_IDENTITY, VendorCatalogClient } from './vendor-catalog.client.js';

export type VendorModelsOptions = {
  provider: LLMProvider;
  /** Built-in catalog used for the default active-model lookup. */
  fallback: ProviderModelsDefinition;
  /** Process-scoped catalog client owning the live fetch + breaker for this provider. */
  catalog: VendorCatalogClient;
};

/**
 * Shared models facet for hosted vendor providers (kimi/deepseek/glm).
 *
 * `getSupportedModels` delegates to the injected process-scoped
 * {@link VendorCatalogClient} (one instance per provider, defined in the
 * provider's `<id>-catalog.client.ts`) that fetches the live `/v1/models` list and
 * degrades to the provider's fallback (never throws). `changeActiveModel` reuses
 * the shared session-scoped resume override store, identical to every other
 * provider.
 */
export class VendorModelsProvider implements IProviderModels {
  private readonly provider: LLMProvider;
  private readonly fallback: ProviderModelsDefinition;
  private readonly catalog: VendorCatalogClient;

  constructor(options: VendorModelsOptions) {
    this.provider = options.provider;
    this.fallback = options.fallback;
    this.catalog = options.catalog;
  }

  /**
   * B-342 — this signature used to take NO argument while the interface declared
   * `getSupportedModels(userId?)` and the service passed one. The identity
   * arrived at this door and was dropped on the floor, so the catalog client
   * asked for "the system's key" on behalf of every user and always found none:
   * the live fetch never ran once, and every user saw a frozen fallback list.
   *
   * `ANONYMOUS_CATALOG_IDENTITY` is the explicit stand-in for a caller with no
   * authenticated user, so "nobody in particular" stays a decision instead of a
   * silent null. T-1260 renamed it away from the store's system scope: this
   * value picks a CACHE BUCKET, and must not double as "spend the org's key".
   */
  async getSupportedModels(userId?: string | number | null): Promise<ProviderModelsDefinition> {
    return this.catalog.getCatalog(userId ?? ANONYMOUS_CATALOG_IDENTITY);
  }

  async getCurrentActiveModel(): Promise<ProviderCurrentActiveModel> {
    return buildDefaultProviderCurrentActiveModel(this.fallback);
  }

  async changeActiveModel(
    input: ProviderChangeActiveModelInput,
  ): Promise<ProviderSessionActiveModelChange> {
    return writeProviderSessionActiveModelChange(this.provider, input);
  }

  /** Exposed for unit tests to reset the catalog breaker/in-flight state. */
  _resetCatalog(): void {
    this.catalog.reset();
  }
}
