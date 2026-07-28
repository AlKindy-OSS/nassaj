/**
 * Route-level integration tests for the T-947 server-action catalog + inline run
 * (ADR-066). Exercises the REAL express router (server/routes/system.js) against
 * an isolated temp SQLite DB, with child_process.spawn MOCKED so no real
 * safe-restart ever runs. The gate spawn is faked to exit 3 ("live work"), i.e.
 * the deferred branch — the one execute outcome that fully exercises CAS claim +
 * audit + WS broadcast + in-flight release WITHOUT touching the real host.
 *
 * Coverage:
 *   - GET /actions catalog: 200, any authenticated role, NEVER leaks cmd/args/gateArgs.
 *   - POST /actions/:actionType/run: unknown type → 400 unknown_action (no row).
 *   - Per-action minRole: admin blocked on owner-only safe-restart → 403 on BOTH
 *     /run (pre-insert) and /pending/:id/execute (post-claim, row reset to pending).
 *   - roleSatisfies hierarchy incl. the admin-allowed-when-minRole=admin path.
 *   - Equivalence: /run and /pending/:id/execute produce the SAME ExecuteOutcome
 *     ('deferred'), the SAME WS broadcast, the SAME gate spawn, the SAME audit.
 *   - dedup: a repeated /run for the same (actionType, sessionId) REUSES the row.
 *   - CAS: execute on a non-claimable id → 409 not_claimable.
 *
 * Framework: node:test + module mocking (--experimental-test-module-mocks) via tsx.
 * Env (JWT_SECRET + temp DATABASE_PATH) and the spawn mock are registered BEFORE
 * any app module is imported (node:test mocks are not hoisted).
 */

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { after, mock } from 'node:test';

import express from 'express';
import * as realChildProcess from 'node:child_process';

// ── env: force auth.js down the JWT_SECRET path (no DB at module load) + temp DB.
process.env.JWT_SECRET = 'system-actions-test-secret-0123456789abcdef';
const tmpDir = await mkdtemp(path.join(tmpdir(), 'sys-actions-test-'));
process.env.DATABASE_PATH = path.join(tmpDir, 'db.sqlite');

// ── spawn mock: every spawn returns a fake child that behaves like the gate
// exiting 3 (live work → defer). The exec (detach --exec) path is never reached,
// so no real restart is ever spawned.
type SpawnCall = { cmd: string; args: string[] };
let spawnCalls: SpawnCall[] = [];

function fakeDeferredGateChild(): EventEmitter & {
  stdout: EventEmitter;
  stderr: EventEmitter;
  unref: () => void;
} {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    unref: () => void;
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.unref = () => {};
  process.nextTick(() => {
    child.stdout.emit('data', Buffer.from(JSON.stringify({ liveCount: 2 })));
    child.emit('close', 3);
  });
  return child;
}

const fakeSpawn = (cmd: string, args: string[]) => {
  spawnCalls.push({ cmd, args: [...args] });
  return fakeDeferredGateChild();
};

mock.module('child_process', {
  namedExports: { ...realChildProcess, spawn: fakeSpawn },
});

// ── import app modules AFTER env + mock are in place.
const { closeConnection, getConnection } = await import('@/modules/database/connection.js');
const { initializeDatabase } = await import('@/modules/database/init-db.js');
const { pendingServerActionsDb, auditLogDb } = await import('@/modules/database/index.js');
const { roleSatisfies } = await import('../../middleware/auth.js');
const { default: systemRouter } = await import('../system.js');

closeConnection();
await initializeDatabase();

// ── test express app: injectable req.user + a fake WS server to capture broadcasts.
type TestUser = { id: number; username: string; role: string };
const OWNER: TestUser = { id: 1, username: 'owner', role: 'owner' };
const ADMIN: TestUser = { id: 2, username: 'adm', role: 'admin' };
const USER: TestUser = { id: 3, username: 'usr', role: 'user' };

// Seed real user rows so audit_log's FK (user_id → users.id, foreign_keys=ON)
// is satisfied when a route records an outcome under req.user.id.
const seedUser = getConnection().prepare(
  'INSERT INTO users (id, username, password_hash, role) VALUES (?, ?, ?, ?)'
);
for (const u of [OWNER, ADMIN, USER]) {
  seedUser.run(u.id, u.username, 'x', u.role);
}

let currentUser: TestUser = OWNER;
let wsSent: string[] = [];

const app = express();
app.use(express.json());
app.locals.wss = {
  clients: new Set([{ readyState: 1, send: (m: string) => wsSent.push(m) }]),
};
app.use(
  '/api/system',
  (req, _res, next) => {
    (req as express.Request & { user: TestUser }).user = currentUser;
    next();
  },
  systemRouter
);

