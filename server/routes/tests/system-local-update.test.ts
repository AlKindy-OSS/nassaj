import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import test, { after } from 'node:test';

import express from 'express';

const scratch = await mkdtemp(path.join(tmpdir(), 'system-local-update-'));
process.env.DATABASE_PATH = path.join(scratch, 'db.sqlite');
process.env.JWT_SECRET ||= 'local-update-test-secret-at-least-thirty-two-characters';
const previousMode = process.env.NASSAJ_UPDATE_MODE;
const { default: router } = await import('../system.js');
const { resolveHostUpdateMode, publicLocalUpdate } = await import('../../services/local-preview-server-control.js');
const { closeConnection, getConnection } = await import('../../modules/database/connection.js');
const { initializeDatabase } = await import('../../modules/database/init-db.js');
await initializeDatabase();
getConnection().prepare("INSERT INTO users(id, username, password_hash, role) VALUES (1, 'local-update-owner', 'test-only', 'owner')").run();

after(async () => {
  if (previousMode === undefined) delete process.env.NASSAJ_UPDATE_MODE;
  else process.env.NASSAJ_UPDATE_MODE = previousMode;
  closeConnection();
  await rm(scratch, { recursive: true, force: true });
});

/** Mount the real router with an authenticated principal, without invoking a live update. */
async function request(role: string, endpoint: string, body?: object, method?: string) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { (req as any).user = { id: 1, role }; next(); });
  app.use('/api/system', router);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/system${endpoint}`, {
      method: method || (body ? 'POST' : 'GET'), headers: { 'Content-Type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: response.status, cache: response.headers.get('cache-control'), body: await response.json() };
  } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
}

test('mode defaults to release and rejects unrecognized trusted configuration', () => {
  assert.equal(resolveHostUpdateMode({}), 'release');
  assert.equal(resolveHostUpdateMode({ NASSAJ_UPDATE_MODE: 'local-main' }), 'local-main');
  assert.throws(() => resolveHostUpdateMode({ NASSAJ_UPDATE_MODE: 'arbitrary-ref' }), /local_update_mode_invalid/);
});

test('a release host reports only its mode and does not inspect or prepare local candidates', async () => {
  delete process.env.NASSAJ_UPDATE_MODE;
  const result = await request('owner', '/update/local');
  assert.equal(result.status, 200);
  assert.equal(result.cache, 'no-store');
  assert.deepEqual(result.body, { mode: 'release' });
});

test('local preparation and control are owner-only', async () => {
  for (const [endpoint, body] of [
    ['/update/local', undefined], ['/update/local/prepare', {}],
    ['/update/local/1/confirm', {}], ['/update/local/1/cancel', {}],
  ] as const) assert.equal((await request('member', endpoint, body)).status, 403);
});

test('invalid input is rejected before preparation can touch a Git tree', async () => {
  process.env.NASSAJ_UPDATE_MODE = 'local-main';
  assert.equal((await request('owner', '/update/local/prepare', { expectedOid: '../main', mode: 'release' })).status, 400);
  assert.equal((await request('owner', '/update/local/not-a-number/cancel', { expectedRevision: 1 })).status, 400);
});

test('confirm cannot invoke a legacy capsule when pair activation is not installed', async () => {
  process.env.NASSAJ_UPDATE_MODE = 'local-main';
  const result = await request('owner', '/update/local/1/confirm', { targetDigest: 'a'.repeat(64), expectedRevision: 1 });
  assert.equal(result.status, 409);
  assert.deepEqual(result.body, { code: 'pair_activation_unavailable', activationReady: false });
});

test('public local state omits authorization and activation control records', () => {
  const result = publicLocalUpdate({ sequence: 1, revision: 2, oid: 'a'.repeat(40), phase: 'prepared',
    prepare: { ownerId: 'private' }, activation: { actionId: 'private' }, consent: { ownerId: 'private', expiresAt: 123 } });
  assert.equal(result.consentExpiresAt, 123);
  assert.equal('prepare' in result, false);
  assert.equal('activation' in result, false);
  assert.equal('consent' in result, false);
});


test('a release owner renews consent for the exact queued target through the update dialog only', async () => {
  delete process.env.NASSAJ_UPDATE_MODE;
  const { sourceUpdateJobsDb } = await import('../../modules/database/repositories/source-update-jobs.db.js');
  const { hasCurrentUpdateConsent } = await import('../../services/update-auto-activator.js');
  const id = 'local-api-release-consent', digest = 'f'.repeat(64);
  sourceUpdateJobsDb.createOrReuse({ id, ownerId: 1, expectedVersion: '1.47.0.20',
    idempotencyKeyHash: '7'.repeat(64), requestFingerprint: '8'.repeat(64), strategy: 'git-checkout-v2' });
  getConnection().prepare("UPDATE source_update_jobs SET state = 'restart_queued', worker_fence = 1, activation_identity_sha256 = ?, updated_at = '2026-01-01 00:00:00' WHERE id = ?").run(digest, id);
  const body = { expectedVersion: '1.47.0.20', targetDigest: digest };
  assert.equal((await request('admin', `/update/jobs/${id}/confirm`, body)).status, 403);
  assert.equal((await request('owner', `/update/jobs/${id}/confirm`, { ...body, targetDigest: 'a'.repeat(64) })).status, 409);
  assert.equal(hasCurrentUpdateConsent(sourceUpdateJobsDb, sourceUpdateJobsDb.getById(id)), false);
  assert.equal((await request('owner', `/update/jobs/${id}/confirm`, body)).status, 202);
  const renewed = sourceUpdateJobsDb.getById(id);
  assert.equal(hasCurrentUpdateConsent(sourceUpdateJobsDb, renewed), true);
  assert.equal(hasCurrentUpdateConsent(sourceUpdateJobsDb, { ...renewed, activation_identity_sha256: 'a'.repeat(64) }), false);
  getConnection().prepare("UPDATE source_update_jobs SET state = 'activated' WHERE id = ?").run(id);
  assert.equal((await request('owner', `/update/jobs/${id}/confirm`, body)).status, 409);
});


test('development policy is owner-only and invalid mutation cannot create authority', async () => {
  assert.equal((await request('member', '/update/local/policy')).status, 403);
  assert.equal((await request('member', '/update/local/policy', {}, 'PUT')).status, 403);
  const result = await request('owner', '/update/local/policy', { mode: 'dev-full-auto', expectedRevision: 0, ownerId: 9 }, 'PUT');
  assert.equal(result.status, 400); assert.equal(result.body.code, 'local_update_policy_invalid_request');
});
