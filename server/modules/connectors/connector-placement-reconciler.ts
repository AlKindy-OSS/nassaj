/**
 * Read-only connector placement planner.
 *
 * This module is deliberately not wired to startup, a timer, connector events,
 * or provider writers.  It is a measurement seam for the separately gated
 * reconciler: with the flag off it does not even read the registry; with the
 * flag on it computes the personal Claude/Codex desired set and returns only
 * aggregate metrics, non-identifying error codes, and a deterministic checksum.
 */
import crypto from 'node:crypto';

import { isConnectorCredentialConfigured } from '@/modules/connectors/connectors.service.js';
import { connectorsDb, userDb, type ConnectorRow } from '@/modules/database/index.js';

export const CONNECTOR_RECONCILER_DRY_RUN_FLAG = 'NASSAJ_CONNECTOR_RECONCILER_DRY_RUN';

const PLACEMENT_TARGETS = [
  { bodyProvider: 'claude', contractVersion: 'mcp-user-v1' },
  { bodyProvider: 'codex', contractVersion: 'mcp-user-v1' },
] as const;

type PlacementTarget = (typeof PLACEMENT_TARGETS)[number];

type DesiredPlacement = {
  connectorId: string;
  memberUserId: number;
  bodyProvider: PlacementTarget['bodyProvider'];
  contractVersion: string;
  desiredFingerprint: string;
};

type PlannerUser = {
  id: number;
  status: string;
};

export type ConnectorPlacementDryRunErrorCode =
  | 'CONNECTOR_CREDENTIAL_MISSING'
  | 'CONNECTOR_OWNER_MISSING'
  | 'CONNECTOR_OWNER_INACTIVE'
  | 'CONNECTOR_SHARED_SCOPE_NOT_ARMED';

export type ConnectorPlacementDryRunResult = {
  enabled: boolean;
  dryRun: true;
  checksum: string | null;
  metrics: {
    connectorsScanned: number;
    connectorsEligible: number;
    activeMembers: number;
    desiredPlacements: number;
    blockedConnectors: number;
    errorsByCode: Partial<Record<ConnectorPlacementDryRunErrorCode, number>>;
  };
  errors: Array<{ code: ConnectorPlacementDryRunErrorCode }>;
};

export type ConnectorPlacementDryRunDeps = {
  listConnectors(): ConnectorRow[];
  listUsers(): PlannerUser[];
  /** Credential-presence only. It must never return or expose the value. */
  hasCredential(connector: ConnectorRow, userId: number): boolean;
};

const defaultDeps: ConnectorPlacementDryRunDeps = {
  listConnectors: () => connectorsDb.list(),
  listUsers: () => userDb.listUsers(),
  hasCredential: (connector, userId) => isConnectorCredentialConfigured(connector, userId),
};

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function desiredFingerprint(connector: ConnectorRow, userId: number, target: PlacementTarget): string {
  // Deliberately excludes credential values, account labels, command arguments,
  // URLs and environment data. Those belong to the later authenticated writer
  // proof; dry-run only measures registry intent and contract routing.
  return sha256(JSON.stringify({
    connectorId: connector.id,
    memberUserId: userId,
    bodyProvider: target.bodyProvider,
    contractVersion: target.contractVersion,
    credentialMode: connector.credentialMode,
    authMode: connector.authMode,
  }));
}

function emptyResult(enabled: boolean): ConnectorPlacementDryRunResult {
  return {
    enabled,
    dryRun: true,
    checksum: null,
    metrics: {
      connectorsScanned: 0,
      connectorsEligible: 0,
      activeMembers: 0,
      desiredPlacements: 0,
      blockedConnectors: 0,
      errorsByCode: {},
    },
    errors: [],
  };
}

/** The dry-run is opt-in; every value except the exact string `1` is OFF. */
export function isConnectorPlacementDryRunEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return env[CONNECTOR_RECONCILER_DRY_RUN_FLAG] === '1';
}

/**
 * Computes desired personal placements without writing DB state or provider
 * files. Shared credentials stay blocked until the isolation gate is reopened.
 */
