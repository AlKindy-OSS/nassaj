/**
 * B-1669 — an OpenCode session stored in a member's OWN opencode.db (per-user
 * XDG isolation) is listed by the synchronizer, so its history must load from
 * that DB too, not only from the operator DB.
 *
 * The fixtures copy the live schema (session/message/part columns) and the real
 * row shape of the failing session: message.data keys {role, time, agent, model,
 * summary} for the user turn, {parentID, role, mode, agent, path, cost, tokens,
 * modelID, providerID, time} for the assistant turn, and parts text, compaction,
 * step-start, reasoning, step-finish. Personal content is replaced by placeholders.
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { after, test } from 'node:test';

import Database from 'better-sqlite3';

// B-1544: must stay the first app-side import; it sandboxes HOME, DATABASE_PATH and the
// harness roots before any app module reads them.
import { removeSandbox } from '@/modules/providers/tests/helpers/hermetic-sandbox.js';

process.env.NASSAJ_PROVIDER_SECRETS_KEY = crypto.randomBytes(32).toString('base64');

const { initializeDatabase, closeConnection, userDb, sessionsDb, participantsDb } = await import('@/modules/database/index.js');
const { _resetProviderSecretsServerKeyCache } = await import('@/services/isolation/provider-secrets-store.js');
const { providerSecretsService } = await import('@/modules/providers/services/provider-secrets.service.js');
const { getProviderSharingConfig, setProviderSharingConfig } = await import('@/services/provider-sharing.js');
const { userConfigDir } = await import('@/services/isolation/provision-user-dirs.js');
const { peekHistoryRevision, resetHistorySnapshotCacheForTests } = await import('@/modules/providers/services/session-history-light.service.js');
const { sessionsService } = await import('@/modules/providers/services/sessions.service.js');
const { OpenCodeSessionsProvider } = await import('./opencode-sessions.provider.js');
const { findOpenCodeDatabaseForSession, operatorOpenCodeDatabasePath } = await import('./opencode-home.js');

await initializeDatabase();
_resetProviderSecretsServerKeyCache();
setProviderSharingConfig({ ...getProviderSharingConfig(), opencode: 'isolated' });

const OPERATOR_SESSION = 'ses_operatorfixture0000000001';
const MEMBER_SESSION = 'ses_memberfixture00000000001';
const MEMBER_B_SESSION = 'ses_memberfixture00000000002';
const MEMBER_KEY = ['glm', 'member-own-vendor-key-0123456789'].join('-');
const MEMBER_AUTH_KEY = ['sk', 'or-member-auth-json-0123456789'].join('-');
const PLATFORM_KEY = ['glm', 'platform-owner-key-0123456789'].join('-');
const PROJECT = '/home/operator/Project/demo';

const platform = userDb.createUser('member-db-platform', 'hash', 'owner');
// Created before the member, so its (corrupt) DB is probed first.
const broken = userDb.createUser('member-db-broken', 'hash', 'user');
const member = userDb.createUser('member-db-member', 'hash', 'user');
const viewer = userDb.createUser('member-db-viewer', 'hash', 'user');
providerSecretsService.setKey(platform.id, 'glm', PLATFORM_KEY);
providerSecretsService.setKey(member.id, 'glm', MEMBER_KEY);

const memberDbPath = userConfigDir(member.id, path.join('.local', 'share', 'opencode', 'opencode.db'));
const operatorDbPath = operatorOpenCodeDatabasePath();
const brokenDbPath = userConfigDir(broken.id, path.join('.local', 'share', 'opencode', 'opencode.db'));

const SCHEMA = `
  CREATE TABLE session (
    id text PRIMARY KEY, project_id text NOT NULL, workspace_id text, parent_id text,
    slug text NOT NULL, directory text NOT NULL, path text, title text NOT NULL,
    version text NOT NULL, share_url text, summary_additions integer, summary_deletions integer,
    summary_files integer, summary_diffs text, metadata text, cost real DEFAULT 0 NOT NULL,
    tokens_input integer DEFAULT 0 NOT NULL, tokens_output integer DEFAULT 0 NOT NULL,
    tokens_reasoning integer DEFAULT 0 NOT NULL, tokens_cache_read integer DEFAULT 0 NOT NULL,
    tokens_cache_write integer DEFAULT 0 NOT NULL, revert text, permission text, agent text,
    model text, time_created integer NOT NULL, time_updated integer NOT NULL,
    time_compacting integer, time_archived integer
  );
  CREATE TABLE message (
    id text PRIMARY KEY, session_id text NOT NULL, time_created integer NOT NULL,
    time_updated integer NOT NULL, data text NOT NULL
  );
  CREATE TABLE part (
    id text PRIMARY KEY, message_id text NOT NULL, session_id text NOT NULL,
    time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL
  );
`;

function openFixtureDb(dbPath: string): Database.Database {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.exec(SCHEMA);
  return db;
}

/** One user turn and one assistant turn in the live row shape; `text` replaces personal content. */
function insertSession(db: Database.Database, sessionId: string, text: string, t0: number): void {
  db.prepare(`INSERT INTO session (id, project_id, slug, directory, path, title, version, permission,
    agent, model, time_created, time_updated) VALUES (?, 'prj', 'slug', ?, ?, 'placeholder title', '1.0.0',
    'ask', 'build', 'glm-5.2', ?, ?)`).run(sessionId, PROJECT, PROJECT, t0, t0 + 10);
  const message = db.prepare('INSERT INTO message VALUES (?, ?, ?, ?, ?)');
  const part = db.prepare('INSERT INTO part VALUES (?, ?, ?, ?, ?, ?)');
  const userId = `${sessionId}_mu`;
  const assistantId = `${sessionId}_ma`;
  message.run(userId, sessionId, t0, t0, JSON.stringify({
    role: 'user', time: { created: t0 }, agent: 'build',
    model: { providerID: 'zai', modelID: 'glm-5.2' }, summary: { diffs: [] },
  }));
  part.run(`${userId}_p1`, userId, sessionId, t0, t0, JSON.stringify({ type: 'text', text: `question ${text}` }));
  part.run(`${userId}_p2`, userId, sessionId, t0 + 1, t0 + 1, JSON.stringify({ type: 'compaction', auto: true, overflow: false }));
  message.run(assistantId, sessionId, t0 + 2, t0 + 2, JSON.stringify({
    parentID: userId, role: 'assistant', mode: 'build', agent: 'build', path: { cwd: PROJECT, root: PROJECT },
    cost: 0, tokens: { input: 10, output: 5, reasoning: 2, cache: { read: 0, write: 0 } },
    modelID: 'glm-5.2', providerID: 'zai', time: { created: t0 + 2, completed: t0 + 9 },
  }));
  part.run(`${assistantId}_p1`, assistantId, sessionId, t0 + 3, t0 + 3, JSON.stringify({ type: 'step-start', snapshot: 'abc' }));
  part.run(`${assistantId}_p2`, assistantId, sessionId, t0 + 4, t0 + 4, JSON.stringify({
    type: 'reasoning', text: `thinking ${text}`, time: { start: t0 + 4, end: t0 + 5 },
  }));
  part.run(`${assistantId}_p3`, assistantId, sessionId, t0 + 6, t0 + 6, JSON.stringify({ type: 'text', text: `answer ${text}` }));
  part.run(`${assistantId}_p4`, assistantId, sessionId, t0 + 8, t0 + 8, JSON.stringify({
    type: 'step-finish', reason: 'stop', snapshot: 'abd', cost: 0,
    tokens: { total: 17, input: 10, output: 5, reasoning: 2, cache: { write: 0, read: 0 } },
  }));
}

