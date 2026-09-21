import crypto from 'node:crypto';

import {
  connectorPlacementsDb,
  connectorsDb,
  type ConnectorPlacementKey,
  type ConnectorRow,
} from '@/modules/database/index.js';
import { providerMcpService, type ConnectorTargetAdapter } from '@/modules/providers/index.js';
import type { UpsertProviderMcpServerInput } from '@/shared/types.js';
import { AppError } from '@/shared/utils.js';

import type { ConnectorPlacementMaterial } from './connector-placement-material.js';
import {
  readConnectorGrantMaterialSecret,
  revokeAuthorizedConnectorGrantMaterialReference,
  type ConnectorGrantMaterialReference,
} from './connector-user-grant.service.js';
import { mcpServerNameFor } from './connector-placement-definition.js';
import {
  isConnectorPlacementWriterEnabled,
  runConnectorPlacementWriter,
  type ConnectorPlacementWriterDeps,
  type ConnectorPlacementWriterPlan,
  type ConnectorPlacementWriterResult,
} from './connector-placement-writer.js';
import { buildConnectorMcpInput } from './connectors.service.js';

const TARGETS = ['claude', 'codex'] as const;
const SNAPSHOT_ATTEMPTS = 3;

type CompositionTargetAdapter = Pick<ConnectorTargetAdapter, 'reconcile' | 'desiredRaw'>;

export type ConnectorPlacementCompositionSources = {
  getConnector(id: string): ConnectorRow | null;
  buildInput(
    connector: ConnectorRow,
    memberUserId: number,
    credentialOverride?: string,
    materialReference?: ConnectorGrantMaterialReference,
  ): UpsertProviderMcpServerInput | null;
  resolveGrantFanout?(
    connector: ConnectorRow,
    memberUserId: number,
  ): Promise<ReadonlyMap<'claude' | 'codex', ConnectorGrantMaterialReference>>;
  readGrantSecret?(reference: ConnectorGrantMaterialReference): Buffer | null;
  releaseGrantReference?(reference: ConnectorGrantMaterialReference): void;
  /**
   * T-1529/C4 rollback hook. Disabling the connector flips `desired_present` to
   * 0, which is the ONLY ledger-consistent way to stage an absence write: every
   * placement mutation is gated by `c.enabled = p.desired_present`. Returns true
   * when the row transitioned (or was already disabled) so the caller can decide
   * whether a compensating absence pass is worth running.
   */
  disableConnectorForReconciliation?(connectorId: string): boolean;
  targetAdapter(provider: 'claude' | 'codex'): CompositionTargetAdapter;
  ledger: ConnectorPlacementWriterDeps['ledger'] & {
    stageDesiredIfConnectorCurrent(
      key: ConnectorPlacementKey,
      sourceRevision: number,
      proof: Parameters<ConnectorPlacementWriterDeps['stageDesiredIfSourceCurrent']>[1],
      desiredPresent: boolean,
    ): boolean;
  };
  now(): number;
  ownerId(): string;
  fingerprint?: ConnectorPlacementWriterDeps['fingerprint'];
  fingerprintAbsence?: ConnectorPlacementWriterDeps['fingerprintAbsence'];
  verify?: ConnectorPlacementWriterDeps['verify'];
};

const productionSources = (): ConnectorPlacementCompositionSources => ({
  getConnector: (id) => connectorsDb.get(id),
  buildInput: buildConnectorMcpInput,
  resolveGrantFanout: async (connector, memberUserId) => {
    if (process.env.NASSAJ_CONNECTOR_GRANTS_V2 !== '1') return new Map();
    const { resolveProductionConnectorGrantFanout } = await import('./connector-user-grant.production.js');
    const placements = await resolveProductionConnectorGrantFanout(
      connector.id, memberUserId, connector.service, TARGETS.map(engine => ({
      bodyId: `${connector.id}:${engine}`, engine, userId: memberUserId,
      serviceIds: [connector.service], teamShared: false,
      })),
    );
    return new Map(placements.map(placement => [placement.engine as 'claude' | 'codex', placement.material]));
  },
  readGrantSecret: readConnectorGrantMaterialSecret,
  releaseGrantReference: revokeAuthorizedConnectorGrantMaterialReference,
  disableConnectorForReconciliation: (id) => {
    const connector = connectorsDb.get(id);
    if (!connector) return false;
    if (!connector.enabled) return true;
    return connectorsDb.setEnabled(id, false);
  },
  targetAdapter: (provider) => providerMcpService.connectorTargetAdapter(provider),
  ledger: connectorPlacementsDb,
  now: () => Date.now(),
  ownerId: () => crypto.randomUUID(),
});

function readRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function assertPersonalOwner(connector: ConnectorRow, memberUserId: number): void {
  if (connector.credentialMode !== 'per_member') {
    throw new AppError('Shared connector reconciliation is not armed.', {
      code: 'CONNECTOR_ORG_SHARED_RECONCILE_DISABLED', statusCode: 409,
    });
  }
  if (connector.ownerUserId !== memberUserId) {
    throw new AppError('Connector not found.', { code: 'CONNECTOR_NOT_FOUND', statusCode: 404 });
  }
}

