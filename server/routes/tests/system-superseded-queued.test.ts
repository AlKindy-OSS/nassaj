/**
 * B-1583: a node stuck on the invalid-action defect keeps a git-checkout job in
 * `restart_queued` (blocking every later update through the one-active index)
 * and its safe-restart row in `executing`. After an out-of-band install of the
 * fixed build, boot settles both — and touches nothing that can still apply.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test, { after } from 'node:test';

const sandbox = fs.mkdtempSync(path.join(process.env.TMPDIR!, 'superseded-queued-'));
process.env.DATABASE_PATH = path.join(sandbox, 'db.sqlite');
process.env.JWT_SECRET ||= 'test-secret-for-superseded-queued-0123456789abcdef';

const { closeConnection, getConnection } = await import('@/modules/database/connection.js');
const { initializeDatabase } = await import('@/modules/database/init-db.js');
const { pendingServerActionsDb, auditLogDb } = await import('@/modules/database/index.js');
const {
    sourceUpdateJobsDb, hashSourceUpdateIdempotencyKey, sourceUpdateRequestFingerprint,
} = await import('@/modules/database/repositories/source-update-jobs.db.js');
const { reconcileSupersededQueuedSourceUpdates, readSourceHead } = await import('../system.js');
const { buildSourceUpdateAction } = await import('../../../scripts/lib/source-update-action-schema.mjs');
await initializeDatabase();
after(() => { closeConnection(); fs.rmSync(sandbox, { recursive: true, force: true }); });

const ORIGINAL = 'a'.repeat(40);
const TARGET = 'b'.repeat(40);
const PREVIOUS = 'c'.repeat(40);
const BUILD = 'd'.repeat(64);
const controlRoot = path.join(sandbox, 'control');
const sha = (value: string) => crypto.createHash('sha256').update(value).digest('hex');
const ownerId = Number(getConnection().prepare(
    "INSERT INTO users(username, password_hash, role) VALUES ('b1583-owner', 'not-a-secret', 'owner')",
).run().lastInsertRowid);

/** A sealed git-checkout job at `state`, its updater-exact action on disk, and its bound safe-restart row. */
function queuedJob(state = 'restart_queued', rowStatus: 'executing' | 'pending' | 'none' = 'executing') {
    const id = crypto.randomUUID();
    const strategy = 'git-checkout-v2' as const;
    const transactionId = `update-b1583-${id}`;
    const candidateRoot = path.join(controlRoot, 'candidates', transactionId);
    fs.mkdirSync(candidateRoot, { recursive: true });
    const action = buildSourceUpdateAction({ transactionId, originalHead: ORIGINAL, targetCommit: TARGET,
        version: '1.0.0.1', manifestPath: path.join(candidateRoot, 'candidate-manifest.json'),
        manifestSha256: 'e'.repeat(64), expectedServerBuildId: BUILD, previousRuntimeOid: PREVIOUS });
    const bytes = `${JSON.stringify(action)}\n`;
    fs.writeFileSync(path.join(candidateRoot, 'activation-action.json'), bytes, { mode: 0o600 });
    const identity = sha(bytes.trim());
    sourceUpdateJobsDb.createOrReuse({ id, ownerId, expectedVersion: '1.0.0.1', strategy, autoActivate: true,
        idempotencyKeyHash: hashSourceUpdateIdempotencyKey(id),
        requestFingerprint: sourceUpdateRequestFingerprint(ownerId, '1.0.0.1', strategy, true) });
    getConnection().prepare(`UPDATE source_update_jobs SET state = ?, transaction_id = ?, activation_identity_sha256 = ?,
        release_commit = ?, expected_server_build_id = ? WHERE id = ?`).run(state, transactionId, identity, TARGET, BUILD, id);
    let rowId: string | null = null;
    if (rowStatus !== 'none') {
        rowId = crypto.randomUUID();
        pendingServerActionsDb.insert({ id: rowId, actionType: 'safe-restart', expectedServerBuildId: BUILD,
            sourceUpdateJobId: id, sourceUpdateTransactionId: transactionId, activationIdentitySha256: identity,
            releaseCommit: TARGET });
        if (rowStatus === 'executing') assert.equal(pendingServerActionsDb.claimForExecution(rowId), 1);
    }
    const retire = () => {
        getConnection().prepare("UPDATE source_update_jobs SET state = 'failed' WHERE id = ?").run(id);
        if (rowId) pendingServerActionsDb.deleteById(rowId);
    };
    return { id, rowId, retire };
}

const run = (options: { runtimeCommit?: string | null; head?: string | null } = {}) => reconcileSupersededQueuedSourceUpdates({
    runtimeCommit: options.runtimeCommit ?? PREVIOUS, readHead: () => options.head ?? ORIGINAL, controlRoot,
});

