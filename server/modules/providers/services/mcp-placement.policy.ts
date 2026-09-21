import type { LLMProvider, McpScope, McpTransport } from '@/shared/types.js';

import { CONNECTOR_ROLLOUT_BODY_PROVIDERS } from '../../../../shared/connector-rollout-policy.js';

type PlacementTarget = {
  provider: LLMProvider;
  scope: Exclude<McpScope, 'local'>;
  transports: readonly Extract<McpTransport, 'stdio' | 'http'>[];
};

export type RuntimeReadProof =
  | { kind: 'installed-runtime'; reader: string }
  | { kind: 'historical-only'; reason: string };

export type ResidueAbsenceProof = {
  kind: 'same-storage-readback';
};

export type LegacyCleanupPlacement = {
  id: string;
  provider: LLMProvider;
  scope: 'user';
  storagePathAlias: string;
  adapter: 'contained-json-cleanup' | 'contained-toml-cleanup' | 'gemini-cleanup-only' | 'opencode-cleanup-only';
  runtimeReadProof: RuntimeReadProof;
  residueAbsenceProof: ResidueAbsenceProof;
};

/** New connector rollout is deliberately independent from generic MCP support. */
export const connectorRolloutTargets = CONNECTOR_ROLLOUT_BODY_PROVIDERS.map(provider => ({
  provider, scope: 'user' as const, transports: ['stdio', 'http'] as const,
})) satisfies readonly PlacementTarget[];

/** Explicit targets for the legacy global/manual endpoint, keyed by scope and transport. */
export const globalManualTargets = [
  { provider: 'claude', scope: 'user', transports: ['stdio', 'http'] },
  { provider: 'codex', scope: 'user', transports: ['stdio', 'http'] },
  { provider: 'cursor', scope: 'user', transports: ['stdio', 'http'] },
  { provider: 'claude', scope: 'project', transports: ['stdio', 'http'] },
  { provider: 'cursor', scope: 'project', transports: ['stdio', 'http'] },
] as const satisfies readonly PlacementTarget[];

/**
 * Every user-scoped file that an older generic fan-out could have touched.
 * Storage aliases are contract identifiers: Gemini's pseudo path and agy's
 * installed-runtime path intentionally remain separate despite sharing .gemini.
 */
export const legacyCleanupPlacements = [
  {
    id: 'claude-user-json', provider: 'claude', scope: 'user',
    storagePathAlias: '$CLAUDE_CONFIG_DIR/.claude.json#mcpServers', adapter: 'contained-json-cleanup',
    runtimeReadProof: { kind: 'installed-runtime', reader: 'claude' },
    residueAbsenceProof: { kind: 'same-storage-readback' },
  },
  {
    id: 'codex-user-toml', provider: 'codex', scope: 'user',
    storagePathAlias: '$CODEX_HOME/config.toml#mcp_servers', adapter: 'contained-toml-cleanup',
    runtimeReadProof: { kind: 'installed-runtime', reader: 'codex' },
    residueAbsenceProof: { kind: 'same-storage-readback' },
  },
  {
    id: 'gemini-pseudo-user-json', provider: 'gemini', scope: 'user',
    storagePathAlias: '$USER_HOME/.gemini/settings.json#mcpServers', adapter: 'gemini-cleanup-only',
    runtimeReadProof: { kind: 'historical-only', reason: 'Installed agy does not read this Google gemini-cli path.' },
    residueAbsenceProof: { kind: 'same-storage-readback' },
  },
  {
    id: 'cursor-user-json', provider: 'cursor', scope: 'user',
    storagePathAlias: '$USER_HOME/.cursor/mcp.json#mcpServers', adapter: 'contained-json-cleanup',
    runtimeReadProof: { kind: 'installed-runtime', reader: 'cursor-agent' },
    residueAbsenceProof: { kind: 'same-storage-readback' },
  },
  {
    id: 'agy-user-json', provider: 'antigravity', scope: 'user',
    storagePathAlias: '$USER_HOME/.gemini/config/mcp_config.json#mcpServers', adapter: 'contained-json-cleanup',
    runtimeReadProof: { kind: 'installed-runtime', reader: 'agy' },
    residueAbsenceProof: { kind: 'same-storage-readback' },
  },
  {
    id: 'opencode-user-json', provider: 'opencode', scope: 'user',
    storagePathAlias: '$XDG_CONFIG_HOME/opencode/opencode.json#mcp', adapter: 'opencode-cleanup-only',
    runtimeReadProof: { kind: 'installed-runtime', reader: 'opencode' },
    residueAbsenceProof: { kind: 'same-storage-readback' },
  },
] as const satisfies readonly LegacyCleanupPlacement[];
