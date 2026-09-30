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

// B-1349: FIRST import — HOME becomes a /var/tmp sandbox before anything reads it.
import '@/shared/__tests__/sandbox-home.js';
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
import { _setVersionStatusTestDeps } from './version-status.service.js';

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
  // Never spawn a real harness `--version` nor reach npm/GitHub from a route test.
  _setVersionStatusTestDeps({
    runVersion: async () => null,
    fetchNpmLatest: async () => null,
    fetchGithubLatest: async () => null,
  });
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
    const keys = Object.keys(res.json).sort();
    const required = [
      'activeJobId', 'checkedAt', 'installedVersion', 'latestVersion', 'provider',
      'reason', 'state', 'upToDate', 'updatable', 'updating',
    ];
    // T-1871 optional fields carry versions/verdicts only (no paths); their
    // presence depends on whether this host has a readable kimi binary.
    const optional = ['drift', 'manualOnly', 'notices', 'restoreCompatible'];
    for (const key of required) assert.ok(keys.includes(key), `missing ${key}`);
    for (const key of keys) {
      assert.ok(required.includes(key) || optional.includes(key), `unexpected key ${key}`);
    }
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
  // qwen: a legacy (non-snapshot) harness, so the lease check is the first refusal.
  acquireHarnessLease('qwen', 'job-held-by-another-run');
  const res = await call('POST', '/api/providers/qwen/update', { id: 1, role: 'owner' });
  assert.equal(res.status, 409);
  assert.deepEqual(res.json, {
    code: 'HARNESS_UPDATE_IN_PROGRESS',
    message: 'Harness action refused (HARNESS_UPDATE_IN_PROGRESS).',
    activeJobId: 'job-held-by-another-run',
  });
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

test('T-1871 owner routes: non-owners refused; refusals always carry a code', async () => {
  const member = { id: 3, role: 'user' };
  for (const [method, url] of [
    ['POST', '/api/providers/codex/rollback'], ['POST', '/api/providers/opencode/restore-compatible'],
    ['POST', '/api/providers/codex/recovery'], ['GET', '/api/providers/codex/snapshots'],
  ] as const) {
    assert.equal((await call(method, url, member, method === 'POST' ? {} : undefined)).status, 403, url);
  }
  const owner = { id: 1, role: 'owner' };
  const notCompat = await call('POST', '/api/providers/claude/restore-compatible', owner, {});
  assert.equal(notCompat.status, 404);
  assert.equal(notCompat.json.code, 'NOT_RESTORE_COMPATIBLE');
  const badScope = await call('POST', '/api/providers/codex/rollback', owner, { jobId: 'x', scope: 'everything' });
  assert.equal(badScope.status, 400);
  assert.equal(badScope.json.code, 'INVALID_ROLLBACK_SCOPE');
  const unknownRun = await call('POST', '/api/providers/codex/rollback', owner, { jobId: '../../etc', scope: 'binary' });
  assert.equal(unknownRun.status, 404);
  assert.equal(unknownRun.json.code, 'SNAPSHOT_NOT_FOUND');
  const recovery = await call('POST', '/api/providers/codex/recovery', owner, { action: 'retry' });
  assert.equal(recovery.status, 409);
  assert.deepEqual(recovery.json, { code: 'NO_RECOVERY_PENDING', message: 'Harness action refused (NO_RECOVERY_PENDING).' });
  const list = await call('GET', '/api/providers/codex/snapshots', owner);
  assert.equal(list.status, 200);
  assert.deepEqual(list.json, []);
});

test('the snapshot listing has its own limiter; exhausting it never blocks the POSTs', async () => {
  const owner = { id: 1, role: 'owner' };
  let limited: Record<string, unknown> | null = null;
  for (let i = 0; i < 40 && !limited; i += 1) {
    const res = await call('GET', '/api/providers/codex/snapshots', owner);
    if (res.status === 429) limited = res.json;
  }
  assert.equal(limited?.code, 'HARNESS_SNAPSHOTS_RATE_LIMITED');
  const post = await call('POST', '/api/providers/codex/recovery', owner, { action: 'retry' });
  assert.equal(post.status, 409, 'the mutation budget is separate');
  let postLimited = false;
  for (let i = 0; i < 15 && !postLimited; i += 1) {
    postLimited = (await call('POST', '/api/providers/codex/recovery', owner, { action: 'retry' })).status === 429;
  }
  assert.ok(postLimited, 'owner mutations refuse an unbounded rate');
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
