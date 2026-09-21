import crypto from 'node:crypto';

import {
  fingerprintConnectorPlacementAbsence,
  fingerprintConnectorPlacementMaterial,
  verifyConnectorPlacementFingerprint,
  type ConnectorPlacementFingerprint,
  type ConnectorPlacementMaterial,
} from '@/modules/connectors/connector-placement-material.js';
import { mcpServerNameFor } from '@/modules/connectors/connector-placement-definition.js';
import type {
  ConnectorPlacementKey,
  ConnectorPlacementLease,
} from '@/modules/database/index.js';
import type { UpsertProviderMcpServerInput } from '@/shared/types.js';

export const CONNECTOR_RECONCILER_WRITE_FLAG = 'NASSAJ_CONNECTOR_RECONCILER_WRITE';

export type ConnectorPlacementWriterPlan = {
  key: ConnectorPlacementKey;
  credentialMode: 'per_member';
  ownerUserId: number;
  scope: 'user';
  desiredEntry: UpsertProviderMcpServerInput | null;
  /** Full provider-native raw map value; null only for authenticated absence. */
  desiredMaterial: ConnectorPlacementMaterial | null;
  /** Connector-row/secret revision checked atomically by stageDesiredIfSourceCurrent. */
  sourceRevision: number;
};

type ConfigWriteProof = {
  desiredProof: ConnectorPlacementFingerprint;
  priorAppliedProof: ConnectorPlacementFingerprint | null;
};

export type ConnectorPlacementWriterLedger = {
  upsertDesired(key: ConnectorPlacementKey, proof: ConnectorPlacementFingerprint): unknown;
  acquireLease(
    key: ConnectorPlacementKey,
    input: { ownerId: string; nowMs: number; leaseMs: number },
  ): ConnectorPlacementLease | null;
  getConfigWriteProof(lease: ConnectorPlacementLease, nowMs: number): ConfigWriteProof | null;
  markHealthy(
    lease: ConnectorPlacementLease,
    proof: ConnectorPlacementFingerprint,
    nowMs: number,
  ): boolean;
  markFailure(
    lease: ConnectorPlacementLease,
    input: { nowMs: number; retryAfterMs: number; errorCode: string; blocked?: boolean },
  ): boolean;
};

/**
 * Adapter boundary for B-764. A real adapter must use the canonical provider
 * config lock and keep fence recheck, ownership, atomic mutation, and readback
 * inside the one callback. It must not wrap providerMcpService.upsert with a
 * second copy of the same lock.
 */
export type ConnectorPlacementTargetAdapter = {
  reconcile(
    plan: ConnectorPlacementWriterPlan,
    input: {
      desired: UpsertProviderMcpServerInput | null;
      assertFenceCurrent(): void | Promise<void>;
      decide(current: ConnectorPlacementTargetObservation): 'keep' | 'apply' | Promise<'keep' | 'apply'>;
      assertAfter(after: ConnectorPlacementTargetObservation): void | Promise<void>;
    },
  ): Promise<{ applied: boolean; after: ConnectorPlacementTargetObservation }>;
  materialForObserved(
    plan: ConnectorPlacementWriterPlan,
    /** Exact raw map value, including unknown fields; normalization is forbidden here. */
    rawEntry: unknown,
  ): ConnectorPlacementMaterial;
};

export type ConnectorPlacementTargetObservation = {
  present: boolean;
  raw: unknown | null;
};

export type ConnectorPlacementWriterDeps = {
  /** This is the only dependency allowed to read connector credentials. */
  loadPlans(): Promise<ConnectorPlacementWriterPlan[]>;
  reloadPlan(key: ConnectorPlacementKey): Promise<ConnectorPlacementWriterPlan | null>;
  /** Must atomically reject a plan whose sourceRevision is no longer current. */
  stageDesiredIfSourceCurrent(
    plan: ConnectorPlacementWriterPlan,
    proof: ConnectorPlacementFingerprint,
  ): boolean;
  ledger: ConnectorPlacementWriterLedger;
  target: ConnectorPlacementTargetAdapter;
  now(): number;
  ownerId(): string;
  fingerprint?(material: ConnectorPlacementMaterial): ConnectorPlacementFingerprint;
  fingerprintAbsence?(
    key: Omit<ConnectorPlacementMaterial, 'body' | 'credential'>,
  ): ConnectorPlacementFingerprint;
  verify?(
    material: ConnectorPlacementMaterial,
    proof: ConnectorPlacementFingerprint,
  ): boolean;
};

