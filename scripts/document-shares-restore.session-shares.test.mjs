import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import Database from 'better-sqlite3';
import { disableRestoredShareTables, disableRestoredShares } from './document-shares-restore.mjs';

test('offline restore also disables session shares and drops their snapshot blobs', (t) => {
  const directory = mkdtempSync(path.join(process.cwd(), 'session-restore-test-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'restored.sqlite');
  const db = new Database(file);
  db.exec(`CREATE TABLE document_shares (id TEXT, revoked_at TEXT);
    CREATE TABLE session_shares (id TEXT, revoked_at TEXT, revoke_reason TEXT, snapshot BLOB);
    INSERT INTO document_shares VALUES ('doc', NULL);
    INSERT INTO session_shares VALUES ('live', NULL, NULL, x'1f8b'), ('old', '2020-01-01', 'manual', x'1f8b')`);
  db.close();
  assert.deepEqual(disableRestoredShareTables(file), { documentShares: 1, sessionShares: 2 });
  const reopened = new Database(file);
  const rows = reopened.prepare('SELECT id, revoked_at, revoke_reason, snapshot FROM session_shares ORDER BY id').all();
  reopened.close();
  assert.equal(rows.every((row) => row.snapshot === null && row.revoked_at), true);
  assert.equal(rows.find((row) => row.id === 'old').revoked_at, '2020-01-01');
  assert.equal(rows.find((row) => row.id === 'old').revoke_reason, 'manual');
  assert.equal(rows.find((row) => row.id === 'live').revoke_reason, 'restored');
});

test('a restored copy with only session shares is disabled and counted', (t) => {
  const directory = mkdtempSync(path.join(process.cwd(), 'session-restore-test-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'restored.sqlite');
  const db = new Database(file);
  db.exec("CREATE TABLE session_shares (id TEXT, revoked_at TEXT, revoke_reason TEXT, snapshot BLOB); INSERT INTO session_shares VALUES ('a', NULL, NULL, x'00')");
  db.close();
  assert.equal(disableRestoredShares(file), 1);
});

test('a restored copy with live shares (ADR-205) also loses every ref_key', (t) => {
  const directory = mkdtempSync(path.join(process.cwd(), 'session-restore-test-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'restored.sqlite');
  const db = new Database(file);
  db.exec(`CREATE TABLE session_shares (id TEXT, revoked_at TEXT, revoke_reason TEXT, snapshot BLOB,
    mode TEXT, ref_key BLOB); INSERT INTO session_shares VALUES ('l', NULL, NULL, NULL, 'live', x'07')`);
  db.close();
  assert.equal(disableRestoredShares(file), 1);
  const reopened = new Database(file);
  const row = reopened.prepare("SELECT ref_key, revoked_at FROM session_shares WHERE id='l'").get();
  reopened.close();
  assert.equal(row.ref_key, null);
  assert.ok(row.revoked_at);
});
