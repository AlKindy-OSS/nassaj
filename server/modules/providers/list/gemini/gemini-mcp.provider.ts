import os from 'node:os';
import path from 'node:path';

import { McpProvider } from '@/modules/providers/shared/mcp/mcp.provider.js';
import {
  readLegacyMcpEntries,
  removeLegacyMcpEntry,
} from '@/modules/providers/services/legacy-mcp-cleanup.js';
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
 * Resolves the per-user `settings.json` for the gemini provider (B-384).
 *
 * Gemini carries the SAME split claude had: both sides used the operator's
 * `~/.gemini/settings.json` while `gemini` is `isolated` in the live
 * provider_sharing policy, so anything the UI wrote landed where no spawn would
 * look. The user root is read from the resolver's output so this file and the
 * spawn can never disagree about which tree they mean.
 *
 * B-548: that root used to be read from `env.GEMINI_CLI_HOME`. The CLI reads no
 * such variable (measured — see resolveProviderEnv's `case 'gemini'`), so the
 * resolver now isolates through `HOME`, and this helper follows it. Reading the
 * OLD name here after that change would have silently fallen back to
 * `os.homedir()` — i.e. written every member's MCP servers into the operator's
 * tree — which is exactly the split B-384 closed.
 *
 * `.gemini` is joined here because the resolved value is the user ROOT (the CLI
 * appends `.gemini` itself). Falling back to `os.homedir()` keeps the `shared`
 * policy working unchanged.
 *
 * B-740 containment: on this node the binary behind `gemini` is agy, and agy
 * reads `.gemini/config/mcp_config.json`, NOT this Google gemini-cli path.
 * Consequently the public generic adapter is blocked. This resolver remains
 * only for the cleanup-only adapter that removes residue written by old builds.
 */
const geminiSettingsFilePath = (userId?: string | number | null): string => {
  const env = resolveProviderEnv(userId ?? null, 'gemini', process.env);
  return path.join(env.HOME || os.homedir(), '.gemini', 'settings.json');
};

const historicalCleanupFile = (userId?: string | number | null) => ({
  rootDir: userId === null || userId === undefined || userId === ''
    ? (process.env.HOME || os.homedir())
    : path.join(os.homedir(), '.nassaj-users', String(userId)),
  relativePath: '.gemini/settings.json',
  format: 'json' as const,
  mapKey: 'mcpServers' as const,
});

export class GeminiMcpProvider extends McpProvider {
  private readonly cleanupOnly: boolean;

  constructor(options: { cleanupOnly?: boolean } = {}) {
    const cleanupOnly = options.cleanupOnly === true;
    // The public provider is genuinely dormant: capability discovery must not
    // advertise a pseudo runtime. Only the private historical sweeper can read
    // and remove the old user path.
    super('gemini', cleanupOnly ? ['user'] : [], cleanupOnly ? ['stdio'] : [], cleanupOnly);
    this.cleanupOnly = cleanupOnly;
  }

  private assertCleanupOperation(_operation: 'list' | 'remove'): void {
    if (!this.cleanupOnly) {
      throw new AppError(
        'Gemini MCP management is disabled because the installed runtime is agy and does not read the Google gemini-cli settings path.',
        { code: 'GEMINI_GENERIC_MCP_DISABLED', statusCode: 403 },
      );
    }
  }

  override async listServers(options?: {
    workspacePath?: string;
    userId?: string | number | null;
  }): Promise<Record<McpScope, ProviderMcpServer[]>> {
    this.assertCleanupOperation('list');
    return super.listServers(options);
  }

  override async listServersForScope(
    scope: McpScope,
    options?: { workspacePath?: string; userId?: string | number | null },
  ): Promise<ProviderMcpServer[]> {
    this.assertCleanupOperation('list');
    if (scope !== 'user') return [];
    const servers = await readLegacyMcpEntries(historicalCleanupFile(options?.userId));
    return Object.entries(servers)
      .map(([name, rawConfig]) => this.normalizeServerConfig(scope, name, rawConfig))
      .filter((entry): entry is ProviderMcpServer => entry !== null);
  }

  override async upsertServer(_input: UpsertProviderMcpServerInput): Promise<ProviderMcpServer> {
    throw new AppError(
      'Gemini MCP management is disabled because the installed runtime is agy and does not read the Google gemini-cli settings path.',
      { code: 'GEMINI_GENERIC_MCP_DISABLED', statusCode: 403 },
    );
  }

  override async removeServer(input: {
    name: string;
    scope?: McpScope;
    workspacePath?: string;
    userId?: string | number | null;
  }): Promise<{ removed: boolean; provider: 'gemini'; name: string; scope: McpScope }> {
    this.assertCleanupOperation('remove');
    if ((input.scope ?? 'project') !== 'user') {
      throw new AppError('Gemini historical MCP cleanup supports only user scope.', {
        code: 'MCP_SCOPE_NOT_SUPPORTED', statusCode: 400,
      });
    }
    const name = input.name.trim();
    if (!name) {
      throw new AppError('MCP server name is required.', {
        code: 'MCP_SERVER_NAME_REQUIRED', statusCode: 400,
      });
    }
    const result = await removeLegacyMcpEntry({
      ...historicalCleanupFile(input.userId),
      name,
    });
    return { removed: result.removed, provider: 'gemini', name, scope: 'user' };
  }

  protected scopedConfigPath(
    scope: McpScope,
    workspacePath: string,
    userId?: string | number | null,
  ): string {
    return scope === 'user'
      ? geminiSettingsFilePath(userId)
      : path.join(workspacePath, '.gemini', 'settings.json');
  }

  protected async readScopedServers(
    scope: McpScope,
    workspacePath: string,
    userId?: string | number | null,
  ): Promise<Record<string, unknown>> {
    const filePath = scope === 'user'
      ? geminiSettingsFilePath(userId)
      : path.join(workspacePath, '.gemini', 'settings.json');
    const config = await readJsonConfig(filePath);
    return readObjectRecord(config.mcpServers) ?? {};
  }

  protected async writeScopedServers(
    scope: McpScope,
    workspacePath: string,
    servers: Record<string, unknown>,
    userId?: string | number | null,
  ): Promise<void> {
    if (scope !== 'user') {
      const filePath = path.join(workspacePath, '.gemini', 'settings.json');
      const config = await readJsonConfig(filePath);
      config.mcpServers = servers;
      await writeJsonConfigAtomic(filePath, config, {
        mode: 0o600,
        directoryMode: 0o700,
        verifyMode: true,
      });
      return;
    }

    // Same reasoning as the claude writer: a per-user settings.json can hold auth state
    // and is written by a live CLI, so the swap is atomic and 0600, then confirmed.
    const filePath = geminiSettingsFilePath(userId);
    const config = await readJsonConfig(filePath);
    config.mcpServers = servers;
    await writeJsonConfigAtomic(filePath, config, {
      mode: 0o600,
      directoryMode: 0o700,
      verifyMode: true,
    });

    const persisted = readObjectRecord((await readJsonConfig(filePath)).mcpServers) ?? {};
    const missing = Object.keys(servers).filter((name) => !(name in persisted));
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
        command: input.command,
        args: input.args ?? [],
        env: input.env ?? {},
        cwd: input.cwd,
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
        provider: 'gemini',
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
      const transport = readOptionalString(config.type) === 'sse' ? 'sse' : 'http';
      return {
        provider: 'gemini',
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
