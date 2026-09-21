import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import * as childProcess from 'node:child_process';
import test, { after, mock } from 'node:test';

import express from 'express';

process.env.JWT_SECRET = 'outcome-read-test-secret-01234567890123456789';
let spawns = 0;
mock.module('node:child_process', { namedExports: { ...childProcess,
  spawn: () => { spawns++; throw new Error('GET must never execute an action'); },
} });
const { initializeDatabase, closeConnection, userDb, getConnection, pendingServerActionsDb } = await import('../../modules/database/index.js');
const { authenticateToken, generateToken } = await import('../../middleware/auth.js');
const { default: router, setOidReceiptReaderForTests } = await import('../system.js');
await initializeDatabase();
const owner = userDb.createUser('outcome-owner', 'hash', 'owner');
const admin = userDb.createUser('outcome-admin', 'hash', 'admin');
const user = userDb.createUser('outcome-user', 'hash', 'user');
const app = express();
app.use('/api/system', authenticateToken, router);
const server = app.listen(0, '127.0.0.1');
await new Promise<void>(resolve => server.once('listening', resolve));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/system/pending`;
let requests = 0;
async function read(id: string, role: typeof owner | null = owner) {
  requests++;
  return fetch(`${base}/${id}/outcome`, { headers: {
    ...(role ? { authorization: `Bearer ${generateToken(role)}` } : {}),
    'cf-connecting-ip': `10.0.1.${requests}`,
  } });
}
function fixture(state = 'loaded', extra: Record<string, unknown> = {}) {
  const id = randomUUID();
  pendingServerActionsDb.insert({ id, actionType: 'safe-restart', requestedBy: 'outcome-user', expectedServerBuildId: 'b'.repeat(64) });
  pendingServerActionsDb.claimForExecution(id);
  const row = pendingServerActionsDb.getById(id)!;
  const receipt = { schema: 'nassaj-oid-control-transaction/v1', actionId: id, transactionNonce: row.executionAttemptNonce,
    buildId: row.expectedServerBuildId, sequence: 1, state, oid: 'c'.repeat(40), bootNonce: 'd'.repeat(64), newPid: 123, newStartTicks: '456', ...extra };
  setOidReceiptReaderForTests(() => [receipt]);
  return { id, row, receipt };
}
after(async () => { setOidReceiptReaderForTests(null); await new Promise<void>(resolve => server.close(() => resolve())); closeConnection(); });

test('owner reads exact loaded/served outcome before and after terminal settlement without leaking runtime identity', async () => {
  for (const state of ['loaded', 'served']) {
    const f = fixture(state);
    for (const settled of [false, true]) {
      if (settled) pendingServerActionsDb.settleExecution(f.id, f.row.executionAttemptNonce!, f.row.expectedServerBuildId!, 'succeeded', 'oid_loaded');
      const response = await read(f.id); assert.equal(response.status, 200);
      assert.equal(response.headers.get('cache-control'), 'no-store');
      assert.deepEqual(await response.json(), { actionId: f.id, currentActionOutcome: { status: 'success', reasonCode: 'oid_loaded', retryable: false } });
    }
  }
});
test('router authentication and owner role gate reads, regardless of requestedBy text', async () => {
  const f = fixture();
  assert.equal((await read(f.id, null)).status, 401);
  for (const role of [user, admin]) assert.equal((await read(f.id, role)).status, 403);
  assert.equal((await read(f.id)).status, 200);
});
test('missing/retained-away actions, old attempts, other builds and incomplete loaded proof never succeed', async () => {
  const absent = await read(randomUUID()); assert.equal(absent.status, 200);
  assert.equal((await absent.json()).currentActionOutcome.reasonCode, 'action_missing');
  assert.equal((await read('invalid-id')).status, 400);
  for (const extra of [{ transactionNonce: '0'.repeat(64) }, { buildId: '0'.repeat(64) }, { bootNonce: null }, { newPid: 0 }, { newStartTicks: '' }, { oid: 'invalid' }, { schema: 'unknown' }]) {
    const f = fixture('loaded', extra);
    const body = await (await read(f.id)).json(); assert.equal(body.currentActionOutcome.status, 'unknown');
  }
  const f = fixture(); setOidReceiptReaderForTests(() => []);
  assert.equal((await (await read(f.id)).json()).currentActionOutcome.status, 'unknown');
});
test('rollback/recovery are explicit failures and contradictory exact receipts fail closed', async () => {
  for (const [state, reason] of [['rolled_back', 'oid_rolled_back'], ['manual_recovery_required', 'oid_manual_recovery_required']]) {
    const f = fixture(state);
    assert.deepEqual((await (await read(f.id)).json()).currentActionOutcome, { status: 'failure', reasonCode: reason, retryable: false });
  }
  const f = fixture();
  setOidReceiptReaderForTests(() => [f.receipt, { ...f.receipt, state: 'rolled_back', sequence: 2 }]);
  assert.deepEqual((await (await read(f.id)).json()).currentActionOutcome, { status: 'unknown', reasonCode: 'receipt_conflict', retryable: false });
});
test('superseded by another request is not success and a proven deferred attempt is explicit', async () => {
  const f = fixture(); pendingServerActionsDb.markSuperseded(f.id, 'superseded_by:other-action');
  assert.equal((await (await read(f.id)).json()).currentActionOutcome.reasonCode, 'superseded');
  const deferred = fixture('restart_deferred_restored', { gate: 6 });
  assert.deepEqual((await (await read(deferred.id)).json()).currentActionOutcome, { status: 'pending', reasonCode: 'live_sessions', retryable: true });
});
test('a stable never-claimed pending action permits the first manual attempt, not automatic execution', async () => {
  const id = randomUUID(); pendingServerActionsDb.insert({ id, actionType: 'safe-restart', expectedServerBuildId: 'b'.repeat(64) });
  setOidReceiptReaderForTests(() => []);
  try {
    assert.deepEqual((await (await read(id)).json()).currentActionOutcome, { status: 'pending', reasonCode: 'action_pending', retryable: true });
  } finally { pendingServerActionsDb.deleteById(id); }
});
test('reread detects nonce, build, status and deletion races rather than reporting a prior attempt', async () => {
  const original = pendingServerActionsDb.getById;
  for (const patch of [{ executionAttemptNonce: 'f'.repeat(64) }, { expectedServerBuildId: 'f'.repeat(64) }, { status: 'superseded' }, null]) {
    const f = fixture(); let reads = 0;
    pendingServerActionsDb.getById = ((id: string) => {
      const row = original(id); reads++;
      return reads === 2 ? patch === null ? null : { ...row, ...patch } : row;
    }) as typeof original;
    try {
      assert.equal((await (await read(f.id)).json()).currentActionOutcome.reasonCode, 'action_changed');
      assert.equal(reads, 2);
    } finally { pendingServerActionsDb.getById = original; }
  }
});
test('authorized outcome GET never maintains, settles, prunes, writes queue rows or spawns', async () => {
  const f = fixture(), methods = ['settleExecution', 'reapStaleExecuting', 'pruneHistory', 'claimForExecution', 'markSucceeded', 'markFailed', 'markSuperseded', 'resetToPending'] as const;
  const before = getConnection().prepare('SELECT * FROM pending_server_actions ORDER BY id').all();
  const originals = methods.map(name => [name, pendingServerActionsDb[name]] as const);
  let writes = 0; const initialSpawns = spawns;
  for (const name of methods) (pendingServerActionsDb as any)[name] = () => { writes++; throw new Error('unexpected GET mutation'); };
  try {
    for (let index = 0; index < 3; index++) assert.equal((await read(f.id)).status, 200);
    assert.equal(writes, 0); assert.equal(spawns, initialSpawns);
    assert.deepEqual(getConnection().prepare('SELECT * FROM pending_server_actions ORDER BY id').all(), before);
  } finally { for (const [name, method] of originals) (pendingServerActionsDb as any)[name] = method; }
  // Existing requireRole denial auditing is intentionally retained; the read handler performs no writes.
});
