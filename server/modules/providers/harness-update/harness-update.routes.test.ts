/**
 * harness-update.routes.test — the WIRE surface of the version-indicator routes
 * (T-1749 / ADR-159; B-1097 findings 9, 11, 12).
 *
 * Driven through a REAL express app over a REAL socket (no handler is called
 * directly), because the three things under test only exist at this layer:
 *
 *   1. the aggregate `GET /version-status` is RATE-LIMITED — it fans out to a
 *      `--version` probe per harness, and the client polls it;
 *   2. saving auto-update settings re-arms the scheduler with the saved interval;
 *   3. the owner gate answers 403 for a non-owner and the conflict answers 409
 *      with `{ activeJobId }` — the two codes the client maps to distinct states
 *      (`not-permitted`, `in-progress`) rather than to "update failed".
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after, before } from 'node:test';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

import express from 'express';

import { appConfigDb, closeConnection, initializeDatabase } from '@/modules/database/index.js';
import { AppError } from '@/shared/utils.js';

import { acquireHarnessLease, _resetHarnessLeases } from './lease.js';
import { isSchedulerRunning, stopHarnessAutoUpdateScheduler } from './scheduler.js';
import router from './harness-update.routes.js';

type TestUser = { id: number; role: string };

let currentUser: TestUser | null = { id: 1, role: 'owner' };
let server: Server;
let baseUrl = '';
let dbDir = '';

async function call(method: string, urlPath: string, user: TestUser | null, body?: unknown) {
  currentUser = user;
  const response = await fetch(`${baseUrl}${urlPath}`, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: response.status, json };
}

before(async () => {
  closeConnection();
  dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-routes-db-'));
  process.env.DATABASE_PATH = path.join(dbDir, 'db.sqlite');
  await initializeDatabase();

  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    if (!currentUser) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }
    (req as unknown as { user: TestUser }).user = currentUser;
    next();
  });
  app.use('/api/providers', router);
  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (err instanceof AppError) {
      res.status(err.statusCode).json({ error: err.message, code: err.code });
      return;
    }
    res.status(500).json({ error: 'internal' });
  });
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  stopHarnessAutoUpdateScheduler();
  _resetHarnessLeases();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  closeConnection();
  fs.rmSync(dbDir, { recursive: true, force: true });
});

test('only an owner may mutate; admin/member/anonymous are refused', async () => {
  for (const user of [{ id: 2, role: 'admin' }, { id: 3, role: 'user' }]) {
    const res = await call('POST', '/api/providers/kimi/update', user);
    assert.equal(res.status, 403);
  }
  const anonymous = await call('POST', '/api/providers/kimi/update', null);
  assert.equal(anonymous.status, 401);
});

test('authenticated owner/admin/member may read status without host details', async () => {
  for (const user of [
    { id: 1, role: 'owner' }, { id: 2, role: 'admin' }, { id: 3, role: 'user' },
  ]) {
    const res = await call('GET', '/api/providers/kimi/version-status', user);
    assert.equal(res.status, 200);
    assert.deepEqual(Object.keys(res.json).sort(), [
      'activeJobId', 'checkedAt', 'installedVersion', 'latestVersion', 'provider',
      'reason', 'state', 'upToDate', 'updatable', 'updating',
    ]);
  }
});

test('GET reflects a durable recovery fence after in-memory state is absent', async () => {
  appConfigDb.set('harness_update_recovery_failed:qwen', '1');
  try {
    const res = await call('GET', '/api/providers/qwen/version-status', { id: 1, role: 'owner' });
    assert.equal(res.status, 200);
    assert.equal(res.json.reason, 'recovery_failed');
    assert.equal(res.json.updatable, false);
    assert.equal(res.json.updating, false);
    assert.equal(res.json.activeJobId, null);
    assert.equal(res.json.installedVersion, null);
  } finally {
    appConfigDb.set('harness_update_recovery_failed:qwen', '');
  }
});

test('a harness already updating answers 409 with { activeJobId }', async () => {
  _resetHarnessLeases();
  acquireHarnessLease('kimi', 'job-held-by-another-run');
  const res = await call('POST', '/api/providers/kimi/update', { id: 1, role: 'owner' });
  assert.equal(res.status, 409);
  assert.deepEqual(res.json, { activeJobId: 'job-held-by-another-run' });
  _resetHarnessLeases();
});

test('an unknown harness id is a clean 404, never a crash', async () => {
  const res = await call('GET', '/api/providers/not-a-harness/version-status', { id: 1, role: 'owner' });
  assert.equal(res.status, 404);
});

test('a command-shaped provider id stays data and never reaches an updater', async () => {
  const injected = encodeURIComponent('kimi;touch /var/tmp/harness-owned');
  const res = await call('POST', `/api/providers/${injected}/update`, { id: 1, role: 'owner' });
  assert.equal(res.status, 404);
  assert.equal(res.json.code, 'UNKNOWN_HARNESS');
});

test('saving auto-update settings re-arms the scheduler timer', async () => {
  stopHarnessAutoUpdateScheduler();
  assert.equal(isSchedulerRunning(), false, 'precondition: no timer armed');

  const res = await call('PUT', '/api/providers/autoupdate-settings', { id: 1, role: 'owner' }, {
    enabled: true, intervalMinutes: 60,
  });
  assert.equal(res.status, 200);
  assert.equal(res.json.intervalMinutes, 60);
  assert.equal(isSchedulerRunning(), true, 'the saved interval reaches a live timer');
  stopHarnessAutoUpdateScheduler();
});

test('corrupt persisted settings disable scheduling and string intervals are rejected', async () => {
  appConfigDb.set('harness_autoupdate', '{corrupt');
  const read = await call('GET', '/api/providers/autoupdate-settings', { id: 1, role: 'owner' });
  assert.equal(read.status, 200);
  assert.equal(read.json.enabled, false);
  assert.equal(read.json.intervalMinutes, 720);

  const write = await call('PUT', '/api/providers/autoupdate-settings', { id: 1, role: 'owner' }, {
    enabled: true, intervalMinutes: '60',
  });
  assert.equal(write.status, 400);
});

test('the aggregate version-status route is rate limited (429 + Retry-After)', async () => {
  const owner = { id: 1, role: 'owner' };
  let sawLimit = false;
  // The limiter window is 60s / 30 requests; the 31st call in the window is 429.
  for (let i = 0; i < 40 && !sawLimit; i += 1) {
    currentUser = owner;
    const response = await fetch(`${baseUrl}/api/providers/version-status`);
    if (response.status === 429) {
      sawLimit = true;
      assert.ok(response.headers.get('retry-after'), 'a 429 tells the client when to retry');
      const body = (await response.json()) as { code?: string };
      assert.equal(body.code, 'HARNESS_STATUS_RATE_LIMITED');
    } else {
      await response.json().catch(() => ({}));
    }
  }
  assert.ok(sawLimit, 'the aggregate route refuses an unbounded poll rate');
});
