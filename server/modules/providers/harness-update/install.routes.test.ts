/**
 * install.routes.test — wire surface of `POST /api/providers/:id/install`
 * (T-2062, qa C2/C3/C8/C9) over a real express app and socket. Every install
 * dependency is injected: no network, no child process, no real home write.
 */

// B-1349: FIRST import — HOME becomes a /var/tmp sandbox before anything reads it.
import { SANDBOX_HOME } from '@/shared/__tests__/sandbox-home.js';
import assert from 'node:assert/strict';
import test, { after, before, beforeEach } from 'node:test';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

import express from 'express';

import { HarnessBinaryUnresolvedError } from '@/shared/harness-binaries.js';
import { AppError } from '@/shared/utils.js';

import { _setInstallTestDeps, type InstallDeps } from './install.service.js';
import { _resetHarnessLeases, acquireHarnessLease } from './lease.js';
import router from './harness-update.routes.js';
import { _awaitHarnessJob, _resetHarnessJobs } from './update-jobs.js';

type TestUser = { id: number; role: string };
const OWNER: TestUser = { id: 1, role: 'owner' };
const MEMBER: TestUser = { id: 2, role: 'member' };

let currentUser: TestUser = OWNER;
let server: Server;
let baseUrl = '';

async function post(urlPath: string, user: TestUser) {
  currentUser = user;
  const response = await fetch(`${baseUrl}${urlPath}`, { method: 'POST' });
  return { status: response.status, json: (await response.json().catch(() => ({}))) as Record<string, unknown> };
}

function deps(over: Partial<InstallDeps> = {}): void {
  _setInstallTestDeps({
    home: () => SANDBOX_HOME,
    isPlatform: () => false,
    serverEnv: () => ({}),
    resolveBinary: (id) => { throw new HarnessBinaryUnresolvedError(id, 'not-installed', 'missing'); },
    audit: () => {},
    installCompatAsset: async () => {},
    verifyInstalled: async () => '1.0.0',
    fetchImpl: (async () => { throw new Error('no network in tests'); }) as typeof fetch,
    ...over,
  });
}

before(async () => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
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

beforeEach(() => {
  _resetHarnessLeases();
  _resetHarnessJobs();
  deps();
});

after(async () => {
  _setInstallTestDeps(null);
  _resetHarnessLeases();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

test('owner gets 202 { jobId, provider, status } and the job polls as kind=install', async () => {
  const res = await post('/api/providers/opencode/install', OWNER);
  assert.equal(res.status, 202);
  assert.equal(res.json.provider, 'opencode');
  assert.equal(res.json.status, 'running');
  await _awaitHarnessJob(String(res.json.jobId));
  currentUser = OWNER;
  const poll = await fetch(`${baseUrl}/api/providers/update-jobs/${String(res.json.jobId)}`);
  const job = (await poll.json()) as Record<string, unknown>;
  assert.equal(job.kind, 'install');
  assert.equal(job.status, 'succeeded');
  assert.equal(job.percent, 100);
});

test('a member gets 403 and nothing starts', async () => {
  let started = false;
  deps({ installCompatAsset: async () => { started = true; } });
  const res = await post('/api/providers/opencode/install', MEMBER);
  assert.equal(res.status, 403);
  assert.equal(started, false);
});

test('unknown harness 404 UNKNOWN_HARNESS; a non-installable one 404 HARNESS_NOT_INSTALLABLE', async () => {
  assert.deepEqual([(await post('/api/providers/nope/install', OWNER)).json.code], ['UNKNOWN_HARNESS']);
  const res = await post('/api/providers/cursor/install', OWNER);
  assert.equal(res.status, 404);
  assert.equal(res.json.code, 'HARNESS_NOT_INSTALLABLE');
});

test('C2: platform mode answers 403 PLATFORM_MODE_UNSUPPORTED', async () => {
  deps({ isPlatform: () => true });
  const res = await post('/api/providers/codex/install', OWNER);
  assert.equal(res.status, 403);
  assert.equal(res.json.code, 'PLATFORM_MODE_UNSUPPORTED');
});

test('C3: installed / invalid install / override set each answer 409 with their code', async () => {
  deps({ resolveBinary: () => '/somewhere/codex' });
  assert.deepEqual(await post('/api/providers/codex/install', OWNER).then((r) => [r.status, r.json.code]),
    [409, 'HARNESS_ALREADY_INSTALLED']);
  deps({ resolveBinary: (id) => { throw new HarnessBinaryUnresolvedError(id, 'invalid-install', 'bad'); } });
  assert.deepEqual(await post('/api/providers/codex/install', OWNER).then((r) => [r.status, r.json.code]),
    [409, 'HARNESS_INSTALL_INVALID']);
  deps({ serverEnv: () => ({ CODEX_PATH: '/opt/codex' }) });
  assert.deepEqual(await post('/api/providers/codex/install', OWNER).then((r) => [r.status, r.json.code]),
    [409, 'HARNESS_OVERRIDE_SET']);
});

test('C8: a held lease answers 409 HARNESS_UPDATE_IN_PROGRESS with activeJobId', async () => {
  acquireHarnessLease('opencode', 'update-job-1');
  const res = await post('/api/providers/opencode/install', OWNER);
  assert.equal(res.status, 409);
  assert.equal(res.json.code, 'HARNESS_UPDATE_IN_PROGRESS');
  assert.equal(res.json.activeJobId, 'update-job-1');
});
