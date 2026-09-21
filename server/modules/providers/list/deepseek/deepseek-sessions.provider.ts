import { VendorSessionsProvider } from '@/modules/providers/shared/vendor/vendor-sessions.provider.js';
import { extractDeepSeekTextualToolCall } from '@/modules/providers/shared/vendor/vendor-config.js';

/**
 * DeepSeek sessions facet. DeepSeek occasionally emits a tool call as plain
 * assistant text (~11% of calls), so it wires the DeepSeek-specific
 * {@link extractDeepSeekTextualToolCall} rescue hook into the shared vendor
 * normalizer; everything else (Anthropic event mapping, JSONL history) is shared.
 */
export class DeepSeekSessionsProvider extends VendorSessionsProvider {
  constructor() {
    super({ provider: 'deepseek', extractTextualToolCall: extractDeepSeekTextualToolCall });
  }
}