const operatorDb = openFixtureDb(operatorDbPath);
insertSession(operatorDb, OPERATOR_SESSION, `operator ${PLATFORM_KEY}`, 1_000);
operatorDb.close();
const memberDb = openFixtureDb(memberDbPath);
insertSession(memberDb, MEMBER_SESSION, `member ${MEMBER_KEY} ${MEMBER_AUTH_KEY}`, 2_000);
insertSession(memberDb, MEMBER_B_SESSION, 'member second', 3_000);
memberDb.close();
fs.writeFileSync(path.join(path.dirname(memberDbPath), 'auth.json'), JSON.stringify({ openrouter: { type: 'api', key: MEMBER_AUTH_KEY } }));
fs.mkdirSync(path.dirname(brokenDbPath), { recursive: true });
fs.writeFileSync(brokenDbPath, 'not a sqlite database');

after(() => {
  closeConnection();
  removeSandbox();
});

const provider = new OpenCodeSessionsProvider();
const textOf = (history: { messages: Array<{ kind: string; content?: string }> }, kind: string) =>
  history.messages.filter((message) => message.kind === kind).map((message) => message.content ?? '');

test('findOpenCodeDatabaseForSession returns the operator DB, the member DB, or null', () => {
  assert.equal(findOpenCodeDatabaseForSession(OPERATOR_SESSION), operatorDbPath);
  assert.equal(findOpenCodeDatabaseForSession(MEMBER_SESSION), memberDbPath, 'a corrupt earlier DB does not hide it');
  assert.equal(findOpenCodeDatabaseForSession(MEMBER_SESSION), memberDbPath, 'remembered location re-confirmed');
  assert.equal(findOpenCodeDatabaseForSession('ses_nowhere'), null);
});

