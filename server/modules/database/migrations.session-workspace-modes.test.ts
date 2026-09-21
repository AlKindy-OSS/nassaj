import assert from 'node:assert/strict';
import test from 'node:test';

import BetterSqlite3 from 'better-sqlite3';

import { migrateSessionWorkspaceModes } from './migrations.js';
import {
  APP_CONFIG_TABLE_SCHEMA_SQL,
  PROJECTS_TABLE_SCHEMA_SQL,
  SESSIONS_TABLE_SCHEMA_SQL,
} from './schema.js';

function database() {
  const db = new BetterSqlite3(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(APP_CONFIG_TABLE_SCHEMA_SQL);
  db.exec(PROJECTS_TABLE_SCHEMA_SQL);
  db.exec(SESSIONS_TABLE_SCHEMA_SQL);
  return db;
}

function addSession(db: BetterSqlite3.Database, id: string, projectPath: string): void {
  db.prepare(`INSERT INTO projects
    (project_id, project_path, custom_project_name, detected_name)
    VALUES (?, ?, NULL, ?)`
  ).run(`project-${id}`, projectPath, id);
  db.prepare(`INSERT INTO sessions (session_id, provider, project_path)
    VALUES (?, 'codex', ?)`
  ).run(id, projectPath);
}

test('workspace mode migration snapshots existing sessions exactly once', () => {
  const db = database();
  try {
    addSession(db, 'before', '/srv/before');
    migrateSessionWorkspaceModes(db);
    assert.deepEqual(
      db.prepare('SELECT session_id, mode, project_path, provider FROM session_workspace_modes').all(),
      [{ session_id: 'before', mode: 'legacy_shared', project_path: '/srv/before', provider: 'codex' }],
    );

    addSession(db, 'after', '/srv/after');
    migrateSessionWorkspaceModes(db);
    assert.equal(
      (db.prepare('SELECT count(*) AS count FROM session_workspace_modes').get() as { count: number }).count,
      1,
    );
  } finally {
    db.close();
  }
});

test('workspace mode migration marks a fresh database without classifying later sessions', () => {
  const db = database();
  try {
    migrateSessionWorkspaceModes(db);
    addSession(db, 'later', '/srv/later');
    migrateSessionWorkspaceModes(db);
    assert.equal(
      (db.prepare('SELECT count(*) AS count FROM session_workspace_modes').get() as { count: number }).count,
      0,
    );
  } finally {
    db.close();
  }
});

test('workspace mode migration removes the experimental sessions foreign key without data loss', () => {
  const db = database();
  try {
    addSession(db, 'bound', '/srv/bound');
    db.exec(`
      CREATE TABLE session_workspace_modes (
        session_id TEXT PRIMARY KEY,
        mode TEXT NOT NULL,
        project_path TEXT NOT NULL,
        provider TEXT NOT NULL,
        classified_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (session_id) REFERENCES sessions(session_id) ON DELETE CASCADE
      );
      INSERT INTO session_workspace_modes(session_id, mode, project_path, provider)
      VALUES ('bound', 'overlay', '/srv/bound', 'codex');
    `);
    migrateSessionWorkspaceModes(db);
    assert.equal(db.prepare('PRAGMA foreign_key_list(session_workspace_modes)').all().length, 0);
    assert.deepEqual(
      db.prepare(`SELECT session_id, mode FROM session_workspace_modes
        WHERE session_id = 'bound'`).get(),
      { session_id: 'bound', mode: 'overlay' },
    );
  } finally {
    db.close();
  }
});
