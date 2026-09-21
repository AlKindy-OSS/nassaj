import { VendorMcpProvider } from '@/modules/providers/shared/vendor/vendor-mcp.provider.js';

/**
 * Kimi MCP facet: no vendor-native MCP store (remote HTTP API), so the shared
 * vendor base exposes an empty server set. Present to satisfy the six-facet
 * contract.
 */
export class KimiMcpProvider extends VendorMcpProvider {
  constructor() {
    super('kimi');
  }
}
