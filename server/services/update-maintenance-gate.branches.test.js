/**
 * T-1728 coverage: the maintenance-gate branches the behaviour suites left
 * dark. Everything runs against the production gate on a real git checkout
 * under TMPDIR; the only thing edited by hand is the journal, and always with
 * a valid checksum, so each case reaches the branch it names and no other.
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import test from 'node:test';

import { createActivationFixture, generationsAt, killedOwnerAt, readJournal, sourceState } from './tests/source-activation-fixture.js';
import { createUpdateMaintenanceGate } from './update-maintenance-gate.js';

const TRANSACTION = 'update-transaction-branches';

function repository(t) {
    const root = fs.mkdtempSync(path.join(process.env.TMPDIR || '/var/tmp', 'nassaj-gate-branches-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    execFileSync('git', ['init', '-q'], { cwd: root });
    return root;
}

function identity(overrides = {}) {
    return {
        transactionId: TRANSACTION, expectedVersion: '1.47.0.16',
        originalHead: 'a'.repeat(40), targetCommit: 'b'.repeat(40), ...overrides,
    };
}

const canonical = (value) => (Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
    : value && typeof value === 'object'
        ? `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
        : JSON.stringify(value));

/** Edit the journal the way only a checksum-aware writer could. */
function rewriteJournal(gate, mutate) {
    const current = JSON.parse(fs.readFileSync(gate.paths.journal, 'utf8'));
    const { checksum: _old, ...payload } = mutate({ ...current });
    fs.writeFileSync(gate.paths.journal, JSON.stringify({
        ...payload, checksum: crypto.createHash('sha256').update(canonical(payload)).digest('hex'),
    }));
}

/** An update left UPDATING at `phase` with its handle released, owned by this living process. */
async function stranded(t, phase = 'SOURCE_APPLIED') {
    const root = repository(t);
    const gate = createUpdateMaintenanceGate({ projectPath: root, recoveryRunner: async () => {} });
    const update = await gate.beginUpdate(identity(), { waitMs: 200 });
    if (phase !== 'PREPARED') update.transition(['PREPARED'], phase);
    update.release();
    return { root, gate };
}

test('inputs are validated before any lock is taken', async (t) => {
    const gate = createUpdateMaintenanceGate({ projectPath: repository(t) });
    for (const bad of [null, identity({ transactionId: 'short' }), identity({ originalHead: 'x' }),
        identity({ targetCommit: 'y' }), identity({ expectedVersion: '1.2' })]) {
        await assert.rejects(gate.beginUpdate(bad, { waitMs: 50 }), /update_identity_invalid/);
    }
    await assert.rejects(gate.acquireWriterLease({ kind: 'Not A Kind', waitMs: 50 }), /update_writer_kind_invalid/);
    await assert.rejects(gate.acquireWriterLease({ waitMs: 50 }), /update_writer_kind_invalid/);
    await assert.rejects(gate.claimBootstrapOwnership({ transactionId: 'x', epoch: 'y', tokenFilePath: gate.paths.token }),
        /update_ownership_context_invalid/);
    await assert.rejects(gate.claimBootstrapOwnership({ transactionId: TRANSACTION, epoch: 'e'.repeat(24), tokenFilePath: '/elsewhere' }),
        /update_ownership_context_invalid/);
    fs.chmodSync(gate.paths.token, 0o644);
    await assert.rejects(gate.claimBootstrapOwnership({ transactionId: TRANSACTION, epoch: 'e'.repeat(24), tokenFilePath: gate.paths.token }),
        /update_ownership_token_unsafe/);
    fs.chmodSync(gate.paths.token, 0o600);
});

test('a directory that is not a git checkout has no control root', (t) => {
    const plain = fs.mkdtempSync(path.join(process.env.TMPDIR || '/var/tmp', 'nassaj-gate-plain-'));
    t.after(() => fs.rmSync(plain, { recursive: true, force: true }));
    assert.throws(() => createUpdateMaintenanceGate({ projectPath: plain }), /update_common_dir_unavailable/);
});

