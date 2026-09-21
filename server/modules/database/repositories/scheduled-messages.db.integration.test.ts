import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, getConnection } from '@/modules/database/connection.js';
import { initializeDatabase } from '@/modules/database/init-db.js';
import { participantsDb } from '@/modules/database/repositories/participants.db.js';
import { projectsDb } from '@/modules/database/repositories/projects.db.js';
import { scheduledMessagesDb } from '@/modules/database/repositories/scheduled-messages.db.js';
import { sessionsDb } from '@/modules/database/repositories/sessions.db.js';
import { userDb } from '@/modules/database/repositories/users.js';

async function withIsolatedDatabase(runTest: () => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'scheduled-messages-db-'));
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

function createScheduled(userId: number, sessionId: string, status: 'pending' | 'running' | 'failed', scheduledFor: string): string {
  const created = scheduledMessagesDb.create({ userId, sessionId, content: `content-${sessionId}`, options: {}, scheduledFor });
  if (status !== 'pending') {
    getConnection().prepare('UPDATE scheduled_messages SET status = ?, updated_at = ? WHERE id = ?')
      .run(status, scheduledFor, created.id);
  }
  return created.id;
}

test('global pages and metadata counts fail closed after participant access is revoked', async () => {
  await withIsolatedDatabase(() => {
    const owner = userDb.createUser('schedule_owner', 'hash', 'user').id;
    const participant = userDb.createUser('schedule_participant', 'hash', 'user').id;
    const projectPath = '/workspace/schedule-revocation';
    projectsDb.createProjectPath(projectPath, 'Schedule revocation', owner);
    sessionsDb.createSession('participant-session', 'claude', projectPath);
    participantsDb.recordSpawn('participant-session', participant);
    createScheduled(participant, 'participant-session', 'failed', '2026-09-04T09:00:00.000Z');

    assert.equal(scheduledMessagesDb.listAccessibleOwned(participant, { limit: 200, offset: 0 }).total, 1);
    assert.deepEqual(scheduledMessagesDb.countAccessibleActionable(participant), { pending: 0, running: 0, failed: 1 });

    getConnection().prepare('DELETE FROM session_participants WHERE session_id = ? AND user_id = ?')
      .run('participant-session', participant);
    assert.deepEqual(scheduledMessagesDb.listAccessibleOwned(participant, { limit: 200, offset: 0 }), { messages: [], total: 0 });
    assert.deepEqual(scheduledMessagesDb.countAccessibleActionable(participant), { pending: 0, running: 0, failed: 0 });
  });
});

test('accessible listing orders active nearest, failed newest, and reports a complete total beyond the page', async () => {
  await withIsolatedDatabase(() => {
    const owner = userDb.createUser('schedule_paging_owner', 'hash', 'user').id;
    const projectPath = '/workspace/schedule-paging';
    projectsDb.createProjectPath(projectPath, 'Schedule paging', owner);
    sessionsDb.createSession('paging-session', 'claude', projectPath);

    const pendingFar = createScheduled(owner, 'paging-session', 'pending', '2026-09-06T09:00:00.000Z');
    const pendingNear = createScheduled(owner, 'paging-session', 'pending', '2026-09-04T09:00:00.000Z');
    const failedOld = createScheduled(owner, 'paging-session', 'failed', '2026-09-04T10:00:00.000Z');
    const failedNew = createScheduled(owner, 'paging-session', 'failed', '2026-09-05T10:00:00.000Z');

    const pending = scheduledMessagesDb.listAccessibleOwned(owner, { status: 'pending', limit: 1, offset: 0 });
    assert.equal(pending.total, 2);
    assert.deepEqual(pending.messages.map((message) => message.id), [pendingNear]);
    assert.deepEqual(scheduledMessagesDb.listAccessibleOwned(owner, { status: 'pending', limit: 1, offset: 1 }).messages.map((message) => message.id), [pendingFar]);

    const failed = scheduledMessagesDb.listAccessibleOwned(owner, { status: 'failed', limit: 2, offset: 0 });
    assert.deepEqual(failed.messages.map((message) => message.id), [failedNew, failedOld]);
  });
});
