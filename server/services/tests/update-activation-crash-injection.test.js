/**
 * ADR-156 WI-13 (T-1728) — the 21 throws of plan table ب.2 on the CRASH path.
 *
 * Every case is a real crash: a child process activates for real (source CAS
 * apply, database snapshot, three-generation exchange) up to a phase, parks,
 * and is SIGKILLed. The recovering gate uses the production `ownerIsAlive`
 * (boot id + /proc start ticks) and the production recovery runner; the only
 * injection is ONE throw at the recovery call site the row names —
 * `validateCandidate`, `rollbackGenerations` or `rollbackSourceManifest` —
 * either before that call's effect or after it.
 *
 * The expected gate outcome is the ب.5 exit table applied to the physical state
 * the crash and the injection leave behind, never the error text:
 *   generations previous + source original -> OPEN
 *   generations previous + source target   -> OPEN, degraded, exit path named
 *   generations target, or source mixed    -> MANUAL, with no owner recorded
 * and in no case a closed gate that still names an owner.
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import test, { mock } from 'node:test';

import {
    createActivationFixture, generationsAt, killedOwnerAt, readJournal, sourceState, startOwnerAt,
} from './source-activation-fixture.js';

const activationUrl = new URL('../../../scripts/lib/source-update-activation.mjs', import.meta.url).href;
const real = await import(activationUrl);
let injection = null;
mock.module(activationUrl, {
    exports: Object.fromEntries(Object.keys(real).map((name) => [name, (...args) => {
        if (injection?.site !== name) return real[name](...args);
        injection.fired += 1;
        if (injection.when === 'after') real[name](...args);
        throw new Error(injection.message);
    }])),
});
const { createUpdateMaintenanceGate } = await import('../update-maintenance-gate.js');

/** Plan table ب.2, in its order. Row 21 is a state, not a throw, and is tested below. */
const ROWS = [
    [1, 'Unsafe activation file: candidate-manifest.json', 'validateCandidate', 'before'],
    [2, 'Activation manifest digest mismatch.', 'validateCandidate', 'before'],
    [3, 'Activation manifest identity mismatch.', 'validateCandidate', 'before'],
    [4, 'Activation manifest path is not canonical.', 'validateCandidate', 'before'],
    [5, 'Activation candidate identity is invalid.', 'validateCandidate', 'before'],
    [6, 'Activation generations must share one filesystem.', 'validateCandidate', 'before'],
    [7, 'Activation client tree is absent from both pending and live paths.', 'validateCandidate', 'before'],
    [8, 'Activation build provenance mismatch.', 'validateCandidate', 'before'],
    [9, 'Rollback server previous generation identity mismatch.', 'rollbackGenerations', 'before'],
    [10, 'Rollback server verification failed.', 'rollbackGenerations', 'after'],
    [11, 'Activation rollback receipt is absent.', 'rollbackGenerations', 'before'],
    [12, 'Source activation gitlink change is unsupported: vendor/module', 'rollbackSourceManifest', 'before'],
    [13, 'Source activation gitlink index mismatch: vendor/module', 'rollbackSourceManifest', 'before'],
    [14, 'Activation atomic exchange failed: mv: injected', 'rollbackGenerations', 'before'],
    [15, 'Activation server is neither pending nor already exchanged.', 'rollbackGenerations', 'before'],
    [16, 'Activation server verification failed after exchange.', 'rollbackGenerations', 'after'],
    [17, 'Runtime server identity mismatch.', 'validateCandidate', 'before'],
    [18, 'Bootstrap descriptor collision.', 'validateCandidate', 'before'],
    [19, 'Source activation CAS mismatch: shipped.txt', 'rollbackSourceManifest', 'before'],
    [20, 'Source activation tree is invalid.', 'rollbackSourceManifest', 'before'],
];

/**
 * The ب.5 row the physical state selects. A crash at SOURCE_APPLIED left no
 * receipt (the recovery then never calls rollbackGenerations); a crash at
 * VERIFIED left all three generations exchanged to the target.
 */
function expectedOutcome(stopAt, site, when) {
    if (stopAt === 'SOURCE_APPLIED') {
        if (site === 'rollbackGenerations') return 'ROLLED_BACK';
        return site === 'rollbackSourceManifest' && when === 'after' ? 'REOPENED_PREVIOUS' : 'REOPENED_PREVIOUS_DEGRADED';
    }
    if (site === 'validateCandidate') return 'MANUAL';
    if (site === 'rollbackGenerations') return when === 'after' ? 'REOPENED_PREVIOUS_DEGRADED' : 'MANUAL';
    return when === 'after' ? 'REOPENED_PREVIOUS' : 'REOPENED_PREVIOUS_DEGRADED';
}