export type ConnectorPlacementWriterErrorCode =
  | 'COLLISION'
  | 'LEASE_UNAVAILABLE'
  | 'PLACEMENT_FAILED'
  | 'STALE_WRITE'
  | 'UNSUPPORTED_PLAN';

export type ConnectorPlacementWriterResult = {
  enabled: boolean;
  policy: 'all-verified-or-explicit-partial';
  // `needs_reconciliation` and `rollback_incomplete` are set only by the
  // composition layer after a partial present-distribution is rolled back to
  // absence (T-1529/C4, B-851). `needs_reconciliation` means the compensating
  // absence pass verified every body back to absent — no secret remains.
  // `rollback_incomplete` means that pass ITSELF only half-succeeded, so the
  // credential may still sit in a body the sweep could not clear; the caller
  // cannot assume the tree is clean and must retry the reconcile. The writer
  // itself never emits either; callers must treat BOTH as NOT available.
  state: 'disabled' | 'verified' | 'partial' | 'needs_reconciliation' | 'rollback_incomplete';
  metrics: {
    targetsPlanned: number;
    targetsVerified: number;
    targetsBlocked: number;
    targetsFailed: number;
    convergeForwardAttempts: number;
    errorsByCode: Partial<Record<ConnectorPlacementWriterErrorCode, number>>;
  };
};

type TargetOutcome = {
  state: 'verified' | 'blocked' | 'failed';
  code?: ConnectorPlacementWriterErrorCode;
  attempts: number;
  sourceRevision?: number;
};

const LEASE_MS = 30_000;
const RETRY_MS = 5_000;
const MAX_ATTEMPTS = 3;

function sameProof(
  left: ConnectorPlacementFingerprint,
  right: ConnectorPlacementFingerprint,
): boolean {
  if (left.version !== right.version) return false;
  if (!/^[0-9a-f]{64}$/.test(left.fingerprint) || !/^[0-9a-f]{64}$/.test(right.fingerprint)) {
    return false;
  }
  return crypto.timingSafeEqual(
    Buffer.from(left.fingerprint, 'hex'),
    Buffer.from(right.fingerprint, 'hex'),
  );
}

function validPlan(plan: ConnectorPlacementWriterPlan): boolean {
  return plan.credentialMode === 'per_member'
    && Number.isSafeInteger(plan.ownerUserId)
    && plan.ownerUserId > 0
    && plan.ownerUserId === plan.key.memberUserId
    && plan.scope === 'user'
    && Number.isSafeInteger(plan.sourceRevision)
    && plan.sourceRevision >= 0
    && plan.sourceRevision % 2 === 0
    && (plan.key.bodyProvider === 'claude' || plan.key.bodyProvider === 'codex')
    && plan.key.contractVersion === 'mcp-user-v1'
    && (plan.desiredMaterial === null
      ? plan.desiredEntry === null
      : (plan.desiredEntry !== null
        && plan.desiredMaterial.connectorId === plan.key.connectorId
        && plan.desiredMaterial.memberUserId === plan.key.memberUserId
        && plan.desiredMaterial.bodyProvider === plan.key.bodyProvider
        && plan.desiredMaterial.contractVersion === plan.key.contractVersion
        && plan.desiredEntry.name === mcpServerNameFor({ id: plan.key.connectorId })
        && plan.desiredEntry.scope === 'user'
        && plan.desiredEntry.userId === plan.ownerUserId));
}

function emptyResult(): ConnectorPlacementWriterResult {
  return {
    enabled: false,
    policy: 'all-verified-or-explicit-partial',
    state: 'disabled',
    metrics: {
      targetsPlanned: 0,
      targetsVerified: 0,
      targetsBlocked: 0,
      targetsFailed: 0,
      convergeForwardAttempts: 0,
      errorsByCode: {},
    },
  };
}

function plansHaveCompleteTargetPairs(plans: ConnectorPlacementWriterPlan[]): boolean {
  if (plans.length === 0) return false;
  const groups = new Map<string, ConnectorPlacementWriterPlan[]>();
  for (const plan of plans) {
    const id = `${plan.key.connectorId}:${plan.key.memberUserId}:${plan.key.contractVersion}`;
    const targets = groups.get(id) ?? [];
    targets.push(plan);
    groups.set(id, targets);
  }
  return [...groups.values()].every((targets) => {
    const providers = targets.map((target) => target.key.bodyProvider);
    return targets.length === 2
      && new Set(providers).size === 2
      && providers.includes('claude')
      && providers.includes('codex')
      && targets[0]?.sourceRevision === targets[1]?.sourceRevision;
  });
}

