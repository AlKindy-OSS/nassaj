import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';

import { closeConnection, getConnection, initializeDatabase, sessionsDb, messageCoordinationDb } from '@/modules/database/index.js';

import { loadStableHistorySnapshot, projectLightHistory, resetHistorySnapshotCacheForTests } from '../../services/session-history-light.service.js';

import { ClaudeSessionsProvider } from './claude-sessions.provider.js';
import { claudeTextPayloadHash, projectClaudeHistoryReceipts } from './claude-receipt-identity.js';

test('real Claude reader and shared cache count all UUID records before filtering and project fresh owner evidence', async () => {
  const directory = await mkdtemp(path.join(process.env.NASSAJ_TEST_TMP || tmpdir(), 'claude-reader-'));
  process.env.DATABASE_PATH = path.join(directory, 'db.sqlite');
  await writeFile(process.env.DATABASE_PATH, ''); closeConnection(); await initializeDatabase();
  try {
    const db = getConnection();
    db.prepare("INSERT INTO users (id,username,password_hash,role) VALUES (1,'owner','hash','admin'),(2,'other','hash','admin')").run();
    const uuid = '21111111-2222-4333-8444-555555555555';
    const base = { userId: 1, clientMsgId: 'c1', provider: 'claude', sessionId: 'session', canonicalContent: 'hello', coordinationLevel: 'direct' as const };
    assert.equal(messageCoordinationDb.claim(base).action, 'dispatch');
    assert.equal(messageCoordinationDb.bindClaudeIdentity({ ...base, uuid, payloadSha256: claudeTextPayloadHash('hello')! }), true);
    assert.equal(messageCoordinationDb.markStarted(base), true);
    const nativePath = path.join(directory, 'session.jsonl');
    const native = { uuid, sessionId: 'session', type: 'user', message: { role: 'user', content: 'hello' } };
    await writeFile(nativePath, JSON.stringify(native) + '\n');
    sessionsDb.createSession('session', 'claude', directory, undefined, undefined, undefined, nativePath);
    messageCoordinationDb.recordVerdict({ ...base, sessionId: 'session' }, 'terminal', { kind: 'complete', exitCode: 0 });
    const provider = new ClaudeSessionsProvider(); let loads = 0;
    const load = async () => { loads++; return provider.fetchHistory('session'); };
    const source = { provider: 'claude' as const, projectPath: directory, jsonlPath: nativePath, updatedAt: 'fixture' };
    resetHistorySnapshotCacheForTests();
    for (const owner of [1, 2, 2, 1]) {
      const cached = await loadStableHistorySnapshot({ sessionId: 'session', requesterUserId: owner, source, pageKey: 'all', load });
      assert.equal(cached.result.messages[0].clientMsgId, undefined);
      const projected = projectClaudeHistoryReceipts(cached.result, 'session', owner);
      assert.equal(projected.messages[0].clientMsgId, owner === 1 ? 'c1' : undefined);
      assert.equal(cached.result.messages[0].clientMsgId, undefined);
    }
    assert.equal(loads, 1, 'both owners consume the actual same private-sidecar cache snapshot');
    await writeFile(nativePath, [native, { uuid, type: 'tool', sessionId: 'different' }].map(row => JSON.stringify(row)).join('\n') + '\n');
    const duplicate = await provider.fetchHistory('session');
    assert.equal(duplicate.messages.length, 1, 'foreign row was filtered from visible history');
    assert.equal(projectClaudeHistoryReceipts(duplicate, 'session', 1).messages[0].clientMsgId, undefined,
      'duplicate is counted BEFORE reader filters foreign/tool rows');
    resetHistorySnapshotCacheForTests();
  } finally { resetHistorySnapshotCacheForTests(); closeConnection(); await rm(directory, { recursive: true, force: true }); }
});

test('B-1078: real coordination rows pair for display through claimed, started and error without the deletion proof', async () => {
  const directory = await mkdtemp(path.join(process.env.NASSAJ_TEST_TMP || tmpdir(), 'claude-b1078-'));
  process.env.DATABASE_PATH = path.join(directory, 'db.sqlite');
  await writeFile(process.env.DATABASE_PATH, ''); closeConnection(); await initializeDatabase();
  try {
    getConnection().prepare("INSERT INTO users (id,username,password_hash,role) VALUES (1,'owner','hash','admin'),(2,'member','hash','admin')").run();
    const uuid = '41111111-2222-4333-8444-555555555555';
    const base = { userId: 1, clientMsgId: 'cmid_mid', provider: 'claude', sessionId: 'session', canonicalContent: 'hello', coordinationLevel: 'direct' as const };
    const nativePath = path.join(directory, 'session.jsonl');
    await writeFile(nativePath, JSON.stringify({ uuid, sessionId: 'session', type: 'user', message: { role: 'user', content: 'hello' } }) + '\n');
    sessionsDb.createSession('session', 'claude', directory, undefined, undefined, undefined, nativePath);
    const provider = new ClaudeSessionsProvider();
    const view = async (requester: number | null) => {
      const row = projectLightHistory(projectClaudeHistoryReceipts(await provider.fetchHistory('session'), 'session', requester)).messages[0];
      return { display: row.displayClientMsgId, prune: row.clientMsgId };
    };
    assert.equal(messageCoordinationDb.claim(base).action, 'dispatch');
    assert.equal(messageCoordinationDb.bindClaudeIdentity({ ...base, uuid, payloadSha256: claudeTextPayloadHash('hello')! }), true);
    assert.deepEqual(await view(1), { display: 'cmid_mid', prune: undefined }, 'claimed, acceptedAt null');
    assert.equal(messageCoordinationDb.markStarted(base), true);
    assert.deepEqual(await view(1), { display: 'cmid_mid', prune: undefined }, 'started mid-turn');
    assert.deepEqual(await view(2), { display: undefined, prune: undefined }, 'other member');
    assert.deepEqual(await view(null), { display: undefined, prune: undefined }, 'no requester');
    messageCoordinationDb.recordVerdict(base, 'terminal', { kind: 'error', message: 'boom' });
    assert.deepEqual(await view(1), { display: 'cmid_mid', prune: undefined }, 'terminal error');
  } finally { closeConnection(); await rm(directory, { recursive: true, force: true }); }
});
