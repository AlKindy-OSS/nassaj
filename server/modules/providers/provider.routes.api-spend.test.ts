/**
 * ADR-214 / T-2066 — HTTP contract of the Anthropic API spend routes.
 *
 * Drives the REAL provider router, the REAL spend service and the REAL
 * encrypted secrets store in a sandboxed HOME. Only the upstream is faked: the
 * service's `getSpend` is wrapped to inject `fetchImpl` (the permission lease
 * is covered by the last case, which runs the unwrapped path).
 *
 * Pinned: member B never sees member A's key status or spend; the key never
 * appears in any response body or audit row; invalid key shapes answer 400;
 * upstream failures answer 502 with an explicit code; DELETE drops the cache.
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after, before, beforeEach } from 'node:test';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

import express from 'express';

import { closeConnection, getConnection, initializeDatabase, userDb } from '@/modules/database/index.js';
import { anthropicApiSpendService } from '@/modules/providers/services/usage/anthropic-api-spend.service.js';
import { _resetProviderSecretsServerKeyCache } from '@/services/isolation/provider-secrets-store.js';
import { AppError } from '@/shared/utils.js';

import providerRouter from './provider.routes.js';

type TestUser = { id: number; role: string };

const KEY_A = 'sk-ant-admin01-' + 'RouteTestMemberA_key-0001';
const COST_BODY = { data: [{ results: [{ amount: '1234.5', currency: 'USD' }] }], has_more: false };

let currentUser: TestUser | null = null;
let server: Server;
let baseUrl = '';
let dbDir = '';
let sandboxHome = '';
let originalHome: string | undefined;
let memberA: TestUser;
let memberB: TestUser;

const originalGetSpend = anthropicApiSpendService.getSpend;
const nativeFetch = globalThis.fetch;
let upstream: { calls: number; status: number } = { calls: 0, status: 200 };

const fakeUpstream = (async () => {
  upstream.calls += 1;
  return new Response(JSON.stringify(COST_BODY), { status: upstream.status });
}) as unknown as typeof fetch;

async function call(
  method: string,
  urlPath: string,
  user: TestUser | null,
  body?: unknown,
): Promise<{ status: number; text: string; json: Record<string, unknown> }> {
  currentUser = user;
  const response = await nativeFetch(`${baseUrl}${urlPath}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  return { status: response.status, text, json: text ? JSON.parse(text) : {} };
}

before(async () => {
  closeConnection();
  dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nassaj-api-spend-db-'));
  sandboxHome = fs.mkdtempSync(path.join(os.tmpdir(), 'nassaj-api-spend-home-'));
  originalHome = process.env.HOME;
  process.env.HOME = sandboxHome;
  process.env.DATABASE_PATH = path.join(dbDir, 'db.sqlite');
  process.env.NASSAJ_PROVIDER_SECRETS_KEY = crypto.randomBytes(32).toString('base64');
  _resetProviderSecretsServerKeyCache();
  await initializeDatabase();

  memberA = userDb.createUser('spend_a', 'hash', 'user') as TestUser;
  memberB = userDb.createUser('spend_b', 'hash', 'user') as TestUser;

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { user: TestUser | null }).user = currentUser;
    next();
  });
  app.use('/api/providers', providerRouter);
  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (err instanceof AppError) {
      res.status(err.statusCode).json({ error: err.message, code: err.code });
      return;
    }
    res.status(500).json({ code: 'INTERNAL_ERROR' });
  });
  server = app.listen(0);
  await new Promise(resolve => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

beforeEach(() => {
  anthropicApiSpendService.__resetCache();
  upstream = { calls: 0, status: 200 };
  anthropicApiSpendService.getSpend = (userId, _deps) =>
    originalGetSpend.call(anthropicApiSpendService, userId, { fetchImpl: fakeUpstream });
});

after(async () => {
  anthropicApiSpendService.getSpend = originalGetSpend;
  globalThis.fetch = nativeFetch;
  await new Promise(resolve => server.close(resolve));
  closeConnection();
  delete process.env.DATABASE_PATH;
  delete process.env.NASSAJ_PROVIDER_SECRETS_KEY;
  _resetProviderSecretsServerKeyCache();
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  fs.rmSync(dbDir, { recursive: true, force: true });
  fs.rmSync(sandboxHome, { recursive: true, force: true });
});

test('no key → 404 NO_SPEND_SOURCE and configured:false', async () => {
  const spend = await call('GET', '/api/providers/claude/api-spend', memberA);
  assert.equal(spend.status, 404);
  assert.equal(spend.json.code, 'NO_SPEND_SOURCE');
  const status = await call('GET', '/api/providers/claude/api-spend/key', memberA);
  assert.deepEqual(status.json, { configured: false });
  assert.equal(upstream.calls, 0);
});

test('invalid key shapes → 400 INVALID_ADMIN_KEY, nothing stored', async () => {
  for (const key of ['sk-ant-api03-abcdefgh', 'sk-ant-oat01-abcdefgh', `${KEY_A} x`, `${KEY_A}\n`, 7]) {
    const response = await call('PUT', '/api/providers/claude/api-spend/key', memberB, { key });
    if (key === `${KEY_A}\n`) {
      // Surrounding whitespace is trimmed (paste accident); clean it up again.
      assert.equal(response.status, 200);
      await call('DELETE', '/api/providers/claude/api-spend/key', memberB);
      continue;
    }
    assert.equal(response.status, 400, String(key));
    assert.equal(response.json.code, 'INVALID_ADMIN_KEY');
    assert.match(String(response.json.error), /Admin key/);
  }
  const status = await call('GET', '/api/providers/claude/api-spend/key', memberB);
  assert.deepEqual(status.json, { configured: false });
});

test('member A sets a key and reads spend; member B sees neither', async () => {
  const put = await call('PUT', '/api/providers/claude/api-spend/key', memberA, { key: KEY_A });
  assert.equal(put.status, 200);
  assert.deepEqual(put.json, { configured: true });
  assert.ok(!put.text.includes(KEY_A));

  const spend = await call('GET', '/api/providers/claude/api-spend', memberA);
  assert.equal(spend.status, 200);
  assert.equal(spend.json.spendCents, 1235);
  assert.equal(spend.json.currency, 'USD');
  assert.equal(spend.json.hasData, true);
  assert.equal(spend.json.excludesPriorityTier, true);
  assert.equal(spend.json.periodEnd, spend.json.observedAt);
  assert.deepEqual(Object.keys(spend.json).sort(), [
    'currency', 'excludesPriorityTier', 'hasData', 'observedAt', 'periodEnd', 'periodStart', 'spendCents',
  ]);
  assert.ok(!spend.text.includes(KEY_A));

  const statusB = await call('GET', '/api/providers/claude/api-spend/key', memberB);
  assert.deepEqual(statusB.json, { configured: false });
  const spendB = await call('GET', '/api/providers/claude/api-spend', memberB);
  assert.equal(spendB.status, 404);
  assert.equal(spendB.json.code, 'NO_SPEND_SOURCE');
  assert.equal(upstream.calls, 1, 'B never triggered a read with A\'s key');

  const rows = getConnection()
    .prepare("SELECT action, metadata, user_id FROM audit_log WHERE action LIKE 'anthropic_admin_key_%'")
    .all() as Array<{ action: string; metadata: string; user_id: number }>;
  assert.ok(rows.some(row => row.action === 'anthropic_admin_key_set' && row.user_id === memberA.id));
  assert.ok(rows.every(row => !String(row.metadata).includes('sk-ant')));
});

test('upstream 401 → 502 API_SPEND_AUTH; 500 → 502 API_SPEND_UNAVAILABLE', async () => {
  upstream.status = 401;
  const auth = await call('GET', '/api/providers/claude/api-spend', memberA);
  assert.equal(auth.status, 502);
  assert.equal(auth.json.code, 'API_SPEND_AUTH');

  anthropicApiSpendService.__resetCache();
  upstream.status = 500;
  const down = await call('GET', '/api/providers/claude/api-spend', memberA);
  assert.equal(down.status, 502);
  assert.equal(down.json.code, 'API_SPEND_UNAVAILABLE');
  assert.ok(!down.text.includes(KEY_A));
});

test('DELETE removes the key and invalidates the cache', async () => {
  await call('PUT', '/api/providers/claude/api-spend/key', memberA, { key: KEY_A });
  await call('GET', '/api/providers/claude/api-spend', memberA);
  assert.equal(upstream.calls, 1);

  const removed = await call('DELETE', '/api/providers/claude/api-spend/key', memberA);
  assert.deepEqual(removed.json, { configured: false });
  const after = await call('GET', '/api/providers/claude/api-spend', memberA);
  assert.equal(after.status, 404);

  await call('PUT', '/api/providers/claude/api-spend/key', memberA, { key: KEY_A });
  await call('GET', '/api/providers/claude/api-spend', memberA);
  assert.equal(upstream.calls, 2, 'the cached spend did not survive the key removal');

  const rows = getConnection()
    .prepare("SELECT metadata FROM audit_log WHERE action = 'anthropic_admin_key_removed'")
    .all() as Array<{ metadata: string }>;
  assert.ok(rows.length >= 1);
  assert.ok(rows.every(row => !String(row.metadata).includes('sk-ant')));
});

test('unauthenticated → 401', async () => {
  const response = await call('GET', '/api/providers/claude/api-spend/key', null);
  assert.equal(response.status, 401);
});

test('a refused permission lease answers 502 and never reaches upstream', async () => {
  await call('PUT', '/api/providers/claude/api-spend/key', memberA, { key: KEY_A });
  anthropicApiSpendService.getSpend = originalGetSpend;
  let anthropicCalls = 0;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url).startsWith('https://api.anthropic.com')) {
      anthropicCalls += 1;
      return new Response(JSON.stringify(COST_BODY));
    }
    return nativeFetch(url, init);
  }) as typeof fetch;
  try {
    // The bare test principal carries no authentication facts, so the gateway refuses.
    const response = await call('GET', '/api/providers/claude/api-spend', memberA);
    assert.equal(response.status, 502);
    assert.equal(response.json.code, 'API_SPEND_UNAVAILABLE');
    assert.equal(anthropicCalls, 0);
  } finally {
    globalThis.fetch = nativeFetch;
  }
});

test('a key-store failure answers a coded 503 on GET /key and GET /api-spend', async () => {
  anthropicApiSpendService.__setKeyReader(() => { throw new Error('store broken'); });
  try {
    for (const urlPath of ['/api/providers/claude/api-spend/key', '/api/providers/claude/api-spend']) {
      const response = await call('GET', urlPath, memberA);
      assert.equal(response.status, 503, urlPath);
      assert.equal(response.json.code, 'ADMIN_KEY_STORE_UNAVAILABLE');
      assert.ok(!response.text.includes('store broken'));
    }
  } finally {
    anthropicApiSpendService.__setKeyReader(null);
  }
});

test('PUT/DELETE key are rate limited: the 11th change in a minute answers 429', async () => {
  const limited = userDb.createUser('spend_limited', 'hash', 'user') as TestUser;
  const statuses: number[] = [];
  for (let index = 0; index < 11; index += 1) {
    const response = index % 2 === 0
      ? await call('PUT', '/api/providers/claude/api-spend/key', limited, { key: KEY_A })
      : await call('DELETE', '/api/providers/claude/api-spend/key', limited);
    statuses.push(response.status);
    if (index === 10) assert.equal(response.json.code, 'ADMIN_KEY_RATE_LIMITED');
  }
  assert.deepEqual(statuses.slice(0, 10), Array(10).fill(200));
  assert.equal(statuses[10], 429);
  // Reads are not throttled by the write limiter.
  assert.equal((await call('GET', '/api/providers/claude/api-spend/key', limited)).status, 200);
});
