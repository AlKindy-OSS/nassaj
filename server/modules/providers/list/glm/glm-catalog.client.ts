import { resolveVendorCatalogKey } from '@/modules/providers/shared/vendor/vendor-catalog-key.js';
import { VENDOR_RUNTIME } from '@/modules/providers/shared/vendor/vendor-config.js';
import { VendorCatalogClient } from '@/modules/providers/shared/vendor/vendor-catalog.client.js';

/**
 * GLM (Zhipu / Z.ai) live model-catalog client. Hard-coded Anthropic-compatible
 * base URL (`api.z.ai/api/anthropic`); the only per-user value is the API key,
 * read from GLM_API_KEY (operator env) or the asking user's secrets store. Never
 * reads or sets any variable under the ANTHROPIC or CLAUDE namespace.
 */
export const glmCatalogClient = new VendorCatalogClient({
  provider: 'glm',
  modelsUrl: VENDOR_RUNTIME.glm.modelsUrl,
  // B-342: the key belongs to the ASKING user. This read was hardcoded to the
  // system scope back when nassaj was single-user, so once keys moved into
  // per-user stores it found nothing and the live catalog silently never ran.
  // B-436: عضو بلا مفتاح شخصي يُشغَّل بمفتاح المؤسسة، فيجب أن يُسرَد به أيضاً
  // — التفاوت بين المسارين كان يعرض نموذجاً واحداً بينما المزوّد يخدم ثمانية.
  getApiKey: (identity) => process.env.GLM_API_KEY ?? resolveVendorCatalogKey(identity, 'glm'),
  fallback: VENDOR_RUNTIME.glm.fallbackModels,
});
