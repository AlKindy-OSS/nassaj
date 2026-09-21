import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import test from 'node:test';

import { hashTree } from '../../scripts/source-update-candidate.mjs';
import { captureDatabaseSnapshot } from '../../scripts/lib/source-update-database-snapshot.mjs';

import { createUpdateMaintenanceGate } from './update-maintenance-gate.js';

function fixture(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nassaj-maintenance-gate-'));
    execFileSync('git', ['init', '-q'], { cwd: root });
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    return root;
}

function identity(overrides = {}) {
    return {
        transactionId: 'update-transaction-1234', expectedVersion: '1.44.0.2',
        originalHead: 'a'.repeat(40), targetCommit: 'b'.repeat(40), ...overrides,
    };
}

test('writer holds shared activity while releasing admission for other writers', async (t) => {
    const root = fixture(t);
    const gate = createUpdateMaintenanceGate({ projectPath: root });
    const first = await gate.acquireWriterLease({ kind: 'git-write', waitMs: 100 });
    const second = await gate.acquireWriterLease({ kind: 'session-start', waitMs: 100 });
    second.release();
    second.release();
    first.release();
    assert.equal(gate.readPublicStatus().state, 'OPEN');
});

test('updater closes admission and waits fail-closed for an existing writer', async (t) => {
    const root = fixture(t);
    const gate = createUpdateMaintenanceGate({ projectPath: root });
    const writer = await gate.acquireWriterLease({ kind: 'watcher-write', waitMs: 100 });
    await assert.rejects(gate.beginUpdate(identity(), { waitMs: 30 }), /update_lock_contended/);
    assert.equal(gate.readPublicStatus().state, 'OPEN');
    writer.release();
});

test('exclusive update blocks writers and journal transitions use monotonic CAS', async (t) => {
    const root = fixture(t);
    const gate = createUpdateMaintenanceGate({ projectPath: root });
    const update = await gate.beginUpdate(identity(), { waitMs: 100 });
    assert.equal(gate.readPublicStatus().state, 'UPDATING');
    await assert.rejects(gate.acquireWriterLease({ kind: 'git-write', waitMs: 30 }), /update_lock_contended/);
    update.transition(['PREPARED'], 'SOURCE_APPLYING');
    update.transition(['SOURCE_APPLYING'], 'SOURCE_APPLIED');
    update.complete();
    update.release();
    assert.deepEqual(gate.readPublicStatus().state, 'OPEN');
});

test('tampered journal fails closed before granting a writer lease', async (t) => {
    const root = fixture(t);
    const gate = createUpdateMaintenanceGate({ projectPath: root });
    const journal = JSON.parse(fs.readFileSync(gate.paths.journal, 'utf8'));
    fs.writeFileSync(gate.paths.journal, JSON.stringify({ ...journal, gateClosed: true }));
    await assert.rejects(gate.acquireWriterLease({ kind: 'git-write', waitMs: 30 }), /update_journal_invalid/);
});

test('an unexpectedly missing journal never reopens an existing control root', (t) => {
    const root = fixture(t);
    const gate = createUpdateMaintenanceGate({ projectPath: root });
    fs.rmSync(gate.paths.journal);
    assert.throws(() => createUpdateMaintenanceGate({ projectPath: root }), /update_control_state_incomplete/);
});

test('released or journal-shaped ownership context cannot bypass a live owner', async (t) => {
    const root = fixture(t);
    const gate = createUpdateMaintenanceGate({ projectPath: root });
    const update = await gate.beginUpdate(identity(), { waitMs: 100 });
    const context = update.ownershipContext;
    update.release();
    const claimed = await gate.recoverOrDeclareManual({ ownershipContext: context, waitMs: 100 });
    assert.deepEqual(claimed, { state: 'UPDATING', recovered: false, ownerAlive: true, phase: 'PREPARED' });

    const otherRoot = fixture(t);
    const other = createUpdateMaintenanceGate({ projectPath: otherRoot });
    const interrupted = await other.beginUpdate(identity({ transactionId: 'update-transaction-5678' }), { waitMs: 100 });
    interrupted.release();
    const manual = await other.recoverOrDeclareManual({
        ownershipContext: { ...interrupted.ownershipContext, epoch: 'wrong-ownership-epoch' },
        waitMs: 100,
    });
    assert.equal(manual.state, 'UPDATING');
    assert.equal(manual.recovered, false);
    assert.equal(manual.ownerAlive, true);
});

