import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import Database from 'better-sqlite3';

import {
  closeConnection,
  getConnection,
  initializeDatabase,
  participantsDb,
  sessionsDb,
} from '@/modules/database/index.js';
import {
  clearAntigravityProjectPath,
  registerAntigravityProjectPath,
} from '@/modules/providers/list/antigravity/antigravity-project-registry.js';
import { AntigravitySessionSynchronizer } from '@/modules/providers/list/antigravity/antigravity-session-synchronizer.provider.js';
import { ClaudeSessionSynchronizer } from '@/modules/providers/list/claude/claude-session-synchronizer.provider.js';
import { CodexSessionSynchronizer } from '@/modules/providers/list/codex/codex-session-synchronizer.provider.js';
import { CursorSessionSynchronizer } from '@/modules/providers/list/cursor/cursor-session-synchronizer.provider.js';
import { OpenCodeSessionSynchronizer } from '@/modules/providers/list/opencode/opencode-session-synchronizer.provider.js';
import { VendorSessionSynchronizer } from '@/modules/providers/shared/vendor/vendor-session-synchronizer.provider.js';
import { KimiAgentSessionSynchronizer } from '@/services/isolation/kimi-agent-session-synchronizer.provider.js';

/**
 * B-1620 — nested CLI runs in a scratch dir must not become sidebar projects
 * through discovery, while launch writers keep recording such runs.
 *
 * The session_meta / transcript shapes below are copied from real on-disk files
 * (a `codex exec` rollout with originator codex_exec and cwd /var/tmp/...,
 * a `claude -p` SDK transcript with cwd /var/tmp/...), with content sanitized.
 * Antigravity (USER_INPUT step) and vendor (`meta` line) shapes also come from
 * real files. Cursor and kimi-agent use the shapes of their existing unit
 * tests: this host has no cursor project dir, and its real kimi wire files
 * carry no cwd at all (so they are never indexed in the first place).
 */

const SID = '00000000-0000-7000-8000-00000000b162'; // synthetic v7, codex rollout id shape
const CLAUDE_SID = '9450d335-9a31-427d-a557-82c077fb1620';

type Box = { home: string; tempCwd: string };

/** A temp root that holds neither the test database nor the patched home. */
function pickForeignTempRoot(excluded: string[]): string {
  const inside = (child: string, parent: string) => child === parent || child.startsWith(`${parent}/`);
  const root = ['/dev/shm', '/tmp', '/var/tmp'].find((candidate) => (
    excluded.every((p) => !inside(p, candidate))
  ));
  assert.ok(root, 'no temp root disjoint from the test database');
  return root;
}

async function withBox(run: (box: Box) => Promise<void>): Promise<void> {
  const previousDb = process.env.DATABASE_PATH;
  const home = mkdtempSync(path.join(os.tmpdir(), 'b1620-discovery-'));
  const originalHomedir = os.homedir;
  (os as { homedir: () => string }).homedir = () => home;
  closeConnection();
  process.env.DATABASE_PATH = path.join(home, 'auth.db');
  await initializeDatabase();
  getConnection().prepare("INSERT INTO users (id, username, password_hash, role) VALUES (1, 'owner', 'x', 'owner')")
    .run();
  // Never created on disk: the guard judges a missing cwd by its lexical form.
  const tempCwd = path.join(pickForeignTempRoot([home, process.env.DATABASE_PATH]), `b1620-nested-${process.pid}`);
  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    await run({ home, tempCwd });
  } finally {
    console.warn = originalWarn;
    (os as { homedir: () => string }).homedir = originalHomedir;
    closeConnection();
    if (previousDb === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previousDb;
    rmSync(home, { recursive: true, force: true });
  }
}

