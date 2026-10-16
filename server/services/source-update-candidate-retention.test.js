import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
    CANDIDATE_RETENTION_KILL_SWITCH, journalRefusal, pruneSourceUpdateCandidates,
} from './source-update-candidate-retention.js';
import { createUpdateMaintenanceGate } from './update-maintenance-gate.js';

const DAY = 24 * 60 * 60 * 1000;
const silent = { info() {}, warn() {} };

function fixture(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nassaj-candidate-retention-'));
    execFileSync('git', ['init', '-q'], { cwd: root });
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'a'], { cwd: root });
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const gate = createUpdateMaintenanceGate({ projectPath: root });
    const candidates = path.join(gate.paths.controlRoot, 'candidates');
    fs.mkdirSync(candidates, { recursive: true, mode: 0o700 });
    return { root, gate, candidates, controlRoot: gate.paths.controlRoot };
}

/** A candidate as the updater leaves it: a linked worktree under source/, a payload and its plan file. */
function candidate(env, tx, { worktree = true, ageMs = 2 * DAY } = {}) {
    const dir = path.join(env.candidates, tx);
    fs.mkdirSync(dir, { mode: 0o700 });
    if (worktree) execFileSync('git', ['worktree', 'add', '-q', '--detach', path.join(dir, 'source'), 'HEAD'], { cwd: env.root });
    fs.mkdirSync(path.join(dir, 'server'));
    fs.writeFileSync(path.join(dir, 'server', 'application.js'), 'x');
    fs.writeFileSync(path.join(env.controlRoot, `plan-${tx}.json`), '{}\n', { mode: 0o600 });
    const at = new Date(Date.now() - ageMs);
    fs.utimesSync(dir, at, at);
    return dir;
}

function registered(env) {
    return execFileSync('git', ['worktree', 'list', '--porcelain'], { cwd: env.root, encoding: 'utf8' })
        .split('\n').filter((line) => line.startsWith('worktree ')).map((line) => line.slice(9))
        .filter((entry) => entry.startsWith(env.candidates));
}

const job = (transactionId, state, completedAt = null, rowOrder = 1) => ({ id: `job-${transactionId}`, state, transactionId, completedAt, rowOrder });

function run(env, jobs, extra = {}) {
    return pruneSourceUpdateCandidates({
        createGate: () => extra.gate || env.gate, listJobReferences: () => jobs, logger: silent, env: {}, ...extra,
    });
}

const exists = (env, tx) => fs.existsSync(path.join(env.candidates, tx));
const leftovers = (env) => fs.readdirSync(env.candidates).sort();

test('B-1626: old terminal candidates go with their worktree registration and plan; the last activated stays', async (t) => {
    const env = fixture(t);
    for (const tx of ['update-old-1', 'update-old-2', 'update-last', 'update-queued', 'update-manual']) candidate(env, tx);
    const jobs = [
        job('update-old-1', 'activated', '2026-10-01 10:00:00', 1),
        job('update-old-2', 'failed', '2026-10-02 10:00:00', 2),
        job('update-last', 'activated', '2026-10-03 10:00:00', 3),
        job('update-queued', 'restart_queued', null, 4),
        job('update-manual', 'manual_recovery_required', null, 5),
    ];
    const result = await run(env, jobs);
    assert.equal(result.status, 'done');
    assert.deepEqual([...result.removed].sort(), ['update-old-1', 'update-old-2']);
    assert.deepEqual(leftovers(env), ['update-last', 'update-manual', 'update-queued']);
    assert.deepEqual(registered(env).map((entry) => path.basename(path.dirname(entry))).sort(),
        ['update-last', 'update-manual', 'update-queued']);
    assert.equal(fs.existsSync(path.join(env.controlRoot, 'plan-update-old-1.json')), false);
    assert.equal(fs.existsSync(path.join(env.controlRoot, 'plan-update-last.json')), true);
});

test('B-1626: the journal transaction and the bootstrap handoff transaction are never removed', async (t) => {
    const env = fixture(t);
    for (const tx of ['update-journal', 'update-handoff', 'update-last', 'update-gone']) candidate(env, tx);
    fs.writeFileSync(path.join(env.controlRoot, 'bootstrap-handoff.json'), JSON.stringify({ transactionId: 'update-handoff' }));
    const gate = { ...env.gate, readRecoveryEvidence: () => ({ ...env.gate.readRecoveryEvidence(), transactionId: 'update-journal', phase: 'ACTIVE_VERIFIED' }) };
    const jobs = [job('update-journal', 'failed'), job('update-handoff', 'failed'), job('update-gone', 'failed'),
        job('update-last', 'activated', '2026-10-03 10:00:00')];
    const result = await run(env, jobs, { gate });
    assert.deepEqual(result.removed, ['update-gone']);
    assert.deepEqual(leftovers(env), ['update-handoff', 'update-journal', 'update-last']);
});