function bootstrapArtifact(root, gate) {
    const applicationPath = path.join(root, 'dist-server', 'server', 'application.js');
    fs.mkdirSync(path.dirname(applicationPath), { recursive: true });
    fs.writeFileSync(applicationPath, 'export const loaded = true;');
    const provenance = { commit: identity().targetCommit, version: identity().expectedVersion, buildId: 'c'.repeat(64) };
    fs.writeFileSync(path.join(root, 'dist-server', 'BUILD_PROVENANCE.json'), JSON.stringify(provenance));
    const manifest = { txId: identity().transactionId, releaseCommit: provenance.commit, version: provenance.version,
        serverBuildId: provenance.buildId, trees: { server: hashTree(path.join(root, 'dist-server')) } };
    const file = path.join(gate.paths.controlRoot, 'candidates', identity().transactionId, 'candidate-manifest.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const bytes = JSON.stringify(manifest);
    fs.writeFileSync(file, bytes, { mode: 0o600 });
    return { applicationPath, manifestSha256: crypto.createHash('sha256').update(bytes).digest('hex') };
}

test('bootstrap claims a handoff using only the canonical 0600 token file', async (t) => {
    const root = fixture(t);
    const previous = process.env.DATABASE_PATH;
    process.env.DATABASE_PATH = path.join(root, 'fixture.sqlite');
    t.after(() => { if (previous === undefined) delete process.env.DATABASE_PATH; else process.env.DATABASE_PATH = previous; });
    execFileSync('/usr/bin/sqlite3', [process.env.DATABASE_PATH, 'CREATE TABLE rows(id INTEGER);']);
    fs.chmodSync(process.env.DATABASE_PATH, 0o600);
    captureDatabaseSnapshot({ databasePath: process.env.DATABASE_PATH, snapshotRoot: path.join(root, 'nassaj-update-db-snapshots'),
        transactionId: identity().transactionId, targetCommit: identity().targetCommit });
    const gate = createUpdateMaintenanceGate({ projectPath: root });
    const artifact = bootstrapArtifact(root, gate);
    const update = await gate.beginUpdate(identity({ manifestSha256: artifact.manifestSha256 }), { waitMs: 100 });
    update.transition(['PREPARED'], 'RESTARTING_HANDOFF');
    const { transactionId, epoch } = update.ownershipContext;
    update.release();
    const bootstrap = await gate.claimBootstrapOwnership({
        transactionId, epoch, applicationPath: artifact.applicationPath, tokenFilePath: gate.paths.token, waitMs: 100,
    });
    const status = await gate.recoverOrDeclareManual({ ownershipContext: bootstrap.ownershipContext });
    assert.deepEqual(status, { state: 'UPDATING', recovered: true, phase: 'BOOTSTRAP_CLAIMED' });
    bootstrap.release();
    await assert.rejects(gate.claimBootstrapOwnership({ transactionId, epoch, tokenFilePath: gate.paths.token, waitMs: 100 }), /claim_rejected/);
});

for (const phase of [
    'SOURCE_APPLYING', 'SOURCE_APPLIED', 'INSTALLING', 'CLIENT_BUILT',
    'SERVER_BUILT', 'VERIFIED', 'ACTIVATION_QUEUED', 'RESTARTING_HANDOFF',
    'BOOTSTRAP_CLAIMED', 'ROLLBACK_PREPARED', 'ROLLBACK_SOURCE_APPLYING',
    'ROLLBACK_SOURCE_APPLIED', 'ROLLBACK_INSTALLING', 'ROLLBACK_CLIENT_BUILT',
    'ROLLBACK_SERVER_BUILT', 'ROLLBACK_VERIFIED',
]) {
    test(`stale ${phase} transaction follows the database recovery boundary`, async (t) => {
        const root = fixture(t);
        const recovered = [];
        const gate = createUpdateMaintenanceGate({
            projectPath: root,
            ownerAlive: () => false,
            recoveryRunner: async (paths, journal) => recovered.push({ paths, journal }),
        });
        const update = await gate.beginUpdate(identity(), { waitMs: 100 });
        update.transition(['PREPARED'], phase);
        update.release();

        const status = await gate.recoverOrDeclareManual({ waitMs: 100 });

        if (['RESTARTING_HANDOFF', 'BOOTSTRAP_CLAIMED'].includes(phase)) {
            assert.deepEqual(status, { state: 'MANUAL', recovered: false, phase });
            assert.equal(recovered.length, 0);
            assert.equal(gate.readPublicStatus().gateClosed, true);
            return;
        }
        assert.deepEqual(status, { state: 'OPEN', recovered: true, phase: 'ROLLED_BACK' });
        assert.equal(recovered.length, 1);
        assert.equal(recovered[0].journal.state, 'RECOVERING');
        assert.equal(recovered[0].journal.phase, phase);
        assert.equal(gate.readPublicStatus().state, 'OPEN');
    });
}

test('unknown owner start time remains fail-closed', async (t) => {
    const root = fixture(t);
    const gate = createUpdateMaintenanceGate({ projectPath: root, ownerAlive: () => null });
    const update = await gate.beginUpdate(identity(), { waitMs: 100 });
    update.release();

    const status = await gate.recoverOrDeclareManual({
        ownershipContext: { transactionId: identity().transactionId, pid: process.pid },
        waitMs: 100,
    });

    assert.equal(status.state, 'MANUAL');
    assert.equal(gate.readPublicStatus().gateClosed, true);
});

/** Run beginUpdate in a REAL child process, stop it at SOURCE_APPLIED, then SIGKILL it. */
async function killedOwner(root) {
    const moduleUrl = new URL('./update-maintenance-gate.js', import.meta.url).href;
    const code = `import { createUpdateMaintenanceGate } from ${JSON.stringify(moduleUrl)};
        const gate = createUpdateMaintenanceGate({ projectPath: ${JSON.stringify(root)} });
        const update = await gate.beginUpdate(${JSON.stringify(identity())}, { waitMs: 5000 });
        update.transition(['PREPARED'], 'SOURCE_APPLIED');
        process.stdout.write('owned\\n');
        setInterval(() => {}, 1000);`;
    const child = spawn(process.execPath, ['--input-type=module', '-e', code], { stdio: ['ignore', 'pipe', 'inherit'] });
    await new Promise((resolve, reject) => {
        child.stdout.on('data', (chunk) => { if (String(chunk).includes('owned')) resolve(); });
        child.once('exit', (status) => reject(new Error(`owner exited early: ${status}`)));
    });
    const exited = new Promise((resolve) => child.once('exit', resolve));
    child.kill('SIGKILL');
    await exited;
    return child.pid;
}

test('an owner that really died is dead, not unknown: recovery rolls back instead of MANUAL (C1)', async (t) => {
    const root = fixture(t);
    const pid = await killedOwner(root);
    const gate = createUpdateMaintenanceGate({ projectPath: root, recoveryRunner: async () => {} });
    const owner = JSON.parse(fs.readFileSync(gate.paths.journal, 'utf8')).owner;
    assert.equal(owner.pid, pid);
    assert.equal(owner.bootId, fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim());
    assert.equal(fs.existsSync(`/proc/${pid}`), false);
    assert.deepEqual(await gate.recoverOrDeclareManual({ waitMs: 1000 }), {
        state: 'OPEN', recovered: true, phase: 'ROLLED_BACK',
    });
    assert.equal(gate.readPublicStatus().gateClosed, false);
});

test('an owner recorded in another boot is dead even when its pid is alive now (C1)', async (t) => {
    const root = fixture(t);
    const gate = createUpdateMaintenanceGate({ projectPath: root, recoveryRunner: async () => {} });
    const update = await gate.beginUpdate(identity(), { waitMs: 100 });
    update.transition(['PREPARED'], 'SOURCE_APPLIED');
    update.release();
    // Same live pid and start time, but a boot id from before a reboot.
    const journal = JSON.parse(fs.readFileSync(gate.paths.journal, 'utf8'));
    const { checksum: _old, ...payload } = { ...journal, owner: { ...journal.owner, bootId: 'an-earlier-boot' } };
    const canonical = (value) => (Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
        : value && typeof value === 'object'
            ? `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
            : JSON.stringify(value));
    fs.writeFileSync(gate.paths.journal, JSON.stringify({
        ...payload, checksum: crypto.createHash('sha256').update(canonical(payload)).digest('hex'),
    }));
    assert.equal((await gate.recoverOrDeclareManual({ waitMs: 100 })).state, 'OPEN');
});

test('control token must remain a regular owner-only file', (t) => {
    const root = fixture(t);
    const gate = createUpdateMaintenanceGate({ projectPath: root });
    fs.chmodSync(gate.paths.token, 0o644);
    assert.throws(() => createUpdateMaintenanceGate({ projectPath: root }), /update_ownership_token_unsafe/);

    fs.rmSync(gate.paths.token);
    const target = path.join(root, 'token-target');
    fs.writeFileSync(target, 'not-a-valid-control-token', { mode: 0o600 });
    fs.symlinkSync(target, gate.paths.token);
    assert.throws(() => createUpdateMaintenanceGate({ projectPath: root }), /update_ownership_token_unsafe/);
});

test('failed automatic rollback remains fail-closed for manual recovery', async (t) => {
    const root = fixture(t);
    const gate = createUpdateMaintenanceGate({
        projectPath: root,
        ownerAlive: () => false,
        recoveryRunner: async () => { throw new Error('injected_rollback_failure'); },
    });
    const update = await gate.beginUpdate(identity(), { waitMs: 100 });
    update.transition(['PREPARED'], 'SOURCE_APPLYING');
    update.release();

    const status = await gate.recoverOrDeclareManual({ waitMs: 100 });

    assert.equal(status.state, 'MANUAL');
    assert.equal(status.recovered, false);
    assert.equal(gate.readPublicStatus().gateClosed, true);
});

test('a crash after entering RECOVERING resumes the same idempotent rollback', async (t) => {
    const root = fixture(t);
    const first = createUpdateMaintenanceGate({
        projectPath: root,
        ownerAlive: () => false,
        afterRecoveryStart: () => { throw new Error('injected_recovery_crash'); },
    });
    const update = await first.beginUpdate(identity(), { waitMs: 100 });
    update.transition(['PREPARED'], 'SERVER_BUILT');
    update.release();
    await assert.rejects(first.recoverOrDeclareManual({ waitMs: 100 }), /injected_recovery_crash/);
    assert.equal(first.readPublicStatus().state, 'RECOVERING');

    let calls = 0;
    const resumed = createUpdateMaintenanceGate({
        projectPath: root,
        ownerAlive: () => false,
        recoveryRunner: async () => { calls += 1; },
    });
    assert.deepEqual(await resumed.recoverOrDeclareManual({ waitMs: 100 }), {
        state: 'OPEN', recovered: true, phase: 'ROLLED_BACK',
    });
    assert.equal(calls, 1);
});

test('missing baseline descriptor makes first bootstrap claim MANUAL and leaves admission closed', async t => {
    const root = fixture(t);
    const previous = process.env.DATABASE_PATH;
    process.env.DATABASE_PATH = path.join(root, 'missing.sqlite');
    t.after(() => { if (previous === undefined) delete process.env.DATABASE_PATH; else process.env.DATABASE_PATH = previous; });
    const gate = createUpdateMaintenanceGate({ projectPath: root });
    const artifact = bootstrapArtifact(root, gate);
    const update = await gate.beginUpdate(identity({ manifestSha256: artifact.manifestSha256 }), { waitMs: 100 });
    update.transition(['PREPARED'], 'ACTIVATION_QUEUED');
    const { descriptor } = update.prepareBootstrapHandoff();
    update.release();
    await assert.rejects(gate.claimBootstrapOwnership({ ...descriptor, applicationPath: artifact.applicationPath, waitMs: 100 }));
    assert.equal(gate.readPublicStatus().state, 'MANUAL');
    assert.equal(gate.readPublicStatus().gateClosed, true);
    await assert.rejects(gate.acquireWriterLease({ kind: 'git-write', waitMs: 100 }), /maintenance_active/);
});

for (const mismatch of ['content', 'path', 'manifest']) {
    test(`bootstrap rejects ${mismatch} mismatch before importing any application code`, async t => {
        const root = fixture(t);
        const gate = createUpdateMaintenanceGate({ projectPath: root });
        const artifact = bootstrapArtifact(root, gate);
        const update = await gate.beginUpdate(identity({ manifestSha256: artifact.manifestSha256 }), { waitMs: 100 });
        update.transition(['PREPARED'], 'ACTIVATION_QUEUED');
        const { descriptor } = update.prepareBootstrapHandoff();
        update.release();
        if (mismatch === 'content') fs.appendFileSync(artifact.applicationPath, '\nexport const unexpected = true;');
        if (mismatch === 'manifest') artifact.manifestSha256 = '0'.repeat(64);
        if (mismatch === 'manifest') fs.appendFileSync(path.join(gate.paths.controlRoot, 'candidates', identity().transactionId, 'candidate-manifest.json'), ' ');
        const applicationPath = mismatch === 'path' ? path.join(root, 'server', 'index.js') : artifact.applicationPath;
        let imported = false;
        await assert.rejects((async () => {
            await gate.claimBootstrapOwnership({ ...descriptor, applicationPath, waitMs: 100 });
            imported = true;
        })(), /update_bootstrap/);
        assert.equal(imported, false);
        assert.equal(gate.readPublicStatus().state, 'MANUAL');
        assert.equal(gate.readPublicStatus().gateClosed, true);
    });
}

test('recovery evidence reader never initializes missing control files and rejects tampering', async (t) => {
    const { readUpdateMaintenanceRecoveryEvidence } = await import('./update-maintenance-gate.js');
    const root = fixture(t), controlRoot = path.join(root, '.git', 'nassaj-source-update');
    assert.throws(() => readUpdateMaintenanceRecoveryEvidence({ projectPath: root }), /ENOENT/);
    assert.equal(fs.existsSync(controlRoot), false, 'observation must not manufacture OPEN');
    const gate = createUpdateMaintenanceGate({ projectPath: root });
    const { controlRoot: observedRoot, ...evidence } = readUpdateMaintenanceRecoveryEvidence({ projectPath: root });
    assert.equal(observedRoot, gate.paths.controlRoot);
    assert.deepEqual(evidence, gate.readRecoveryEvidence());
    fs.unlinkSync(gate.paths.journal);
    const namesBefore = fs.readdirSync(controlRoot).sort();
    assert.throws(() => readUpdateMaintenanceRecoveryEvidence({ projectPath: root }), /ENOENT/);
    assert.deepEqual(fs.readdirSync(controlRoot).sort(), namesBefore);
    fs.writeFileSync(gate.paths.journal, JSON.stringify({ state: 'OPEN', gateClosed: false }), { mode: 0o600 });
    assert.throws(() => readUpdateMaintenanceRecoveryEvidence({ projectPath: root }), /update_journal_invalid/);
});

for (const mutation of ['control-mode', 'control-symlink', 'token-mode', 'token-symlink', 'token-hardlink', 'token-mismatch', 'journal-mode', 'journal-symlink']) {
    test(`read-only recovery evidence rejects ${mutation} without repair`, async (t) => {
        const { readUpdateMaintenanceRecoveryEvidence } = await import('./update-maintenance-gate.js');
        const root = fixture(t), gate = createUpdateMaintenanceGate({ projectPath: root });
        const file = mutation.startsWith('token') ? gate.paths.token : gate.paths.journal;
        if (mutation === 'control-mode') fs.chmodSync(gate.paths.controlRoot, 0o755);
        else if (mutation === 'control-symlink') {
            fs.renameSync(gate.paths.controlRoot, `${gate.paths.controlRoot}-retained`);
            fs.symlinkSync(`${gate.paths.controlRoot}-retained`, gate.paths.controlRoot);
        } else if (mutation.endsWith('-mode')) fs.chmodSync(file, 0o644);
        else if (mutation.endsWith('-symlink')) { fs.renameSync(file, `${file}-retained`); fs.symlinkSync(`${file}-retained`, file); }
        else if (mutation === 'token-hardlink') fs.linkSync(file, `${file}-alias`);
        else fs.writeFileSync(file, crypto.randomBytes(32).toString('base64url'));
        const before = fs.lstatSync(mutation.startsWith('control') ? gate.paths.controlRoot : file);
        assert.throws(() => readUpdateMaintenanceRecoveryEvidence({ projectPath: root }), /unsafe|ELOOP|mismatch/);
        const after = fs.lstatSync(mutation.startsWith('control') ? gate.paths.controlRoot : file);
        assert.equal(after.ino, before.ino); assert.equal(after.mode, before.mode);
    });
}
