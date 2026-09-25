import os from 'node:os';
import path from 'node:path';

import { providerRegistry } from '@/modules/providers/provider.registry.js';
import { OpenCodeMcpProvider } from '@/modules/providers/list/opencode/opencode-mcp.provider.js';
import {
  removeLegacyMcpEntry,
} from '@/modules/providers/services/legacy-mcp-cleanup.js';
import {
  connectorRolloutTargets,
  globalManualTargets,
  legacyCleanupPlacements,
  type LegacyMcpCleanupOwner,
} from '@/modules/providers/services/mcp-placement.policy.js';
import type { LLMProvider, McpScope, ProviderMcpServer, UpsertProviderMcpServerInput } from '@/shared/types.js';
import type {
  ConnectorMcpReconcileInput,
  ConnectorMcpReconcileResult,
} from '@/modules/providers/shared/mcp/mcp.provider.js';
import { AppError } from '@/shared/utils.js';

/**
 * Connector fan-out is narrower than generic MCP configuration support.
 *
 * This allowlist is an explicit rollout decision, not a capability-derived list.
 * Antigravity/agy and Cursor now have writer→installed-real-reader contract
 * tests, but remain intentionally unarmed until a separate rollout decision or
 * feature flag covers lifecycle/reconciliation behavior. OpenCode, Kimi
 * chat and Hermes are also unarmed for the blockers documented in B-740.
 */
export const CONNECTOR_MCP_TARGETS = new Set<LLMProvider>(
  connectorRolloutTargets.map(({ provider }) => provider),
);

export type ConnectorCleanupResult = {
  provider: LegacyMcpCleanupOwner;
  removed: boolean;
  /** A remove return value is not proof; this is set only after a read-back. */
  verified: boolean;
  state: 'removed' | 'absent' | 'failed';
  error?: string;
};

export type ConnectorTargetAdapter = {
  reconcile(input: ConnectorMcpReconcileInput): Promise<ConnectorMcpReconcileResult>;
  desiredRaw(input: UpsertProviderMcpServerInput): Record<string, unknown>;
};

const historicalUserRoot = (userId?: string | number | null): string =>
  userId === null || userId === undefined || userId === ''
    ? (process.env.HOME || os.homedir())
    : path.join(os.homedir(), '.nassaj-users', String(userId));

const containedCleanupFile = (
  placement: Exclude<(typeof legacyCleanupPlacements)[number], { adapter: 'opencode-cleanup-only' }>,
  userId?: string | number | null,
) => {
  const userRoot = historicalUserRoot(userId);
  switch (placement.id) {
    case 'claude-user-json':
      return {
        rootDir: userId === null || userId === undefined || userId === ''
          ? (process.env.CLAUDE_CONFIG_DIR || userRoot)
          : path.join(userRoot, '.claude'),
        relativePath: '.claude.json', format: 'json' as const, mapKey: 'mcpServers' as const,
      };
    case 'codex-user-toml':
      return {
        rootDir: userId === null || userId === undefined || userId === ''
          ? (process.env.CODEX_HOME || path.join(userRoot, '.codex'))
          : path.join(userRoot, '.codex'),
        relativePath: 'config.toml', format: 'toml' as const, mapKey: 'mcp_servers' as const,
      };
    case 'gemini-pseudo-user-json':
      return { rootDir: userRoot, relativePath: '.gemini/settings.json', format: 'json' as const, mapKey: 'mcpServers' as const };
    case 'cursor-user-json':
      return { rootDir: userRoot, relativePath: '.cursor/mcp.json', format: 'json' as const, mapKey: 'mcpServers' as const };
    case 'agy-user-json':
      return { rootDir: userRoot, relativePath: '.gemini/config/mcp_config.json', format: 'json' as const, mapKey: 'mcpServers' as const };
    default:
      throw new AppError('Unknown historical MCP cleanup placement.', {
        code: 'MCP_CLEANUP_PLACEMENT_UNKNOWN', statusCode: 500,
      });
  }
};


