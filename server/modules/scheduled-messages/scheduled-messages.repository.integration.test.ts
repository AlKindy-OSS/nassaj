import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test, { after, before } from 'node:test';

import { closeConnection, getConnection, initializeDatabase, scheduledMessagesDb } from '@/modules/database/index.js';

const USER_ID = 1919;
const SESSION_ID = 'scheduled-repository-session';
let previousDatabasePath: string | undefined;
let testDirectory: string;

before(async () => {
  previousDatabasePath = process.env.DATABASE_PATH;
  testDirectory = await mkdtemp('/var/tmp/nassaj-scheduled-messages-test-');
  process.env.DATABASE_PATH = path.join(testDirectory, 'auth.db');
  await writeFile(process.env.DATABASE_PATH, '');
  closeConnection();
  await initializeDatabase();
  const db = getConnection();
  db.prepare("INSERT OR IGNORE INTO users (id, username, password_hash) VALUES (?, 'scheduled-test-user', 'x')").run(USER_ID);
  db.prepare("INSERT OR IGNORE INTO sessions (session_id, provider, isArchived) VALUES (?, 'codex', 0)").run(SESSION_ID);
});

after(async () => {
  closeConnection();
  if (previousDatabasePath === undefined) delete process.env.DATABASE_PATH;
  else process.env.DATABASE_PATH = previousDatabasePath;
  await rm(testDirectory, { recursive: true, force: true });
});

function insertDue(overrides: { id?: string; status?: string; attempts?: number; leaseToken?: string | null; leaseExpiresAt?: string | null } = {}) {
  const id = overrides.id ?? randomUUID();
  getConnection().prepare(`INSERT INTO scheduled_messages
    (id, user_id, session_id, content, options_json, scheduled_for, available_at, status, attempts,
     lease_token, lease_expires_at)
    VALUES (?, ?, ?, 'due', '{}', ?, ?, ?, ?, ?, ?)`)
    .run(id, USER_ID, SESSION_ID, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', overrides.status ?? 'pending',
      overrides.attempts ?? 0, overrides.leaseToken ?? null, overrides.leaseExpiresAt ?? null);
  return id;
}

test('CAS claim grants a due message to only one worker before lease expiry', () => {
  getConnection().prepare('DELETE FROM scheduled_messages').run();
  const id = insertDue();
  const now = '2026-09-03T09:00:00.000Z';

  const workerA = scheduledMessagesDb.claimDue(now, 60_000);
  const workerB = scheduledMessagesDb.claimDue(now, 60_000);

  assert.equal(workerA?.id, id);
  assert.ok(workerA?.leaseToken);
  assert.equal(workerA?.attempts, 1);
  assert.equal(workerB, null, 'a live lease was claimed by a second worker');
});

test('restart recovery reclaims only an expired lease and rejects stale settlement', () => {
  getConnection().prepare('DELETE FROM scheduled_messages').run();
  const id = insertDue({
    status: 'running', attempts: 1, leaseToken: 'lease-before-crash',
    leaseExpiresAt: '2026-09-03T08:59:59.000Z',
  });

  const recovered = scheduledMessagesDb.claimDue('2026-09-03T09:00:00.000Z', 60_000);
  assert.equal(recovered?.id, id);
  assert.equal(recovered?.attempts, 2);
  assert.notEqual(recovered?.leaseToken, 'lease-before-crash');
  assert.equal(scheduledMessagesDb.settle(id, 'lease-before-crash', { success: true, retryable: false }), false);
  assert.equal(scheduledMessagesDb.settle(id, recovered!.leaseToken!, { success: true, retryable: false }), true);
  assert.equal(scheduledMessagesDb.getOwned(id, USER_ID)?.status, 'sent');
});

