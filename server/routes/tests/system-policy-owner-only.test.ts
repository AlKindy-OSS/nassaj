/**
 * Route tests for B-1341: the tmpfs and storage policy endpoints are owner-only.
 *
 * Exercises the REAL express router (server/routes/system.js) against an isolated temp
 * SQLite DB, like permission-fences.test.ts. Coverage:
 *   - GET and PUT /tmpfs-policy and /storage-policy refuse admin and member (403)
 *     without writing, and succeed for the owner.
 *   - Owner writes still record their audit_log rows.
 * The storage PUT avoids retentionDays so the test never touches engine policy files.
 */

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';

import express from 'express';

process.env.JWT_SECRET = 'system-policy-owner-only-secret-0123456789abcdef';
const tmpDir = await mkdtemp(path.join(process.env.NASSAJ_TEST_TMP || tmpdir(), 'policy-routes-'));
process.env.DATABASE_PATH = path.join(tmpDir, 'db.sqlite');

const { closeConnection, getConnection } = await import('@/modules/database/connection.js');
const { initializeDatabase } = await import('@/modules/database/init-db.js');
const { default: systemRouter } = await import('../system.js');

closeConnection();
await initializeDatabase();

type TestUser = { id: number; username: string; role: string };
const OWNER: TestUser = { id: 1, username: 'owner', role: 'owner' };
const ADMIN: TestUser = { id: 2, username: 'adm', role: 'admin' };
const MEMBER: TestUser = { id: 3, username: 'member', role: 'user' };

const seedUser = getConnection().prepare('INSERT INTO users (id, username, password_hash, role) VALUES (?, ?, ?, ?)');
for (const u of [OWNER, ADMIN, MEMBER]) seedUser.run(u.id, u.username, 'x', u.role);

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
    headers: { 'content-type': 'application/json', 'cf-connecting-ip': `10.9.1.${ipCounter}` },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  return { status: res.status, body: await res.json() as Record<string, any> };
}

const configValue = (key: string) => (getConnection()
  .prepare('SELECT value FROM app_config WHERE key = ?').get(key) as { value: string } | undefined)?.value;
type AuditRow = { action: string; metadata: string | null; user_id: number | null; ip_address: string | null; user_agent: string | null };
const auditRows = (action: string) => getConnection()
  .prepare('SELECT action, metadata, user_id, ip_address, user_agent FROM audit_log WHERE action = ?')
  .all(action) as AuditRow[];

/** Asserts exactly one audit row for `action`, attributed to the owner with request context. */
function assertOwnerAudit(action: string, expectedMetadata: Record<string, unknown>) {
  const rows = auditRows(action);
  assert.equal(rows.length, 1);
  const [row] = rows;
  assert.equal(row.user_id, OWNER.id);
  assert.deepEqual(JSON.parse(row.metadata ?? 'null'), expectedMetadata);
  assert.ok(row.ip_address, 'ip_address recorded');
  assert.ok(row.user_agent, 'user_agent recorded');
}

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  closeConnection();
  await rm(tmpDir, { recursive: true, force: true });
});

for (const denied of [ADMIN, MEMBER]) {
  test(`${denied.role} gets 403 on GET and PUT of both policies without writing`, async () => {
    assert.equal((await call('GET', '/api/system/tmpfs-policy', { user: denied })).status, 403);
    assert.equal((await call('GET', '/api/system/storage-policy', { user: denied })).status, 403);
    const tmpfsPut = await call('PUT', '/api/system/tmpfs-policy', { user: denied, body: { desiredMb: 512 } });
    assert.equal(tmpfsPut.status, 403);
    const storagePut = await call('PUT', '/api/system/storage-policy', { user: denied, body: { imageMaxMb: 9 } });
    assert.equal(storagePut.status, 403);
    assert.equal(configValue('tmpfs_cap_mb'), undefined);
    assert.equal(configValue('chat_image_max_mb'), undefined);
    assert.equal(auditRows('tmpfs_policy_set').length, 0);
    assert.equal(auditRows('storage_policy_set').length, 0);
  });
}

test('owner reads and writes the tmpfs policy and the write is audited', async () => {
  assert.equal((await call('GET', '/api/system/tmpfs-policy')).status, 200);
  const put = await call('PUT', '/api/system/tmpfs-policy', { body: { desiredMb: 512 } });
  assert.equal(put.status, 200);
  assert.equal(put.body.desiredMb, 512);
  const read = await call('GET', '/api/system/tmpfs-policy');
  assert.equal(read.body.desiredMb, 512);
  assertOwnerAudit('tmpfs_policy_set', { desiredMb: 512 });
});

test('owner reads and writes the storage policy and the write is audited', async () => {
  const before = await call('GET', '/api/system/storage-policy');
  assert.equal(before.status, 200);
  assert.equal(before.body.imageMaxMbIsDefault, true);
  const put = await call('PUT', '/api/system/storage-policy', { body: { imageMaxMb: 9, imageMaxCount: 4 } });
  assert.equal(put.status, 200);
  assert.equal(put.body.imageMaxMb, 9);
  assert.equal(put.body.imageMaxCount, 4);
  assert.equal(configValue('chat_image_max_mb'), '9');
  assertOwnerAudit('storage_policy_set', { imageMaxMb: 9, imageMaxCount: 4 });
});
