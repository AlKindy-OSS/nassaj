/**
 * ADR-173 P4 (H2): identity rows of a shared writer.
 *
 * A member who writes into another member's conversation is recorded as
 * role 'participant', attribution 'shared_write' — the lowest privilege. The
 * row never demotes an owner (strict or inferred), never seizes ownership, never
 * carries spawn consent, and never widens which credential tree may fill the
 * recorded transcript path.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  closeConnection,
  getConnection,
  initializeDatabase,
  participantsDb,
  sessionsDb,
} from '@/modules/database/index.js';

const PROJECT_PATH = '/workspace/adr173-shared-writer';
const CREATOR = 1;
const WRITER = 2;
const SID = 'bbbbbbbb-0000-4000-8000-000000000173';

async function withSandbox(run: (home: string) => void): Promise<void> {
  const previousDb = process.env.DATABASE_PATH;
  const home = mkdtempSync(path.join(os.tmpdir(), 'adr173-p4-'));
  const originalHomedir = os.homedir;
  (os as { homedir: () => string }).homedir = () => home;
  closeConnection();
  process.env.DATABASE_PATH = path.join(home, 'auth.db');
  await initializeDatabase();
  const insertUser = getConnection().prepare('INSERT INTO users (id, username, password_hash) VALUES (?, ?, ?)');
  for (const id of [CREATOR, WRITER]) insertUser.run(id, `member-${id}`, 'x');
  try {
    run(home);
  } finally {
    (os as { homedir: () => string }).homedir = originalHomedir;
    closeConnection();
    if (previousDb === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previousDb;
    rmSync(home, { recursive: true, force: true });
  }
}

function readRow(sessionId: string, userId: number) {
  return getConnection().prepare(`SELECT role, attribution, message_count AS messageCount
    FROM session_participants WHERE session_id = ? AND user_id = ?`).get(sessionId, userId) as
    { role: string; attribution: string; messageCount: number } | undefined;
}

const context = { provider: 'claude', projectPath: PROJECT_PATH };

test('a shared writer is a shared_write participant and the strict owner keeps the session', async () => {
  await withSandbox(() => {
    sessionsDb.createSession(SID, 'claude', PROJECT_PATH);
    participantsDb.recordSpawn(SID, CREATOR, context);
    participantsDb.recordSpawn(SID, WRITER, { ...context, sharedWriter: true });
    participantsDb.recordSpawn(SID, WRITER, { ...context, sharedWriter: true });

    assert.deepEqual(readRow(SID, WRITER), { role: 'participant', attribution: 'shared_write', messageCount: 2 });
    assert.equal(readRow(SID, CREATOR)?.role, 'owner');
    assert.equal(participantsDb.resolveStrictSpawnOwnerUserId(SID), CREATOR);
    assert.equal(participantsDb.hasSpawnConsent(SID, WRITER), false, 'shared_write is not spawn consent');
    assert.equal(participantsDb.isParticipant(SID, WRITER), false, 'no consent-bearing participation');
    assert.equal(participantsDb.getSessionIdsForUser(WRITER).includes(SID), false);
  });
});

test('a shared writer never demotes an inferred owner nor seizes an ownerless session (H2)', async () => {
  await withSandbox(() => {
    sessionsDb.createSession(SID, 'claude', PROJECT_PATH);
    participantsDb.recordSpawn(SID, CREATOR, { ...context, attribution: 'provenance' });
    participantsDb.recordSpawn(SID, WRITER, { ...context, sharedWriter: true });
    assert.deepEqual(readRow(SID, CREATOR), { role: 'owner', attribution: 'provenance', messageCount: 1 });
    assert.equal(readRow(SID, WRITER)?.role, 'participant');

    const ownerless = `${SID.slice(0, -1)}9`;
    sessionsDb.createSession(ownerless, 'claude', PROJECT_PATH);
    participantsDb.recordSpawn(ownerless, WRITER, { ...context, sharedWriter: true });
    assert.deepEqual(readRow(ownerless, WRITER), { role: 'participant', attribution: 'shared_write', messageCount: 1 });
    assert.equal(participantsDb.resolveStrictSpawnOwnerUserId(ownerless), null);
  });
});

test('adopting a runtime stub id keeps attribution instead of resetting it to spawn', async () => {
  await withSandbox(() => {
    const stub = 'agy_stub_shared_writer';
    sessionsDb.createSession(stub, 'antigravity', PROJECT_PATH);
    sessionsDb.createSession(SID, 'antigravity', PROJECT_PATH);
    participantsDb.recordSpawn(stub, CREATOR, { ...context, provider: 'antigravity' });
    participantsDb.recordSpawn(stub, WRITER, { ...context, provider: 'antigravity', sharedWriter: true });
    assert.equal(sessionsDb.adoptRuntimeSessionId(stub, SID), true);
    assert.equal(readRow(SID, WRITER)?.attribution, 'shared_write');
    assert.equal(readRow(SID, CREATOR)?.attribution, 'spawn');
  });
});

test('a shared writer tree never fills a NULL recorded transcript path', async () => {
  await withSandbox((home) => {
    sessionsDb.insertDiscoveredSession({ sessionId: SID, provider: 'claude', projectPath: PROJECT_PATH });
    participantsDb.recordSpawn(SID, CREATOR, context);
    participantsDb.recordSpawn(SID, WRITER, { ...context, sharedWriter: true });
    const dir = path.join(home, '.nassaj-users', String(WRITER), '.claude', 'projects', '-workspace');
    mkdirSync(dir, { recursive: true });
    const writerFile = path.join(dir, `${SID}.jsonl`);
    writeFileSync(writerFile, '{}\n');
    const warn = console.warn;
    console.warn = () => undefined;
    try {
      assert.equal(sessionsDb.refreshDiscoveredSession({
        sessionId: SID, provider: 'claude', projectPath: PROJECT_PATH, jsonlPath: writerFile,
      }), 'refused');
    } finally {
      console.warn = warn;
    }
    assert.equal(sessionsDb.getSessionById(SID)?.jsonl_path ?? null, null);
  });
});

test('CRIT-1: a later spawn write never upgrades shared_write to spawn nor demotes the inferred owner', async () => {
  await withSandbox(() => {
    sessionsDb.createSession(SID, 'claude', PROJECT_PATH);
    participantsDb.recordSpawn(SID, CREATOR, { ...context, attribution: 'provenance' });
    participantsDb.recordSpawn(SID, WRITER, { ...context, sharedWriter: true });
    participantsDb.recordSpawn(SID, WRITER, context);
    assert.deepEqual(readRow(SID, WRITER), { role: 'participant', attribution: 'shared_write', messageCount: 2 });
    assert.deepEqual(readRow(SID, CREATOR), { role: 'owner', attribution: 'provenance', messageCount: 1 });
    assert.equal(participantsDb.hasSpawnConsent(SID, WRITER), false);
  });
});
