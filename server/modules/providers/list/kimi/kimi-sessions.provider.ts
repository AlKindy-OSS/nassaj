import { VendorSessionsProvider } from '@/modules/providers/shared/vendor/vendor-sessions.provider.js';

/**
 * Kimi sessions facet. Kimi speaks the Anthropic Messages event vocabulary, so it
 * uses the shared vendor normalizer as-is (no textual-tool-call rescue needed —
 * that quirk is DeepSeek-specific). History is read from the nassaj-owned JSONL
 * transcript.
 */
export class KimiSessionsProvider extends VendorSessionsProvider {
  constructor() {
    super({ provider: 'kimi' });
  }
}