/** Every value except the exact string `1` leaves the writer inert. */
export function isConnectorPlacementWriterEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[CONNECTOR_RECONCILER_WRITE_FLAG] === '1';
}

async function reconcileTarget(
  initialPlan: ConnectorPlacementWriterPlan,
  deps: ConnectorPlacementWriterDeps,
): Promise<TargetOutcome> {
  const fingerprint = deps.fingerprint ?? fingerprintConnectorPlacementMaterial;
  const fingerprintAbsence = deps.fingerprintAbsence ?? fingerprintConnectorPlacementAbsence;
  const verify = deps.verify ?? ((material, proof) =>
    verifyConnectorPlacementFingerprint(material, proof).valid);
  let lastSourceRevision = initialPlan.sourceRevision;
  let convergeForwardProof: ConnectorPlacementFingerprint | null = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const plan = await deps.reloadPlan(initialPlan.key);
    if (!plan || !validPlan(plan) || keyOfPlan(plan) !== keyOfPlan(initialPlan)) {
      return {
        state: 'failed', code: 'UNSUPPORTED_PLAN', attempts: attempt, sourceRevision: lastSourceRevision,
      };
    }
    lastSourceRevision = plan.sourceRevision;
    const desiredProof = plan.desiredMaterial
      ? fingerprint(plan.desiredMaterial)
      : fingerprintAbsence({
        connectorId: plan.key.connectorId,
        memberUserId: plan.key.memberUserId,
        bodyProvider: plan.key.bodyProvider,
        contractVersion: plan.key.contractVersion,
      });
    if (!deps.stageDesiredIfSourceCurrent(plan, desiredProof)) continue;
    const lease = deps.ledger.acquireLease(plan.key, {
      ownerId: deps.ownerId(),
      nowMs: deps.now(),
      leaseMs: LEASE_MS,
    });
    if (!lease) {
      return {
        state: 'failed', code: 'LEASE_UNAVAILABLE', attempts: attempt, sourceRevision: plan.sourceRevision,
      };
    }

    try {
      let fence: ConfigWriteProof | null = null;
      let collision = false;
      const transaction = await deps.target.reconcile(plan, {
        desired: plan.desiredEntry,
        assertFenceCurrent: () => {
          fence = deps.ledger.getConfigWriteProof(lease, deps.now());
          if (!fence || !sameProof(fence.desiredProof, desiredProof)) {
            throw new Error('connector_placement_fence_stale');
          }
        },
        decide: (observed) => {
          if (!fence) throw new Error('connector_placement_fence_stale');
          if (!observed.present) return plan.desiredEntry === null ? 'keep' : 'apply';
          const observedMaterial = deps.target.materialForObserved(plan, observed.raw);
          if (plan.desiredMaterial && verify(observedMaterial, desiredProof)) return 'keep';
          if (fence.priorAppliedProof && verify(observedMaterial, fence.priorAppliedProof)) return 'apply';
          if (convergeForwardProof && verify(observedMaterial, convergeForwardProof)) return 'apply';
          collision = true;
          return 'keep';
        },
        assertAfter: (after) => {
          if (collision) return;
          const valid = plan.desiredEntry === null
            ? !after.present
            : after.present && plan.desiredMaterial !== null
              && verify(deps.target.materialForObserved(plan, after.raw), desiredProof);
          if (!valid) throw new Error('connector_placement_readback_stale');
        },
      });

      if (collision) {
        const recorded = deps.ledger.markFailure(lease, {
          nowMs: deps.now(), retryAfterMs: 0, errorCode: 'connector_collision', blocked: true,
        });
        if (recorded) {
          return {
            state: 'blocked', code: 'COLLISION', attempts: attempt, sourceRevision: plan.sourceRevision,
          };
        }
        continue;
      }
      const readBackVerified = plan.desiredEntry === null
        ? !transaction.after.present
        : transaction.after.present && plan.desiredMaterial !== null
          && verify(deps.target.materialForObserved(plan, transaction.after.raw), desiredProof);
      if (!readBackVerified) {
        deps.ledger.markFailure(lease, {
          nowMs: deps.now(), retryAfterMs: 0, errorCode: 'stale_write',
        });
        continue;
      }
      convergeForwardProof = desiredProof;
      if (deps.ledger.markHealthy(lease, desiredProof, deps.now())) {
        const latest = await deps.reloadPlan(plan.key);
        if (latest?.sourceRevision === plan.sourceRevision) {
          return { state: 'verified', attempts: attempt, sourceRevision: plan.sourceRevision };
        }
        continue;
      }
      // CAS loss after a verified write converges forward immediately. The next
      // owner either adopts these exact bytes or updates from the prior proof.
    } catch (error) {
      if (
        error instanceof Error
        && (error.message === 'connector_placement_fence_stale'
          || error.message === 'connector_placement_readback_stale')
      ) {
        deps.ledger.markFailure(lease, {
          nowMs: deps.now(), retryAfterMs: 0, errorCode: 'stale_write',
        });
        continue;
      }
      const recorded = deps.ledger.markFailure(lease, {
        nowMs: deps.now(), retryAfterMs: RETRY_MS, errorCode: 'placement_failed',
      });
      if (!recorded) continue;
      return {
        state: 'failed', code: 'PLACEMENT_FAILED', attempts: attempt, sourceRevision: plan.sourceRevision,
      };
    }
  }
  return {
    state: 'failed', code: 'STALE_WRITE', attempts: MAX_ATTEMPTS, sourceRevision: lastSourceRevision,
  };
}

