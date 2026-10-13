/**
 * B-1607 — session and project delete also remove the files a provider
 * derives from the session (Claude `<id>/subagents` and `<id>/workflows`,
 * Codex child rollouts, the agy brain directory), through the same pinned
 * park / verify / unlink step as the transcript, and never anything else.
 *
 * Driven through `removeSessionTranscript` (the one removal entry both delete
 * paths use) on rows recorded exactly as the synchronizers record them.
 * Every negative plants the most admissible-looking foreign file it can: a
 * symlinked directory or file, a hard link, a child whose header names another
 * session, a rollout of another conversation.
 *
 * Sandbox: a /var/tmp HOME with members /1 and /10; victims live in /10.
 * Headers come from the redacted real fixtures (B-1520) and the cost-test
 * header helpers (keys measured on this host).
 *
 * Runner: node scripts/run-isolated-node-tests.mjs server <this file>
 */
// FIRST import — HOME becomes a /var/tmp sandbox before anything reads it.
// eslint-disable-next-line import-x/order -- must evaluate before every other import
import { SANDBOX_HOME } from '@/shared/__tests__/sandbox-home.js';

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { initializeDatabase, userDb } from '@/modules/database/index.js';
import { AGY_BRAIN_UNDER_HOME } from '@/modules/providers/list/antigravity/agy-brain-layout.js';
import { codexHeaderLine } from '@/modules/providers/services/cost/__tests__/bound-transcripts.js';
import { setProviderSharingConfig } from '@/services/provider-sharing.js';

import { isRetryableRefusal, removeSessionTranscript } from './session-transcript-removal.js';

process.env.CLAUDE_CONFIG_DIR = path.join(SANDBOX_HOME, '.claude');
process.env.NASSAJ_GOVERNANCE_DIR = path.join(SANDBOX_HOME, 'nassaj-core');
const FIXTURES = path.join(import.meta.dirname, '..', '..', '..', 'services', '__fixtures__', 'session-share');
const CLAUDE_FIXTURE_ID = '00000000-0000-4000-a000-000000000013';
const USERS = path.join(SANDBOX_HOME, '.nassaj-users');

await initializeDatabase();
for (let filler = 1; userDb.createUser(`artifact-member-${filler}`, 'hash', 'user').id < 10; filler += 1);
setProviderSharingConfig({ claude: 'isolated' });

let counter = 0;
const nextId = (): string => `00000000-0000-4000-b000-${String(++counter).padStart(12, '0')}`;
const claudeText = (id: string): string =>
  fs.readFileSync(path.join(FIXTURES, 'claude.jsonl'), 'utf8').replaceAll(CLAUDE_FIXTURE_ID, id);
const agyText = (): string => fs.readFileSync(path.join(FIXTURES, 'antigravity.jsonl'), 'utf8');
const claudeLine = (sessionId: string): string =>
  `${JSON.stringify({ type: 'user', sessionId, isSidechain: true, agentId: 'a1' })}\n`;

function write(file: string, text: string): string {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  return file;
}

const exists = (target: string): boolean => fs.existsSync(target) || fs.lstatSync(target, { throwIfNoEntry: false }) !== undefined;
const projectDir = (member: string, project: string): string => path.join(USERS, member, '.claude', 'projects', project);

type Claude = { id: string; transcript: string; sessionDir: string };

/** A member-1 Claude transcript with subagents (one in a workflow) and a workflow script. */
function claudeSession(project: string): Claude {
  const id = nextId();
  const transcript = write(path.join(projectDir('1', project), `${id}.jsonl`), claudeText(id));
  const sessionDir = path.join(projectDir('1', project), id);
  write(path.join(sessionDir, 'subagents', 'agent-a1.jsonl'), claudeLine(id));
  write(path.join(sessionDir, 'subagents', 'agent-a1.meta.json'), '{"agentType":"general-purpose"}');
  write(path.join(sessionDir, 'subagents', 'workflows', 'wf_1', 'agent-b2.jsonl'), claudeLine(id));
  write(path.join(sessionDir, 'workflows', 'scripts', 'run-wf_1.js'), 'export {};\n');
  return { id, transcript, sessionDir };
}

