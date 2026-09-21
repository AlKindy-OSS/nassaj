/**
 * ADR-156 ب.5 / WI-12 (T-1727) — `reopenOnPreviousGeneration`.
 *
 * The injection these tests exist for: `validateCandidate` THROWS while the
 * activation receipt is intact. That is B-1054's shape, and the whole point of
 * م-2 is that the exit path must survive it — `readReceipt(validation)` needs
 * the validation object whose throw brought us here, so this path reads the
 * receipt itself, under its own integrity rules.
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import test from 'node:test';

import { hashTree } from '../../scripts/lib/source-update-tree-identity.mjs';

import { createUpdateMaintenanceGate } from './update-maintenance-gate.js';

const GENERATIONS = { client: 'dist', server: 'dist-server', nodeModules: 'node_modules' };
const TRANSACTION = 'update-transaction-1234';

/** A git repository with two commits and the three live generation trees. */
function fixture(t, { sourceAt = 'target' } = {}) {
    const root = fs.mkdtempSync(path.join(process.env.TMPDIR || '/var/tmp', 'nassaj-gate-reopen-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 'test@example.invalid');
    git('config', 'user.name', 'test');
    fs.writeFileSync(path.join(root, 'shipped.txt'), 'original\n');
    git('add', 'shipped.txt');
    git('commit', '-q', '-m', 'original');
    const originalHead = git('rev-parse', 'HEAD');
    fs.writeFileSync(path.join(root, 'shipped.txt'), 'target\n');
    git('add', 'shipped.txt');
    git('commit', '-q', '-m', 'target');
    const targetCommit = git('rev-parse', 'HEAD');
    if (sourceAt === 'original') {
        git('reset', '-q', '--hard', originalHead);
    } else if (sourceAt === 'mixed') {
        fs.writeFileSync(path.join(root, 'shipped.txt'), 'original\n');
    }
    for (const directory of Object.values(GENERATIONS)) {
        fs.mkdirSync(path.join(root, directory), { recursive: true });
        fs.writeFileSync(path.join(root, directory, 'marker'), `live-${directory}\n`);
    }
    return { root, originalHead, targetCommit };
}

/** Seal a candidate whose receipt says the live trees ARE the previous ones. */
function sealCandidate(gate, repository, { mode = 0o600, steps = null, live = true, receipt = true } = {}) {
    const candidateRoot = path.join(gate.paths.controlRoot, 'candidates', TRANSACTION);
    fs.mkdirSync(candidateRoot, { recursive: true, mode: 0o700 });
    const trees = Object.fromEntries(Object.keys(GENERATIONS).map((name) => [name, { sha256: `${name}-target`, files: 1 }]));
    const manifest = { schemaVersion: 1, txId: TRANSACTION, releaseCommit: repository.targetCommit, trees };
    const manifestBytes = `${JSON.stringify(manifest, null, 2)}\n`;
    fs.writeFileSync(path.join(candidateRoot, 'candidate-manifest.json'), manifestBytes, { mode: 0o600 });
    fs.chmodSync(path.join(candidateRoot, 'candidate-manifest.json'), 0o600);
    const recorded = steps ?? Object.fromEntries(Object.keys(GENERATIONS).map((name) => [
        name, { state: 'exchanged', previous: live ? hashTree(path.join(repository.root, GENERATIONS[name])) : { sha256: 'other', files: 9 } },
    ]));
    const receiptPath = path.join(candidateRoot, 'activation-receipt.json');
    if (receipt) {
        fs.writeFileSync(receiptPath, `${JSON.stringify({ schemaVersion: 1, txId: TRANSACTION, state: 'activating', steps: recorded }, null, 2)}\n`, { mode });
        fs.chmodSync(receiptPath, mode);
    }
    return {
        receiptPath,
        manifestSha256: crypto.createHash('sha256').update(manifestBytes).digest('hex'),
    };
}

function identity(repository, manifestSha256) {
    return {
        transactionId: TRANSACTION, expectedVersion: '1.47.0.11',
        originalHead: repository.originalHead, targetCommit: repository.targetCommit, manifestSha256,
    };
}

/** Drive the gate to the exact point where automatic rollback throws. */
async function crashedUpdate(t, options = {}) {
    const repository = fixture(t, options);
    const gate = createUpdateMaintenanceGate({
        projectPath: repository.root,
        ownerAlive: () => false,
        // The injection: this is what `validateCandidate` does in B-1054.
        recoveryRunner: async () => { throw new Error('Activation manifest digest mismatch.'); },
    });
    const sealed = sealCandidate(gate, repository, options);
    const update = await gate.beginUpdate(identity(repository, sealed.manifestSha256), { waitMs: 100 });
    update.transition(['PREPARED'], 'SOURCE_APPLIED');
    update.release();
    return { repository, gate, sealed };
}

test('a throwing validateCandidate no longer ends in MANUAL when the receipt proves the previous generation', async (t) => {
    const { gate } = await crashedUpdate(t);
    const status = await gate.recoverOrDeclareManual({ waitMs: 100 });
    assert.equal(status.state, 'OPEN');
    assert.equal(status.recovered, true);
    assert.equal(status.phase, 'REOPENED_PREVIOUS_DEGRADED');
    const published = gate.readPublicStatus();
    assert.equal(published.gateClosed, false);
    assert.equal(published.degraded, 'source_tree_at_target');
    assert.equal(published.exitPath, 'complete_source_rollback_or_pin_release_ref');
});

test('a degraded reopen is never silent: it blocks the next update until the source is reconciled', async (t) => {
    const { gate, repository, sealed } = await crashedUpdate(t);
    await gate.recoverOrDeclareManual({ waitMs: 100 });
    await assert.rejects(
        gate.beginUpdate(identity(repository, sealed.manifestSha256), { waitMs: 100 }),
        /update_source_state_degraded/,
    );
});

test('the observed source state is recorded in the receipt itself', async (t) => {
    const { gate, sealed, repository } = await crashedUpdate(t);
    await gate.recoverOrDeclareManual({ waitMs: 100 });
    const receipt = JSON.parse(fs.readFileSync(sealed.receiptPath, 'utf8'));
    assert.deepEqual(receipt.source, { head: repository.targetCommit, treeApplied: 'target' });
    assert.equal(fs.lstatSync(sealed.receiptPath).mode & 0o777, 0o600);
});

test('a fully rolled back source reopens OPEN with no degraded marker at all', async (t) => {
    const { gate } = await crashedUpdate(t, { sourceAt: 'original' });
    const status = await gate.recoverOrDeclareManual({ waitMs: 100 });
    assert.equal(status.phase, 'REOPENED_PREVIOUS');
    assert.equal(status.degraded, null);
    const published = gate.readPublicStatus();
    assert.equal(published.degraded, null);
    assert.equal(published.transactionId, null);
});

test('a half-applied source tree has no defined exit path and stays MANUAL', async (t) => {
    const { gate } = await crashedUpdate(t, { sourceAt: 'mixed' });
    const status = await gate.recoverOrDeclareManual({ waitMs: 100 });
    assert.equal(status.state, 'MANUAL');
    assert.equal(gate.readPublicStatus().gateClosed, true);
});

test('a receipt at 0644 is refused, so a weakened file cannot reopen the gate', async (t) => {
    const { gate } = await crashedUpdate(t, { mode: 0o644 });
    const status = await gate.recoverOrDeclareManual({ waitMs: 100 });
    assert.equal(status.state, 'MANUAL');
    assert.equal(gate.readPublicStatus().gateClosed, true);
});

test('a live generation that does not match the recorded previous digest stays MANUAL', async (t) => {
    const { gate } = await crashedUpdate(t, { live: false });
    const status = await gate.recoverOrDeclareManual({ waitMs: 100 });
    assert.equal(status.state, 'MANUAL');
    assert.equal(gate.readPublicStatus().gateClosed, true);
});

test('an exchange that outran its receipt is not mistaken for an untouched generation', async (t) => {
    const repository = fixture(t);
    const gate = createUpdateMaintenanceGate({
        projectPath: repository.root,
        ownerAlive: () => false,
        recoveryRunner: async () => { throw new Error('Activation manifest digest mismatch.'); },
    });
    // No step for `client`, yet dist/ already equals the manifest's target tree.
    const candidateRoot = path.join(gate.paths.controlRoot, 'candidates', TRANSACTION);
    const sealed = sealCandidate(gate, repository, { steps: {
        server: { state: 'exchanged', previous: hashTree(path.join(repository.root, 'dist-server')) },
        nodeModules: { state: 'exchanged', previous: hashTree(path.join(repository.root, 'node_modules')) },
    } });
    const manifest = JSON.parse(fs.readFileSync(path.join(candidateRoot, 'candidate-manifest.json'), 'utf8'));
    manifest.trees.client = hashTree(path.join(repository.root, 'dist'));
    const bytes = `${JSON.stringify(manifest, null, 2)}\n`;
    fs.writeFileSync(path.join(candidateRoot, 'candidate-manifest.json'), bytes, { mode: 0o600 });
    const update = await gate.beginUpdate(
        identity(repository, crypto.createHash('sha256').update(bytes).digest('hex')), { waitMs: 100 },
    );
    update.transition(['PREPARED'], 'SOURCE_APPLIED');
    update.release();
    assert.equal((await gate.recoverOrDeclareManual({ waitMs: 100 })).state, 'MANUAL');
    assert.ok(sealed.receiptPath);
});

test('a missing receipt with untouched generations reopens on the source state alone (H2)', async (t) => {
    const { gate, sealed, repository } = await crashedUpdate(t, { receipt: false, sourceAt: 'original' });
    const status = await gate.recoverOrDeclareManual({ waitMs: 100 });
    assert.equal(status.phase, 'REOPENED_PREVIOUS');
    assert.equal(gate.readPublicStatus().gateClosed, false);
    assert.equal(fs.existsSync(sealed.receiptPath), false, 'no receipt is invented for an exchange that never ran');
    const journal = JSON.parse(fs.readFileSync(gate.paths.journal, 'utf8'));
    assert.deepEqual(journal.sourceState, { head: repository.originalHead, treeApplied: 'original' });
});

test('a missing receipt with the source at target reopens degraded, never silently (H2)', async (t) => {
    const { gate } = await crashedUpdate(t, { receipt: false });
    const status = await gate.recoverOrDeclareManual({ waitMs: 100 });
    assert.equal(status.phase, 'REOPENED_PREVIOUS_DEGRADED');
    assert.equal(gate.readPublicStatus().degraded, 'source_tree_at_target');
});

test('a missing receipt is not proof when a live generation already equals its target (H2)', async (t) => {
    const repository = fixture(t, { sourceAt: 'original' });
    const gate = createUpdateMaintenanceGate({
        projectPath: repository.root, ownerAlive: () => false,
        recoveryRunner: async () => { throw new Error('Activation manifest digest mismatch.'); },
    });
    const candidateRoot = path.join(gate.paths.controlRoot, 'candidates', TRANSACTION);
    sealCandidate(gate, repository, { receipt: false });
    const manifest = JSON.parse(fs.readFileSync(path.join(candidateRoot, 'candidate-manifest.json'), 'utf8'));
    manifest.trees.server = hashTree(path.join(repository.root, 'dist-server'));
    const bytes = `${JSON.stringify(manifest, null, 2)}\n`;
    fs.writeFileSync(path.join(candidateRoot, 'candidate-manifest.json'), bytes, { mode: 0o600 });
    const update = await gate.beginUpdate(
        identity(repository, crypto.createHash('sha256').update(bytes).digest('hex')), { waitMs: 100 },
    );
    update.transition(['PREPARED'], 'SOURCE_APPLIED');
    update.release();
    assert.equal((await gate.recoverOrDeclareManual({ waitMs: 100 })).state, 'MANUAL');
    assert.equal(JSON.parse(fs.readFileSync(gate.paths.journal, 'utf8')).reopenRefusedReason,
        'update_reopen_generation_unrecorded_server');
});

/** An in-process update whose own rollback just failed, still holding its leases. */
async function failedInProcessRollback(t, options = {}) {
    const repository = fixture(t, options);
    const gate = createUpdateMaintenanceGate({ projectPath: repository.root });
    const sealed = sealCandidate(gate, repository);
    const update = await gate.beginUpdate(identity(repository, sealed.manifestSha256), { waitMs: 100 });
    update.transition(['PREPARED'], 'ROLLBACK_SOURCE_APPLIED');
    return { gate, update };
}

test('a failed in-process rollback reopens without leaving a live owner on a closed gate (H1)', async (t) => {
    const { gate, update } = await failedInProcessRollback(t);
    const outcome = update.reopenOrDeclareManual(new Error('Source activation CAS mismatch: shipped.txt'));
    assert.deepEqual(outcome, { state: 'OPEN', degraded: 'source_tree_at_target', reason: null });
    assert.equal(JSON.parse(fs.readFileSync(gate.paths.journal, 'utf8')).owner, null);
    assert.equal(gate.readPublicStatus().gateClosed, false);
    // The leases went with it: a writer is admitted at once, no restart needed.
    const writer = await gate.acquireWriterLease({ kind: 'git-write', waitMs: 100 });
    writer.release();
});

test('an in-process rollback with no exit path is MANUAL with no owner recorded (H1)', async (t) => {
    const { gate, update } = await failedInProcessRollback(t, { sourceAt: 'mixed' });
    const outcome = update.reopenOrDeclareManual(new Error('Source activation CAS mismatch: shipped.txt'));
    assert.deepEqual(outcome, { state: 'MANUAL', degraded: null, reason: 'update_reopen_source_tree_mixed' });
    const journal = JSON.parse(fs.readFileSync(gate.paths.journal, 'utf8'));
    assert.equal(journal.owner, null, 'the next boot must not mistake this process for a live owner');
    assert.equal(journal.gateClosed, true);
    assert.throws(() => update.reopenOrDeclareManual(new Error('again')), /update_ownership_released/);
});

test('completing the source rollback refuses a CAS conflict before any write (H3)', async (t) => {
    const { gate, repository } = await crashedUpdate(t);
    await gate.recoverOrDeclareManual({ waitMs: 100 });
    assert.equal(gate.readPublicStatus().degraded, 'source_tree_at_target');
    fs.writeFileSync(path.join(repository.root, 'shipped.txt'), 'operator edit\n');
    const sequence = JSON.parse(fs.readFileSync(gate.paths.journal, 'utf8')).sequence;
    const refused = await gate.completeSourceRollback({ waitMs: 100, dryRun: false });
    assert.equal(refused.applied, false);
    assert.match(refused.reason, /CAS mismatch: shipped\.txt/);
    assert.equal(JSON.parse(fs.readFileSync(gate.paths.journal, 'utf8')).sequence, sequence, 'the journal is untouched');
    assert.equal(fs.readFileSync(path.join(repository.root, 'shipped.txt'), 'utf8'), 'operator edit\n');
    assert.equal(gate.readPublicStatus().degraded, 'source_tree_at_target', 'still degraded, still blocking the next update');
});

test('completing the source rollback clears degraded and reopens fully (H3)', async (t) => {
    const { gate, repository } = await crashedUpdate(t);
    await gate.recoverOrDeclareManual({ waitMs: 100 });
    const planned = await gate.completeSourceRollback({ waitMs: 100 });
    assert.equal(planned.reason, 'dry_run');
    assert.equal(planned.paths, 1);
    const applied = await gate.completeSourceRollback({ waitMs: 100, dryRun: false });
    assert.equal(applied.applied, true);
    assert.deepEqual(applied.source, { head: repository.originalHead, treeApplied: 'original' });
    const status = gate.readPublicStatus();
    assert.equal(status.degraded, null);
    assert.equal(status.transactionId, null);
    // The block is gone: the next update may begin again.
    const next = await gate.beginUpdate(identity(repository, 'e'.repeat(64)), { waitMs: 100 });
    next.release();
});

test('the standalone operation prints a plan and writes nothing unless dryRun is false', async (t) => {
    const { gate } = await crashedUpdate(t, { sourceAt: 'original' });
    const gated = createUpdateMaintenanceGate({ projectPath: gate.paths.root, ownerAlive: () => false });
    const sequence = JSON.parse(fs.readFileSync(gate.paths.journal, 'utf8')).sequence;
    const planned = await gated.reopenOnPreviousGeneration({ waitMs: 100 });
    assert.equal(planned.applied, false);
    assert.equal(planned.reason, 'dry_run');
    assert.deepEqual(planned.to, { state: 'OPEN', gateClosed: false, phase: null, degraded: null, exitPath: null });
    assert.equal(JSON.parse(fs.readFileSync(gate.paths.journal, 'utf8')).sequence, sequence);

    const applied = await gated.reopenOnPreviousGeneration({ waitMs: 100, dryRun: false });
    assert.equal(applied.applied, true);
    assert.equal(gated.readPublicStatus().gateClosed, false);
});

test('re-running the operation after the source is reconciled clears the degraded marker', async (t) => {
    const { gate, repository } = await crashedUpdate(t);
    await gate.recoverOrDeclareManual({ waitMs: 100 });
    assert.equal(gate.readPublicStatus().degraded, 'source_tree_at_target');
    execFileSync('git', ['reset', '-q', '--hard', repository.originalHead], { cwd: repository.root });
    const applied = await gate.reopenOnPreviousGeneration({ waitMs: 100, dryRun: false });
    assert.equal(applied.applied, true);
    assert.equal(gate.readPublicStatus().degraded, null);
});

test('downtime, interventions and reachedManual are measured where they happen (ت-3)', async (t) => {
    let clock = 1_000;
    const repository = fixture(t, { sourceAt: 'original' });
    const gate = createUpdateMaintenanceGate({
        projectPath: repository.root,
        ownerAlive: () => false,
        now: () => clock,
        recoveryRunner: async () => { throw new Error('Activation manifest digest mismatch.'); },
    });
    const sealed = sealCandidate(gate, repository);
    const update = await gate.beginUpdate(identity(repository, sealed.manifestSha256), { waitMs: 100 });
    update.transition(['PREPARED'], 'SOURCE_APPLIED');
    update.release();
    clock = 6_500;
    await gate.recoverOrDeclareManual({ waitMs: 100 });
    const { metrics } = gate.readPublicStatus();
    assert.equal(metrics.downtimeMs, 5_500);
    // M3: the gate reopened ITSELF. That is an automatic repair, not a person.
    assert.equal(metrics.interventionsRequired, 0);
    assert.equal(metrics.automaticRepairs, 1);
    assert.equal(metrics.intervention, 'automatic');
    assert.equal(metrics.reachedManual, false);
    assert.equal(Object.hasOwn(JSON.parse(fs.readFileSync(gate.paths.journal, 'utf8')), 'intervention'), false,
        'the per-transition actor is never persisted as journal state');
});

test('a human reopen after MANUAL counts as a human intervention, and only once (M3)', async (t) => {
    const { gate } = await crashedUpdate(t, { mode: 0o644, sourceAt: 'original' });
    assert.equal((await gate.recoverOrDeclareManual({ waitMs: 100 })).state, 'MANUAL');
    const candidateRoot = path.join(gate.paths.controlRoot, 'candidates', TRANSACTION);
    fs.chmodSync(path.join(candidateRoot, 'activation-receipt.json'), 0o600);
    const applied = await gate.reopenOnPreviousGeneration({ waitMs: 100, dryRun: false });
    assert.equal(applied.applied, true);
    const { metrics } = gate.readPublicStatus();
    assert.deepEqual(
        { human: metrics.interventionsRequired, automatic: metrics.automaticRepairs, intervention: metrics.intervention, manual: metrics.reachedManual },
        { human: 1, automatic: 0, intervention: 'human', manual: true },
    );
});
