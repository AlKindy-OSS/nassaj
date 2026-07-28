import { getProviderKey } from '@/services/isolation/provider-secrets-store.js';
import { VENDOR_RUNTIME } from '@/modules/providers/shared/vendor/vendor-config.js';
import { VendorCatalogClient } from '@/modules/providers/shared/vendor/vendor-catalog.client.js';

/**
 * DeepSeek live model-catalog client. Hard-coded Anthropic-compatible base URL
 * (`api.deepseek.com/anthropic`); the only per-user value is the API key, read
 * from DEEPSEEK_API_KEY (operator env) or the single-user secrets store. Never
 * reads or sets any variable under the ANTHROPIC or CLAUDE namespace.
 */
export const deepseekCatalogClient = new VendorCatalogClient({
  provider: 'deepseek',
  modelsUrl: VENDOR_RUNTIME.deepseek.modelsUrl,
  getApiKey: () => process.env.DEEPSEEK_API_KEY ?? getProviderKey(null, 'deepseek'),
  fallback: VENDOR_RUNTIME.deepseek.fallbackModels,
});
