/**
 * ADR-201 A-P4 — shared physical `projects/` (legitimate case b, risk 2):
 * provisioning links member /1's and member /10's `.claude/projects` to the
 * operator tree, so all three spellings name ONE physical directory.
 *
 * What Phase A CAN tell apart there (asserted as refusals):
 *   - a file whose header names another session (id binding);
 *   - a symlink or hardlink planted under the session's name;
 *   - a sync of the /10 spelling re-pointing a row recorded as /1 or operator
 *     (the writer compares lexical AND real tree keys).
 * What Phase A CANNOT tell apart (asserted as the documented behaviour, closed
 * only by Phase B's launch binding under T-898):
 *   - /10 overwriting `<id>.jsonl` in the shared dir with a header bound to /1's
 *     id: it is the same physical file, so /1's history shows /10's text;
 *   - a row recorded under the /10 spelling reads /1's file (tree confinement
 *     is physical; both spellings resolve into the operator root).
 *
 * Runner: TMPDIR=/var/tmp node scripts/run-isolated-node-tests.mjs server <this file>
 */
// FIRST import — HOME becomes a /var/tmp sandbox before anything reads it.
import { SANDBOX_HOME } from '@/shared/__tests__/sandbox-home.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { getConnection, initializeDatabase, participantsDb, sessionsDb } from '@/modules/database/index.js';
import { recordClaudeLaunchTranscript } from '@/modules/providers/list/claude/claude-launch-transcript.js';
import { ClaudeSessionSynchronizer } from '@/modules/providers/list/claude/claude-session-synchronizer.provider.js';
import { encodeClaudeProjectDir } from '@/modules/providers/list/claude/claude-transcript-path.js';
import { resetHistorySnapshotCacheForTests } from '@/modules/providers/services/session-history-light.service.js';
import { sessionsService } from '@/modules/providers/services/sessions.service.js';
import { isTranscriptHandle, openSessionTranscript } from '@/modules/providers/shared/session-transcript.js';

import { claudeTranscript } from './helpers/adr201-real-headers.js';

process.env.CLAUDE_CONFIG_DIR = path.join(SANDBOX_HOME, '.claude');
const SHARED = path.join(SANDBOX_HOME, '.claude', 'projects');
const USERS = path.join(SANDBOX_HOME, '.nassaj-users');
const B = 1;
const A = 10;
const PROJECT = path.join(SANDBOX_HOME, 'work', 'shared-project');
const ENCODED = encodeClaudeProjectDir(PROJECT);

// Provisioning (case b): each member's projects/ is a link to the one physical tree.
fs.mkdirSync(SHARED, { recursive: true });
fs.mkdirSync(PROJECT, { recursive: true });
for (const member of [B, A]) {
  fs.mkdirSync(path.join(USERS, String(member), '.claude'), { recursive: true });
  fs.symlinkSync(SHARED, path.join(USERS, String(member), '.claude', 'projects'));
}

await initializeDatabase();
const insertUser = getConnection().prepare('INSERT INTO users (id, username, password_hash) VALUES (?, ?, ?)');
for (const id of [B, A]) insertUser.run(id, `member-${id}`, 'x');

let counter = 0;
const nextId = () => `00000000-0000-4000-a202-${String(++counter).padStart(12, '0')}`;
const spelling = (tree: number | 'operator', sessionId: string) =>
  path.join(tree === 'operator' ? SHARED : path.join(USERS, String(tree), '.claude', 'projects'), ENCODED, `${sessionId}.jsonl`);
const row = (sessionId: string) => sessionsDb.getSessionById(sessionId);

function write(file: string, text: string): string {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  return file;
}

async function quietly<T>(run: () => Promise<T> | T): Promise<T> {
  const original = console.warn;
  console.warn = () => {};
  try {
    return await run();
  } finally {
    console.warn = original;
  }
}

async function historyText(sessionId: string, userId: number): Promise<string> {
  resetHistorySnapshotCacheForTests();
  return JSON.stringify((await sessionsService.fetchHistory(sessionId, userId, {})).messages);
}

async function openReason(sessionId: string, userId: number): Promise<string> {
  const opened = await quietly(() => openSessionTranscript(sessionId, userId, 'history'));
  if (!isTranscriptHandle(opened)) return opened.reason;
  await opened.fd.close();
  return 'ok';
}

const syncClaude = () => quietly(() => new ClaudeSessionSynchronizer().synchronize());

