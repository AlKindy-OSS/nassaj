import { access, lstat, readFile, rename } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

import { McpProvider } from '@/modules/providers/shared/mcp/mcp.provider.js';
import { resolveOpenCodeConfigHomeForUser } from '@/modules/providers/list/opencode/opencode-governance.js';
import { materializeOpenCodeConfig } from '@/services/isolation/opencode-config-material.js';
import {
  recoverOpenCodeConfigMigration,
  secureNeutralizeOpenCodeFile,
  secureReadOpenCodeText,
  withOpenCodeConfigLock,
} from '@/services/isolation/opencode-config-lock.js';
import type { McpScope, ProviderMcpServer, UpsertProviderMcpServerInput } from '@/shared/types.js';
import {
  AppError,
  readObjectRecord,
  readOptionalString,
  readStringArray,
  readStringRecord,
  writeJsonConfigAtomic,
} from '@/shared/utils.js';

type OpenCodeConfigPath = {
  filePath: string;
  exists: boolean;
};

const OPENCODE_MCP_FEATURE_FLAG = 'NASSAJ_OPENCODE_MCP_ENABLED';
const openCodeMcpEnabled = (): boolean => process.env[OPENCODE_MCP_FEATURE_FLAG] === '1';

type MigrationFaultPhase = 'lock-mkdir' | 'rename' | 'canonical' | 'neutralize';

const fileExists = async (filePath: string): Promise<boolean> => {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
};

const fileEntryExists = async (filePath: string): Promise<boolean> => {
  try {
    await lstat(filePath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
};

/**
 * Removes JSONC comments without touching comment-like text inside strings.
 */
const stripJsonComments = (content: string): string => {
  let output = '';
  let inString = false;
  let quote = '';
  let escaped = false;

  for (let index = 0; index < content.length; index += 1) {
    const char = content[index];
    const next = content[index + 1];

    if (inString) {
      output += char;
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === quote) {
        inString = false;
        quote = '';
      }
      continue;
    }

    if (char === '"' || char === '\'') {
      inString = true;
      quote = char;
      output += char;
      continue;
    }

    if (char === '/' && next === '/') {
      while (index < content.length && content[index] !== '\n') {
        index += 1;
      }
      output += '\n';
      continue;
    }

    if (char === '/' && next === '*') {
      index += 2;
      while (index < content.length && !(content[index] === '*' && content[index + 1] === '/')) {
        index += 1;
      }
      index += 1;
      continue;
    }

    output += char;
  }

  return output;
};

const stripTrailingCommas = (content: string): string =>
  content.replace(/,\s*([}\]])/g, '$1');

const readOpenCodeConfig = async (filePath: string): Promise<Record<string, unknown>> => {
  try {
    const content = await readFile(filePath, 'utf8');
    const parsed = JSON.parse(stripTrailingCommas(stripJsonComments(content))) as unknown;
    return readObjectRecord(parsed) ?? {};
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      return {};
    }

    throw error;
  }
};

const parseOpenCodeConfig = (content: string): Record<string, unknown> =>
  readObjectRecord(JSON.parse(stripTrailingCommas(stripJsonComments(content))) as unknown) ?? {};

/**
 * T-1230 — atomic + 0600, matching the claude/codex writers.
 *
 * Two reasons, both now live. A plain `writeFile` truncates before it writes, so
 * a crash or a concurrent read mid-write leaves a torn or empty `opencode.json`
 * — and this file carries the member's provider config, not scratch data. And
 * since ADR-098 an MCP entry here may hold a connector's API key, which a 0644
 * file publishes to every process on the box; 0600 under the shared `nassaj` uid
 * is the same access the engines already have and no more.
 *
 * This does not close the last-writer-wins race against the opencode CLI itself
 * — that limit is documented in the other MCP writers and unchanged here.
 */
const writeOpenCodeConfig = async (
  filePath: string,
  data: Record<string, unknown>,
  privateDirectory: boolean,
): Promise<void> => {
  await writeJsonConfigAtomic(filePath, data, {
    mode: 0o600,
    ...(privateDirectory ? { directoryMode: 0o700 } : {}),
    verifyMode: true,
  });
};

