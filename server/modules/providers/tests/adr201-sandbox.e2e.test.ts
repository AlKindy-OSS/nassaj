/**
 * ADR-201 A-P4 — end-to-end sandbox: members /1 and /10 (prefix trap), a
 * stranger /100 and the operator root, driven through the REAL writers (the
 * Claude/Codex/agy synchronizers, the participant FK stub, the Claude launch
 * record) and then read back through the REAL readers (history fetch, search,
 * agent status, token usage). Repository- and reader-level negatives already
 * live in session-discovery.db.integration, session-discovery-writers,
 * session-transcript and transcript-readers-*; this file covers the chain
 * sync → row → read for:
 *   - a forged session id planted in /10 for /1's session, a forged cwd, a
 *     provider relabel (Codex rollout named after a Claude session);
 *   - credential grant (grantee working in the grantor tree) and FK stub fill
 *     (participant tree allowed, stranger tree refused);
 *   - T-1880 legacy spelling, agy placeholder → real workspace, overlay
 *     canonicalisation, rename migration, launch-recorded path + later sync.
 * Fixtures: real-derived header shapes (helpers/adr201-real-headers.ts).
 *
 * Runner: TMPDIR=/var/tmp node scripts/run-isolated-node-tests.mjs server <this file>
 */
// FIRST import — HOME becomes a /var/tmp sandbox before anything reads it.
import { SANDBOX_HOME } from '@/shared/__tests__/sandbox-home.js';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import {
  credentialGrantsDb, getConnection, initializeDatabase, participantsDb, projectsDb, sessionsDb,
} from '@/modules/database/index.js';
import { AGY_BRAIN_UNDER_HOME } from '@/modules/providers/list/antigravity/agy-brain-layout.js';
import { registerAntigravityProjectPath } from '@/modules/providers/list/antigravity/antigravity-project-registry.js';
import { AntigravitySessionSynchronizer } from '@/modules/providers/list/antigravity/antigravity-session-synchronizer.provider.js';
import {
  createClaudeLaunchTranscriptRecorder, recordClaudeLaunchTranscript,
} from '@/modules/providers/list/claude/claude-launch-transcript.js';
import { ClaudeSessionSynchronizer } from '@/modules/providers/list/claude/claude-session-synchronizer.provider.js';
import { readClaudeTranscriptForSession } from '@/modules/providers/list/claude/claude-token-usage.js';
import { encodeClaudeProjectDir } from '@/modules/providers/list/claude/claude-transcript-path.js';
import { CodexSessionSynchronizer } from '@/modules/providers/list/codex/codex-session-synchronizer.provider.js';
import { agentStatusService } from '@/modules/providers/services/agent-status.service.js';
import { searchConversations } from '@/modules/providers/services/session-conversations-search.service.js';
import { resetHistorySnapshotCacheForTests } from '@/modules/providers/services/session-history-light.service.js';
import { sessionsService } from '@/modules/providers/services/sessions.service.js';
import { isTranscriptHandle, openSessionTranscript } from '@/modules/providers/shared/session-transcript.js';
import { createSessionWorkspace } from '@/modules/session-workspaces/index.js';

import { agyTranscript, claudeTranscript, codexRollout } from './helpers/adr201-real-headers.js';

process.env.CLAUDE_CONFIG_DIR = path.join(SANDBOX_HOME, '.claude');
process.env.NASSAJ_GOVERNANCE_DIR = path.join(SANDBOX_HOME, 'nassaj-core');

const USERS = path.join(SANDBOX_HOME, '.nassaj-users');
const B = 1; // victim (member /1)
const A = 10; // attacker (member /10, the prefix trap of /1)
const STRANGER = 100;
const PROJECT_B = path.join(SANDBOX_HOME, 'work', 'project-b');
const PROJECT_A = path.join(SANDBOX_HOME, 'work', 'project-a');
const AGENT_ID = 'a0123456789abcdef';

await initializeDatabase();
const insertUser = getConnection().prepare('INSERT INTO users (id, username, password_hash) VALUES (?, ?, ?)');
for (const id of [B, A, STRANGER]) insertUser.run(id, `member-${id}`, 'x');
for (const project of [PROJECT_A, PROJECT_B]) fs.mkdirSync(project, { recursive: true });

let counter = 0;
const nextId = () => `00000000-0000-4000-a201-${String(++counter).padStart(12, '0')}`;

