import os from 'node:os';
import path from 'node:path';
import type { Stats } from 'node:fs';

import { McpProvider } from '@/modules/providers/shared/mcp/mcp.provider.js';
import { resolveProviderEnv } from '@/services/isolation/resolve-provider-env.js';
import type { McpScope, ProviderMcpServer, UpsertProviderMcpServerInput } from '@/shared/types.js';
import {
  AppError,
  readJsonConfig,
  readObjectRecord,
  readOptionalString,
  readStringArray,
  readStringRecord,
  writeJsonConfigAtomic,
} from '@/shared/utils.js';

const jsonTransactionConfig = (snapshot: string | null): Record<string, unknown> => {
  if (snapshot === null) return {};
  return readObjectRecord(JSON.parse(snapshot) as unknown) ?? {};
};

/**
 * Native MCP adapter for the installed agy/Antigravity CLI.
 *
 * Measured against agy 1.1.19: both `agy mcp add` and `agy mcp list` use
 * $HOME/.gemini/config/mcp_config.json with a top-level `mcpServers` map.
 * Only user scope is advertised because no workspace/project config reader is
 * documented or observed.
 */
export class AntigravityMcpProvider extends McpProvider {
  protected override readonly usesLegacyCleanupLock = true;

  constructor() {
    super('antigravity', ['user'], ['stdio', 'http'], true);
  }

  protected scopedConfigPath(
    scope: McpScope,
    _workspacePath: string,
    userId?: string | number | null,
  ): string {
    if (scope !== 'user') {
      throw new AppError('Antigravity CLI supports only user-scoped MCP configuration.', {
        code: 'MCP_SCOPE_NOT_SUPPORTED',
        statusCode: 400,
      });
    }
    const env = resolveProviderEnv(userId ?? null, 'agy', process.env);
    return path.join(env.HOME || os.homedir(), '.gemini', 'config', 'mcp_config.json');
  }

  protected async readScopedServers(
    scope: McpScope,
    workspacePath: string,
    userId?: string | number | null,
    transactionPath?: string,
    transactionSnapshot?: string | null,
  ): Promise<Record<string, unknown>> {
    const config = transactionSnapshot === undefined
      ? await readJsonConfig(transactionPath ?? this.scopedConfigPath(scope, workspacePath, userId))
      : jsonTransactionConfig(transactionSnapshot);
    return readObjectRecord(config.mcpServers) ?? {};
  }

  protected async writeScopedServers(
    scope: McpScope,
    workspacePath: string,
    servers: Record<string, unknown>,
    userId?: string | number | null,
    transactionPath?: string,
    transactionSnapshot?: string | null,
    beforePromotion?: () => Promise<void>,
    recordPromotion?: (stat: Stats, content: string) => void,
  ): Promise<void> {
    const filePath = transactionPath ?? this.scopedConfigPath(scope, workspacePath, userId);
    const config = transactionSnapshot === undefined
      ? await readJsonConfig(filePath)
      : jsonTransactionConfig(transactionSnapshot);
    config.mcpServers = servers;
    await writeJsonConfigAtomic(filePath, config, {
      mode: 0o600,
      directoryMode: transactionPath ? undefined : 0o700,
      directoryPrepared: transactionPath !== undefined,
      beforePromotion,
      recordPromotion,
      verifyMode: true,
    });
  }

  protected buildServerConfig(input: UpsertProviderMcpServerInput): Record<string, unknown> {
    if (input.transport === 'stdio') {
      if (!input.command?.trim()) {
        throw new AppError('command is required for stdio MCP servers.', {
          code: 'MCP_COMMAND_REQUIRED',
          statusCode: 400,
        });
      }
      return {
        command: input.command,
        args: input.args ?? [],
        env: input.env ?? {},
        disabled: false,
      };
    }

    if (!input.url?.trim()) {
      throw new AppError('url is required for http MCP servers.', {
        code: 'MCP_URL_REQUIRED',
        statusCode: 400,
      });
    }
    return {
      serverUrl: input.url,
      headers: input.headers ?? {},
      disabled: false,
    };
  }

  protected normalizeServerConfig(
    scope: McpScope,
    name: string,
    rawConfig: unknown,
  ): ProviderMcpServer | null {
    const config = readObjectRecord(rawConfig);
    if (!config) return null;

    if (typeof config.command === 'string') {
      return {
        provider: 'antigravity',
        name,
        scope,
        transport: 'stdio',
        command: config.command,
        args: readStringArray(config.args),
        env: readStringRecord(config.env),
      };
    }

    const url = readOptionalString(config.serverUrl);
    if (url) {
      return {
        provider: 'antigravity',
        name,
        scope,
        transport: 'http',
        url,
        headers: readStringRecord(config.headers),
      };
    }

    return null;
  }
}
