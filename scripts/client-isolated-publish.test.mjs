#!/usr/bin/env node
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
    assertFullSourceRef, assertPublishingMainHead, assertRecordedOidSuperseded,
    clearMutableWatcherInhibit, localMainHead, mutableWatcherInhibitPath,
    readMutableWatcherInhibit, sharedClientPublishLockPath,
} from './client-isolated-publish.mjs';
import { previewControlPaths } from './local-preview-ledger.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BUILD = 'a'.repeat(64);
function git(root, ...args) { return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim(); }
function fixture() {
    const root = mkdtempSync('/var/tmp/isolated-client-publish-');
    git(root, 'init', '-q', '-b', 'main'); git(root, 'config', 'user.name', 'Test'); git(root, 'config', 'user.email', 'test@example.invalid');
    writeFileSync(path.join(root, 'source.txt'), 'committed'); git(root, 'add', 'source.txt'); git(root, 'commit', '-qm', 'source');
    const oid = git(root, 'rev-parse', 'HEAD'); mkdirSync(path.join(root, 'dist')); writeFileSync(path.join(root, 'dist', 'index.html'), 'old');
    return { root, oid };
}
// A three-commit history: main = A <- B, plus an unmerged overlay commit X off A.
function lineageFixture() {
    const root = mkdtempSync('/var/tmp/isolated-client-publish-lineage-');
    git(root, 'init', '-q', '-b', 'main'); git(root, 'config', 'user.name', 'Test'); git(root, 'config', 'user.email', 'test@example.invalid');
    writeFileSync(path.join(root, 'source.txt'), 'a'); git(root, 'add', 'source.txt'); git(root, 'commit', '-qm', 'a');
    const a = git(root, 'rev-parse', 'HEAD');
    writeFileSync(path.join(root, 'source.txt'), 'b'); git(root, 'add', 'source.txt'); git(root, 'commit', '-qm', 'b');
    const b = git(root, 'rev-parse', 'HEAD');
    git(root, 'checkout', '-q', '-b', 'overlay', a);
    writeFileSync(path.join(root, 'overlay.txt'), 'x'); git(root, 'add', 'overlay.txt'); git(root, 'commit', '-qm', 'x');
    const x = git(root, 'rev-parse', 'HEAD');
    git(root, 'checkout', '-q', 'main');
    mkdirSync(path.join(root, 'dist')); writeFileSync(path.join(root, 'dist', 'index.html'), 'old');
    return { root, a, b, x };
}
function inhibitRecord(oid, buildId = BUILD, operationId = '123e4567-e89b-12d3-a456-426614174000') {
    return { schemaVersion: 1, oid, buildId, operationId, sourceRoot: '.nassaj-client-snapshots', publishedAt: new Date().toISOString() };
}
function cleanup(root) { if (existsSync(root)) { execFileSync('chmod', ['-R', 'u+w', root]); rmSync(root, { recursive: true, force: true }); } }

test('CLI clears only the inhibit matching its exact source and build identity', () => {
    const value = fixture();
    const script = path.join(ROOT, 'scripts', 'client-isolated-publish.mjs');
    const record = {
        schemaVersion: 1,
        oid: value.oid,
        buildId: BUILD,
        operationId: '123e4567-e89b-12d3-a456-426614174000',
        sourceRoot: '.nassaj-client-snapshots',
        publishedAt: new Date().toISOString(),
    };
    try {
        writeFileSync(mutableWatcherInhibitPath(value.root), `${JSON.stringify(record)}\n`);
        const output = execFileSync(process.execPath, [script,
            '--repo', value.root, '--source-ref', value.oid,
            '--clear-inhibit', '--build-id', BUILD,
        ], { encoding: 'utf8' });
        assert.deepEqual(JSON.parse(output), { cleared: true });
        assert.equal(existsSync(mutableWatcherInhibitPath(value.root)), false);

        writeFileSync(mutableWatcherInhibitPath(value.root), `${JSON.stringify(record)}\n`);
        const failure = spawnSync(process.execPath, [script,
            '--repo', value.root, '--source-ref', value.oid,
            '--clear-inhibit', '--build-id', 'b'.repeat(64),
        ], { encoding: 'utf8' });
        assert.notEqual(failure.status, 0);
        assert.match(failure.stderr, /different build identity/);
        assert.equal(readMutableWatcherInhibit(value.root).buildId, BUILD);
    } finally { cleanup(value.root); }
});

test('uses the watcher publish lock and re-checks inhibit after acquiring it', () => {
    const publisher = readFileSync(path.join(ROOT, 'scripts', 'client-isolated-publish.mjs'), 'utf8');
    const watcher = readFileSync(path.join(ROOT, 'scripts', 'client-build-watch.mjs'), 'utf8');
    const builder = readFileSync(path.join(ROOT, 'scripts', 'client-build-atomic.mjs'), 'utf8');
    const value = fixture();
    try {
        assert.equal(sharedClientPublishLockPath(value.root), previewControlPaths(value.root).buildLock);
    } finally { cleanup(value.root); }
    assert.match(publisher, /sharedClientPublishLockPath\(root\)/); assert.match(publisher, /'flock', args/);
    assert.match(watcher, /readMutableWatcherInhibit\(ROOT\)/);
    assert.match(builder, /options\.localPreview && readMutableWatcherInhibit\(ROOT\)/);
});

