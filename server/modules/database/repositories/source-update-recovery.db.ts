/** SQLite-only registration of a previously verified, operation-bound local recovery candidate. */
import crypto from 'node:crypto';

import type Database from 'better-sqlite3';

import { insertPendingServerAction, getPendingServerActionById } from '@/modules/database/repositories/pending-server-actions.db.js';

import { inspectManualRecoveryRollbackState as inspectManualRecoveryRollbackStateCore,
  manualRecoveryRegistrationIdentity, reconcileManualRecoveryRollback as reconcileManualRecoveryRollbackCore,
} from '../../../../scripts/lib/source-update-manual-rollback-db.mjs';

type TreeIdentity = { sha256: string; files: number };
export type LocalRecoveryOperationBinding = {
  schema: 'nassaj-local-source-recovery-operation/v1';
  root: string; nodeIdentity: string; jobId: string; actionId: string; transactionId: string; ownerId: number;
  approvalReference: string; reservationReference: string; previousSourceOid: string;
  previousRuntime: { oid: string; serverBuildId: string; clientBuildId: string; pid: number; startTicks: string;
    controlManifestSha256: string; actualTrees: { client: TreeIdentity; server: TreeIdentity; nodeModules: TreeIdentity } };
  modeTransition: { from: 'release'; to: 'local-main'; configReceiptId: string; configBindingSha256: string;
    originalEnvSha256: string; proposalEnvSha256: string };
};

export type PreparedRecoveryRegistration = {
  jobId: string; actionId: string; transactionId: string; ownerId: number; version: string; sourceOid: string;
  sourceTreeSha256: string; manifestPath: string; manifestSha256: string; activationIdentitySha256: string;
  operationPacketSha256: string;
  expectedServerBuildId: string; expectedClientBuildId: string; operationBinding: LocalRecoveryOperationBinding;
};

const SHA = /^[a-f0-9]{64}$/;
const sha = (value: string) => crypto.createHash('sha256').update(value).digest('hex');
const fail = (reason: string): never => { throw new Error(`local_recovery_registration_${reason}`); };

function registrationIdentity(input: PreparedRecoveryRegistration) {
  return manualRecoveryRegistrationIdentity(input);
}

function assertRegisteredJob(input: PreparedRecoveryRegistration, identity: ReturnType<typeof registrationIdentity>, existing: Record<string, unknown>) {
  if (existing.id !== input.jobId || existing.request_fingerprint !== identity.requestFingerprint) fail('identity_conflict');
  const expected = { owner_id: input.ownerId, transaction_id: input.transactionId, expected_version: input.version,
    idempotency_key_hash: identity.idempotencyKeyHash, strategy: 'git-checkout-v2', auto_activate: 0,
    release_commit: input.sourceOid, source_tree_sha256: input.sourceTreeSha256,
    activation_identity_sha256: input.activationIdentitySha256, expected_server_build_id: input.expectedServerBuildId,
    expected_client_build_id: input.expectedClientBuildId, release_id: null, release_tag: null,
    release_asset_id: null, release_asset_name: null, release_asset_size: null, release_asset_sha256: null, archive_sha256: null };
  if (Object.entries(expected).some(([key, value]) => existing[key] !== value)) fail('replay_job_changed');
}

function replay(db: Database.Database, input: PreparedRecoveryRegistration, identity: ReturnType<typeof registrationIdentity>, existing: Record<string, unknown>) {
  if (existing.state !== 'restart_queued') fail('blocked_manual_reconciliation');
  assertRegisteredJob(input, identity, existing);
  const receipt = db.prepare('SELECT facts_sha256, facts_json FROM source_update_receipts WHERE job_id = ? AND sequence = 1')
    .get(input.jobId) as { facts_sha256: string; facts_json: string } | undefined;
  const action = getPendingServerActionById(db, input.actionId);
  if (receipt?.facts_sha256 !== identity.factsSha256 || receipt.facts_json !== identity.factsJson
    || action?.status !== 'pending' || action.sourceUpdateJobId !== input.jobId || action.sourceUpdateTransactionId !== input.transactionId
    || action.activationIdentitySha256 !== input.activationIdentitySha256 || action.releaseCommit !== input.sourceOid
    || action.expectedServerBuildId !== input.expectedServerBuildId) fail('replay_evidence_changed');
  return { job: existing, action, reused: true, factsSha256: identity.factsSha256 };
}