test('stuck after a manual install of the target build: job superseded, executing row failed, audited', () => {
    const job = queuedJob();
    const receipts = (sourceUpdateJobsDb.listReceipts(job.id) as unknown[]).length;
    const result = run({ runtimeCommit: TARGET, head: TARGET });
    assert.deepEqual(result.find((entry) => entry.jobId === job.id),
        { jobId: job.id, settled: true, code: 'source_update_target_already_loaded', rows: 1 });
    assert.equal(sourceUpdateJobsDb.getById(job.id)?.state, 'superseded');
    const row = pendingServerActionsDb.getById(job.rowId!)!;
    assert.deepEqual([row.status, row.error], ['failed', 'source_update_target_already_loaded']);
    const last = (sourceUpdateJobsDb.listReceipts(job.id) as { kind: string; facts_json: string }[]).at(-1)!;
    assert.equal((sourceUpdateJobsDb.listReceipts(job.id) as unknown[]).length, receipts + 1);
    assert.deepEqual([last.kind, JSON.parse(last.facts_json).code], ['recovery', 'source_update_target_already_loaded']);
    assert.ok(auditLogDb.recent(20).some((entry) => entry.action === 'source_update_superseded_at_boot'));
    // Idempotent: the job is terminal now, so a second boot settles nothing.
    assert.equal(run({ runtimeCommit: TARGET, head: TARGET }).some((entry) => entry.jobId === job.id), false);
    job.retire();
});

test('the source moved past originalHead out of band: superseded, a pending row superseded too', () => {
    const job = queuedJob('restart_queued', 'pending');
    const result = run({ head: 'f'.repeat(40) });
    assert.equal(result.find((entry) => entry.jobId === job.id)?.code, 'source_update_source_moved');
    assert.equal(sourceUpdateJobsDb.getById(job.id)?.state, 'superseded');
    assert.equal(pendingServerActionsDb.getById(job.rowId!)?.status, 'superseded');
    job.retire();
});

test('a queued job that can still apply is left exactly as it was', () => {
    const job = queuedJob();
    const before = pendingServerActionsDb.getById(job.rowId!)!;
    const result = run();
    assert.deepEqual(result.find((entry) => entry.jobId === job.id), { jobId: job.id, settled: false });
    assert.equal(sourceUpdateJobsDb.getById(job.id)?.state, 'restart_queued');
    const row = pendingServerActionsDb.getById(job.rowId!)!;
    assert.deepEqual([row.status, row.executionAttemptNonce], [before.status, before.executionAttemptNonce]);
    job.retire();
});

test('the boot after a successful activation is untouched: runtime_verifying and activated jobs are not queued', () => {
    for (const state of ['runtime_verifying', 'activated']) {
        const job = queuedJob(state);
        const result = run({ runtimeCommit: TARGET, head: TARGET });
        assert.equal(result.some((entry) => entry.jobId === job.id), false, state);
        assert.equal(sourceUpdateJobsDb.getById(job.id)?.state, state);
        assert.equal(pendingServerActionsDb.getById(job.rowId!)?.status, 'executing');
        job.retire();
    }
});

test('unrelated rows are untouched; a re-claimed attempt is never settled by a stale nonce', () => {
    const job = queuedJob('restart_queued', 'none');
    const unrelated = crypto.randomUUID();
    pendingServerActionsDb.insert({ id: unrelated, actionType: 'safe-restart', expectedServerBuildId: 'f'.repeat(64) });
    assert.equal(pendingServerActionsDb.claimForExecution(unrelated), 1);
    run({ runtimeCommit: TARGET });
    assert.equal(sourceUpdateJobsDb.getById(job.id)?.state, 'superseded');
    assert.equal(pendingServerActionsDb.getById(unrelated)?.status, 'executing');
    assert.equal(pendingServerActionsDb.failExecutingAttempt(unrelated, '0'.repeat(64), 'internal'), 0);
    assert.equal(pendingServerActionsDb.getById(unrelated)?.status, 'executing');
    pendingServerActionsDb.deleteById(unrelated);
    job.retire();
});

test('an action that is missing or not bound to the job settles nothing', () => {
    const job = queuedJob();
    const transactionId = getConnection().prepare('SELECT transaction_id FROM source_update_jobs WHERE id = ?')
        .pluck().get(job.id) as string;
    fs.appendFileSync(path.join(controlRoot, 'candidates', transactionId, 'activation-action.json'), ' ');
    getConnection().prepare('UPDATE source_update_jobs SET activation_identity_sha256 = ? WHERE id = ?').run('0'.repeat(64), job.id);
    assert.deepEqual(run({ runtimeCommit: TARGET }).find((entry) => entry.jobId === job.id), { jobId: job.id, settled: false });
    assert.equal(sourceUpdateJobsDb.getById(job.id)?.state, 'restart_queued');
    job.retire();
});

test('readSourceHead reads a branch ref, loose or packed, without launching git itself', () => {
    const root = fs.mkdtempSync(path.join(sandbox, 'repo-'));
    const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
    git('init', '-q', '-b', 'main');
    git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--allow-empty', '-qm', 'one');
    const head = git('rev-parse', 'HEAD');
    assert.equal(readSourceHead(root), head);
    git('pack-refs', '--all');
    assert.equal(fs.existsSync(path.join(root, '.git/refs/heads/main')), false);
    assert.equal(readSourceHead(root), head);
    git('checkout', '-q', '--detach');
    assert.equal(readSourceHead(root), head);
});