test('the shared tree is scanned once; a /1 launch record and the operator spelling are one tree', async () => {
  const sid = nextId();
  participantsDb.recordSpawn(sid, B, { provider: 'claude', projectPath: PROJECT });
  write(spelling(B, sid), claudeTranscript(sid, PROJECT, 'zqsharedown'));
  assert.equal(recordClaudeLaunchTranscript(sid, { cwd: PROJECT, configDir: path.join(USERS, String(B), '.claude') }), 'refreshed');
  assert.equal(row(sid)?.jsonl_path, spelling(B, sid));
  await syncClaude();
  const stored = row(sid)?.jsonl_path;
  assert.ok(stored === spelling(B, sid) || stored === spelling('operator', sid), 'case b: /1 ↔ operator spelling only');
  assert.match(await historyText(sid, B), /zqsharedown/);
});

test('CAN tell apart: forged header id, symlink and hardlink in the shared tree are refused', async () => {
  const victim = nextId();
  const forged = nextId();
  const symlinked = nextId();
  const hardlinked = nextId();
  write(spelling('operator', victim), claudeTranscript(victim, PROJECT, 'zqsharedvictim'));
  const outside = write(path.join(SANDBOX_HOME, 'outside', 'x.jsonl'), claudeTranscript(symlinked, PROJECT, 'zqoutside'));
  write(spelling(A, forged), claudeTranscript(victim, PROJECT, 'zqsharedforged'));
  fs.symlinkSync(outside, spelling(A, symlinked));
  const hardSource = write(path.join(SANDBOX_HOME, 'outside', 'h.jsonl'), claudeTranscript(hardlinked, PROJECT, 'zqhard'));
  fs.linkSync(hardSource, spelling(A, hardlinked));
  const insert = getConnection().prepare('INSERT INTO sessions (session_id, provider, project_path, jsonl_path) VALUES (?, ?, ?, ?)');
  for (const sid of [forged, symlinked, hardlinked]) {
    insert.run(sid, 'claude', PROJECT, spelling(B, sid));
    participantsDb.recordSpawn(sid, B);
  }
  assert.equal(await openReason(forged, B), 'id_mismatch');
  // A1.5: the recorded name is opened O_NOFOLLOW, so the symlink is refused as such.
  assert.equal(await openReason(symlinked, B), 'symlink');
  assert.equal(await openReason(hardlinked, B), 'multiply_linked');
});

test('CAN tell apart: a sync of the /10 spelling never re-points a /1 or operator row', async () => {
  for (const recordedTree of [B, 'operator'] as const) {
    const sid = nextId();
    participantsDb.recordSpawn(sid, B, { provider: 'claude', projectPath: PROJECT });
    const recorded = write(spelling(recordedTree, sid), claudeTranscript(sid, PROJECT, 'zqsharedrow'));
    assert.equal(sessionsDb.refreshDiscoveredSession({ sessionId: sid, provider: 'claude', projectPath: PROJECT, jsonlPath: recorded }),
      'refreshed');
    const outcome = await quietly(() => sessionsDb.refreshDiscoveredSession({
      sessionId: sid, provider: 'claude', projectPath: PROJECT, jsonlPath: spelling(A, sid),
    }));
    assert.equal(outcome, 'refused', `recorded as ${recordedTree}`);
    assert.equal(row(sid)?.jsonl_path, recorded);
  }
});

test('CANNOT tell apart (documented, Phase B): /10 rewriting /1\'s file in the shared tree is read as /1\'s', async () => {
  const sid = nextId();
  participantsDb.recordSpawn(sid, B, { provider: 'claude', projectPath: PROJECT });
  write(spelling(B, sid), claudeTranscript(sid, PROJECT, 'zqsharedorig'));
  await syncClaude();
  // Member /10 writes through ITS OWN spelling: the same physical file.
  write(spelling(A, sid), claudeTranscript(sid, PROJECT, 'zqsharedoverwrite'));
  await syncClaude();
  assert.match(await historyText(sid, B), /zqsharedoverwrite/, 'Phase A confines by physical tree only');
  // A row recorded under the /10 spelling reads the shared file too.
  const other = nextId();
  write(spelling(B, other), claudeTranscript(other, PROJECT, 'zqsharedbyten'));
  getConnection().prepare('INSERT INTO sessions (session_id, provider, project_path, jsonl_path) VALUES (?, ?, ?, ?)')
    .run(other, 'claude', PROJECT, spelling(A, other));
  participantsDb.recordSpawn(other, B);
  assert.equal(await openReason(other, B), 'ok');
});