test('the ownership token is verified by content, not only by mode', (t) => {
    const root = repository(t);
    const gate = createUpdateMaintenanceGate({ projectPath: root });
    const original = fs.readFileSync(gate.paths.token, 'utf8');
    fs.writeFileSync(gate.paths.token, 'too short', { mode: 0o600 });
    assert.throws(() => createUpdateMaintenanceGate({ projectPath: root }), /update_ownership_token_invalid/);
    fs.writeFileSync(gate.paths.token, crypto.randomBytes(32).toString('base64url'), { mode: 0o600 });
    assert.throws(() => createUpdateMaintenanceGate({ projectPath: root }), /update_ownership_token_mismatch/);
    fs.writeFileSync(gate.paths.token, original, { mode: 0o600 });
    assert.equal(createUpdateMaintenanceGate({ projectPath: root }).readPublicStatus().state, 'OPEN');
});

test('an unreadable journal and an unknown phase are both refused', (t) => {
    const gate = createUpdateMaintenanceGate({ projectPath: repository(t) });
    rewriteJournal(gate, (journal) => ({ ...journal, phase: 'NOT_A_PHASE' }));
    assert.throws(() => gate.readPublicStatus(), /update_journal_invalid/);
    fs.writeFileSync(gate.paths.journal, '{ not json');
    assert.throws(() => gate.readPublicStatus(), /update_journal_unavailable/);
});

test('the update handle refuses out-of-order phases and any use after release', async (t) => {
    const gate = createUpdateMaintenanceGate({ projectPath: repository(t) });
    const update = await gate.beginUpdate(identity(), { waitMs: 200 });
    assert.equal(update.phase, 'PREPARED');
    assert.throws(() => update.transition(['PREPARED'], 'NOT_A_PHASE'), /update_phase_invalid/);
    assert.throws(() => update.transition(['SOURCE_APPLIED'], 'INSTALLING'), /update_phase_invalid/);
    assert.throws(() => update.prepareBootstrapHandoff(), /update_phase_invalid/);
    assert.throws(() => update.captureArtifactSnapshot(), /artifact_snapshot_ownership_required/);
    update.release();
    update.release();
    for (const call of [
        () => update.transition(['PREPARED'], 'SOURCE_APPLYING'), () => update.prepareBootstrapHandoff(),
        () => update.complete(), () => update.completeRollback(), () => update.reopenOrDeclareManual(new Error('x')),
    ]) assert.throws(call, /update_ownership_released/);
});

test('a waiting lock is abandoned when its signal aborts', async (t) => {
    const gate = createUpdateMaintenanceGate({ projectPath: repository(t) });
    const update = await gate.beginUpdate(identity(), { waitMs: 200 });
    t.after(() => update.release());
    await assert.rejects(gate.acquireWriterLease({ kind: 'git-write', signal: AbortSignal.timeout(50), waitMs: 5_000 }),
        /update_lock_aborted/);
    const aborted = new AbortController();
    aborted.abort();
    await assert.rejects(gate.acquireWriterLease({ kind: 'git-write', signal: aborted.signal, waitMs: 5_000 }),
        /update_lock_aborted/);
});

test('a live writer makes every exclusive operation give its admission back', async (t) => {
    const gate = createUpdateMaintenanceGate({ projectPath: repository(t) });
    const writer = await gate.acquireWriterLease({ kind: 'git-write', waitMs: 200 });
    t.after(() => writer.release());
    for (const operation of [
        () => gate.recoverOrDeclareManual({ waitMs: 50 }),
        () => gate.reopenOnPreviousGeneration({ waitMs: 50 }),
        () => gate.completeSourceRollback({ waitMs: 50 }),
        () => gate.claimBootstrapOwnership({ transactionId: TRANSACTION, epoch: 'e'.repeat(24), tokenFilePath: gate.paths.token, waitMs: 50 }),
    ]) await assert.rejects(operation(), /update_lock_contended/);
    // Admission was released each time: another writer still gets in at once.
    const second = await gate.acquireWriterLease({ kind: 'session-start', waitMs: 200 });
    second.release();
});

