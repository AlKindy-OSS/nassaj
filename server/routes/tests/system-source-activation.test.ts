/**
 * qa-critic C2 — no source-update job may be stranded in `activating`.
 *
 * Two ways used to strand one: beginUpdate refusing AFTER the job moved to
 * `activating` (it sat outside the try), and a crash between claiming the
 * restart action and the handoff. The first now fails the job with a receipt;
 * the second is settled at boot against the maintenance gate record.
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';

const tmpDir = await mkdtemp(path.join(tmpdir(), 'system-source-activation-'));
process.env.DATABASE_PATH = path.join(tmpDir, 'db.sqlite');
process.env.JWT_SECRET ||= 'test-secret-for-system-source-activation-0123456789abcdef';

const { closeConnection, getConnection } = await import('@/modules/database/connection.js');
const { initializeDatabase } = await import('@/modules/database/init-db.js');
const {
    sourceUpdateJobsDb, hashSourceUpdateIdempotencyKey, sourceUpdateRequestFingerprint,
} = await import('@/modules/database/repositories/source-update-jobs.db.js');
const {
    executeSourceUpdateActivation, reconcileStrandedActivationJobs, setSourcePlannerForTests,
} = await import('../system.js');
await initializeDatabase();
// The fixture root is not a git tree; the planner is exercised on its own below.
setSourcePlannerForTests(() => ({ paths: 0 }));
after(async () => { setSourcePlannerForTests(null); closeConnection(); await rm(tmpDir, { recursive: true, force: true }); });

let ownerId = 0;
/** One real job at `restart_queued`, bound to a transaction and an action identity. */
function queuedJob() {
    ownerId ||= Number(getConnection().prepare(
        `INSERT INTO users(username, password_hash, role) VALUES ('c2-owner', 'not-a-secret', 'owner')`,
    ).run().lastInsertRowid);
    const owner = ownerId;
    const id = crypto.randomUUID();
    const strategy = 'git-checkout-v2' as const;
    sourceUpdateJobsDb.createOrReuse({
        id, ownerId: owner, expectedVersion: '1.47.0.16', strategy,
        idempotencyKeyHash: hashSourceUpdateIdempotencyKey(id),
        requestFingerprint: sourceUpdateRequestFingerprint(owner, '1.47.0.16', strategy),
    });
    const transactionId = `update-c2-${id}`;
    const activationIdentitySha256 = crypto.createHash('sha256').update(id).digest('hex');
    getConnection().prepare(`UPDATE source_update_jobs SET state = 'restart_queued', transaction_id = ?,
        activation_identity_sha256 = ?, release_commit = ? WHERE id = ?`).run(transactionId, activationIdentitySha256, 'b'.repeat(40), id);
    return { id, transactionId, activationIdentitySha256 };
}

function activationInputs(job: ReturnType<typeof queuedJob>, beginUpdate: () => Promise<unknown>) {
    const row = {
        sourceUpdateJobId: job.id, sourceUpdateTransactionId: job.transactionId,
        activationIdentitySha256: job.activationIdentitySha256, releaseCommit: 'b'.repeat(40),
    };
    const resolved = {
        action: {
            transactionId: job.transactionId, originalHead: 'c'.repeat(40), targetCommit: 'b'.repeat(40),
            version: '1.47.0.16', manifestSha256: 'd'.repeat(64),
            candidateRoot: path.join(tmpDir, 'candidate'), manifestPath: path.join(tmpDir, 'candidate', 'candidate-manifest.json'),
        },
        maintenance: { paths: { root: tmpDir }, beginUpdate },
    };
    return { row, resolved };
}

test('a plan conflict found just before the gate closes fails the job and never closes the gate (H1)', async () => {
    const job = queuedJob();
    let gateClosed = false;
    const { row, resolved } = activationInputs(job, async () => { gateClosed = true; throw new Error('unreachable'); });
    setSourcePlannerForTests(() => { throw new Error('Source activation CAS mismatch: build/generated.js'); });
    try {
        await assert.rejects(executeSourceUpdateActivation(row, resolved), /CAS mismatch/);
    } finally { setSourcePlannerForTests(() => ({ paths: 0 })); }
    assert.equal(gateClosed, false);
    assert.equal(sourceUpdateJobsDb.getById(job.id)?.state, 'failed');
});