const remove = (id: string, provider: string, jsonlPath: string) =>
  removeSessionTranscript({ session_id: id, provider, jsonl_path: jsonlPath }, 'session-delete');

test('Claude: subagents/ and workflows/ go with the transcript, and the emptied <id> dir too', async () => {
  const { id, transcript, sessionDir } = claudeSession('-claude-all');
  const memory = write(path.join(projectDir('1', '-claude-all'), 'memory', 'MEMORY.md'), 'project memory');
  assert.deepEqual(await remove(id, 'claude', transcript), { removed: true });
  assert.equal(exists(transcript), false);
  assert.equal(exists(sessionDir), false, 'subagents, workflows and the emptied session dir are gone');
  assert.equal(fs.readFileSync(memory, 'utf8'), 'project memory', 'the project memory is not the session\'s');
});

test('Claude: a symlinked subagents dir and a symlinked child are never followed', async () => {
  const { id, transcript, sessionDir } = claudeSession('-claude-links');
  const victimDir = path.join(projectDir('10', '-victim'), 'victim-subagents');
  const victim = write(path.join(victimDir, 'agent-v.jsonl'), claudeLine(id));
  fs.rmSync(path.join(sessionDir, 'workflows'), { recursive: true });
  fs.symlinkSync(victimDir, path.join(sessionDir, 'workflows'));
  fs.symlinkSync(victim, path.join(sessionDir, 'subagents', 'agent-link.jsonl'));
  assert.deepEqual(await remove(id, 'claude', transcript), { removed: true });
  assert.equal(fs.readFileSync(victim, 'utf8'), claudeLine(id), 'the victim is untouched');
  assert.equal(fs.lstatSync(path.join(sessionDir, 'workflows')).isSymbolicLink(), true, 'the planted link is left');
  assert.equal(exists(path.join(sessionDir, 'subagents', 'agent-a1.jsonl')), false, 'own children still go');
});

test('Claude: a hard-linked child and a child naming another session are kept', async () => {
  const { id, transcript, sessionDir } = claudeSession('-claude-hard');
  const victim = write(path.join(projectDir('10', '-victim-hard'), `${nextId()}.jsonl`), claudeLine(id));
  fs.linkSync(victim, path.join(sessionDir, 'subagents', 'agent-hard.jsonl'));
  const foreign = write(path.join(sessionDir, 'subagents', 'agent-foreign.jsonl'), claudeLine(nextId()));
  assert.deepEqual(await remove(id, 'claude', transcript), { removed: true });
  assert.equal(fs.readFileSync(victim, 'utf8'), claudeLine(id));
  assert.equal(fs.statSync(victim).nlink, 2, 'the hard link was not removed');
  assert.equal(exists(foreign), true, 'a child bound to another session is not this one\'s');
});

test('Claude: a session dir that is a symlink into /10 is not walked', async () => {
  const id = nextId();
  const transcript = write(path.join(projectDir('1', '-claude-dir-link'), `${id}.jsonl`), claudeText(id));
  const victim = write(path.join(projectDir('10', '-victim-session'), id, 'subagents', 'agent-v.jsonl'), claudeLine(id));
  fs.symlinkSync(path.join(projectDir('10', '-victim-session'), id), path.join(projectDir('1', '-claude-dir-link'), id));
  assert.deepEqual(await remove(id, 'claude', transcript), { removed: true });
  assert.equal(fs.readFileSync(victim, 'utf8'), claudeLine(id));
});

type FsMethod = (...args: unknown[]) => Promise<unknown>;

async function withPatchedUnlink<T>(patch: (target: string) => boolean, run: () => Promise<T>): Promise<T> {
  const promises = fs.promises as unknown as Record<string, FsMethod>;
  const original = promises.unlink;
  promises.unlink = (...args) => {
    if (patch(String(args[0]))) return Promise.reject(Object.assign(new Error('synthetic EIO'), { code: 'EIO' }));
    return original.apply(fs.promises, args);
  };
  try {
    return await run();
  } finally {
    promises.unlink = original;
  }
}

