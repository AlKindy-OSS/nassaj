/**
 * migrations.engine-pin.test.ts — ADR-088 (B-258/B-262) persistence tests.
 *
 * Covers the review's blocking items on the DB layer:
 *  - write discipline of setSessionEnginePin (first-verdict-wins, inferred→verdict
 *    upgrade, official never laundering an inferred engine pin, missing-row
 *    reported not silent) — qa-critic حرج 1/2, بند 7;
 *  - the sessions-table REBUILD preserves the pin (حرج 12);
 *  - PRAGMA table_info(sessions) matches the shared SELECT column list, so no
 *    reader can silently drop a column again (بند 13);
 *  - migration idempotence (three fleet nodes will run it repeatedly);
 *  - the background-synchronizer upsert (createSession ON CONFLICT) does NOT
 *    wipe the pin (بند 14 — the isArchived/B-161 lesson).
 */

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, getConnection } from '@/modules/database/connection.js';
import { initializeDatabase } from '@/modules/database/init-db.js';
import { runMigrations } from '@/modules/database/migrations.js';
import { stopReconcileScheduler } from '@/modules/database/project-reconcile.service.js';
import { sessionsDb } from '@/modules/database/repositories/sessions.db.js';

async function withIsolatedDatabase(runTest: () => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'engine-pin-migration-'));
  const databasePath = path.join(tempDirectory, 'auth.db');

  closeConnection();
  process.env.DATABASE_PATH = databasePath;
  await initializeDatabase();
  stopReconcileScheduler();

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

// ---------------------------------------------------------------------------
// Column presence + reader completeness
// ---------------------------------------------------------------------------

test('sessions carries engine_provider/engine_provider_source after migration', async () => {
  await withIsolatedDatabase(() => {
    const db = getConnection();
    const cols = (db.prepare('PRAGMA table_info(sessions)').all() as { name: string }[])
      .map((c) => c.name);
    assert.ok(cols.includes('engine_provider'));
    assert.ok(cols.includes('engine_provider_source'));
  });
});

test('GUARD (بند 13): every sessions column is read back by getSessionById — no silently dropped columns', async () => {
  await withIsolatedDatabase(() => {
    const db = getConnection();
    sessionsDb.createSession('guard-cols', 'claude', '/tmp/proj-guard');
    const tableCols = (db.prepare('PRAGMA table_info(sessions)').all() as { name: string }[])
      .map((c) => c.name)
      .sort();
    const row = sessionsDb.getSessionById('guard-cols');
    assert.ok(row);
    const readCols = Object.keys(row as object).sort();
    // Generalized guard: ANY future column added to the table but not to the
    // shared SELECT list fails here — this is how the engine axis was lost
    // client-side in the first place.
    assert.deepEqual(readCols, tableCols);
  });
});

// ---------------------------------------------------------------------------
// setSessionEnginePin write discipline
// ---------------------------------------------------------------------------

test('first verdict wins; a second verdict never overwrites it', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createSession('pin-a', 'claude', '/tmp/proj-a');
    assert.equal(sessionsDb.setSessionEnginePin('pin-a', 'kimi', 'server_verdict').outcome, 'written');
    const second = sessionsDb.setSessionEnginePin('pin-a', 'anthropic', 'server_verdict');
    assert.equal(second.outcome, 'kept');
    assert.equal(second.engine, 'kimi');
  });
});

test('inferred pin upgrades to a SERVER ENGINE verdict…', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createSession('pin-b', 'claude', '/tmp/proj-b');
    sessionsDb.setSessionEnginePin('pin-b', 'kimi', 'inferred');
    const upgraded = sessionsDb.setSessionEnginePin('pin-b', 'kimi', 'server_verdict');
    assert.equal(upgraded.outcome, 'upgraded');
    assert.equal(sessionsDb.getSessionEnginePin('pin-b')?.source, 'server_verdict');
  });
});

test('…but an OFFICIAL verdict never launders an inferred engine pin (حرج 1)', async () => {
  await withIsolatedDatabase(() => {
    // The leak scenario: inferred kimi pin, then (enforcement off) a leaked
    // official turn runs and reports its verdict. The pin must survive.
    sessionsDb.createSession('pin-c', 'claude', '/tmp/proj-c');
    sessionsDb.setSessionEnginePin('pin-c', 'kimi', 'inferred');
    const attempt = sessionsDb.setSessionEnginePin('pin-c', 'anthropic', 'server_verdict');
    assert.equal(attempt.outcome, 'kept');
    assert.equal(attempt.engine, 'kimi');
  });
});

