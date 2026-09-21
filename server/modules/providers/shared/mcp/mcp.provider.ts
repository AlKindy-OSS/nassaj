import path from 'node:path';
import type { Stats } from 'node:fs';

import { withCanonicalMcpWriterLock } from '@/modules/providers/services/legacy-mcp-cleanup.js';
import type { IProviderMcp } from '@/shared/interfaces.js';
import type { LLMProvider, McpScope, McpTransport, ProviderMcpServer, UpsertProviderMcpServerInput } from '@/shared/types.js';
import { AppError } from '@/shared/utils.js';

/**
 * Serialises read-modify-write transactions by their final config path.
 *
 * A lock on `writeScopedServers` alone is too late: two upserts can both read the
 * same snapshot and the second write then drops the first entry.  The queue must
 * therefore cover the initial read, mutation, and atomic write as one unit.
 * This is process-local by design; provider CLIs do not participate, so writers
 * still use atomic replacement and confirm-read where supported.
 */
const configTransactions = new Map<string, Promise<void>>();

const withConfigTransaction = async <T>(filePath: string, operation: () => Promise<T>): Promise<T> => {
  const key = path.resolve(filePath);
  const previous = configTransactions.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => current);
  configTransactions.set(key, tail);

  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (configTransactions.get(key) === tail) {
      configTransactions.delete(key);
    }
  }
};

const resolveWorkspacePath = (workspacePath?: string): string =>
  path.resolve(workspacePath ?? process.cwd());

const normalizeServerName = (name: string): string => {
  const normalized = name.trim();
  if (!normalized) {
    throw new AppError('MCP server name is required.', {
      code: 'MCP_SERVER_NAME_REQUIRED',
      statusCode: 400,
    });
  }

  return normalized;
};

export type ConnectorMcpReconcileInput = {
  name: string;
  userId: string | number;
  desired: UpsertProviderMcpServerInput | null;
  decide(current: ConnectorMcpObservation): 'keep' | 'apply' | Promise<'keep' | 'apply'>;
  assertFenceCurrent(): void | Promise<void>;
  assertAfter(after: ConnectorMcpObservation): void | Promise<void>;
};

export type ConnectorMcpObservation = {
  present: boolean;
  raw: unknown | null;
  normalized: ProviderMcpServer | null;
};

export type ConnectorMcpReconcileResult = {
  applied: boolean;
  after: ConnectorMcpObservation;
};

/**
 * Shared MCP provider for provider-specific config readers/writers.
 */
export abstract class McpProvider implements IProviderMcp {
  protected readonly provider: LLMProvider;
  protected readonly supportedScopes: McpScope[];
  protected readonly supportedTransports: McpTransport[];
  protected readonly usesLegacyCleanupLock: boolean = false;

  /**
   * True when this provider's `user`/`local` writer resolves its file from the
   * CALLER's per-user config home, so the bytes can only ever land in the writing
   * member's own tree (T-1177).
   *
   * WHY THIS IS A FLAG ON THE WRITER AND NOT A POLICY LOOKUP. The MCP route uses it
   * to decide whether a plain member may write a user-scoped server. Deriving that
   * from the sharing policy ALONE is unsound: `isProviderIsolated('opencode')` can
   * be flipped to true from the admin UI at any moment, while
   * `resolveOpenCodeConfigPath` still computes `os.homedir()/.config/opencode` with
   * no userId — so the gate would open onto the OPERATOR's file and silently reopen
   * B-345. The permission must therefore be conditioned on a property of the code
   * that performs the write, declared here, next to that code, where anyone
   * changing the writer is looking. Providers default to `false`: a new provider is
   * admin-only until someone proves its writer is per-user.
   */
  readonly writesPerUserConfig: boolean;

  /**
   * Derived, not declared: an implementation that supports no scope or no
   * transport has no surface to write into. VendorMcpProvider is built with both
   * lists empty for exactly that reason, so it reports false without a second
   * place to keep in sync.
   */
  get supportsMcp(): boolean {
    return this.supportedScopes.length > 0 && this.supportedTransports.length > 0;
  }

  protected constructor(
    provider: LLMProvider,
    supportedScopes: McpScope[],
    supportedTransports: McpTransport[],
    writesPerUserConfig = false,
  ) {
    this.provider = provider;
    this.supportedScopes = supportedScopes;
    this.supportedTransports = supportedTransports;
    this.writesPerUserConfig = writesPerUserConfig;
  }

  async listServers(options?: { workspacePath?: string; userId?: string | number | null }): Promise<Record<McpScope, ProviderMcpServer[]>> {
    const grouped: Record<McpScope, ProviderMcpServer[]> = {
      user: [],
      local: [],
      project: [],
    };

    for (const scope of this.supportedScopes) {
      grouped[scope] = await this.listServersForScope(scope, options);
    }

    return grouped;
  }

