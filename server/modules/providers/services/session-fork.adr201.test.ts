/**
 * B-1597 (ADR-201 L2) — the session fork reads its source only through the
 * pinned, tree-confined, id-bound reader (openRecordedTranscript), so a member
 * whose transcript lives in their own tree can fork it, and a forged or
 * planted source is refused before anything is written.
 *
 * Driven through the real `forkSessionAtMessage` / `forkSessionFromSideQuery`
 * and the real `forkClaudeTranscript`. Only the synchronizer is replaced (it
 * indexes the new file; here it records the call, or fails on demand).
 *
 * Sandbox: a /var/tmp HOME with members /1 and /10 (the prefix trap). Headers
 * come from the redacted real Claude fixture (B-1520).
 *
 * Runner: node scripts/run-isolated-node-tests.mjs server <this file>
 */
// FIRST import — HOME becomes a /var/tmp sandbox before anything reads it.
// eslint-disable-next-line import-x/order -- must evaluate before every other import
import { SANDBOX_HOME } from '@/shared/__tests__/sandbox-home.js';

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { mock, test } from 'node:test';

const synced: string[] = [];
const syncState = { fail: false };
mock.module('@/modules/providers/services/session-synchronizer.service.js', {
  namedExports: {
    sessionSynchronizerService: {
      synchronizeProviderFile: async (_provider: string, filePath: string) => {
        if (syncState.fail) throw new Error('index offline');
        synced.push(filePath);
      },
    },
  },
});

const { getConnection, initializeDatabase, participantsDb, projectsDb, userDb } = await import('@/modules/database/index.js');
const { setProviderSharingConfig } = await import('@/services/provider-sharing.js');
const { forkSessionAtMessage, forkSessionFromSideQuery, SessionForkError } = await import('./session-fork.service.js');

process.env.CLAUDE_CONFIG_DIR = path.join(SANDBOX_HOME, '.claude');
process.env.NASSAJ_GOVERNANCE_DIR = path.join(SANDBOX_HOME, 'nassaj-core');
const FIXTURE = path.join(import.meta.dirname, '..', '..', '..', 'services', '__fixtures__', 'session-share', 'claude.jsonl');
const FIXTURE_ID = '00000000-0000-4000-a000-000000000013';
const FIXTURE_CWD = '/home/operator/Project/General';
/** A primary assistant record of the fixture: the cut point of a message fork. */
const ASSISTANT_UUID = '00000000-0000-4000-9000-00000000000a';
const USERS = path.join(SANDBOX_HOME, '.nassaj-users');

await initializeDatabase();
const ownerId = userDb.createUser('fork-owner', 'hash-o', 'user').id;
for (let filler = 2; userDb.createUser(`fork-member-${filler}`, 'hash', 'user').id < 10; filler += 1);
setProviderSharingConfig({ claude: 'isolated' });

const projectPath = path.join(SANDBOX_HOME, 'workspaces', 'fork');
fs.mkdirSync(projectPath, { recursive: true });
const storedProjectPath = projectsDb.createProjectPath(projectPath, null, ownerId).project!.project_path;
const encoded = projectPath.replace(/[^a-zA-Z0-9-]/g, '-');

let counter = 0;
const nextId = (): string => `00000000-0000-4000-b000-${String(++counter).padStart(12, '0')}`;
const claudeText = (id: string): string => fs.readFileSync(FIXTURE, 'utf8')
  .replaceAll(FIXTURE_ID, id).replaceAll(FIXTURE_CWD, projectPath);
const memberClaude = (member: string, id: string, project = encoded): string =>
  path.join(USERS, member, '.claude', 'projects', project, `${id}.jsonl`);

function write(file: string, text: string): string {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, { mode: 0o600 });
  return file;
}

/** A Claude session row of the project recording `jsonlPath`, launched by the owner. */
function recordSession(id: string, jsonlPath: string | null): void {
  getConnection().prepare('INSERT INTO sessions (session_id, provider, project_path, jsonl_path) VALUES (?, ?, ?, ?)')
    .run(id, 'claude', storedProjectPath, jsonlPath);
  participantsDb.recordSpawn(id, ownerId);
}

const isNotFound = (error: unknown): boolean =>
  error instanceof SessionForkError && error.code === 'transcript_not_found';

/** Names in `dir` other than `keep` (what a refused fork must not have written). */
const extraNames = (dir: string, keep: string[]): string[] =>
  fs.readdirSync(dir).filter((name) => !keep.includes(name));

