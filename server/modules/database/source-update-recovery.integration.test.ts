import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import Database from 'better-sqlite3';
import { closeConnection, getConnection } from '@/modules/database/connection.js';
import { initializeDatabase } from '@/modules/database/init-db.js';
import { sourceUpdateJobsDb, SOURCE_UPDATE_ACTIVE_STATES } from '@/modules/database/repositories/source-update-jobs.db.js';
import { pendingServerActionsDb } from '@/modules/database/repositories/pending-server-actions.db.js';
import type { PreparedRecoveryRegistration } from '@/modules/database/repositories/source-update-recovery.db.js';
import { registerPreparedRecoveryCandidate, reconcileManualRecoveryRollback, reconcilePreparedRecoveryRollback } from '@/modules/database/repositories/source-update-recovery.db.js';

const hash = 'a'.repeat(64), oid = 'b'.repeat(40);
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
function input(ownerId: number): PreparedRecoveryRegistration {
  const root = '/fixture/nassaj', transactionId = 'recovery-1', jobId = 'job-1', actionId = 'action-1';
  const tree = { sha256: hash, files: 1 };
  return { jobId, actionId, transactionId, ownerId, version: '2.2.0.1', sourceOid: oid,
    sourceTreeSha256: hash, manifestPath: `${root}/.git/nassaj-source-update/candidates/${transactionId}/candidate-manifest.json`,
    manifestSha256: hash, activationIdentitySha256: hash, operationPacketSha256: hash, expectedServerBuildId: hash, expectedClientBuildId: hash,
    operationBinding: { schema: 'nassaj-local-source-recovery-operation/v1', root, nodeIdentity: 'example-node', jobId,
      actionId, transactionId, ownerId, approvalReference: 'T-1772/approval', reservationReference: 'T-1772/reservation',
      previousSourceOid: oid, previousRuntime: { oid: 'c'.repeat(40), serverBuildId: hash, clientBuildId: hash,
        pid: 1234, startTicks: '12345', controlManifestSha256: hash, actualTrees: { client: tree, server: tree, nodeModules: tree } },
      modeTransition: { from: 'release', to: 'local-main', configReceiptId: 'config-1', configBindingSha256: hash,
        originalEnvSha256: hash, proposalEnvSha256: hash } } };
}

async function withDb(run: (request: PreparedRecoveryRegistration) => void) {
  const previous = process.env.DATABASE_PATH, dir = await mkdtemp(path.join(tmpdir(), 'source-recovery-'));
  closeConnection(); process.env.DATABASE_PATH = path.join(dir, 'private.sqlite');
  try {
    await writeFile(process.env.DATABASE_PATH, '', { mode: 0o600, flag: 'wx' });
    await initializeDatabase();
    const owner = getConnection().prepare("INSERT INTO users(username,password_hash,role) VALUES ('recovery-owner','fixture','owner')").run();
    run(input(Number(owner.lastInsertRowid)));
  } finally {
    closeConnection();
    if (previous === undefined) delete process.env.DATABASE_PATH; else process.env.DATABASE_PATH = previous;
    await rm(dir, { recursive: true, force: true });
  }
}

const snapshot = () => ['source_update_jobs','source_update_receipts','pending_server_actions','source_update_control']
  .map(table => getConnection().prepare(`SELECT * FROM ${table}`).all());

