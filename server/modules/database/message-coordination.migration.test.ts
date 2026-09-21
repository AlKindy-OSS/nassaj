import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, getConnection } from '@/modules/database/connection.js';
import { initializeDatabase } from '@/modules/database/init-db.js';
import { messageCoordinationDb } from '@/modules/database/repositories/message-coordination.db.js';

test('coordination ingress claim is atomic and immutable by clientMsgId', async () => {
  const previous = process.env.DATABASE_PATH;
  const directory = await mkdtemp(path.join(process.env.NASSAJ_TEST_TMP ?? '/var/tmp', 'message-coordination-'));
  process.env.DATABASE_PATH = path.join(directory, 'db.sqlite');
  await writeFile(process.env.DATABASE_PATH, '');
  closeConnection();
  await initializeDatabase();
  try {
    const db = getConnection();
    db.prepare("INSERT INTO users (username, password_hash, role) VALUES ('owner', 'hash', 'admin')").run();
    const userId = (db.prepare("SELECT id FROM users WHERE username='owner'").get() as { id: number }).id;
    const base = {
      sessionId: null, clientMsgId: 'c1', userId, provider: 'codex', canonicalContent: 'exact user bytes',
    };
    assert.deepEqual(messageCoordinationDb.claim({ ...base, coordinationLevel: 'delegate' }), { action: 'dispatch' });
    assert.deepEqual(messageCoordinationDb.claim({ ...base, coordinationLevel: 'delegate' }), { action: 'ambiguous_started' });
    assert.deepEqual(messageCoordinationDb.claim({ ...base, coordinationLevel: 'direct' }), { action: 'fingerprint_mismatch' });
    assert.equal(messageCoordinationDb.bindSession('c1', userId, 's1', 'codex'), true);

    const scope = { clientMsgId: 'c1', userId, provider: 'codex', sessionId: 's1' };
    assert.equal(messageCoordinationDb.readDelivery(scope)?.acceptedAt, null);
    for (const changed of [{ userId: userId + 1 }, { provider: 'claude' }, { sessionId: 'other' }, { clientMsgId: 'other' }]) {
      assert.equal(messageCoordinationDb.markStarted({ ...scope, ...changed }), false);
    }
    assert.equal(messageCoordinationDb.bindSession('c1', userId, 's2', 'codex'), false);
    assert.equal(messageCoordinationDb.bindSession('c1', userId, 's1', 'claude'), false);
    assert.equal(messageCoordinationDb.markStarted(scope), true);
    const acceptedAt = messageCoordinationDb.readDelivery(scope)?.acceptedAt;
    assert.ok(acceptedAt);
    assert.equal(messageCoordinationDb.markStarted(scope), true);
    assert.equal(messageCoordinationDb.readDelivery(scope)?.acceptedAt, acceptedAt);
    messageCoordinationDb.recordVerdict({ ...scope, provider: 'claude' }, 'terminal', { kind: 'error' });
    assert.equal(messageCoordinationDb.readDelivery(scope)?.lifecycleStatus, 'started');
    messageCoordinationDb.recordVerdict(scope, 'terminal', { kind: 'error', code: 'aborted' });
    assert.equal(messageCoordinationDb.readDelivery(scope)?.acceptedAt, acceptedAt);
    assert.equal(messageCoordinationDb.readDelivery(scope)?.lifecycleStatus, 'terminal');
    assert.equal(messageCoordinationDb.markStarted(scope), false);

    const rows = messageCoordinationDb.listBySession('s1');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].coordinationLevel, 'delegate', 'replay cannot replace the accepted level');
    assert.equal(rows[0].canonicalContent, 'exact user bytes');

    const retry = { ...base, clientMsgId: 'c2' };
    assert.deepEqual(messageCoordinationDb.claim({ ...retry, coordinationLevel: 'delegate' }), { action: 'dispatch' });
    messageCoordinationDb.recordVerdict({ clientMsgId: 'c2', userId, provider: 'codex', sessionId: null }, 'not_started', { kind: 'error', code: 'session_busy' });
    assert.deepEqual(messageCoordinationDb.claim({ ...retry, coordinationLevel: 'delegate' }), { action: 'dispatch' });
    messageCoordinationDb.recordVerdict({ clientMsgId: 'c2', userId, provider: 'codex', sessionId: null }, 'terminal', { kind: 'complete', success: true });
    assert.deepEqual(messageCoordinationDb.claim({ ...retry, coordinationLevel: 'delegate' }), {
      action: 'replay_verdict', verdict: { kind: 'complete', success: true },
    });
  } finally {
    closeConnection();
    if (previous === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previous;
    await rm(directory, { recursive: true, force: true });
  }
});
