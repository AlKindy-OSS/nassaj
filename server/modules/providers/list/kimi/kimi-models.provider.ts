import { VendorModelsProvider } from '@/modules/providers/shared/vendor/vendor-models.provider.js';
import { KIMI_FALLBACK_MODELS } from '@/modules/providers/shared/vendor/vendor-config.js';

import { kimiCatalogClient } from './kimi-catalog.client.js';

/**
 * Kimi (Moonshot) model catalog. Live `/v1/models` via {@link kimiCatalogClient}
 * with a conservative fallback to {@link KIMI_FALLBACK_MODELS} (flagged degraded,
 * never throws). Re-exported so the live model id (e.g. a promoted kimi-k2.7-code)
 * always surfaces when the endpoint is reachable.
 */
export { KIMI_FALLBACK_MODELS };

export class KimiProviderModels extends VendorModelsProvider {
  constructor() {
    super({ provider: 'kimi', fallback: KIMI_FALLBACK_MODELS, catalog: kimiCatalogClient });
  }
}
