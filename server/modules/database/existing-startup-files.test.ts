import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

import Database from 'better-sqlite3';

import { inspectExistingStartupFiles } from './existing-startup-files.js';

function fixture(t: { after: (fn: () => void) => void }) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'startup-files-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'database.sqlite');
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.exec('CREATE TABLE example (id INTEGER PRIMARY KEY, value TEXT)');
  db.prepare('INSERT INTO example VALUES (?, ?)').run(1, 'preserved');
  db.close(); fs.chmodSync(file, 0o600);
  const stat = fs.statSync(file, { bigint: true });
  return { file, directory, identity: {realpath:file, device:String(stat.dev), inode:String(stat.ino)} };
}

test('readonly SQLite creates absent sidecars without changing main bytes or rows', t => {
  const { file, identity } = fixture(t);
  assert.equal(fs.existsSync(file + '-wal'), false);
  const before = fs.readFileSync(file);
  const recheck = inspectExistingStartupFiles(identity);
  const db = new Database(file, {readonly:true, fileMustExist:true});
  try {
    assert.equal(db.prepare('SELECT value FROM example WHERE id = ?').pluck().get(1), 'preserved');
    recheck();
    assert.ok(fs.existsSync(file + '-wal')); assert.ok(fs.existsSync(file + '-shm'));
    assert.deepEqual(fs.readFileSync(file), before);
  } finally { db.close(); }
});

for (const malicious of ['symlink', 'hardlink', 'fifo', 'mode', 'journal', 'dangling-journal', 'parent']) {
  test(`rejects ${malicious} before SQLite open`, t => {
    const { file, directory, identity } = fixture(t);
    if (malicious === 'hardlink') fs.linkSync(file, file + '-wal');
    if (malicious === 'symlink') fs.symlinkSync(file, file + '-wal');
    if (malicious === 'fifo') assert.equal(spawnSync('mkfifo', [file + '-wal']).status, 0);
    if (malicious === 'mode') fs.writeFileSync(file + '-wal', '', {mode:0o644});
    if (malicious === 'journal') fs.writeFileSync(file + '-journal', 'rollback', {mode:0o600});
    if (malicious === 'dangling-journal') fs.symlinkSync(file + '.absent', file + '-journal');
    if (malicious === 'parent') fs.chmodSync(directory, 0o777);
    assert.throws(() => inspectExistingStartupFiles(identity), /existing_startup_/);
  });
}

test('rejects main byte mutation and sidecar inode replacement after inspection', t => {
  const { file, identity } = fixture(t);
  const recheck = inspectExistingStartupFiles(identity);
  fs.appendFileSync(file, 'changed');
  assert.throws(recheck, /database_files_changed/);
  const second = fixture(t);
  fs.writeFileSync(second.file + '-wal', '', {mode:0o600});
  const recheckSidecar = inspectExistingStartupFiles(second.identity);
  fs.renameSync(second.file + '-wal', second.file + '.old');
  fs.writeFileSync(second.file + '-wal', '', {mode:0o600});
  assert.throws(recheckSidecar, /sidecar_changed/);
});

test('reopens actual SQLite sidecars left by an abruptly terminated readonly child', t => {
  const { file, identity } = fixture(t);
  const before = fs.readFileSync(file);
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import Database from 'better-sqlite3';
    const db = new Database(process.argv[1], {readonly:true,fileMustExist:true});
    db.prepare('SELECT * FROM example').all();
    process.kill(process.pid, 'SIGKILL');
  `, file], {cwd:process.cwd()});
  assert.equal(child.signal, 'SIGKILL');
  const recheck = inspectExistingStartupFiles(identity);
  const db = new Database(file, {readonly:true,fileMustExist:true});
  try { assert.equal(db.prepare('SELECT count(*) FROM example').pluck().get(), 1); recheck(); }
  finally { db.close(); }
  assert.deepEqual(fs.readFileSync(file), before);
});
