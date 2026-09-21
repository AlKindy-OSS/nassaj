/**
 * ADR-156 WI-13 (T-1728) — the 21 throws of plan table ب.2 on the IN-PROCESS
 * path, through `executeSourceUpdateActivation` in server/routes/system.js.
 *
 * Everything is real by default: a git repository, a sealed candidate, the
 * production maintenance gate, the application database and its jobs table,
 * the CAS source apply/rollback and the `mv --exchange` generation swap. A row
 * injects ONE throw where it originates on the forward path (or on the rollback
 * path, for the identity checks that stay in both directions); every other
 * effect happens for real, so the gate's exit is decided by the physical state.
 *
 * Invariants asserted for every case: the gate is never closed while it still
 * names an owner, and the job never stays in `activating` or `rollback_pending`.
 *
 * The file also carries the H1 chain (real apply failure, then real rollback
 * failure, no injection at all) and the crash-to-boot settlement of jobs.
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test, { after, mock } from 'node:test';

import {
    VERSION, createActivationFixture, diskTempRoot, generationsAt, git, killedOwnerAt, readJournal, sourceState,
} from '../../services/tests/source-activation-fixture.js';

type Fixture = ReturnType<typeof createActivationFixture>;
type AnyFunction = (...args: any[]) => any;
type Handler = (original: AnyFunction, ...args: any[]) => any;

const tmpDir = fs.mkdtempSync(path.join(diskTempRoot(), 'system-activation-inject-'));
process.env.DATABASE_PATH = path.join(tmpDir, 'db.sqlite');
process.env.JWT_SECRET ||= 'test-secret-for-system-activation-injection-0123456789';

const activationUrl = new URL('../../../scripts/lib/source-update-activation.mjs', import.meta.url).href;
const real: Record<string, AnyFunction> = await import(activationUrl);
const handlers = new Map<string, Handler>();
(mock as any).module(activationUrl, {
    exports: Object.fromEntries(Object.entries(real).map(([name, original]) => [name, (...args: any[]) => {
        const handler = handlers.get(name);
        return handler ? handler(original, ...args) : original(...args);
    }])),
});

const { closeConnection, getConnection } = await import('@/modules/database/connection.js');
const { initializeDatabase } = await import('@/modules/database/init-db.js');
const {
    sourceUpdateJobsDb, hashSourceUpdateIdempotencyKey, sourceUpdateRequestFingerprint,
} = await import('@/modules/database/repositories/source-update-jobs.db.js');
const { executeSourceUpdateActivation, reconcileStrandedActivationJobs } = await import('../system.js');
await initializeDatabase();

const fixtures: Fixture[] = [];
after(() => {
    for (const fixture of fixtures) fixture.cleanup();
    closeConnection();
    fs.rmSync(tmpDir, { recursive: true, force: true });
});

function fixture(options?: Parameters<typeof createActivationFixture>[0]) {
    const created = createActivationFixture(options);
    fixtures.push(created);
    return created;
}

let ownerId = 0;
const createdJobs: string[] = [];
/**
 * One real job bound to the fixture's transaction, at `state`. The repository
 * admits ONE active job at a time, so a job an earlier test deliberately left
 * active (the success path, a defect demonstration) is retired first; each
 * test has already asserted its own job's state by then.
 */
function job(fx: Fixture, state = 'restart_queued', transactionId = fx.transactionId) {
    ownerId ||= Number(getConnection().prepare(
        `INSERT INTO users(username, password_hash, role) VALUES ('wi13-owner', 'not-a-secret', 'owner')`,
    ).run().lastInsertRowid);
    for (const earlier of createdJobs) {
        getConnection().prepare(`UPDATE source_update_jobs SET state = 'failed'
            WHERE id = ? AND state NOT IN ('failed', 'rolled_back', 'manual_recovery_required')`).run(earlier);
    }
    const id = crypto.randomUUID();
    const strategy = 'git-checkout-v2' as const;
    const created = sourceUpdateJobsDb.createOrReuse({
        id, ownerId, expectedVersion: VERSION, strategy,
        idempotencyKeyHash: hashSourceUpdateIdempotencyKey(id),
        requestFingerprint: sourceUpdateRequestFingerprint(ownerId, VERSION, strategy),
    });
    assert.equal(created.job?.id, id, 'a fresh job, not a reused active one');
    createdJobs.push(id);
    const activationIdentitySha256 = crypto.createHash('sha256').update(id).digest('hex');
    getConnection().prepare(`UPDATE source_update_jobs SET state = ?, transaction_id = ?,
        activation_identity_sha256 = ?, release_commit = ? WHERE id = ?`)
        .run(state, transactionId, activationIdentitySha256, fx.targetCommit, id);
    return { id, activationIdentitySha256, transactionId };
}

