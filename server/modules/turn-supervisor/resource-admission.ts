/** Atomic host-capacity admission and durable lease lifecycle for every harness. */
import { randomUUID } from 'node:crypto';

import type { Database } from 'better-sqlite3';

import type { SystemResourceSample } from '@/services/system-resource-sampler.service.js';
import { systemResourceSampler } from '@/services/system-resource-sampler.service.js';

export type ResourceReservation = { cpuPercent: number; memoryPercent: number };

export type ResourceAdmissionConfig = {
  thresholdPercent: number;
  globalCap: number;
  perUserCap: number;
  maxSampleAgeMs: number;
};

export type ResourceLease = {
  leaseId: string;
  turnId: string;
  userId: number;
  ownerId: string;
  ownerPid: number;
  cpuReserved: number;
  memoryReserved: number;
  heartbeatAtMs: number;
};

export type AdmissionRequest = {
  turnId: string;
  userId: number;
  ownerId: string;
  ownerPid: number;
  reservation: ResourceReservation;
};

export type AdmissionVerdict =
  | { admitted: true; lease: ResourceLease; idempotent: boolean }
  | {
      admitted: false;
      code: 'measurement_unavailable' | 'admission_unavailable' | 'capacity' | 'global_cap' | 'user_cap' | 'invalid_request';
      reason: string;
    };

export type ProcessExitProof = {
  kind: 'process_exit' | 'process_dead';
  observedAtMs: number;
};

declare const adapterTerminalProofBrand: unique symbol;

export type AdapterTerminalExitProof = {
  readonly kind: 'adapter_terminal';
  readonly observedAtMs: number;
  readonly adapterId: string;
  readonly runId: string;
  readonly writerEpoch: number;
  readonly [adapterTerminalProofBrand]: true;
};

export type ExitProof = ProcessExitProof | AdapterTerminalExitProof;

/**
 * Resource-manager-owned issuer passed to the adapter registry. Proofs are
 * identity-attested and can only be issued after the registry observes settle.
 */
export class AdapterTerminalProofAuthority {
  readonly #issued = new WeakSet<object>();
  #bound = false;