test('Claude: a retryable child failure keeps the transcript (the row stays) and a retry removes all', async () => {
  const { id, transcript, sessionDir } = claudeSession('-claude-retry');
  let failures = 1;
  // The first parked unlink is a child's: derived files go before the transcript.
  const first = await withPatchedUnlink((target) => target.includes('nassaj-removing') && failures-- > 0,
    () => remove(id, 'claude', transcript));
  assert.equal(first.removed, false);
  assert.equal(!first.removed && isRetryableRefusal(first.reason), true, 'retryable, so the row is kept');
  assert.equal(exists(transcript), true, 'the transcript stays to bind the retry');
  assert.equal(fs.readFileSync(path.join(sessionDir, 'subagents', 'agent-a1.jsonl'), 'utf8'), claudeLine(id), 'put back');
  assert.deepEqual(await remove(id, 'claude', transcript), { removed: true });
  assert.equal(exists(sessionDir), false);
});

const codexRoot = path.join(SANDBOX_HOME, '.codex', 'sessions');
const rollout = (day: string, stamp: string, id: string): string =>
  path.join(codexRoot, ...day.split('-'), `rollout-${stamp}-${id}.jsonl`);

test('Codex: child rollouts bound by session_meta go, in the same and later day dirs; others stay', async () => {
  const parent = nextId();
  const transcript = write(rollout('2026-09-01', '2026-09-01T10-00-00', parent), codexHeaderLine(parent));
  const sameDay = nextId();
  const nextDay = nextId();
  const children = [
    write(rollout('2026-09-01', '2026-09-01T10-05-00', sameDay), codexHeaderLine(sameDay, { sessionId: parent, threadSource: 'subagent' })),
    write(rollout('2026-09-02', '2026-09-02T00-10-00', nextDay), codexHeaderLine(nextDay, { sessionId: parent, threadSource: 'subagent' })),
  ];
  const other = nextId();
  const forged = nextId();
  const kept = [
    // Another conversation's root and its child.
    write(rollout('2026-09-01', '2026-09-01T10-06-00', other), codexHeaderLine(other)),
    write(rollout('2026-09-01', '2026-09-01T10-07-00', nextId()), codexHeaderLine(nextId(), { sessionId: other })),
    // Named as a child, but its header carries another thread id.
    write(rollout('2026-09-01', '2026-09-01T10-08-00', forged), codexHeaderLine(nextId(), { sessionId: parent })),
    // A child that started before its parent is not one.
    write(rollout('2026-09-01', '2026-09-01T09-00-00', nextId()), codexHeaderLine(nextId(), { sessionId: parent })),
  ];
  // A planted symlink and a hard link to a /10 rollout bound to the parent.
  const victimId = nextId();
  const victim = write(path.join(USERS, '10', '.codex', 'sessions', '2026', '09', '01', `rollout-2026-09-01T10-09-00-${victimId}.jsonl`),
    codexHeaderLine(victimId, { sessionId: parent }));
  fs.symlinkSync(victim, rollout('2026-09-01', '2026-09-01T10-10-00', victimId));
  const hardId = nextId();
  const hardVictim = write(path.join(USERS, '10', '.codex', 'sessions', `rollout-2026-09-01T10-11-00-${hardId}.jsonl`),
    codexHeaderLine(hardId, { sessionId: parent }));
  fs.linkSync(hardVictim, rollout('2026-09-01', '2026-09-01T10-11-00', hardId));

  assert.deepEqual(await remove(parent, 'codex', transcript), { removed: true });
  assert.equal(exists(transcript), false);
  for (const child of children) assert.equal(exists(child), false, path.basename(child));
  for (const file of kept) assert.equal(exists(file), true, path.basename(file));
  assert.equal(fs.readFileSync(victim, 'utf8'), codexHeaderLine(victimId, { sessionId: parent }));
  assert.equal(fs.statSync(hardVictim).nlink, 2, 'the hard link was not removed');
});

test('Codex: a day directory that is a symlink into /10 is not walked', async () => {
  const parent = nextId();
  const transcript = write(rollout('2026-10-01', '2026-10-01T10-00-00', parent), codexHeaderLine(parent));
  const childId = nextId();
  const victimDay = path.join(USERS, '10', '.codex', 'sessions', '2026', '10', '02');
  const victim = write(path.join(victimDay, `rollout-2026-10-02T00-00-00-${childId}.jsonl`), codexHeaderLine(childId, { sessionId: parent }));
  fs.symlinkSync(victimDay, path.join(codexRoot, '2026', '10', '02'));
  assert.deepEqual(await remove(parent, 'codex', transcript), { removed: true });
  assert.equal(exists(victim), true);
});

