#!/usr/bin/env node
import assert from 'node:assert/strict';
import {
    cpSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    renameSync,
    rmSync,
    symlinkSync,
    writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import test from 'node:test';

import { advancePreview, materializePreviewSnapshot, requestPreview } from './preview-oid-pipeline.mjs';
import { activateOidCandidate, rollbackOidCandidate } from './preview-oid-activate.mjs';
import { enqueuePreviewEvent } from './preview-oid-consumer.mjs';
import { readPreviewLedger } from './local-preview-ledger.mjs';

function git(root, ...args) {
    return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
}

function provenance(buildId, oid, version = '1.2.3.4') {
    return {
        artifact: 'server', version, commit: oid, baseCommit: oid,
        commitShort: oid.slice(0, 8), branch: null, describe: oid.slice(0, 12),
        dirty: false, dirtyFiles: 0, builtAt: new Date().toISOString(), buildId,
    };
}

async function fixture({ eventSequence = null } = {}) {
    const root = mkdtempSync('/var/tmp/preview-activate-');
    git(root, 'init', '-q');
    git(root, 'config', 'user.name', 'Activation Test');
    git(root, 'config', 'user.email', 'activation@example.invalid');
    mkdirSync(path.join(root, 'scripts'));
    writeFileSync(path.join(root, 'package.json'), JSON.stringify({ version: '1.2.3.4' }));
    writeFileSync(path.join(root, 'scripts', 'server-build-atomic.mjs'), 'export function verifyServerArtefact() {}\n');
    git(root, 'add', '.');
    git(root, 'commit', '-qm', 'snapshot');
    const oid = git(root, 'rev-parse', 'HEAD');
    await materializePreviewSnapshot(root, oid);
    const group = eventSequence === null
        ? 'activation-test' : `event-${String(eventSequence).padStart(16, '0')}`;
    if (eventSequence === null) requestPreview(root, { group, oid, domains: ['server'] });
    else enqueuePreviewEvent(root, { sequence: eventSequence, oid, domains: ['server'] });
    advancePreview(root, { group, domain: 'server', state: 'candidate', oid });
    const buildId = 'a'.repeat(64);
    const previousBuildId = 'b'.repeat(64);
    const candidate = path.join(root, '.nassaj-local-preview', 'server-candidates', buildId);
    const live = path.join(root, 'dist-server');
    mkdirSync(candidate, { recursive: true });
    mkdirSync(live);
    writeFileSync(path.join(candidate, 'BUILD_PROVENANCE.json'), JSON.stringify(provenance(buildId, oid)));
    writeFileSync(path.join(candidate, 'marker'), 'new');
    writeFileSync(path.join(live, 'BUILD_PROVENANCE.json'), JSON.stringify({ ...provenance(previousBuildId, oid), commit: 'c'.repeat(40), baseCommit: 'c'.repeat(40) }));
    writeFileSync(path.join(live, 'marker'), 'old');
    const contract = { verifyServerArtefact: (directory) => assert.equal(readFileSync(path.join(directory, 'marker'), 'utf8'), 'new') };
    return { root, oid, group, buildId, previousBuildId, candidate, live, contract };
}

function cleanup(root) {
    execFileSync('chmod', ['-R', 'u+w', root]);
    rmSync(root, { recursive: true, force: true });
}

function simulateAtomicExchange(command, args) {
    // Test double only: production keeps using fail-closed kernel exchange.
    assert.equal(command, 'mv');
    assert.deepEqual(args.slice(0, 3), ['--exchange', '--no-copy', '-T']);
    const [left, right] = args.slice(3);
    const temporary = `${left}.test-exchange`;
    renameSync(left, temporary);
    renameSync(right, left);
    renameSync(temporary, right);
    return { status: 0, stdout: '', stderr: '' };
}

function injected(value, overrides = {}) {
    return { contract: value.contract, run: simulateAtomicExchange, ...overrides };
}

test('activation exchanges exact candidate, retains previous, and rollback restores it', async () => {
    const value = await fixture();
    try {
        const activated = await activateOidCandidate({
            root: value.root, group: value.group, expectedOid: value.oid, buildId: value.buildId,
        }, injected(value));
        assert.equal(activated.state, 'promoted');
        assert.equal(readFileSync(path.join(value.live, 'marker'), 'utf8'), 'new');
        assert.equal(readFileSync(path.join(activated.previousPath, 'marker'), 'utf8'), 'old');
        const ledger = readPreviewLedger(value.root);
        assert.equal(ledger.serverState, 'promoted');
        assert.equal(ledger.serverPromotedBuildId, value.buildId);
        assert.equal(ledger.serverLoadedBuildId, value.previousBuildId);
        const rolledBack = rollbackOidCandidate({ root: value.root, group: value.group }, injected(value));
        assert.equal(rolledBack.state, 'rolled_back');
        assert.equal(readFileSync(path.join(value.live, 'marker'), 'utf8'), 'old');
        assert.equal(readFileSync(path.join(activated.previousPath, 'marker'), 'utf8'), 'new');
    } finally { cleanup(value.root); }
});

test('activation fails closed when atomic exchange is unavailable', async () => {
    const value = await fixture();
    try {
        await assert.rejects(() => activateOidCandidate({
            root: value.root, group: value.group, expectedOid: value.oid, buildId: value.buildId,
        }, injected(value, {
            run: () => ({ status: 1, stdout: '', stderr: 'mv: unrecognized option --exchange' }),
        })), /atomic exchange failed/);
        assert.equal(readFileSync(path.join(value.live, 'marker'), 'utf8'), 'old');
        assert.equal(readFileSync(path.join(value.candidate, 'marker'), 'utf8'), 'new');
    } finally { cleanup(value.root); }
});

test('a rolled-back candidate can be retried without losing either generation', async () => {
    const value = await fixture();
    try {
        const first = await activateOidCandidate({
            root: value.root, group: value.group, expectedOid: value.oid, buildId: value.buildId,
        }, injected(value));
        rollbackOidCandidate({ root: value.root, group: value.group }, injected(value));
        const retried = await activateOidCandidate({
            root: value.root, group: value.group, expectedOid: value.oid, buildId: value.buildId,
        }, injected(value));
        assert.equal(retried.state, 'promoted');
        assert.equal(readFileSync(path.join(value.live, 'marker'), 'utf8'), 'new');
        assert.equal(readFileSync(path.join(first.previousPath, 'marker'), 'utf8'), 'old');
    } finally { cleanup(value.root); }
});

test('retry resumes if it crashed after restoring a rolled-back candidate path', async () => {
    const value = await fixture();
    try {
        const first = await activateOidCandidate({
            root: value.root, group: value.group, expectedOid: value.oid, buildId: value.buildId,
        }, injected(value));
        rollbackOidCandidate({ root: value.root, group: value.group }, injected(value));
        // Crash boundary: rolled_back journal is durable, candidate rename
        // completed, but the retry process died before fsync/validation.
        renameSync(first.previousPath, value.candidate);
        const resumed = await activateOidCandidate({
            root: value.root, group: value.group, expectedOid: value.oid, buildId: value.buildId,
        }, injected(value));
        assert.equal(resumed.state, 'promoted');
        assert.equal(readFileSync(path.join(value.live, 'marker'), 'utf8'), 'new');
    } finally { cleanup(value.root); }
});

test('activation rejects a candidate symlink before touching live', async () => {
    const value = await fixture();
    try {
        symlinkSync('/etc/passwd', path.join(value.candidate, 'escape'));
        await assert.rejects(() => activateOidCandidate({
            root: value.root, group: value.group, expectedOid: value.oid, buildId: value.buildId,
        }, injected(value)), /symbolic link/);
        assert.equal(readFileSync(path.join(value.live, 'marker'), 'utf8'), 'old');
    } finally { cleanup(value.root); }
});

test('identity race blocks exchange and leaves live unchanged', async () => {
    const value = await fixture();
    try {
        await assert.rejects(() => activateOidCandidate({
            root: value.root, group: value.group, expectedOid: value.oid, buildId: value.buildId,
        }, injected(value, {
            beforeExchange: () => {
                const displaced = `${value.candidate}.displaced`;
                renameSync(value.candidate, displaced);
                cpSync(displaced, value.candidate, { recursive: true });
            },
        })), /path changed/);
        assert.equal(readFileSync(path.join(value.live, 'marker'), 'utf8'), 'old');
    } finally { cleanup(value.root); }
});

test('a newer global event arriving before exchange blocks the older promotion', async () => {
    const value = await fixture({ eventSequence: 30 });
    try {
        writeFileSync(path.join(value.root, 'newer'), 'newer');
        git(value.root, 'add', 'newer');
        git(value.root, 'commit', '-qm', 'newer');
        const newerOid = git(value.root, 'rev-parse', 'HEAD');
        await assert.rejects(() => activateOidCandidate({
            root: value.root, group: value.group, expectedOid: value.oid, buildId: value.buildId,
        }, injected(value, {
            beforeExchange: () => enqueuePreviewEvent(value.root, {
                sequence: 31, oid: newerOid, domains: ['server'],
            }),
        })), /preview_superseded_before_promotion/);
        assert.equal(readFileSync(path.join(value.live, 'marker'), 'utf8'), 'old');
        assert.equal(readFileSync(path.join(value.candidate, 'marker'), 'utf8'), 'new');
    } finally { cleanup(value.root); }
});

for (const [name, injection] of [
    ['after previous rename', { afterPreviousRename: () => { throw new Error('fault-after-rename'); } }],
    ['after live fsync', { afterLiveFsync: () => { throw new Error('fault-after-live-fsync'); } }],
    ['after previous fsync', { afterPreviousFsync: () => { throw new Error('fault-after-previous-fsync'); } }],
    ['while writing promoted transaction', {
        writeTransaction: (() => {
            let writes = 0;
            return (root, group, transaction) => {
                writes += 1;
                if (writes === 2) throw new Error('fault-promoted-journal');
                // The first prepared write must use the real durable path. The
                // fault is injected only at the promoted journal boundary.
                const file = path.join(root, '.git', `nassaj-preview-oid-activation-${group}.json`);
                writeFileSync(file, JSON.stringify({ schemaVersion: 1, ...transaction }));
            };
        })(),
    }],
]) {
    test(`post-exchange fault ${name} restores a retryable prepared layout`, async () => {
        const value = await fixture();
        try {
            await assert.rejects(() => activateOidCandidate({
                root: value.root, group: value.group, expectedOid: value.oid, buildId: value.buildId,
            }, injected(value, injection)), /fault/);
            assert.equal(readFileSync(path.join(value.live, 'marker'), 'utf8'), 'old');
            assert.equal(readFileSync(path.join(value.candidate, 'marker'), 'utf8'), 'new');
            const retried = await activateOidCandidate({
                root: value.root, group: value.group, expectedOid: value.oid, buildId: value.buildId,
            }, injected(value));
            assert.equal(retried.state, 'promoted');
            assert.equal(readFileSync(path.join(value.live, 'marker'), 'utf8'), 'new');
        } finally { cleanup(value.root); }
    });
}

test('crash immediately after durable promoted journal resumes as promoted', async () => {
    const value = await fixture();
    try {
        await assert.rejects(() => activateOidCandidate({
            root: value.root, group: value.group, expectedOid: value.oid, buildId: value.buildId,
        }, injected(value, { afterPromotedWrite: () => { throw new Error('simulated-process-crash'); } })), /simulated-process-crash/);
        assert.equal(readFileSync(path.join(value.live, 'marker'), 'utf8'), 'new');
        const resumed = await activateOidCandidate({
            root: value.root, group: value.group, expectedOid: value.oid, buildId: value.buildId,
        }, injected(value));
        assert.equal(resumed.state, 'promoted');
        assert.equal(readFileSync(path.join(resumed.previousPath, 'marker'), 'utf8'), 'old');
    } finally { cleanup(value.root); }
});

for (const [name, injection] of [
    ['before rollback exchange', { beforeRollbackExchange: () => { throw new Error('crash-before-rollback-exchange'); } }],
    ['after rollback exchange', { afterRollbackExchange: () => { throw new Error('crash-after-rollback-exchange'); } }],
    ['after durable rolled-back journal', { afterRolledBackWrite: () => { throw new Error('crash-after-rolled-back-write'); } }],
]) {
    test(`rollback crash ${name} resumes to one verified rolled-back layout`, async () => {
        const value = await fixture();
        try {
            await activateOidCandidate({
                root: value.root, group: value.group, expectedOid: value.oid, buildId: value.buildId,
            }, injected(value));
            assert.throws(() => rollbackOidCandidate({ root: value.root, group: value.group }, injected(value, injection)), /crash/);
            const resumed = rollbackOidCandidate({ root: value.root, group: value.group }, injected(value));
            assert.equal(resumed.state, 'rolled_back');
            assert.equal(readFileSync(path.join(value.live, 'marker'), 'utf8'), 'old');
            assert.equal(readFileSync(path.join(resumed.previousPath, 'marker'), 'utf8'), 'new');
        } finally { cleanup(value.root); }
    });
}

test('failure writing rolled-back journal resumes from rollback-prepared disk identity', async () => {
    const value = await fixture();
    try {
        await activateOidCandidate({
            root: value.root, group: value.group, expectedOid: value.oid, buildId: value.buildId,
        }, injected(value));
        let writes = 0;
        assert.throws(() => rollbackOidCandidate({ root: value.root, group: value.group }, injected(value, {
            writeTransaction: (root, group, transaction) => {
                writes += 1;
                if (writes === 2) throw new Error('fault-rolled-back-journal');
                writeFileSync(
                    path.join(root, '.git', `nassaj-preview-oid-activation-${group}.json`),
                    JSON.stringify({ schemaVersion: 1, ...transaction }),
                );
            },
        })), /fault-rolled-back-journal/);
        assert.equal(readFileSync(path.join(value.live, 'marker'), 'utf8'), 'old');
        const resumed = rollbackOidCandidate({ root: value.root, group: value.group }, injected(value));
        assert.equal(resumed.state, 'rolled_back');
        assert.equal(readFileSync(path.join(resumed.previousPath, 'marker'), 'utf8'), 'new');
    } finally { cleanup(value.root); }
});

test('legacy promoted journal with rolled-back disk is reconciled before early return', async () => {
    const value = await fixture();
    try {
        const promoted = await activateOidCandidate({
            root: value.root, group: value.group, expectedOid: value.oid, buildId: value.buildId,
        }, injected(value));
        simulateAtomicExchange('mv', ['--exchange', '--no-copy', '-T', value.live, promoted.previousPath]);
        const resumed = await activateOidCandidate({
            root: value.root, group: value.group, expectedOid: value.oid, buildId: value.buildId,
        }, injected(value));
        assert.equal(resumed.state, 'promoted');
        assert.equal(readFileSync(path.join(value.live, 'marker'), 'utf8'), 'new');
        assert.equal(readFileSync(path.join(resumed.previousPath, 'marker'), 'utf8'), 'old');
    } finally { cleanup(value.root); }
});
