/**
 * B-1668 item 3, read side: a stored title still dirty from before the fix
 * (image list, injected block, markdown, a known secret) reaches every viewer
 * egress as ONE display title — sidebar list, deep link, archive, live-session
 * panel and the rename answer — with no data migration.
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  closeConnection,
  initializeDatabase,
  participantsDb,
  projectsDb,
  sessionsDb,
  userDb,
} from '@/modules/database/index.js';
import {
  getProjectsWithSessions,
  getSessionDeepLinkContext,
} from '@/modules/projects/services/projects-with-sessions-fetch.service.js';
// eslint-disable-next-line boundaries/dependencies -- integration test compares every title egress side by side.
import { sessionsService } from '@/modules/providers/services/sessions.service.js';
// eslint-disable-next-line boundaries/no-unknown -- ADR-210 test seam of the display masking leaf service.
import { configureDisplayMaskForTests } from '@/services/display-secret-mask.js';
// eslint-disable-next-line boundaries/no-unknown -- the live-session panel egress under test.
import { attachSessionTitles } from '@/services/live-session-titles.js';

const PROJECT_PATH = '/workspace/title-egress';
const LITERAL = ['abc__def*ghi', 'jkl-0123456789ABCDEFGHIJ'].join('_');
const DIRTY = `<nassaj_document_sharing>g</nassaj_document_sharing>**Fix** key ${LITERAL}\n\n`
  + '[Images provided at the following paths:]\n1. /home/user/.nassaj/chat-images/a.png';

async function withSession(runTest: (userId: number, sessionId: string) => Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'title-egress-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
  await initializeDatabase();
  try {
    const userId = userDb.createUser(`egress_${Date.now()}`, 'hash', 'user').id;
    projectsDb.createProjectPath(PROJECT_PATH, null, userId);
    sessionsDb.createSession('egress-1', 'claude', PROJECT_PATH, DIRTY);
    participantsDb.recordSpawn('egress-1', userId, { role: 'owner' });
    configureDisplayMaskForTests({
      env: () => undefined, readSetting: () => null, serviceLiterals: () => [],
      allUserIds: () => [userId], vendorLiterals: () => [LITERAL], sharedVendorLiterals: () => [],
    });
    await runTest(userId, 'egress-1');
  } finally {
    configureDisplayMaskForTests(null);
    closeConnection();
    if (previousDatabasePath === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previousDatabasePath;
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

test('every egress shows the same cleaned, masked title for a dirty stored name', async () => {
  await withSession(async (userId, sessionId) => {
    const [project] = await getProjectsWithSessions({ skipSynchronization: true, currentUserId: userId });
    const listed = (project.sessions as Array<{ id: string; summary: string }>).find((s) => s.id === sessionId)?.summary;
    const deepLinked = getSessionDeepLinkContext(sessionId, userId)?.session.summary;
    const [live] = attachSessionTitles([{ sessionId }], null) as Array<{ title?: string }>;
    sessionsDb.updateSessionIsArchived(sessionId, true);
    const archived = sessionsService.listArchivedSessions(userId).find((s) => s.sessionId === sessionId)?.sessionTitle;

    assert.equal(listed, 'Fix key [masked:known-secret]');
    assert.deepEqual([deepLinked, live?.title, archived], [listed, listed, listed]);
  });
});

test('a rename that keeps the marker restores the stored secret and answers with the display title', async () => {
  await withSession(async (userId, sessionId) => {
    const answer = sessionsService.renameSessionById(sessionId, userId, 'Fixed key [masked:known-secret]');
    assert.equal(answer.summary, 'Fixed key [masked:known-secret]');
    assert.equal(sessionsDb.getSessionById(sessionId)?.custom_name, `Fixed key ${LITERAL}`);
  });
});
