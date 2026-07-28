import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import Database from 'better-sqlite3';

import {
  closeConnection,
  initializeDatabase,
  sessionsDb,
  userDb,
} from '@/modules/database/index.js';

import { OpenCodeSessionSynchronizer } from './opencode-session-synchronizer.provider.js';

const patchHomeDir = (nextHomeDir: string) => {
  const original = os.homedir;
  (os as any).homedir = () => nextHomeDir;
  return () => {
    (os as any).homedir = original;
  };
};

async function withIsolatedDatabase(runTest: () => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'opencode-dedup-db-'));
  const databasePath = path.join(tempDirectory, 'auth.db');

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

type SeedSession = {
  id: string;
  parentId: string | null;
  title: string;
  timeCreated: number;
  timeUpdated: number;
  model?: string;
};

/**
 * Builds an opencode.db under <homeDir>/.local/share/opencode with the given sessions.
 * Schema mirrors the real opencode `session` table (parent_id present) so the B-172
 * child-fold path is exercised against a faithful shape.
 */
const createOpenCodeDatabase = async (
  homeDir: string,
  workspacePath: string,
  sessions: SeedSession[],
): Promise<void> => {
  const dataDir = path.join(homeDir, '.local', 'share', 'opencode');
  await mkdir(dataDir, { recursive: true });

  const db = new Database(path.join(dataDir, 'opencode.db'));
  try {
    db.exec(`
      CREATE TABLE project (
        id TEXT PRIMARY KEY,
        worktree TEXT NOT NULL,
        time_created INTEGER NOT NULL,
        time_updated INTEGER NOT NULL,
        sandboxes TEXT NOT NULL
      );

      CREATE TABLE session (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        parent_id TEXT,
        slug TEXT NOT NULL,
        directory TEXT NOT NULL,
        title TEXT NOT NULL,
        version TEXT NOT NULL,
        model TEXT,
        time_created INTEGER NOT NULL,
        time_updated INTEGER NOT NULL,
        time_archived INTEGER,
        FOREIGN KEY (project_id) REFERENCES project(id) ON DELETE CASCADE
      );

      CREATE TABLE message (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        time_created INTEGER NOT NULL,
        time_updated INTEGER NOT NULL,
        data TEXT NOT NULL
      );

      CREATE TABLE part (
        id TEXT PRIMARY KEY,
        message_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        time_created INTEGER NOT NULL,
        time_updated INTEGER NOT NULL,
        data TEXT NOT NULL
      );
    `);

    db.prepare(
      'INSERT INTO project (id, worktree, time_created, time_updated, sandboxes) VALUES (?, ?, ?, ?, ?)',
    ).run('project-1', workspacePath, 1_700_000_000_000, 1_700_000_001_000, '[]');

    const insertSession = db.prepare(`
      INSERT INTO session (
        id, project_id, parent_id, slug, directory, title, version, model,
        time_created, time_updated, time_archived
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    for (const session of sessions) {
      insertSession.run(
        session.id,
        'project-1',
        session.parentId,
        session.id,
        workspacePath,
        session.title,
        '0.0.0',
        session.model ?? null,
        session.timeCreated,
        session.timeUpdated,
        null,
      );
    }
  } finally {
    db.close();
  }
};

test('B-172: opencode child sessions (non-null parent_id) are folded, never indexed as own rows', { concurrency: false }, async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'opencode-dedup-'));
  const workspacePath = path.join(tempRoot, 'workspace');
  await mkdir(workspacePath, { recursive: true });
  const restoreHomeDir = patchHomeDir(tempRoot);

  try {
    // One top-level GLM carrier conversation plus TWO subagent children under it.
    await createOpenCodeDatabase(tempRoot, workspacePath, [
      {
        id: 'ses_parent',
        parentId: null,
        title: 'GLM carrier conversation',
        timeCreated: 1_700_000_000_000,
        timeUpdated: 1_700_000_000_500,
        model: JSON.stringify({ id: 'glm-5.2', providerID: 'glm' }),
      },
      {
        id: 'ses_child_a',
        parentId: 'ses_parent',
        title: 'GLM carrier conversation',
        timeCreated: 1_700_000_001_000,
        timeUpdated: 1_700_000_002_000,
        model: JSON.stringify({ id: 'glm-5.2', providerID: 'glm' }),
      },
      {
        id: 'ses_child_b',
        parentId: 'ses_parent',
        title: 'GLM carrier conversation',
        timeCreated: 1_700_000_001_500,
        timeUpdated: 1_700_000_003_000,
        model: JSON.stringify({ id: 'glm-5.2', providerID: 'glm' }),
      },
    ]);

    await withIsolatedDatabase(async () => {
      const synchronizer = new OpenCodeSessionSynchronizer();
      const processed = await synchronizer.synchronize();

      // Exactly ONE row indexed (the parent) — the two children are folded away.
      assert.equal(processed, 1);
      assert.ok(sessionsDb.getSessionById('ses_parent'), 'parent conversation must be indexed');
      assert.equal(sessionsDb.getSessionById('ses_child_a'), null, 'child A must not get its own row');
      assert.equal(sessionsDb.getSessionById('ses_child_b'), null, 'child B must not get its own row');

      // The parent's freshness is bumped to the newest child activity (best-effort).
      const parent = sessionsDb.getSessionById('ses_parent');
      const bumped = new Date(parent?.updated_at ?? 0).getTime();
      assert.ok(
        bumped >= 1_700_000_003_000,
        `parent updated_at (${parent?.updated_at}) must be bumped to the newest child activity`,
      );
    });
  } finally {
    restoreHomeDir();
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('B-172: an idempotent rescan never inflates rows and a folded child never creates a row', { concurrency: false }, async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'opencode-dedup-rescan-'));
  const workspacePath = path.join(tempRoot, 'workspace');
  await mkdir(workspacePath, { recursive: true });
  const restoreHomeDir = patchHomeDir(tempRoot);

  try {
    await createOpenCodeDatabase(tempRoot, workspacePath, [
      {
        id: 'ses_root',
        parentId: null,
        title: 'Root conversation',
        timeCreated: 1_700_000_000_000,
        timeUpdated: 1_700_000_000_500,
      },
      {
        id: 'ses_sub',
        parentId: 'ses_root',
        title: 'Root conversation',
        timeCreated: 1_700_000_001_000,
        timeUpdated: 1_700_000_002_000,
      },
    ]);

    await withIsolatedDatabase(async () => {
      // An owner exists so the externally-created session is attributed a participant
      // (T-857) and thus counts as a NATIVE session in countSessionsByProjectPath.
      userDb.createUser(`u_owner_${Date.now()}`, 'hash', 'owner');

      const synchronizer = new OpenCodeSessionSynchronizer();
      const first = await synchronizer.synchronize();
      const second = await synchronizer.synchronize();

      assert.equal(first, 1);
      assert.equal(second, 1, 'a repeat scan still indexes exactly the one parent row');
      assert.equal(sessionsDb.countSessionsByProjectPath(workspacePath), 1, 'no duplicate/child rows accrue');
      assert.equal(sessionsDb.getSessionById('ses_sub'), null, 'folded child never materializes across rescans');
    });
  } finally {
    restoreHomeDir();
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('B-172: an ORPHAN child (parent absent) is folded silently and creates no row', { concurrency: false }, async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'opencode-dedup-orphan-'));
  const workspacePath = path.join(tempRoot, 'workspace');
  await mkdir(workspacePath, { recursive: true });
  const restoreHomeDir = patchHomeDir(tempRoot);

  try {
    // A child whose parent is not present in this store (e.g. archived/pruned parent).
    await createOpenCodeDatabase(tempRoot, workspacePath, [
      {
        id: 'ses_orphan_child',
        parentId: 'ses_missing_parent',
        title: 'Orphan child',
        timeCreated: 1_700_000_001_000,
        timeUpdated: 1_700_000_002_000,
      },
    ]);

    await withIsolatedDatabase(async () => {
      const synchronizer = new OpenCodeSessionSynchronizer();
      const processed = await synchronizer.synchronize();

      assert.equal(processed, 0, 'an orphan child indexes nothing');
      assert.equal(sessionsDb.getSessionById('ses_orphan_child'), null, 'orphan child gets no row');
      assert.equal(sessionsDb.getSessionById('ses_missing_parent'), null, 'bump never resurrects a missing parent');
    });
  } finally {
    restoreHomeDir();
    await rm(tempRoot, { recursive: true, force: true });
  }
});
