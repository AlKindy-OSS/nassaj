/**
 * sessions.adopt-runtime-id.test.ts — a run's spawn key must hand its records to
 * the conversation id the provider files the transcript under.
 *
 * The failure this locks (reported live 2026-07-27 for agy_1785164728257_44c0wsid,
 * "it replies once then disappears"): the antigravity adapter mints a runtime
 * spawn key `agy_<ts>_<rand>`, participants.recordSpawn creates a STUB sessions
 * row for it to satisfy its FK, and the synchronizer then files the SAME
 * conversation under the agy brain UUID. Nothing reconciled the two, so the chat
 * the user typed in kept an id whose row has no jsonl_path — and fetchHistory
 * resolves history from jsonl_path, so it returned 0 messages while the real
 * 29-message conversation sat in a second row beside it. Measured on the live DB:
 * 7 such orphan rows.
 *
 * What is locked: the move carries the run's records (message authorship and
 * participants), and the guard rails — a row WITH a transcript is never treated
 * as a stub, and a missing destination aborts the move rather than cascading the
 * records away.
 */

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, getConnection } from '@/modules/database/connection.js';
import { initializeDatabase } from '@/modules/database/init-db.js';
import { sessionsDb } from '@/modules/database/repositories/sessions.db.js';
import { userDb } from '@/modules/database/repositories/users.js';

/** Same isolated-db harness the other repository tests use. */
async function withIsolatedDatabase(runTest: () => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'adopt-runtime-id-db-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'db.sqlite');
  await initializeDatabase();
  try {
    await runTest();
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previousDatabasePath;
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

const PROJECT = '/tmp/adopt-runtime-id-project';
const STUB = 'agy_1785164728257_44c0wsid';
const REAL = 'fa05e04c-dfbd-4b1d-98c1-bbc638282d4d';
const TRANSCRIPT = '/tmp/brain/fa05e04c/.system_generated/logs/transcript.jsonl';

function userId(): number {
  return userDb.createUser('adopt-test', 'hash', 'user').id;
}

function seedStubWithRecords(uid: number) {
  const db = getConnection();
  sessionsDb.createSession(STUB, 'antigravity', PROJECT);          // stub: no jsonl_path
  db.prepare(
    "INSERT OR IGNORE INTO session_participants (session_id, user_id, role) VALUES (?, ?, 'owner')"
  ).run(STUB, uid);
  db.prepare(
    "INSERT INTO message_authors (session_id, user_id, content_hash, created_at) VALUES (?, ?, 'hash-1', '2026-07-27T15:05:00Z')"
  ).run(STUB, uid);
}

test('the stub is removed and its records follow the conversation id', async () => withIsolatedDatabase(() => {
  const db = getConnection();
  const uid = userId();
  seedStubWithRecords(uid);
  sessionsDb.createSession(REAL, 'antigravity', PROJECT, undefined, undefined, undefined, TRANSCRIPT);

  assert.equal(sessionsDb.adoptRuntimeSessionId(STUB, REAL), true);

  assert.ok(!sessionsDb.getSessionById(STUB), 'the empty stub must not linger as a chat');
  assert.equal(sessionsDb.getSessionById(REAL)?.jsonl_path, TRANSCRIPT, 'history still resolves');

  const authors = db
    .prepare('SELECT COUNT(*) c FROM message_authors WHERE session_id = ?')
    .get(REAL) as { c: number };
  assert.equal(authors.c, 1, 'authorship must move, not vanish with the stub');
  const participants = db
    .prepare('SELECT role FROM session_participants WHERE session_id = ? AND user_id = ?')
    .get(REAL, uid) as { role: string } | undefined;
  assert.equal(participants?.role, 'owner', 'the owner must stay the owner on the surviving row');
}));

test('a row that owns a transcript is never treated as a stub', async () => withIsolatedDatabase(() => {
  const uid = userId();
  seedStubWithRecords(uid);
  // Give the "stub" a transcript: it is a real conversation now.
  sessionsDb.createSession(STUB, 'antigravity', PROJECT, undefined, undefined, undefined, TRANSCRIPT);
  sessionsDb.createSession(REAL, 'antigravity', PROJECT, undefined, undefined, undefined, TRANSCRIPT);

  assert.equal(sessionsDb.adoptRuntimeSessionId(STUB, REAL), false);
  assert.ok(sessionsDb.getSessionById(STUB), 'a conversation with history must never be deleted');
}));

test('a missing destination aborts the move instead of cascading the records away', async () => withIsolatedDatabase(() => {
  const db = getConnection();
  const uid = userId();
  seedStubWithRecords(uid);

  assert.equal(sessionsDb.adoptRuntimeSessionId(STUB, REAL), false);
  assert.ok(sessionsDb.getSessionById(STUB), 'nothing is deleted without somewhere to move to');
  const authors = db
    .prepare('SELECT COUNT(*) c FROM message_authors WHERE session_id = ?')
    .get(STUB) as { c: number };
  assert.equal(authors.c, 1, 'authorship stays put');
}));

test('adopting is a no-op when the ids are the same or empty', async () => withIsolatedDatabase(() => {
  assert.equal(sessionsDb.adoptRuntimeSessionId(STUB, STUB), false);
  assert.equal(sessionsDb.adoptRuntimeSessionId('', REAL), false);
}));