function keyOfPlan(plan: ConnectorPlacementWriterPlan): string {
  return `${plan.key.connectorId}:${plan.key.memberUserId}:${plan.key.bodyProvider}:${plan.key.contractVersion}`;
}

/**
 * Dormant writer entry point. The feature flag is deliberately the first branch:
 * while off, even dependency getters remain untouched.
 */
export async function runConnectorPlacementWriter(options: {
  env?: NodeJS.ProcessEnv;
  deps: ConnectorPlacementWriterDeps;
}): Promise<ConnectorPlacementWriterResult> {
  if (!isConnectorPlacementWriterEnabled(options.env)) return emptyResult();

  const plans = await options.deps.loadPlans();
  if (!plansHaveCompleteTargetPairs(plans) || plans.some((plan) => !validPlan(plan))) {
    const invalidTargets = Math.max(1, plans.length);
    return {
      enabled: true,
      policy: 'all-verified-or-explicit-partial',
      state: 'partial',
      metrics: {
        targetsPlanned: plans.length,
        targetsVerified: 0,
        targetsBlocked: 0,
        targetsFailed: invalidTargets,
        convergeForwardAttempts: 0,
        errorsByCode: { UNSUPPORTED_PLAN: invalidTargets },
      },
    };
  }
  let currentPlans = plans;
  let outcomes: TargetOutcome[] = [];
  let priorAttempts = 0;
  let allLatestPairVerified = false;
  for (let round = 1; round <= MAX_ATTEMPTS; round += 1) {
    outcomes = [];
    for (const plan of currentPlans) outcomes.push(await reconcileTarget(plan, options.deps));
    const latest = await Promise.all(currentPlans.map((plan) => options.deps.reloadPlan(plan.key)));
    const latestPlans = latest.filter((plan): plan is ConnectorPlacementWriterPlan => plan !== null);
    const revisionsCurrent = latestPlans.length === currentPlans.length
      && outcomes.every((outcome, index) =>
        outcome.state === 'verified'
        && outcome.sourceRevision === latestPlans[index]?.sourceRevision)
      && plansHaveCompleteTargetPairs(latestPlans);
    if (revisionsCurrent) {
      allLatestPairVerified = true;
      break;
    }
    const revisionsChanged = latestPlans.length === currentPlans.length
      && latestPlans.some((plan, index) => plan.sourceRevision !== outcomes[index]?.sourceRevision);
    if (!revisionsChanged || round === MAX_ATTEMPTS) break;
    priorAttempts += outcomes.reduce((total, outcome) => total + outcome.attempts, 0);
    currentPlans = latestPlans;
  }

  const errorsByCode: ConnectorPlacementWriterResult['metrics']['errorsByCode'] = {};
  for (const outcome of outcomes) {
    if (outcome.code) errorsByCode[outcome.code] = (errorsByCode[outcome.code] ?? 0) + 1;
  }
  const targetsVerified = outcomes.filter((outcome) => outcome.state === 'verified').length;
  const targetsBlocked = outcomes.filter((outcome) => outcome.state === 'blocked').length;
  const targetsFailed = outcomes.filter((outcome) => outcome.state === 'failed').length;
  return {
    enabled: true,
    policy: 'all-verified-or-explicit-partial',
    state: allLatestPairVerified && targetsVerified === plans.length ? 'verified' : 'partial',
    metrics: {
      targetsPlanned: plans.length,
      targetsVerified,
      targetsBlocked,
      targetsFailed,
      convergeForwardAttempts: outcomes.reduce(
        (total, outcome) => total + Math.max(0, outcome.attempts - 1),
        priorAttempts,
      ),
      errorsByCode,
    },
  };
}