/** Register job, receipt and bound pending action atomically; never expose a worker-consumable state or grant activation consent. */
export function registerPreparedRecoveryCandidate(db: Database.Database, input: PreparedRecoveryRegistration, activeStates: readonly string[], assertStillCurrent: () => void = () => {}) {
  const identity = registrationIdentity(input);
  return db.transaction(() => {
    assertStillCurrent();
    const owner = db.prepare("SELECT username FROM users WHERE id = ? AND role = 'owner' AND is_active = 1")
      .get(input.ownerId) as { username: string } | undefined;
    if (!owner) return fail('owner_required');
    const existing = db.prepare('SELECT * FROM source_update_jobs WHERE id = ? OR transaction_id = ? OR (owner_id = ? AND idempotency_key_hash = ?)')
      .get(input.jobId, input.transactionId, input.ownerId, identity.idempotencyKeyHash) as Record<string, unknown> | undefined;
    if (existing) return replay(db, input, identity, existing);
    if (db.prepare(`SELECT 1 FROM source_update_jobs WHERE state IN (${activeStates.map(() => '?').join(',')}) OR state = 'manual_recovery_required' LIMIT 1`).get(...activeStates)) fail('active_job_conflict');
    const control = db.prepare('SELECT * FROM source_update_control WHERE singleton = 1').get() as Record<string, unknown>;
    if (control.active_job_id || control.worker_id || db.prepare("SELECT 1 FROM source_update_effects WHERE state = 'running' LIMIT 1").get()) fail('worker_conflict');
    if (db.prepare("SELECT 1 FROM pending_server_actions WHERE action_type = 'safe-restart' AND status = 'executing' LIMIT 1").get()) fail('action_executing');
    if (db.prepare("SELECT 1 FROM pending_server_actions WHERE action_type = 'safe-restart' AND status = 'pending' LIMIT 1").get()) fail('action_conflict');
    const fence = Number(control.fence_epoch) + 1;
    db.prepare(`INSERT INTO source_update_jobs (id, expected_version, owner_id, idempotency_key_hash, request_fingerprint,
      strategy, state, worker_fence, transaction_id, release_commit, source_tree_sha256, activation_identity_sha256,
      expected_server_build_id, expected_client_build_id, auto_activate)
      VALUES (?, ?, ?, ?, ?, 'git-checkout-v2', 'restart_queued', ?, ?, ?, ?, ?, ?, ?, 0)`)
      .run(input.jobId, input.version, input.ownerId, identity.idempotencyKeyHash, identity.requestFingerprint, fence,
        input.transactionId, input.sourceOid, input.sourceTreeSha256, input.activationIdentitySha256, input.expectedServerBuildId, input.expectedClientBuildId);
    db.prepare(`INSERT INTO source_update_receipts(job_id, sequence, worker_fence, phase, kind, facts_json, facts_sha256)
      VALUES (?, 1, ?, 'restart_queued', 'recovery', ?, ?)`).run(input.jobId, fence, identity.factsJson, identity.factsSha256);
    const inserted = insertPendingServerAction(db, { id: input.actionId, actionType: 'safe-restart', requestedBy: owner.username,
      reason: `تفعيل نساج ${input.version} من main (${input.sourceOid.slice(0, 10)}) على هذه العقدة، والتحويل إلى التحديث المحلي بعد خلو الجلسات`, expectedServerBuildId: input.expectedServerBuildId,
      sourceUpdateJobId: input.jobId, sourceUpdateTransactionId: input.transactionId,
      activationIdentitySha256: input.activationIdentitySha256, releaseCommit: input.sourceOid });
    if (inserted !== 1) fail('action_conflict');
    db.prepare('UPDATE source_update_control SET fence_epoch = ? WHERE singleton = 1').run(fence);
    return { job: db.prepare('SELECT * FROM source_update_jobs WHERE id = ?').get(input.jobId) as Record<string, unknown>,
      action: getPendingServerActionById(db, input.actionId), reused: false, factsSha256: identity.factsSha256 };
  }).immediate();
}

