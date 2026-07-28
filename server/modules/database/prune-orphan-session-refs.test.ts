/**
 * Tests for B-149: pruneOrphanSessionRefs.
 *
 * message_authors and starred_sessions intentionally carry NO foreign key on
 * session_id and are never cleaned when a session is deleted, so they grow
 * unbounded. pruneOrphanSessionRefs removes rows whose session is genuinely gone
 * (NOT EXISTS in sessions) AND older than a grace window, so:
 *  - orphaned + old rows are deleted,
 *  - live rows (session still present) are kept,
 *  - orphaned + recent rows are kept (they may reference a session whose row has
 *    not been lazily synced yet — the documented transient-absence contract).
 */

import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, getConnection } from '@/modules/database/connection.js';
import { initializeDatabase } from '@/modules/database/init-db.js';
import { pruneOrphanSessionRefs } from '@/modules/database/migrations.js';
import { userDb } from '@/modules/database/repositories/users.js';

async function withIsolatedDatabase(runTest: () => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'orphan-prune-'));
  const databasePath = path.join(tempDirectory, 'auth.db');
  // Pre-create the file so the legacy-DB copy in connection.ts is skipped and we
  // start from a truly empty, isolated database.
  await writeFile(databasePath, '');

  closeConnection();
  process.env.DATABASE_PATH = databasePath;
  await initializeDatabase();

  try {
    await runTest();
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

// 30 days old — comfortably beyond the 7-day grace window.
const OLD_ISO = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
const NOW_ISO = new Date().toISOString();

test('B-149: prunes orphaned+old rows, keeps live and recent-orphan rows', async () => {
  await withIsolatedDatabase(() => {
    const db = getConnection();
    const user = userDb.createUser('starrer', 'hash', 'user');

    // Only 'live' exists in sessions; 'gone'/'gone2' are orphans.
    db.prepare(`INSERT INTO sessions (session_id) VALUES ('live')`).run();

    // message_authors: created_at is ISO-8601 (matches the app's toISOString()).
    const insMA = db.prepare(
      `INSERT INTO message_authors (session_id, user_id, content_hash, created_at)
       VALUES (?, ?, ?, ?)`
    );
    insMA.run('live', user.id, 'h-live', OLD_ISO); // live → keep
    insMA.run('gone', user.id, 'h-old-orphan', OLD_ISO); // orphan + old → delete
    insMA.run('gone', user.id, 'h-recent-orphan', NOW_ISO); // orphan + recent → keep

    // starred_sessions: created_at is CURRENT_TIMESTAMP form ("YYYY-MM-DD HH:MM:SS").
    const insSSOld = db.prepare(
      `INSERT INTO starred_sessions (user_id, session_id, created_at)
       VALUES (?, ?, datetime('now', '-30 days'))`
    );
    const insSSNow = db.prepare(
      `INSERT INTO starred_sessions (user_id, session_id, created_at)
       VALUES (?, ?, datetime('now'))`
    );
    insSSOld.run(user.id, 'live'); // live + old → keep
    insSSOld.run(user.id, 'gone'); // orphan + old → delete
    insSSNow.run(user.id, 'gone2'); // orphan + recent → keep

    pruneOrphanSessionRefs(db);

    const maHashes = (
      db.prepare('SELECT content_hash FROM message_authors ORDER BY content_hash').all() as {
        content_hash: string;
      }[]
    ).map((r) => r.content_hash);
    assert.deepEqual(maHashes, ['h-live', 'h-recent-orphan']);

    const ssIds = (
      db.prepare('SELECT session_id FROM starred_sessions ORDER BY session_id').all() as {
        session_id: string;
      }[]
    ).map((r) => r.session_id);
    assert.deepEqual(ssIds, ['gone2', 'live']);
  });
});

test('B-149: is a no-op second pass and never touches live data', async () => {
  await withIsolatedDatabase(() => {
    const db = getConnection();
    const user = userDb.createUser('u', 'hash', 'user');
    db.prepare(`INSERT INTO sessions (session_id) VALUES ('s')`).run();
    db.prepare(
      `INSERT INTO message_authors (session_id, user_id, content_hash, created_at)
       VALUES ('s', ?, 'h', ?)`
    ).run(user.id, OLD_ISO);
    db.prepare(
      `INSERT INTO starred_sessions (user_id, session_id, created_at)
       VALUES (?, 's', datetime('now', '-30 days'))`
    ).run(user.id);

    pruneOrphanSessionRefs(db);
    pruneOrphanSessionRefs(db);

    assert.equal(
      (db.prepare('SELECT COUNT(*) c FROM message_authors').get() as { c: number }).c,
      1,
      'live message_authors row must remain'
    );
    assert.equal(
      (db.prepare('SELECT COUNT(*) c FROM starred_sessions').get() as { c: number }).c,
      1,
      'live starred_sessions row must remain'
    );
  });
});
