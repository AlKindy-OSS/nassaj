import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test, { after, before, beforeEach } from 'node:test';

import { closeConnection, getConnection, initializeDatabase, scheduledMessagesDb } from '@/modules/database/index.js';

import { createScheduledMessagesService } from './scheduled-messages.service.js';

// T-1912: node-wide "due soon" reading that softly holds an update restart.
const ACTIVE_USER = 4101;
const INACTIVE_USER = 4102;
const OPEN_SESSION = 'due-soon-open-session';
const OWNED_PROJECT_SESSION = 'due-soon-owned-project-session';
const REVOKED_SESSION = 'due-soon-revoked-session';
const NOW = '2026-09-28T12:00:00.000Z';
const NOW_MS = Date.parse(NOW);
const WINDOW_MS = 10 * 60_000;
const at = (offsetMs: number) => new Date(NOW_MS + offsetMs).toISOString();
const until = at(WINDOW_MS);

let previousDatabasePath: string | undefined;
let testDirectory: string;

before(async () => {
  previousDatabasePath = process.env.DATABASE_PATH;
  testDirectory = await mkdtemp('/var/tmp/nassaj-scheduled-due-soon-test-');
  process.env.DATABASE_PATH = path.join(testDirectory, 'auth.db');
  await writeFile(process.env.DATABASE_PATH, '');
  closeConnection();
  await initializeDatabase();
  const db = getConnection();
  db.prepare("INSERT INTO users (id, username, password_hash) VALUES (?, 'due-soon-active', 'x')").run(ACTIVE_USER);
  db.prepare("INSERT INTO users (id, username, password_hash, is_active) VALUES (?, 'due-soon-inactive', 'x', 0)")
    .run(INACTIVE_USER);
  db.prepare("INSERT INTO projects (project_id, project_path, created_by) VALUES ('p-owned', '/w/owned', ?)")
    .run(ACTIVE_USER);
  db.prepare("INSERT INTO projects (project_id, project_path, created_by) VALUES ('p-foreign', '/w/foreign', NULL)").run();
  const session = db.prepare("INSERT INTO sessions (session_id, provider, isArchived, project_path) VALUES (?, 'codex', 0, ?)");
  session.run(OPEN_SESSION, null);
  session.run(OWNED_PROJECT_SESSION, '/w/owned');
  session.run(REVOKED_SESSION, '/w/foreign');
});

after(async () => {
  closeConnection();
  if (previousDatabasePath === undefined) delete process.env.DATABASE_PATH;
  else process.env.DATABASE_PATH = previousDatabasePath;
  await rm(testDirectory, { recursive: true, force: true });
});

beforeEach(() => { getConnection().prepare('DELETE FROM scheduled_messages').run(); });

function insert(overrides: {
  availableAt: string; status?: string; attempts?: number; maxAttempts?: number; userId?: number;
  sessionId?: string; leaseExpiresAt?: string | null;
}) {
  getConnection().prepare(`INSERT INTO scheduled_messages
    (id, user_id, session_id, content, options_json, scheduled_for, available_at, status, attempts,
     max_attempts, lease_token, lease_expires_at)
    VALUES (?, ?, ?, 'secret body', '{}', ?, ?, ?, ?, ?, ?, ?)`)
    .run(randomUUID(), overrides.userId ?? ACTIVE_USER, overrides.sessionId ?? OPEN_SESSION,
      overrides.availableAt, overrides.availableAt, overrides.status ?? 'pending', overrides.attempts ?? 0,
      overrides.maxAttempts ?? 3, overrides.leaseExpiresAt ? 'lease' : null, overrides.leaseExpiresAt ?? null);
}

test('window boundaries: 9:59 and 10:00 are due soon, 10:01 is not', () => {
  insert({ availableAt: at(10 * 60_000 + 1_000) });
  assert.deepEqual(scheduledMessagesDb.nextDueWithin(NOW, until), { count: 0, earliestAt: null });
  insert({ availableAt: at(10 * 60_000) });
  assert.deepEqual(scheduledMessagesDb.nextDueWithin(NOW, until), { count: 1, earliestAt: at(10 * 60_000) });
  insert({ availableAt: at(9 * 60_000 + 59_000) });
  assert.deepEqual(scheduledMessagesDb.nextDueWithin(NOW, until), { count: 2, earliestAt: at(9 * 60_000 + 59_000) });
});

test('overdue pending rows and in-flight running rows count', () => {
  insert({ availableAt: at(-60_000) });
  insert({ availableAt: at(-120_000), status: 'running', attempts: 3, leaseExpiresAt: at(60_000) });
  assert.deepEqual(scheduledMessagesDb.nextDueWithin(NOW, until), { count: 2, earliestAt: at(-120_000) });
});

test('a session writable through project ownership counts', () => {
  insert({ availableAt: at(60_000), sessionId: OWNED_PROJECT_SESSION });
  assert.equal(scheduledMessagesDb.nextDueWithin(NOW, until).count, 1);
});