const jobState = (id: string) => sourceUpdateJobsDb.getById(id)?.state;

function activate(fx: Fixture, created: ReturnType<typeof job>) {
    const row = {
        sourceUpdateJobId: created.id, sourceUpdateTransactionId: created.transactionId,
        activationIdentitySha256: created.activationIdentitySha256, releaseCommit: fx.targetCommit,
    };
    const resolved = {
        action: {
            transactionId: fx.transactionId, originalHead: fx.originalHead, targetCommit: fx.targetCommit,
            version: VERSION, manifestSha256: fx.manifestSha256, candidateRoot: fx.candidateRoot, manifestPath: fx.manifestPath,
        },
        maintenance: fx.gate,
    };
    return executeSourceUpdateActivation(row, resolved);
}

/** Run with `injected` handlers installed, always removing them afterwards. */
async function withInjections<T>(injected: Record<string, Handler>, body: () => Promise<T>): Promise<T> {
    for (const [name, handler] of Object.entries(injected)) handlers.set(name, handler);
    try { return await body(); } finally { handlers.clear(); }
}

const TERMINAL_JOB = new Set(['failed', 'rolled_back', 'manual_recovery_required']);

function assertSettled(fx: Fixture, jobId: string) {
    const journal = readJournal(fx);
    assert.ok(!(journal.gateClosed && journal.owner),
        `closed gate still names a live owner: state=${journal.state} phase=${journal.phase} pid=${journal.owner?.pid}`);
    const state = jobState(jobId);
    assert.ok(TERMINAL_JOB.has(state), `job stranded in ${state}`);
    return journal;
}

const before = (message: string): Handler => () => { throw new Error(message); };
const afterEffect = (message: string): Handler => (original, ...args) => { original(...args); throw new Error(message); };
const firstStepOnly = (message: string): Handler => (original, validation, injected = {}) => {
    original(validation, { ...injected, names: ['nodeModules'] });
    throw new Error(message);
};

type Expect = 'ROLLED_BACK' | 'REOPENED_PREVIOUS' | 'DEGRADED' | 'MANUAL';
type Row = { row: number; message: string; injected: Record<string, Handler>; expect: Expect; recoveryError?: string };

