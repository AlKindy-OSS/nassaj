/**
 * T-1880 (resolver fallback, L-D): rows whose `jsonl_path` is spelled with the
 * pre-separation governance root keep resolving once the transcript lives under
 * the real `~/.claude/projects` — with no compat link left behind — and the
 * ghost sweep deletes only rows whose file is gone everywhere.
 */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { mock } from 'node:test';

import { closeConnection, initializeDatabase, sessionsDb, userDb } from '@/modules/database/index.js';
import { ClaudeSessionSynchronizer } from '@/modules/providers/list/claude/claude-session-synchronizer.provider.js';
import { ClaudeSessionsProvider } from '@/modules/providers/list/claude/claude-sessions.provider.js';

import { listClaudeConfigDirsReadOnly } from '../claude-home.js';
import { claudeRootLists, resolveStoredClaudeTranscript } from '../claude-projects-roots.js';
import { resolveClaudeTranscriptPath } from '../claude-transcript-path.js';

const LIVE = 'aaaaaaaa-0000-0000-0000-000000000001';
const GHOST = 'aaaaaaaa-0000-0000-0000-000000000002';
const SLUG = '-workspace-demo';

type Fixture = { base: string; core: string; realFile: string; legacyPath: (id: string) => string };

async function withFixture(run: (fixture: Fixture) => Promise<void>): Promise<void> {
  const base = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'claude-legacy-')));
  const saved = { db: process.env.DATABASE_PATH, gov: process.env.NASSAJ_GOVERNANCE_DIR, homedir: os.homedir };
  const core = path.join(base, 'nassaj-core');
  closeConnection();
  process.env.DATABASE_PATH = path.join(base, 'auth.db');
  process.env.NASSAJ_GOVERNANCE_DIR = core;
  (os as { homedir: () => string }).homedir = () => base;
  await initializeDatabase();
  mkdirSync(path.join(core, 'projects'), { recursive: true });
  mkdirSync(path.join(base, '.claude', 'projects', SLUG), { recursive: true });
  const realFile = path.join(base, '.claude', 'projects', SLUG, `${LIVE}.jsonl`);
  writeFileSync(realFile, `${JSON.stringify({ sessionId: LIVE, cwd: '/workspace/demo', type: 'user' })}\n`);
  const legacyPath = (id: string) => path.join(core, 'projects', SLUG, `${id}.jsonl`);
  for (const id of [LIVE, GHOST]) {
    sessionsDb.createSession(id, 'claude', '/workspace/demo', undefined, undefined, undefined, legacyPath(id));
  }
  try {
    await run({ base, core, realFile, legacyPath });
  } finally {
    closeConnection();
    (os as { homedir: () => string }).homedir = saved.homedir;
    if (saved.db === undefined) delete process.env.DATABASE_PATH; else process.env.DATABASE_PATH = saved.db;
    if (saved.gov === undefined) delete process.env.NASSAJ_GOVERNANCE_DIR; else process.env.NASSAJ_GOVERNANCE_DIR = saved.gov;
    rmSync(base, { recursive: true, force: true });
  }
}

test('a legacy-spelled jsonl_path resolves to the file under the current projects root', async () => {
  await withFixture(async ({ realFile, legacyPath }) => {
    assert.equal(resolveStoredClaudeTranscript(legacyPath(LIVE)), realFile);
    assert.equal(resolveStoredClaudeTranscript(legacyPath(GHOST)), null);
    assert.equal(await resolveClaudeTranscriptPath({ session_id: LIVE, jsonl_path: legacyPath(LIVE) }, null), realFile);
  });
});

test('ghost sweep keeps relocated rows and deletes only transcripts gone everywhere', async () => {
  await withFixture(async () => {
    const sync = new ClaudeSessionSynchronizer();
    const pruned = await (sync as unknown as { pruneDeletedSessionFiles(): Promise<number> }).pruneDeletedSessionFiles();
    assert.equal(pruned, 1);
    assert.ok(sessionsDb.getSessionById(LIVE), 'relocated transcript keeps its row');
    assert.ok(!sessionsDb.getSessionById(GHOST), 'a genuinely missing transcript is still swept');
  });
});

test('M1: history read on a present stored path neither enumerates users nor provisions', async () => {
  await withFixture(async ({ base, realFile }) => {
    userDb.createUser('t1880-member', 'hash', 'user');
    writeFileSync(realFile, `${JSON.stringify({ sessionId: LIVE, cwd: '/workspace/demo', type: 'user', uuid: 'u1',
      timestamp: '2026-09-27T10:00:00.000Z', message: { role: 'user', content: 'hello' } })}\n`);
    sessionsDb.createSession(LIVE, 'claude', '/workspace/demo', undefined, undefined, undefined, realFile);
    const listUsers = mock.method(userDb, 'listUsers');
    try {
      const history = await new ClaudeSessionsProvider().fetchHistory(LIVE);
      assert.ok(history.messages.length > 0, 'the transcript was read');
      assert.equal(listUsers.mock.callCount(), 0, 'no user enumeration on the present-path fast path');
    } finally {
      listUsers.mock.restore();
    }
    assert.equal(existsSync(path.join(base, '.nassaj-users')), false, 'no user dirs provisioned');
  });
});

test('M1: root lists are side-effect-free and cached per HOME/config key', async () => {
  await withFixture(async ({ base }) => {
    const member = userDb.createUser('t1880-member', 'hash', 'user');
    const homes = listClaudeConfigDirsReadOnly();
    assert.ok(homes.includes(path.join(base, '.nassaj-users', String(member.id), '.claude')), homes.join(', '));
    assert.equal(existsSync(path.join(base, '.nassaj-users')), false, 'listing never provisions');
    const listUsers = mock.method(userDb, 'listUsers');
    try {
      const first = claudeRootLists(1_000_000);
      assert.equal(claudeRootLists(1_000_500), first, 'served from cache inside the TTL');
      assert.notEqual(claudeRootLists(1_000_000 + 31_000), first, 'recomputed after the TTL');
      assert.equal(listUsers.mock.callCount(), 2);
    } finally {
      listUsers.mock.restore();
    }
  });
});

test('L5: the existing sync rewrites a legacy jsonl_path to the found spelling', async () => {
  await withFixture(async ({ realFile, legacyPath }) => {
    assert.equal(sessionsDb.getSessionById(LIVE)?.jsonl_path, legacyPath(LIVE));
    await new ClaudeSessionSynchronizer().synchronize();
    assert.equal(sessionsDb.getSessionById(LIVE)?.jsonl_path, realFile);
  });
});