test('a failure before any source write rolls back as a no-op and reopens the gate (H1)', async () => {
    const job = queuedJob();
    const calls: string[] = [];
    const update = {
        transition: (_expected: string[], next: string) => { calls.push(next); },
        completeRollback: () => { calls.push('completeRollback'); },
        reopenOrDeclareManual: () => { calls.push('reopenOrDeclareManual'); return { state: 'MANUAL' }; },
        release: () => { calls.push('release'); },
    };
    // validateCandidate throws on the absent candidate: nothing was written yet.
    const { row, resolved } = activationInputs(job, async () => update);
    await assert.rejects(executeSourceUpdateActivation(row, resolved));
    assert.deepEqual(calls, ['ROLLBACK_PREPARED', 'ROLLBACK_SOURCE_APPLYING', 'ROLLBACK_SOURCE_APPLIED', 'completeRollback']);
    assert.equal(sourceUpdateJobsDb.getById(job.id)?.state, 'rolled_back');
});

test('a beginUpdate refusal fails the job with its reason instead of stranding it in activating', async () => {
    const job = queuedJob();
    const { row, resolved } = activationInputs(job, async () => { throw new Error('update_source_state_degraded'); });
    await assert.rejects(executeSourceUpdateActivation(row, resolved), /update_source_state_degraded/);
    assert.equal(sourceUpdateJobsDb.getById(job.id)?.state, 'failed');
    const receipts = sourceUpdateJobsDb.listReceipts(job.id) as { phase: string; facts_json: string }[];
    const last = receipts.at(-1)!;
    assert.equal(last.phase, 'activating');
    // M3: a refusal before the gate closed repaired nothing, so it is neither kind of intervention.
    assert.deepEqual(JSON.parse(last.facts_json), { code: 'update_source_state_degraded', failedPhase: 'activating', intervention: null });
});

type Stranded = { id: string; state: string; strategy: string; transaction_id: string; activation_identity_sha256: string };

function fakeJobs(rows: Stranded[]) {
    const receipts: unknown[] = [];
    const moves: { jobId: string; expected: string[]; next: string }[] = [];
    return {
        receipts, moves,
        listStrandedActivations: () => rows,
        appendActivationReceipt: (identity: unknown, phase: string, kind: string, facts: unknown) => {
            receipts.push({ identity, phase, kind, facts });
        },
        transitionActivation: (identity: { jobId: string }, expected: string[], next: string) => {
            moves.push({ jobId: identity.jobId, expected, next });
            return true;
        },
    };
}

const stranded = (id: string, state: string, strategy = 'git-checkout-v2'): Stranded => ({
    id, state, strategy, transaction_id: `update-${id}-transaction`, activation_identity_sha256: 'e'.repeat(64),
});

test('an open gate means the stranded activation is not in effect: failed, or rolled_back after rollback', () => {
    const jobs = fakeJobs([stranded('one', 'activating'), stranded('two', 'rollback_pending')]);
    const settled = reconcileStrandedActivationJobs({
        jobs, readGate: () => ({ state: 'OPEN', gateClosed: false, phase: null, transactionId: null, degraded: null }),
    });
    assert.deepEqual(jobs.moves.map(({ jobId, next }) => [jobId, next]), [['one', 'failed'], ['two', 'rolled_back']]);
    assert.equal(jobs.receipts.length, 2, 'every settlement carries a receipt');
    assert.ok(settled.every((entry) => entry.settled && entry.code === 'source_update_activation_interrupted'));
});

test('a MANUAL gate that owns the transaction makes the job manual; any other closed gate leaves it', () => {
    const job = stranded('three', 'activating');
    const manual = fakeJobs([job]);
    reconcileStrandedActivationJobs({ jobs: manual, readGate: () => ({
        state: 'MANUAL', gateClosed: true, phase: 'SOURCE_APPLIED', transactionId: job.transaction_id,
    }) });
    assert.deepEqual(manual.moves.map(({ next }) => next), ['manual_recovery_required']);

    const owned = fakeJobs([job]);
    reconcileStrandedActivationJobs({ jobs: owned, readGate: () => ({
        state: 'UPDATING', gateClosed: true, phase: 'SOURCE_APPLIED', transactionId: job.transaction_id,
    }) });
    assert.equal(owned.moves.length, 0, 'a closed gate still owns its transaction');
});