const RUNTIME = 'Runtime server identity mismatch.';
/** Plan table ب.2, each throw injected where it originates on the forward path. */
const FORWARD_ROWS: Row[] = [
    { row: 1, message: 'Unsafe activation file: candidate-manifest.json', injected: { validateCandidate: before('Unsafe activation file: candidate-manifest.json') }, expect: 'ROLLED_BACK' },
    { row: 2, message: 'Activation manifest digest mismatch.', injected: { validateCandidate: before('Activation manifest digest mismatch.') }, expect: 'ROLLED_BACK' },
    { row: 3, message: 'Activation manifest identity mismatch.', injected: { validateCandidate: before('Activation manifest identity mismatch.') }, expect: 'ROLLED_BACK' },
    { row: 4, message: 'Activation manifest path is not canonical.', injected: { validateCandidate: before('Activation manifest path is not canonical.') }, expect: 'ROLLED_BACK' },
    { row: 5, message: 'Activation candidate identity is invalid.', injected: { validateCandidate: before('Activation candidate identity is invalid.') }, expect: 'ROLLED_BACK' },
    { row: 6, message: 'Activation generations must share one filesystem.', injected: { validateCandidate: before('Activation generations must share one filesystem.') }, expect: 'ROLLED_BACK' },
    { row: 7, message: 'Activation client tree is absent from both pending and live paths.', injected: { validateCandidate: before('Activation client tree is absent from both pending and live paths.') }, expect: 'ROLLED_BACK' },
    { row: 8, message: 'Activation build provenance mismatch.', injected: { validateCandidate: before('Activation build provenance mismatch.') }, expect: 'ROLLED_BACK' },
    // Rows 9-10 only exist on the rollback of an exchange: the forward failure is a runtime mismatch.
    { row: 9, message: RUNTIME, injected: { verifyRuntimeIdentities: before(RUNTIME), rollbackGenerations: before('Rollback server previous generation identity mismatch.') }, expect: 'MANUAL', recoveryError: 'Rollback server previous generation identity mismatch.' },
    { row: 10, message: RUNTIME, injected: { verifyRuntimeIdentities: before(RUNTIME), rollbackGenerations: afterEffect('Rollback server verification failed.') }, expect: 'REOPENED_PREVIOUS', recoveryError: 'Rollback server verification failed.' },
    // Row 11 is NOT injected: an exchange that fails before its first step makes the real rollbackGenerations throw it.
    { row: 11, message: 'Activation atomic exchange failed: mv: injected before any step', injected: { exchangeGenerations: before('Activation atomic exchange failed: mv: injected before any step') }, expect: 'REOPENED_PREVIOUS', recoveryError: 'Activation rollback receipt is absent.' },
    { row: 12, message: 'Source activation gitlink change is unsupported: vendor/module', injected: { applySourceManifest: before('Source activation gitlink change is unsupported: vendor/module') }, expect: 'ROLLED_BACK' },
    { row: 13, message: 'Source activation gitlink index mismatch: vendor/module', injected: { applySourceManifest: before('Source activation gitlink index mismatch: vendor/module') }, expect: 'ROLLED_BACK' },
    { row: 14, message: 'Activation atomic exchange failed: mv: injected after nodeModules', injected: { exchangeGenerations: firstStepOnly('Activation atomic exchange failed: mv: injected after nodeModules') }, expect: 'ROLLED_BACK' },
    { row: 15, message: 'Activation server is neither pending nor already exchanged.', injected: { exchangeGenerations: before('Activation server is neither pending nor already exchanged.') }, expect: 'REOPENED_PREVIOUS', recoveryError: 'Activation rollback receipt is absent.' },
    { row: 16, message: 'Activation server verification failed after exchange.', injected: { exchangeGenerations: afterEffect('Activation server verification failed after exchange.') }, expect: 'ROLLED_BACK' },
    { row: 17, message: RUNTIME, injected: { verifyRuntimeIdentities: before(RUNTIME) }, expect: 'ROLLED_BACK' },
    // Row 18 is real and lives in its own test below; row 21 too.
    { row: 19, message: 'Source activation CAS mismatch: shipped.txt', injected: { applySourceManifest: before('Source activation CAS mismatch: shipped.txt') }, expect: 'ROLLED_BACK' },
    { row: 20, message: 'Source activation tree is invalid.', injected: { applySourceManifest: before('Source activation tree is invalid.') }, expect: 'ROLLED_BACK' },
];

/** The identity checks that stay in BOTH directions, thrown by the rollback of an applied source. */
const ROLLBACK_SOURCE_ROWS: Row[] = [13, 19, 20].map((row) => {
    const message = { 13: 'Source activation gitlink index mismatch: vendor/module', 19: 'Source activation CAS mismatch: shipped.txt', 20: 'Source activation tree is invalid.' }[row]!;
    return { row, message: RUNTIME, injected: { verifyRuntimeIdentities: before(RUNTIME), rollbackSourceManifest: before(message) }, expect: 'DEGRADED', recoveryError: message };
});

/* ---- 1. crash -> boot: every stranded job settles against the real gate (C2) ---- */

async function crashedAndRecovered(stopAt: string, injected: Record<string, Handler> = {}) {
    const fx = fixture();
    await killedOwnerAt(fx, stopAt);
    const { createUpdateMaintenanceGate } = await import('../../services/update-maintenance-gate.js');
    await withInjections(injected, () => createUpdateMaintenanceGate({ projectPath: fx.root }).recoverOrDeclareManual({ waitMs: 2_000 }));
    return fx;
}

