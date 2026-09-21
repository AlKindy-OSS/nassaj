import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { mkdtempSync, chmodSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import Database from 'better-sqlite3';
import { createVerifiedSqliteBackup, verifySqliteDatabase } from './lib/release-database-backup.mjs';

function fixture(t) {
    const root = mkdtempSync(path.join(process.env.TMPDIR || '/var/tmp', 'backup-fallback-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const source = path.join(root, 'source.sqlite');
    const db = new Database(source); chmodSync(source, 0o600);
    t.after(() => db.close());
    return { root, source, db };
}
function missingCli(t, code = 'ENOENT', executable = '/usr/bin/sqlite3') {
    const original = childProcess.execFileSync;
    childProcess.execFileSync = () => { throw Object.assign(new Error('controlled spawn error'), { code, path: executable }); };
    syncBuiltinESMExports();
    t.after(() => { childProcess.execFileSync = original; syncBuiltinESMExports(); });
}
test('missing CLI backs up committed WAL and quoted destination without changing source', t => {
    const { root, source, db } = fixture(t); db.pragma('journal_mode=WAL'); db.pragma('wal_autocheckpoint=0');
    db.exec("CREATE TABLE sample(id INTEGER PRIMARY KEY,value TEXT); INSERT INTO sample VALUES(1,'committed');");
    const before = readFileSync(source), walBefore = readFileSync(`${source}-wal`);
    missingCli(t);
    const target = path.join(root, "quoted'backup.sqlite");
    const result = createVerifiedSqliteBackup(source, target);
    assert.equal(result.integrityCheck, 'ok'); assert.equal(result.foreignKeyViolations, 0);
    assert.equal(result.sourceSchemaDigest, result.schemaDigest);
    const backup = new Database(target, { readonly: true });
    try { assert.deepEqual(backup.prepare('SELECT * FROM sample').all(), [{ id: 1, value: 'committed' }]); }
    finally { backup.close(); }
    assert.deepEqual(readFileSync(source), before); assert.deepEqual(readFileSync(`${source}-wal`), walBefore);
});
test('missing CLI refuses corrupt database', t => {
    const { root } = fixture(t); const file = path.join(root, 'corrupt.sqlite');
    writeFileSync(file, 'not a database', { mode: 0o600 }); missingCli(t);
    assert.throws(() => verifySqliteDatabase(file), /database_sqlite_operation_failed/);
});
test('missing CLI refuses foreign key violations', t => {
    const { source, db } = fixture(t); db.pragma('foreign_keys=OFF');
    db.exec('CREATE TABLE parent(id PRIMARY KEY); CREATE TABLE child(id REFERENCES parent(id)); INSERT INTO child VALUES(1);');
    missingCli(t); assert.throws(() => verifySqliteDatabase(source), /database_backup_verification_failed/);
});
for (const code of ['EACCES', 'ETIMEDOUT', 'SQLITE_ERROR']) test(`${code} does not fall back`, t => {
    const { root, source, db } = fixture(t); db.exec('CREATE TABLE sample(id);'); missingCli(t, code);
    const target = path.join(root, 'must-not-exist.sqlite');
    assert.throws(() => createVerifiedSqliteBackup(source, target), /database_sqlite_operation_failed/);
    assert.equal(existsSync(target), false);
});
test('ENOENT for another executable does not fall back', t => {
    const { source } = fixture(t); missingCli(t, 'ENOENT', '/another/path');
    assert.throws(() => verifySqliteDatabase(source), /database_sqlite_operation_failed/);
});
