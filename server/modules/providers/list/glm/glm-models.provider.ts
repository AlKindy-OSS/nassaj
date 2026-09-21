import { VendorModelsProvider } from '@/modules/providers/shared/vendor/vendor-models.provider.js';
import { GLM_FALLBACK_MODELS } from '@/modules/providers/shared/vendor/vendor-config.js';

import { glmCatalogClient } from './glm-catalog.client.js';

/**
 * GLM (Zhipu/Z.ai) model catalog. Live `/v1/models` via {@link glmCatalogClient}
 * with a conservative fallback to {@link GLM_FALLBACK_MODELS} (degraded, never
 * throws). The live catalog supersedes the fallback id (e.g. a newer GLM
 * generation) when reachable.
 */
export { GLM_FALLBACK_MODELS };

export class GlmProviderModels extends VendorModelsProvider {
  constructor() {
    super({ provider: 'glm', fallback: GLM_FALLBACK_MODELS, catalog: glmCatalogClient });
  }
}