function settleOnly(fx: Fixture, jobId: string) {
    const settled = reconcileStrandedActivationJobs({ readGate: () => fx.gate.readPublicStatus() });
    return settled.find((entry: { jobId: string }) => entry.jobId === jobId);
}

test('boot settlement: a crash the gate rolled back leaves no job in activating', async () => {
    const fx = await crashedAndRecovered('SOURCE_APPLIED');
    const created = job(fx, 'activating');
    assert.equal(settleOnly(fx, created.id)?.code, 'source_update_activation_interrupted');
    assert.equal(jobState(created.id), 'failed');
});

test('boot settlement: a degraded reopen of the same transaction needs the human exit path', async () => {
    const fx = await crashedAndRecovered('SOURCE_APPLIED', { rollbackSourceManifest: before('Source activation CAS mismatch: shipped.txt') });
    assert.equal(fx.gate.readPublicStatus().degraded, 'source_tree_at_target');
    const created = job(fx, 'rollback_pending');
    assert.equal(settleOnly(fx, created.id)?.code, 'update_source_state_degraded');
    assert.equal(jobState(created.id), 'manual_recovery_required');
});

test('boot settlement: a MANUAL gate past the handoff makes its job manual, never leaves it pending', async () => {
    const fx = await crashedAndRecovered('HANDOFF');
    assert.equal(fx.gate.readPublicStatus().state, 'MANUAL');
    const created = job(fx, 'activating');
    assert.equal(settleOnly(fx, created.id)?.code, 'source_update_manual_recovery_required');
    assert.equal(jobState(created.id), 'manual_recovery_required');
});

/* ---- 2. the in-process path: success pinned, then every row ---- */

test('an uninjected activation reaches the handoff with every effect real', async () => {
    const fx = fixture();
    const created = job(fx);
    const context = await activate(fx, created);
    assert.equal(context.handoff.descriptor.transactionId, fx.transactionId);
    assert.equal(readJournal(fx).phase, 'RESTARTING_HANDOFF');
    assert.equal(jobState(created.id), 'runtime_verifying');
    assert.equal(generationsAt(fx), 'target');
    assert.equal(sourceState(fx).atTarget, true);
    context.update.release();
});

for (const entry of [...FORWARD_ROWS, ...ROLLBACK_SOURCE_ROWS.map((row) => ({ ...row, rollbackSite: true }))]) {
    const site = 'rollbackSite' in entry ? 'rollbackSourceManifest' : Object.keys(entry.injected).at(-1);
    test(`ب.2 row ${entry.row} in-process at ${site} ends ${entry.expect}`, async () => {
        const fx = fixture();
        const created = job(fx);
        await withInjections(entry.injected, () => assert.rejects(activate(fx, created), (error: Error) => {
            assert.equal(error.message, entry.message);
            return true;
        }));
        const journal = assertSettled(fx, created.id);
        const status = fx.gate.readPublicStatus();
        if (entry.expect === 'MANUAL') {
            assert.equal(journal.state, 'MANUAL');
            assert.equal(journal.recoveryError, entry.recoveryError);
            assert.equal(journal.reopenRefusedReason, 'update_reopen_generation_mismatch_client');
            assert.equal(generationsAt(fx), 'target', 'MANUAL only because the generations could not be restored');
            assert.equal(jobState(created.id), 'manual_recovery_required');
            return;
        }
        assert.equal(status.gateClosed, false);
        assert.notEqual(generationsAt(fx), 'target');
        if (entry.expect === 'DEGRADED') {
            assert.equal(status.degraded, 'source_tree_at_target');
            assert.equal(journal.recoveryError, entry.recoveryError);
            assert.equal(sourceState(fx).atTarget, true);
            assert.equal(jobState(created.id), 'manual_recovery_required');
            // Decision 7: the degraded reopen blocks the next activation before its gate closes.
            const next = job(fx, 'restart_queued', `${fx.transactionId}-next`);
            await assert.rejects(activate(fx, next), /update_source_state_degraded/);
            assert.equal(jobState(next.id), 'failed');
            return;
        }
        assert.equal(status.degraded, null);
        assert.equal(status.transactionId, null);
        assert.equal(sourceState(fx).atOriginal, true);
        assert.equal(jobState(created.id), 'rolled_back');
        if (entry.expect === 'REOPENED_PREVIOUS') {
            assert.equal(journal.recovery, 'REOPENED_PREVIOUS');
            assert.equal(journal.recoveryError, entry.recoveryError);
        } else {
            assert.equal(journal.rollbackReason, 'activation_failed');
        }
    });
}