test('recovery leaves an OPEN gate alone and re-declares MANUAL instead of recovering it', async (t) => {
    const gate = createUpdateMaintenanceGate({ projectPath: repository(t) });
    assert.deepEqual(await gate.recoverOrDeclareManual({ waitMs: 200 }), { state: 'OPEN', recovered: false });
    const update = await gate.beginUpdate(identity(), { waitMs: 200 });
    update.transition(['PREPARED'], 'SOURCE_APPLIED');
    update.declareManual('operator_review');
    const journal = JSON.parse(fs.readFileSync(gate.paths.journal, 'utf8'));
    assert.deepEqual({ state: journal.state, owner: journal.owner, recoveryError: journal.recoveryError },
        { state: 'MANUAL', owner: null, recoveryError: 'operator_review' });
    const again = await gate.recoverOrDeclareManual({ waitMs: 200 });
    assert.equal(again.state, 'MANUAL');
    assert.equal(gate.readPublicStatus().metrics.intervention, 'human', 'MANUAL alone means a person must act');
});

test('owner liveness is read from the process table, not assumed', async (t) => {
    // Same pid as this living process, but another start time: a reused pid, so dead.
    const reused = await stranded(t, 'PREPARED');
    rewriteJournal(reused.gate, (journal) => ({ ...journal, owner: { ...journal.owner, startTime: '1' } }));
    assert.equal((await reused.gate.recoverOrDeclareManual({ waitMs: 200 })).state, 'OPEN', 'an unstarted update just reopens');

    // A pid no process can hold is unknowable, so the gate stays closed.
    const unknowable = await stranded(t, 'PREPARED');
    rewriteJournal(unknowable.gate, (journal) => ({ ...journal, owner: { ...journal.owner, pid: -1 } }));
    assert.equal((await unknowable.gate.recoverOrDeclareManual({ waitMs: 200 })).state, 'MANUAL');

    // The owner really is this process: recovery must not touch it.
    const live = await stranded(t, 'SOURCE_APPLIED');
    const status = await live.gate.recoverOrDeclareManual({ waitMs: 200 });
    assert.deepEqual(status, { state: 'UPDATING', recovered: false, ownerAlive: true, phase: 'SOURCE_APPLIED' });
});

test('the doctor reopen names why it will not act', async (t) => {
    const open = createUpdateMaintenanceGate({ projectPath: repository(t) });
    assert.equal((await open.reopenOnPreviousGeneration({ waitMs: 200 })).reason, 'gate_already_open');

    const live = await stranded(t);
    assert.equal((await live.gate.reopenOnPreviousGeneration({ waitMs: 200 })).reason, 'update_owner_alive');

    const noCandidate = await stranded(t);
    rewriteJournal(noCandidate.gate, (journal) => ({ ...journal, owner: null }));
    const refused = await noCandidate.gate.reopenOnPreviousGeneration({ waitMs: 200, dryRun: false });
    assert.equal(refused.applied, false);
    assert.match(refused.reason, /ENOENT/, 'no candidate manifest, no provable previous generation');

    const badIdentity = await stranded(t);
    rewriteJournal(badIdentity.gate, (journal) => ({ ...journal, owner: null, transactionId: 'not a token' }));
    assert.equal((await badIdentity.gate.reopenOnPreviousGeneration({ waitMs: 200 })).reason, 'update_reopen_identity_unavailable');
});

