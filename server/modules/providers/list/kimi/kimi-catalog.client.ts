import { getProviderKey } from '@/services/isolation/provider-secrets-store.js';
import { VENDOR_RUNTIME } from '@/modules/providers/shared/vendor/vendor-config.js';
import { VendorCatalogClient } from '@/modules/providers/shared/vendor/vendor-catalog.client.js';

/**
 * Kimi (Moonshot) live model-catalog client. Hard-coded Anthropic-compatible
 * base URL (`api.moonshot.ai/anthropic`); the only per-user value is the API key,
 * read from KIMI_API_KEY (operator env) or the single-user secrets store. Never
 * reads or sets any variable under the ANTHROPIC or CLAUDE namespace.
 */
export const kimiCatalogClient = new VendorCatalogClient({
  provider: 'kimi',
  modelsUrl: VENDOR_RUNTIME.kimi.modelsUrl,
  getApiKey: () => process.env.KIMI_API_KEY ?? getProviderKey(null, 'kimi'),
  fallback: VENDOR_RUNTIME.kimi.fallbackModels,
});
