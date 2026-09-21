/**
 * Regression tests for B-148.
 *
 * migrateSessionAgentsCascade rebuilds session_agents_cache to add ON DELETE
 * CASCADE via the SQLite rename-and-rebuild pattern. The rebuild previously
 * recreated the table with only four columns and copied only four, silently
 * dropping the later-added `agent_model` column and any resolved model values
 * it held. These tests pin the fix: the rebuild must preserve agent_model data
 * when the source carries it, add the column (NULL) when a legacy DB lacks it,
 * and still install a working ON DELETE CASCADE.
 */

import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, getConnection } from '@/modules/database/connection.js';
import { initializeDatabase } from '@/modules/database/init-db.js';
import { migrateSessionAgentsCascade } from '@/modules/database/migrations.js';

type Db = ReturnType<typeof getConnection>;

async function withIsolatedDatabase(runTest: () => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'sac-cascade-'));
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

/**
 * Replaces the (already-migrated) session_agents_cache with a legacy-shape table
 * that has NO foreign key to sessions, so migrateSessionAgentsCascade sees the
 * rebuild as needed. `withModel` toggles whether the legacy table carries the
 * agent_model column (older databases predate it).
 */
function installLegacyCache(db: Db, withModel: boolean): void {
  db.exec('DROP TABLE IF EXISTS session_agents_cache');
  db.exec(
    withModel
      ? `CREATE TABLE session_agents_cache (
           session_id TEXT NOT NULL,
           agent_name TEXT NOT NULL,
           agent_kind TEXT NOT NULL,
           invocation_count INTEGER DEFAULT 1,
           agent_model TEXT DEFAULT NULL,
           PRIMARY KEY (session_id, agent_name, agent_kind)
         )`
      : `CREATE TABLE session_agents_cache (
           session_id TEXT NOT NULL,
           agent_name TEXT NOT NULL,
           agent_kind TEXT NOT NULL,
           invocation_count INTEGER DEFAULT 1,
           PRIMARY KEY (session_id, agent_name, agent_kind)
         )`
  );
}

function cacheColumns(db: Db): string[] {
  return (db.prepare('PRAGMA table_info(session_agents_cache)').all() as { name: string }[]).map(
    (c) => c.name
  );
}

function cacheHasCascade(db: Db): boolean {
  const fks = db.prepare('PRAGMA foreign_key_list(session_agents_cache)').all() as {
    table: string;
    on_delete: string;
  }[];
  const sessionFk = fks.find((r) => r.table === 'sessions');
  return sessionFk !== undefined && sessionFk.on_delete === 'CASCADE';
}

test('B-148: cascade rebuild preserves agent_model values when the column exists', async () => {
  await withIsolatedDatabase(() => {
    const db = getConnection();
    installLegacyCache(db, true);

    db.prepare(`INSERT INTO sessions (session_id) VALUES ('s1')`).run();
    db.prepare(
      `INSERT INTO session_agents_cache
         (session_id, agent_name, agent_kind, invocation_count, agent_model)
       VALUES ('s1', 'model', 'model', 3, 'claude-opus-4-8')`
    ).run();
    db.prepare(
      `INSERT INTO session_agents_cache
         (session_id, agent_name, agent_kind, invocation_count, agent_model)
       VALUES ('s1', 'backend-dev', 'subagent', 1, 'sonnet-5')`
    ).run();

    // Sanity: the legacy table has no CASCADE yet, so the rebuild must run.
    assert.equal(cacheHasCascade(db), false, 'precondition: legacy table lacks CASCADE');

    migrateSessionAgentsCascade(db);

    // CASCADE was installed...
    assert.equal(cacheHasCascade(db), true, 'FK should now be ON DELETE CASCADE');
    // ...and the agent_model DATA survived the rebuild (the actual B-148 bug).
    const rows = db
      .prepare(
        `SELECT agent_name, invocation_count, agent_model
         FROM session_agents_cache
         WHERE session_id = 's1'
         ORDER BY agent_name`
      )
      .all() as { agent_name: string; invocation_count: number; agent_model: string | null }[];
    assert.deepEqual(rows, [
      { agent_name: 'backend-dev', invocation_count: 1, agent_model: 'sonnet-5' },
      { agent_name: 'model', invocation_count: 3, agent_model: 'claude-opus-4-8' },
    ]);
  });
});

test('B-148: cascade rebuild adds agent_model (NULL) when a legacy DB lacks it', async () => {
  await withIsolatedDatabase(() => {
    const db = getConnection();
    installLegacyCache(db, false);

    assert.equal(cacheColumns(db).includes('agent_model'), false, 'precondition: no agent_model');

    db.prepare(`INSERT INTO sessions (session_id) VALUES ('s2')`).run();
    db.prepare(
      `INSERT INTO session_agents_cache
         (session_id, agent_name, agent_kind, invocation_count)
       VALUES ('s2', 'model', 'model', 5)`
    ).run();

    migrateSessionAgentsCascade(db);

    assert.equal(
      cacheColumns(db).includes('agent_model'),
      true,
      'agent_model column should exist after rebuild'
    );
    const row = db
      .prepare(
        `SELECT invocation_count, agent_model
         FROM session_agents_cache
         WHERE session_id = 's2' AND agent_name = 'model'`
      )
      .get() as { invocation_count: number; agent_model: string | null };
    assert.equal(row.invocation_count, 5, 'existing data preserved');
    assert.equal(row.agent_model, null, 'newly added column defaults to NULL');
    assert.equal(cacheHasCascade(db), true);
  });
});

test('B-148: after rebuild, deleting a session cascade-clears only its cache rows', async () => {
  await withIsolatedDatabase(() => {
    const db = getConnection();
    installLegacyCache(db, true);

    db.prepare(`INSERT INTO sessions (session_id) VALUES ('keep'), ('drop')`).run();
    db.prepare(
      `INSERT INTO session_agents_cache
         (session_id, agent_name, agent_kind, invocation_count, agent_model)
       VALUES ('keep', 'model', 'model', 1, 'm-keep'),
              ('drop', 'model', 'model', 1, 'm-drop')`
    ).run();

    migrateSessionAgentsCascade(db);

    // The migration leaves foreign_keys ON; assert explicitly so the delete cascades.
    db.pragma('foreign_keys = ON');
    db.prepare(`DELETE FROM sessions WHERE session_id = 'drop'`).run();

    const remaining = db
      .prepare(`SELECT session_id, agent_model FROM session_agents_cache ORDER BY session_id`)
      .all() as { session_id: string; agent_model: string | null }[];
    assert.deepEqual(remaining, [{ session_id: 'keep', agent_model: 'm-keep' }]);
  });
});