function sameSnapshot(left: ConnectorRow, right: ConnectorRow): boolean {
  return left.id === right.id
    && left.sourceRevision === right.sourceRevision
    && left.sourceRevision % 2 === 0
    && left.ownerUserId === right.ownerUserId
    && left.credentialMode === right.credentialMode
    && left.enabled === right.enabled;
}

function credentialFromRaw(connector: ConnectorRow, raw: unknown): string | null {
  const record = readRecord(raw);
  if (!record) return null;
  if (connector.authMode === 'oauth') {
    return `oauth-grant:${connector.id}:${connector.sourceRevision}`;
  }
  if (connector.transport === 'stdio' && connector.keyEnvVar) {
    const env = readRecord(record.env);
    return typeof env?.[connector.keyEnvVar] === 'string'
      ? env[connector.keyEnvVar] as string
      : null;
  }
  if (connector.transport === 'http' && connector.keyHeader) {
    const headers = readRecord(record.headers) ?? readRecord(record.http_headers);
    return typeof headers?.[connector.keyHeader] === 'string'
      ? headers[connector.keyHeader] as string
      : null;
  }
  return null;
}

function sourceMapKey(plan: Pick<ConnectorPlacementWriterPlan, 'key' | 'sourceRevision'>): string {
  return `${plan.key.connectorId}:${plan.key.memberUserId}:${plan.key.bodyProvider}:${plan.sourceRevision}`;
}

function createWriterDeps(
  connectorId: string,
  memberUserId: number,
  sources: ConnectorPlacementCompositionSources,
): ConnectorPlacementWriterDeps {
  const snapshots = new Map<string, Readonly<{
    connector: ConnectorRow;
    grantMaterialRef?: ConnectorGrantMaterialReference;
  }>>();

  const loadStablePlans = async (): Promise<ConnectorPlacementWriterPlan[]> => {
    for (let attempt = 0; attempt < SNAPSHOT_ATTEMPTS; attempt += 1) {
      const before = sources.getConnector(connectorId);
      if (!before) {
        throw new AppError('Connector not found.', { code: 'CONNECTOR_NOT_FOUND', statusCode: 404 });
      }
      assertPersonalOwner(before, memberUserId);
      if (before.sourceRevision % 2 !== 0) continue;

      const grantRefs = before.enabled && sources.resolveGrantFanout
        ? await sources.resolveGrantFanout(before, memberUserId)
        : new Map<'claude' | 'codex', ConnectorGrantMaterialReference>();
      const grantRef = grantRefs.get('claude') ?? grantRefs.get('codex');
      const grantSecret = grantRef
        ? (sources.readGrantSecret ?? readConnectorGrantMaterialSecret)(grantRef)
        : null;
      let desiredEntry: UpsertProviderMcpServerInput | null;
      try {
        desiredEntry = before.enabled
          ? sources.buildInput(
            before, memberUserId, grantSecret?.toString('utf8'), grantRef,
          )
          : null;
      } finally {
        grantSecret?.fill(0);
        if (grantRef) sources.releaseGrantReference?.(grantRef);
      }
      const after = sources.getConnector(connectorId);
      if (!after) {
        throw new AppError('Connector not found.', { code: 'CONNECTOR_NOT_FOUND', statusCode: 404 });
      }
      assertPersonalOwner(after, memberUserId);
      if (!sameSnapshot(before, after)) continue;
      if (before.enabled && !desiredEntry) {
        throw new AppError('Connector credential is not configured.', {
          code: 'CONNECTOR_NOT_CONFIGURED', statusCode: 409,
        });
      }

      return TARGETS.map((bodyProvider) => {
        const raw = desiredEntry === null
          ? null
          : sources.targetAdapter(bodyProvider).desiredRaw(desiredEntry);
        const credential = raw === null ? null : credentialFromRaw(before, raw);
        if (raw !== null && credential === null) {
          throw new AppError('Connector material is incomplete.', {
            code: 'CONNECTOR_MATERIAL_INCOMPLETE', statusCode: 409,
          });
        }
        const plan: ConnectorPlacementWriterPlan = {
          key: {
            connectorId,
            memberUserId,
            bodyProvider,
            contractVersion: 'mcp-user-v1',
          },
          credentialMode: 'per_member',
          ownerUserId: memberUserId,
          scope: 'user',
          desiredEntry,
          desiredMaterial: raw === null ? null : {
            connectorId,
            memberUserId,
            bodyProvider,
            contractVersion: 'mcp-user-v1',
            body: raw,
            credential: credential!,
            ...(grantRefs.get(bodyProvider) ? { grantMaterialRef: grantRefs.get(bodyProvider)! } : {}),
          },
          sourceRevision: before.sourceRevision,
        };
        snapshots.set(sourceMapKey(plan), {
          connector: before,
          ...(grantRefs.get(bodyProvider) ? { grantMaterialRef: grantRefs.get(bodyProvider)! } : {}),
        });
        return plan;
      });
    }
    throw new AppError('The connector source mutation is incomplete.', {
      code: 'CONNECTOR_SOURCE_MUTATION_INCOMPLETE', statusCode: 409,
    });
  };

  return {
    loadPlans: loadStablePlans,
    reloadPlan: async (key) => {
      if (key.connectorId !== connectorId || key.memberUserId !== memberUserId) return null;
      return (await loadStablePlans()).find((plan) => plan.key.bodyProvider === key.bodyProvider) ?? null;
    },
    stageDesiredIfSourceCurrent: (plan, proof) =>
      sources.ledger.stageDesiredIfConnectorCurrent(
        plan.key,
        plan.sourceRevision,
        proof,
        plan.desiredEntry !== null,
      ),
    ledger: sources.ledger,
    target: {
      reconcile: (plan, input) => sources.targetAdapter(plan.key.bodyProvider).reconcile({
        name: plan.desiredEntry?.name ?? mcpServerNameFor({ id: plan.key.connectorId }),
        userId: plan.ownerUserId,
        desired: input.desired,
        decide: (observation) => input.decide({ present: observation.present, raw: observation.raw }),
        assertFenceCurrent: input.assertFenceCurrent,
        assertAfter: (observation) => input.assertAfter({
          present: observation.present,
          raw: observation.raw,
        }),
      }).then((result) => ({
        applied: result.applied,
        after: { present: result.after.present, raw: result.after.raw },
      })),
      materialForObserved: (plan, rawEntry): ConnectorPlacementMaterial => {
        const snapshot = snapshots.get(sourceMapKey(plan));
        if (!snapshot) throw new Error('connector_placement_source_snapshot_missing');
        const credential = credentialFromRaw(snapshot.connector, rawEntry);
        if (!credential) throw new Error('connector_placement_observed_material_invalid');
        return {
          connectorId: plan.key.connectorId,
          memberUserId: plan.key.memberUserId,
          bodyProvider: plan.key.bodyProvider,
          contractVersion: plan.key.contractVersion,
          body: rawEntry,
          credential,
          ...(snapshot.grantMaterialRef ? { grantMaterialRef: snapshot.grantMaterialRef } : {}),
        };
      },
    },
    now: sources.now,
    ownerId: sources.ownerId,
    fingerprint: sources.fingerprint,
    fingerprintAbsence: sources.fingerprintAbsence,
    verify: sources.verify,
  };
}