test('B-1626: a real MANUAL journal deletes nothing', async (t) => {
    const env = fixture(t);
    candidate(env, 'update-old');
    const update = await env.gate.beginUpdate({ transactionId: 'update-transaction-1234', expectedVersion: '1.44.0.2',
        originalHead: 'a'.repeat(40), targetCommit: 'b'.repeat(40) }, { waitMs: 100 });
    update.declareManual();
    assert.equal(env.gate.readPublicStatus().state, 'MANUAL');
    const result = await run(env, [job('update-old', 'failed'), job('update-x', 'activated', '2026-10-03')]);
    assert.equal(result.status, 'skipped');
    assert.equal(result.reason, 'update_maintenance_active');
    assert.ok(exists(env, 'update-old'));
    assert.equal(registered(env).length, 1);
});

test('B-1626: a real RECOVERING journal (recovery holding the gate) deletes nothing', async (t) => {
    const env = fixture(t);
    candidate(env, 'update-old');
    const update = await env.gate.beginUpdate({ transactionId: 'update-transaction-1234', expectedVersion: '1.44.0.2',
        originalHead: 'a'.repeat(40), targetCommit: 'b'.repeat(40) }, { waitMs: 100 });
    update.transition(['PREPARED'], 'SOURCE_APPLYING');
    update.release();
    let during;
    const recovering = createUpdateMaintenanceGate({
        projectPath: env.root, ownerAlive: () => false,
        recoveryRunner: async () => {
            assert.equal(recovering.readPublicStatus().state, 'RECOVERING');
            during = await run(env, [job('update-old', 'failed'), job('update-x', 'activated', '2026-10-03')]);
            throw new Error('rollback_failed');
        },
    });
    await recovering.recoverOrDeclareManual({ waitMs: 100 });
    assert.equal(during.status, 'skipped');
    assert.match(during.reason, /^update_lock_contended$|^update_maintenance_active$/);
    assert.ok(exists(env, 'update-old'));
});

test('B-1626: journal guard refuses RECOVERING, ROLLBACK_PREPARED, MANUAL, PRE_CANDIDATE and degraded even under a lease', async (t) => {
    const env = fixture(t);
    candidate(env, 'update-old');
    const base = env.gate.readRecoveryEvidence();
    const cases = [
        [{ state: 'RECOVERING', gateClosed: true, phase: 'ROLLBACK_PREPARED' }, 'journal_recovering'],
        [{ state: 'UPDATING', gateClosed: true, phase: 'ROLLBACK_PREPARED' }, 'journal_updating'],
        [{ state: 'OPEN', gateClosed: false, phase: 'ROLLBACK_PREPARED' }, 'journal_phase_rollback_prepared'],
        [{ state: 'MANUAL', gateClosed: true, phase: null }, 'journal_manual'],
        [{ state: 'DRAINING', gateClosed: true, phase: 'PREPARED', databaseState: 'PRE_CANDIDATE' }, 'journal_draining'],
        [{ state: 'OPEN', gateClosed: false, phase: 'PREPARED', databaseState: 'PRE_CANDIDATE' }, 'journal_phase_prepared'],
        [{ state: 'OPEN', gateClosed: false, phase: null, degraded: 'source_tree_at_target' }, 'journal_degraded'],
        [{ state: 'OPEN', gateClosed: false, phase: null, oidAdmissionIntentPending: true }, 'oid_admission_pending'],
    ];
    for (const [patch, reason] of cases) {
        const gate = { ...env.gate, readRecoveryEvidence: () => ({ ...base, ...patch }) };
        const result = await run(env, [job('update-old', 'failed'), job('update-x', 'activated', '2026-10-03')], { gate });
        assert.deepEqual([result.status, result.reason], ['skipped', reason]);
        assert.ok(exists(env, 'update-old'), reason);
    }
    assert.equal(journalRefusal({ state: 'OPEN', gateClosed: false, phase: 'ACTIVE_VERIFIED' }), null);
});

