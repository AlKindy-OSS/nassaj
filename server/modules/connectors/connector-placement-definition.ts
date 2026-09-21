import type { ConnectorRow } from '@/modules/database/index.js';
import type { UpsertProviderMcpServerInput } from '@/shared/types.js';

export type NonSecretConnectorPlacementMaterial =
  | {
    transport: 'stdio';
    command: string;
    args: string[];
    env?: Record<string, string>;
  }
  | {
    transport: 'http';
    url: string;
    headers?: Record<string, string>;
  };

/** Canonical, collision-resistant config name occupied by one connector. */
export function mcpServerNameFor(connector: Pick<ConnectorRow, 'id'>): string {
  return `nassaj-connector-${connector.id}`;
}

/**
 * Builds the canonical non-secret placement body shared by every writer.
 * Credential values are deliberately overlaid by connectors.service only after
 * this function returns; this definition is safe to fingerprint in later work.
 */
export function buildConnectorPlacementInput(
  connector: Pick<ConnectorRow, 'id'>,
  userId: number,
  material: NonSecretConnectorPlacementMaterial,
): UpsertProviderMcpServerInput {
  const base = {
    name: mcpServerNameFor(connector),
    scope: 'user' as const,
    userId,
  };
  if (material.transport === 'http') {
    return {
      ...base,
      transport: 'http',
      url: material.url,
      headers: { ...(material.headers ?? {}) },
    };
  }
  return {
    ...base,
    transport: 'stdio',
    command: material.command,
    args: [...material.args],
    env: { ...(material.env ?? {}) },
  };
}