/** Crash a real owner at `stopAt`, then recover through the production gate with one injection. */
async function crashThenRecover(t, stopAt, site, when, message) {
    const fixture = createActivationFixture();
    t.after(() => fixture.cleanup());
    const pid = await killedOwnerAt(fixture, stopAt);
    assert.equal(readJournal(fixture).owner.pid, pid, 'the journal names the killed child as owner');
    assert.equal(fs.existsSync(`/proc/${pid}`), false, 'the owner is really gone from /proc');
    const previousDatabase = process.env.DATABASE_PATH;
    process.env.DATABASE_PATH = fixture.databasePath;
    injection = { site, when, message, fired: 0 };
    try {
        // No ownerAlive, no recoveryRunner: both are the production defaults.
        const gate = createUpdateMaintenanceGate({ projectPath: fixture.root });
        const status = await gate.recoverOrDeclareManual({ waitMs: 2_000 });
        return { fixture, gate, status, fired: injection.fired };
    } finally {
        injection = null;
        if (previousDatabase === undefined) delete process.env.DATABASE_PATH;
        else process.env.DATABASE_PATH = previousDatabase;
    }
}

/** The invariant for every case, whatever the row: no closed gate still names an owner. */
function assertNoOwnerOnClosedGate(journal) {
    assert.ok(!(journal.gateClosed && journal.owner),
        `closed gate with a recorded owner: state=${journal.state} phase=${journal.phase} pid=${journal.owner?.pid}`);
    assert.equal(journal.owner, null);
}

for (const stopAt of ['SOURCE_APPLIED', 'VERIFIED']) {
    for (const [row, message, site, when] of ROWS) {
        const expected = expectedOutcome(stopAt, site, when);
        test(`ب.2 row ${row} at ${site} (${when}) after a real crash at ${stopAt} ends ${expected}`, async (t) => {
            const { fixture, gate, status, fired } = await crashThenRecover(t, stopAt, site, when, message);
            const journal = readJournal(fixture);
            const published = gate.readPublicStatus();
            const source = sourceState(fixture);
            assertNoOwnerOnClosedGate(journal);
            assert.equal(fired, expected === 'ROLLED_BACK' ? 0 : 1, 'the injection fired exactly where the row names');

            if (expected === 'MANUAL') {
                assert.deepEqual(status, { state: 'MANUAL', recovered: false, phase: stopAt });
                assert.equal(published.gateClosed, true);
                assert.equal(journal.recoveryError, message);
                assert.equal(journal.reopenRefusedReason, 'update_reopen_generation_mismatch_client');
                assert.equal(generationsAt(fixture), 'target', 'MANUAL only because the live generations are not previous');
                assert.equal(published.metrics.reachedManual, true);
                return;
            }
            assert.equal(status.state, 'OPEN');
            assert.equal(status.recovered, true);
            assert.equal(status.phase, expected);
            assert.equal(published.gateClosed, false);
            assert.notEqual(generationsAt(fixture), 'target', 'an open gate serves the previous generation');
            assert.equal(published.metrics.automaticRepairs, 1);
            assert.equal(published.metrics.interventionsRequired, 0);
            if (expected === 'REOPENED_PREVIOUS_DEGRADED') {
                assert.equal(published.degraded, 'source_tree_at_target');
                assert.equal(published.exitPath, 'complete_source_rollback_or_pin_release_ref');
                assert.equal(published.transactionId, fixture.transactionId, 'the exit path keeps the identity it needs');
                assert.equal(journal.recoveryError, message);
                assert.equal(source.atTarget, true);
            } else {
                assert.equal(published.degraded, null);
                assert.equal(published.transactionId, null);
                assert.equal(source.atOriginal, true);
                if (expected === 'REOPENED_PREVIOUS') assert.equal(journal.recoveryError, message);
            }
        });
    }
}

for (const stopAt of ['HANDOFF', 'HANDOFF_TORN']) {
    test(`ب.2 row 21: a real crash at ${stopAt} is the ADR-143 boundary, MANUAL without running any rollback`, async (t) => {
        const { fixture, gate, status, fired } = await crashThenRecover(t, stopAt, 'validateCandidate', 'before', 'must_not_run');
        assert.deepEqual(status, { state: 'MANUAL', recovered: false, phase: 'RESTARTING_HANDOFF' });
        assert.equal(fired, 0, 'no rollback is attempted past the handoff');
        const journal = readJournal(fixture);
        assertNoOwnerOnClosedGate(journal);
        assert.equal(journal.recoveryError, 'update_database_state_unknown');
        assert.equal(gate.readPublicStatus().gateClosed, true);
        assert.equal(generationsAt(fixture), 'target');
    });
}