function seedManualRollback(request: PreparedRecoveryRegistration) {
  sourceUpdateJobsDb.registerPreparedRecoveryCandidate(request);
  const db = getConnection();
  const job = db.prepare('SELECT worker_fence FROM source_update_jobs WHERE id=?').get(request.jobId) as { worker_fence: number };
  const consent = JSON.stringify({ code: 'owner_activation_consent', ownerId: request.ownerId,
    expectedVersion: request.version, targetDigest: request.activationIdentitySha256 });
  const failure = JSON.stringify({ code: 'update_database_state_unknown', failedPhase: 'runtime_verifying', intervention: 'human' });
  db.prepare("UPDATE source_update_jobs SET state='manual_recovery_required',auto_activate=1 WHERE id=?").run(request.jobId);
  db.prepare("UPDATE pending_server_actions SET status='failed',error='source_update_manual_recovery_required' WHERE id=?").run(request.actionId);
  db.prepare("INSERT INTO source_update_receipts(job_id,sequence,worker_fence,phase,kind,facts_json,facts_sha256) VALUES (?,2,?,'restart_queued','recovery',?,?)")
    .run(request.jobId, job.worker_fence, consent, sha(consent));
  db.prepare("INSERT INTO source_update_receipts(job_id,sequence,worker_fence,phase,kind,facts_json,facts_sha256) VALUES (?,3,?,'runtime_verifying','recovery',?,?)")
    .run(request.jobId, job.worker_fence, failure, sha(failure));
}

test('rollback reconciliation is atomic, revokes the old action, and releases only its job reservation', async () => {
  await withDb(request => {
    sourceUpdateJobsDb.registerPreparedRecoveryCandidate(request); const db = getConnection();
    db.prepare("UPDATE source_update_jobs SET state='runtime_verifying' WHERE id=?").run(request.jobId);
    db.prepare('UPDATE source_update_control SET active_job_id=? WHERE singleton=1').run(request.jobId);
    const reconciliation = { registration: request, reconciliationPacketSha256: hash, evidenceSha256: hash,
      approvalReference: 'synthetic:reconciliation', restoredProcess: { pid: 999, startTicks: '9876' } };
    let before = snapshot();
    assert.throws(() => reconcilePreparedRecoveryRollback(db, { ...reconciliation,
      restoredProcess: { ...reconciliation.restoredProcess, oid: 'f'.repeat(40) } } as typeof reconciliation,
      SOURCE_UPDATE_ACTIVE_STATES, () => {}), /reconciliation_identity/);
    assert.deepEqual(snapshot(), before);
    assert.throws(() => reconcilePreparedRecoveryRollback(db, reconciliation, SOURCE_UPDATE_ACTIVE_STATES, () => { throw Error('process_changed'); }), /process_changed/);
    assert.deepEqual(snapshot(), before);
    db.exec("CREATE TRIGGER fail_settlement BEFORE UPDATE OF state ON source_update_jobs WHEN NEW.state='rolled_back' BEGIN SELECT RAISE(ABORT,'settlement_failure'); END");
    assert.throws(() => reconcilePreparedRecoveryRollback(db, reconciliation, SOURCE_UPDATE_ACTIVE_STATES, () => {}), /settlement_failure/);
    assert.deepEqual(snapshot(), before); db.exec('DROP TRIGGER fail_settlement');
    db.prepare("UPDATE source_update_control SET active_job_id='new-job' WHERE singleton=1").run(); before = snapshot();
    assert.throws(() => reconcilePreparedRecoveryRollback(db, reconciliation, SOURCE_UPDATE_ACTIVE_STATES, () => {}), /worker_conflict/);
    assert.deepEqual(snapshot(), before);
    db.prepare('UPDATE source_update_control SET active_job_id=? WHERE singleton=1').run(request.jobId);
    assert.equal(reconcilePreparedRecoveryRollback(db, reconciliation, SOURCE_UPDATE_ACTIVE_STATES, () => {}).reused, false);
    before = snapshot();
    assert.equal(reconcilePreparedRecoveryRollback(db, reconciliation, SOURCE_UPDATE_ACTIVE_STATES, () => {}).reused, true);
    assert.deepEqual(snapshot(), before);
    assert.equal(pendingServerActionsDb.claimForExecution(request.actionId), 0);
    assert.equal((db.prepare('SELECT active_job_id FROM source_update_control').get() as { active_job_id: string | null }).active_job_id, null);
    assert.throws(() => sourceUpdateJobsDb.registerPreparedRecoveryCandidate(request), /blocked_manual_reconciliation/);
    assert.throws(() => reconcilePreparedRecoveryRollback(db, { ...reconciliation, evidenceSha256: 'f'.repeat(64) }, SOURCE_UPDATE_ACTIVE_STATES, () => {}), /reconciliation_replay_changed/);
    assert.deepEqual(snapshot(), before);
  });
});

