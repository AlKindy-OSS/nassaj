import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, getConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import { ClaudeSessionSynchronizer } from '@/modules/providers/list/claude/claude-session-synchronizer.provider.js';
import { CodexSessionSynchronizer } from '@/modules/providers/list/codex/codex-session-synchronizer.provider.js';
import { CursorSessionSynchronizer } from '@/modules/providers/list/cursor/cursor-session-synchronizer.provider.js';
import { VendorSessionSynchronizer } from '@/modules/providers/shared/vendor/vendor-session-synchronizer.provider.js';

/**
 * ADR-201 A2 — negative tests per synchronizer: a file in member /10's tree that
 * names a session recorded from member /1's tree (prefix trap) must not move,
 * relabel or re-point that row.
 */

const PROJECT_A = '/workspace/adr201-writers-a';
const PROJECT_B = '/workspace/adr201-writers-b';
const SID = '5d0c1a7e-0000-4000-8000-00000000a201';

type Box = { home: string; member: (id: string, ...rest: string[]) => string };

async function withBox(run: (box: Box) => Promise<void>): Promise<void> {
  const previousDb = process.env.DATABASE_PATH;
  const home = mkdtempSync(path.join(os.tmpdir(), 'adr201-writers-'));
  const originalHomedir = os.homedir;
  (os as { homedir: () => string }).homedir = () => home;
  closeConnection();
  process.env.DATABASE_PATH = path.join(home, 'auth.db');
  await initializeDatabase();
  const member = (id: string, ...rest: string[]): string => path.join(home, '.nassaj-users', id, ...rest);
  try {
    await run({ home, member });
  } finally {
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

async function quietly<T>(run: () => Promise<T>): Promise<T> {
  const original = console.warn;
  console.warn = () => {};
  try {
    return await run();
  } finally {
    console.warn = original;
  }
}

function assertUnchanged(provider: string, jsonlPath: string): void {
  const row = sessionsDb.getSessionById(SID);
  assert.equal(row?.provider, provider);
  assert.equal(row?.project_path, PROJECT_A);
  assert.equal(row?.jsonl_path, jsonlPath);
}

const claudeLine = (cwd: string) => ({ sessionId: SID, cwd, type: 'user' });
const codexMeta = (cwd: string, extra: Record<string, unknown> = {}) => ({
  type: 'session_meta', payload: { id: SID, cwd, source: 'cli', thread_source: 'user', ...extra },
});

test('Claude: a forged /10 file cannot move, re-point or rename a /1 session', async () => {
  await withBox(async ({ member }) => {
    const sync = new ClaudeSessionSynchronizer();
    const own = writeJsonl(member('1', '.claude', 'projects', '-a', `${SID}.jsonl`), [claudeLine(PROJECT_A)]);
    await sync.synchronizeFile(own);
    assertUnchanged('claude', own);
    const forged = writeJsonl(member('10', '.claude', 'projects', '-b', `${SID}.jsonl`), [claudeLine(PROJECT_B)]);
    await quietly(() => sync.synchronizeFile(forged));
    assertUnchanged('claude', own);
  });
});

test('Claude: a same-tree file whose name is not its content id never refreshes the row (A3)', async () => {
  await withBox(async ({ member }) => {
    const sync = new ClaudeSessionSynchronizer();
    const own = writeJsonl(member('1', '.claude', 'projects', '-a', `${SID}.jsonl`), [claudeLine(PROJECT_A)]);
    await sync.synchronizeFile(own);
    const fork = writeJsonl(member('1', '.claude', 'projects', '-a', 'other-name.jsonl'), [claudeLine(PROJECT_A)]);
    await quietly(() => sync.synchronizeFile(fork));
    assertUnchanged('claude', own);
  });
});

test('L7: a file whose name is not its content id inserts no row either (warn only)', async () => {
  await withBox(async ({ member }) => {
    const sync = new ClaudeSessionSynchronizer();
    // No row exists for SID: a fork/resume copy or a forgery under another name must not create one.
    const fork = writeJsonl(member('1', '.claude', 'projects', '-a', 'other-name.jsonl'), [claudeLine(PROJECT_A)]);
    await quietly(() => sync.synchronizeFile(fork));
    assert.ok(!sessionsDb.getSessionById(SID), 'no row from a mismatched name');
    await quietly(() => sync.synchronize());
    assert.ok(!sessionsDb.getSessionById(SID), 'nor from a full scan');
  });
});

test('Codex: a /10 rollout claiming a Claude id relabels nothing; a cwd forgery moves nothing', async () => {
  await withBox(async ({ member }) => {
    const own = writeJsonl(member('1', '.claude', 'projects', '-a', `${SID}.jsonl`), [claudeLine(PROJECT_A)]);
    await new ClaudeSessionSynchronizer().synchronizeFile(own);
    const rollout = writeJsonl(
      member('10', '.codex', 'sessions', '2026', '10', '12', `rollout-2026-10-12T00-00-00-${SID}.jsonl`),
      [codexMeta(PROJECT_B)],
    );
    await quietly(() => new CodexSessionSynchronizer().synchronizeFile(rollout));
    assertUnchanged('claude', own);
  });
});

test('Codex: a /10 child thread cannot bump a /1 parent; a /1 child can', async () => {
  await withBox(async ({ member }) => {
    const sync = new CodexSessionSynchronizer();
    const dayDir = (id: string) => member(id, '.codex', 'sessions', '2026', '10', '12');
    const parent = writeJsonl(path.join(dayDir('1'), `rollout-2026-10-12T00-00-00-${SID}.jsonl`), [codexMeta(PROJECT_A)]);
    await sync.synchronizeFile(parent);
    getConnection().prepare("UPDATE sessions SET updated_at = '2000-01-01T00:00:00.000Z' WHERE session_id = ?").run(SID);
    const childId = '5d0c1a7e-0000-4000-8000-00000000c401';
    const childMeta = { type: 'session_meta', payload: { id: childId, cwd: PROJECT_A, thread_source: 'subagent', parent_thread_id: SID } };
    const foreignChild = writeJsonl(path.join(dayDir('10'), `rollout-2026-10-12T00-00-01-${childId}.jsonl`), [childMeta]);
    await quietly(() => sync.synchronizeFile(foreignChild));
    assert.equal(sessionsDb.getSessionById(SID)?.updated_at, '2000-01-01T00:00:00.000Z');
    const ownChild = writeJsonl(path.join(dayDir('1'), `rollout-2026-10-12T00-00-01-${childId}.jsonl`), [childMeta]);
    await sync.synchronizeFile(ownChild);
    assert.notEqual(sessionsDb.getSessionById(SID)?.updated_at, '2000-01-01T00:00:00.000Z');
  });
});

test('Vendor (kimi/deepseek/glm): a /10 transcript named after a /1 session re-points nothing', async () => {
  await withBox(async ({ member }) => {
    const sync = new VendorSessionSynchronizer('glm');
    const meta = (projectPath: string) => ({ type: 'meta', projectPath, sessionName: 'title' });
    const own = writeJsonl(member('1', '.nassaj-vendor-sessions', 'glm', 'h', `${SID}.jsonl`), [meta(PROJECT_A)]);
    await sync.synchronizeFile(own);
    assertUnchanged('glm', own);
    const forged = writeJsonl(member('10', '.nassaj-vendor-sessions', 'glm', 'h', `${SID}.jsonl`), [meta(PROJECT_B)]);
    await quietly(() => sync.synchronizeFile(forged));
    assertUnchanged('glm', own);
  });
});

test('Cursor: a /10 chat named after a /1 session re-points nothing', async () => {
  await withBox(async ({ member }) => {
    const sync = new CursorSessionSynchronizer();
    const chat = (id: string, project: string): string => {
      const base = member(id, '.cursor', 'projects', 'p');
      mkdirSync(base, { recursive: true });
      writeFileSync(path.join(base, 'worker.log'), `workspacePath=${project}\n`);
      return writeJsonl(path.join(base, 'agent-transcripts', SID, `${SID}.jsonl`),
        [{ role: 'user', message: { content: [{ text: 'hello' }] } }]);
    };
    const own = chat('1', PROJECT_A);
    await sync.synchronizeFile(own);
    assertUnchanged('cursor', own);
    await quietly(() => sync.synchronizeFile(chat('10', PROJECT_B)));
    assertUnchanged('cursor', own);
  });
});