test('a session in a member DB loads its user, assistant and thinking rows', async () => {
  const history = await provider.fetchHistory(MEMBER_SESSION);
  assert.equal(history.readFailed, undefined);
  assert.ok(history.total > 0, JSON.stringify(history));
  const text = textOf(history, 'text');
  assert.ok(text.some((value) => value.startsWith('question member')));
  assert.ok(text.some((value) => value.startsWith('answer member')));
  assert.ok(textOf(history, 'thinking').some((value) => value.startsWith('thinking member')));
});

test('the member DB owner key and the auth.json in that dir are redacted', async () => {
  const serialized = JSON.stringify((await provider.fetchHistory(MEMBER_SESSION)).messages);
  assert.ok(!serialized.includes(MEMBER_KEY));
  assert.ok(!serialized.includes(MEMBER_AUTH_KEY));
  assert.ok(serialized.includes('[REDACTED]'));
});

test('an operator-DB session still loads and redacts the platform owner key', async () => {
  const history = await provider.fetchHistory(OPERATOR_SESSION);
  assert.ok(textOf(history, 'text').some((value) => value.startsWith('answer operator')));
  assert.ok(!JSON.stringify(history.messages).includes(PLATFORM_KEY));
});

test('an unknown session is empty, not a failed read, while the operator DB exists', async () => {
  const history = await provider.fetchHistory('ses_nowhere');
  assert.deepEqual(history.messages, []);
  assert.equal(history.total, 0);
  assert.equal(history.readFailed, undefined);
});

test('a missing operator DB does not stop a member-DB session from loading', async () => {
  const parked = `${operatorDbPath}.parked`;
  fs.renameSync(operatorDbPath, parked);
  try {
    const history = await provider.fetchHistory(MEMBER_B_SESSION);
    assert.ok(textOf(history, 'text').some((value) => value === 'answer member second'));
    assert.equal((await provider.fetchHistory('ses_nowhere')).readFailed, true);
  } finally {
    fs.renameSync(parked, operatorDbPath);
  }
});

test('ADR-205 D3: peek and fetch agree on the member-DB revision for two viewers', async () => {
  sessionsDb.createSession(MEMBER_SESSION, 'opencode', PROJECT, undefined, undefined, undefined, null);
  participantsDb.recordSpawn(MEMBER_SESSION, member.id);
  participantsDb.recordSpawn(MEMBER_SESSION, viewer.id);
  resetHistorySnapshotCacheForTests();
  for (const userId of [member.id, viewer.id]) {
    const peek = await peekHistoryRevision(MEMBER_SESSION, userId);
    const fetched = await sessionsService.fetchHistory(MEMBER_SESSION, userId, { limit: null, snapshotCache: 'coalesce-only' });
    assert.ok(!peek.readFailed);
    assert.equal(peek.revision, fetched.revision, `viewer ${userId}`);
    assert.ok(fetched.total > 0);
  }
});

test('the revision follows the member DB, not the reader\'s own DB', async () => {
  const before = await peekHistoryRevision(MEMBER_SESSION, viewer.id);
  const viewerDb = openFixtureDb(userConfigDir(viewer.id, path.join('.local', 'share', 'opencode', 'opencode.db')));
  insertSession(viewerDb, 'ses_viewerfixture_unrelated', 'viewer', 4_000);
  viewerDb.close();
  const unchanged = await peekHistoryRevision(MEMBER_SESSION, viewer.id);
  assert.ok(!before.readFailed && !unchanged.readFailed);
  assert.equal(unchanged.revision, before.revision, 'the reader\'s unrelated DB is not fingerprinted');

  await new Promise((resolve) => setTimeout(resolve, 5));
  const db = new Database(memberDbPath);
  db.prepare('INSERT INTO part VALUES (?, ?, ?, ?, ?, ?)').run(
    'p_late', `${MEMBER_SESSION}_ma`, MEMBER_SESSION, 2_100, 2_100, JSON.stringify({ type: 'text', text: 'late part' }),
  );
  db.close();
  const changed = await peekHistoryRevision(MEMBER_SESSION, viewer.id);
  assert.ok(!changed.readFailed);
  assert.notEqual(changed.revision, before.revision, 'a write to the member DB changes the revision');
});
