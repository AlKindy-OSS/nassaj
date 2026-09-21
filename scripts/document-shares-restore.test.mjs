import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import Database from 'better-sqlite3';
import { disableRestoredShares } from './document-shares-restore.mjs';

test('offline restore disables capabilities and refuses open/live or symlink copies', (t) => {
  const directory = mkdtempSync(path.join(process.cwd(), 'document-restore-test-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'restored.sqlite');
  const db = new Database(file);
  db.exec("CREATE TABLE document_shares (id TEXT, revoked_at TEXT); INSERT INTO document_shares VALUES ('before-backup', NULL), ('revoked-before-backup','2020-01-01')");
  assert.throws(() => disableRestoredShares(file), /is_open/);
  db.close();
  assert.equal(disableRestoredShares(file), 2);
  const reopened = new Database(file);
  assert.equal(reopened.prepare('SELECT COUNT(*) AS count FROM document_shares WHERE revoked_at IS NULL').get().count, 0);
  assert.equal(reopened.prepare("SELECT revoked_at FROM document_shares WHERE id='revoked-before-backup'").get().revoked_at, '2020-01-01');
  reopened.close();
  const link = path.join(directory, 'link.sqlite');
  symlinkSync(file, link);
  assert.throws(() => disableRestoredShares(link), /unsafe/);
  assert.throws(() => disableRestoredShares('relative.sqlite'), /absolute/);
});