test('missing sessions row is reported, not silent (بند 7 — anon/system spawns)', async () => {
  await withIsolatedDatabase(() => {
    const result = sessionsDb.setSessionEnginePin('no-such-row', 'kimi', 'server_verdict');
    assert.equal(result.outcome, 'missing_row');
    assert.equal(result.engine, null);
  });
});

test('createSession upsert (background synchronizers) does NOT wipe the pin (بند 14)', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createSession('pin-d', 'claude', '/tmp/proj-d');
    sessionsDb.setSessionEnginePin('pin-d', 'glm', 'server_verdict');
    // A rescan re-upserts the same session (the B-161 shape).
    sessionsDb.createSession('pin-d', 'claude', '/tmp/proj-d', 'renamed', undefined, undefined, '/tmp/x.jsonl');
    assert.equal(sessionsDb.getSessionEnginePin('pin-d')?.engine, 'glm');
  });
});

// ---------------------------------------------------------------------------
// Rebuild + idempotence
// ---------------------------------------------------------------------------

test('REBUILD (حرج 12): a legacy-shaped sessions table is rebuilt WITHOUT losing pins', async () => {
  await withIsolatedDatabase(() => {
    const db = getConnection();
    // Recreate the legacy shape that forces rebuildSessionsTableWithProjectSchema
    // down its full copy path: composite PK (the shouldRebuild trigger), but
    // already carrying engine columns with live pins.
    db.exec('PRAGMA foreign_keys = OFF');
    // Drop dependants first: with a composite-PK sessions table their FK target
    // no longer exists and SQLite reports "foreign key mismatch" the moment any
    // migration touches them. runMigrations recreates them all.
    for (const dependant of [
      'session_participants',
      'session_agents_cache',
      'session_agents_meta',
      'starred_sessions',
      'closed_sessions',
      'response_turn_metrics',
      'scheduled_messages',
      // ADR-187 room tables (created by the last migration, never on a legacy DB).
      'session_internal_message_mentions',
      'session_internal_messages',
      'session_internal_room_members',
      'session_internal_rooms',
    ]) {
      db.exec(`DROP TABLE IF EXISTS ${dependant}`);
    }
    db.exec('DROP TABLE IF EXISTS sessions');
    db.exec(`
      CREATE TABLE sessions (
        session_id TEXT NOT NULL,
        provider TEXT NOT NULL DEFAULT 'claude',
        custom_name TEXT,
        project_path TEXT,
        jsonl_path TEXT,
        engine_provider TEXT DEFAULT NULL,
        engine_provider_source TEXT DEFAULT NULL,
        isArchived BOOLEAN DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (session_id, provider)
      )
    `);
    db.prepare(
      `INSERT OR IGNORE INTO projects (project_id, project_path, isStarred, isArchived)
       VALUES ('proj-r-id', '/tmp/proj-r', 0, 0)`
    ).run();
    db.prepare(
      `INSERT INTO sessions (session_id, provider, project_path, engine_provider, engine_provider_source)
       VALUES ('rebuilt-1', 'claude', '/tmp/proj-r', 'kimi', 'server_verdict')`
    ).run();
    db.exec('PRAGMA foreign_keys = ON');
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), [],
      'the legacy fixture must be internally valid before running migrations');

    runMigrations(db);

    const pin = sessionsDb.getSessionEnginePin('rebuilt-1');
    assert.equal(pin?.engine, 'kimi');
    assert.equal(pin?.source, 'server_verdict');
    // And the rebuilt table really went through the copy path (single-column PK now).
    const pk = (db.prepare('PRAGMA table_info(sessions)').all() as { name: string; pk: number }[])
      .filter((c) => c.pk > 0);
    assert.deepEqual(pk.map((c) => c.name), ['session_id']);
  });
});

test('idempotence: running migrations twice keeps data intact (fleet nodes rerun it)', async () => {
  await withIsolatedDatabase(() => {
    const db = getConnection();
    sessionsDb.createSession('pin-e', 'claude', '/tmp/proj-e');
    sessionsDb.setSessionEnginePin('pin-e', 'kimi', 'inferred');
    runMigrations(db);
    runMigrations(db);
    const pin = sessionsDb.getSessionEnginePin('pin-e');
    assert.equal(pin?.engine, 'kimi');
    assert.equal(pin?.source, 'inferred');
  });
});
