import { getProviderKey } from '@/services/isolation/provider-secrets-store.js';
import { VENDOR_RUNTIME } from '@/modules/providers/shared/vendor/vendor-config.js';
import { VendorCatalogClient } from '@/modules/providers/shared/vendor/vendor-catalog.client.js';

/**
 * GLM (Zhipu / Z.ai) live model-catalog client. Hard-coded Anthropic-compatible
 * base URL (`api.z.ai/api/anthropic`); the only per-user value is the API key,
 * read from GLM_API_KEY (operator env) or the single-user secrets store. Never
 * reads or sets any variable under the ANTHROPIC or CLAUDE namespace.
 */
export const glmCatalogClient = new VendorCatalogClient({
  provider: 'glm',
  modelsUrl: VENDOR_RUNTIME.glm.modelsUrl,
  getApiKey: () => process.env.GLM_API_KEY ?? getProviderKey(null, 'glm'),
  fallback: VENDOR_RUNTIME.glm.fallbackModels,
});