test('B-1626: lock contention skips; the updater holding the gate keeps every candidate', async (t) => {
    const env = fixture(t);
    candidate(env, 'update-old');
    const update = await env.gate.beginUpdate({ transactionId: 'update-transaction-1234', expectedVersion: '1.44.0.2',
        originalHead: 'a'.repeat(40), targetCommit: 'b'.repeat(40) }, { waitMs: 100 });
    t.after(() => update.release());
    const result = await run(env, [job('update-old', 'failed'), job('update-x', 'activated', '2026-10-03')],
        { options: { leaseWaitMs: 50 } });
    assert.equal(result.status, 'skipped');
    assert.match(result.reason, /^update_lock_contended$|^update_maintenance_active$/);
    assert.ok(exists(env, 'update-old'));
});

test('B-1626: the retention lease blocks beginUpdate as contended (deferrable), never closing the gate', async (t) => {
    const env = fixture(t);
    candidate(env, 'update-old', { worktree: false });
    let outcome;
    // The sweep's Git call runs under the lease; an update attempted meanwhile must defer.
    const runGit = async () => {
        outcome = await env.gate.beginUpdate({ transactionId: 'update-transaction-1234', expectedVersion: '1.44.0.2',
            originalHead: 'a'.repeat(40), targetCommit: 'b'.repeat(40) }, { waitMs: 50 })
            .then(() => 'began', (error) => error.message);
        return { code: 0, stdout: '' };
    };
    const result = await run(env, [job('update-old', 'failed'), job('update-x', 'activated', '2026-10-03')], { runGit });
    assert.equal(result.status, 'done');
    assert.equal(outcome, 'update_lock_contended');
    assert.equal(env.gate.readPublicStatus().state, 'OPEN');
});

test('B-1626: a job before its seal skips the sweep; an unknown last activation skips it', async (t) => {
    const env = fixture(t);
    candidate(env, 'update-old');
    const staging = await run(env, [job('update-old', 'failed'), job(null, 'staging'), job('update-x', 'activated', '2026-10-03')]);
    assert.deepEqual([staging.status, staging.reason], ['skipped', 'job_before_seal']);
    const unknown = await run(env, [job('update-old', 'failed')]);
    assert.deepEqual([unknown.status, unknown.reason], ['skipped', 'last_activated_unknown']);
    assert.ok(exists(env, 'update-old'));
});

test('B-1626: missing directories — unprotected registrations are dropped, protected ones stay', async (t) => {
    const env = fixture(t);
    candidate(env, 'update-vanished');
    candidate(env, 'update-queued');
    fs.rmSync(path.join(env.candidates, 'update-vanished'), { recursive: true, force: true });
    fs.rmSync(path.join(env.candidates, 'update-queued'), { recursive: true, force: true });
    assert.equal(registered(env).length, 2);
    const result = await run(env, [job('update-vanished', 'failed'), job('update-queued', 'restart_queued'),
        job('update-x', 'activated', '2026-10-03')]);
    assert.equal(result.status, 'done');
    assert.equal(result.registrations, 1);
    assert.deepEqual(registered(env).map((entry) => path.basename(path.dirname(entry))), ['update-queued']);
});

test('B-1626: non-worktree and orphan candidates — grace period, prestage slot, bound and retired leftovers', async (t) => {
    const env = fixture(t);
    candidate(env, 'update-plain', { worktree: false });
    candidate(env, 'update-orphan-old', { worktree: false, ageMs: 3 * DAY });
    candidate(env, 'update-orphan-young', { worktree: false, ageMs: 60_000 });
    candidate(env, 'update-pre-abc', { worktree: false, ageMs: 9 * DAY });
    fs.mkdirSync(path.join(env.candidates, '.retired-update-crashed-0001'));
    const jobs = [job('update-plain', 'superseded'), job('update-x', 'activated', '2026-10-03')];
    const bounded = await run(env, jobs, { options: { maxRemovals: 1 } });
    assert.deepEqual(bounded.removed, ['update-orphan-old']);
    assert.equal(bounded.deleted, 2);
    const rest = await run(env, jobs);
    assert.deepEqual(rest.removed, ['update-plain']);
    assert.deepEqual(leftovers(env), ['update-orphan-young', 'update-pre-abc']);
});

test('B-1626: the kill switch disables the sweep', async (t) => {
    const env = fixture(t);
    candidate(env, 'update-old', { worktree: false });
    const result = await run(env, [job('update-old', 'failed'), job('update-x', 'activated', '2026-10-03')],
        { env: { [CANDIDATE_RETENTION_KILL_SWITCH]: '0' } });
    assert.deepEqual([result.status, result.reason], ['skipped', 'disabled']);
    assert.ok(exists(env, 'update-old'));
});

