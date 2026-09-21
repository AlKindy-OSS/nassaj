/**
 * Route tests for the owner-only permission fence screen (T-1770 / B-953).
 *
 * Exercises the REAL express router (server/routes/system.js) against an isolated temp
 * SQLite DB, like system-actions.test.ts. Coverage:
 *   - GET /permission-fences: owner only; lists a generation fence with its decision.
 *   - POST /permission-fences/lift: owner only; refuses without the explicit external
 *     acknowledgement or a reason, leaving the fence intact.
 *   - A valid lift deletes the fence, writes the durable intent BEFORE deleting with
 *     force=false (the UI can never bypass open leases), and records audit_log.
 *   - Lifting again is a 409 fence_not_found, not a silent success.
 */

import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';

import express from 'express';

process.env.JWT_SECRET = 'permission-fences-test-secret-0123456789abcdef';
const tmpDir = await mkdtemp(path.join(process.env.NASSAJ_TEST_TMP || tmpdir(), 'fence-routes-'));
process.env.DATABASE_PATH = path.join(tmpDir, 'db.sqlite');

const { closeConnection, getConnection } = await import('@/modules/database/connection.js');
const { initializeDatabase } = await import('@/modules/database/init-db.js');
const { default: systemRouter } = await import('../system.js');

closeConnection();
await initializeDatabase();

type TestUser = { id: number; username: string; role: string };
const OWNER: TestUser = { id: 1, username: 'owner', role: 'owner' };
const ADMIN: TestUser = { id: 2, username: 'adm', role: 'admin' };

const seedUser = getConnection().prepare('INSERT INTO users (id, username, password_hash, role) VALUES (?, ?, ?, ?)');
for (const u of [OWNER, ADMIN]) seedUser.run(u.id, u.username, 'x', u.role);

let currentUser: TestUser = OWNER;
const app = express();
app.use(express.json());
app.use('/api/system', (req, _res, next) => {
  (req as express.Request & { user: TestUser }).user = currentUser;
  next();
}, systemRouter);

const server = app.listen(0);
await new Promise<void>((resolve) => server.once('listening', () => resolve()));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

let ipCounter = 0;
async function call(method: string, urlPath: string, opts: { user?: TestUser; body?: unknown } = {}) {
  currentUser = opts.user ?? OWNER;
  ipCounter += 1;
  const res = await fetch(base + urlPath, {
    method,
    headers: { 'content-type': 'application/json', 'cf-connecting-ip': `10.9.0.${ipCounter}` },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  return { status: res.status, body: await res.json() as Record<string, any> };
}

const seedFence = () => getConnection().prepare(`INSERT INTO permission_generation_blocks
  (protocol_generation, reason_code, created_at_ms) VALUES (1, 'RECONCILED_EFFECT_UNKNOWN', ?)`).run(Date.now());
const fenceCount = () => (getConnection()
  .prepare('SELECT COUNT(*) AS n FROM permission_generation_blocks').get() as { n: number }).n;
const validLift = { generation: 1, reason: 'owner verified the connect terminal ended', acknowledgeExternalEffects: true };

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  closeConnection();
  await rm(tmpDir, { recursive: true, force: true });
});

seedFence();

test('GET lists the fence for the owner and refuses an admin', async () => {
  const denied = await call('GET', '/api/system/permission-fences', { user: ADMIN });
  assert.equal(denied.status, 403);
  const listed = await call('GET', '/api/system/permission-fences');
  assert.equal(listed.status, 200);
  assert.equal(listed.body.fences.length, 1);
  assert.equal(listed.body.fences[0].generation, 1);
  assert.equal(listed.body.fences[0].reasonCode, 'RECONCILED_EFFECT_UNKNOWN');
  assert.equal(listed.body.fences[0].decision, null);
});

test('lift refuses an admin, a missing acknowledgement and a blank reason', async () => {
  assert.equal((await call('POST', '/api/system/permission-fences/lift', { user: ADMIN, body: validLift })).status, 403);
  const unacknowledged = await call('POST', '/api/system/permission-fences/lift', {
    body: { ...validLift, acknowledgeExternalEffects: 'yes' },
  });
  assert.equal(unacknowledged.status, 400);
  assert.equal(unacknowledged.body.code, 'acknowledgement_required');
  const blank = await call('POST', '/api/system/permission-fences/lift', { body: { ...validLift, reason: '   ' } });
  assert.equal(blank.status, 400);
  assert.equal(blank.body.code, 'invalid_request');
  assert.equal(fenceCount(), 1);
});

test('owner lift deletes the fence after a force=false intent and records audit_log', async () => {
  const lifted = await call('POST', '/api/system/permission-fences/lift', { body: validLift });
  assert.equal(lifted.status, 200);
  assert.equal(lifted.body.databaseCommitted, true);
  assert.equal(lifted.body.completionAuditRecorded, true);
  assert.equal(fenceCount(), 0);

  const journal = (await readFile(`${process.env.DATABASE_PATH}.fence-lifts.jsonl`, 'utf8'))
    .trim().split('\n').map((line) => JSON.parse(line));
  const intent = journal.find((record) => record.event === 'lift_intent');
  assert.equal(intent.operationId, lifted.body.operationId);
  assert.equal(intent.actor, 'nassaj-user:1:owner');
  assert.equal(intent.force, false);
  assert.equal(intent.forceExternal, true);
  assert.equal(intent.acknowledgementIsProof, false);
  assert.ok(journal.some((record) => record.event === 'lift_committed'));

  const auditRows = JSON.stringify(getConnection().prepare('SELECT * FROM audit_log').all());
  assert.ok(auditRows.includes('permission_fence_lifted'));
  assert.ok(auditRows.includes(lifted.body.operationId));
});

test('lifting an absent fence is a 409, not a silent success', async () => {
  const again = await call('POST', '/api/system/permission-fences/lift', { body: validLift });
  assert.equal(again.status, 409);
  assert.equal(again.body.code, 'fence_not_found');
});