  bindIssuer(): (input: {
    adapterId: string;
    runId: string;
    writerEpoch: number;
    observedAtMs: number;
    settled: true;
  }) => AdapterTerminalExitProof {
    if (this.#bound) throw new Error('adapter proof issuer already bound');
    this.#bound = true;
    return (input) => {
      if (
        input.settled !== true || !input.adapterId || !input.runId
        || !Number.isSafeInteger(input.writerEpoch) || input.writerEpoch < 0
        || !Number.isFinite(input.observedAtMs)
      ) throw new TypeError('invalid adapter terminal attestation');
      const proof = Object.freeze({
        kind: 'adapter_terminal' as const,
        observedAtMs: input.observedAtMs,
        adapterId: input.adapterId,
        runId: input.runId,
        writerEpoch: input.writerEpoch,
      }) as AdapterTerminalExitProof;
      this.#issued.add(proof);
      return proof;
    };
  }

  verifies(proof: AdapterTerminalExitProof): boolean {
    return typeof proof === 'object' && proof !== null && this.#issued.has(proof);
  }
}

export type ResourceAdmissionDeps = {
  sample?: () => Promise<SystemResourceSample>;
  now?: () => number;
  leaseId?: () => string;
};

const DEFAULT_CONFIG: ResourceAdmissionConfig = {
  thresholdPercent: 80,
  globalCap: 8,
  perUserCap: 3,
  maxSampleAgeMs: 1_000,
};

type ActiveTotals = { count: number; cpu: number; memory: number };

function finiteNonNegative(value: number): boolean {
  return Number.isFinite(value) && value >= 0;
}

function validRequest(request: AdmissionRequest): boolean {
  return (
    request.turnId.length > 0 && request.turnId.length <= 256
    && request.ownerId.length > 0 && request.ownerId.length <= 256
    && Number.isSafeInteger(request.userId) && request.userId > 0
    && Number.isSafeInteger(request.ownerPid) && request.ownerPid > 0
    && finiteNonNegative(request.reservation.cpuPercent)
    && finiteNonNegative(request.reservation.memoryPercent)
  );
}

function toLease(row: Record<string, unknown>): ResourceLease {
  return {
    leaseId: String(row.lease_id),
    turnId: String(row.turn_id),
    userId: Number(row.user_id),
    ownerId: String(row.owner_id),
    ownerPid: Number(row.owner_pid),
    cpuReserved: Number(row.cpu_reserved),
    memoryReserved: Number(row.memory_reserved),
    heartbeatAtMs: Number(row.heartbeat_at_ms),
  };
}

/**
 * Admission is serialized with BEGIN IMMEDIATE. Measurement happens first, but
 * every competing process then re-sums reservations while holding the SQLite
 * write lock, closing the classic 79→80 double-admit race.
 */
export async function admitResources(
  db: Database,
  request: AdmissionRequest,
  config: Partial<ResourceAdmissionConfig> = {},
  deps: ResourceAdmissionDeps = {},
): Promise<AdmissionVerdict> {
  if (!validRequest(request)) {
    return { admitted: false, code: 'invalid_request', reason: 'invalid resource admission request' };
  }
  const resolved = { ...DEFAULT_CONFIG, ...config };
  if (
    !Number.isFinite(resolved.thresholdPercent) || resolved.thresholdPercent <= 0 || resolved.thresholdPercent > 100
    || !Number.isSafeInteger(resolved.globalCap) || resolved.globalCap <= 0
    || !Number.isSafeInteger(resolved.perUserCap) || resolved.perUserCap <= 0
    || !Number.isFinite(resolved.maxSampleAgeMs) || resolved.maxSampleAgeMs < 0
  ) {
    return { admitted: false, code: 'invalid_request', reason: 'invalid resource admission configuration' };
  }
  let sample: SystemResourceSample;
  try {
    sample = await (deps.sample ?? (() => systemResourceSampler.sample()))();
  } catch (error) {
    return {
      admitted: false,
      code: 'measurement_unavailable',
      reason: error instanceof Error ? error.message : String(error),
    };
  }
  const now = (deps.now ?? Date.now)();
  if (
    !finiteNonNegative(sample.cpuPercent)
    || !finiteNonNegative(sample.memoryPercent)
    || sample.cpuPercent > 100
    || sample.memoryPercent > 100
    || !Number.isFinite(sample.measuredAt)
    || sample.measuredAt > now
    || now - sample.measuredAt > resolved.maxSampleAgeMs
  ) {
    return { admitted: false, code: 'measurement_unavailable', reason: 'resource sample is invalid or stale' };
  }

  const transact = db.transaction((): AdmissionVerdict => {
    const existing = db.prepare(
      "SELECT * FROM turn_resource_leases WHERE turn_id = ? AND status = 'active'",
    ).get(request.turnId) as Record<string, unknown> | undefined;
    if (existing) {
      const lease = toLease(existing);
      const same = lease.userId === request.userId
        && lease.ownerId === request.ownerId
        && lease.ownerPid === request.ownerPid
        && lease.cpuReserved === request.reservation.cpuPercent
        && lease.memoryReserved === request.reservation.memoryPercent;
      return same
        ? { admitted: true, lease, idempotent: true }
        : { admitted: false, code: 'invalid_request', reason: 'turn already owns a different active lease' };
    }

    const totals = db.prepare(
      `SELECT COUNT(*) AS count,
              COALESCE(SUM(cpu_reserved), 0) AS cpu,
              COALESCE(SUM(memory_reserved), 0) AS memory
         FROM turn_resource_leases WHERE status = 'active'`,
    ).get() as ActiveTotals;
    if (totals.count >= resolved.globalCap) {
      return { admitted: false, code: 'global_cap', reason: 'global active-turn cap reached' };
    }
    const user = db.prepare(
      "SELECT COUNT(*) AS count FROM turn_resource_leases WHERE status = 'active' AND user_id = ?",
    ).get(request.userId) as { count: number };
    if (user.count >= resolved.perUserCap) {
      return { admitted: false, code: 'user_cap', reason: 'per-user active-turn cap reached' };
    }
    const projectedCpu = sample.cpuPercent + totals.cpu + request.reservation.cpuPercent;
    const projectedMemory = sample.memoryPercent + totals.memory + request.reservation.memoryPercent;
    if (projectedCpu >= resolved.thresholdPercent || projectedMemory >= resolved.thresholdPercent) {
      return {
        admitted: false,
        code: 'capacity',
        reason: `projected resources must stay below ${resolved.thresholdPercent}%`,
      };
    }

    const leaseId = (deps.leaseId ?? randomUUID)();
    db.prepare(
      `INSERT INTO turn_resource_leases (
         lease_id, turn_id, user_id, owner_id, owner_pid,
         cpu_reserved, memory_reserved, status, created_at_ms, heartbeat_at_ms
       ) VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
    ).run(
      leaseId, request.turnId, request.userId, request.ownerId, request.ownerPid,
      request.reservation.cpuPercent, request.reservation.memoryPercent, now, now,
    );
    return {
      admitted: true,
      idempotent: false,
      lease: {
        leaseId,
        turnId: request.turnId,
        userId: request.userId,
        ownerId: request.ownerId,
        ownerPid: request.ownerPid,
        cpuReserved: request.reservation.cpuPercent,
        memoryReserved: request.reservation.memoryPercent,
        heartbeatAtMs: now,
      },
    };
  });
  // better-sqlite3's immediate variant is exactly BEGIN IMMEDIATE/COMMIT.
  try {
    return transact.immediate();
  } catch (error) {
    // Missing schema, SQLITE_BUSY after the configured timeout, disk failure,
    // and every other storage anomaly deny the launch. No caller needs to infer
    // whether a thrown transaction committed a reservation.
    return {
      admitted: false,
      code: 'admission_unavailable',
      reason: `resource admission storage unavailable: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/** Refresh every active lease owned by this supervisor instance. */
export function heartbeatOwner(db: Database, ownerId: string, atMs = Date.now()): number {
  if (!ownerId) return 0;
  return db.prepare(
    "UPDATE turn_resource_leases SET heartbeat_at_ms = ? WHERE owner_id = ? AND status = 'active'",
  ).run(atMs, ownerId).changes;
}

export function listStaleActiveLeases(db: Database, staleBeforeMs: number): ResourceLease[] {
  const rows = db.prepare(
    `SELECT * FROM turn_resource_leases
      WHERE status = 'active' AND heartbeat_at_ms < ?
      ORDER BY heartbeat_at_ms ASC`,
  ).all(staleBeforeMs) as Record<string, unknown>[];
  return rows.map(toLease);
}

/**
 * Release is impossible without a proof. The proof and release are written in
 * one BEGIN IMMEDIATE transaction and ownership is checked to prevent a stale
 * supervisor from releasing a replacement's lease.
 */
export function releaseWithExitProof(
  db: Database,
  input: {
    leaseId: string;
    ownerId: string;
    proof: ExitProof;
    adapterProofAuthority?: AdapterTerminalProofAuthority;
  },
): boolean {
  if (!input.leaseId || !input.ownerId || !Number.isFinite(input.proof.observedAtMs)) return false;
  if (
    input.proof.kind === 'adapter_terminal'
    && !input.adapterProofAuthority?.verifies(input.proof)
  ) return false;
  const transact = db.transaction(() => {
    const result = db.prepare(
      `UPDATE turn_resource_leases
          SET exit_proof_at_ms = ?, exit_proof_kind = ?, released_at_ms = ?, status = 'released'
        WHERE lease_id = ? AND owner_id = ? AND status = 'active'
          AND exit_proof_at_ms IS NULL`,
    ).run(
      input.proof.observedAtMs,
      input.proof.kind,
      input.proof.observedAtMs,
      input.leaseId,
      input.ownerId,
    );
    return result.changes === 1;
  });
  return transact.immediate();
}

/** Releases a reservation only while its durable run is still pre-dispatch. */
export function releaseUndispatchedLease(
  db: Database,
  input: { leaseId: string; ownerId: string; runId: string; expectedRunEpoch: number; observedAtMs?: number },
): boolean {
  if (!input.leaseId || !input.ownerId || !input.runId || !Number.isSafeInteger(input.expectedRunEpoch)) {
    return false;
  }
  const at = input.observedAtMs ?? Date.now();
  return db.transaction(() => db.prepare(
    `UPDATE turn_resource_leases
     SET exit_proof_at_ms = ?, exit_proof_kind = 'dispatch_not_started',
         released_at_ms = ?, status = 'released'
     WHERE lease_id = ? AND owner_id = ? AND status = 'active'
       AND EXISTS (
         SELECT 1 FROM turn_supervisor_runs r
         WHERE r.run_id = ? AND r.turn_id = turn_resource_leases.turn_id
           AND r.state = 'claimed' AND r.epoch = ?
       )`,
  ).run(at, at, input.leaseId, input.ownerId, input.runId, input.expectedRunEpoch).changes === 1).immediate();
}

export function activeLeaseCount(db: Database): number {
  return Number((db.prepare(
    "SELECT COUNT(*) AS count FROM turn_resource_leases WHERE status = 'active'",
  ).get() as { count: number }).count);
}