const resolveOpenCodeConfigPath = async (
  scope: McpScope,
  workspacePath: string,
  userId?: string | number | null,
): Promise<OpenCodeConfigPath> => {
  const root = scope === 'user'
    ? resolveOpenCodeConfigHomeForUser(userId ?? null)
    : workspacePath;
  const jsonPath = path.join(root, 'opencode.json');
  const jsoncPath = path.join(root, 'opencode.jsonc');

  // User scope is governed by one canonical opencode.json. Legacy JSONC is
  // inspected/migrated explicitly by the user writer below; returning it here
  // would create a second canonical filename and bypass that transition.
  if (scope === 'user') {
    return { filePath: jsonPath, exists: await fileEntryExists(jsonPath) };
  }

  if (await fileExists(jsonPath)) {
    return { filePath: jsonPath, exists: true };
  }

  if (await fileExists(jsoncPath)) {
    return { filePath: jsoncPath, exists: true };
  }

  return { filePath: jsonPath, exists: false };
};

export class OpenCodeMcpProvider extends McpProvider {
  private readonly cleanupOnly: boolean;
  private readonly testCrashAfter?: MigrationFaultPhase;

  constructor(options: {
    enabled?: boolean;
    cleanupOnly?: boolean;
    /** Test-only fault injection used to prove migration crash recovery. */
    testCrashAfter?: MigrationFaultPhase;
  } = {}) {
    // Dormant contract: user scope follows the same XDG_CONFIG_HOME resolver as
    // the real spawn. Connector rollout remains separately allowlisted.
    const enabled = options.enabled ?? openCodeMcpEnabled();
    const active = enabled || options.cleanupOnly === true;
    super('opencode', active ? ['user'] : [], active ? ['stdio', 'http'] : [], enabled);
    this.cleanupOnly = options.cleanupOnly === true;
    this.testCrashAfter = options.testCrashAfter;
  }

  override async upsertServer(input: UpsertProviderMcpServerInput): Promise<ProviderMcpServer> {
    if (this.cleanupOnly) {
      throw new AppError('OpenCode MCP cleanup mode does not permit writes.', {
        code: 'MCP_WRITE_FORBIDDEN', statusCode: 403,
      });
    }
    return super.upsertServer(input);
  }

  protected async scopedConfigPath(
    scope: McpScope,
    workspacePath: string,
    userId?: string | number | null,
  ): Promise<string> {
    return (await resolveOpenCodeConfigPath(scope, workspacePath, userId)).filePath;
  }

  protected override async withScopedTransaction<T>(
    filePath: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    return withOpenCodeConfigLock(filePath, async () => {
      recoverOpenCodeConfigMigration(filePath);
      return operation();
    }, {
      afterMkdir: this.testCrashAfter === 'lock-mkdir'
        ? () => this.throwInjectedMigrationFault('lock-mkdir')
        : undefined,
    });
  }

  protected async readScopedServers(
    scope: McpScope,
    workspacePath: string,
    userId?: string | number | null,
  ): Promise<Record<string, unknown>> {
    const { filePath } = await resolveOpenCodeConfigPath(scope, workspacePath, userId);
    if (scope === 'user') {
      const jsoncPath = `${filePath}c`;
      const [jsonExists, jsoncExists] = await Promise.all([
        fileEntryExists(filePath),
        fileEntryExists(jsoncPath),
      ]);
      if (jsonExists && jsoncExists) {
        throw new AppError('OpenCode has both opencode.json and opencode.jsonc; refusing ambiguous MCP state.', {
          code: 'MCP_CONFIG_DUAL_FORMAT',
          statusCode: 409,
        });
      }
      const selectedPath = jsonExists ? filePath : jsoncPath;
      const config = (jsonExists || jsoncExists)
        ? parseOpenCodeConfig(secureReadOpenCodeText(selectedPath))
        : {};
      return readObjectRecord(config.mcp) ?? {};
    }
    const config = await readOpenCodeConfig(filePath);
    return readObjectRecord(config.mcp) ?? {};
  }

