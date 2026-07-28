import type { IProviderMcp } from '@/shared/interfaces.js';
import type {
  LLMProvider,
  McpScope,
  ProviderMcpServer,
  UpsertProviderMcpServerInput,
} from '@/shared/types.js';
import { AppError } from '@/shared/utils.js';

/**
 * MCP adapter for the Antigravity (agy) CLI.
 *
 * agy currently acts as an MCP client, not a host that exposes its own MCP server
 * registry. To keep the provider contract uniform without lying about supported
 * scopes/transports, listing methods return empty collections and any write
 * operation is rejected with a stable error code. When agy gains a real MCP
 * config surface, this stub should be replaced by a concrete `McpProvider`
 * subclass that reads/writes the native config files.
 */
export class AntigravityMcpProvider implements IProviderMcp {
  private readonly provider: LLMProvider = 'antigravity';

  async listServers(_options?: { workspacePath?: string }): Promise<Record<McpScope, ProviderMcpServer[]>> {
    return {
      user: [],
      local: [],
      project: [],
    };
  }

  async listServersForScope(
    _scope: McpScope,
    _options?: { workspacePath?: string },
  ): Promise<ProviderMcpServer[]> {
    return [];
  }

  async upsertServer(_input: UpsertProviderMcpServerInput): Promise<ProviderMcpServer> {
    throw new AppError('Antigravity provider does not support MCP server management.', {
      code: 'MCP_NOT_SUPPORTED_BY_PROVIDER',
      statusCode: 400,
    });
  }

  async removeServer(
    input: { name: string; scope?: McpScope; workspacePath?: string },
  ): Promise<{ removed: boolean; provider: LLMProvider; name: string; scope: McpScope }> {
    return {
      removed: false,
      provider: this.provider,
      name: input.name,
      scope: input.scope ?? 'project',
    };
  }
}
