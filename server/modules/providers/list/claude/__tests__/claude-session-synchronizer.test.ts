import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import { ClaudeSessionSynchronizer } from '@/modules/providers/list/claude/claude-session-synchronizer.provider.js';

const SESSION_UUID = '11111111-2222-3333-4444-555555555555';
const PROJECT_PATH = '/workspace/demo-project';

const patchHomeDir = (nextHomeDir: string): (() => void) => {
  const original = os.homedir;
  (os as { homedir: () => string }).homedir = () => nextHomeDir;
  return () => {
    (os as { homedir: () => string }).homedir = original;
  };
};

/**
 * Sets up an isolated DB plus a fake `$HOME` so the synchronizer reads from a
 * disposable ~/.claude/projects directory. The DB is required because
 * synchronize() writes session rows through sessionsDb.createSession.
 */
async function withSyncFixture(
  populate: (projectsDir: string) => Promise<void> | void,
  runTest: (sync: ClaudeSessionSynchronizer, projectsDir: string) => Promise<void>,
): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempHome = await mkdtemp(path.join(os.tmpdir(), 'claude-sync-'));
  const databasePath = path.join(tempHome, 'auth.db');

  closeConnection();
  process.env.DATABASE_PATH = databasePath;
  await initializeDatabase();

  const restoreHomeDir = patchHomeDir(tempHome);
  const projectsDir = path.join(tempHome, '.claude', 'projects');

  try {
    await populate(projectsDir);
    // The synchronizer resolves ~/.claude at construction time, so it must be
    // created after homedir is patched.
    const sync = new ClaudeSessionSynchronizer();
    await runTest(sync, projectsDir);
  } finally {
    restoreHomeDir();
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(tempHome, { recursive: true, force: true });
  }
}

async function writeTranscript(projectsDir: string, sessionId: string): Promise<string> {
  const projectDir = path.join(projectsDir, '-workspace-demo-project');
  await mkdir(projectDir, { recursive: true });
  const transcriptPath = path.join(projectDir, `${sessionId}.jsonl`);
  await writeFile(
    transcriptPath,
    JSON.stringify({ sessionId, cwd: PROJECT_PATH, type: 'user' }) + '\n',
    'utf8'
  );
  return transcriptPath;
}

test('synchronize indexes a transcript and stores its jsonl_path', async () => {
  await withSyncFixture(
    async (projectsDir) => {
      await writeTranscript(projectsDir, SESSION_UUID);
    },
    async (sync, projectsDir) => {
      const processed = await sync.synchronize();
      assert.equal(processed, 1);

      const row = sessionsDb.getSessionById(SESSION_UUID);
      assert.ok(row, 'expected the synchronizer to upsert a session row');
      assert.equal(row?.provider, 'claude');
      assert.equal(
        row?.jsonl_path,
        path.join(projectsDir, '-workspace-demo-project', `${SESSION_UUID}.jsonl`)
      );
    },
  );
});

test('synchronize prunes ghost rows whose transcript file was deleted from disk', async () => {
  await withSyncFixture(
    async (projectsDir) => {
      await writeTranscript(projectsDir, SESSION_UUID);
    },
    async (sync, projectsDir) => {
      await sync.synchronize();
      assert.ok(sessionsDb.getSessionById(SESSION_UUID));

      // Simulate Claude's retention sweep removing the transcript while the
      // server was down.
      const transcriptPath = path.join(projectsDir, '-workspace-demo-project', `${SESSION_UUID}.jsonl`);
      await rm(transcriptPath);

      await sync.synchronize();
      assert.equal(sessionsDb.getSessionById(SESSION_UUID), null);
    },
  );
});

test('synchronize prunes archived ghost rows too', async () => {
  await withSyncFixture(
    async (projectsDir) => {
      await writeTranscript(projectsDir, SESSION_UUID);
    },
    async (sync, projectsDir) => {
      await sync.synchronize();
      sessionsDb.updateSessionIsArchived(SESSION_UUID, true);

      await rm(path.join(projectsDir, '-workspace-demo-project', `${SESSION_UUID}.jsonl`));

      await sync.synchronize();
      assert.equal(sessionsDb.getSessionById(SESSION_UUID), null);
    },
  );
});

test('prune never touches other providers or claude rows without a jsonl_path', async () => {
  await withSyncFixture(
    () => undefined,
    async (sync) => {
      // Another provider's row pointing at a missing file must survive a
      // Claude sync — its own synchronizer owns that cleanup.
      sessionsDb.createSession(
        'codex-session',
        'codex',
        PROJECT_PATH,
        undefined,
        undefined,
        undefined,
        '/nonexistent/codex/transcript.jsonl'
      );
      // A claude row with no stored transcript path is not a ghost candidate.
      sessionsDb.createSession('claude-no-path', 'claude', PROJECT_PATH);

      await sync.synchronize();

      assert.ok(sessionsDb.getSessionById('codex-session'));
      assert.ok(sessionsDb.getSessionById('claude-no-path'));
    },
  );
});
