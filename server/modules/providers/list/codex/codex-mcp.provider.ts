import fs from 'node:fs';
import type { Stats } from 'node:fs';
import { open, readFile, rename, rm, stat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

import TOML from '@iarna/toml';

import { McpProvider } from '@/modules/providers/shared/mcp/mcp.provider.js';
import { resolveProviderEnv } from '@/services/isolation/resolve-provider-env.js';
import type { McpScope, ProviderMcpServer, UpsertProviderMcpServerInput } from '@/shared/types.js';
import {
  AppError,
  ensurePrivateConfigDirectory,
  readObjectRecord,
  readOptionalString,
  readStringArray,
  readStringRecord,
} from '@/shared/utils.js';

const parseTomlConfig = (content: string): Record<string, unknown> => {
  const parsed = TOML.parse(content) as Record<string, unknown>;
  return readObjectRecord(parsed) ?? {};
};

const readTomlConfig = async (filePath: string): Promise<Record<string, unknown>> => {
  try {
    const content = await readFile(filePath, 'utf8');
    return parseTomlConfig(content);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      return {};
    }
    throw error;
  }
};

const writeTomlConfig = async (
  filePath: string,
  data: Record<string, unknown>,
  directoryPrepared = false,
  beforePromotion?: () => Promise<void>,
  recordPromotion?: (stat: Stats, content: string) => void,
): Promise<void> => {
  if (!directoryPrepared) await ensurePrivateConfigDirectory(path.dirname(filePath), 0o700);
  const toml = TOML.stringify(data as never);
  const tmpPath = `${filePath}.tmp-${process.pid}-${randomUUID()}`;
  let staged: Awaited<ReturnType<typeof open>> | null = null;
  try {
    staged = await open(
      tmpPath,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
      0o600,
    );
    await staged.chmod(0o600);
    await staged.writeFile(toml, 'utf8');
    await staged.sync();
    await beforePromotion?.();
    await rename(tmpPath, filePath);
    recordPromotion?.(await staged.stat(), toml);
    await staged.close();
    staged = null;
    const persistedMode = (await stat(filePath)).mode & 0o777;
    if (persistedMode !== 0o600) {
      throw new AppError(`Refusing insecure Codex MCP config mode ${persistedMode.toString(8)}.`, {
        code: 'MCP_CONFIG_INSECURE_MODE',
        statusCode: 500,
      });
    }
  } catch (error) {
    await staged?.close().catch(() => {});
    await rm(tmpPath, { force: true }).catch(() => {});
    throw error;
  }
};

export class CodexMcpProvider extends McpProvider {
  protected override readonly usesLegacyCleanupLock = true;

  constructor() {
    // writesPerUserConfig: userConfigPath resolves CODEX_HOME per caller.
    // Codex CLI 0.147.0 only documents and reads MCP servers from
    // $CODEX_HOME/config.toml.  It does not discover <workspace>/.codex/config.toml;
    // advertising project scope therefore produced a file the real reader ignored
    // (B-751).  Keep the proven user scope and reject project explicitly.
    super('codex', ['user'], ['stdio', 'http'], true);
  }

  private userConfigPath(userId?: string | number | null): string {
    // Internal/operator callers have no member identity to isolate.  Sending a
    // null id through userConfigDir would create a literal `.nassaj-users/null`
    // tree that no real Codex process reads. Authenticated routes always pass
    // their member id and therefore still use the isolated CODEX_HOME below.
    if (userId === null || userId === undefined || userId === '') {
      return path.join(
        process.env.CODEX_HOME || path.join(process.env.HOME || os.homedir(), '.codex'),
        'config.toml',
      );
    }
    const env = resolveProviderEnv(userId ?? null, 'codex', process.env);
    return path.join(env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'config.toml');
  }

  protected scopedConfigPath(
    scope: McpScope,
    workspacePath: string,
    userId?: string | number | null,
  ): string {
    if (scope !== 'user') {
      throw new AppError('Codex CLI does not support project-scoped MCP configuration.', {
        code: 'MCP_SCOPE_NOT_SUPPORTED',
        statusCode: 400,
      });
    }
    return this.userConfigPath(userId);
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
      ? await readTomlConfig(filePath)
      : transactionSnapshot === null ? {} : parseTomlConfig(transactionSnapshot);
    return readObjectRecord(config.mcp_servers) ?? {};
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
      ? await readTomlConfig(filePath)
      : transactionSnapshot === null ? {} : parseTomlConfig(transactionSnapshot);
    config.mcp_servers = servers;
    await writeTomlConfig(
      filePath,
      config,
      transactionPath !== undefined,
      beforePromotion,
      recordPromotion,
    );
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
        env_vars: input.envVars ?? [],
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
      bearer_token_env_var: input.bearerTokenEnvVar,
      http_headers: input.headers ?? {},
      env_http_headers: input.envHttpHeaders ?? {},
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
        provider: 'codex',
        name,
        scope,
        transport: 'stdio',
        command: config.command,
        args: readStringArray(config.args),
        env: readStringRecord(config.env),
        cwd: readOptionalString(config.cwd),
        envVars: readStringArray(config.env_vars),
      };
    }

    if (typeof config.url === 'string') {
      return {
        provider: 'codex',
        name,
        scope,
        transport: 'http',
        url: config.url,
        headers: readStringRecord(config.http_headers),
        bearerTokenEnvVar: readOptionalString(config.bearer_token_env_var),
        envHttpHeaders: readStringRecord(config.env_http_headers),
      };
    }

    return null;
  }
}
