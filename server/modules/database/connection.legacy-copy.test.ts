/**
 * B-973: the one-time legacy migration copies `<install>/database/auth.db` into
 * an absent target. The test-isolation guard admits temporary targets, so a test
 * run (or any synthetic temp path) used to receive a copy of the real legacy
 * database. Both cases must now open a fresh database instead. The legacy file
 * is only ever read by the code under test, never written here; when it is
 * absent a synthetic one is created and removed again.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import Database from 'better-sqlite3';

const legacyPath = path.resolve(import.meta.dirname, '..', '..', '..', 'database', 'auth.db');

/** Make sure some legacy database exists; returns a cleanup for one we created. */
function ensureLegacyDatabase(): () => void {
  if (fs.existsSync(legacyPath)) return () => {};
  fs.mkdirSync(path.dirname(legacyPath), { recursive: true });
  const db = new Database(legacyPath);
  db.exec('CREATE TABLE legacy_marker (id INTEGER PRIMARY KEY)');
  db.close();
  return () => { for (const suffix of ['', '-wal', '-shm']) fs.rmSync(legacyPath + suffix, { force: true }); };
}

/** Table names of a database file other than the eagerly created app_config. */
function foreignTables(file: string): string[] {
  const db = new Database(file, { readonly: true, fileMustExist: true });
  try {
    return (db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table'").all() as Array<{ name: string }>)
      .map(({ name }) => name).filter((name) => name !== 'app_config');
  } finally { db.close(); }
}

const tempRoot = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'legacy-copy-'));
const cleanupLegacy = ensureLegacyDatabase();
test.after(() => { cleanupLegacy(); fs.rmSync(tempRoot, { recursive: true, force: true }); });

test('a test run opens a fresh target instead of copying the legacy database', async () => {
  const target = path.join(tempRoot, 'in-process', 'auth.db');
  process.env.DATABASE_PATH = target;
  const { getConnection, closeConnection } = await import('./connection.js');
  const logged: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => { logged.push(args.map(String).join(' ')); };
  try { getConnection(); } finally { console.log = original; closeConnection(); }
  assert.ok(!logged.some((line) => line.includes('Migrated legacy database')), logged.join('\n'));
  assert.deepEqual(foreignTables(target), []);
});

test('outside a test runtime a temporary target is not seeded from the legacy database either', () => {
  const target = path.join(tempRoot, 'child', 'auth.db');
  const env: NodeJS.ProcessEnv = { ...process.env, NODE_ENV: 'production', DATABASE_PATH: target };
  delete env.NODE_TEST_CONTEXT;
  delete env.VITEST;
  const script = "const m = await import('./server/modules/database/connection.ts');"
    + ' m.getConnection(); m.closeConnection();';
  const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script],
    { cwd: path.resolve(import.meta.dirname, '..', '..', '..'), env, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stdout + result.stderr, /Migrated legacy database/);
  assert.deepEqual(foreignTables(target), []);
});