test('ineligible rows never hold an update', () => {
  const soon = at(60_000);
  for (const status of ['cancelled', 'sent', 'failed']) insert({ availableAt: soon, status });
  insert({ availableAt: soon, attempts: 3, maxAttempts: 3 }); // exhausted pending
  insert({ availableAt: soon, status: 'running', attempts: 3, leaseExpiresAt: at(-1_000) }); // dead final lease
  insert({ availableAt: soon, sessionId: REVOKED_SESSION }); // owner lost write access
  insert({ availableAt: soon, userId: INACTIVE_USER });
  assert.deepEqual(scheduledMessagesDb.nextDueWithin(NOW, until), { count: 0, earliestAt: null });
});

test('service upcomingDue uses its clock, returns metadata only, and window 0 disables', () => {
  insert({ availableAt: at(5 * 60_000) });
  const service = createScheduledMessagesService({
    repository: scheduledMessagesDb,
    getActiveUser: () => undefined,
    sessionExists: () => true,
    canWriteSession: () => true,
    dispatch: async () => ({ success: true, retryable: false }),
    audit: () => undefined,
    now: () => NOW_MS,
  });
  const reading = service.upcomingDue(WINDOW_MS);
  assert.deepEqual(Object.keys(reading).sort(), ['count', 'earliestAt']);
  assert.deepEqual(reading, { count: 1, earliestAt: at(5 * 60_000) });
  assert.ok(!JSON.stringify(reading).includes('secret body'));
  assert.deepEqual(service.upcomingDue(0), { count: 0, earliestAt: null });
  assert.deepEqual(service.upcomingDue(4 * 60_000), { count: 0, earliestAt: null });
});

/** SQL text prepared while `run` executes, in order. */
function preparedSql(run: () => void): string[] {
  const db = getConnection() as unknown as { prepare: (sql: string) => unknown };
  const original = db.prepare.bind(db);
  const seen: string[] = [];
  db.prepare = (sql: string) => { seen.push(sql); return original(sql); };
  try { run(); } finally { delete (db as { prepare?: unknown }).prepare; }
  return seen;
}

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

// Digests of the SQL these accessors prepared before T-1912 (main d9a9714fe):
// the placeholder refactor of the writable-session fragment must not change a byte.
const PRE_T1912_SQL_DIGESTS = {
  listAccessibleOwned: [
    'f4ba7b9b999f90d3c9daa7ade8b24fa3dc76f42a9f4a70739ef23e3de6b9cd08',
    '1f124a709fc38fe49b47759409444af789fce22de5c1c92236d3a4b7591e6b15',
    '77fc067d3c44a7fbb4c360ed719cae590b8d11b56eaa8a671d1fd98c8d5fc5bd',
    '7dc0506409a0d87e048f01dcb39df25e55b1f8deffa2e28ef8b45978b6e3948d',
  ],
  countAccessibleActionable: ['acadb2768761c05ef9dbad2585b00d1d53a9e76ffb05f42fc6f56478c0e0b737'],
  countOpenForUser: ['1a278e952ed8a85b08366c94bf584bbf0343114b63b29babec5e3e9312fe403b'],
  claimDue: ['9d7190cbe77bd4d8f60decd09dc48220f81d5307c1bbbd74147a62d7f5dc4ab3'],
};

test('per-user accessors prepare byte-identical SQL to before T-1912', () => {
  const actual = {
    listAccessibleOwned: preparedSql(() => {
      scheduledMessagesDb.listAccessibleOwned(ACTIVE_USER, { limit: 10, offset: 0 });
      scheduledMessagesDb.listAccessibleOwned(ACTIVE_USER, {
        sessionId: OPEN_SESSION, status: 'pending', limit: 10, offset: 0,
      });
    }).map(sha256),
    countAccessibleActionable: preparedSql(() => { scheduledMessagesDb.countAccessibleActionable(ACTIVE_USER); })
      .map(sha256),
    countOpenForUser: preparedSql(() => { scheduledMessagesDb.countOpenForUser(ACTIVE_USER); }).map(sha256),
    claimDue: preparedSql(() => { scheduledMessagesDb.claimDue(NOW, 60_000); }).map(sha256),
  };
  assert.deepEqual(actual, PRE_T1912_SQL_DIGESTS);
});

test('the node-wide reading fills every user slot with the row owner column', () => {
  const [sql] = preparedSql(() => { scheduledMessagesDb.nextDueWithin(NOW, until); });
  assert.ok(!sql.includes('{{'), 'an unfilled user slot reached SQLite');
  assert.equal(sql.match(/\?/g)?.length, 2, 'only the two time bounds are bound');
  // Five writable-session slots plus the active-owner check (u.id = ...).
  assert.equal(sql.match(/= scheduled_messages\.user_id\b/g)?.length, 6);
});