function writeJsonl(file: string, lines: unknown[]): string {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`);
  return file;
}

/** First line of a real `codex exec` rollout (sanitized). */
function codexExecRollout(home: string, cwd: string, timestamp = '2026-10-13T18:33:58.241Z'): string {
  const file = path.join(home, '.codex', 'sessions', '2026', '10', '13', `rollout-2026-10-13T21-33-58-${SID}.jsonl`);
  return writeJsonl(file, [{
    timestamp,
    type: 'session_meta',
    payload: {
      id: SID, session_id: SID, timestamp, cwd, originator: 'codex_exec', cli_version: '0.160.0',
      source: 'exec', thread_source: 'user', history_mode: 'paginated', model_provider: 'openai',
      base_instructions: { text: 'sanitized' }, runtime_workspace_roots: [cwd],
    },
  }]);
}

/** Leading lines of a real `claude -p` (SDK) transcript (sanitized). */
function claudePrintTranscript(home: string, cwd: string): string {
  const file = path.join(home, '.claude', 'projects', cwd.replace(/[/.]/g, '-'), `${CLAUDE_SID}.jsonl`);
  const base = {
    cwd, sessionId: CLAUDE_SID, entrypoint: 'sdk-ts', userType: 'external', version: '2.1.273',
    gitBranch: '', isSidechain: false, timestamp: '2026-10-13T18:00:00.000Z',
  };
  return writeJsonl(file, [
    { type: 'queue-operation', operation: 'enqueue', sessionId: CLAUDE_SID, timestamp: base.timestamp },
    { ...base, type: 'user', uuid: 'u1', parentUuid: null, message: { role: 'user', content: 'sanitized' } },
  ]);
}

/** An opencode.db (real `session` columns used by the synchronizer) with one temp-dir session. */
function writeOpenCodeDb(home: string, tempCwd: string): void {
  const dataDir = path.join(home, '.local', 'share', 'opencode');
  mkdirSync(dataDir, { recursive: true });
  const db = new Database(path.join(dataDir, 'opencode.db'));
  try {
    db.exec(`
      CREATE TABLE project (id TEXT PRIMARY KEY, worktree TEXT NOT NULL, time_created INTEGER NOT NULL,
        time_updated INTEGER NOT NULL, sandboxes TEXT NOT NULL);
      CREATE TABLE session (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, parent_id TEXT, slug TEXT NOT NULL,
        directory TEXT NOT NULL, title TEXT NOT NULL, version TEXT NOT NULL, model TEXT,
        time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, time_archived INTEGER);
      CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, time_created INTEGER NOT NULL,
        time_updated INTEGER NOT NULL, data TEXT NOT NULL);
      CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT NOT NULL, session_id TEXT NOT NULL,
        time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL);
    `);
    db.prepare('INSERT INTO project VALUES (?, ?, ?, ?, ?)').run('p1', tempCwd, 1_700_000_000_000, 1_700_000_000_000, '[]');
    db.prepare(`INSERT INTO session (id, project_id, parent_id, slug, directory, title, version, model,
      time_created, time_updated, time_archived) VALUES (?, 'p1', NULL, ?, ?, 'nested run', '1.0.0', NULL, ?, ?, NULL)`)
      .run('ses_b1620', 'ses_b1620', tempCwd, 1_700_000_000_000, 1_700_000_000_500);
  } finally {
    db.close();
  }
}

const projectCount = (projectPath: string): number => (getConnection()
  .prepare('SELECT COUNT(*) AS n FROM projects WHERE project_path = ?').get(projectPath) as { n: number }).n;

/** Registers `projectPath` as a project created by user 1. */
function registerByUser(projectPath: string): void {
  getConnection().prepare("INSERT INTO projects (project_id, project_path, created_by) VALUES ('p-user', ?, 1)")
    .run(projectPath);
}

test('Codex: a codex_exec rollout in a temp cwd records no session and no project', async () => {
  await withBox(async ({ home, tempCwd }) => {
    await new CodexSessionSynchronizer().synchronizeFile(codexExecRollout(home, tempCwd));
    assert.equal(sessionsDb.getSessionById(SID), null);
    assert.equal(projectCount(tempCwd), 0);
  });
});

test('Claude: a claude -p transcript in a temp cwd records no session and no project', async () => {
  await withBox(async ({ home, tempCwd }) => {
    const sync = new ClaudeSessionSynchronizer();
    const transcript = claudePrintTranscript(home, tempCwd);
    await sync.synchronizeFile(transcript);
    await sync.synchronize();
    assert.equal(sessionsDb.getSessionById(CLAUDE_SID), null);
    assert.equal(projectCount(tempCwd), 0);
    // Control: the same fixture is indexed once a user registers the path.
    registerByUser(tempCwd);
    await sync.synchronizeFile(transcript);
    assert.equal(sessionsDb.getSessionById(CLAUDE_SID)?.project_path, tempCwd);
  });
});

test('OpenCode: a temp-dir session gets no row, no project and no provenance participant', async () => {
  await withBox(async ({ home, tempCwd }) => {
    writeOpenCodeDb(home, tempCwd);
    assert.equal(await new OpenCodeSessionSynchronizer().synchronize(), 0);
    assert.equal(sessionsDb.getSessionById('ses_b1620'), null);
    assert.equal(participantsDb.hasParticipant('ses_b1620'), false);
    assert.equal(projectCount(tempCwd), 0);
    // Control: the same fixture is indexed once a user registers the path.
    registerByUser(tempCwd);
    assert.equal(await new OpenCodeSessionSynchronizer().synchronize(), 1);
    assert.equal(sessionsDb.getSessionById('ses_b1620')?.project_path, tempCwd);
  });
});

test('a temp path registered by a user (created_by set) is still discovered', async () => {
  await withBox(async ({ home, tempCwd }) => {
    registerByUser(tempCwd);
    await new CodexSessionSynchronizer().synchronizeFile(codexExecRollout(home, tempCwd));
    assert.equal(sessionsDb.getSessionById(SID)?.project_path, tempCwd);
  });
});

test('an auto-created temp project (created_by NULL) gets no new session', async () => {
  await withBox(async ({ home, tempCwd }) => {
    getConnection().prepare("INSERT INTO projects (project_id, project_path) VALUES ('p-auto', ?)").run(tempCwd);
    await new CodexSessionSynchronizer().synchronizeFile(codexExecRollout(home, tempCwd));
    assert.equal(sessionsDb.getSessionById(SID), null);
    assert.equal(projectCount(tempCwd), 1, 'the existing row is left alone, not deleted');
  });
});

test('an existing temp row is frozen: no refresh and no child bump', async () => {
  await withBox(async ({ home, tempCwd }) => {
    sessionsDb.recordDiscoveredSession({
      sessionId: SID, provider: 'codex', projectPath: tempCwd, customName: 'old',
      createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z',
    });
    const before = sessionsDb.getSessionById(SID);
    assert.ok(before, 'the launch writer recorded the row');
    await new CodexSessionSynchronizer().synchronizeFile(codexExecRollout(home, tempCwd, '2026-10-13T18:33:58.241Z'));
    sessionsDb.bumpSessionUpdatedAt(SID, '2026-10-14T00:00:00.000Z');
    const after = sessionsDb.getSessionById(SID);
    assert.equal(after?.updated_at, before.updated_at);
    assert.equal(after?.jsonl_path, before.jsonl_path);
    assert.equal(after?.custom_name, 'old');
  });
});

test('launch writers in a temp dir still record (S1)', async () => {
  await withBox(async ({ tempCwd }) => {
    assert.equal(sessionsDb.insertDiscoveredSession({ sessionId: 'launch-1', provider: 'qwen', projectPath: tempCwd }),
      'inserted');
    sessionsDb.recordDiscoveredSession({ sessionId: 'launch-2', provider: 'antigravity', projectPath: tempCwd });
    assert.equal(sessionsDb.getSessionById('launch-2')?.project_path, tempCwd);
    assert.equal(sessionsDb.refreshDiscoveredSession({
      sessionId: 'launch-2', provider: 'antigravity', projectPath: tempCwd, updatedAt: '2026-10-14T00:00:00.000Z',
    }), 'refreshed');
    // participants FK fallback: the spawn beat the synchronizer, so no row exists yet.
    participantsDb.recordSpawn('launch-3', 1, { provider: 'codex', projectPath: tempCwd });
    assert.equal(sessionsDb.getSessionById('launch-3')?.project_path, tempCwd);
    assert.equal(participantsDb.isParticipant('launch-3', 1), true);
    assert.equal(projectCount(tempCwd), 1);
  });
});

test('a provenance write through the FK fallback obeys the watcher rule', async () => {
  await withBox(async ({ tempCwd }) => {
    const originalError = console.error;
    console.error = () => {};
    try {
      participantsDb.recordSpawn('prov-1', 1, { provider: 'opencode', projectPath: tempCwd, attribution: 'provenance' });
    } finally {
      console.error = originalError;
    }
    assert.equal(sessionsDb.getSessionById('prov-1'), null);
    assert.equal(projectCount(tempCwd), 0);
  });
});

test('boot ensureProjectsForSessionPaths creates no project for a temp session path', async () => {
  await withBox(async ({ home, tempCwd }) => {
    await new CodexSessionSynchronizer().synchronizeFile(codexExecRollout(home, tempCwd));
    const db = getConnection();
    db.pragma('foreign_keys = OFF');
    db.prepare("INSERT INTO sessions (session_id, provider, project_path) VALUES ('orphan-temp', 'codex', ?)")
      .run(tempCwd);
    db.prepare("INSERT INTO sessions (session_id, provider, project_path) VALUES ('orphan-real', 'codex', ?)")
      .run('/srv/b1620-real-project');
    closeConnection();
    await initializeDatabase();
    assert.equal(projectCount(tempCwd), 0);
    assert.equal(projectCount('/srv/b1620-real-project'), 1, 'non-temp paths are still backfilled');
  });
});

test('OpenCode: an existing frozen temp row gets no provenance participant (M2)', async () => {
  await withBox(async ({ home, tempCwd }) => {
    writeOpenCodeDb(home, tempCwd);
    sessionsDb.recordDiscoveredSession({ sessionId: 'ses_b1620', provider: 'opencode', projectPath: tempCwd });
    assert.ok(sessionsDb.getSessionById('ses_b1620'), 'a launch writer recorded the row');
    assert.equal(await new OpenCodeSessionSynchronizer().synchronize(), 0);
    assert.equal(participantsDb.hasParticipant('ses_b1620'), false);
  });
});

test('Antigravity: a temp workspace registered at launch is not indexed by discovery', async () => {
  await withBox(async ({ home, tempCwd }) => {
    const brainId = 'aaaaaaaa-bbbb-4ccc-8ddd-0000000b1620';
    const transcript = writeJsonl(
      path.join(home, '.gemini', 'antigravity-cli', 'brain', brainId, '.system_generated', 'logs', 'transcript.jsonl'),
      [{ step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', status: 'DONE',
        created_at: '2026-10-13T18:00:00Z', content: '<USER_REQUEST>\nsanitized\n</USER_REQUEST>' }],
    );
    registerAntigravityProjectPath(brainId, tempCwd);
    try {
      const sync = new AntigravitySessionSynchronizer();
      await sync.synchronizeFile(transcript);
      await sync.synchronize();
      assert.equal(sessionsDb.getSessionById(brainId), null);
      assert.equal(projectCount(tempCwd), 0);
      registerByUser(tempCwd);
      await sync.synchronizeFile(transcript);
      assert.equal(sessionsDb.getSessionById(brainId)?.project_path, tempCwd, 'control: indexed once registered');
    } finally {
      clearAntigravityProjectPath(brainId);
    }
  });
});

test('Cursor: a chat whose workspace is a temp dir is not indexed', async () => {
  await withBox(async ({ home, tempCwd }) => {
    const chatId = 'c0c0c0c0-0000-4000-8000-00000000b162';
    const base = path.join(home, '.cursor', 'projects', 'p');
    mkdirSync(base, { recursive: true });
    writeFileSync(path.join(base, 'worker.log'), `workspacePath=${tempCwd}\n`);
    const chat = writeJsonl(path.join(base, 'agent-transcripts', chatId, `${chatId}.jsonl`),
      [{ role: 'user', message: { content: [{ text: 'sanitized' }] } }]);
    const sync = new CursorSessionSynchronizer();
    await sync.synchronizeFile(chat);
    await sync.synchronize();
    assert.equal(sessionsDb.getSessionById(chatId), null);
    assert.equal(projectCount(tempCwd), 0);
    registerByUser(tempCwd);
    await sync.synchronizeFile(chat);
    assert.equal(sessionsDb.getSessionById(chatId)?.project_path, tempCwd, 'control: indexed once registered');
  });
});

test('Vendor: a vendor transcript whose projectPath is a temp dir is not indexed', async () => {
  await withBox(async ({ home, tempCwd }) => {
    const vendorId = '1d106895-6e12-4f88-8c51-99569600b162';
    const transcript = writeJsonl(path.join(home, '.nassaj-vendor-sessions', 'glm', 'h', `${vendorId}.jsonl`),
      [{ type: 'meta', projectPath: tempCwd, sessionName: 'sanitized' }]);
    const sync = new VendorSessionSynchronizer('glm');
    await sync.synchronizeFile(transcript);
    await sync.synchronize();
    assert.equal(sessionsDb.getSessionById(vendorId), null);
    assert.equal(projectCount(tempCwd), 0);
    registerByUser(tempCwd);
    await sync.synchronizeFile(transcript);
    assert.equal(sessionsDb.getSessionById(vendorId)?.project_path, tempCwd, 'control: indexed once registered');
  });
});

test('Kimi agent: a wire transcript whose cwd is a temp dir is not indexed', async () => {
  await withBox(async ({ home, tempCwd }) => {
    const wire = writeJsonl(path.join(home, '.kimi', 'sessions', 'conv-b1620', 'agents', 'main', 'wire.jsonl'),
      [{ type: 'session', cwd: tempCwd, title: 'sanitized' }]);
    const sync = new KimiAgentSessionSynchronizer();
    await sync.synchronizeFile(wire);
    await sync.synchronize();
    assert.equal(sessionsDb.getSessionById('conv-b1620'), null);
    assert.equal(projectCount(tempCwd), 0);
    registerByUser(tempCwd);
    await sync.synchronizeFile(wire);
    assert.equal(sessionsDb.getSessionById('conv-b1620')?.project_path, tempCwd, 'control: indexed once registered');
  });
});