const agyRoot = path.join(SANDBOX_HOME, AGY_BRAIN_UNDER_HOME);

test('agy: the brain directory named after the session goes whole', async () => {
  const id = nextId();
  const brain = path.join(agyRoot, id);
  const transcript = write(path.join(brain, '.system_generated', 'logs', 'transcript.jsonl'), agyText());
  write(path.join(brain, '.system_generated', 'messages', `${nextId()}.json`), '{}');
  write(path.join(brain, 'scratch', 'notes.md'), 'n');
  write(path.join(brain, 'plan.md'), 'p');
  fs.mkdirSync(path.join(brain, '.user_uploaded'));
  const neighbour = write(path.join(agyRoot, nextId(), '.system_generated', 'logs', 'transcript.jsonl'), agyText());
  assert.deepEqual(await remove(id, 'antigravity', transcript), { removed: true });
  assert.equal(exists(brain), false);
  assert.equal(exists(neighbour), true, 'another session\'s brain stays');
});

test('agy: a symlink and a hard link inside the brain are not followed; the brain stays non-empty', async () => {
  const id = nextId();
  const brain = path.join(agyRoot, id);
  const transcript = write(path.join(brain, '.system_generated', 'logs', 'transcript.jsonl'), agyText());
  const victimDir = path.join(USERS, '10', AGY_BRAIN_UNDER_HOME, nextId());
  const victim = write(path.join(victimDir, 'plan.md'), 'victim');
  fs.symlinkSync(victimDir, path.join(brain, 'scratch'));
  fs.linkSync(victim, path.join(brain, 'hard.md'));
  write(path.join(brain, 'own.md'), 'own');
  assert.deepEqual(await remove(id, 'antigravity', transcript), { removed: true });
  assert.equal(fs.readFileSync(victim, 'utf8'), 'victim');
  assert.equal(fs.statSync(victim).nlink, 2);
  assert.equal(exists(path.join(brain, 'own.md')), false);
  assert.equal(exists(transcript), false);
  assert.deepEqual(fs.readdirSync(brain).sort(), ['hard.md', 'scratch'], 'only the refused entries are left');
});

test('Codex (qa C1): a manual user fork, a legacy back-reference and a child with its own row all survive', async () => {
  const { getConnection } = await import('@/modules/database/index.js');
  const parent = nextId();
  const transcript = write(rollout('2026-11-01', '2026-11-01T10-00-00', parent), codexHeaderLine(parent));
  const [fork, legacy, rowed, child] = [nextId(), nextId(), nextId(), nextId()];
  // Shapes of codex-session-dedup.test.ts: a user fork keeps thread_source 'user' and back-references its origin.
  const forkFile = write(rollout('2026-11-01', '2026-11-01T10-01-00', fork),
    codexHeaderLine(fork, { sessionId: parent, threadSource: 'user', parentThreadId: parent }));
  const legacyLine = `${JSON.stringify({ type: 'session_meta', payload: { id: legacy, session_id: parent, forked_from_id: parent } })}\n`;
  const legacyFile = write(rollout('2026-11-01', '2026-11-01T10-02-00', legacy), legacyLine);
  const rowedFile = write(rollout('2026-11-01', '2026-11-01T10-03-00', rowed),
    codexHeaderLine(rowed, { sessionId: parent, threadSource: 'subagent' }));
  getConnection().prepare('INSERT INTO sessions (session_id, provider, project_path, jsonl_path) VALUES (?, ?, NULL, ?)')
    .run(rowed, 'codex', rowedFile);
  const childFile = write(rollout('2026-11-01', '2026-11-01T10-04-00', child),
    codexHeaderLine(child, { sessionId: parent, threadSource: 'subagent' }));
  assert.deepEqual(await remove(parent, 'codex', transcript), { removed: true });
  for (const file of [forkFile, legacyFile, rowedFile]) assert.equal(exists(file), true, path.basename(file));
  assert.equal(exists(childFile), false, 'a subagent child still goes');
});