test('ب.2 row 14 in-process: a partial exchange is undone from its durable receipt', async () => {
    const fx = fixture();
    const created = job(fx);
    const previousGenerations = generationsAt(fx);
    const partial: Handler = (original, validation, injected = {}) => {
        original(validation, { ...injected, names: ['nodeModules'] });
        const receipt = JSON.parse(fs.readFileSync(path.join(fx.candidateRoot, 'activation-receipt.json'), 'utf8'));
        assert.deepEqual(Object.keys(receipt.steps), ['nodeModules']);
        assert.equal(receipt.steps.nodeModules.state, 'exchanged');
        throw new Error('Activation atomic exchange failed: mv: partial');
    };
    await withInjections({ exchangeGenerations: partial },
        () => assert.rejects(activate(fx, created), /partial/));
    const receipt = JSON.parse(fs.readFileSync(path.join(fx.candidateRoot, 'activation-receipt.json'), 'utf8'));
    assert.deepEqual(Object.keys(receipt.steps).sort(), ['client', 'nodeModules', 'server']);
    for (const step of Object.values(receipt.steps) as { state: string }[]) assert.equal(step.state, 'rolled_back');
    assert.equal(receipt.state, 'rolled_back');
    assert.equal(generationsAt(fx), previousGenerations);
});

test('a real beginUpdate refusal fails the job and leaves the gate exactly as it was', async () => {
    const fx = fixture();
    const blocker = await fx.gate.beginUpdate({ ...fx.identity, transactionId: `${fx.transactionId}-other` }, { waitMs: 200 });
    blocker.release();
    const before = readJournal(fx);
    const created = job(fx);
    // The journal is UPDATING under another transaction whose owner is this living process.
    await assert.rejects(activate(fx, created), /update_maintenance_active/);
    assert.equal(jobState(created.id), 'failed');
    assert.equal(readJournal(fx).sequence, before.sequence);
    assert.equal(sourceState(fx).atOriginal, true, 'nothing was written');
});

/*
 * B-1126 (found by this test, T-1728). ب.2 row 18 in-process, with a REAL
 * obstacle: a stale handoff temporary makes the descriptor write fail (EEXIST)
 * after `prepareBootstrapHandoff` already moved the journal to
 * RESTARTING_HANDOFF. system.js recorded that phase only after the call
 * returned, so rollback() asked for ACTIVATION_QUEUED -> ROLLBACK_PREPARED, the
 * gate refused, and only the leases were released: UPDATING and closed under
 * this living process. The phase is now read back from the gate.
 */
test('ب.2 row 18 in-process — a failed handoff write does not leave a closed gate with a live owner', async () => {
    const fx = fixture();
    const created = job(fx);
    fs.writeFileSync(path.join(fx.gate.paths.controlRoot, `.bootstrap-handoff.${process.pid}.tmp`), '');
    await assert.rejects(activate(fx, created), /EEXIST/);
    const journal = readJournal(fx);
    assert.equal(jobState(created.id), 'manual_recovery_required');
    assert.ok(!(journal.gateClosed && journal.owner),
        `closed gate names this live process: state=${journal.state} phase=${journal.phase} pid=${journal.owner?.pid}`);
});

/*
 * B-1127 (found by this test, T-1728). ب.2 row 21 in-process: after the
 * handoff, `rollback()` used to leave the job in rollback_pending, and
 * `declareManual` kept `owner` — this living process — so `doctor
 * --reopen-gate` refused with update_owner_alive until the process died.
 * MANUAL now names no owner and the job ends manual_recovery_required.
 */
