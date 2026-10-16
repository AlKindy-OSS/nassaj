/** T-2024 (ADR-207 §3.3, qa A2): the shared in-process build mutex. */
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import test from 'node:test';

import { buildMutexHolder, tryAcquireBuildMutex } from './source-update-build-mutex.js';
import { createSourceUpdater } from './source-updater.js';

const EXT4_MAGIC = 0xef53;

function fixture(t) {
    const root = fs.mkdtempSync(path.join('/var/tmp', 'nassaj-build-mutex-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    execFileSync('git', ['init', '-q'], { cwd: root });
    return root;
}

function updaterFor(appRoot, commandRunner) {
    return createSourceUpdater({
        appRoot, activeSessionCount: () => 0, commandRunner,
        statfs: () => ({ type: EXT4_MAGIC, bavail: 4_000_000, bsize: 4096 }),
    });
}

test('one holder per source tree; a second caller is refused, other trees are independent', () => {
    const first = tryAcquireBuildMutex('/srv/a', { kind: 'source-update-prestage' });
    assert.ok(first);
    assert.equal(tryAcquireBuildMutex('/srv/a/', { kind: 'source-update' }), null, 'same tree after normalization');
    assert.equal(buildMutexHolder('/srv/a').kind, 'source-update-prestage');
    const other = tryAcquireBuildMutex('/srv/b', { kind: 'source-update' });
    assert.ok(other);
    first.release();
    other.release();
    assert.equal(buildMutexHolder('/srv/a'), null);
});

test('release is idempotent and a stale handle never frees a later holder', () => {
    const stale = tryAcquireBuildMutex('/srv/c', { kind: 'one' });
    stale.release();
    const current = tryAcquireBuildMutex('/srv/c', { kind: 'two' });
    stale.release();
    assert.equal(buildMutexHolder('/srv/c').kind, 'two');
    current.release();
    assert.equal(buildMutexHolder('/srv/c'), null);
});

test('updateSource() is refused while any other caller (e.g. the prestager) holds the mutex', async (t) => {
    const appRoot = fixture(t);
    const calls = [];
    const update = updaterFor(appRoot, async (...args) => { calls.push(args); return { code: 1, stdout: '', stderr: '' }; });
    const prestage = tryAcquireBuildMutex(appRoot, { kind: 'source-update-prestage' });
    try {
        await assert.rejects(update('1.42.0.1'), (error) => error.code === 'update_in_progress');
        assert.equal(calls.length, 0, 'refused before any command');
    } finally {
        prestage.release();
    }
    await assert.rejects(update('1.42.0.1'), (error) => error.code !== 'update_in_progress');
    assert.ok(calls.length > 0, 'runs once the mutex is free');
});

test('two updater instances on one tree share the mutex; it is free again after the run', async (t) => {
    const appRoot = fixture(t);
    let releaseFirst;
    const gate = new Promise((resolve) => { releaseFirst = resolve; });
    let waited = false;
    const slow = updaterFor(appRoot, async () => {
        if (!waited) { waited = true; await gate; }
        return { code: 1, stdout: '', stderr: '' };
    });
    const other = updaterFor(appRoot, async () => ({ code: 1, stdout: '', stderr: '' }));
    const first = slow('1.42.0.1');
    assert.equal(buildMutexHolder(appRoot).kind, 'source-update');
    await assert.rejects(other('1.42.0.1'), (error) => error.code === 'update_in_progress');
    releaseFirst();
    await assert.rejects(first, (error) => error.code === 'git_status_failed');
    assert.equal(buildMutexHolder(appRoot), null);
});

test('a refused entry check never leaves the mutex held', async (t) => {
    const appRoot = fixture(t);
    const update = updaterFor(appRoot, async () => ({ code: 1, stdout: '', stderr: '' }));
    await assert.rejects(update('not-a-version'), (error) => error.code === 'invalid_release_version');
    assert.equal(buildMutexHolder(appRoot), null);
});
