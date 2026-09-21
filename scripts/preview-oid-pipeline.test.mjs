#!/usr/bin/env node
import assert from 'node:assert/strict';
import {
    chmodSync,
    existsSync,
    lstatSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    readdirSync,
    rmSync,
    writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import {
    advancePreview,
    materializePreviewSnapshot,
    readPreviewState,
    reconcilePreviewSnapshots,
    requestPreview,
} from './preview-oid-pipeline.mjs';
import { dispatchCommittedPreview, previewDomainsForPaths } from './preview-oid-dispatch.mjs';

function command(root, executable, args) {
    const result = spawnSync(executable, args, { cwd: root, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
}

function fixture() {
    const root = mkdtempSync(path.join(process.env.TMPDIR || '/var/tmp', 'preview-oid-'));
    command(root, 'git', ['init', '-q']);
    command(root, 'git', ['config', 'user.name', 'Preview Test']);
    command(root, 'git', ['config', 'user.email', 'preview@example.invalid']);
    writeFileSync(path.join(root, 'source.txt'), 'committed-one\n');
    command(root, 'git', ['add', 'source.txt']);
    command(root, 'git', ['commit', '-qm', 'one']);
    const first = command(root, 'git', ['rev-parse', 'HEAD']);
    writeFileSync(path.join(root, 'source.txt'), 'committed-two\n');
    command(root, 'git', ['commit', '-qam', 'two']);
    const second = command(root, 'git', ['rev-parse', 'HEAD']);
    return { root, first, second };
}

function cleanup(root) {
    function writable(entry) {
        if (!existsSync(entry)) return;
        const metadata = lstatSync(entry);
        if (metadata.isDirectory() && !metadata.isSymbolicLink()) {
            chmodSync(entry, 0o700);
            for (const child of readdirSync(entry)) writable(path.join(entry, child));
        }
    }
    writable(root);
    rmSync(root, { recursive: true, force: true });
}

test('coherence group binds client and server lifecycle refs to one OID', () => {
    const { root, first, second } = fixture();
    try {
        requestPreview(root, { group: 'session-17', oid: first });
        advancePreview(root, { group: 'session-17', domain: 'client', state: 'candidate', oid: first });
        advancePreview(root, { group: 'session-17', domain: 'client', state: 'promoted', oid: first });
        advancePreview(root, { group: 'session-17', domain: 'client', state: 'served', oid: first });
        advancePreview(root, { group: 'session-17', domain: 'server', state: 'candidate', oid: first });
        advancePreview(root, { group: 'session-17', domain: 'server', state: 'promoted', oid: first });
        advancePreview(root, { group: 'session-17', domain: 'server', state: 'loaded', oid: first });
        const state = readPreviewState(root, 'session-17');
        assert.equal(state.coherent, true);
        assert.equal(state.client.served, first);
        assert.equal(state.server.loaded, first);
        assert.throws(() => requestPreview(root, { group: 'session-17', oid: second }), /already bound/);
    } finally { cleanup(root); }
});

test('retry repairs a crash between the common desired ref and domain refs', () => {
    const { root, first } = fixture();
    try {
        assert.throws(() => requestPreview(root, { group: 'crash-retry', oid: first }, {
            afterGroupRef: () => { throw new Error('synthetic crash'); },
        }), /synthetic crash/);
        assert.equal(readPreviewState(root, 'crash-retry').client.desired, null);
        requestPreview(root, { group: 'crash-retry', oid: first });
        const repaired = readPreviewState(root, 'crash-retry');
        assert.equal(repaired.client.desired, first);
        assert.equal(repaired.server.desired, first);
    } finally { cleanup(root); }
});

test('snapshot contains commit bytes and never dirty working-tree bytes', async () => {
    const { root, first } = fixture();
    try {
        writeFileSync(path.join(root, 'source.txt'), 'dirty-secret\n');
        const snapshot = await materializePreviewSnapshot(root, first);
        assert.equal(readFileSync(path.join(snapshot, 'source.txt'), 'utf8'), 'committed-one\n');
        assert.throws(() => writeFileSync(path.join(snapshot, 'source.txt'), 'mutation'), /EACCES|permission denied/i);
    } finally { cleanup(root); }
});

test('snapshot rejects committed symlinks instead of following an escape', async () => {
    const { root } = fixture();
    try {
        command(root, 'ln', ['-s', '/etc/passwd', 'escape']);
        command(root, 'git', ['add', 'escape']);
        command(root, 'git', ['commit', '-qm', 'symlink']);
        const oid = command(root, 'git', ['rev-parse', 'HEAD']);
        await assert.rejects(() => materializePreviewSnapshot(root, oid), /symbolic link/);
        const parent = path.join(root, '.nassaj-local-preview', 'oid-snapshots');
        assert.equal(readdirSync(parent).some((name) => name.startsWith('.extracting-')), false);
    } finally { cleanup(root); }
});

test('durable preview refs retain an otherwise unreachable commit across gc', () => {
    const { root, second } = fixture();
    try {
        const tree = command(root, 'git', ['write-tree']);
        const unreachable = command(root, 'git', ['commit-tree', tree, '-m', 'detached preview']);
        requestPreview(root, { group: 'gc-retention', oid: unreachable, domains: ['client'] });
        command(root, 'git', ['reflog', 'expire', '--expire=now', '--all']);
        command(root, 'git', ['gc', '--prune=now']);
        assert.equal(command(root, 'git', ['cat-file', '-t', unreachable]), 'commit');
        assert.equal(command(root, 'git', ['rev-parse', 'HEAD']), second);
    } finally { cleanup(root); }
});

test('reconciliation removes interrupted extraction only', () => {
    const { root, first } = fixture();
    try {
        const parent = path.join(root, '.nassaj-local-preview', 'oid-snapshots');
        const partial = `.extracting-${first}-991`;
        mkdirSync(path.join(parent, partial), { recursive: true });
        mkdirSync(path.join(parent, first), { recursive: true });
        assert.deepEqual(reconcilePreviewSnapshots(root), [partial]);
        assert.equal(existsSync(path.join(parent, first)), true);
    } finally { cleanup(root); }
});

test('arbiter result dispatch derives coherent domains and materializes its commit', async () => {
    const { root, first } = fixture();
    try {
        assert.deepEqual(previewDomainsForPaths(['src/App.tsx']), ['client']);
        assert.deepEqual(previewDomainsForPaths(['server/index.js']), ['server']);
        assert.deepEqual(previewDomainsForPaths(['shared/version.js']), ['client', 'server']);
        const dispatched = await dispatchCommittedPreview(root, 'arbiter-42', {
            commit: first,
            sequence: 42,
            attempts: 1,
            changedPaths: ['shared/version.js'],
        });
        assert.deepEqual(dispatched.domains, ['client', 'server']);
        assert.equal(readFileSync(path.join(dispatched.sourceRoot, 'source.txt'), 'utf8'), 'committed-one\n');
        assert.equal(dispatched.state.client.desired, first);
        assert.equal(dispatched.state.server.desired, first);
        assert.equal(dispatched.group, 'event-0000000000000042');
    } finally { cleanup(root); }
});