const server = app.listen(0);
await new Promise<void>((resolve) => server.once('listening', () => resolve()));
const port = (server.address() as { port: number }).port;
const base = `http://127.0.0.1:${port}`;

// Unique cf-connecting-ip per call → distinct rate-limit bucket (the immediate
// peer is loopback, so clientIp trusts cf-connecting-ip). Keeps the 5/min
// restart limiter from tripping across the suite.
let ipCounter = 0;
async function call(
  method: string,
  urlPath: string,
  opts: { user?: TestUser; body?: unknown } = {}
): Promise<{ status: number; json: () => Promise<any> }> {
  if (opts.user) currentUser = opts.user;
  ipCounter += 1;
  const res = await fetch(base + urlPath, {
    method,
    headers: {
      'content-type': 'application/json',
      'cf-connecting-ip': `10.${Math.floor(ipCounter / 250)}.0.${(ipCounter % 250) + 1}`,
    },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  return { status: res.status, json: () => res.json() };
}

const wsHadBroadcast = () =>
  wsSent.some((m) => {
    try {
      return JSON.parse(m).type === 'pending-actions-updated';
    } catch {
      return false;
    }
  });

const auditHasResult = (result: string) =>
  auditLogDb.recent(200).some((a) => {
    if (a.action !== 'system_restart_triggered' || !a.metadata) return false;
    try {
      return JSON.parse(a.metadata).result === result;
    } catch {
      return false;
    }
  });

after(async () => {
  server.close();
  closeConnection();
  await rm(tmpDir, { recursive: true, force: true });
});

// ── GET /actions catalog ──────────────────────────────────────────────────────

test('GET /actions returns the catalog to any authenticated role, no executable leak', async () => {
  const res = await call('GET', '/api/system/actions', { user: USER });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(Array.isArray(body.actions));

  const sr = body.actions.find((a: { actionType: string }) => a.actionType === 'safe-restart');
  assert.ok(sr, 'safe-restart must appear in the catalog');
  assert.equal(sr.minRole, 'owner');
  assert.ok(typeof sr.label === 'string' && sr.label.length > 0);
  assert.ok(typeof sr.commandPreview === 'string' && sr.commandPreview.length > 0);

  // SECURITY: the structured executable fields must never reach the wire.
  const keys = Object.keys(sr);
  for (const forbidden of ['cmd', 'args', 'argv', 'gateArgs', 'detachExec', 'cwd', 'description']) {
    assert.ok(!keys.includes(forbidden), `catalog must not expose "${forbidden}"`);
  }
  assert.deepEqual(
    keys.sort(),
    ['actionType', 'commandPreview', 'label', 'minRole'].sort()
  );
});

// ── roleSatisfies hierarchy (incl. the admin-allowed path) ────────────────────

test('roleSatisfies enforces owner>admin>user and fails closed', () => {
  assert.equal(roleSatisfies('owner', 'owner'), true);
  assert.equal(roleSatisfies('owner', 'admin'), true);
  assert.equal(roleSatisfies('owner', 'user'), true);
  // The "action minRole=admin" ALLOW path (no allowlisted action is admin-scoped
  // yet, so this is the unit-level proof that widening minRole would let admin in).
  assert.equal(roleSatisfies('admin', 'admin'), true);
  assert.equal(roleSatisfies('admin', 'user'), true);
  // admin is blocked on an owner-only action.
  assert.equal(roleSatisfies('admin', 'owner'), false);
  assert.equal(roleSatisfies('user', 'admin'), false);
  assert.equal(roleSatisfies('user', 'user'), true);
  // fail-closed: unknown/missing role or minRole → denied.
  assert.equal(roleSatisfies(undefined, 'user'), false);
  assert.equal(roleSatisfies('hacker', 'user'), false);
  assert.equal(roleSatisfies('owner', 'superadmin'), false);
});

// ── POST /actions/:actionType/run — unknown type ──────────────────────────────

test('POST /actions/:actionType/run rejects an unknown actionType with 400 (no row created)', async () => {
  const beforeCount = pendingServerActionsDb.countActionable();
  const res = await call('POST', '/api/system/actions/pm2-restart/run', { user: OWNER, body: {} });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).code, 'unknown_action');
  assert.equal(
    pendingServerActionsDb.countActionable(),
    beforeCount,
    'an unknown actionType must not enqueue anything'
  );
});

// ── Per-action minRole enforcement ────────────────────────────────────────────

test('POST /actions/safe-restart/run: admin is blocked on the owner-only action (403, no row)', async () => {
  const beforeCount = pendingServerActionsDb.countActionable();
  const res = await call('POST', '/api/system/actions/safe-restart/run', { user: ADMIN, body: {} });
  assert.equal(res.status, 403);
  assert.equal((await res.json()).code, 'insufficient_role');
  assert.equal(
    pendingServerActionsDb.countActionable(),
    beforeCount,
    'a refused run must not create a pending row'
  );
});

