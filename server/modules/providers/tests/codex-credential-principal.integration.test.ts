// Fixture must initialize an empty DB before the router module graph can open a connection.
// eslint-disable-next-line import-x/order
import { database, principal } from './codex-credential-principal.fixture.js';

import assert from 'node:assert/strict';
import * as childProcess from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, beforeEach, mock, test } from 'node:test';
import type { AddressInfo } from 'node:net';

import express from 'express';

import { createCodexMachineFixture } from '@/shared/tests/codex-release-fixture.js';

import { emulateCodexCliLogin } from './codex-cli-login.fixture.js';

// ADR-200 S10 (B-1575): these cases target the legacy T-1201 key path, which the
// default-ON flag makes read-only; the flag-ON cases below lift the pin locally.
process.env.NASSAJ_UNIFIED_VENDOR_KEYS = '0';
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-login-home-'));
process.env.CODEX_HOME = home;
// B-1420 gives each case its own HOME with no operator CLI, so the machine
// resolver gets a synthetic release; spawn itself is mocked below.
process.env.CODEX_PATH = createCodexMachineFixture(path.join(home, 'codex-machine')).launcher;
const calls: Array<{ args: unknown; input: string }> = [];
// Only the OS spawn is replaced: actor, runtime gateway, adapter, and receipts are real.
mock.module('node:child_process', { namedExports: { ...childProcess, spawn: (_file: string, args: unknown, opts: unknown) => {
  const call = { args, input: '' }; calls.push(call);
  const child = new EventEmitter() as EventEmitter & { stdin: unknown };
  child.stdin = { write: (value: string) => { call.input += value; }, end() {} };
  // ADR-200 S3: the writer re-reads auth.json, so leave what the CLI writes.
  setImmediate(() => { emulateCodexCliLogin(opts, call.input); child.emit('close', 0, null); });
  return child;
} } });
const { CodexCredentialsWriter } = await import('../list/codex/codex-credentials.writer.js');
const { default: router } = await import('../provider.routes.js');
const app = express();
app.use(express.json());
// Canonical authentication seam is fixture-owned, never sourced from body fields.
app.use((req, _res, next) => {
  Object.assign(req, { user: req.headers['x-test-stale'] ? { ...principal, authorizationGeneration: 2 } : principal });
  next();
});
app.use('/api/providers', router);
app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  res.status(403).json({ error: 'rejected', code: (error as { code?: string } | null)?.code ?? null });
});
const server = app.listen(0);
await new Promise<void>(resolve => server.once('listening', resolve));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
const key = 'synthetic-codex-test-key';
const writer = new CodexCredentialsWriter();
beforeEach(() => { calls.length = 0; });
after(async () => {
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  fs.rmSync(home, { recursive: true, force: true });
});

/** Send a fixture request through the unchanged provider router and service. */
async function save(route: string, body: object, stale = false) {
  const response = await fetch(`${base}${route}`, { method: 'POST',
    headers: { 'content-type': 'application/json', ...(stale ? { 'x-test-stale': '1' } : {}) },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

for (const route of ['/api/providers/codex/api-key', '/api/providers/company/openai/key']) {
  test(`${route}: default writer reaches real gateway exactly once, bound to req.user`, async () => {
    const before = database.prepare('SELECT count(*) AS n FROM permission_launch_decisions').get() as { n: number };
    const result = await save(route, { apiKey: key, includeSubscription: true, vendorIds: ['openai'],
      userId: 999, authenticatedPrincipal: { id: 999, role: 'owner' } });
    assert.equal(result.status, 200);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].args, ['login', '--with-api-key']);
    assert.equal(calls[0].input, `${key}\n`);
    assert.equal(JSON.stringify(result.body).includes(key), false);
    const rows = database.prepare('SELECT user_id, principal_id, state, terminal_outcome FROM permission_launch_decisions').all();
    assert.equal(rows.length, before.n + 1);
    assert.deepEqual(rows.at(-1), { user_id: 1, principal_id: 'user:1', state: 'terminal', terminal_outcome: 'succeeded' });
  });
  test(`${route}: stale actor cannot launch despite forged current body`, async () => {
    const result = await save(route, { apiKey: key, includeSubscription: true, vendorIds: ['openai'], authenticatedPrincipal: principal }, true);
    assert.equal(calls.length, 0);
    if (route.includes('/company/')) assert.equal(result.body.data.configured, false);
    else assert.equal(result.status, 403);
  });
}

test('default writer rejects absent, stale and mismatched destination principals before spawn', async () => {
  const before = database.prepare('SELECT count(*) AS n FROM permission_launch_decisions').get();
  await assert.rejects(writer.setApiKey(1, key), /ACTOR_ID_INVALID/);
  await assert.rejects(writer.setApiKey(1, key, undefined, { ...principal, authorizationGeneration: 2 }), /authentication/);
  await assert.rejects(writer.setApiKey(999, key, undefined, principal), /authentication/);
  assert.equal(calls.length, 0);
  assert.deepEqual(database.prepare('SELECT count(*) AS n FROM permission_launch_decisions').get(), before);
});

test('an injected spawn is also subject to current-actor checks', async () => {
  let injected = 0;
  const injectedWriter = new CodexCredentialsWriter((() => { injected += 1; }) as never);
  await assert.rejects(injectedWriter.setApiKey(1, key), /ACTOR_ID_INVALID/);
  assert.equal(injected, 0);
});

/** Run one case with the unified vendor-key flag at its default (unset). */
async function withUnifiedDefault(run: () => Promise<void>) {
  delete process.env.NASSAJ_UNIFIED_VENDOR_KEYS;
  try { await run(); } finally { process.env.NASSAJ_UNIFIED_VENDOR_KEYS = '0'; }
}

test('ADR-200 S10: flag default ON makes the legacy Codex key route refuse before any launch', async () => {
  await withUnifiedDefault(async () => {
    const before = database.prepare('SELECT count(*) AS n FROM permission_launch_decisions').get();
    const result = await save('/api/providers/codex/api-key', { apiKey: key });
    assert.equal(result.status, 403);
    assert.equal(result.body.code, 'LEGACY_KEY_ROUTE_READ_ONLY');
    assert.equal(calls.length, 0);
    assert.deepEqual(database.prepare('SELECT count(*) AS n FROM permission_launch_decisions').get(), before);
  });
});

test('ADR-200 S10: flag default ON stores the company OpenAI key without projecting into an unset tree', async () => {
  await withUnifiedDefault(async () => {
    const result = await save('/api/providers/company/openai/key', { apiKey: key, includeSubscription: true, vendorIds: ['openai'] });
    assert.equal(result.status, 200);
    assert.equal(calls.length, 0);
    assert.deepEqual(result.body.data.slots.map((slot: { outcome: string }) => slot.outcome), ['shared_scope_refused']);
    assert.equal(JSON.stringify(result.body).includes(key), false);
  });
});
