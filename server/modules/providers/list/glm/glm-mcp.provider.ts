import { VendorMcpProvider } from '@/modules/providers/shared/vendor/vendor-mcp.provider.js';

/**
 * GLM MCP facet: no vendor-native MCP store (remote HTTP API). Empty server set,
 * present to satisfy the six-facet contract.
 */
export class GlmMcpProvider extends VendorMcpProvider {
  constructor() {
    super('glm');
  }
}