test('POST /pending/:id/execute: admin blocked on owner-only row → 403, row reset to pending, WS+audit', async () => {
  wsSent = [];
  spawnCalls = [];
  const id = crypto.randomUUID();
  pendingServerActionsDb.insert({ id, actionType: 'safe-restart', sessionId: 'exec-admin-403' });

  const res = await call('POST', `/api/system/pending/${id}/execute`, { user: ADMIN });
  assert.equal(res.status, 403);
  assert.equal((await res.json()).code, 'insufficient_role');

  // The row is valid — just not for this role — so it must return to pending
  // (retryable by an owner), never left 'executing' or 'failed'.
  assert.equal(pendingServerActionsDb.getById(id)!.status, 'pending');
  assert.ok(wsHadBroadcast(), 'a refusal after claim must broadcast the queue change');
  assert.ok(auditHasResult('insufficient_role'), 'the refusal must be audited');
  // No gate/exec was ever spawned for a role-refused action.
  assert.equal(spawnCalls.length, 0, 'no spawn for a role-refused execute');
});

// ── Equivalence: /pending/:id/execute vs /actions/:actionType/run ─────────────

test('POST /pending/:id/execute (owner): deferred outcome exercises CAS+gate+audit+WS', async () => {
  wsSent = [];
  spawnCalls = [];
  const id = crypto.randomUUID();
  pendingServerActionsDb.insert({ id, actionType: 'safe-restart', sessionId: 'equiv-exec' });

  const res = await call('POST', `/api/system/pending/${id}/execute`, { user: OWNER });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).status, 'deferred');

  // Gate ran read-only (--json), exec (--exec) never spawned.
  assert.ok(spawnCalls.some((c) => c.args.includes('--json')), 'the read-only gate must have run');
  assert.ok(!spawnCalls.some((c) => c.args.includes('--exec')), 'the --exec path must NOT run');
  // deferred → row back to pending; WS + audit recorded.
  assert.equal(pendingServerActionsDb.getById(id)!.status, 'pending');
  assert.ok(wsHadBroadcast());
  assert.ok(auditHasResult('deferred'));
});

test('POST /actions/safe-restart/run (owner): SAME deferred outcome as /pending/:id/execute', async () => {
  wsSent = [];
  spawnCalls = [];
  const res = await call('POST', '/api/system/actions/safe-restart/run', {
    user: OWNER,
    body: { sessionId: 'equiv-run', reason: 'deploy' },
  });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).status, 'deferred', 'run must yield the same ExecuteOutcome');

  // A row was created for equiv-run and returned to pending after the deferred gate.
  const row = pendingServerActionsDb.getPendingByDedup('safe-restart', 'equiv-run');
  assert.ok(row, 'run must have enqueued a row');
  assert.equal(row!.status, 'pending');
  // Identical downstream effects to the execute route.
  assert.ok(spawnCalls.some((c) => c.args.includes('--json')));
  assert.ok(!spawnCalls.some((c) => c.args.includes('--exec')));
  assert.ok(wsHadBroadcast());
  assert.ok(auditHasResult('deferred'));
  // Parity: a fresh run also records the request (like POST /pending).
  assert.ok(
    auditLogDb.recent(200).some((a) => a.action === 'server_action_requested'),
    'a fresh run must record server_action_requested'
  );
});

// ── dedup ─────────────────────────────────────────────────────────────────────

test('POST /actions/safe-restart/run dedups: a repeat for the same (type, session) reuses the row', async () => {
  // Seed a fresh pending row via run, then repeat with the same sessionId.
  await call('POST', '/api/system/actions/safe-restart/run', {
    user: OWNER,
    body: { sessionId: 'dedup-run' },
  });
  const first = pendingServerActionsDb.getPendingByDedup('safe-restart', 'dedup-run');
  assert.ok(first, 'first run must enqueue a row');

  const res = await call('POST', '/api/system/actions/safe-restart/run', {
    user: OWNER,
    body: { sessionId: 'dedup-run' },
  });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).status, 'deferred');

  const rowsForSession = pendingServerActionsDb
    .listActionable()
    .filter((r) => r.sessionId === 'dedup-run');
  assert.equal(rowsForSession.length, 1, 'a repeated run must not create a duplicate row');
  assert.equal(rowsForSession[0]!.id, first!.id, 'the repeat must reuse the original row id');
});

// ── CAS ───────────────────────────────────────────────────────────────────────

test('POST /pending/:id/execute on a non-claimable id → 409 not_claimable', async () => {
  const res = await call('POST', '/api/system/pending/does-not-exist-xyz/execute', { user: OWNER });
  assert.equal(res.status, 409);
  assert.equal((await res.json()).code, 'not_claimable');
});
