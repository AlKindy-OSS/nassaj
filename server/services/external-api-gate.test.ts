/**
 * external-api-gate.test.ts — ADR-102 / T-1242.
 *
 * `POST /api/agent` is the largest blast radius in the app: it runs an agent
 * with `permissionMode:'bypassPermissions'`, spawns git, and can push branches
 * and open pull requests. It is now closed unless the owner opens it from
 * Settings. Two properties make that gate worth anything, and both are pinned
 * here.
 *
 *  1. FAIL-CLOSED (behavioural). Absent, '0', or any value that is not exactly
 *     '1' means closed — including the near-misses an operator would plausibly
 *     type by hand ('true', 'yes', ' 1'). A gate that opens when its own
 *     storage is unreadable or unexpected is not a gate. Asserted against a
 *     real migrated SQLite database, through the real middleware, over HTTP.
 *
 *  2. ORDER (structural). The gate must run BEFORE `validateExternalApiKey`,
 *     whose first branch (`IS_PLATFORM`) authenticates a request as the first
 *     user WITHOUT inspecting any credential — a gate placed after it would
 *     leave exactly that path ungated.
 *
 * Why (2) is asserted on the source text and not by driving the real router:
 * importing `server/routes/agent.js` pulls in the provider stack, which leaves
 * a timer on the event loop and hangs the whole `test:server` run (measured,
 * 2026-08-04). So the ordering is checked where it is actually expressed — the
 * route registration — and it is a STRUCTURAL guard, not proof of behaviour.
 * The behaviour of the gate itself is covered end-to-end by (1).
 *
 * Runner: node:test via tsx.
 */

import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, test } from 'node:test';

import express from 'express';

import { closeConnection } from '@/modules/database/connection.js';
import { initializeDatabase } from '@/modules/database/init-db.js';
import { stopReconcileScheduler } from '@/modules/database/project-reconcile.service.js';
import { appConfigDb } from '@/modules/database/index.js';
import {
  EXTERNAL_API_ENABLED_KEY,
  isExternalApiEnabled,
  requireExternalApiEnabled,
  setExternalApiEnabled,
} from '@/services/external-api-config.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const AGENT_ROUTE_FILE = path.join(HERE, '..', 'routes', 'agent.js');

let server: ReturnType<express.Express['listen']>;
let baseUrl = '';
let tempDirectory = '';
const previousDatabasePath = process.env.DATABASE_PATH;

before(async () => {
  tempDirectory = await mkdtemp(path.join(tmpdir(), 'external-api-gate-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
  await initializeDatabase();
  stopReconcileScheduler();

  // The gate in front of a stand-in for the agent handler. Reaching the
  // handler (200 'open') is what "the gate let the request through" means.
  const app = express();
  app.post('/api/agent', requireExternalApiEnabled, (_req, res) => {
    res.json({ reached: true });
  });

  server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  closeConnection();
  if (previousDatabasePath === undefined) {
    delete process.env.DATABASE_PATH;
  } else {
    process.env.DATABASE_PATH = previousDatabasePath;
  }
  if (tempDirectory) {
    await rm(tempDirectory, { recursive: true, force: true });
  }
});

const postAgent = () => fetch(`${baseUrl}/api/agent`, { method: 'POST' });

test('closed by default: no row in app_config ⇒ 404', async () => {
  assert.equal(isExternalApiEnabled(), false);

  const response = await postAgent();
  assert.equal(response.status, 404);
  // 404 body, not a "forbidden"/"disabled" message: a closed surface must be
  // indistinguishable from a route that was never mounted.
  assert.deepEqual(await response.json(), { error: 'Not found' });
});

test('explicit off ⇒ 404', async () => {
  setExternalApiEnabled(false);
  assert.equal(isExternalApiEnabled(), false);
  assert.equal((await postAgent()).status, 404);
});

test('only the exact string "1" opens the gate', async () => {
  for (const value of ['true', 'yes', 'on', 'enabled', '2', '', ' 1', '1 ']) {
    appConfigDb.set(EXTERNAL_API_ENABLED_KEY, value);
    assert.equal(
      isExternalApiEnabled(),
      false,
      `value ${JSON.stringify(value)} must not be read as enabled`
    );
    assert.equal(
      (await postAgent()).status,
      404,
      `value ${JSON.stringify(value)} must stay closed`
    );
  }
});

test('enabled ⇒ the request reaches the handler', async () => {
  setExternalApiEnabled(true);
  assert.equal(isExternalApiEnabled(), true);

  const response = await postAgent();
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { reached: true });
});

test('re-disabling closes it again (the switch is not one-way)', async () => {
  setExternalApiEnabled(true);
  assert.equal((await postAgent()).status, 200);

  setExternalApiEnabled(false);
  assert.equal((await postAgent()).status, 404);
});

test('structural: the gate is registered before the API-key middleware', async () => {
  const source = await readFile(AGENT_ROUTE_FILE, 'utf8');

  const registration = /router\.post\(\s*'\/'\s*,([^)]*?)async\s*\(req, res\)/s.exec(source);
  assert.ok(registration, 'could not locate the POST / route registration in agent.js');

  const middlewareChain = registration[1];
  const gateIndex = middlewareChain.indexOf('requireExternalApiEnabled');
  const authIndex = middlewareChain.indexOf('validateExternalApiKey');

  assert.notEqual(gateIndex, -1, 'requireExternalApiEnabled is not registered on POST /api/agent');
  assert.notEqual(authIndex, -1, 'validateExternalApiKey is not registered on POST /api/agent');
  assert.ok(
    gateIndex < authIndex,
    'requireExternalApiEnabled must precede validateExternalApiKey: the latter authenticates '
      + 'without a credential in IS_PLATFORM mode, so a gate behind it does not gate that path'
  );
});