export type RecoveryRollbackReconciliation = {
  registration: PreparedRecoveryRegistration; reconciliationPacketSha256: string; evidenceSha256: string;
  approvalReference: string; restoredProcess: { pid: number; startTicks: string };
};

export type ManualRecoveryRollback = {
  registration: PreparedRecoveryRegistration; operationPacketSha256: string; runtimePacketSha256: string; ownerAck: string;
  evidenceSha256: string;
};

/** Verify the exact post-consent MANUAL tuple without writing; callers run this before filesystem rollback. */
export function inspectManualRecoveryRollbackState(db: Database.Database, registration: PreparedRecoveryRegistration,
  activeStates: readonly string[]) {
  return inspectManualRecoveryRollbackStateCore(db, registration, activeStates);
}

/** Settle the one post-consent MANUAL recovery shape after physical rollback is proven. */
export function reconcileManualRecoveryRollback(db: Database.Database, input: ManualRecoveryRollback,
  activeStates: readonly string[], assertStillCurrent: () => void) {
  return reconcileManualRecoveryRollbackCore(db, input, activeStates, assertStillCurrent);
}

/** Settle only the previously registered recovery job after a separately verified PRE_CANDIDATE rollback. */
export function reconcilePreparedRecoveryRollback(db: Database.Database, input: RecoveryRollbackReconciliation,
  activeStates: readonly string[], assertStillCurrent: () => void) {
  const original = registrationIdentity(input.registration);
  if (![input.reconciliationPacketSha256, input.evidenceSha256].every(value => SHA.test(value))
    || !input.restoredProcess || Object.keys(input.restoredProcess).sort().join(',') !== 'pid,startTicks'
    || !/^[A-Za-z0-9][A-Za-z0-9._:/#-]{0,199}$/.test(input.approvalReference)
    || !Number.isSafeInteger(input.restoredProcess.pid) || input.restoredProcess.pid < 2
    || !/^[1-9][0-9]*$/.test(input.restoredProcess.startTicks) || typeof assertStillCurrent !== 'function') fail('reconciliation_identity');
  const factsJson = JSON.stringify({ code: 'local_recovery_rollback_reconciled', ...input }), factsSha256 = sha(factsJson);
  return db.transaction(() => {
    assertStillCurrent();
    const r = input.registration;
    const owner = db.prepare("SELECT 1 FROM users WHERE id=? AND role='owner' AND is_active=1").get(r.ownerId);
    if (!owner) fail('owner_required');
    const job = db.prepare('SELECT * FROM source_update_jobs WHERE id=?').get(r.jobId) as Record<string, unknown> | undefined;
    const first = db.prepare('SELECT facts_json,facts_sha256,worker_fence FROM source_update_receipts WHERE job_id=? AND sequence=1')
      .get(r.jobId) as { facts_json: string; facts_sha256: string; worker_fence: number } | undefined;
    if (!job || job.request_fingerprint !== original.requestFingerprint || first?.facts_sha256 !== original.factsSha256
      || first.facts_json !== original.factsJson || job.owner_id !== r.ownerId || job.transaction_id !== r.transactionId
      || job.activation_identity_sha256 !== r.activationIdentitySha256 || job.release_commit !== r.sourceOid
      || job.expected_server_build_id !== r.expectedServerBuildId || job.expected_client_build_id !== r.expectedClientBuildId
      || job.strategy !== 'git-checkout-v2' || job.auto_activate !== 0) return fail('reconciliation_job_changed');
    assertRegisteredJob(r, original, job);
    if (!Number.isSafeInteger(job.worker_fence) || job.worker_fence !== first.worker_fence) fail('reconciliation_fence_changed');
    const previous = db.prepare("SELECT facts_json,facts_sha256 FROM source_update_receipts WHERE job_id=? AND phase='rolled_back' AND kind='recovery'")
      .all(r.jobId) as Array<{ facts_json: string; facts_sha256: string }>;
    if (job.state === 'rolled_back') {
      if (previous.length !== 1 || previous[0].facts_sha256 !== factsSha256 || previous[0].facts_json !== factsJson) fail('reconciliation_replay_changed');
      const settledAction = getPendingServerActionById(db, r.actionId);
      if (settledAction?.status !== 'superseded' || settledAction.sourceUpdateJobId !== r.jobId
        || settledAction.activationIdentitySha256 !== r.activationIdentitySha256) fail('reconciliation_action_changed');
      return { reused: true, jobId: r.jobId, factsSha256 };
    }
    if (job.state !== 'runtime_verifying' || previous.length) fail('reconciliation_state_changed');
    if (db.prepare(`SELECT 1 FROM source_update_jobs WHERE id<>? AND (state IN (${activeStates.map(() => '?').join(',')}) OR state='manual_recovery_required') LIMIT 1`)
      .get(r.jobId, ...activeStates)) fail('active_job_conflict');
    const control = db.prepare('SELECT active_job_id FROM source_update_control WHERE singleton=1').get() as { active_job_id: string | null };
    if (control.active_job_id && control.active_job_id !== r.jobId) fail('worker_conflict');
    const action = getPendingServerActionById(db, r.actionId);
    if (!action || action.sourceUpdateJobId !== r.jobId || action.sourceUpdateTransactionId !== r.transactionId
      || action.activationIdentitySha256 !== r.activationIdentitySha256 || action.releaseCommit !== r.sourceOid
      || action.expectedServerBuildId !== r.expectedServerBuildId
      || !['pending','failed','executing'].includes(action.status)) fail('reconciliation_action_changed');
    const sequence = Number((db.prepare('SELECT COALESCE(MAX(sequence),0)+1 AS n FROM source_update_receipts WHERE job_id=?').get(r.jobId) as { n: number }).n);
    db.prepare("INSERT INTO source_update_receipts(job_id,sequence,worker_fence,phase,kind,facts_json,facts_sha256) VALUES (?,?,?,'rolled_back','recovery',?,?)")
      .run(r.jobId, sequence, job.worker_fence, factsJson, factsSha256);
    const changed = db.prepare("UPDATE source_update_jobs SET state='rolled_back',progress_seq=progress_seq+1,updated_at=CURRENT_TIMESTAMP,completed_at=CURRENT_TIMESTAMP WHERE id=? AND state='runtime_verifying' AND transaction_id=? AND activation_identity_sha256=?")
      .run(r.jobId, r.transactionId, r.activationIdentitySha256).changes;
    if (changed !== 1) fail('reconciliation_cas_failed');
    db.prepare("UPDATE pending_server_actions SET status='superseded',error='local_recovery_rollback_reconciled',settled_at=CURRENT_TIMESTAMP WHERE id=?")
      .run(r.actionId);
    db.prepare(`UPDATE source_update_control SET active_job_id=NULL,worker_id=NULL,pid=NULL,start_ticks=NULL,boot_id=NULL,
      pgid=NULL,lease_expires_at=NULL,updated_at=CURRENT_TIMESTAMP WHERE singleton=1 AND active_job_id=?`).run(r.jobId);
    return { reused: false, jobId: r.jobId, factsSha256 };
  }).immediate();
}