/** `<tree>/.claude/projects/<encoded cwd>/<id>.jsonl`; tree 'operator' is the sandbox HOME. */
function claudeFile(tree: number | 'operator', cwd: string, sessionId: string): string {
  const home = tree === 'operator' ? SANDBOX_HOME : path.join(USERS, String(tree));
  return path.join(home, '.claude', 'projects', encodeClaudeProjectDir(cwd), `${sessionId}.jsonl`);
}

function write(file: string, text: string): string {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  return file;
}

/** A subagent transcript beside `transcript` whose report text is `marker`. */
function plantAgent(transcript: string, marker: string): void {
  const dir = path.join(path.dirname(transcript), path.basename(transcript, '.jsonl'), 'subagents');
  const row = { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: marker }] } };
  write(path.join(dir, `agent-${AGENT_ID}.jsonl`), `${JSON.stringify(row)}\n`);
}

/** A launch as the run path records it: the participant FK stub (NULL jsonl_path). */
function launch(sessionId: string, userId: number, projectPath: string, provider = 'claude'): void {
  participantsDb.recordSpawn(sessionId, userId, { provider, projectPath });
}

const row = (sessionId: string) => sessionsDb.getSessionById(sessionId);

async function quietly<T>(run: () => Promise<T> | T): Promise<T> {
  const original = console.warn;
  console.warn = () => {};
  try {
    return await run();
  } finally {
    console.warn = original;
  }
}

/** Full Claude scan of the operator home and every member home (real synchronize()). */
const syncClaude = () => quietly(() => new ClaudeSessionSynchronizer().synchronize());

/** History text as `userId` sees it through the unleased history fetch. */
async function historyText(sessionId: string, userId: number): Promise<string> {
  resetHistorySnapshotCacheForTests();
  const { messages } = await sessionsService.fetchHistory(sessionId, userId, {});
  return JSON.stringify(messages);
}

async function searchHits(term: string, userId: number): Promise<string[]> {
  const { results } = await searchConversations(term, userId, 200);
  return results.flatMap((project) => project.sessions.map((session) => session.sessionId));
}

async function openReason(sessionId: string, userId: number): Promise<string> {
  const opened = await openSessionTranscript(sessionId, userId, 'history');
  if (!isTranscriptHandle(opened)) return opened.reason;
  await opened.fd.close();
  return 'ok';
}

test('forged id in /10 for a /1 session: sync keeps the row, every reader shows only /1 content', async () => {
  const sid = nextId();
  launch(sid, B, PROJECT_B);
  // The attacker plants first, before the victim's CLI has written anything.
  const forged = write(claudeFile(A, PROJECT_A, sid), claudeTranscript(sid, PROJECT_A, 'zqforgedcwd'));
  plantAgent(forged, 'zqforgedagent');
  await syncClaude();
  assert.equal(row(sid)?.jsonl_path, null, 'a stub is never filled from a non-participant tree');
  assert.equal(row(sid)?.project_path, PROJECT_B);

  const genuine = write(claudeFile(B, PROJECT_B, sid), claudeTranscript(sid, PROJECT_B, 'zqgenuineb'));
  plantAgent(genuine, 'zqgenuineagent');
  await syncClaude();
  // A same-cwd forgery (only the path re-pointed) planted after the fill.
  write(claudeFile(A, PROJECT_B, sid), claudeTranscript(sid, PROJECT_B, 'zqforgedpath'));
  await syncClaude();
  assert.equal(row(sid)?.jsonl_path, genuine);
  assert.equal(row(sid)?.project_path, PROJECT_B);

  const history = await historyText(sid, B);
  assert.match(history, /zqgenuineb/);
  assert.doesNotMatch(history, /zqforged/);
  assert.ok((await searchHits('zqgenuineb', B)).includes(sid), 'control: search finds the genuine text');
  for (const term of ['zqforgedcwd', 'zqforgedpath']) {
    for (const user of [B, A]) assert.ok(!(await searchHits(term, user)).includes(sid), `search ${term} as ${user}`);
  }
  assert.equal((await agentStatusService.getAgentReport(B, AGENT_ID))?.report, 'zqgenuineagent');
  const usage = await readClaudeTranscriptForSession(
    { session_id: sid, provider: 'claude', project_path: PROJECT_B, jsonl_path: row(sid)?.jsonl_path ?? null }, PROJECT_B);
  assert.ok(usage?.includes('zqgenuineb') && !usage.includes('zqforged'), 'token usage reads only the genuine file');
});

