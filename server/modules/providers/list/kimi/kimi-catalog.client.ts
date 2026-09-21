import { resolveVendorCatalogKey } from '@/modules/providers/shared/vendor/vendor-catalog-key.js';
import { VENDOR_RUNTIME } from '@/modules/providers/shared/vendor/vendor-config.js';
import { VendorCatalogClient } from '@/modules/providers/shared/vendor/vendor-catalog.client.js';

/**
 * Kimi (Moonshot) live model-catalog client. Hard-coded Anthropic-compatible
 * base URL (`api.moonshot.ai/anthropic`); the only per-user value is the API key,
 * read from KIMI_API_KEY (operator env) or the asking user's secrets store. Never
 * reads or sets any variable under the ANTHROPIC or CLAUDE namespace.
 */
export const kimiCatalogClient = new VendorCatalogClient({
  provider: 'kimi',
  modelsUrl: VENDOR_RUNTIME.kimi.modelsUrl,
  // B-342: the key belongs to the ASKING user. This read was hardcoded to the
  // system scope back when nassaj was single-user, so once keys moved into
  // per-user stores it found nothing and the live catalog silently never ran.
  // B-436: عضو بلا مفتاح شخصي يُشغَّل بمفتاح المؤسسة، فيجب أن يُسرَد به أيضاً
  // — التفاوت بين المسارين كان يعرض نموذجاً واحداً بينما المزوّد يخدم ثمانية.
  getApiKey: (identity) => process.env.KIMI_API_KEY ?? resolveVendorCatalogKey(identity, 'kimi'),
  fallback: VENDOR_RUNTIME.kimi.fallbackModels,
});
