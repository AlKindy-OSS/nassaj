/**
 * ADR-216 §3.2 — acquireExclusiveSourceRefLease: admission EXCLUSIVE then
 * activity EXCLUSIVE, short waits, refusals for a busy gate, a non-OPEN,
 * closed or degraded journal, an oid-pair maintenance (t3), and the journal
 * creation side effect on a never-updated node (t4).
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { SOURCE_REF_LEASE, createUpdateMaintenanceGate, flockAsync, requireSourceRefGitDir } from './update-maintenance-gate.js';

function fixture(t) {
    const root = fs.mkdtempSync(path.join(process.env.TMPDIR || '/var/tmp', 'nassaj-source-ref-lease-'));
    execFileSync('git', ['init', '-q'], { cwd: root });
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    return root;
}

/** The gate's canonical checksum, so a test can stage a journal the gate accepts. */
function canonical(value) {
    if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
    if (value && typeof value === 'object') {
        return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
    }
    return JSON.stringify(value);
}

function rewriteJournal(gate, patch) {
    const { checksum: _old, ...current } = JSON.parse(fs.readFileSync(gate.paths.journal, 'utf8'));
    const next = { ...current, ...patch };
    next.checksum = crypto.createHash('sha256').update(canonical(next)).digest('hex');
    fs.writeFileSync(gate.paths.journal, `${JSON.stringify(next)}\n`, { mode: 0o600 });
}

test('t4: the first lease on a never-updated node creates token + journal (OPEN, sequence 0) inside .git', async (t) => {
    const root = fixture(t);
    const gate = createUpdateMaintenanceGate({ projectPath: root });
    const lease = await gate.acquireExclusiveSourceRefLease();
    assert.equal(lease.kind, 'source-attach');
    assert.equal(lease.journalSequence, 0);
    assert.equal(lease[SOURCE_REF_LEASE], true);
    assert.equal(lease.held, true);
    assert.equal(lease.commonGitDir, fs.realpathSync(path.join(root, '.git')));
    assert.ok(fs.existsSync(path.join(root, '.git', 'nassaj-source-update', 'token')));
    assert.equal(JSON.parse(fs.readFileSync(gate.paths.journal, 'utf8')).state, 'OPEN');
    lease.release();
    lease.release();
    assert.equal(lease.held, false);
    // Released: an ordinary writer and a second lease are admitted again.
    (await gate.acquireWriterLease({ kind: 'source-update-stage', waitMs: 500 })).release();
    (await gate.acquireExclusiveSourceRefLease()).release();
});

test('a held lease excludes writers and a second lease; a held writer refuses the lease as writers_active', async (t) => {
    const root = fixture(t);
    const gate = createUpdateMaintenanceGate({ projectPath: root });
    const lease = await gate.acquireExclusiveSourceRefLease();
    await assert.rejects(gate.acquireWriterLease({ kind: 'source-update-stage', waitMs: 200 }), { message: 'update_lock_contended' });
    await assert.rejects(gate.acquireExclusiveSourceRefLease({ waitMs: 200 }), { message: 'update_maintenance_active' });
    lease.release();
    const writer = await gate.acquireWriterLease({ kind: 'source-update-stage', waitMs: 500 });
    const started = Date.now();
    await assert.rejects(gate.acquireExclusiveSourceRefLease(), { message: 'source_attach_writers_active' });
    assert.ok(Date.now() - started < 2500);
    writer.release();
    assert.equal(JSON.parse(fs.readFileSync(gate.paths.journal, 'utf8')).sequence, 0, 'no journal write');
});

test('a non-OPEN, closed or degraded journal is refused update_maintenance_active', async (t) => {
    for (const patch of [{ state: 'MANUAL', gateClosed: true }, { gateClosed: true }, { degraded: 'source_tree_at_target' }]) {
        const root = fixture(t);
        const gate = createUpdateMaintenanceGate({ projectPath: root });
        rewriteJournal(gate, patch);
        await assert.rejects(gate.acquireExclusiveSourceRefLease(), { message: 'update_maintenance_active' }, JSON.stringify(patch));
        // Nothing was left locked by the refusal: both locks are free for an exclusive holder.
        for (const lock of [gate.paths.admissionLock, gate.paths.activityLock]) (await flockAsync(lock, 'exclusive', { waitMs: 200 })).release();
    }
});

test('t3: an oid-pair maintenance is refused even while the journal reads OPEN', async (t) => {
    const root = fixture(t);
    const gate = createUpdateMaintenanceGate({ projectPath: root });
    rewriteJournal(gate, { identity: { kind: 'oid-pair', oid: { targetDigest: 'a'.repeat(64), transactionNonce: 'b'.repeat(64) } } });
    await assert.rejects(gate.acquireExclusiveSourceRefLease(), { message: 'update_maintenance_active' });
});

test('an invalid kind is refused before any lock is taken', async (t) => {
    const gate = createUpdateMaintenanceGate({ projectPath: fixture(t) });
    await assert.rejects(gate.acquireExclusiveSourceRefLease({ kind: 'Bad Kind' }), { message: 'update_writer_kind_invalid' });
});

test('t3/M6: a node with no git common dir (artifact layout) is refused unsupported_install_mode', () => {
    assert.throws(() => requireSourceRefGitDir({ commonGitDir: null }), { message: 'unsupported_install_mode' });
    assert.throws(() => requireSourceRefGitDir(null), { message: 'unsupported_install_mode' });
    assert.equal(requireSourceRefGitDir({ commonGitDir: '/x/.git' }), '/x/.git');
});