/** Manual-only production entry point. It has no hook, timer, startup call, or backfill. */
export async function reconcileConnectorPlacements(
  connectorId: string,
  memberUserId: number,
  env: NodeJS.ProcessEnv = process.env,
  injectedSources?: ConnectorPlacementCompositionSources,
): Promise<ConnectorPlacementWriterResult> {
  if (!isConnectorPlacementWriterEnabled(env)) {
    return runConnectorPlacementWriter({ env, deps: null as unknown as ConnectorPlacementWriterDeps });
  }
  const sources = injectedSources ?? productionSources();
  const result = await runConnectorPlacementWriter({
    env,
    deps: createWriterDeps(connectorId, memberUserId, sources),
  });

  // T-1529/C4: a present-distribution that only half-succeeded leaves the
  // verified body carrying the credential in its MCP config while the grant
  // never reaches `available_next_session` (rollout policy demands claude AND
  // codex). Reconcile to absence: disable the source (so `desired_present`
  // becomes 0) and re-run the writer, which now sweeps every body back to
  // absent. The grant returns to its pre-distribution state and no half body
  // keeps the secret. Guarded on the connector still being enabled so an
  // absence reconcile that itself reports partial is never re-disabled.
  if (result.state !== 'partial') return result;
  const current = sources.getConnector(connectorId);
  if (!current || !current.enabled) return result;
  if (!sources.disableConnectorForReconciliation?.(connectorId)) return result;
  const rolledBack = await runConnectorPlacementWriter({
    env,
    deps: createWriterDeps(connectorId, memberUserId, sources),
  });
  // B-851: the compensating absence pass can itself only half-succeed. Only when
  // it verifies EVERY body back to absent is the tree provably clean; that is the
  // `needs_reconciliation` signal the earlier fix always returned. If the pass
  // reports anything else (a `partial` sweep leaving one body unswept), the
  // credential may still sit in a body we could not clear, so we must NOT reuse
  // the clean-rollback code. `rollback_incomplete` tells the caller and the owner
  // that residue is possible and the reconcile has to be retried; its preserved
  // `metrics` (targetsFailed / errorsByCode) name how many bodies were not swept.
  // Both codes are fail-closed downstream: every consumer treats only `verified`
  // as available.
  const state = rolledBack.state === 'verified' ? 'needs_reconciliation' : 'rollback_incomplete';
  return { ...rolledBack, state };
}