test('a degraded reopen of the same transaction leaves the job needing the human exit path', () => {
    const job = stranded('four', 'rollback_pending');
    const jobs = fakeJobs([job]);
    const [entry] = reconcileStrandedActivationJobs({ jobs, readGate: () => ({
        state: 'OPEN', gateClosed: false, phase: null, transactionId: job.transaction_id, degraded: 'source_tree_at_target',
    }) });
    assert.equal(entry.code, 'update_source_state_degraded');
    assert.deepEqual(jobs.moves.map(({ next }) => next), ['manual_recovery_required']);
});

test('release-layout jobs are out of scope and an unreadable gate settles nothing', () => {
    const artifact = fakeJobs([stranded('five', 'activating', 'release-layout-v2')]);
    assert.deepEqual(reconcileStrandedActivationJobs({ jobs: artifact, readGate: () => { throw new Error('unused'); } }), []);
    const unreadable = fakeJobs([stranded('six', 'activating')]);
    const [entry] = reconcileStrandedActivationJobs({ jobs: unreadable, readGate: () => { throw new Error('update_journal_invalid'); } });
    assert.equal(entry.settled, false);
    assert.equal(unreadable.moves.length, 0);
});

test('B-1147: the real repository includes runtime_verifying without treating OPEN as failure', () => {
    const job = queuedJob();
    getConnection().prepare("UPDATE source_update_jobs SET state = 'runtime_verifying' WHERE id = ?").run(job.id);
    assert.ok(sourceUpdateJobsDb.listStrandedActivations().some((row) => row.id === job.id));
    const rows = reconcileStrandedActivationJobs({
        readGate: () => ({ state: 'OPEN', gateClosed: false, phase: null, transactionId: null }),
    });
    assert.equal(rows.find((row) => row.jobId === job.id)?.settled, false);
    assert.equal(sourceUpdateJobsDb.getById(job.id)?.state, 'runtime_verifying');
    getConnection().prepare("UPDATE source_update_jobs SET state = 'failed' WHERE id = ?").run(job.id);
});

test('B-1147: checksum-validated gate and exact live evidence settle the real Git job once', async () => {
    const { createActivationFixture, VERSION } = await import('../../services/tests/source-activation-fixture.js');
    const { validateCandidate, exchangeGenerations, verifyRuntimeIdentities } = await import('../../../scripts/lib/source-update-activation.mjs');
    const fx = createActivationFixture();
    try {
        const created = queuedJob();
        const actionHash = crypto.createHash('sha256').update(JSON.stringify(fx.action)).digest('hex');
        const validation = validateCandidate({ projectRoot: fx.root, candidateRoot: fx.candidateRoot,
            transactionId: fx.transactionId, releaseCommit: fx.targetCommit, version: VERSION,
            manifestPath: fx.manifestPath, manifestSha256: fx.manifestSha256 });
        getConnection().prepare(`UPDATE source_update_jobs SET state='runtime_verifying', expected_version=?,
            transaction_id=?, activation_identity_sha256=?, release_commit=?, expected_server_build_id=?, expected_client_build_id=? WHERE id=?`)
            .run(VERSION, fx.transactionId, actionHash, fx.targetCommit, validation.manifest.serverBuildId, validation.manifest.clientBuildId, created.id);
        const identity = { jobId: created.id, transactionId: fx.transactionId, activationIdentitySha256: actionHash };
        const lease = await fx.gate.beginUpdate(fx.identity);
        try {
            exchangeGenerations(validation);
            const runtimeIdentities = verifyRuntimeIdentities(validation);
            sourceUpdateJobsDb.appendActivationReceipt(identity, 'runtime_verifying', 'done', { runtimeIdentities });
            lease.complete({ runtimeIdentities });
        } finally { lease.release(); }
        const options = { projectRoot: fx.root, controlRoot: fx.gate.paths.controlRoot,
            readGate: () => fx.gate.readRecoveryEvidence(), runtime: { commit: fx.targetCommit,
                serverBuildId: validation.manifest.serverBuildId, clientBuildId: validation.manifest.clientBuildId } };
        const settled = reconcileStrandedActivationJobs(options);
        assert.equal(settled.find((entry) => entry.jobId === created.id)?.state, 'activated');
        assert.equal(sourceUpdateJobsDb.getById(created.id)?.state, 'activated');
        assert.equal(reconcileStrandedActivationJobs(options).some((entry) => entry.jobId === created.id), false);
    } finally { fx.cleanup(); }
});
