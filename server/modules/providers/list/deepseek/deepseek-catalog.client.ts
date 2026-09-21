import { resolveVendorCatalogKey } from '@/modules/providers/shared/vendor/vendor-catalog-key.js';
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
  // B-342: the key belongs to the ASKING user. This read was hardcoded to the
  // system scope back when nassaj was single-user, so once keys moved into
  // per-user stores it found nothing and the live catalog silently never ran.
  // B-436: عضو بلا مفتاح شخصي يُشغَّل بمفتاح المؤسسة، فيجب أن يُسرَد به أيضاً
  // — التفاوت بين المسارين كان يعرض نموذجاً واحداً بينما المزوّد يخدم ثمانية.
  getApiKey: (identity) => process.env.DEEPSEEK_API_KEY ?? resolveVendorCatalogKey(identity, 'deepseek'),
  fallback: VENDOR_RUNTIME.deepseek.fallbackModels,
});