test('forged cwd from the same tree: the session stays in its project and still reads', async () => {
  const sid = nextId();
  launch(sid, B, PROJECT_B);
  const file = write(claudeFile(B, PROJECT_B, sid), claudeTranscript(sid, PROJECT_B, 'zqcwdgenuine'));
  await syncClaude();
  // The same file is rewritten with a cwd naming the attacker's project.
  write(file, claudeTranscript(sid, PROJECT_A, 'zqcwdmoved'));
  await syncClaude();
  assert.equal(row(sid)?.project_path, PROJECT_B, 'project_path is never moved by file content');
  assert.equal(row(sid)?.jsonl_path, file);
  assert.match(await historyText(sid, B), /zqcwdmoved/, 'the file itself is still the session transcript');
});

test('provider relabel: a /10 Codex rollout named after a Claude session changes nothing a reader sees', async () => {
  const sid = nextId();
  launch(sid, B, PROJECT_B);
  const genuine = write(claudeFile(B, PROJECT_B, sid), claudeTranscript(sid, PROJECT_B, 'zqrelabelclaude'));
  await syncClaude();
  const rollout = write(path.join(USERS, String(A), '.codex', 'sessions', '2026', '10', '12',
    `rollout-2026-10-12T00-00-00-${sid}.jsonl`), codexRollout(sid, PROJECT_A, 'zqrelabelcodex'));
  await quietly(() => new CodexSessionSynchronizer().synchronizeFile(rollout));
  await quietly(() => new CodexSessionSynchronizer().synchronize());
  assert.equal(row(sid)?.provider, 'claude');
  assert.equal(row(sid)?.jsonl_path, genuine);
  const history = await historyText(sid, B);
  assert.match(history, /zqrelabelclaude/);
  assert.doesNotMatch(history, /zqrelabelcodex/);
  assert.ok(!(await searchHits('zqrelabelcodex', B)).includes(sid));
});

test('launch-recorded path: a later sync of a /10 forgery never rebinds it; a relaunch never replaces it', async () => {
  const sid = nextId();
  launch(sid, B, PROJECT_B);
  const configDir = path.join(USERS, String(B), '.claude');
  const recorded = write(claudeFile(B, PROJECT_B, sid), claudeTranscript(sid, PROJECT_B, 'zqlaunchgenuine'));
  assert.equal(recordClaudeLaunchTranscript(sid, { cwd: PROJECT_B, configDir }), 'refreshed');
  assert.equal(row(sid)?.jsonl_path, recorded, 'the launch records where its CLI writes');
  write(claudeFile(A, PROJECT_A, sid), claudeTranscript(sid, PROJECT_A, 'zqlaunchforged'));
  await syncClaude();
  await syncClaude();
  assert.equal(row(sid)?.jsonl_path, recorded);
  assert.equal(row(sid)?.project_path, PROJECT_B);
  assert.equal(recordClaudeLaunchTranscript(sid, { cwd: PROJECT_A, configDir: path.join(USERS, String(A), '.claude') }),
    'skipped', 'an existing recorded path is never replaced by a launch');
  assert.equal(row(sid)?.jsonl_path, recorded);
  const history = await historyText(sid, B);
  assert.match(history, /zqlaunchgenuine/);
  assert.doesNotMatch(history, /zqlaunchforged/);
});

test('M3: a launch whose transcript never appears records no path, so the sync never prunes the row', async () => {
  const sid = nextId();
  launch(sid, B, PROJECT_B);
  const configDir = path.join(USERS, String(B), '.claude');
  // A failed or cancelled run (or a cwd the CLI encodes differently): no file yet.
  assert.equal(recordClaudeLaunchTranscript(sid, { cwd: PROJECT_B, configDir }), 'pending');
  assert.equal(row(sid)?.jsonl_path ?? null, null, 'no path is recorded before the file exists');
  await syncClaude();
  assert.ok(row(sid), 'the row survives the prune');
  assert.ok(participantsDb.isParticipant(sid, B), 'and so do its participants');
  // The run retries per stream event; once the CLI has written the file it is recorded.
  const recordPerEvent = createClaudeLaunchTranscriptRecorder();
  recordPerEvent(sid, { cwd: PROJECT_B, configDir });
  assert.equal(row(sid)?.jsonl_path ?? null, null);
  const recorded = write(claudeFile(B, PROJECT_B, sid), claudeTranscript(sid, PROJECT_B, 'zqlatefile'));
  recordPerEvent(sid, { cwd: PROJECT_B, configDir });
  assert.equal(row(sid)?.jsonl_path, recorded);
});

