import { VendorSessionsProvider } from '@/modules/providers/shared/vendor/vendor-sessions.provider.js';

/**
 * GLM sessions facet. GLM can break long streaming mid-flight, but the shared
 * vendor design records every event as its own JSONL line and replays the full
 * transcript on history fetch — so streaming length never causes dropped messages
 * in history. GLM speaks the Anthropic event vocabulary, so the shared normalizer
 * is used as-is (no textual-tool-call rescue, which is DeepSeek-specific).
 */
export class GlmSessionsProvider extends VendorSessionsProvider {
  constructor() {
    super({ provider: 'glm' });
  }
}
