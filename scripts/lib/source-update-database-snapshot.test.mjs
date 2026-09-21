import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { captureDatabaseSnapshot, readDatabaseSnapshot, restoreDatabaseSnapshot, pruneDatabaseSnapshots } from './source-update-database-snapshot.mjs';

function fixture(t) {
    const root = fs.mkdtempSync(path.join(process.env.TMPDIR, 'db-snapshot-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const databasePath = path.join(root, 'db.sqlite');
    execFileSync('/usr/bin/sqlite3', [databasePath, 'CREATE TABLE rows(id INTEGER); INSERT INTO rows VALUES (1);']);
    fs.chmodSync(databasePath, 0o600);
    return { databasePath, snapshotRoot: path.join(root, 'snap'), transactionId: 'update-test-baseline', targetCommit: 'a'.repeat(40) };
}
test('descriptor survives fresh process, capture preserves baseline and DML writes', t => {
    const options = fixture(t);
    const first = captureDatabaseSnapshot(options);
    execFileSync('/usr/bin/sqlite3', [options.databasePath, 'INSERT INTO rows VALUES (2);']);
    assert.deepEqual(captureDatabaseSnapshot(options), first);
    const moduleUrl = new URL('./source-update-database-snapshot.mjs', import.meta.url).href;
    const value = execFileSync(process.execPath, ['--input-type=module', '-e',
        `import {readDatabaseSnapshot} from ${JSON.stringify(moduleUrl)}; process.stdout.write(JSON.stringify(readDatabaseSnapshot(${JSON.stringify(options)})));`]);
    assert.deepEqual(JSON.parse(value), first);
    assert.throws(() => restoreDatabaseSnapshot({ databasePath: options.databasePath, snapshot: first, quiescent: true }), /manual_quiescence/);
    assert.equal(execFileSync('/usr/bin/sqlite3', [options.databasePath, 'SELECT count(*) FROM rows;']).toString().trim(), '2');
});
test('all unresolved snapshots remain pinned beyond retention', t => {
    const options = fixture(t);
    for (let i = 0; i < 4; i++) captureDatabaseSnapshot({ ...options, transactionId: `update-${i}` });
    assert.deepEqual(pruneDatabaseSnapshots(options.snapshotRoot, 1), []);
    assert.equal(fs.readdirSync(options.snapshotRoot).length, 4);
});
test('missing descriptor and interrupted capture never replace baseline', t => {
    const options = fixture(t);
    const first = captureDatabaseSnapshot(options);
    const file = path.join(first.snapshotDir, 'descriptor.json');
    fs.unlinkSync(file);
    assert.throws(() => captureDatabaseSnapshot(options));
    fs.writeFileSync(file, JSON.stringify({ ...first, phase: 'CAPTURE_INTENT' }), { mode: 0o600 });
    assert.throws(() => captureDatabaseSnapshot(options), /descriptor_invalid/);
    assert.ok(fs.existsSync(first.snapshotFile));
});
test('tampered snapshot, identity and symlink are rejected', t => {
    const options = fixture(t);
    const first = captureDatabaseSnapshot(options);
    assert.throws(() => readDatabaseSnapshot({ ...options, targetCommit: 'b'.repeat(40) }), /descriptor_invalid/);
    execFileSync('/usr/bin/sqlite3', [first.snapshotFile, 'INSERT INTO rows VALUES (9);']);
    assert.throws(() => readDatabaseSnapshot(options), /verification_failed/);
    fs.unlinkSync(first.snapshotFile);
    fs.symlinkSync(options.databasePath, first.snapshotFile);
    assert.throws(() => readDatabaseSnapshot(options), /path_unsafe/);
});
test('ENOSPC and unavailable counters refuse before snapshot intent', t => {
    const options = fixture(t);
    for (const bavail of [1, NaN]) assert.throws(() => captureDatabaseSnapshot({ ...options,
        statfs: () => ({ type: 0xef53, bavail, bsize: 4096 }) }), /insufficient_disk/);
    assert.equal(fs.existsSync(path.join(options.snapshotRoot, options.transactionId)), false);
});
test('schema drift never authorizes automatic DB replacement', t => {
    const options = fixture(t);
    const snapshot = captureDatabaseSnapshot(options);
    execFileSync('/usr/bin/sqlite3', [options.databasePath, 'ALTER TABLE rows ADD COLUMN content TEXT;']);
    const before = fs.readFileSync(options.databasePath);
    assert.throws(() => restoreDatabaseSnapshot({ databasePath: options.databasePath, snapshot }), /manual_quiescence/);
    assert.deepEqual(fs.readFileSync(options.databasePath), before);
});