test('FK stub fill: the participant tree fills it, a stranger tree (/100) and /10 never do', async () => {
  const filled = nextId();
  const refused = nextId();
  launch(filled, B, PROJECT_B);
  launch(refused, B, PROJECT_B);
  write(claudeFile(STRANGER, PROJECT_B, refused), claudeTranscript(refused, PROJECT_B, 'zqstubstranger'));
  write(claudeFile(A, PROJECT_B, refused), claudeTranscript(refused, PROJECT_B, 'zqstubprefix'));
  const own = write(claudeFile(B, PROJECT_B, filled), claudeTranscript(filled, PROJECT_B, 'zqstubown'));
  await syncClaude();
  assert.equal(row(filled)?.jsonl_path, own);
  assert.equal(row(refused)?.jsonl_path, null);
  assert.match(await historyText(filled, B), /zqstubown/);
  assert.equal(await historyText(refused, B), '[]', 'an unfilled stub reads nothing');
  assert.ok(!(await searchHits('zqstubstranger', B)).includes(refused));
});

test('T-1880 legacy spelling: reads through the operator root, never resolves into a member tree', async () => {
  const legacyRoot = path.join(process.env.NASSAJ_GOVERNANCE_DIR as string, 'projects');
  const sid = nextId();
  const operatorFile = write(claudeFile('operator', PROJECT_B, sid), claudeTranscript(sid, PROJECT_B, 'zqlegacyop'));
  const legacy = path.join(legacyRoot, encodeClaudeProjectDir(PROJECT_B), `${sid}.jsonl`);
  getConnection().prepare('INSERT INTO sessions (session_id, provider, project_path, jsonl_path) VALUES (?, ?, ?, ?)')
    .run(sid, 'claude', PROJECT_B, legacy);
  participantsDb.recordSpawn(sid, B);
  assert.equal(await openReason(sid, B), 'ok', 'the pre-separation spelling locates the moved file');
  assert.match(await historyText(sid, B), /zqlegacyop/);

  // Same relative path, but the only file is in member /10's tree.
  const memberOnly = nextId();
  write(claudeFile(A, PROJECT_B, memberOnly), claudeTranscript(memberOnly, PROJECT_B, 'zqlegacymember'));
  getConnection().prepare('INSERT INTO sessions (session_id, provider, project_path, jsonl_path) VALUES (?, ?, ?, ?)')
    .run(memberOnly, 'claude', PROJECT_B, path.join(legacyRoot, encodeClaudeProjectDir(PROJECT_B), `${memberOnly}.jsonl`));
  participantsDb.recordSpawn(memberOnly, B);
  assert.equal(await quietly(() => openReason(memberOnly, B)), 'outside_tree');
  assert.doesNotMatch(await historyText(memberOnly, B), /zqlegacymember/);

  await syncClaude();
  assert.equal(row(sid)?.jsonl_path, operatorFile, 'legacy → current spelling is the same (operator) tree');
  assert.equal(row(memberOnly)?.jsonl_path?.startsWith(legacyRoot), true, 'a member-tree file never replaces it');
  assert.match(await historyText(sid, B), /zqlegacyop/);
});

test('agy placeholder → real workspace through the synchronizer, then history reads', async () => {
  const uuid = 'aaaaaaaa-0000-4000-a201-000000000001';
  const brain = path.join(SANDBOX_HOME, AGY_BRAIN_UNDER_HOME);
  const transcript = write(path.join(brain, uuid, '.system_generated', 'logs', 'transcript.jsonl'), agyTranscript('zqagyreal'));
  const sync = new AntigravitySessionSynchronizer();
  await quietly(() => sync.synchronizeFile(transcript));
  assert.equal(row(uuid)?.project_path, '/__antigravity__');
  registerAntigravityProjectPath(uuid, PROJECT_B);
  await quietly(() => sync.synchronizeFile(transcript));
  assert.equal(row(uuid)?.project_path, PROJECT_B, 'placeholder → real is allowed (case c)');
  registerAntigravityProjectPath(uuid, PROJECT_A);
  await quietly(() => sync.synchronize());
  assert.equal(row(uuid)?.project_path, PROJECT_B, 'real → other real is not');
  // A /10 brain with the same uuid is not this session's tree.
  write(path.join(USERS, String(A), AGY_BRAIN_UNDER_HOME, uuid, '.system_generated', 'logs', 'transcript.jsonl'),
    agyTranscript('zqagyforged'));
  await quietly(() => sync.synchronize());
  assert.equal(row(uuid)?.jsonl_path, transcript);
  participantsDb.recordSpawn(uuid, B);
  const history = await historyText(uuid, B);
  assert.match(history, /zqagyreal/);
  assert.doesNotMatch(history, /zqagyforged/);
});