test('restart recovery terminalizes an expired final attempt instead of leaving it running forever', () => {
  getConnection().prepare('DELETE FROM scheduled_messages').run();
  const id = insertDue({
    status: 'running', attempts: 3, leaseToken: 'final-attempt-before-crash',
    leaseExpiresAt: '2026-09-03T08:59:59.000Z',
  });

  const failed = scheduledMessagesDb.failExpiredExhausted('2026-09-03T09:00:00.000Z');

  assert.deepEqual(failed.map((message) => message.id), [id]);
  const stored = scheduledMessagesDb.getOwned(id, USER_ID);
  assert.equal(stored?.status, 'failed');
  assert.equal(stored?.lastErrorCode, 'lease_expired');
  assert.equal(stored?.leaseToken, null);
  assert.equal(scheduledMessagesDb.claimDue('2036-09-03T09:00:00.000Z', 60_000), null);
});

test('retryable settlement is not reclaimable before its persisted backoff expires', () => {
  getConnection().prepare('DELETE FROM scheduled_messages').run();
  const id = insertDue();
  const claimed = scheduledMessagesDb.claimDue('2026-09-03T09:00:00.000Z', 60_000);
  assert.equal(claimed?.id, id);
  assert.equal(scheduledMessagesDb.settle(id, claimed!.leaseToken!, {
    success: false,
    retryable: true,
    errorCode: 'provider_busy',
    retryAt: '2026-09-03T09:00:30.000Z',
  }), true);

  assert.equal(scheduledMessagesDb.claimDue('2026-09-03T09:00:29.999Z', 60_000), null);
  const retried = scheduledMessagesDb.claimDue('2026-09-03T09:00:30.000Z', 60_000);
  assert.equal(retried?.id, id);
  assert.equal(retried?.attempts, 2);
});

test('terminal failure leaves no path for a later worker to reclaim the row', () => {
  getConnection().prepare('DELETE FROM scheduled_messages').run();
  const id = insertDue();
  const claimed = scheduledMessagesDb.claimDue('2026-09-03T09:00:00.000Z', 60_000);
  assert.equal(claimed?.id, id);
  assert.equal(scheduledMessagesDb.settle(id, claimed!.leaseToken!, {
    success: false, retryable: false, errorCode: 'actor_revoked',
  }), true);

  assert.equal(scheduledMessagesDb.getOwned(id, USER_ID)?.status, 'failed');
  assert.equal(scheduledMessagesDb.claimDue('2036-09-03T09:00:00.000Z', 60_000), null);
});

test('cancel and update lose safely once a concurrent worker has claimed the row', () => {
  getConnection().prepare('DELETE FROM scheduled_messages').run();
  const id = insertDue();
  const claimed = scheduledMessagesDb.claimDue('2026-09-03T09:00:00.000Z', 60_000);
  assert.equal(claimed?.id, id);

  assert.equal(scheduledMessagesDb.cancelOwned(id, USER_ID), 'conflict');
  assert.equal(scheduledMessagesDb.updateOwned(id, USER_ID, {
    content: 'changed after claim', options: {}, scheduledFor: '2026-09-04T09:00:00.000Z',
  }), null);
  assert.equal(scheduledMessagesDb.getOwned(id, USER_ID)?.content, 'due');
  assert.equal(scheduledMessagesDb.settle(id, claimed!.leaseToken!, { success: true, retryable: false }), true);
});

test('repository ownership predicates prevent cross-user read, update, and cancel', () => {
  getConnection().prepare('DELETE FROM scheduled_messages').run();
  const id = insertDue();
  const otherUser = USER_ID + 1;

  assert.equal(scheduledMessagesDb.getOwned(id, otherUser), null);
  assert.deepEqual(scheduledMessagesDb.listOwned(otherUser), []);
  assert.equal(scheduledMessagesDb.updateOwned(id, otherUser, {
    content: 'cross-user overwrite', options: {}, scheduledFor: '2026-09-04T09:00:00.000Z',
  }), null);
  assert.equal(scheduledMessagesDb.cancelOwned(id, otherUser), 'not_found');
  assert.equal(scheduledMessagesDb.getOwned(id, USER_ID)?.content, 'due');
});
