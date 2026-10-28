/**
 * ADR-207 S5 (T-2024): the owner-only prestage view on GET /release/latest and
 * the re-confirm route's auto-activator wake. Real router, real DB, test hooks.
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import test, { after, afterEach } from 'node:test';

import express from 'express';

const scratch = await mkdtemp(path.join(tmpdir(), 'system-update-prestage-'));
process.env.DATABASE_PATH = path.join(scratch, 'db.sqlite');
process.env.JWT_SECRET ||= 'update-prestage-test-secret-at-least-thirty-two-characters';
const previousMode = process.env.NASSAJ_UPDATE_MODE;
delete process.env.NASSAJ_UPDATE_MODE;
const { default: router, setReleaseDiscoveryForTests, setUpdateRouteHooks } = await import('../system.js');
const { closeConnection, getConnection } = await import('../../modules/database/connection.js');
const { initializeDatabase } = await import('../../modules/database/init-db.js');
const { sourceUpdateJobsDb } = await import('../../modules/database/repositories/source-update-jobs.db.js');
await initializeDatabase();
getConnection().prepare("INSERT INTO users(id, username, password_hash, role) VALUES (1, 'prestage-owner', 'test-only', 'owner')").run();

setReleaseDiscoveryForTests(async () => ({ release: { version: '2.4.0.1', tagName: 'v2.4.0.1', htmlUrl: 'https://example.invalid/r' } }));

afterEach(() => setUpdateRouteHooks(null));
after(async () => {
  setReleaseDiscoveryForTests(null);
  if (previousMode !== undefined) process.env.NASSAJ_UPDATE_MODE = previousMode;
  closeConnection();
  await rm(scratch, { recursive: true, force: true });
});

async function request(role: string, endpoint: string, body?: object) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { (req as any).user = { id: 1, role }; next(); });
  app.use('/api/system', router);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/system${endpoint}`, {
      method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: response.status, body: await response.json() as Record<string, unknown> };
  } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
}

const readyStatus = () => ({ enabled: true, policy: 'quarantine', state: 'ready', version: '2.4.0.1',
  readyAt: '2026-10-15T08:00:00.000Z', reasonCode: null, quarantineUntil: null, updatedAt: 'x' });

test('S5: the owner sees the prestage object on /release/latest', async () => {
  setUpdateRouteHooks({ prestageStatus: readyStatus });
  const { status, body } = await request('owner', '/release/latest');
  assert.equal(status, 200);
  assert.equal(body.version, '2.4.0.1');
  assert.deepEqual(body.prestage, { state: 'ready', version: '2.4.0.1', quarantineUntil: null,
    notPrestagedReason: null, readySince: '2026-10-15T08:00:00.000Z' });
});

test('S5: admins and members get exactly the previous contract', async () => {
  let reads = 0;
  setUpdateRouteHooks({ prestageStatus: () => { reads += 1; return readyStatus(); } });
  for (const role of ['admin', 'user', 'member']) {
    const { status, body } = await request(role, '/release/latest');
    assert.equal(status, 200, role);
    assert.equal(Object.hasOwn(body, 'prestage'), false, role);
  }
  assert.equal(reads, 0);
});

test('S5: a node without a prestager, or a failing one, adds nothing', async () => {
  assert.equal(Object.hasOwn((await request('owner', '/release/latest')).body, 'prestage'), false);
  setUpdateRouteHooks({ prestageStatus: () => { throw new Error('boom'); } });
  const { status, body } = await request('owner', '/release/latest');
  assert.equal(status, 200);
  assert.equal(Object.hasOwn(body, 'prestage'), false);
});

test('S5: a successful re-confirm wakes the auto-activator once; refusals do not', async () => {
  let wakes = 0;
  setUpdateRouteHooks({ wakeAutoActivator: () => { wakes += 1; } });
  const id = 'prestage-confirm-wake', digest = 'e'.repeat(64);
  sourceUpdateJobsDb.createOrReuse({ id, ownerId: 1, expectedVersion: '2.4.0.1',
    idempotencyKeyHash: '5'.repeat(64), requestFingerprint: '6'.repeat(64), strategy: 'git-checkout-v2' });
  getConnection().prepare("UPDATE source_update_jobs SET state = 'restart_queued', worker_fence = 1, activation_identity_sha256 = ?, updated_at = '2026-01-01 00:00:00' WHERE id = ?").run(digest, id);
  const body = { expectedVersion: '2.4.0.1', targetDigest: digest };
  assert.equal((await request('admin', `/update/jobs/${id}/confirm`, body)).status, 403);
  assert.equal((await request('owner', `/update/jobs/${id}/confirm`, { ...body, targetDigest: 'a'.repeat(64) })).status, 409);
  assert.equal(wakes, 0);
  assert.equal((await request('owner', `/update/jobs/${id}/confirm`, body)).status, 202);
  assert.equal(wakes, 1);
  getConnection().prepare("UPDATE source_update_jobs SET state = 'activated' WHERE id = ?").run(id);
});

test('S5: a throwing wake never fails the confirmed consent', async () => {
  setUpdateRouteHooks({ wakeAutoActivator: () => { throw new Error('boom'); } });
  const id = 'prestage-confirm-wake-throws', digest = 'd'.repeat(64);
  sourceUpdateJobsDb.createOrReuse({ id, ownerId: 1, expectedVersion: '2.4.0.1',
    idempotencyKeyHash: '3'.repeat(64), requestFingerprint: '4'.repeat(64), strategy: 'git-checkout-v2' });
  getConnection().prepare("UPDATE source_update_jobs SET state = 'restart_queued', worker_fence = 1, activation_identity_sha256 = ?, updated_at = '2026-01-01 00:00:00' WHERE id = ?").run(digest, id);
  assert.equal((await request('owner', `/update/jobs/${id}/confirm`, { expectedVersion: '2.4.0.1', targetDigest: digest })).status, 202);
});

test('T-2025: /release/latest hands every discovered release to the prestager, for every role', async () => {
  const seen: Array<Record<string, unknown>> = [];
  setUpdateRouteHooks({ noteReleaseDiscovered: (release: Record<string, unknown>) => { seen.push(release); } });
  for (const role of ['owner', 'member']) assert.equal((await request(role, '/release/latest')).status, 200, role);
  assert.deepEqual(seen.map(release => release.version), ['2.4.0.1', '2.4.0.1']);
});

test('T-2025: a throwing or rejecting prestager hook never fails the banner', async () => {
  setUpdateRouteHooks({ noteReleaseDiscovered: () => { throw new Error('boom'); } });
  assert.equal((await request('member', '/release/latest')).status, 200);
  setUpdateRouteHooks({ noteReleaseDiscovered: () => Promise.reject(new Error('boom')) });
  assert.equal((await request('member', '/release/latest')).status, 200);
});

test('T-2025: the banner reads the node\'s shared discovery when one is wired', async () => {
  setReleaseDiscoveryForTests(null);
  try {
    let calls = 0;
    setUpdateRouteHooks({ releaseDiscovery: async () => {
      calls += 1;
      return { release: { version: '2.4.0.2', tagName: 'v2.4.0.2', htmlUrl: 'https://example.invalid/r' } };
    } });
    const { status, body } = await request('member', '/release/latest');
    assert.deepEqual([status, body.version, calls], [200, '2.4.0.2', 1]);
    assert.equal(Object.hasOwn(body, 'htmlUrl'), false);
  } finally {
    setReleaseDiscoveryForTests(async () => ({ release: { version: '2.4.0.1', tagName: 'v2.4.0.1', htmlUrl: 'https://example.invalid/r' } }));
  }
});