test('a member forks a transcript in their own tree at a message', async () => {
  const id = nextId();
  const source = write(memberClaude('1', id), claudeText(id));
  recordSession(id, source);
  synced.length = 0;
  const result = await forkSessionAtMessage({ sessionId: id, upToMessageId: ASSISTANT_UUID, userId: ownerId });
  const forked = path.join(path.dirname(source), `${result.sessionId}.jsonl`);
  assert.deepEqual(synced, [forked], 'the branch lands beside its source, in the member tree');
  const lines = fs.readFileSync(forked, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  assert.ok(lines.length >= 2);
  assert.ok(lines.every((line) => line.sessionId === result.sessionId), 'every entry is the new session');
  assert.equal(fs.readFileSync(source, 'utf8'), claudeText(id), 'the source is untouched');
});

test('a member forks a side question (fresh) from their own tree', async () => {
  const id = nextId();
  const source = write(memberClaude('1', id), claudeText(id));
  recordSession(id, source);
  const result = await forkSessionFromSideQuery({
    sessionId: id, question: 'why?', answer: 'because', userId: ownerId, mode: 'fresh',
  });
  assert.equal(fs.existsSync(path.join(path.dirname(source), `${result.sessionId}.jsonl`)), true);
});

test('a forged path to member 10\'s transcript is refused and nothing is written', async () => {
  const id = nextId();
  const victimId = nextId();
  const victim = write(memberClaude('10', victimId, '-victim'), claudeText(victimId));
  recordSession(id, victim);
  await assert.rejects(() => forkSessionAtMessage({ sessionId: id, upToMessageId: ASSISTANT_UUID, userId: ownerId }), isNotFound);
  assert.deepEqual(extraNames(path.dirname(victim), [path.basename(victim)]), []);
});

test('a symlink planted at the recorded name in /1, pointing into /10, is refused', async () => {
  const id = nextId();
  const victim = write(memberClaude('10', id, '-victim-link'), claudeText(id));
  const planted = memberClaude('1', id, '-planted');
  fs.mkdirSync(path.dirname(planted), { recursive: true });
  fs.symlinkSync(victim, planted);
  recordSession(id, planted);
  await assert.rejects(() => forkSessionAtMessage({ sessionId: id, upToMessageId: ASSISTANT_UUID, userId: ownerId }), isNotFound);
  assert.deepEqual(extraNames(path.dirname(victim), [path.basename(victim)]), []);
});

test('a project-directory link from /1 into /10 is not followed', async () => {
  const id = nextId();
  const victim = write(memberClaude('10', id, '-victim-dir'), claudeText(id));
  fs.symlinkSync(path.dirname(victim), path.join(USERS, '1', '.claude', 'projects', '-dir-link'));
  recordSession(id, memberClaude('1', id, '-dir-link'));
  await assert.rejects(() => forkSessionAtMessage({ sessionId: id, upToMessageId: ASSISTANT_UUID, userId: ownerId }), isNotFound);
  assert.deepEqual(extraNames(path.dirname(victim), [path.basename(victim)]), []);
});

test('a file whose header names another session is refused even under its own name', async () => {
  const id = nextId();
  const source = write(memberClaude('1', id, '-header'), claudeText(nextId()));
  recordSession(id, source);
  await assert.rejects(() => forkSessionAtMessage({ sessionId: id, upToMessageId: ASSISTANT_UUID, userId: ownerId }), isNotFound);
  assert.deepEqual(extraNames(path.dirname(source), [path.basename(source)]), []);
});

test('a source outside its project directory is refused', async () => {
  const id = nextId();
  const source = write(memberClaude('1', id, '-another-project'), claudeText(id));
  recordSession(id, source);
  await assert.rejects(() => forkSessionAtMessage({ sessionId: id, upToMessageId: ASSISTANT_UUID, userId: ownerId }), isNotFound);
});

test('a failed registration removes the new branch through the confined primitive; the source stays', async () => {
  const id = nextId();
  const source = write(memberClaude('1', id), claudeText(id));
  recordSession(id, source);
  const before = fs.readdirSync(path.dirname(source)).sort();
  syncState.fail = true;
  try {
    await assert.rejects(
      () => forkSessionAtMessage({ sessionId: id, upToMessageId: ASSISTANT_UUID, userId: ownerId }),
      (error: unknown) => error instanceof SessionForkError && error.code === 'fork_failed',
    );
  } finally {
    syncState.fail = false;
  }
  assert.deepEqual(fs.readdirSync(path.dirname(source)).sort(), before, 'no branch, no parked name left');
  assert.equal(fs.readFileSync(source, 'utf8'), claudeText(id));
});
