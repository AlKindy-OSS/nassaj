import assert from 'node:assert/strict';
import test, { mock } from 'node:test';

import BetterSqlite3 from 'better-sqlite3';

import { SESSION_WORKSPACE_MODES_TABLE_SCHEMA_SQL } from '../schema.js';

const database = new BetterSqlite3(':memory:');
database.exec('CREATE TABLE sessions (session_id TEXT PRIMARY KEY)');
database.exec(SESSION_WORKSPACE_MODES_TABLE_SCHEMA_SQL);

mock.module('@/modules/database/connection.js', {
  namedExports: { getConnection: () => database },
});

const { sessionWorkspaceModesDb } = await import('./session-workspace-modes.db.js');

test('legacy eligibility requires an exact path/provider snapshot and rejects overlay mode', () => {
  database.prepare('INSERT INTO sessions(session_id) VALUES (?)').run('legacy');
  database.prepare(`INSERT INTO session_workspace_modes
    (session_id, mode, project_path, provider) VALUES (?, 'legacy_shared', ?, ?)`
  ).run('legacy', '/srv/repo', 'codex');

  assert.equal(
    sessionWorkspaceModesDb.readLegacyEligibility('legacy', '/srv/repo', 'codex')?.mode,
    'legacy_shared',
  );
  assert.equal(sessionWorkspaceModesDb.readLegacyEligibility('legacy', '/srv/other', 'codex'), null);
  assert.equal(sessionWorkspaceModesDb.readLegacyEligibility('legacy', '/srv/repo', 'claude'), null);

  sessionWorkspaceModesDb.markOverlay('legacy', '/srv/repo', 'codex');
  assert.equal(sessionWorkspaceModesDb.readLegacyEligibility('legacy', '/srv/repo', 'codex'), null);
});

test('markOverlay is monotonic and cannot downgrade an existing overlay', () => {
  database.prepare('INSERT INTO sessions(session_id) VALUES (?)').run('overlay');
  sessionWorkspaceModesDb.markOverlay('overlay', '/srv/first', 'codex');
  const first = database.prepare(`SELECT mode, classified_at FROM session_workspace_modes
    WHERE session_id = ?`).get('overlay') as { mode: string; classified_at: string };
  sessionWorkspaceModesDb.markOverlay('overlay', '/srv/second', 'claude');
  const second = database.prepare(`SELECT mode, project_path, provider, classified_at
    FROM session_workspace_modes WHERE session_id = ?`).get('overlay') as {
      mode: string; project_path: string; provider: string; classified_at: string;
    };
  assert.equal(second.mode, 'overlay');
  assert.equal(second.project_path, '/srv/second');
  assert.equal(second.provider, 'claude');
  assert.equal(second.classified_at, first.classified_at);
});

test('markOverlay succeeds before a sessions row exists with foreign keys enabled', () => {
  database.pragma('foreign_keys = ON');
  assert.doesNotThrow(() => {
    sessionWorkspaceModesDb.markOverlay('provider-first', '/srv/provider-first', 'codex');
  });
  assert.deepEqual(
    database.prepare(`SELECT session_id, mode FROM session_workspace_modes
      WHERE session_id = ?`).get('provider-first'),
    { session_id: 'provider-first', mode: 'overlay' },
  );
});

test('markShared is exact-idempotent and never downgrades or rewrites a binding', () => {
  sessionWorkspaceModesDb.markShared('shared', '/srv/shared', 'codex');
  assert.doesNotThrow(() => {
    sessionWorkspaceModesDb.markShared('shared', '/srv/shared', 'codex');
  });
  assert.throws(
    () => sessionWorkspaceModesDb.markShared('shared', '/srv/other', 'codex'),
    /conflicts with an existing classification/,
  );

  sessionWorkspaceModesDb.markOverlay('shared', '/srv/shared', 'codex');
  assert.throws(
    () => sessionWorkspaceModesDb.markShared('shared', '/srv/shared', 'codex'),
    /conflicts with an existing classification/,
  );
  assert.deepEqual(
    database.prepare(`SELECT mode, project_path, provider FROM session_workspace_modes
      WHERE session_id = ?`).get('shared'),
    { mode: 'overlay', project_path: '/srv/shared', provider: 'codex' },
  );
});

test.after(() => database.close());
