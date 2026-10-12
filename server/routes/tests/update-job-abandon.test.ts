/**
 * B-1605 — POST /api/system/update/jobs/:jobId/abandon and the abandonability
 * published on the active-job payload.
 *
 * The REAL route stack (requireRole('owner') + handler) over the REAL
 * repositories on a temporary database. Only the host probes (gate journal,
 * HEAD, loaded runtime, live restart/worker processes) are injected, so each
 * allowed and blocked case is driven from the outside.
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test, { after, beforeEach } from 'node:test';

import express from 'express';

const sandbox = fs.mkdtempSync(path.join(process.env.TMPDIR!, 'update-abandon-'));
process.env.NODE_ENV = 'test';
process.env.DATABASE_PATH = path.join(sandbox, 'db.sqlite');
process.env.JWT_SECRET ||= 'update-abandon-test-secret-0123456789abcdef0123';

const { closeConnection, getConnection } = await import('@/modules/database/connection.js');
const { initializeDatabase } = await import('@/modules/database/init-db.js');
const { pendingServerActionsDb, auditLogDb } = await import('@/modules/database/index.js');
const {
    sourceUpdateJobsDb, hashSourceUpdateIdempotencyKey, sourceUpdateRequestFingerprint,
} = await import('@/modules/database/repositories/source-update-jobs.db.js');
const {
    createUpdateJobAbandoner, readQueuedActionEvidence, isSafeRestartProcessRunning, UPDATE_ABANDONED_BY_OWNER,
} = await import('../../services/update-job-abandon.js');
const { createAbandonUpdateJobHandler, toActiveUpdateJobPayload } = await import('../update-job-abandon.js');
const { requireRole } = await import('../../middleware/auth.js');
const { buildSourceUpdateAction } = await import('../../../scripts/lib/source-update-action-schema.mjs');
await initializeDatabase();

const ORIGINAL = 'a'.repeat(40);
const TARGET = 'b'.repeat(40);
const PREVIOUS = 'c'.repeat(40);
const MOVED = 'f'.repeat(40);
const BUILD = 'd'.repeat(64);
const controlRoot = path.join(sandbox, 'control');
fs.mkdirSync(path.join(controlRoot, 'candidates'), { recursive: true });
const sha = (value: string) => crypto.createHash('sha256').update(value).digest('hex');
const insertUser = (name: string, role: string) => Number(getConnection().prepare(
    'INSERT INTO users(username, password_hash, role) VALUES (?, ?, ?)',
).run(name, 'not-a-secret', role).lastInsertRowid);
const ownerId = insertUser('b1605-owner', 'owner');
const otherOwnerId = insertUser('b1605-other', 'owner');
const adminId = insertUser('b1605-admin', 'admin');

const PREVIOUS_TX = 'update-previous-transaction-0001';
const OPEN_GATE = { state: 'OPEN', phase: 'ACTIVE_VERIFIED', gateClosed: false, degraded: null, oidAdmissionIntentPending: false,
    transactionId: PREVIOUS_TX };
const writeHandoff = (transactionId?: string) => fs.writeFileSync(path.join(controlRoot, 'bootstrap-handoff.json'),
    `${JSON.stringify({ schema: 'nassaj-source-update-bootstrap/v1', ...(transactionId ? { transactionId } : {}), epoch: 'e'.repeat(32) })}\n`, { mode: 0o600 });
type Probes = {
    gate: (() => unknown); restartInFlight: boolean; safeRestart: boolean; leaseAlive: boolean;
    head: string | null; runtime: string | null; nowMs: number;
};
let probes: Probes;
beforeEach(() => {
    probes = { gate: () => OPEN_GATE, restartInFlight: false, safeRestart: false, leaseAlive: false,
        head: ORIGINAL, runtime: PREVIOUS, nowMs: Date.now() };
    fs.rmSync(path.join(controlRoot, 'bootstrap-handoff.json'), { force: true });
    // One active job at a time (the one-active index): retire whatever a test left.
    getConnection().prepare("UPDATE source_update_jobs SET state = 'failed' WHERE state NOT IN ('failed','activated','rolled_back','superseded','manual_recovery_required','cancelled')").run();
    getConnection().prepare('UPDATE source_update_control SET active_job_id = NULL, worker_id = NULL, pid = NULL, start_ticks = NULL, boot_id = NULL, pgid = NULL, lease_expires_at = NULL WHERE singleton = 1').run();
});

const abandoner = createUpdateJobAbandoner({
    jobs: sourceUpdateJobsDb, actions: pendingServerActionsDb, audit: auditLogDb,
    transact: (fn: () => unknown) => getConnection().transaction(fn)(),
    readGate: () => probes.gate(),
    controlRoot: () => controlRoot,
    isRestartInFlight: () => probes.restartInFlight,
    isSafeRestartRunning: () => probes.safeRestart,
    isLeaseOwnerAlive: () => probes.leaseAlive,
    readHead: () => probes.head,
    runtimeCommit: () => probes.runtime,
    now: () => probes.nowMs,
});

type JobOptions = { state?: string; row?: 'executing' | 'pending' | 'none'; action?: 'bound' | 'missing';
    strategy?: 'git-checkout-v2' | 'release-layout-v2'; owner?: number };
/** A job at `state` with its updater-exact (9-key) action on disk and its bound safe-restart row. */
function job({ state = 'restart_queued', row = 'executing', action = 'bound', strategy = 'git-checkout-v2', owner = ownerId }: JobOptions = {}) {
    const id = crypto.randomUUID();
    const transactionId = `update-b1605-${id}`;
    const candidateRoot = path.join(controlRoot, 'candidates', transactionId);
    fs.mkdirSync(candidateRoot, { recursive: true });
    const built = buildSourceUpdateAction({ transactionId, originalHead: ORIGINAL, targetCommit: TARGET,
        version: '1.0.0.1', manifestPath: path.join(candidateRoot, 'candidate-manifest.json'),
        manifestSha256: 'e'.repeat(64), expectedServerBuildId: BUILD, previousRuntimeOid: PREVIOUS });
    const bytes = `${JSON.stringify(built)}\n`;
    if (action === 'bound') fs.writeFileSync(path.join(candidateRoot, 'activation-action.json'), bytes, { mode: 0o600 });
    const identity = sha(bytes.trim());
    const created = sourceUpdateJobsDb.createOrReuse({ id, ownerId: owner, expectedVersion: '1.0.0.1', strategy, autoActivate: true,
        idempotencyKeyHash: hashSourceUpdateIdempotencyKey(id),
        requestFingerprint: sourceUpdateRequestFingerprint(owner, '1.0.0.1', strategy, true) });
    assert.equal(created.reused, false);
    getConnection().prepare(`UPDATE source_update_jobs SET state = ?, transaction_id = ?, activation_identity_sha256 = ?,
        release_commit = ?, expected_server_build_id = ?, worker_fence = 3 WHERE id = ?`).run(state, transactionId, identity, TARGET, BUILD, id);
    // A sealed job keeps active_job_id after its worker released (release() in the repository).
    getConnection().prepare('UPDATE source_update_control SET active_job_id = ? WHERE singleton = 1').run(id);
    let rowId: string | null = null;
    if (row !== 'none') {
        rowId = crypto.randomUUID();
        pendingServerActionsDb.insert({ id: rowId, actionType: 'safe-restart', expectedServerBuildId: BUILD,
            sourceUpdateJobId: id, sourceUpdateTransactionId: transactionId, activationIdentitySha256: identity,
            releaseCommit: TARGET });
        if (row === 'executing') assert.equal(pendingServerActionsDb.claimForExecution(rowId), 1);
    }
    return { id, rowId, transactionId, identity, keys: Object.keys(built).length };
}