  async listServersForScope(
    scope: McpScope,
    options?: { workspacePath?: string; userId?: string | number | null },
  ): Promise<ProviderMcpServer[]> {
    if (!this.supportedScopes.includes(scope)) {
      return [];
    }

    const workspacePath = resolveWorkspacePath(options?.workspacePath);
    const scopedServers = await this.readScopedServers(scope, workspacePath, options?.userId);
    return Object.entries(scopedServers)
      .map(([name, rawConfig]) => this.normalizeServerConfig(scope, name, rawConfig))
      .filter((entry): entry is ProviderMcpServer => entry !== null);
  }

  async upsertServer(input: UpsertProviderMcpServerInput): Promise<ProviderMcpServer> {
    const scope = input.scope ?? 'project';
    this.assertScopeAndTransport(scope, input.transport);
    const normalizedName = normalizeServerName(input.name);
    await this.withServerMapWriterTransaction({
      name: normalizedName,
      scope,
      workspacePath: input.workspacePath,
      userId: input.userId,
      desired: input,
      decide: () => 'apply',
      assertFenceCurrent: () => {},
      assertAfter: () => {},
    });

    return {
      provider: this.provider,
      name: normalizedName,
      scope,
      transport: input.transport,
      command: input.command,
      args: input.args,
      env: input.env,
      cwd: input.cwd,
      url: input.url,
      headers: input.headers,
      envVars: input.envVars,
      bearerTokenEnvVar: input.bearerTokenEnvVar,
      envHttpHeaders: input.envHttpHeaders,
    };
  }

  async removeServer(
    input: { name: string; scope?: McpScope; workspacePath?: string; userId?: string | number | null },
  ): Promise<{ removed: boolean; provider: LLMProvider; name: string; scope: McpScope }> {
    const scope = input.scope ?? 'project';
    this.assertScope(scope);

    const normalizedName = normalizeServerName(input.name);
    const result = await this.withServerMapWriterTransaction({
      name: normalizedName,
      scope,
      workspacePath: input.workspacePath,
      userId: input.userId,
      desired: null,
      decide: (current) => current.present ? 'apply' : 'keep',
      assertFenceCurrent: () => {},
      assertAfter: (after) => {
        if (after.present) throw new Error('mcp_remove_readback_failed');
      },
    });

    return { removed: result.applied, provider: this.provider, name: normalizedName, scope };
  }

  /** Connector-only transaction; not part of the public IProviderMcp contract. */
  async reconcileUserServer(input: ConnectorMcpReconcileInput): Promise<ConnectorMcpReconcileResult> {
    if (input.desired) {
      if (input.desired.scope !== 'user' || input.desired.userId !== input.userId) {
        throw new AppError('Connector MCP reconciliation is restricted to one member user scope.', {
          code: 'CONNECTOR_MCP_TARGET_SCOPE_INVALID', statusCode: 400,
        });
      }
      this.assertScopeAndTransport('user', input.desired.transport);
    } else {
      this.assertScope('user');
    }
    return this.withServerMapWriterTransaction({
      ...input,
      name: normalizeServerName(input.name),
      scope: 'user',
    });
  }

  /** Provider-owned canonical raw map value; performs no path or config access. */
  connectorDesiredRaw(input: UpsertProviderMcpServerInput): Record<string, unknown> {
    if (input.scope !== 'user' || input.userId === null || input.userId === undefined) {
      throw new AppError('Connector MCP material is restricted to member user scope.', {
        code: 'CONNECTOR_MCP_TARGET_SCOPE_INVALID', statusCode: 400,
      });
    }
    this.assertScopeAndTransport('user', input.transport);
    return this.buildServerConfig(input);
  }