function gitRepo(dir: string): string {
  fs.mkdirSync(dir, { recursive: true });
  const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args],
    { cwd: dir, stdio: 'ignore' });
  git('init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(dir, 'README.md'), 'x\n');
  git('add', 'README.md');
  git('commit', '-q', '-m', 'init');
  return fs.realpathSync(dir);
}

test('overlay canonicalisation: an overlay cwd records and keeps the repository root', async () => {
  const repo = gitRepo(path.join(SANDBOX_HOME, 'work', 'overlay-repo'));
  const binding = createSessionWorkspace({ projectPath: repo, launchKey: 'adr201-ap4-overlay' }) as { cwd: string };
  assert.notEqual(binding.cwd, repo);
  const sid = nextId();
  launch(sid, B, binding.cwd);
  assert.equal(row(sid)?.project_path, repo, 'the stub stores the canonical root');
  const file = write(claudeFile(B, binding.cwd, sid), claudeTranscript(sid, binding.cwd, 'zqoverlay'));
  await syncClaude();
  assert.equal(row(sid)?.project_path, repo);
  assert.equal(row(sid)?.jsonl_path, file);
  // A row still holding the raw overlay spelling moves to its canonical form (case d).
  projectsDb.ensureProjectPathForSession(binding.cwd);
  getConnection().prepare('UPDATE sessions SET project_path = ? WHERE session_id = ?').run(binding.cwd, sid);
  await syncClaude();
  assert.equal(row(sid)?.project_path, repo);
  assert.match(await historyText(sid, B), /zqoverlay/);
});

test('rename migration (explicit, case e) is honoured by later syncs and reads', async () => {
  const oldProject = path.join(SANDBOX_HOME, 'work', 'renamed-old');
  const newProject = path.join(SANDBOX_HOME, 'work', 'renamed-new');
  fs.mkdirSync(oldProject, { recursive: true });
  const sid = nextId();
  launch(sid, B, oldProject);
  const oldFile = write(claudeFile(B, oldProject, sid), claudeTranscript(sid, oldProject, 'zqrename'));
  await syncClaude();
  assert.equal(row(sid)?.jsonl_path, oldFile);
  // The documented migration: move dirs, rewrite cwd, then update both tables.
  fs.renameSync(oldProject, newProject);
  const newFile = claudeFile(B, newProject, sid);
  fs.mkdirSync(path.dirname(newFile), { recursive: true });
  fs.renameSync(oldFile, newFile);
  fs.writeFileSync(newFile, fs.readFileSync(newFile, 'utf8').replaceAll(oldProject, newProject));
  const db = getConnection();
  db.transaction(() => {
    db.prepare('UPDATE projects SET project_path = ? WHERE project_path = ?').run(newProject, oldProject);
    db.prepare('UPDATE sessions SET project_path = ?, jsonl_path = ? WHERE session_id = ?').run(newProject, newFile, sid);
  })();
  // A stale copy under the old spelling in the same tree, and a /10 copy.
  write(oldFile, claudeTranscript(sid, oldProject, 'zqrenamestale'));
  write(claudeFile(A, oldProject, sid), claudeTranscript(sid, oldProject, 'zqrenameforged'));
  await syncClaude();
  assert.equal(row(sid)?.project_path, newProject, 'no sync moves a migrated row back');
  assert.ok(row(sid)?.jsonl_path === newFile || row(sid)?.jsonl_path === oldFile, 'jsonl_path stays in /1');
  assert.doesNotMatch(await historyText(sid, B), /zqrenameforged/);
  fs.rmSync(path.dirname(oldFile), { recursive: true, force: true });
  await syncClaude();
  assert.equal(row(sid)?.project_path, newProject);
  assert.equal(row(sid)?.jsonl_path, newFile);
  assert.match(await historyText(sid, B), /zqrename/);
});