test('completing the source rollback refuses every state that is not a clean degraded reopen', async (t) => {
    const open = createUpdateMaintenanceGate({ projectPath: repository(t) });
    assert.equal((await open.completeSourceRollback({ waitMs: 200 })).reason, 'source_rollback_not_degraded');

    const degraded = (patch) => async () => {
        const gate = createUpdateMaintenanceGate({ projectPath: repository(t) });
        rewriteJournal(gate, (journal) => ({
            ...journal, degraded: 'source_tree_at_target', exitPath: 'complete_source_rollback_or_pin_release_ref',
            identity: { originalHead: 'a'.repeat(40), targetCommit: 'b'.repeat(40) }, ...patch(journal),
        }));
        return gate;
    };
    const noIdentity = await degraded(() => ({ identity: null }))();
    assert.equal((await noIdentity.completeSourceRollback({ waitMs: 200 })).reason, 'update_reopen_identity_unavailable');
    const owned = await degraded(() => ({ owner: { pid: process.pid, startTime: fs.readFileSync(`/proc/${process.pid}/stat`, 'utf8')
        .slice(fs.readFileSync(`/proc/${process.pid}/stat`, 'utf8').lastIndexOf(')') + 2).split(' ')[19] } }))();
    assert.equal((await owned.completeSourceRollback({ waitMs: 200 })).reason, 'update_owner_alive');
    const closed = await degraded(() => ({ state: 'MANUAL', gateClosed: true }))();
    assert.equal((await closed.completeSourceRollback({ waitMs: 200 })).reason, 'source_rollback_not_degraded');
    const unplannable = await degraded(() => ({}))();
    const refused = await unplannable.completeSourceRollback({ waitMs: 200, dryRun: false });
    assert.equal(refused.applied, false);
    assert.match(refused.reason, /Git operation failed/, 'commits this repository does not have cannot be planned');
    assert.equal(refused.source.treeApplied, 'mixed');
});

/** Point the database resolver at the fixture's own database for one test. */
function useFixtureDatabase(t, fixture) {
    const previous = process.env.DATABASE_PATH;
    process.env.DATABASE_PATH = fixture.databasePath;
    t.after(() => { if (previous === undefined) delete process.env.DATABASE_PATH; else process.env.DATABASE_PATH = previous; });
}

test('a real crash after the exchange is rolled back for real: snapshot, generations and source', async (t) => {
    const fixture = createActivationFixture();
    t.after(() => fixture.cleanup());
    useFixtureDatabase(t, fixture);
    await killedOwnerAt(fixture, 'VERIFIED');
    assert.equal(generationsAt(fixture), 'target', 'the owner died with every generation already exchanged');
    const status = await createUpdateMaintenanceGate({ projectPath: fixture.root }).recoverOrDeclareManual({ waitMs: 2_000 });
    assert.deepEqual(status, { state: 'OPEN', recovered: true, phase: 'ROLLED_BACK' });
    assert.notEqual(generationsAt(fixture), 'target');
    assert.equal(sourceState(fixture).atOriginal, true);
    const journal = readJournal(fixture);
    assert.deepEqual({ owner: journal.owner, automatic: journal.metrics.automaticRepairs, intervention: journal.metrics.intervention },
        { owner: null, automatic: 1, intervention: 'automatic' });
});

test('a recovery action that no longer matches the journal is refused; the ب.5 exit decides instead', async (t) => {
    const fixture = createActivationFixture();
    t.after(() => fixture.cleanup());
    await killedOwnerAt(fixture, 'SOURCE_APPLIED');
    const actionFile = path.join(fixture.candidateRoot, 'activation-action.json');
    fs.writeFileSync(actionFile, JSON.stringify({ ...fixture.action, version: '9.9.9.9' }), { mode: 0o600 });
    const status = await createUpdateMaintenanceGate({ projectPath: fixture.root }).recoverOrDeclareManual({ waitMs: 2_000 });
    // No exchange ever ran (no receipt) and the source sits at target: degraded, never silent.
    assert.equal(status.phase, 'REOPENED_PREVIOUS_DEGRADED');
    assert.equal(readJournal(fixture).recoveryError, 'update_recovery_action_mismatch');
});

test('the public status never forwards a malformed degraded marker', (t) => {
    const gate = createUpdateMaintenanceGate({ projectPath: repository(t) });
    rewriteJournal(gate, (journal) => ({ ...journal, degraded: 7, exitPath: ['x'], metrics: 'nope' }));
    const status = gate.readPublicStatus();
    assert.deepEqual({ degraded: status.degraded, exitPath: status.exitPath, metrics: status.metrics },
        { degraded: null, exitPath: null, metrics: null });
});
