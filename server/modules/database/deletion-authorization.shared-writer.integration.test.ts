/**
 * ADR-173 review (Low): a shared writer's message_authors rows never grant him
 * deletion authority over the conversation he wrote in. The ADR-104 author arm still
 * admits an author who is not a shared writer.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, getConnection, initializeDatabase, participantsDb, sessionsDb } from '@/modules/database/index.js';

import { readDeletionParticipants } from './deletion-authorization.js';

const CREATOR = 1;
const WRITER = 2;
const AUTHOR = 3;
const SID = 'cccccccc-0000-4000-8000-000000000173';
const context = { provider: 'claude', projectPath: '/workspace/adr173-delete' };

async function withSandbox(run: () => void): Promise<void> {
  const previousDb = process.env.DATABASE_PATH;
  const home = mkdtempSync(path.join('/var/tmp', 'adr173-delete-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(home, 'auth.db');
  await initializeDatabase();
  const insertUser = getConnection().prepare('INSERT INTO users (id, username, password_hash) VALUES (?, ?, ?)');
  for (const id of [CREATOR, WRITER, AUTHOR]) insertUser.run(id, `member-${id}`, 'x');
  try {
    run();
  } finally {
    closeConnection();
    if (previousDb === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previousDb;
    rmSync(home, { recursive: true, force: true });
  }
}

const authored = (userId: number) => getConnection().prepare(`INSERT INTO message_authors
  (session_id, user_id, content_hash, created_at) VALUES (?, ?, 'h', CURRENT_TIMESTAMP)`).run(SID, userId);

const participants = (actorId: number) => {
  const db = getConnection();
  return db.transaction(() => readDeletionParticipants(db, [SID], actorId)).immediate();
};

test('a shared writer\'s authored turns grant no deletion authority; other authors keep the ADR-104 arm', async () => {
  await withSandbox(() => {
    sessionsDb.createSession(SID, 'claude', context.projectPath);
    participantsDb.recordSpawn(SID, CREATOR, context);
    participantsDb.recordSpawn(SID, WRITER, { ...context, sharedWriter: true });
    authored(WRITER);
    authored(AUTHOR);
    assert.equal(participants(CREATOR).has(SID), true, 'spawn consent');
    assert.equal(participants(WRITER).has(SID), false, 'shared writer excluded');
    assert.equal(participants(AUTHOR).has(SID), true, 'ADR-104 author arm unchanged');
  });
});