test('B-1626: a failure is reported, never thrown', async () => {
    const result = await pruneSourceUpdateCandidates({
        createGate: () => { throw new Error('update_common_dir_unavailable'); }, listJobReferences: () => [], logger: silent, env: {},
    });
    assert.deepEqual(result, { status: 'error', reason: 'update_common_dir_unavailable' });
});

test('ADR-207 S2: an update-pre-* candidate no job references is the prestager\'s, never the orphan rule\'s', async (t) => {
    const env = fixture(t);
    candidate(env, 'update-pre-old', { worktree: false, ageMs: 30 * DAY });
    candidate(env, 'update-pre-gone', { ageMs: 30 * DAY });
    fs.rmSync(path.join(env.candidates, 'update-pre-gone'), { recursive: true, force: true });
    candidate(env, 'update-orphan', { worktree: false, ageMs: 30 * DAY });
    const result = await run(env, [job('update-x', 'activated', '2026-10-03')]);
    assert.equal(result.status, 'done');
    assert.deepEqual(result.removed, ['update-orphan']);
    assert.deepEqual(leftovers(env), ['update-pre-old']);
    assert.equal(fs.existsSync(path.join(env.controlRoot, 'plan-update-pre-old.json')), true);
    assert.equal(result.registrations, 0, 'the prestager\'s worktree registration is not dropped');
    assert.deepEqual(registered(env).map((entry) => path.basename(path.dirname(entry))), ['update-pre-gone']);
});

test('ADR-207 S2: an adopted update-pre-* follows normal job retention', async (t) => {
    const env = fixture(t);
    for (const tx of ['update-pre-failed', 'update-pre-queued', 'update-pre-last']) candidate(env, tx);
    candidate(env, 'update-pre-young-failed', { ageMs: 60_000 });
    const jobs = [
        job('update-pre-failed', 'failed', '2026-10-01 10:00:00', 1),
        job('update-pre-young-failed', 'cancelled', '2026-10-01 11:00:00', 2),
        job('update-pre-queued', 'restart_queued', null, 3),
        job('update-pre-last', 'activated', '2026-10-03 10:00:00', 4),
    ];
    const result = await run(env, jobs);
    assert.equal(result.status, 'done');
    assert.deepEqual([...result.removed].sort(), ['update-pre-failed', 'update-pre-young-failed'],
        'a terminal job\'s candidate goes regardless of age');
    assert.deepEqual(leftovers(env), ['update-pre-last', 'update-pre-queued']);
    assert.equal(fs.existsSync(path.join(env.controlRoot, 'plan-update-pre-failed.json')), false);
    assert.deepEqual(registered(env).map((entry) => path.basename(path.dirname(entry))).sort(),
        ['update-pre-last', 'update-pre-queued']);
});

test('ADR-207 S2: a vanished adopted update-pre-* of a terminal job drops its registration', async (t) => {
    const env = fixture(t);
    candidate(env, 'update-pre-done');
    fs.rmSync(path.join(env.candidates, 'update-pre-done'), { recursive: true, force: true });
    const result = await run(env, [job('update-pre-done', 'failed'), job('update-x', 'activated', '2026-10-03')]);
    assert.equal(result.registrations, 1);
    assert.deepEqual(registered(env), []);
});

test('T-2024 S3: a transaction named by a pending or executing safe-command row is never removed', async (t) => {
    const env = fixture(t);
    for (const tx of ['update-row-pending', 'update-row-executing', 'update-plain']) candidate(env, tx);
    const jobs = [
        job('update-row-pending', 'failed', '2026-10-01 10:00:00', 1),
        job('update-row-executing', 'cancelled', '2026-10-01 11:00:00', 2),
        job('update-plain', 'failed', '2026-10-02 10:00:00', 3),
        job('update-last', 'activated', '2026-10-03 10:00:00', 4),
    ];
    const result = await run(env, jobs, { listActionReferences: () => ['update-row-pending', 'update-row-executing'] });
    assert.equal(result.status, 'done');
    assert.deepEqual(result.removed, ['update-plain']);
    assert.deepEqual(leftovers(env), ['update-row-executing', 'update-row-pending']);
});

test('T-2024 S3: unreadable safe-command references skip the whole sweep', async (t) => {
    const env = fixture(t);
    candidate(env, 'update-old');
    const result = await run(env, [job('update-old', 'failed', '2026-10-01'), job('update-x', 'activated', '2026-10-03')],
        { listActionReferences: () => { throw new Error('db'); } });
    assert.deepEqual([result.status, result.reason], ['skipped', 'action_references_unavailable']);
    assert.ok(exists(env, 'update-old'));
});
