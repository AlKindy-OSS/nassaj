import { VendorMcpProvider } from '@/modules/providers/shared/vendor/vendor-mcp.provider.js';

/**
 * DeepSeek MCP facet: no vendor-native MCP store (remote HTTP API). Empty server
 * set, present to satisfy the six-facet contract.
 */
export class DeepSeekMcpProvider extends VendorMcpProvider {
  constructor() {
    super('deepseek');
  }
}
