/**
 * ADR-210 (T-2036): history served to a viewer is masked and its revision
 * folds in the mask version; the raw read (share snapshots, internal callers)
 * is unchanged. A real kimi vendor transcript is read through the live path.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, participantsDb, sessionsDb, userDb } from '@/modules/database/index.js';
import { sessionsService } from '@/modules/providers/services/sessions.service.js';
import { vendorProjectHash } from '@/modules/providers/shared/vendor/vendor-transcript.js';
// eslint-disable-next-line boundaries/no-unknown -- ADR-210 test seam of the display masking leaf service.
import { configureDisplayMaskForTests, displayHistoryRevision } from '@/services/display-secret-mask.js';

const PROJECT_PATH = '/work/mask-proj';
const SESSION_ID = 'display-mask-history-001';
const SK = 'sk-' + 'ant-api03-AbCdEfGhIjKlMnOpQrStUvWx';

async function withSession(runTest: (ownerId: number) => Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const originalHome = os.homedir;
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 't2036-history-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(tempRoot, 'auth.db');
  await initializeDatabase();
  (os as unknown as { homedir: () => string }).homedir = () => tempRoot;
  try {
    const ownerId = userDb.createUser('alice', 'hash-a', 'user').id;
    const dir = path.join(tempRoot, '.nassaj-vendor-sessions', 'kimi', vendorProjectHash(PROJECT_PATH));
    await fs.mkdir(dir, { recursive: true });
    const lines = [
      JSON.stringify({ type: 'meta', projectPath: PROJECT_PATH, sessionName: 'mask' }),
      JSON.stringify({ type: 'message', message: { role: 'user', content: `use OPENAI_API_KEY=${SK} please` } }),
      JSON.stringify({ type: 'message', message: { role: 'assistant', content: 'commit 3636a7419ff81202f2b224e8e953781cdf8c7ace' } }),
    ];
    await fs.writeFile(path.join(dir, `${SESSION_ID}.jsonl`), `${lines.join('\n')}\n`);
    sessionsDb.createSession(SESSION_ID, 'kimi', PROJECT_PATH);
    participantsDb.recordSpawn(SESSION_ID, ownerId);
    configureDisplayMaskForTests({ env: () => undefined, serviceLiterals: () => [], allUserIds: () => [] });
    await runTest(ownerId);
  } finally {
    configureDisplayMaskForTests(null);
    (os as unknown as { homedir: () => string }).homedir = originalHome;
    closeConnection();
    if (previousDatabasePath === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previousDatabasePath;
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
}

test('viewer history is masked, raw history is not, and the revision carries the mask version', async () => {
  await withSession(async (ownerId) => {
    const raw = await sessionsService.fetchHistory(SESSION_ID, ownerId, { limit: 10, offset: 0 });
    const masked = await sessionsService.fetchHistory(SESSION_ID, ownerId, { limit: 10, offset: 0, displayMask: true });
    assert.equal(raw.messages[0]?.content, `use OPENAI_API_KEY=${SK} please`, 'raw read unchanged (share, internal)');
    assert.equal(masked.messages[0]?.content, 'use OPENAI_API_KEY=[masked:assignment] please');
    assert.equal(masked.messages[1]?.content, raw.messages[1]?.content, 'a commit SHA survives');
    assert.ok(!JSON.stringify(masked).includes(SK));
    assert.notEqual(masked.revision, raw.revision);
    assert.equal(masked.revision, displayHistoryRevision(raw.revision));
    // Paging with the masked revision is consistent; a raw revision is now stale.
    await sessionsService.fetchHistory(SESSION_ID, ownerId, { limit: 1, offset: 0, displayMask: true, revision: masked.revision });
    await assert.rejects(
      sessionsService.fetchHistory(SESSION_ID, ownerId, { limit: 1, offset: 0, displayMask: true, revision: raw.revision }),
      (error: unknown) => (error as { code?: string }).code === 'HISTORY_REVISION_CHANGED',
    );
  });
});

test('the admin setting off serves raw history with the raw revision', async () => {
  await withSession(async (ownerId) => {
    configureDisplayMaskForTests({ env: () => undefined, serviceLiterals: () => [], allUserIds: () => [], readSetting: () => 'off' });
    const raw = await sessionsService.fetchHistory(SESSION_ID, ownerId, { limit: 10, offset: 0 });
    const viewer = await sessionsService.fetchHistory(SESSION_ID, ownerId, { limit: 10, offset: 0, displayMask: true });
    assert.equal(viewer.messages[0]?.content, raw.messages[0]?.content);
    assert.equal(viewer.revision, raw.revision);
  });
});

test('rename round-trip: submitting the masked title keeps the stored raw title', async () => {
  await withSession(async (ownerId) => {
    const raw = `deploy with OPENAI_API_KEY=${SK}`;
    sessionsDb.updateSessionCustomName(SESSION_ID, raw);
    const shown = 'deploy with OPENAI_API_KEY=[masked:assignment]';
    const result = sessionsService.renameSessionById(SESSION_ID, ownerId, shown);
    assert.equal(sessionsDb.getSessionById(SESSION_ID)?.custom_name, raw, 'masked text never overwrites the real title');
    assert.equal(result.summary, shown, 'the response is masked like every viewer egress');
    sessionsService.renameSessionById(SESSION_ID, ownerId, `prod ${shown}`);
    assert.equal(sessionsDb.getSessionById(SESSION_ID)?.custom_name, `prod ${raw}`);
    sessionsService.renameSessionById(SESSION_ID, ownerId, 'a fresh title');
    assert.equal(sessionsDb.getSessionById(SESSION_ID)?.custom_name, 'a fresh title');
  });
});