const control = () => getConnection().prepare('SELECT * FROM source_update_control WHERE singleton = 1').get() as Record<string, unknown>;
const reasonFor = (id: string) => abandoner.evaluate(sourceUpdateJobsDb.getById(id)).abandonBlockedReason;

type User = { id: number; role: string; username: string };
let currentUser: User = { id: ownerId, role: 'owner', username: 'b1605-owner' };
const app = express();
app.use(express.json());
app.post('/api/system/update/jobs/:jobId/abandon', (req, _res, next) => {
    (req as unknown as { user: User }).user = currentUser;
    next();
}, requireRole('owner'), createAbandonUpdateJobHandler({ abandoner }));
const server = app.listen(0);
await new Promise<void>((resolve) => server.once('listening', () => resolve()));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
after(() => { server.close(); closeConnection(); fs.rmSync(sandbox, { recursive: true, force: true }); });

async function post(jobId: string, body: unknown = { confirm: true }, user: User = currentUser) {
    currentUser = user;
    const response = await fetch(`${base}/api/system/update/jobs/${encodeURIComponent(jobId)}/abandon`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    currentUser = { id: ownerId, role: 'owner', username: 'b1605-owner' };
    return { status: response.status, body: await response.json() as any };
}

test('B-1583-shaped stuck state: abandon settles job, row and lease, and a new job can start', async () => {
    const stuck = job();
    assert.equal(stuck.keys, 9, 'the updater-exact action carries previousRuntimeOid (9 keys)');
    assert.deepEqual(abandoner.evaluate(sourceUpdateJobsDb.getById(stuck.id)), { abandonable: true, abandonBlockedReason: null, abandoned: false });
    // Before: a new update is refused while this job holds the one-active slot.
    const blockedKey = crypto.randomUUID();
    assert.equal(sourceUpdateJobsDb.createOrReuse({ id: blockedKey, ownerId, expectedVersion: '1.0.0.2', strategy: 'git-checkout-v2',
        idempotencyKeyHash: hashSourceUpdateIdempotencyKey(blockedKey),
        requestFingerprint: sourceUpdateRequestFingerprint(ownerId, '1.0.0.2', 'git-checkout-v2') }).activeConflict, true);
    const receipts = (sourceUpdateJobsDb.listReceipts(stuck.id) as unknown[]).length;

    const response = await post(stuck.id);
    assert.equal(response.status, 200);
    assert.deepEqual(response.body, { abandoned: true, job: {
        jobId: stuck.id, state: 'failed', targetVersion: '1.0.0.1',
        statusUrl: `/api/system/update/jobs/${stuck.id}`, abandonable: false, abandonBlockedReason: 'terminal',
    } });
    const settled = sourceUpdateJobsDb.getById(stuck.id)!;
    assert.deepEqual([settled.state, settled.error_code], ['failed', UPDATE_ABANDONED_BY_OWNER]);
    assert.ok(settled.completed_at);
    const row = pendingServerActionsDb.getById(stuck.rowId!)!;
    assert.deepEqual([row.status, row.error], ['failed', UPDATE_ABANDONED_BY_OWNER]);
    assert.equal(control().active_job_id, null);
    const all = sourceUpdateJobsDb.listReceipts(stuck.id) as { kind: string; phase: string; facts_json: string }[];
    assert.equal(all.length, receipts + 1);
    assert.deepEqual([all.at(-1)!.kind, all.at(-1)!.phase, JSON.parse(all.at(-1)!.facts_json)], ['recovery', 'restart_queued',
        { code: UPDATE_ABANDONED_BY_OWNER, failedPhase: 'restart_queued', intervention: 'human', actorId: ownerId }]);
    const audit = auditLogDb.recent(20).find((entry: { action: string }) => entry.action === 'update_job_abandoned') as any;
    assert.ok(audit, 'the abandonment is audited');
    // The candidate is left for the separate cleanup.
    assert.ok(fs.existsSync(path.join(controlRoot, 'candidates', stuck.transactionId, 'activation-action.json')));

    // After: the slot is free and a new job is accepted.
    const freshKey = crypto.randomUUID();
    const fresh = sourceUpdateJobsDb.createOrReuse({ id: freshKey, ownerId, expectedVersion: '1.0.0.2', strategy: 'git-checkout-v2',
        idempotencyKeyHash: hashSourceUpdateIdempotencyKey(freshKey),
        requestFingerprint: sourceUpdateRequestFingerprint(ownerId, '1.0.0.2', 'git-checkout-v2') });
    assert.deepEqual([fresh.reused, fresh.mismatch, fresh.job?.state], [false, false, 'accepted']);
});

test('abandon is idempotent: a repeat returns the same 200 and writes nothing more', async () => {
    const stuck = job();
    assert.equal((await post(stuck.id)).status, 200);
    const receipts = (sourceUpdateJobsDb.listReceipts(stuck.id) as unknown[]).length;
    const audits = auditLogDb.recent(200).filter((entry: { action: string }) => entry.action === 'update_job_abandoned').length;
    const again = await post(stuck.id);
    assert.equal(again.status, 200);
    assert.deepEqual([again.body.abandoned, again.body.job.state, again.body.job.abandonBlockedReason], [true, 'failed', 'terminal']);
    assert.equal((sourceUpdateJobsDb.listReceipts(stuck.id) as unknown[]).length, receipts);
    assert.equal(auditLogDb.recent(200).filter((entry: { action: string }) => entry.action === 'update_job_abandoned').length, audits);
});

test('a pending bound row is superseded, and a dead worker in staging can be abandoned', async () => {
    const queued = job({ row: 'pending' });
    assert.equal((await post(queued.id)).status, 200);
    assert.deepEqual([pendingServerActionsDb.getById(queued.rowId!)?.status, pendingServerActionsDb.getById(queued.rowId!)?.error],
        ['superseded', UPDATE_ABANDONED_BY_OWNER]);

    const staging = job({ state: 'staging', row: 'none', action: 'missing' });
    getConnection().prepare('UPDATE source_update_control SET worker_id = ?, lease_expires_at = ? WHERE singleton = 1')
        .run('dead-worker', probes.nowMs - 1);
    assert.equal(reasonFor(staging.id), null);
    assert.equal((await post(staging.id)).status, 200);
    assert.deepEqual([control().active_job_id, control().worker_id], [null, null]);
});

test('in_flight_restart: a live restart, worker, effect, handoff or activation blocks abandon', async () => {
    const cases: [string, (id: string) => void][] = [
        ['restart launched by this process', () => { probes.restartInFlight = true; }],
        ['safe-restart process alive', () => { probes.safeRestart = true; }],
        ['worker lease unexpired', () => getConnection().prepare('UPDATE source_update_control SET worker_id = ?, lease_expires_at = ? WHERE singleton = 1').run('w', probes.nowMs + 60_000)],
        ['worker process alive', () => { probes.leaseAlive = true; getConnection().prepare('UPDATE source_update_control SET worker_id = ?, lease_expires_at = 0 WHERE singleton = 1').run('w'); }],
        ['running effect', (id) => getConnection().prepare(`INSERT INTO source_update_effects(job_id, effect_id, worker_fence, effect_kind, pid, start_ticks, boot_id, pgid)
            VALUES (?, 'e1', 3, 'npm', 4242, '1', 'boot', 4242)`).run(id)],
        ['handoff naming no transaction', () => writeHandoff()],
        ['handoff of another transaction', () => writeHandoff('update-some-other-transaction')],
        ['handoff of this very job', (id) => writeHandoff(sourceUpdateJobsDb.getById(id)!.transaction_id as string)],
        ['activation started', (id) => getConnection().prepare("UPDATE source_update_jobs SET state = 'activating' WHERE id = ?").run(id)],
    ];
    for (const [label, arrange] of cases) {
        probes = { ...probes, restartInFlight: false, safeRestart: false, leaseAlive: false };
        fs.rmSync(path.join(controlRoot, 'bootstrap-handoff.json'), { force: true });
        const stuck = job();
        arrange(stuck.id);
        const response = await post(stuck.id);
        assert.equal(response.status, 409, label);
        assert.deepEqual([response.body.error.code, response.body.error.reason, response.body.reason],
            ['update_not_abandonable', 'in_flight_restart', 'in_flight_restart'], label);
        assert.equal(typeof response.body.error.message, 'string');
        assert.notEqual(sourceUpdateJobsDb.getById(stuck.id)?.state, 'failed', label);
        assert.equal(pendingServerActionsDb.getById(stuck.rowId!)?.status, 'executing', label);
        getConnection().prepare("UPDATE source_update_effects SET state = 'terminated' WHERE job_id = ?").run(stuck.id);
        getConnection().prepare("UPDATE source_update_jobs SET state = 'failed' WHERE id = ?").run(stuck.id);
        getConnection().prepare('UPDATE source_update_control SET worker_id = NULL, lease_expires_at = NULL WHERE singleton = 1').run();
    }
});

test('gate_closed: a closed, MANUAL, degraded, pending-OID or unreadable journal blocks abandon', async () => {
    const gates: [string, () => unknown][] = [
        ['closed', () => ({ ...OPEN_GATE, state: 'UPDATING', gateClosed: true })],
        ['manual', () => ({ ...OPEN_GATE, state: 'MANUAL', gateClosed: true })],
        ['recovering', () => ({ ...OPEN_GATE, state: 'RECOVERING', gateClosed: true })],
        ['degraded', () => ({ ...OPEN_GATE, degraded: 'source_at_target' })],
        ['oid intent', () => ({ ...OPEN_GATE, oidAdmissionIntentPending: true })],
        ['restarting handoff', () => ({ ...OPEN_GATE, phase: 'RESTARTING_HANDOFF' })],
        ['unreadable', () => { throw new Error('update_existing_control_unsafe'); }],
    ];
    for (const [label, gate] of gates) {
        probes.gate = gate;
        const stuck = job();
        const response = await post(stuck.id);
        assert.deepEqual([response.status, response.body.error.reason], [409, 'gate_closed'], label);
        assert.equal(sourceUpdateJobsDb.getById(stuck.id)?.state, 'restart_queued', label);
        getConnection().prepare("UPDATE source_update_jobs SET state = 'failed' WHERE id = ?").run(stuck.id);
    }
});

test('head_moved_unverified: only a provably pre-update runtime may be abandoned', async () => {
    const blocked: [string, Partial<Probes>, JobOptions][] = [
        ['target already loaded', { runtime: TARGET, head: TARGET }, {}],
        ['HEAD at the target though runtime is original', { head: TARGET, runtime: ORIGINAL }, {}],
        ['HEAD and runtime both moved', { head: MOVED, runtime: MOVED }, {}],
        ['HEAD unreadable, runtime moved', { head: null, runtime: MOVED }, {}],
        ['no evidence and runtime unreadable', { runtime: null }, { action: 'missing' }],
        ['no evidence and HEAD at target', { head: TARGET }, { action: 'missing' }],
        ['release layout with unknown runtime', { runtime: null }, { strategy: 'release-layout-v2' }],
    ];
    for (const [label, probe, options] of blocked) {
        Object.assign(probes, probe);
        const stuck = job(options);
        const response = await post(stuck.id);
        assert.deepEqual([response.status, response.body.error.reason], [409, 'head_moved_unverified'], label);
        getConnection().prepare("UPDATE source_update_jobs SET state = 'failed' WHERE id = ?").run(stuck.id);
        probes.head = ORIGINAL; probes.runtime = PREVIOUS;
    }
    const allowed: [string, Partial<Probes>, JobOptions][] = [
        ['HEAD at originalHead', { head: ORIGINAL, runtime: MOVED }, {}],
        ['runtime at previousRuntimeOid', { head: MOVED, runtime: PREVIOUS }, {}],
        ['runtime at originalHead', { head: MOVED, runtime: ORIGINAL }, {}],
        ['no evidence, neither at target', { head: MOVED, runtime: MOVED }, { action: 'missing' }],
        ['release layout, runtime not the target', { runtime: PREVIOUS, head: null }, { strategy: 'release-layout-v2' }],
    ];
    for (const [label, probe, options] of allowed) {
        Object.assign(probes, probe);
        const stuck = job(options);
        assert.equal((await post(stuck.id)).status, 200, label);
        probes.head = ORIGINAL; probes.runtime = PREVIOUS;
    }
});

test('terminal, missing and foreign jobs: 409 terminal and 404 not found', async () => {
    const done = job();
    getConnection().prepare("UPDATE source_update_jobs SET state = 'activated' WHERE id = ?").run(done.id);
    const response = await post(done.id);
    assert.deepEqual([response.status, response.body.error.code, response.body.error.reason], [409, 'update_not_abandonable', 'terminal']);
    assert.equal(sourceUpdateJobsDb.getById(done.id)?.state, 'activated');

    const missing = await post('no-such-job');
    assert.deepEqual([missing.status, missing.body.error.code], [404, 'update_job_not_found']);
    const foreign = job({ owner: otherOwnerId });
    const notMine = await post(foreign.id);
    assert.deepEqual([notMine.status, notMine.body.error.code], [404, 'update_job_not_found']);
    assert.equal(sourceUpdateJobsDb.getById(foreign.id)?.state, 'restart_queued');
});

test('authorization and confirmation: admin and user are 403, a missing confirm is 400', async () => {
    const stuck = job();
    for (const role of ['admin', 'user']) {
        const response = await post(stuck.id, { confirm: true }, { id: adminId, role, username: `b1605-${role}` });
        assert.equal(response.status, 403, role);
    }
    for (const body of [{}, { confirm: 'true' }, { confirm: false }]) {
        const response = await post(stuck.id, body);
        assert.deepEqual([response.status, response.body.error.code], [400, 'update_abandon_confirmation_required']);
    }
    assert.equal(sourceUpdateJobsDb.getById(stuck.id)?.state, 'restart_queued');
});

test('a concurrent change between probe and write is refused, not overwritten', () => {
    const stuck = job();
    const moved = sourceUpdateJobsDb.abandonByOwner({ jobId: stuck.id, ownerId, expectedState: 'restart_queued',
        expectedProgressSeq: 999, code: UPDATE_ABANDONED_BY_OWNER, message: 'm', facts: {} });
    assert.equal(moved.outcome, 'changed');
    assert.equal(sourceUpdateJobsDb.getById(stuck.id)?.state, 'restart_queued');
});

test('active-job payload carries abandonable and abandonBlockedReason', () => {
    const stuck = job();
    const payload = toActiveUpdateJobPayload(sourceUpdateJobsDb.getById(stuck.id), abandoner.evaluate(sourceUpdateJobsDb.getById(stuck.id)));
    assert.deepEqual(payload, { jobId: stuck.id, state: 'restart_queued', targetVersion: '1.0.0.1',
        statusUrl: `/api/system/update/jobs/${stuck.id}`, abandonable: true, abandonBlockedReason: null });
    probes.gate = () => ({ ...OPEN_GATE, state: 'MANUAL', gateClosed: true });
    assert.deepEqual(toActiveUpdateJobPayload(sourceUpdateJobsDb.getById(stuck.id), abandoner.evaluate(sourceUpdateJobsDb.getById(stuck.id))),
        { ...payload, abandonable: false, abandonBlockedReason: 'gate_closed' });
});

test('evidence: a hash-bound action or a receipt names originalHead; a foreign file does not', () => {
    const stuck = job({ action: 'bound' });
    const row = sourceUpdateJobsDb.getById(stuck.id);
    assert.deepEqual(readQueuedActionEvidence(row, controlRoot, []), { originalHead: ORIGINAL, previousRuntimeOid: PREVIOUS, source: 'action' });
    fs.appendFileSync(path.join(controlRoot, 'candidates', stuck.transactionId, 'activation-action.json'), 'x');
    assert.equal(readQueuedActionEvidence(row, controlRoot, []), null);
    const receipt = { facts_json: JSON.stringify({ transactionId: stuck.transactionId, originalHead: MOVED }) };
    assert.deepEqual(readQueuedActionEvidence(row, controlRoot, [receipt]), { originalHead: MOVED, previousRuntimeOid: null, source: 'receipt' });
    const foreign = { facts_json: JSON.stringify({ transactionId: 'other', originalHead: MOVED }) };
    assert.equal(readQueuedActionEvidence(row, controlRoot, [foreign]), null);
});

test('isSafeRestartProcessRunning matches a safe-restart argv only, and fails closed', () => {
    const proc = path.join(sandbox, 'proc');
    fs.mkdirSync(path.join(proc, '101'), { recursive: true });
    fs.writeFileSync(path.join(proc, '101', 'cmdline'), 'bash\0scripts/not-safe-restart.sh.bak\0');
    assert.equal(isSafeRestartProcessRunning({ procRoot: proc, uid: process.getuid!() }), false);
    fs.mkdirSync(path.join(proc, '102'));
    fs.writeFileSync(path.join(proc, '102', 'cmdline'), 'bash\0/srv/app/scripts/safe-restart.sh\0--json\0');
    assert.equal(isSafeRestartProcessRunning({ procRoot: proc, uid: process.getuid!() }), false, 'a --json probe is not a restart');
    fs.writeFileSync(path.join(proc, '102', 'cmdline'), 'bash\0/srv/app/scripts/safe-restart.sh\0--exec\0');
    assert.equal(isSafeRestartProcessRunning({ procRoot: proc, uid: process.getuid!() }), true);
    assert.equal(isSafeRestartProcessRunning({ procRoot: proc, uid: process.getuid!() + 1 }), false);
    assert.equal(isSafeRestartProcessRunning({ procRoot: path.join(sandbox, 'no-proc') }), true);
});

test('the REAL node shape (stale handoff of the finished tx, receipts without originalHead): abandon, then a new job', async () => {
    // Both nodes: journal OPEN/ACTIVE_VERIFIED for the PREVIOUS transaction, whose
    // bootstrap-handoff.json complete() left behind; worker_id null; 0600 9-key action.
    writeHandoff(PREVIOUS_TX);
    probes.head = ORIGINAL; probes.runtime = ORIGINAL;
    const stuck = job();
    sourceUpdateJobsDb.appendActivationReceipt({ jobId: stuck.id, transactionId: stuck.transactionId, activationIdentitySha256: stuck.identity },
        'restart_queued', 'done', { transactionId: stuck.transactionId, releaseCommit: TARGET });
    const row = sourceUpdateJobsDb.getById(stuck.id)!;
    assert.deepEqual([row.state, control().active_job_id, control().worker_id, stuck.keys], ['restart_queued', stuck.id, null, 9]);
    assert.equal(fs.statSync(path.join(controlRoot, 'candidates', stuck.transactionId, 'activation-action.json')).mode & 0o777, 0o600);
    assert.ok(pendingServerActionsDb.getById(stuck.rowId!)!.executionAttemptNonce);
    assert.deepEqual(abandoner.evaluate(row), { abandonable: true, abandonBlockedReason: null, abandoned: false });
    assert.equal((await post(stuck.id)).status, 200);
    assert.equal(pendingServerActionsDb.getById(stuck.rowId!)?.status, 'failed');
    assert.ok(fs.existsSync(path.join(controlRoot, 'bootstrap-handoff.json')), 'abandon never touches the handoff file');
    const key = crypto.randomUUID();
    const fresh = sourceUpdateJobsDb.createOrReuse({ id: key, ownerId, expectedVersion: '1.0.0.2', strategy: 'git-checkout-v2',
        idempotencyKeyHash: hashSourceUpdateIdempotencyKey(key),
        requestFingerprint: sourceUpdateRequestFingerprint(ownerId, '1.0.0.2', 'git-checkout-v2') });
    assert.deepEqual([fresh.reused, fresh.job?.state], [false, 'accepted']);
});

test('the REAL node shape after a bridge moved HEAD and runtime: boot settles it superseded/source_moved', async () => {
    const { reconcileSupersededQueuedSourceUpdates } = await import('../system.js');
    writeHandoff(PREVIOUS_TX);
    const stuck = job();
    const reconcile = () => reconcileSupersededQueuedSourceUpdates({ runtimeCommit: MOVED, readHead: () => MOVED,
        controlRoot, readGate: () => OPEN_GATE });
    assert.deepEqual(reconcile().find((entry) => entry.jobId === stuck.id),
        { jobId: stuck.id, settled: true, code: 'source_update_source_moved', rows: 1 });
    assert.equal(sourceUpdateJobsDb.getById(stuck.id)?.state, 'superseded');
    assert.equal(pendingServerActionsDb.getById(stuck.rowId!)?.status, 'failed');
    assert.equal(control().active_job_id, null);
    assert.equal(reconcile().some((entry) => entry.jobId === stuck.id), false, 'a second boot settles nothing');
});

test('a worker that claims the job between the probe and the write wins', () => {
    const stuck = job();
    let reads = 0;
    const racing = createUpdateJobAbandoner({
        jobs: {
            getForOwner: sourceUpdateJobsDb.getForOwner.bind(sourceUpdateJobsDb),
            listReceipts: sourceUpdateJobsDb.listReceipts.bind(sourceUpdateJobsDb),
            hasRunningEffects: sourceUpdateJobsDb.hasRunningEffects.bind(sourceUpdateJobsDb),
            abandonByOwner: sourceUpdateJobsDb.abandonByOwner.bind(sourceUpdateJobsDb),
            readControl: () => (++reads === 1 ? null : { active_job_id: stuck.id, worker_id: 'late', lease_expires_at: probes.nowMs + 60_000 }),
        },
        actions: pendingServerActionsDb, audit: auditLogDb,
        transact: (fn: () => unknown) => getConnection().transaction(fn)(),
        readGate: () => probes.gate(), controlRoot: () => controlRoot,
        isRestartInFlight: () => false, isSafeRestartRunning: () => false, isLeaseOwnerAlive: () => false,
        readHead: () => probes.head, runtimeCommit: () => probes.runtime, now: () => probes.nowMs,
    });
    const result = racing.abandon({ jobId: stuck.id, ownerId });
    assert.deepEqual([result.outcome, (result as { reason?: string }).reason], ['blocked', 'in_flight_restart']);
    assert.equal(sourceUpdateJobsDb.getById(stuck.id)?.state, 'restart_queued');
    assert.equal(pendingServerActionsDb.getById(stuck.rowId!)?.status, 'executing');
});