  protected async writeScopedServers(
    scope: McpScope,
    workspacePath: string,
    servers: Record<string, unknown>,
    userId?: string | number | null,
  ): Promise<void> {
    const { filePath } = await resolveOpenCodeConfigPath(scope, workspacePath, userId);
    if (scope === 'user') {
      const jsoncPath = `${filePath}c`;
      const jsoncExists = await fileEntryExists(jsoncPath);
      let migratingPath: string | null = null;
      if (jsoncExists) {
        const jsonExists = await fileEntryExists(filePath);
        if (jsonExists) {
          throw new AppError('OpenCode has both opencode.json and opencode.jsonc; refusing ambiguous MCP state.', {
            code: 'MCP_CONFIG_DUAL_FORMAT',
            statusCode: 409,
          });
        }
        const legacyStat = await lstat(jsoncPath);
        if (!legacyStat.isFile() || legacyStat.isSymbolicLink()) {
          throw new AppError('Refusing unsafe OpenCode JSONC migration source.', {
            code: 'MCP_CONFIG_UNSAFE_LEGACY_FILE',
            statusCode: 409,
          });
        }
        migratingPath = `${jsoncPath}.migrating-${process.pid}-${randomUUID()}`;
        await rename(jsoncPath, migratingPath);
        this.throwInjectedMigrationFault('rename');
      }

      const ok = materializeOpenCodeConfig(path.dirname(filePath), { mcp: servers, lockHeld: true, callerId: userId });
      if (!ok) {
        if (migratingPath) await rename(migratingPath, jsoncPath).catch(() => {});
        throw new AppError('Failed to materialize governed OpenCode MCP overlay.', {
          code: 'MCP_WRITE_NOT_PERSISTED',
          statusCode: 409,
        });
      }
      this.throwInjectedMigrationFault('canonical');
      if (migratingPath) {
        // Neutralize before unlink so even an interrupted cleanup leaves no
        // credential-bearing duplicate under the migration filename.
        secureNeutralizeOpenCodeFile(
          migratingPath,
          () => this.throwInjectedMigrationFault('neutralize'),
        );
        if (await fileEntryExists(jsoncPath) || await fileEntryExists(migratingPath)) {
          throw new AppError('OpenCode JSONC migration cleanup could not be verified.', {
            code: 'MCP_CONFIG_LEGACY_CLEANUP_FAILED',
            statusCode: 409,
          });
        }
      }
      return;
    }
    const config = await readOpenCodeConfig(filePath);
    config.mcp = servers;
    await writeOpenCodeConfig(filePath, config, false);
  }

  private throwInjectedMigrationFault(phase: MigrationFaultPhase): void {
    if (this.testCrashAfter === phase) {
      throw new AppError(`Injected OpenCode migration crash after ${phase}.`, {
        code: 'MCP_TEST_MIGRATION_CRASH', statusCode: 500,
      });
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
        type: 'local',
        command: [input.command, ...(input.args ?? [])],
        enabled: true,
        environment: input.env ?? {},
      };
    }

    if (!input.url?.trim()) {
      throw new AppError('url is required for http MCP servers.', {
        code: 'MCP_URL_REQUIRED',
        statusCode: 400,
      });
    }

    return {
      type: 'remote',
      url: input.url,
      enabled: true,
      headers: input.headers ?? {},
    };
  }

  protected normalizeServerConfig(
    scope: McpScope,
    name: string,
    rawConfig: unknown,
  ): ProviderMcpServer | null {
    const config = readObjectRecord(rawConfig);
    if (!config) {
      return null;
    }

    if (config.type === 'local' || config.command !== undefined) {
      const commandParts = typeof config.command === 'string'
        ? [config.command, ...(readStringArray(config.args) ?? [])]
        : readStringArray(config.command);
      const command = commandParts?.[0];
      if (!command) {
        return null;
      }

      return {
        provider: 'opencode',
        name,
        scope,
        transport: 'stdio',
        command,
        args: commandParts.slice(1),
        env: readStringRecord(config.environment) ?? readStringRecord(config.env),
      };
    }

    if (config.type === 'remote' || typeof config.url === 'string') {
      const url = readOptionalString(config.url);
      if (!url) {
        return null;
      }

      return {
        provider: 'opencode',
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
