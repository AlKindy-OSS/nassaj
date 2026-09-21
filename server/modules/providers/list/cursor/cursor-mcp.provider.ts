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

export class CursorMcpProvider extends McpProvider {
  protected override readonly usesLegacyCleanupLock = true;

  constructor() {
    // cursor-agent derives ~/.cursor from HOME. resolveProviderEnv sets the same
    // per-member HOME for the real spawn, so the writer and reader now agree.
    super('cursor', ['user', 'project'], ['stdio', 'http'], true);
  }

  protected scopedConfigPath(
    scope: McpScope,
    workspacePath: string,
    userId?: string | number | null,
  ): string {
    const env = resolveProviderEnv(userId ?? null, 'cursor', process.env);
    return scope === 'user'
      ? path.join(env.HOME || os.homedir(), '.cursor', 'mcp.json')
      : path.join(workspacePath, '.cursor', 'mcp.json');
  }

  protected async readScopedServers(
    scope: McpScope,
    workspacePath: string,
    userId?: string | number | null,
    transactionPath?: string,
    transactionSnapshot?: string | null,
  ): Promise<Record<string, unknown>> {
    const filePath = transactionPath ?? this.scopedConfigPath(scope, workspacePath, userId);
    const config = transactionSnapshot === undefined
      ? await readJsonConfig(filePath)
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
    // T-1230 — atomic + 0600 like the other MCP writers: this file may now hold a
    // connector's API key (ADR-098), and a truncating write can leave it torn.
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
        cwd: input.cwd,
      };
    }

    if (!input.url?.trim()) {
      throw new AppError('url is required for http MCP servers.', {
        code: 'MCP_URL_REQUIRED',
        statusCode: 400,
      });
    }

    return {
      url: input.url,
      headers: input.headers ?? {},
    };
  }

  protected normalizeServerConfig(
    scope: McpScope,
    name: string,
    rawConfig: unknown,
  ): ProviderMcpServer | null {
    if (!rawConfig || typeof rawConfig !== 'object') {
      return null;
    }

    const config = rawConfig as Record<string, unknown>;
    if (typeof config.command === 'string') {
      return {
        provider: 'cursor',
        name,
        scope,
        transport: 'stdio',
        command: config.command,
        args: readStringArray(config.args),
        env: readStringRecord(config.env),
        cwd: readOptionalString(config.cwd),
      };
    }

    if (typeof config.url === 'string') {
      return {
        provider: 'cursor',
        name,
        scope,
        transport: 'http',
        url: config.url,
        headers: readStringRecord(config.headers),
      };
    }

    return null;
  }
}