test('the isolated publisher lock excludes the watcher lock during a promotion race', async () => {
    const value = fixture();
    let holder;
    try {
        const lock = sharedClientPublishLockPath(value.root);
        holder = spawn('flock', ['-x', lock, 'sh', '-c', 'echo locked; read release'], { stdio: ['pipe', 'pipe', 'ignore'] });
        await Promise.race([
            once(holder.stdout, 'data'),
            once(holder, 'error').then(([error]) => { throw error; }),
        ]);
        assert.throws(() => execFileSync('flock', ['-n', lock, 'true']));
        holder.stdin.end('release\n');
        await once(holder, 'exit');
        holder = null;
        assert.doesNotThrow(() => execFileSync('flock', ['-n', lock, 'true']));
    } finally {
        if (holder) {
            holder.stdin.end('release\n');
            await once(holder, 'exit');
        }
        cleanup(value.root);
    }
});

test('clears an inhibit whose recorded OID is an ancestor of the published main HEAD', () => {
    const value = lineageFixture();
    try {
        writeFileSync(mutableWatcherInhibitPath(value.root), `${JSON.stringify(inhibitRecord(value.a))}\n`);
        assert.equal(clearMutableWatcherInhibit(value.root, value.b, BUILD), true);
        assert.equal(existsSync(mutableWatcherInhibitPath(value.root)), false);
    } finally { cleanup(value.root); }
});

test('refuses to clear an unmerged overlay inhibit (T-1711 replay) and keeps the record', () => {
    const value = lineageFixture();
    try {
        writeFileSync(mutableWatcherInhibitPath(value.root), `${JSON.stringify(inhibitRecord(value.x))}\n`);
        assert.throws(() => clearMutableWatcherInhibit(value.root, value.b, BUILD), /not\s+merged/);
        assert.equal(readMutableWatcherInhibit(value.root).oid, value.x);
    } finally { cleanup(value.root); }
});

test('refuses to clear a squash-merged overlay inhibit (non-ancestor) and keeps the record', () => {
    const value = lineageFixture();
    try {
        // Simulate a squash-merge: main gains the overlay content as a fresh
        // commit, so overlay X is not an ancestor of the new main HEAD.
        writeFileSync(path.join(value.root, 'overlay.txt'), 'x');
        git(value.root, 'add', 'overlay.txt'); git(value.root, 'commit', '-qm', 'squash of overlay');
        const merged = git(value.root, 'rev-parse', 'HEAD');
        writeFileSync(mutableWatcherInhibitPath(value.root), `${JSON.stringify(inhibitRecord(value.x))}\n`);
        assert.throws(() => clearMutableWatcherInhibit(value.root, merged, BUILD), /not\s+merged/);
        assert.equal(readMutableWatcherInhibit(value.root).oid, value.x);
    } finally { cleanup(value.root); }
});

test('self-release supersede passes the lineage gate', () => {
    const value = lineageFixture();
    try {
        assert.doesNotThrow(() => assertRecordedOidSuperseded(value.root, value.b, value.b));
    } finally { cleanup(value.root); }
});

test('fails closed when the recorded OID is a missing object (git exit 128)', () => {
    const value = lineageFixture();
    try {
        writeFileSync(mutableWatcherInhibitPath(value.root), `${JSON.stringify(inhibitRecord('f'.repeat(40)))}\n`);
        assert.throws(() => clearMutableWatcherInhibit(value.root, value.b, BUILD), /could not prove|missing object|git failure/);
        assert.equal(readMutableWatcherInhibit(value.root).oid, 'f'.repeat(40));
    } finally { cleanup(value.root); }
});

test('fails closed when refs/heads/main is missing', () => {
    const root = mkdtempSync('/var/tmp/isolated-client-publish-nomain-');
    try {
        git(root, 'init', '-q', '-b', 'work'); git(root, 'config', 'user.name', 'Test'); git(root, 'config', 'user.email', 'test@example.invalid');
        writeFileSync(path.join(root, 'f.txt'), '1'); git(root, 'add', 'f.txt'); git(root, 'commit', '-qm', 'one');
        const oid = git(root, 'rev-parse', 'HEAD');
        assert.equal(localMainHead(root), null);
        assert.throws(() => assertPublishingMainHead(root, oid), /main HEAD|refs\/heads\/main/);
    } finally { cleanup(root); }
});

test('refuses a non-main publish without the flag and allows it with --allow-non-main', () => {
    const value = lineageFixture();
    try {
        assert.doesNotThrow(() => assertPublishingMainHead(value.root, value.b));
        assert.throws(() => assertPublishingMainHead(value.root, value.a), /non-main|allow-non-main/);
        assert.doesNotThrow(() => assertPublishingMainHead(value.root, value.a, { allowNonMain: true }));
    } finally { cleanup(value.root); }
});


test('full source ref validation rejects abbreviated and malformed identities', () => {
    assert.throws(() => assertFullSourceRef('a'.repeat(12)), /40-character/);
    assert.throws(() => assertFullSourceRef('z'.repeat(40)), /40-character/);
    assert.doesNotThrow(() => assertFullSourceRef('a'.repeat(40)));
});