test('explicit connection owns all writes and rollback without touching singleton or app_config', async () => {
  await withDb(request => {
    const singleton = getConnection(), before = snapshot(), db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    const tables = ['users','source_update_jobs','source_update_receipts','source_update_effects','source_update_control','pending_server_actions'];
    try {
      for (const name of tables) {
        const schema = singleton.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(name) as { sql: string };
        db.exec(schema.sql);
      }
      db.prepare("INSERT INTO users(id,username,password_hash,role) VALUES (?,'private-owner','fixture','owner')").run(request.ownerId);
      db.exec('INSERT INTO source_update_control(singleton,fence_epoch) VALUES (1,0)');
      db.exec("CREATE TRIGGER fail_action BEFORE INSERT ON pending_server_actions BEGIN SELECT RAISE(ABORT,'explicit_connection_failure'); END");
      assert.throws(() => registerPreparedRecoveryCandidate(db, request, SOURCE_UPDATE_ACTIVE_STATES), /explicit_connection_failure/);
      for (const table of ['source_update_jobs','source_update_receipts','pending_server_actions'])
        assert.equal((db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n, 0);
      assert.equal((db.prepare('SELECT fence_epoch FROM source_update_control').get() as { fence_epoch: number }).fence_epoch, 0);
      db.exec('DROP TRIGGER fail_action');
      assert.equal(registerPreparedRecoveryCandidate(db, request, SOURCE_UPDATE_ACTIVE_STATES).reused, false);
      assert.equal(registerPreparedRecoveryCandidate(db, request, SOURCE_UPDATE_ACTIVE_STATES).reused, true);
      assert.equal((db.prepare('SELECT count(*) AS n FROM source_update_receipts').get() as { n: number }).n, 1);
      assert.equal(db.prepare("SELECT 1 FROM sqlite_master WHERE name='app_config'").get(), undefined);
      assert.deepEqual(snapshot(), before);
    } finally { db.close(); }
  });
});

test('evidence changing before the in-transaction recheck refuses registration without writes', async () => {
  await withDb(request => {
    const db = getConnection(), before = snapshot();
    let checked = false;
    assert.throws(() => registerPreparedRecoveryCandidate(db, request, SOURCE_UPDATE_ACTIVE_STATES, () => {
      assert.equal(db.inTransaction, true);
      checked = true;
      throw new Error('fixture_evidence_changed_after_initial_inspection');
    }), /fixture_evidence_changed_after_initial_inspection/);
    assert.equal(checked, true);
    assert.equal(db.inTransaction, false);
    assert.deepEqual(snapshot(), before);
  });
});

test('registration atomically adopts a sealed local candidate, binds source action, and exactly replays', async () => {
  await withDb(request => {
    const first = sourceUpdateJobsDb.registerPreparedRecoveryCandidate(request);
    assert.equal(first.reused, false); assert.equal(first.job.state, 'restart_queued');
    assert.equal(first.job.auto_activate, 0); assert.equal(first.job.release_tag, null);
    assert.equal(first.job.release_commit, oid); assert.equal(first.action?.sourceUpdateJobId, request.jobId);
    assert.equal(first.action?.sourceUpdateTransactionId, request.transactionId);
    const before = snapshot();
    assert.equal(sourceUpdateJobsDb.registerPreparedRecoveryCandidate(request).reused, true);
    assert.deepEqual(snapshot(), before);
    assert.equal(sourceUpdateJobsDb.claim({ workerId: 'worker', pid: process.pid, startTicks: '1', bootId: 'boot', pgid: process.pid }, Date.now(), 30_000), null);
  });
});

test('exact replay rejects changed job columns even when its fingerprint remains unchanged', async () => {
  await withDb(request => {
    const result = sourceUpdateJobsDb.registerPreparedRecoveryCandidate(request);
    const changes = { transaction_id: 'other-tx', release_commit: 'd'.repeat(40), activation_identity_sha256: 'd'.repeat(64),
      expected_server_build_id: 'd'.repeat(64), expected_client_build_id: 'd'.repeat(64), strategy: 'release-layout-v2',
      auto_activate: 1, expected_version: '9.9.9.9', source_tree_sha256: 'd'.repeat(64), release_tag: 'vFake' };
    for (const [column, value] of Object.entries(changes)) {
      getConnection().prepare(`UPDATE source_update_jobs SET ${column}=? WHERE id=?`).run(value, request.jobId);
      const before = snapshot();
      assert.throws(() => sourceUpdateJobsDb.registerPreparedRecoveryCandidate(request), /replay_job_changed/);
      assert.deepEqual(snapshot(), before);
      getConnection().prepare(`UPDATE source_update_jobs SET ${column}=? WHERE id=?`).run(result.job[column], request.jobId);
    }
  });
});

test('every changed operation binding rejects replay without writes', async () => {
  await withDb(request => {
    sourceUpdateJobsDb.registerPreparedRecoveryCandidate(request); const before = snapshot();
    for (const mutate of [
      (r: PreparedRecoveryRegistration) => { r.manifestSha256 = 'd'.repeat(64); },
      (r: PreparedRecoveryRegistration) => { r.operationBinding.previousRuntime.startTicks = '9999'; },
      (r: PreparedRecoveryRegistration) => { r.operationBinding.nodeIdentity = 'other-node'; },
      (r: PreparedRecoveryRegistration) => { r.operationBinding.modeTransition.proposalEnvSha256 = 'd'.repeat(64); },
      (r: PreparedRecoveryRegistration) => { r.operationBinding.approvalReference = 'other-approval'; },
    ]) { const changed = structuredClone(request); mutate(changed);
      assert.throws(() => sourceUpdateJobsDb.registerPreparedRecoveryCandidate(changed), /identity_conflict/);
      assert.deepEqual(snapshot(), before); }
  });
});

test('interruption during action insertion rolls back all registration rows and fence', async () => {
  await withDb(request => {
    getConnection().exec("CREATE TRIGGER fail_action BEFORE INSERT ON pending_server_actions BEGIN SELECT RAISE(ABORT, 'fixture_interruption'); END");
    const before = snapshot();
    assert.throws(() => sourceUpdateJobsDb.registerPreparedRecoveryCandidate(request), /fixture_interruption/);
    assert.deepEqual(snapshot(), before);
    getConnection().exec('DROP TRIGGER fail_action');
    assert.equal(sourceUpdateJobsDb.registerPreparedRecoveryCandidate(request).reused, false);
  });
});

test('pending or executing restart conflicts cannot leave a partial recovery job', async () => {
  await withDb(request => {
    pendingServerActionsDb.insert({ id: 'other', actionType: 'safe-restart' });
    let before = snapshot();
    assert.throws(() => sourceUpdateJobsDb.registerPreparedRecoveryCandidate(request), /action_conflict/);
    assert.deepEqual(snapshot(), before);
    pendingServerActionsDb.claimForExecution('other'); before = snapshot();
    assert.throws(() => sourceUpdateJobsDb.registerPreparedRecoveryCandidate(request), /action_executing/);
    assert.deepEqual(snapshot(), before);
  });
});

test('stranded old-reader runtime_verifying requires manual reconciliation, never reactivation', async () => {
  await withDb(request => {
    sourceUpdateJobsDb.registerPreparedRecoveryCandidate(request);
    getConnection().prepare("UPDATE source_update_jobs SET state='runtime_verifying' WHERE id=?").run(request.jobId);
    const before = snapshot();
    assert.throws(() => sourceUpdateJobsDb.registerPreparedRecoveryCandidate(request), /blocked_manual_reconciliation/);
    assert.deepEqual(snapshot(), before);
    const other = input(request.ownerId); other.jobId = 'job-2'; other.transactionId = 'recovery-2'; other.actionId = 'action-2';
    Object.assign(other.operationBinding, { jobId: other.jobId, transactionId: other.transactionId, actionId: other.actionId });
    other.manifestPath = other.manifestPath.replace('recovery-1', 'recovery-2');
    assert.throws(() => sourceUpdateJobsDb.registerPreparedRecoveryCandidate(other), /active_job_conflict/);
    assert.deepEqual(snapshot(), before);
  });
});

test('inactive owner, unsafe manifest path, and changed action evidence fail closed', async () => {
  await withDb(request => {
    let before = snapshot();
    assert.throws(() => sourceUpdateJobsDb.registerPreparedRecoveryCandidate({ ...request, manifestPath: '/outside/manifest' }), /manifest_path_invalid/);
    assert.deepEqual(snapshot(), before);
    getConnection().prepare('UPDATE users SET is_active=0 WHERE id=?').run(request.ownerId); before = snapshot();
    assert.throws(() => sourceUpdateJobsDb.registerPreparedRecoveryCandidate(request), /owner_required/);
    assert.deepEqual(snapshot(), before);
    getConnection().prepare('UPDATE users SET is_active=1 WHERE id=?').run(request.ownerId);
    sourceUpdateJobsDb.registerPreparedRecoveryCandidate(request);
    getConnection().prepare("UPDATE pending_server_actions SET activation_identity_sha256=? WHERE id=?").run('e'.repeat(64), request.actionId);
    before = snapshot();
    assert.throws(() => sourceUpdateJobsDb.registerPreparedRecoveryCandidate(request), /replay_evidence_changed/);
    assert.deepEqual(snapshot(), before);
  });
});

test('manual auto-activation rollback is exact, atomic, idempotent, and leaves user data unchanged', async () => {
  await withDb(request => {
    seedManualRollback(request);
    const db = getConnection(), usersBefore = db.prepare('SELECT * FROM users ORDER BY id').all();
    const runtimePacketSha256 = 'f'.repeat(64);
    const rollback = { registration: request, operationPacketSha256: request.operationPacketSha256, runtimePacketSha256,
      ownerAck: `rollback:${request.transactionId}:${request.operationPacketSha256}:${runtimePacketSha256}`, evidenceSha256: 'e'.repeat(64) };
    let before = snapshot();
    assert.throws(() => reconcileManualRecoveryRollback(db, { ...rollback, ownerAck: 'rollback:wrong' },
      SOURCE_UPDATE_ACTIVE_STATES, () => {}), /manual_rollback_identity/);
    assert.deepEqual(snapshot(), before);
    for (const [race, error] of [
      [`INSERT INTO source_update_jobs(id,expected_version,owner_id,idempotency_key_hash,request_fingerprint,strategy,state)
        VALUES ('race-job','1.0.0.0',${request.ownerId},'race-key','race-fingerprint','git-checkout-v2','accepted')`, 'active_job_conflict'],
      ["UPDATE source_update_control SET active_job_id='race-job' WHERE singleton=1", 'worker_conflict'],
      ["INSERT INTO source_update_effects(job_id,effect_id,worker_fence,effect_kind,pid,start_ticks,boot_id,pgid,state) VALUES ('job-1','race-effect',1,'build',99,'1','boot',99,'running')", 'worker_conflict'],
      ["INSERT INTO pending_server_actions(id,action_type,status) VALUES ('race-action','safe-restart','pending')", 'action_conflict'],
    ] as Array<[string, string]>) {
      assert.throws(() => reconcileManualRecoveryRollback(db, rollback, SOURCE_UPDATE_ACTIVE_STATES, () => db.exec(race)), new RegExp(error));
      assert.deepEqual(snapshot(), before);
    }
    assert.throws(() => reconcileManualRecoveryRollback(db, rollback, SOURCE_UPDATE_ACTIVE_STATES,
      () => { throw new Error('fixture_process_or_tree_drift'); }), /fixture_process_or_tree_drift/);
    assert.deepEqual(snapshot(), before);
    db.exec("CREATE TRIGGER fail_manual_rollback BEFORE UPDATE OF state ON source_update_jobs WHEN NEW.state='rolled_back' BEGIN SELECT RAISE(ABORT,'fixture_manual_rollback_crash'); END");
    assert.throws(() => reconcileManualRecoveryRollback(db, rollback, SOURCE_UPDATE_ACTIVE_STATES, () => {}), /fixture_manual_rollback_crash/);
    assert.deepEqual(snapshot(), before);
    db.exec('DROP TRIGGER fail_manual_rollback');
    const result = reconcileManualRecoveryRollback(db, rollback, SOURCE_UPDATE_ACTIVE_STATES, () => {});
    assert.equal(result.reused, false);
    assert.equal((db.prepare('SELECT state FROM source_update_jobs WHERE id=?').get(request.jobId) as { state: string }).state, 'rolled_back');
    assert.deepEqual(db.prepare('SELECT status,error FROM pending_server_actions WHERE id=?').get(request.actionId),
      { status: 'superseded', error: 'local_source_manual_rollback' });
    before = snapshot();
    assert.equal(reconcileManualRecoveryRollback(db, rollback, SOURCE_UPDATE_ACTIVE_STATES, () => {}).reused, true);
    assert.deepEqual(snapshot(), before);
    assert.deepEqual(db.prepare('SELECT * FROM users ORDER BY id').all(), usersBefore);
  });
});

test('manual rollback rejects job, action, consent, failure, and competing-job drift without partial writes', async () => {
  await withDb(request => {
    seedManualRollback(request);
    const db = getConnection();
    const runtimePacketSha256 = 'f'.repeat(64);
    const rollback = { registration: request, operationPacketSha256: request.operationPacketSha256, runtimePacketSha256,
      ownerAck: `rollback:${request.transactionId}:${request.operationPacketSha256}:${runtimePacketSha256}`, evidenceSha256: 'e'.repeat(64) };
    const cases: Array<[string, string]> = [
      ["UPDATE source_update_jobs SET auto_activate=0 WHERE id='job-1'", "UPDATE source_update_jobs SET auto_activate=1 WHERE id='job-1'"],
      ["UPDATE source_update_jobs SET expected_server_build_id='changed' WHERE id='job-1'", `UPDATE source_update_jobs SET expected_server_build_id='${hash}' WHERE id='job-1'`],
      ["UPDATE pending_server_actions SET status='pending' WHERE id='action-1'", "UPDATE pending_server_actions SET status='failed' WHERE id='action-1'"],
      ["UPDATE pending_server_actions SET release_commit='changed' WHERE id='action-1'", `UPDATE pending_server_actions SET release_commit='${oid}' WHERE id='action-1'`],
      ["UPDATE source_update_receipts SET facts_sha256='changed' WHERE job_id='job-1' AND sequence=2", `UPDATE source_update_receipts SET facts_sha256=lower(hex(sha256(facts_json))) WHERE 0`],
    ];
    // SQLite has no built-in sha256; preserve the exact consent digest for restoration.
    const consentDigest = (db.prepare("SELECT facts_sha256 FROM source_update_receipts WHERE job_id='job-1' AND sequence=2").get() as { facts_sha256: string }).facts_sha256;
    cases[4][1] = `UPDATE source_update_receipts SET facts_sha256='${consentDigest}' WHERE job_id='job-1' AND sequence=2`;
    for (const [mutate, restore] of cases) {
      db.exec(mutate); const before = snapshot();
      assert.throws(() => reconcileManualRecoveryRollback(db, rollback, SOURCE_UPDATE_ACTIVE_STATES, () => {}),
        /manual_rollback_(job|action|receipt|state)_changed/);
      assert.deepEqual(snapshot(), before); db.exec(restore);
    }
  });
});
