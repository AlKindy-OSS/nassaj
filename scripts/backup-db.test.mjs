import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const script = path.join(root, 'scripts/backup-db.sh');
const tempBase = process.env.NASSAJ_TEST_TEMP_ROOT || process.env.TMPDIR || '/var/tmp';

function sandbox(t) {
  const dir = fs.mkdtempSync(path.join(tempBase, 'nassaj-backup-db.'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function sqlite(file, sql) {
  const result = spawnSync('sqlite3', [file, sql], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function sourceDb(dir) {
  const file = path.join(dir, 'source.sqlite');
  sqlite(file, 'CREATE TABLE sample(id INTEGER PRIMARY KEY, value TEXT); INSERT INTO sample(value) VALUES (\'synthetic\');');
  return file;
}

function run(args, env = {}) {
  return spawnSync('bash', [script, ...args], {
    cwd: root,
    encoding: 'utf8',
    timeout: 15_000,
    env: { ...process.env, HOME: env.HOME || process.env.HOME, ...env },
  });
}

function outputPath(result) {
  return result.stdout.trim().split('\n').at(-1);
}

test('creates a mandatory-verified backup with 0700/0600 modes', (t) => {
  const dir = sandbox(t);
  const db = sourceDb(dir);
  const out = path.join(dir, 'backups');
  const result = run(['--db', db, '--out-dir', out, '--label', 'synthetic']);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /verify : integrity ok/);
  const backup = outputPath(result);
  assert.equal(fs.statSync(out).mode & 0o777, 0o700);
  assert.equal(fs.statSync(backup).mode & 0o777, 0o600);
  assert.equal(fs.lstatSync(backup).isSymbolicLink(), false);
  assert.equal(sqlite(backup, 'PRAGMA integrity_check;'), 'ok');
  assert.equal(sqlite(backup, 'SELECT value FROM sample;'), 'synthetic');
});

test('rejects a symlinked output path and a noncanonical label', (t) => {
  const dir = sandbox(t);
  const db = sourceDb(dir);
  const real = path.join(dir, 'real');
  const link = path.join(dir, 'link');
  fs.mkdirSync(real, { mode: 0o700 });
  fs.symlinkSync(real, link);

  const symlinked = run(['--db', db, '--out-dir', link]);
  assert.equal(symlinked.status, 2);
  assert.match(symlinked.stderr, /without symlink components/);
  assert.deepEqual(fs.readdirSync(real), []);

  const badLabel = run(['--db', db, '--out-dir', path.join(dir, 'out'), '--label', '../escape']);
  assert.equal(badLabel.status, 1);
  assert.match(badLabel.stderr, /canonical characters/);
});

test('retention keeps the newly verified backup and only the newest predecessors', (t) => {
  const dir = sandbox(t);
  const db = sourceDb(dir);
  const out = path.join(dir, 'backups');
  fs.mkdirSync(out, { mode: 0o700 });

  const old = [];
  for (let i = 0; i < 5; i += 1) {
    const file = path.join(out, `source-2030010${i + 1}T000000Z-old.sqlite`);
    fs.copyFileSync(db, file, fs.constants.COPYFILE_EXCL);
    fs.chmodSync(file, 0o600);
    const time = new Date(Date.UTC(2030, 0, i + 1));
    fs.utimesSync(file, time, time);
    old.push(file);
  }

  const result = run(['--db', db, '--out-dir', out, '--label', 'new'], {
    NASSAJ_BACKUP_RETENTION: '3',
  });
  assert.equal(result.status, 0, result.stderr);
  const backup = outputPath(result);
  const kept = fs.readdirSync(out).filter((name) => name.endsWith('.sqlite'));
  assert.equal(kept.length, 3);
  assert.equal(fs.existsSync(backup), true);
  assert.equal(fs.existsSync(old[4]), true);
  assert.equal(fs.existsSync(old[3]), true);
  assert.equal(fs.existsSync(old[0]), false);
});

test('a failed backup does not rotate previously retained files', (t) => {
  const dir = sandbox(t);
  const db = path.join(dir, 'broken.sqlite');
  const out = path.join(dir, 'backups');
  fs.writeFileSync(db, 'not a sqlite database', { mode: 0o600 });
  fs.mkdirSync(out, { mode: 0o700 });
  const prior = path.join(out, 'broken-20300101T000000Z-good.sqlite');
  fs.writeFileSync(prior, 'retained evidence', { mode: 0o600 });

  const result = run(['--db', db, '--out-dir', out], { NASSAJ_BACKUP_RETENTION: '1' });
  assert.notEqual(result.status, 0);
  assert.equal(fs.readFileSync(prior, 'utf8'), 'retained evidence');
  assert.deepEqual(fs.readdirSync(out), [path.basename(prior)]);
});

test('source contains fail-closed ownership, fsync, and creation-time mode contracts', () => {
  const source = fs.readFileSync(script, 'utf8');
  assert.match(source, /umask 077/);
  assert.match(source, /stat -c '%u'/);
  assert.match(source, /fs\.fsyncSync/);
  assert.match(source, /integrity_check/);
  assert.match(source, /ordered\[0\]\?\.file !== target/);
});