test('a live owner still holding its leases keeps recovery out at the lock, journal untouched', async (t) => {
    const fixture = createActivationFixture();
    t.after(() => fixture.cleanup());
    const owner = await startOwnerAt(fixture, 'SOURCE_APPLIED');
    t.after(() => owner.kill());
    const sequence = readJournal(fixture).sequence;
    injection = { site: 'validateCandidate', when: 'before', message: 'must_not_run', fired: 0 };
    try {
        const gate = createUpdateMaintenanceGate({ projectPath: fixture.root });
        await assert.rejects(gate.recoverOrDeclareManual({ waitMs: 200 }), /update_lock_contended/);
        assert.equal(injection.fired, 0);
        assert.equal(readJournal(fixture).sequence, sequence);
    } finally { injection = null; }
});

test('a live owner whose leases are gone is found alive through the real /proc: no recovery, no injection', async (t) => {
    const fixture = createActivationFixture();
    t.after(() => fixture.cleanup());
    const owner = await startOwnerAt(fixture, 'SOURCE_APPLIED', { releaseLeases: true });
    t.after(() => owner.kill());
    injection = { site: 'validateCandidate', when: 'before', message: 'must_not_run', fired: 0 };
    try {
        const gate = createUpdateMaintenanceGate({ projectPath: fixture.root });
        const status = await gate.recoverOrDeclareManual({ waitMs: 2_000 });
        assert.deepEqual(status, { state: 'UPDATING', recovered: false, ownerAlive: true, phase: 'SOURCE_APPLIED' });
        assert.equal(injection.fired, 0);
        assert.equal(readJournal(fixture).owner.pid, owner.pid);
        // The moment it dies, the same reader proves it dead and recovers.
        await owner.kill();
        assert.equal((await gate.recoverOrDeclareManual({ waitMs: 2_000 })).state, 'OPEN');
    } finally { injection = null; }
});

test('a live pid with another start time is a dead owner (pid reuse), proven through the real /proc', async (t) => {
    const fixture = createActivationFixture();
    t.after(() => fixture.cleanup());
    await killedOwnerAt(fixture, 'SOURCE_APPLIED');
    // Hand the dead owner's record a pid that IS alive now — this test process —
    // keeping the dead owner's start ticks, and re-seal the journal checksum.
    const journal = readJournal(fixture);
    const { checksum: _stale, ...payload } = { ...journal, owner: { ...journal.owner, pid: process.pid } };
    const canonical = (value) => (Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
        : value && typeof value === 'object'
            ? `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
            : JSON.stringify(value));
    fs.writeFileSync(fixture.gate.paths.journal, JSON.stringify({
        ...payload, checksum: crypto.createHash('sha256').update(canonical(payload)).digest('hex'),
    }));
    const gate = createUpdateMaintenanceGate({ projectPath: fixture.root });
    assert.deepEqual(await gate.recoverOrDeclareManual({ waitMs: 2_000 }), { state: 'OPEN', recovered: true, phase: 'ROLLED_BACK' });
    assert.equal(sourceState(fixture).atOriginal, true, 'the production runner rolled the source back for real');
});

test('a degraded reopen after a real crash blocks the next update until doctor completes the source rollback', async (t) => {
    const { fixture, gate } = await crashThenRecover(
        t, 'SOURCE_APPLIED', 'rollbackSourceManifest', 'before', 'Source activation CAS mismatch: shipped.txt',
    );
    assert.equal(gate.readPublicStatus().degraded, 'source_tree_at_target');
    await assert.rejects(gate.beginUpdate({ ...fixture.identity, transactionId: `${fixture.transactionId}-next` }, { waitMs: 200 }),
        /update_source_state_degraded/);
    const applied = await gate.completeSourceRollback({ waitMs: 2_000, dryRun: false });
    assert.equal(applied.applied, true);
    assert.deepEqual(applied.source, { head: fixture.originalHead, treeApplied: 'original' });
    const status = gate.readPublicStatus();
    assert.deepEqual({ degraded: status.degraded, gateClosed: status.gateClosed, transactionId: status.transactionId },
        { degraded: null, gateClosed: false, transactionId: null });
    assert.equal(status.metrics.interventionsRequired, 1, 'the doctor exit is a human intervention');
    const next = await gate.beginUpdate({ ...fixture.identity, transactionId: `${fixture.transactionId}-next` }, { waitMs: 200 });
    next.release();
});
