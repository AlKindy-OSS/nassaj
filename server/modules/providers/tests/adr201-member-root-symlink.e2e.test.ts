/**
 * ADR-201 qa H1 — a symlink on the provider root inside a member's OWN tree.
 *
 * Member /1 makes `~/.nassaj-users/1/.claude/projects` a link to member /10's
 * real `projects/`. Scans run in id order, so before H1 member /10's files were
 * indexed under /1's spelling (tree keys {member:1, member:10}); /1 then
 * re-pointed the link at a dir it owns holding a forged `<id>.jsonl` whose
 * header names /10's session, and the reader confined that row to /1's tree.
 *
 * Asserted here (each fails on the pre-H1 code):
 *   - the synchronizer skips /1's spelling; /10's row keeps /10's spelling;
 *   - the writers refuse a candidate whose lexical and physical members differ;
 *   - the reader refuses a legacy /1-spelled row while the link points at /10;
 *   - after the re-point, /10's history is still /10's own file.
 * The live layout (every member root a link to the operator tree, case b) is
 * kept readable: see adr201-shared-projects.e2e.test.ts.
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
import { ClaudeSessionSynchronizer } from '@/modules/providers/list/claude/claude-session-synchronizer.provider.js';
import { encodeClaudeProjectDir } from '@/modules/providers/list/claude/claude-transcript-path.js';
import { isTranscriptHandle, openRecordedTranscript } from '@/modules/providers/shared/session-transcript-reader.js';

import { claudeTranscript } from './helpers/adr201-real-headers.js';

process.env.CLAUDE_CONFIG_DIR = path.join(SANDBOX_HOME, '.claude');
const USERS = path.join(SANDBOX_HOME, '.nassaj-users');
const LINKER = 1;
const VICTIM = 10;
const PROJECT = path.join(SANDBOX_HOME, 'work', 'member-root-project');
const ENCODED = encodeClaudeProjectDir(PROJECT);
const projectsOf = (member: number) => path.join(USERS, String(member), '.claude', 'projects');
const spelling = (member: number, sessionId: string) => path.join(projectsOf(member), ENCODED, `${sessionId}.jsonl`);
const FORGED_DIR = path.join(USERS, String(LINKER), 'owned-elsewhere');

fs.mkdirSync(path.join(SANDBOX_HOME, '.claude', 'projects'), { recursive: true });
fs.mkdirSync(PROJECT, { recursive: true });
fs.mkdirSync(projectsOf(VICTIM), { recursive: true });
fs.mkdirSync(path.dirname(projectsOf(LINKER)), { recursive: true });
fs.symlinkSync(projectsOf(VICTIM), projectsOf(LINKER));

await initializeDatabase();
const insertUser = getConnection().prepare('INSERT INTO users (id, username, password_hash) VALUES (?, ?, ?)');
for (const id of [LINKER, VICTIM]) insertUser.run(id, `member-${id}`, 'x');

const SID = '00000000-0000-4000-a201-0000000000a1';
const LEGACY = '00000000-0000-4000-a201-0000000000a2';

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

async function readAs(sessionId: string, jsonlPath: string): Promise<string> {
  const opened = await quietly(() => openRecordedTranscript(
    { session_id: sessionId, provider: 'claude', jsonl_path: jsonlPath }, 'history'));
  if (!isTranscriptHandle(opened)) return `refused:${opened.reason}`;
  try {
    return await opened.fd.readFile({ encoding: 'utf8' });
  } finally {
    await opened.fd.close();
  }
}

const syncClaude = () => quietly(() => new ClaudeSessionSynchronizer().synchronize());

test('root /1 symlinked to /10: the sync indexes /10\'s file under /10\'s own spelling', async () => {
  write(spelling(VICTIM, SID), claudeTranscript(SID, PROJECT, 'zqvictimown'));
  participantsDb.recordSpawn(SID, VICTIM, { provider: 'claude', projectPath: PROJECT });
  await syncClaude();
  assert.equal(sessionsDb.getSessionById(SID)?.jsonl_path, spelling(VICTIM, SID));
});

test('root /1 symlinked to /10: the writers refuse a /1-spelled candidate (keys name two members)', async () => {
  const fresh = '00000000-0000-4000-a201-0000000000a3';
  write(spelling(VICTIM, fresh), claudeTranscript(fresh, PROJECT, 'zqfresh'));
  const input = { sessionId: fresh, provider: 'claude', projectPath: PROJECT, jsonlPath: spelling(LINKER, fresh) };
  assert.equal(await quietly(() => sessionsDb.insertDiscoveredSession(input)), 'skipped');
  await quietly(() => sessionsDb.recordDiscoveredSession(input));
  assert.ok(!sessionsDb.getSessionById(fresh), "no row from a cross-member spelling");
  const refresh = await quietly(() => sessionsDb.refreshDiscoveredSession({ ...input, sessionId: SID, jsonlPath: spelling(LINKER, SID) }));
  assert.equal(refresh, 'refused');
});

test('root /1 symlinked to /10: the reader refuses a legacy /1-spelled row', async () => {
  write(spelling(VICTIM, LEGACY), claudeTranscript(LEGACY, PROJECT, 'zqlegacy'));
  assert.equal(await readAs(LEGACY, spelling(LINKER, LEGACY)), 'refused:outside_tree');
  // The owner's own spelling still reads.
  assert.match(await readAs(LEGACY, spelling(VICTIM, LEGACY)), /zqlegacy/);
});

test('root /1 symlinked to /10, then to a forged dir: /10\'s row still reads /10\'s own file', async () => {
  const sid = '00000000-0000-4000-a201-0000000000a5';
  fs.unlinkSync(projectsOf(LINKER));
  fs.symlinkSync(projectsOf(VICTIM), projectsOf(LINKER));
  // A session found by discovery alone (no launch row): the first sync inserts it.
  write(spelling(VICTIM, sid), claudeTranscript(sid, PROJECT, 'zqvictimsecond'));
  await syncClaude();
  // /1 now re-points its own link at a dir it owns, holding a forged <sid>.jsonl.
  write(path.join(FORGED_DIR, ENCODED, `${sid}.jsonl`), claudeTranscript(sid, PROJECT, 'zqforged'));
  fs.unlinkSync(projectsOf(LINKER));
  fs.symlinkSync(FORGED_DIR, projectsOf(LINKER));
  await syncClaude();
  const stored = sessionsDb.getSessionById(sid)?.jsonl_path;
  assert.equal(stored, spelling(VICTIM, sid), 'the /1 spelling never names /10\'s row');
  const text = await readAs(sid, stored as string);
  assert.match(text, /zqvictimsecond/);
  assert.doesNotMatch(text, /zqforged/);
});

test('case b stays readable: a member root linked to the operator tree', async () => {
  const shared = path.join(SANDBOX_HOME, '.claude', 'projects');
  const member = 22;
  fs.mkdirSync(path.dirname(projectsOf(member)), { recursive: true });
  fs.symlinkSync(shared, projectsOf(member));
  const sid = '00000000-0000-4000-a201-0000000000a4';
  write(path.join(shared, ENCODED, `${sid}.jsonl`), claudeTranscript(sid, PROJECT, 'zqcaseb'));
  assert.match(await readAs(sid, spelling(member, sid)), /zqcaseb/);
  assert.equal(await quietly(() => sessionsDb.insertDiscoveredSession({
    sessionId: sid, provider: 'claude', projectPath: PROJECT, jsonlPath: spelling(member, sid),
  })), 'inserted');
});