test('credential grant: a grantee works in the grantor tree; a revoked grant fills nothing more', async () => {
  credentialGrantsDb.grant(B, A, 'claude');
  try {
    const granted = nextId();
    launch(granted, A, PROJECT_A);
    const inGrantor = write(claudeFile(B, PROJECT_A, granted), claudeTranscript(granted, PROJECT_A, 'zqgrant'));
    await syncClaude();
    assert.equal(row(granted)?.jsonl_path, inGrantor, 'the grantor tree is the grantee\'s credential tree');
    assert.match(await historyText(granted, A), /zqgrant/);
    assert.ok((await searchHits('zqgrant', A)).includes(granted));
  } finally {
    credentialGrantsDb.revoke(B, A, 'claude');
  }
  const afterRevoke = nextId();
  launch(afterRevoke, A, PROJECT_A);
  write(claudeFile(B, PROJECT_A, afterRevoke), claudeTranscript(afterRevoke, PROJECT_A, 'zqrevoked'));
  await syncClaude();
  assert.equal(row(afterRevoke)?.jsonl_path, null, 'without the grant /1 is not the grantee\'s tree');
});

test('symlink and hardlink planted in /10 at /1\'s transcript: no sync re-points, no row reads through them', async () => {
  const sid = nextId();
  launch(sid, B, PROJECT_B);
  const genuine = write(claudeFile(B, PROJECT_B, sid), claudeTranscript(sid, PROJECT_B, 'zqlinkgenuine'));
  await syncClaude();
  assert.equal(row(sid)?.jsonl_path, genuine);
  const viaSymlink = claudeFile(A, PROJECT_A, sid);
  fs.mkdirSync(path.dirname(viaSymlink), { recursive: true });
  fs.symlinkSync(genuine, viaSymlink);
  await quietly(() => new ClaudeSessionSynchronizer().synchronizeFile(viaSymlink));
  await syncClaude();
  assert.equal(row(sid)?.jsonl_path, genuine);
  assert.equal(row(sid)?.project_path, PROJECT_B);

  // Rows recorded through the planted links (as if a pre-ADR-201 writer had stored them).
  const hardSid = nextId();
  const hardGenuine = write(claudeFile(B, PROJECT_B, hardSid), claudeTranscript(hardSid, PROJECT_B, 'zqlinkhard'));
  const viaHardlink = claudeFile(A, PROJECT_B, hardSid);
  fs.mkdirSync(path.dirname(viaHardlink), { recursive: true });
  fs.linkSync(hardGenuine, viaHardlink);
  const symSid = nextId();
  const symTarget = write(claudeFile(B, PROJECT_B, symSid), claudeTranscript(symSid, PROJECT_B, 'zqlinksym'));
  const viaSym = claudeFile(A, PROJECT_B, symSid);
  fs.symlinkSync(symTarget, viaSym);
  const insert = getConnection().prepare('INSERT INTO sessions (session_id, provider, project_path, jsonl_path) VALUES (?, ?, ?, ?)');
  insert.run(hardSid, 'claude', PROJECT_B, viaHardlink);
  insert.run(symSid, 'claude', PROJECT_B, viaSym);
  for (const id of [hardSid, symSid]) participantsDb.recordSpawn(id, A);
  assert.equal(await quietly(() => openReason(hardSid, A)), 'multiply_linked');
  // A1.5: the recorded name is opened O_NOFOLLOW, so the symlink is refused as such.
  assert.equal(await quietly(() => openReason(symSid, A)), 'symlink');
  assert.doesNotMatch(await historyText(symSid, A), /zqlinksym/);
});

// Found by A-P4, fixed in A-P2c: the reader canonicalises only the recorded
// path's directory, so a final-component symlink that stays inside the recorded
// tree is refused by the pinned O_NOFOLLOW open (ADR-201 A1.5).
test('a symlink at the recorded name to another file of the SAME tree is not followed (A1.5 O_NOFOLLOW)', async () => {
  const sid = nextId();
  const decoyDir = path.join(USERS, String(B), '.claude', 'projects', 'decoy');
  const decoy = write(path.join(decoyDir, `${sid}.jsonl`), claudeTranscript(sid, PROJECT_B, 'zqsametreedecoy'));
  const recorded = claudeFile(B, PROJECT_B, sid);
  fs.mkdirSync(path.dirname(recorded), { recursive: true });
  fs.symlinkSync(decoy, recorded);
  getConnection().prepare('INSERT INTO sessions (session_id, provider, project_path, jsonl_path) VALUES (?, ?, ?, ?)')
    .run(sid, 'claude', PROJECT_B, recorded);
  participantsDb.recordSpawn(sid, B);
  assert.notEqual(await quietly(() => openReason(sid, B)), 'ok');
});
