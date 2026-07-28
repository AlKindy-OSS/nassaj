import { McpProvider } from '@/modules/providers/shared/mcp/mcp.provider.js';
import type { LLMProvider, McpScope, ProviderMcpServer, UpsertProviderMcpServerInput } from '@/shared/types.js';

/**
 * MCP facet for hosted vendor providers (kimi/deepseek/glm).
 *
 * These providers are remote HTTP APIs with no local agent that reads an MCP
 * config file, so there is no provider-native MCP store to manage. Rather than
 * leave the facet unimplemented (the contract requires all six), this extends the
 * shared `McpProvider` with NO supported scopes/transports: `listServers` returns
 * empty groups and any upsert/remove is rejected with the standard
 * "scope not supported" error from the base. The abstract read/write/build hooks
 * are implemented as no-ops to satisfy the type, but the empty scope list means
 * they are never reached.
 */
export class VendorMcpProvider extends McpProvider {
  constructor(provider: LLMProvider) {
    super(provider, [], []);
  }

  protected async readScopedServers(): Promise<Record<string, unknown>> {
    return {};
  }

  protected async writeScopedServers(): Promise<void> {
    // No vendor-native MCP store: writes are unreachable (no supported scopes).
  }

  protected buildServerConfig(_input: UpsertProviderMcpServerInput): Record<string, unknown> {
    return {};
  }

  protected normalizeServerConfig(
    _scope: McpScope,
    _name: string,
    _rawConfig: unknown,
  ): ProviderMcpServer | null {
    return null;
  }
}
