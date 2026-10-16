/**
 * ADR-210 (T-2036): conversation search cannot be used as an oracle for a
 * stored secret. A hit must survive masking, and snippets come from masked
 * text. Real Claude transcripts are searched through the live path.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, participantsDb, sessionsDb, userDb } from '@/modules/database/index.js';
import {
  searchConversations,
  type SessionConversationSearchProgressUpdate,
} from '@/modules/providers/services/session-conversations-search.service.js';
// eslint-disable-next-line boundaries/no-unknown -- ADR-210 test seam of the display masking leaf service.
import { configureDisplayMaskForTests } from '@/services/display-secret-mask.js';
// eslint-disable-next-line boundaries/no-unknown -- shared test fixture helper (same seam as sandbox-home)
import { claudeProjectsSandbox } from '@/shared/__tests__/provider-root-sandbox.js';

const SK = 'sk-' + 'ant-api03-QwErTyUiOpAsDfGhJkLzXcVb';
const MARKER = 'quokkavelvetmarker';
// A GLM-format key matches no rule; it belongs to a member who never joined this session.
const GLM = '0a1b2c3d4e5f60718293a4b5c6d7e8f9.GlmKeyPartAbCdEf';

async function withSearchSession(env: string | undefined, runTest: (userId: number) => Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 't2036-search-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(tempRoot, 'auth.db');
  await initializeDatabase();
  try {
    const userId = userDb.createUser('alice', 'hash-a', 'user').id;
    const sessionId = 'display-mask-search-1';
    const transcriptPath = path.join(claudeProjectsSandbox('t2036-search-'), `${sessionId}.jsonl`);
    const line = JSON.stringify({
      type: 'user', sessionId, uuid: `${sessionId}-u1`, timestamp: '2026-10-16T10:00:00.000Z',
      message: { role: 'user', content: `${MARKER} my key is ${SK} ok, glm ${GLM}` },
    });
    await fs.writeFile(transcriptPath, `${line}\n`);
    sessionsDb.createSession(sessionId, 'claude', '/work/mask-search', null as unknown as undefined, undefined, undefined, transcriptPath);
    participantsDb.recordSpawn(sessionId, userId);
    configureDisplayMaskForTests({
      env: () => env, readSetting: () => null, serviceLiterals: () => [],
      allUserIds: () => [userId, 99], vendorLiterals: (id) => (id === 99 ? [GLM] : []),
    });
    await runTest(userId);
  } finally {
    configureDisplayMaskForTests(null);
    closeConnection();
    if (previousDatabasePath === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previousDatabasePath;
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
}

async function search(query: string, userId: number): Promise<{ total: number; streamed: string }> {
  const updates: SessionConversationSearchProgressUpdate[] = [];
  const result = await searchConversations(query, userId, 50, (update) => updates.push(update));
  // `result.query` echoes the caller's own query; only content the server found is checked.
  return { total: result.totalMatches, streamed: JSON.stringify([result.results, updates]) };
}

test('searching a prefix of a stored secret returns zero hits and streams nothing', async () => {
  await withSearchSession(undefined, async (userId) => {
    for (const query of ['sk-ant-api03-QwEr', SK.slice(0, 20), SK]) {
      const { total, streamed } = await search(query, userId);
      assert.equal(total, 0, query);
      assert.ok(!streamed.includes('QwErTyUi'), `no secret fragment streamed for ${query}`);
    }
  });
});

test('a hit on surrounding text shows a masked snippet and a masked summary', async () => {
  await withSearchSession(undefined, async (userId) => {
    const { total, streamed } = await search(MARKER, userId);
    assert.equal(total, 1);
    assert.ok(!streamed.includes('QwErTyUi'));
    assert.ok(streamed.includes('[masked:anthropic-openai-key]'));
    assert.ok(!streamed.includes('GlmKeyPart') && streamed.includes('[masked:known-secret]'), 'I5: any member key, one set');
    assert.equal((await search(GLM.slice(0, 20), userId)).total, 0, 'no oracle on a member key either');
  });
});

test('with the kill switch off, search behaves as before', async () => {
  await withSearchSession('0', async (userId) => {
    const { total } = await search(SK.slice(0, 20), userId);
    assert.equal(total, 1);
  });
});
