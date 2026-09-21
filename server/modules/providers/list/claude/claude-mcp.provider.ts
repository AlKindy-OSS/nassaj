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

/**
 * Resolves the `.claude.json` that THIS user's claude spawns actually read (B-384).
 *
 * The bug this closes: both sides used `os.homedir()/.claude.json` — the OPERATOR's
 * file — while every spawn runs with `CLAUDE_CONFIG_DIR=~/.nassaj-users/<id>/.claude`
 * (resolveProviderEnv, B-ISO-CLAUDE). `loadMcpConfig` in claude-sdk.js was already
 * fixed to read the per-user file (B-346), so the writer was the remaining half of the
 * split: a server registered from the UI landed in a file no agent ever reads. Measured
 * before the fix: the operator file held `mcpServers:['playwright']` while all six
 * member files held `[]`.
 *
 * The `|| os.homedir()` fallback is load-bearing, not defensive padding: it makes this
 * path FOLLOW the `provider_sharing` policy automatically. When claude is `isolated`
 * resolveProviderEnv sets CLAUDE_CONFIG_DIR and both sides use the member tree; when it
 * is `shared` it sets nothing and both sides fall back to the operator file — so the
 * reader and the writer can never split again on a policy flip. The same expression is
 * what `loadMcpConfig` resolves, which is what the parity test pins.
 */
const claudeConfigFilePath = (userId?: string | number | null): string => {
  const env = resolveProviderEnv(userId ?? null, 'claude', process.env);
  return path.join(env.CLAUDE_CONFIG_DIR || os.homedir(), '.claude.json');
};

const jsonTransactionConfig = (snapshot: string | null): Record<string, unknown> => {
  if (snapshot === null) return {};
  const parsed = JSON.parse(snapshot) as unknown;
  return readObjectRecord(parsed) ?? {};
};

export class ClaudeMcpProvider extends McpProvider {
  protected override readonly usesLegacyCleanupLock = true;

  constructor() {
    // writesPerUserConfig: claudeConfigFilePath resolves CLAUDE_CONFIG_DIR from the
    // caller's userId (B-384), so user/local bytes land in that member's tree alone.
    super('claude', ['user', 'local', 'project'], ['stdio', 'http', 'sse'], true);
  }

  protected override secureWriterParent(scope: McpScope): boolean {
    return scope !== 'project';
  }

  protected scopedConfigPath(
    scope: McpScope,
    workspacePath: string,
    userId?: string | number | null,
  ): string {
    return scope === 'project'
      ? path.join(workspacePath, '.mcp.json')
      : claudeConfigFilePath(userId);
  }