export function runConnectorPlacementDryRun(options: {
  env?: NodeJS.ProcessEnv;
  deps?: ConnectorPlacementDryRunDeps;
} = {}): ConnectorPlacementDryRunResult {
  if (!isConnectorPlacementDryRunEnabled(options.env)) return emptyResult(false);

  const deps = options.deps ?? defaultDeps;
  const connectors = deps.listConnectors();
  const activeUsers = deps.listUsers()
    .filter((user) => user.status === 'active' && Number.isSafeInteger(user.id) && user.id > 0)
    .sort((a, b) => a.id - b.id);
  const activeUserIds = new Set(activeUsers.map((user) => user.id));
  const desired: DesiredPlacement[] = [];
  const errors: ConnectorPlacementDryRunResult['errors'] = [];
  let eligible = 0;

  const recordError = (code: ConnectorPlacementDryRunErrorCode): void => {
    // No connector id/reference is returned. A short hash of a predictable id
    // is dictionary-reversible; omitting the correlation field is safer than
    // inventing a new redaction secret merely for dry-run diagnostics.
    errors.push({ code });
  };

  for (const connector of [...connectors].sort((a, b) => a.id.localeCompare(b.id))) {
    if (!connector.enabled) continue;
    if (connector.credentialMode !== 'per_member') {
      recordError('CONNECTOR_SHARED_SCOPE_NOT_ARMED');
      continue;
    }
    if (!Number.isSafeInteger(connector.ownerUserId) || (connector.ownerUserId ?? 0) <= 0) {
      recordError('CONNECTOR_OWNER_MISSING');
      continue;
    }
    const ownerUserId = connector.ownerUserId as number;
    if (!activeUserIds.has(ownerUserId)) {
      recordError('CONNECTOR_OWNER_INACTIVE');
      continue;
    }
    if (!deps.hasCredential(connector, ownerUserId)) {
      recordError('CONNECTOR_CREDENTIAL_MISSING');
      continue;
    }

    eligible += 1;
    for (const target of PLACEMENT_TARGETS) {
      desired.push({
        connectorId: connector.id,
        memberUserId: ownerUserId,
        bodyProvider: target.bodyProvider,
        contractVersion: target.contractVersion,
        desiredFingerprint: desiredFingerprint(connector, ownerUserId, target),
      });
    }
  }

  desired.sort((a, b) =>
    a.connectorId.localeCompare(b.connectorId)
    || a.memberUserId - b.memberUserId
    || a.bodyProvider.localeCompare(b.bodyProvider));
  errors.sort((a, b) => a.code.localeCompare(b.code));

  const errorsByCode: ConnectorPlacementDryRunResult['metrics']['errorsByCode'] = {};
  for (const error of errors) errorsByCode[error.code] = (errorsByCode[error.code] ?? 0) + 1;

  return {
    enabled: true,
    dryRun: true,
    checksum: sha256(JSON.stringify(desired)),
    metrics: {
      connectorsScanned: connectors.length,
      connectorsEligible: eligible,
      activeMembers: activeUsers.length,
      desiredPlacements: desired.length,
      blockedConnectors: errors.length,
      errorsByCode,
    },
    errors,
  };
}

export type PlacementFence = {
  desiredGeneration: number;
  fencingToken: number;
  leaseExpiresAtMs: number;
};

export type PlacementFenceErrorCode =
  | 'PLACEMENT_LEASE_EXPIRED'
  | 'PLACEMENT_STALE_FENCING_TOKEN'
  | 'PLACEMENT_STALE_DESIRED_GENERATION';

/** Models the monotonically fenced lease acquisition used by the later writer. */
export function nextPlacementFence(
  previousFencingToken: number,
  desiredGeneration: number,
  nowMs: number,
  ttlMs: number,
): PlacementFence {
  if (!Number.isSafeInteger(previousFencingToken) || previousFencingToken < 0) {
    throw new TypeError('previousFencingToken must be a non-negative safe integer');
  }
  if (!Number.isSafeInteger(desiredGeneration) || desiredGeneration < 0) {
    throw new TypeError('desiredGeneration must be a non-negative safe integer');
  }
  if (!Number.isSafeInteger(nowMs) || !Number.isSafeInteger(ttlMs) || nowMs < 0 || ttlMs <= 0) {
    throw new TypeError('lease times must be positive safe integers');
  }
  const fencingToken = previousFencingToken + 1;
  const leaseExpiresAtMs = nowMs + ttlMs;
  if (!Number.isSafeInteger(fencingToken) || !Number.isSafeInteger(leaseExpiresAtMs)) {
    throw new RangeError('placement fence overflow');
  }
  return { desiredGeneration, fencingToken, leaseExpiresAtMs };
}

/** A commit is valid only for the current unexpired token AND desired generation. */
export function validatePlacementFence(
  current: PlacementFence,
  presented: Pick<PlacementFence, 'desiredGeneration' | 'fencingToken'>,
  nowMs: number,
): PlacementFenceErrorCode | null {
  assertSafeNonNegativeInteger(current.desiredGeneration, 'current.desiredGeneration');
  assertSafeNonNegativeInteger(current.fencingToken, 'current.fencingToken');
  assertSafeNonNegativeInteger(current.leaseExpiresAtMs, 'current.leaseExpiresAtMs');
  assertSafeNonNegativeInteger(presented.desiredGeneration, 'presented.desiredGeneration');
  assertSafeNonNegativeInteger(presented.fencingToken, 'presented.fencingToken');
  assertSafeNonNegativeInteger(nowMs, 'nowMs');
  if (current.fencingToken !== presented.fencingToken) return 'PLACEMENT_STALE_FENCING_TOKEN';
  if (current.desiredGeneration !== presented.desiredGeneration) {
    return 'PLACEMENT_STALE_DESIRED_GENERATION';
  }
  if (nowMs >= current.leaseExpiresAtMs) return 'PLACEMENT_LEASE_EXPIRED';
  return null;
}

function assertSafeNonNegativeInteger(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${field} must be a non-negative safe integer`);
  }
}