test('ب.2 row 21 in-process — a post-handoff rollback ends MANUAL without an owner and a terminal job', async () => {
    const fx = fixture();
    const created = job(fx);
    const context = await activate(fx, created);
    assert.throws(() => context.rollback('restart_failed'), /update_database_state_unknown/);
    const journal = readJournal(fx);
    assert.equal(journal.state, 'MANUAL');
    assert.equal(journal.recoveryError, 'update_database_state_unknown');
    assert.equal(journal.owner, null, `MANUAL still names this live process as owner (pid ${journal.owner?.pid})`);
    assert.ok(TERMINAL_JOB.has(jobState(created.id)), `job left in ${jobState(created.id)}`);
});

/* ---- 3. the H1 chain: a real apply failure, then a real rollback failure — no injection ---- */

test('H1 chain: index.lock fails the apply after its worktree writes and the rollback after its own; the gate reopens', async () => {
    const fx = fixture();
    const created = job(fx);
    const lock = path.join(fx.root, '.git', 'index.lock');
    fs.writeFileSync(lock, '');
    await assert.rejects(activate(fx, created), /Source activation Git operation failed/);
    const journal = assertSettled(fx, created.id);
    // Reaching REOPENED_PREVIOUS at all proves the rollback threw: only then is reopenOrDeclareManual taken.
    assert.deepEqual({ state: journal.state, gateClosed: journal.gateClosed, recovery: journal.recovery, owner: journal.owner },
        { state: 'OPEN', gateClosed: false, recovery: 'REOPENED_PREVIOUS', owner: null });
    assert.equal(journal.recoveryError, 'Source activation Git operation failed.');
    assert.equal(sourceState(fx).atOriginal, true, 'the rollback restored every worktree path before its index write failed');
    assert.equal(jobState(created.id), 'rolled_back');
    assert.equal(fs.existsSync(lock), true);
    const writer = await fx.gate.acquireWriterLease({ kind: 'git-write', waitMs: 200 });
    writer.release();
});

test('H1 chain: EACCES stops the apply half way, EEXIST stops the rollback half way; MANUAL with no owner, then a human exit', async () => {
    const fx = fixture({
        original: { '.gitignore': 'dist/\ndist-server/\nnode_modules/\n', 'a.txt': 'a-original\n', 'removed.txt': 'removed\n', 'ro/inner.txt': 'inner-original\n' },
        target: { 'a.txt': 'a-target\n', 'removed.txt': null, 'ro/inner.txt': 'inner-target\n' },
    });
    const created = job(fx);
    // Apply: unlinks removed.txt, installs a.txt, then cannot create its temporary inside ro/.
    fs.chmodSync(path.join(fx.root, 'ro'), 0o555);
    // Rollback: restores a.txt, then cannot create removed.txt's temporary (a stale one holds the name).
    const stale = path.join(fx.root, `removed.txt.nassaj-update-${process.pid}`);
    fs.writeFileSync(stale, 'stale');
    await assert.rejects(activate(fx, created), /EACCES/);
    const journal = assertSettled(fx, created.id);
    assert.deepEqual({ state: journal.state, gateClosed: journal.gateClosed, owner: journal.owner, refused: journal.reopenRefusedReason },
        { state: 'MANUAL', gateClosed: true, owner: null, refused: 'update_reopen_source_tree_mixed' });
    assert.match(journal.recoveryError, /EEXIST/, 'the rollback failed for real, on its own obstacle');
    assert.equal(fs.readFileSync(path.join(fx.root, 'a.txt'), 'utf8'), 'a-original\n');
    assert.equal(fs.existsSync(path.join(fx.root, 'removed.txt')), false);
    assert.equal(jobState(created.id), 'manual_recovery_required');

    // MANUAL is not a dead end: the operator clears both obstacles, restores the one path, and reopens.
    fs.rmSync(stale);
    fs.chmodSync(path.join(fx.root, 'ro'), 0o755);
    git(fx.root, 'checkout', '--', 'removed.txt');
    const reopened = await fx.gate.reopenOnPreviousGeneration({ waitMs: 2_000, dryRun: false });
    assert.equal(reopened.applied, true);
    const status = fx.gate.readPublicStatus();
    assert.deepEqual({ gateClosed: status.gateClosed, degraded: status.degraded, human: status.metrics.interventionsRequired },
        { gateClosed: false, degraded: null, human: 1 });
});