export const providerMcpService = {
  /** Internal connector writer adapter over the registered Claude/Codex instance. */
  connectorTargetAdapter(providerName: 'claude' | 'codex'): ConnectorTargetAdapter {
    const provider = providerRegistry.resolveConnectorMcpProvider(providerName);
    return {
      reconcile: (input) => provider.reconcileUserServer(input),
      desiredRaw: (input) => provider.connectorDesiredRaw(input),
    };
  },
  /** Whether the provider's MCP surface is enabled in this server process. */
  providerSupportsMcp(providerName: string): boolean {
    try {
      return providerRegistry.resolveProvider(providerName).mcp.supportsMcp === true;
    } catch {
      return false;
    }
  },

  /**
   * True when this provider's user/local MCP writer targets the CALLER's own config
   * home (T-1177). The route pairs this with the sharing policy before letting a
   * plain member write: the policy says WHERE the spawn reads, this says whether the
   * writer follows the caller — and only both together mean "the member's own tree".
   * An unknown provider name is not writable-by-member, fail-closed.
   */
  providerWritesPerUserMcpConfig(providerName: string): boolean {
    try {
      return providerRegistry.resolveProvider(providerName).mcp.writesPerUserConfig === true;
    } catch {
      return false;
    }
  },

  /**
   * Lists MCP servers for one provider grouped by supported scopes.
   */
  async listProviderMcpServers(
    providerName: string,
    options?: { workspacePath?: string; userId?: string | number | null },
  ): Promise<Record<McpScope, ProviderMcpServer[]>> {
    const provider = providerRegistry.resolveProvider(providerName);
    return provider.mcp.listServers(options);
  },

  /**
   * Lists MCP servers for one provider scope.
   */
  async listProviderMcpServersForScope(
    providerName: string,
    scope: McpScope,
    options?: { workspacePath?: string; userId?: string | number | null },
  ): Promise<ProviderMcpServer[]> {
    const provider = providerRegistry.resolveProvider(providerName);
    return provider.mcp.listServersForScope(scope, options);
  },

  /**
   * Adds or updates one provider MCP server.
   */
  async upsertProviderMcpServer(
    providerName: string,
    input: UpsertProviderMcpServerInput,
  ): Promise<ProviderMcpServer> {
    const provider = providerRegistry.resolveProvider(providerName);
    return provider.mcp.upsertServer(input);
  },

  /**
   * Removes one provider MCP server.
   */
  async removeProviderMcpServer(
    providerName: string,
    input: { name: string; scope?: McpScope; workspacePath?: string; userId?: string | number | null },
  ): Promise<{ removed: boolean; provider: LLMProvider; name: string; scope: McpScope }> {
    const provider = providerRegistry.resolveProvider(providerName);
    return provider.mcp.removeServer(input);
  },

  /**
   * The MCP-capable providers, each tagged with whether its writer follows the
   * caller into that member's own config tree.
   *
   * Callers that fan a registration out across members need this split: a
   * per-user provider must be written once PER MEMBER, while an operator-homed
   * one must be written exactly ONCE for everybody. Looping members over a
   * shared provider rewrites one file N times and then reports N successes for
   * what was a single write — the kind of result that reads as "distributed to
   * everyone" while describing something else entirely.
   */
  listMcpTargets(): Array<{ provider: LLMProvider; writesPerUserConfig: boolean }> {
    return connectorRolloutTargets.map(({ provider }) => ({
      provider,
      writesPerUserConfig: providerRegistry.resolveProvider(provider).mcp.writesPerUserConfig === true,
    }));
  },

  /**
   * Attempts to remove one connector MCP server from every current or legacy
   * MCP-capable target.
   *
   * New fan-out is narrow, but cleanup cannot forget destinations used by older
   * releases. Unsupported providers are excluded; a technical failure from any
   * real writer is returned so lifecycle operations can fail closed.
   *
   * `removed: false` with no error simply means that provider had no such
   * server, which is the normal case when the same name is swept twice.
   */
  async removeMcpServerFromAllProviders(input: {
    name: string;
    scope?: Exclude<McpScope, 'local'>;
    workspacePath?: string;
    userId?: string | number | null;
  }): Promise<ConnectorCleanupResult[]> {
    const scope = input.scope ?? 'user';
    if (scope !== 'user') {
      throw new AppError('Historical connector MCP cleanup supports only user scope.', {
        code: 'CONNECTOR_CLEANUP_SCOPE_UNSUPPORTED',
        statusCode: 400,
      });
    }
    const results: ConnectorCleanupResult[] = [];

    for (const placement of legacyCleanupPlacements) {
      try {
        if (placement.adapter === 'opencode-cleanup-only') {
          const adapter = new OpenCodeMcpProvider({ cleanupOnly: true });
          const outcome = await adapter.removeServer({ ...input, scope: placement.scope });
          const readBack = await adapter.listServersForScope(placement.scope, {
            workspacePath: input.workspacePath,
            userId: input.userId,
          });
          const stillPresent = readBack.some((server) => server.name === input.name);
          results.push(stillPresent
            ? {
                provider: placement.provider, removed: outcome.removed, verified: false, state: 'failed',
                error: 'CONNECTOR_PLACEMENT_STILL_PRESENT',
              }
            : {
                provider: placement.provider, removed: outcome.removed, verified: true,
                state: outcome.removed ? 'removed' : 'absent',
              });
          continue;
        }

        const cleanupFile = containedCleanupFile(placement, input.userId);
        const outcome = await removeLegacyMcpEntry({ ...cleanupFile, name: input.name });
        try {
          const stillPresent = !outcome.residueAbsent;
          if (stillPresent) {
            results.push({
              provider: placement.provider,
              removed: outcome.removed,
              verified: false,
              state: 'failed',
              error: 'CONNECTOR_PLACEMENT_STILL_PRESENT',
            });
          } else {
            results.push({
              provider: placement.provider,
              removed: outcome.removed,
              verified: true,
              state: outcome.removed ? 'removed' : 'absent',
            });
          }
        } catch (readBackError) {
          results.push({
            provider: placement.provider,
            removed: outcome.removed,
            verified: false,
            state: 'failed',
            error: readBackError instanceof Error
              ? readBackError.message
              : 'Connector cleanup read-back failed',
          });
        }
      } catch (error) {
        results.push({
          provider: placement.provider,
          removed: false,
          verified: false,
          state: 'failed',
          error: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    }

    return results;
  },

  /**
   * Adds one HTTP/stdio MCP server to every provider.
   */
  async addMcpServerToAllProviders(
    input: Omit<UpsertProviderMcpServerInput, 'scope'> & { scope?: Exclude<McpScope, 'local'> },
  ): Promise<Array<{ provider: LLMProvider; created: boolean; error?: string }>> {
    if (input.transport !== 'stdio' && input.transport !== 'http') {
      throw new AppError('Global MCP add supports only "stdio" and "http".', {
        code: 'INVALID_GLOBAL_MCP_TRANSPORT',
        statusCode: 400,
      });
    }

    const scope = input.scope ?? 'project';
    const results: Array<{ provider: LLMProvider; created: boolean; error?: string }> = [];
    const targets = globalManualTargets.filter(
      (target) => target.scope === scope && target.transports.some(
        (transport) => transport === input.transport,
      ),
    );
    for (const target of targets) {
      try {
        await providerRegistry.resolveProvider(target.provider).mcp.upsertServer({ ...input, scope });
        results.push({ provider: target.provider, created: true });
      } catch (error) {
        results.push({
          provider: target.provider,
          created: false,
          error: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    }

    return results;
  },
};