  protected async readScopedServers(
    scope: McpScope,
    workspacePath: string,
    userId?: string | number | null,
    transactionPath?: string,
    transactionSnapshot?: string | null,
  ): Promise<Record<string, unknown>> {
    if (scope === 'project') {
      const filePath = transactionPath ?? path.join(workspacePath, '.mcp.json');
      const config = transactionSnapshot === undefined
        ? await readJsonConfig(filePath)
        : jsonTransactionConfig(transactionSnapshot);
      return readObjectRecord(config.mcpServers) ?? {};
    }

    const filePath = transactionPath ?? claudeConfigFilePath(userId);
    const config = transactionSnapshot === undefined
      ? await readJsonConfig(filePath)
      : jsonTransactionConfig(transactionSnapshot);
    if (scope === 'user') {
      return readObjectRecord(config.mcpServers) ?? {};
    }

    const projects = readObjectRecord(config.projects) ?? {};
    const projectConfig = readObjectRecord(projects[workspacePath]) ?? {};
    return readObjectRecord(projectConfig.mcpServers) ?? {};
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
    if (scope === 'project') {
      const filePath = transactionPath ?? path.join(workspacePath, '.mcp.json');
      const config = transactionSnapshot === undefined
        ? await readJsonConfig(filePath)
        : jsonTransactionConfig(transactionSnapshot);
      config.mcpServers = servers;
      await writeJsonConfigAtomic(filePath, config, {
        mode: 0o600,
        beforePromotion,
        recordPromotion,
        verifyMode: true,
      });
      return;
    }

    // `.claude.json` is a live credential-bearing file the CLI rewrites on its own, so
    // this side writes atomically at 0600 (see writeJsonConfigAtomic) rather than
    // truncating in place. The remaining last-writer-wins race against a RUNNING CLI is
    // a documented limit — the confirm-read below turns a lost write into a loud error
    // instead of a server that silently never appears.
    const filePath = transactionPath ?? claudeConfigFilePath(userId);
    const config = transactionSnapshot === undefined
      ? await readJsonConfig(filePath)
      : jsonTransactionConfig(transactionSnapshot);
    if (scope === 'user') {
      config.mcpServers = servers;
      await writeJsonConfigAtomic(filePath, config, {
        mode: 0o600,
        directoryMode: transactionPath ? undefined : 0o700,
        directoryPrepared: transactionPath !== undefined,
        beforePromotion,
        recordPromotion,
        verifyMode: true,
      });
      await this.confirmScopedWrite(filePath, servers, (persisted) => readObjectRecord(persisted.mcpServers));
      return;
    }

    const projects = readObjectRecord(config.projects) ?? {};
    const projectConfig = readObjectRecord(projects[workspacePath]) ?? {};
    projectConfig.mcpServers = servers;
    projects[workspacePath] = projectConfig;
    config.projects = projects;
    await writeJsonConfigAtomic(filePath, config, {
      mode: 0o600,
      directoryMode: transactionPath ? undefined : 0o700,
      directoryPrepared: transactionPath !== undefined,
      beforePromotion,
      recordPromotion,
      verifyMode: true,
    });
    await this.confirmScopedWrite(filePath, servers, (persisted) => {
      const persistedProjects = readObjectRecord(persisted.projects) ?? {};
      return readObjectRecord(readObjectRecord(persistedProjects[workspacePath])?.mcpServers);
    });
  }

  /**
   * Re-reads what actually landed on disk and fails loudly when it does not match.
   *
   * A concurrent CLI flush can overwrite our file between our read and our rename; the
   * write itself still "succeeds", so without this the UI would report success for a
   * server that no longer exists on disk. Comparing the persisted key set (not the full
   * value) keeps this cheap and immune to unrelated keys the CLI legitimately changed.
   */
  private async confirmScopedWrite(
    filePath: string,
    expected: Record<string, unknown>,
    select: (persisted: Record<string, unknown>) => Record<string, unknown> | null | undefined,
  ): Promise<void> {
    const persisted = select(await readJsonConfig(filePath)) ?? {};
    const missing = Object.keys(expected).filter((name) => !(name in persisted));
    if (missing.length > 0) {
      throw new AppError(
        `MCP config write did not persist (${missing.join(', ')}). A provider CLI may have rewritten the file concurrently — close the running session and retry.`,
        { code: 'MCP_WRITE_NOT_PERSISTED', statusCode: 409 },
      );
    }
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
        type: 'stdio',
        command: input.command,
        args: input.args ?? [],
        env: input.env ?? {},
      };
    }

    if (!input.url?.trim()) {
      throw new AppError('url is required for http/sse MCP servers.', {
        code: 'MCP_URL_REQUIRED',
        statusCode: 400,
      });
    }

    return {
      type: input.transport,
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
        provider: 'claude',
        name,
        scope,
        transport: 'stdio',
        command: config.command,
        args: readStringArray(config.args),
        env: readStringRecord(config.env),
      };
    }

    if (typeof config.url === 'string') {
      const transport = readOptionalString(config.type) === 'sse' ? 'sse' : 'http';
      return {
        provider: 'claude',
        name,
        scope,
        transport,
        url: config.url,
        headers: readStringRecord(config.headers),
      };
    }

    return null;
  }
}