  /** One lock owner for snapshot → decision → mutation → semantic readback. */
  private async withServerMapWriterTransaction(input: {
    name: string;
    scope: McpScope;
    workspacePath?: string;
    userId?: string | number | null;
    desired: UpsertProviderMcpServerInput | null;
    decide(current: ConnectorMcpObservation): 'keep' | 'apply' | Promise<'keep' | 'apply'>;
    assertFenceCurrent(): void | Promise<void>;
    assertAfter(after: ConnectorMcpObservation): void | Promise<void>;
  }): Promise<ConnectorMcpReconcileResult> {
    const workspacePath = resolveWorkspacePath(input.workspacePath);
    const configPath = await this.scopedConfigPath(input.scope, workspacePath, input.userId);
    return withConfigTransaction(configPath, async () => {
      const operation = async (transaction?: {
        targetPath: string;
        snapshotContent: string | null;
        beforePromotion: () => Promise<void>;
        recordPromotion: (stat: Stats, content: string) => void;
      }) => this.withScopedTransaction(transaction?.targetPath ?? configPath, async () => {
        const scopedServers = await this.readScopedServers(
          input.scope, workspacePath, input.userId,
          transaction?.targetPath, transaction?.snapshotContent,
        );
        const currentPresent = Object.prototype.hasOwnProperty.call(scopedServers, input.name);
        const currentRaw = currentPresent ? scopedServers[input.name] : null;
        const current: ConnectorMcpObservation = {
          present: currentPresent,
          raw: currentRaw,
          normalized: currentPresent
            ? this.normalizeServerConfig(input.scope, input.name, currentRaw)
            : null,
        };
        await input.assertFenceCurrent();
        const decision = await input.decide(current);
        let applied = false;
        if (decision === 'apply') {
          applied = true;
          if (input.desired) scopedServers[input.name] = this.buildServerConfig(input.desired);
          else delete scopedServers[input.name];
          await this.writeScopedServers(
            input.scope, workspacePath, scopedServers, input.userId,
            transaction?.targetPath, transaction?.snapshotContent,
            async () => {
              await transaction?.beforePromotion();
              await input.assertFenceCurrent();
            },
            transaction?.recordPromotion,
          );
        }
        const afterServers = await this.readScopedServers(
          input.scope, workspacePath, input.userId, transaction?.targetPath,
        );
        const afterPresent = Object.prototype.hasOwnProperty.call(afterServers, input.name);
        const afterRaw = afterPresent ? afterServers[input.name] : null;
        const after: ConnectorMcpObservation = {
          present: afterPresent,
          raw: afterRaw,
          normalized: afterPresent
            ? this.normalizeServerConfig(input.scope, input.name, afterRaw)
            : null,
        };
        await input.assertAfter(after);
        await input.assertFenceCurrent();
        return { applied, after };
      });
      return this.usesLegacyCleanupLock
        ? withCanonicalMcpWriterLock(configPath, operation, {
          secureFinalParent: this.secureWriterParent(input.scope),
          ...this.writerTransactionTestHooks(),
        })
        : operation();
    });
  }

  protected abstract readScopedServers(
    scope: McpScope,
    workspacePath: string,
    userId?: string | number | null,
    transactionPath?: string,
    transactionSnapshot?: string | null,
  ): Promise<Record<string, unknown>>;

  /** Provider hook for a cross-process transaction lock; process-local by default. */
  protected async withScopedTransaction<T>(
    _filePath: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    return operation();
  }

  /** Whether the provider-owned final config directory must be tightened to 0700. */
  protected secureWriterParent(_scope: McpScope): boolean {
    return true;
  }

  /** Deterministic fault seams for transaction security tests; empty in production. */
  protected writerTransactionTestHooks(): {
    testAfterFinalSnapshot?: () => void | Promise<void>;
    testAfterEffect?: () => void | Promise<void>;
    testAfterRelease?: () => void | Promise<void>;
  } {
    return {};
  }

  /** Final file path used as the key for the complete read-modify-write lock. */
  protected abstract scopedConfigPath(
    scope: McpScope,
    workspacePath: string,
    userId?: string | number | null,
  ): string | Promise<string>;

  protected abstract writeScopedServers(
    scope: McpScope,
    workspacePath: string,
    servers: Record<string, unknown>,
    userId?: string | number | null,
    transactionPath?: string,
    transactionSnapshot?: string | null,
    beforePromotion?: () => Promise<void>,
    recordPromotion?: (stat: Stats, content: string) => void,
  ): Promise<void>;

  protected abstract buildServerConfig(input: UpsertProviderMcpServerInput): Record<string, unknown>;

  protected abstract normalizeServerConfig(
    scope: McpScope,
    name: string,
    rawConfig: unknown,
  ): ProviderMcpServer | null;

  protected assertScope(scope: McpScope): void {
    if (!this.supportedScopes.includes(scope)) {
      throw new AppError(`Provider "${this.provider}" does not support "${scope}" MCP scope.`, {
        code: 'MCP_SCOPE_NOT_SUPPORTED',
        statusCode: 400,
      });
    }
  }

  protected assertScopeAndTransport(scope: McpScope, transport: McpTransport): void {
    this.assertScope(scope);
    if (!this.supportedTransports.includes(transport)) {
      throw new AppError(`Provider "${this.provider}" does not support "${transport}" MCP transport.`, {
        code: 'MCP_TRANSPORT_NOT_SUPPORTED',
        statusCode: 400,
      });
    }
  }
}
