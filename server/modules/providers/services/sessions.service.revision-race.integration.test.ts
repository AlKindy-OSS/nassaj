/**
 * B-1666 #2 — the real revision contract the client's light400 path relies on.
 *
 * Read through the real `sessionsService.fetchHistory` on an on-disk transcript:
 *  - a light read pinned to a revision the transcript has since outgrown is
 *    409 HISTORY_REVISION_CHANGED (never 200 with another revision);
 *  - the same read WITHOUT a revision succeeds and reports the new revision;
 *  - a read that overlaps a write is 409 HISTORY_REVISION_CHANGED even without
 *    a revision (torn read), so the client must treat it as transient.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, participantsDb, sessionsDb, userDb } from '@/modules/database/index.js';
import { providerRegistry } from '@/modules/providers/provider.registry.js';
import { sessionsService } from '@/modules/providers/services/sessions.service.js';
import { vendorProjectHash } from '@/modules/providers/shared/vendor/vendor-transcript.js';

const PROJECT_PATH = '/work/revision-race';
const SESSION_ID = 'revision-race-001';
const LIGHT_FLAG = 'NASSAJ_LIGHT_HISTORY_ENABLED';

const line = (role: 'user' | 'assistant', content: string) =>
  `${JSON.stringify({ type: 'message', message: { role, content } })}\n`;

type Context = { ownerId: number; transcript: string };

async function withTranscript(runTest: (context: Context) => Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const previousFlag = process.env[LIGHT_FLAG];
  const originalHome = os.homedir;
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'b1666-revision-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(tempRoot, 'auth.db');
  process.env[LIGHT_FLAG] = '1';
  await initializeDatabase();
  (os as unknown as { homedir: () => string }).homedir = () => tempRoot;
  try {
    const ownerId = userDb.createUser('owner', 'hash', 'user').id;
    const dir = path.join(tempRoot, '.nassaj-vendor-sessions', 'kimi', vendorProjectHash(PROJECT_PATH));
    await fs.mkdir(dir, { recursive: true });
    const transcript = path.join(dir, `${SESSION_ID}.jsonl`);
    await fs.writeFile(transcript,
      JSON.stringify({ type: 'meta', projectPath: PROJECT_PATH, sessionName: 'race' }) + '\n'
      + line('user', 'first question') + line('assistant', 'first answer'));
    sessionsDb.createSession(SESSION_ID, 'kimi', PROJECT_PATH);
    participantsDb.recordSpawn(SESSION_ID, ownerId);
    await runTest({ ownerId, transcript });
  } finally {
    (os as unknown as { homedir: () => string }).homedir = originalHome;
    closeConnection();
    if (previousDatabasePath === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previousDatabasePath;
    if (previousFlag === undefined) delete process.env[LIGHT_FLAG];
    else process.env[LIGHT_FLAG] = previousFlag;
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
}

const isRevisionChanged = (error: unknown) => {
  const { code, statusCode } = error as { code?: string; statusCode?: number };
  return code === 'HISTORY_REVISION_CHANGED' && statusCode === 409;
};

test('a light400 read pinned to an outgrown revision is 409; without it, 200 with the new one', async () => {
  await withTranscript(async ({ ownerId, transcript }) => {
    const first = await sessionsService.fetchHistory(SESSION_ID, ownerId,
      { limit: 20, offset: 0, payloadMode: 'light' });
    assert.ok(first.revision, 'a light read reports its revision');

    await new Promise((resolve) => setTimeout(resolve, 5));
    await fs.appendFile(transcript, line('user', 'second question'));

    await assert.rejects(
      sessionsService.fetchHistory(SESSION_ID, ownerId,
        { limit: 400, offset: 0, payloadMode: 'light', revision: first.revision }),
      isRevisionChanged,
    );
    const widened = await sessionsService.fetchHistory(SESSION_ID, ownerId,
      { limit: 400, offset: 0, payloadMode: 'light' });
    assert.notEqual(widened.revision, first.revision);
    assert.equal(widened.messages.at(-1)?.content, 'second question');
  });
});

test('a read that overlaps a write is 409 even without a revision (torn read)', async () => {
  await withTranscript(async ({ ownerId, transcript }) => {
    const history = providerRegistry.resolveHistorySessions('kimi');
    const original = history.fetchHistory;
    let writes = 0;
    // Grow the transcript during every provider read of it, as an active run does.
    history.fetchHistory = async (...args: Parameters<typeof original>) => {
      const result = await original.apply(history, args);
      writes += 1;
      await fs.appendFile(transcript, line('assistant', `chunk ${writes}`));
      return result;
    };
    try {
      await assert.rejects(
        sessionsService.fetchHistory(SESSION_ID, ownerId, { limit: 400, offset: 0, payloadMode: 'light' }),
        isRevisionChanged,
      );
    } finally {
      history.fetchHistory = original;
    }
    assert.equal(writes, 2, 'one read plus its single bounded retry, then fail closed');
  });
});
