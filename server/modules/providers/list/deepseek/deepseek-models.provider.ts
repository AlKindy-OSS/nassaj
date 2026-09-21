import { VendorModelsProvider } from '@/modules/providers/shared/vendor/vendor-models.provider.js';
import { DEEPSEEK_FALLBACK_MODELS } from '@/modules/providers/shared/vendor/vendor-config.js';

import { deepseekCatalogClient } from './deepseek-catalog.client.js';

/**
 * DeepSeek model catalog. Live `/v1/models` via {@link deepseekCatalogClient}
 * with a conservative fallback to {@link DEEPSEEK_FALLBACK_MODELS} (degraded,
 * never throws). The deprecated v3 ids are intentionally omitted from the
 * fallback; the live catalog supersedes it when reachable.
 */
export { DEEPSEEK_FALLBACK_MODELS };

export class DeepSeekProviderModels extends VendorModelsProvider {
  constructor() {
    super({ provider: 'deepseek', fallback: DEEPSEEK_FALLBACK_MODELS, catalog: deepseekCatalogClient });
  }
}
