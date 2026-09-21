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
import * as realChildProcess from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { after, mock } from 'node:test';

import express from 'express';

// ── env: force auth.js down the JWT_SECRET path (no DB at module load) + temp DB.
process.env.JWT_SECRET = 'system-actions-test-secret-0123456789abcdef';
const tmpDir = await mkdtemp(path.join(tmpdir(), 'sys-actions-test-'));
process.env.DATABASE_PATH = path.join(tmpDir, 'db.sqlite');

// ── spawn mock: every spawn returns a fake child that behaves like the gate
// exiting 3 (live work → defer). The exec (detach --exec) path is never reached,
// so no real restart is ever spawned.
type SpawnCall = { cmd: string; args: string[] };
let spawnCalls: SpawnCall[] = [];
let oidExitCode = 6;
let beforeOidExit: (() => void) | null = null;

function createSealedLocalPreviewRoot(fs: Pick<typeof import('node:fs'), 'mkdirSync' | 'statSync'>, root: string) {
  const previewRoot = path.join(root, '.nassaj-local-preview');
  fs.mkdirSync(previewRoot, { mode: 0o700 });
  // verifyOidDependencyCandidate requires this ancestor to stay non-writable by group or other.
  assert.equal(fs.statSync(previewRoot).mode & 0o022, 0, 'local preview root must remain sealed');
  return previewRoot;
}

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

const originalSpawn = realChildProcess.spawn;
const fakeSpawn = (cmd: string, args: string[], options?: any) => {
  if (cmd === 'flock') return originalSpawn(cmd, args, options);
  spawnCalls.push({ cmd, args: [...args] });
  if (cmd === process.execPath && args[0]?.endsWith('/dist-server/scripts/preview-oid-capsule-launcher.mjs')) {
    const child = fakeDeferredGateChild();
    process.nextTick(() => { beforeOidExit?.(); child.emit('exit', oidExitCode); });
    return child;
  }
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
let localFixtureRoot: string | null = null;
const actualLocalControl = await import('../../services/local-preview-server-control.js');
mock.module('../../services/local-preview-server-control.js', { namedExports: { ...actualLocalControl,
  inspectLocalUpdateAction: (row: any) => actualLocalControl.inspectLocalUpdateAction(row, localFixtureRoot || undefined),
} });
// Forward to the real disk validators; only the project root is isolated.
const actualCapsule = await import('../../../scripts/oid-control-capsule.mjs');
mock.module('../../../scripts/oid-control-capsule.mjs', { namedExports: { ...actualCapsule,
  validateOidPairTerminal: (root: string, value: any) => actualCapsule.validateOidPairTerminal(localFixtureRoot || root, value),
  readOidPairServingReceipt: (root: string, value: any) => actualCapsule.readOidPairServingReceipt(localFixtureRoot || root, value),
  reconcileOidPairServingReceipt: (root: string, value: any) => actualCapsule.reconcileOidPairServingReceipt(localFixtureRoot || root, value),
} });
const actualMaintenance = await import('../../services/update-maintenance-gate.js');
mock.module('../../services/update-maintenance-gate.js', { namedExports: { ...actualMaintenance,
  readUpdateMaintenanceRecoveryEvidence: (options: any) => actualMaintenance.readUpdateMaintenanceRecoveryEvidence({ ...options,
    projectPath: localFixtureRoot || options.projectPath }),
  createUpdateMaintenanceGate: (options: any) => actualMaintenance.createUpdateMaintenanceGate({ ...options,
    projectPath: localFixtureRoot || options.projectPath }),
} });
const {
  default: systemRouter, executeActionRowAs, runQueueMaintenance, setQueueMaintenanceClockForTests,
  setServerCandidateInspectorForTests, setOidReceiptReaderForTests, readOidTransactionReceipts,
} = await import('../system.js');

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
    ['actionType', 'commandPreview', 'label', 'minRole', 'requiresConfirmation'].sort()
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

test('POST /actions/safe-restart/run rejects malformed expectedServerBuildId before enqueue', async () => {
  const beforeCount = pendingServerActionsDb.countActionable();
  const res = await call('POST', '/api/system/actions/safe-restart/run', {
    user: OWNER, body: { expectedServerBuildId: 'not-a-sha256' },
  });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).code, 'invalid_action');
  assert.equal(pendingServerActionsDb.countActionable(), beforeCount);
});

test('direct safe-restart can never fall back to an unbound action when caller changes reason', async () => {
  const beforeCount = pendingServerActionsDb.countActionable();
  const res = await call('POST', '/api/system/actions/safe-restart/run', {
    user: OWNER, body: { reason: 'caller-controlled-different-reason' },
  });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).code, 'expected_server_build_id_required');
  assert.equal(pendingServerActionsDb.countActionable(), beforeCount);
  assert.equal(spawnCalls.length, 0);
});

test('POST /pending rejects an unbound safe-restart regardless of caller-controlled reason', async () => {
  const beforeCount = pendingServerActionsDb.countActionable();
  const res = await call('POST', '/api/system/pending', {
    user: OWNER,
    body: { actionType: 'safe-restart', reason: 'arbitrary-not-the-banner', sessionId: 'pending-bypass' },
  });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).code, 'expected_server_build_id_required');
  assert.equal(pendingServerActionsDb.countActionable(), beforeCount);
  assert.equal(spawnCalls.length, 0);
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

test('POST /pending/:id/execute permanently rejects a legacy unbound safe-restart row', async () => {
  wsSent = [];
  spawnCalls = [];
  const id = crypto.randomUUID();
  pendingServerActionsDb.insert({ id, actionType: 'safe-restart', sessionId: 'equiv-exec' });

  const res = await call('POST', `/api/system/pending/${id}/execute`, { user: OWNER });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).code, 'expected_server_build_id_required');
  assert.equal(spawnCalls.length, 0, 'legacy unbound rows never reach a gate or executable path');
  assert.equal(pendingServerActionsDb.getById(id)!.status, 'superseded');
  assert.ok(wsHadBroadcast());
  assert.ok(auditHasResult('gate_failed'));
});

test('POST /actions/safe-restart/run (owner): unbound legacy invocation is rejected', async () => {
  wsSent = [];
  spawnCalls = [];
  const res = await call('POST', '/api/system/actions/safe-restart/run', {
    user: OWNER,
    body: { sessionId: 'equiv-run', reason: 'deploy' },
  });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).code, 'expected_server_build_id_required');
  assert.equal(pendingServerActionsDb.getPendingByDedup('safe-restart', 'equiv-run'), null);
  assert.equal(spawnCalls.length, 0);
});

// ── dedup ─────────────────────────────────────────────────────────────────────

test('POST /actions/safe-restart/run rejects repeated unbound requests without dedup side effects', async () => {
  const res = await call('POST', '/api/system/actions/safe-restart/run', {
    user: OWNER,
    body: { sessionId: 'dedup-run', reason: 'not-the-banner' },
  });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).code, 'expected_server_build_id_required');

  const rowsForSession = pendingServerActionsDb
    .listActionable()
    .filter((r) => r.sessionId === 'dedup-run');
  assert.equal(rowsForSession.length, 0, 'an unbound run must never create a row');
});

// ── CAS ───────────────────────────────────────────────────────────────────────

test('POST /pending/:id/execute on a non-claimable id → 409 not_claimable', async () => {
  const res = await call('POST', '/api/system/pending/does-not-exist-xyz/execute', { user: OWNER });
  assert.equal(res.status, 409);
  assert.equal((await res.json()).code, 'not_claimable');
});

test('POST /pending/:id/execute reports a permanently superseded server generation', async () => {
  const id = crypto.randomUUID();
  pendingServerActionsDb.insert({
    id, actionType: 'safe-restart', expectedServerBuildId: 'a'.repeat(64),
  });
  pendingServerActionsDb.markSuperseded(id);
  const res = await call('POST', `/api/system/pending/${id}/execute`, { user: OWNER });
  assert.equal(res.status, 409);
  assert.equal((await res.json()).code, 'superseded');
  assert.equal(pendingServerActionsDb.getById(id)?.status, 'superseded');
});

function receiptFor(actionId: string, state: string, extras: Record<string, unknown> = {}) {
  const row = pendingServerActionsDb.getById(actionId);
  return { schema: 'nassaj-oid-control-transaction/v1', actionId, state, sequence: 41,
    oid: 'a'.repeat(40), bootNonce: 'b'.repeat(64), newPid: 1234, newStartTicks: '9876',
    buildId: row?.expectedServerBuildId, transactionNonce: row?.executionAttemptNonce, ...extras };
}

for (const activationKind of ['oid', 'oid-pair']) test(`request-only ${activationKind} cannot create or execute an activation`, async () => {
  const buildId = 'b'.repeat(64); spawnCalls = [];
  setServerCandidateInspectorForTests(() => ({ allowed: true, code: 'oid_candidate', activationKind, expectedServerBuildId: buildId }));
  try {
    const id = crypto.randomUUID();
    pendingServerActionsDb.insert({ id, actionType: 'safe-restart', expectedServerBuildId: buildId });
    const response = await call('POST', `/api/system/pending/${id}/execute`, { user: OWNER });
    assert.equal(response.status, 422); assert.equal((await response.json()).code, 'node_update_button_required');
    assert.equal(spawnCalls.length, 0); assert.equal(pendingServerActionsDb.getById(id)?.status, 'failed');
    for (const endpoint of ['/api/system/pending', '/api/system/actions/safe-restart/run']) {
      const queued = await call('POST', endpoint, { user: OWNER, body: { actionType: 'safe-restart', sessionId: crypto.randomUUID(), expectedServerBuildId: buildId } });
      assert.equal(queued.status, 422); assert.equal((await queued.json()).code, 'node_update_button_required');
    }
  } finally { setServerCandidateInspectorForTests(null); }
});

test('terminal OID receipts reconcile on later queue reads, not only the first GET', async () => {
  const id = crypto.randomUUID();
  pendingServerActionsDb.insert({
    id, actionType: 'safe-restart', expectedServerBuildId: 'e'.repeat(64),
  });
  pendingServerActionsDb.claimForExecution(id);
  setOidReceiptReaderForTests(() => []);
  await call('GET', '/api/system/pending', { user: OWNER });
  pendingServerActionsDb.claimForExecution(id);
  setOidReceiptReaderForTests(() => [receiptFor(id, 'loaded')]);
  try {
    await call('GET', '/api/system/pending', { user: OWNER });
    assert.equal(pendingServerActionsDb.getById(id)?.status, 'succeeded');
    assert.equal(pendingServerActionsDb.getById(id)?.error, 'oid_loaded');

    const rolledBackId = crypto.randomUUID();
    pendingServerActionsDb.insert({
      id: rolledBackId, actionType: 'safe-restart', expectedServerBuildId: 'd'.repeat(64),
    });
    pendingServerActionsDb.claimForExecution(rolledBackId);
    setOidReceiptReaderForTests(() => [receiptFor(rolledBackId, 'rolled_back')]);
    await call('GET', '/api/system/pending', { user: OWNER });
    assert.equal(pendingServerActionsDb.getById(rolledBackId)?.status, 'superseded');
    assert.equal(pendingServerActionsDb.getById(rolledBackId)?.error, 'oid_rolled_back');
  } finally { setOidReceiptReaderForTests(null); }
});

for (const receipts of [
  [
    { sequence: 41, state: 'restart_deferred_restored' },
    { sequence: 41, state: 'loaded' },
  ],
  [
    { sequence: 41, state: 'loaded' },
    { sequence: 41, state: 'restart_deferred_restored' },
  ],
]) {
  test(`OID receipt reconciliation cannot resurrect loaded action (${receipts[0].state} first)`, async () => {
    const id = crypto.randomUUID();
    pendingServerActionsDb.insert({
      id, actionType: 'safe-restart', expectedServerBuildId: '1'.repeat(64),
    });
    pendingServerActionsDb.claimForExecution(id);
    setOidReceiptReaderForTests(() => receipts.map((receipt) => receiptFor(id, receipt.state, receipt)));
    try {
      await call('GET', '/api/system/pending', { user: OWNER });
      assert.equal(pendingServerActionsDb.getById(id)?.status, 'succeeded');
      assert.equal(pendingServerActionsDb.getById(id)?.error, 'oid_loaded');

      // A later maintenance pass sees the same pair and remains idempotent.
      await call('GET', '/api/system/pending', { user: OWNER });
      assert.equal(pendingServerActionsDb.getById(id)?.status, 'succeeded');
      assert.equal(pendingServerActionsDb.getById(id)?.error, 'oid_loaded');
    } finally { setOidReceiptReaderForTests(null); }
  });
}

test('deferred OID receipt does not downgrade a failed database row to pending', async () => {
  const id = crypto.randomUUID();
  pendingServerActionsDb.insert({
    id, actionType: 'safe-restart', expectedServerBuildId: '2'.repeat(64),
  });
  pendingServerActionsDb.markFailed(id, 'oid_manual_recovery_required');
  setOidReceiptReaderForTests(() => [{
    actionId: id, sequence: 42, state: 'restart_deferred_restored',
  }]);
  try {
    await call('GET', '/api/system/pending', { user: OWNER });
    assert.equal(pendingServerActionsDb.getById(id)?.status, 'failed');
    assert.equal(pendingServerActionsDb.getById(id)?.error, 'oid_manual_recovery_required');
  } finally { setOidReceiptReaderForTests(null); }
});

test('queue maintenance preserves an unresolved restart beyond the stale horizon', () => {
  let now = 1_000_000;
  setQueueMaintenanceClockForTests(() => now);
  const id = crypto.randomUUID();
  try {
    pendingServerActionsDb.insert({
      id, actionType: 'safe-restart', expectedServerBuildId: 'f'.repeat(64),
    });
    pendingServerActionsDb.claimForExecution(id);

    // The first pass sees a fresh execution and must leave it alone.
    runQueueMaintenance();
    assert.equal(pendingServerActionsDb.getById(id)?.status, 'executing');

    // It becomes stale after that first pass. A request inside the one-minute
    // cadence stays cheap, while the next bounded pass recovers the orphan.
    getConnection().prepare(
      "UPDATE pending_server_actions SET executed_at = datetime('now', '-31 minutes') WHERE id = ?"
    ).run(id);
    now += 30_000;
    runQueueMaintenance();
    assert.equal(pendingServerActionsDb.getById(id)?.status, 'executing');
    now += 30_000;
    runQueueMaintenance();
    assert.equal(pendingServerActionsDb.getById(id)?.status, 'executing');
  } finally {
    pendingServerActionsDb.deleteById(id);
    setQueueMaintenanceClockForTests(null);
  }
});

test('queue maintenance does not stall when its injected clock moves backwards', () => {
  let now = 2_000_000;
  setQueueMaintenanceClockForTests(() => now);
  const id = crypto.randomUUID();
  try {
    pendingServerActionsDb.insert({
      id, actionType: 'custom-test', expectedServerBuildId: 'a'.repeat(64),
    });
    pendingServerActionsDb.claimForExecution(id);
    runQueueMaintenance();
    assert.equal(pendingServerActionsDb.getById(id)?.status, 'executing');

    getConnection().prepare(
      "UPDATE pending_server_actions SET executed_at = datetime('now', '-31 minutes') WHERE id = ?"
    ).run(id);
    now -= 1;
    runQueueMaintenance();
    // T-1684: an abandoned execution settles as unresolved history, never back
    // to 'pending' — the janitor must not be able to raise the yellow badge.
    assert.equal(pendingServerActionsDb.getById(id)?.status, 'failed');
    assert.equal(pendingServerActionsDb.getById(id)?.error, 'execution_unresolved');
  } finally {
    pendingServerActionsDb.deleteById(id);
    setQueueMaintenanceClockForTests(null);
  }
});

test('receipt reconciliation rejects old-attempt, wrong-build and legacy-null evidence before accepting exact proof', async () => {
  const id = crypto.randomUUID();
  const build = 'a'.repeat(64);
  pendingServerActionsDb.insert({ id, actionType: 'safe-restart', expectedServerBuildId: build });
  pendingServerActionsDb.claimForExecution(id);
  const old = receiptFor(id, 'loaded');
  const nonce = pendingServerActionsDb.getById(id)!.executionAttemptNonce!;
  pendingServerActionsDb.settleExecution(id, nonce, build, 'pending', 'live_work');
  pendingServerActionsDb.claimForExecution(id);
  setOidReceiptReaderForTests(() => [old, receiptFor(id, 'loaded', { buildId: 'b'.repeat(64) })]);
  try {
    await call('GET', '/api/system/pending', { user: OWNER });
    assert.equal(pendingServerActionsDb.getById(id)?.status, 'executing');
    const exact = receiptFor(id, 'loaded');
    setOidReceiptReaderForTests(() => [old, exact]);
    await call('GET', '/api/system/pending', { user: OWNER });
    assert.equal(pendingServerActionsDb.getById(id)?.error, 'oid_loaded');
    await call('GET', '/api/system/pending', { user: OWNER });
    assert.equal(pendingServerActionsDb.getById(id)?.error, 'oid_loaded');
    const legacyId = crypto.randomUUID();
    pendingServerActionsDb.insert({ id: legacyId, actionType: 'safe-restart', expectedServerBuildId: build });
    getConnection().prepare("UPDATE pending_server_actions SET status = 'executing', execution_attempt_nonce = NULL WHERE id = ?").run(legacyId);
    setOidReceiptReaderForTests(() => [receiptFor(legacyId, 'loaded')]);
    const res = await call('GET', '/api/system/pending', { user: OWNER });
    const row = (await res.json()).actions.find((value: { id: string }) => value.id === legacyId);
    assert.equal(row.retryable, false);
    assert.equal(row.reasonCode, 'execution_unresolved');
    assert.equal(row.executionAttemptNonce, undefined);
    assert.equal(pendingServerActionsDb.getById(legacyId)?.status, 'executing');
  } finally { setOidReceiptReaderForTests(null); }
});

test('dismiss rejects an executing action without destroying its attempt binding', async () => {
  const id = crypto.randomUUID();
  pendingServerActionsDb.insert({ id, actionType: 'safe-restart', expectedServerBuildId: 'd'.repeat(64) });
  pendingServerActionsDb.claimForExecution(id);
  const nonce = pendingServerActionsDb.getById(id)?.executionAttemptNonce;
  const res = await call('DELETE', `/api/system/pending/${id}`, { user: OWNER });
  assert.equal(res.status, 409);
  assert.equal(pendingServerActionsDb.getById(id)?.executionAttemptNonce, nonce);
});

test('served receipt requires exact attempt and complete runtime attestation', async () => {
  const id = crypto.randomUUID();
  pendingServerActionsDb.insert({ id, actionType: 'safe-restart', expectedServerBuildId: 'a'.repeat(64) });
  pendingServerActionsDb.claimForExecution(id);
  setOidReceiptReaderForTests(() => [receiptFor(id, 'served', { bootNonce: null })]);
  try {
    runQueueMaintenance();
    assert.equal(pendingServerActionsDb.getById(id)?.status, 'executing');
    setOidReceiptReaderForTests(() => [receiptFor(id, 'served', { transactionNonce: '0'.repeat(64) })]);
    runQueueMaintenance();
    assert.equal(pendingServerActionsDb.getById(id)?.status, 'executing');
    setOidReceiptReaderForTests(() => [receiptFor(id, 'served')]);
    runQueueMaintenance();
    assert.equal(pendingServerActionsDb.getById(id)?.error, 'oid_loaded');
  } finally { setOidReceiptReaderForTests(null); }
});

test('malformed unrelated receipt does not hide valid evidence and queue pass reads once', async () => {
  const directory = await mkdtemp(path.join(tmpDir, 'receipts-'));
  const id = crypto.randomUUID();
  pendingServerActionsDb.insert({ id, actionType: 'safe-restart', expectedServerBuildId: '3'.repeat(64) });
  pendingServerActionsDb.claimForExecution(id);
  await writeFile(path.join(directory, 'nassaj-oid-control-transaction-bad.json'), '{');
  await writeFile(path.join(directory, 'nassaj-oid-control-transaction-null.json'), 'null');
  await writeFile(path.join(directory, 'nassaj-oid-control-transaction-good.json'), JSON.stringify(receiptFor(id, 'loaded')));
  let reads = 0;
  setOidReceiptReaderForTests(() => { reads++; return readOidTransactionReceipts(directory); });
  try {
    const response = await call('GET', '/api/system/pending', { user: OWNER });
    assert.equal(response.status, 200);
    assert.equal(reads, 1);
    assert.equal(pendingServerActionsDb.getById(id)?.error, 'oid_loaded');
  } finally { setOidReceiptReaderForTests(null); await rm(directory, { recursive: true, force: true }); }
});

test('GET maintenance settles exact prior loaded proof idempotently without a new launcher', async () => {
  const id = crypto.randomUUID(), buildId = '4'.repeat(64);
  pendingServerActionsDb.insert({ id, actionType: 'safe-restart', expectedServerBuildId: buildId });
  pendingServerActionsDb.claimForExecution(id);
  setOidReceiptReaderForTests(() => [receiptFor(id, 'loaded')]); spawnCalls = [];
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await call('GET', '/api/system/pending', { user: OWNER });
      assert.equal(response.status, 200);
      assert.equal(pendingServerActionsDb.getById(id)?.status, 'succeeded');
      assert.equal(pendingServerActionsDb.getById(id)?.error, 'oid_loaded');
    }
    assert.equal(spawnCalls.length, 0);
  } finally { setOidReceiptReaderForTests(null); }
});

test('GET reconciliation resolves deferred dedup race without a 500 or deleting attempt history', async () => {
  const id = crypto.randomUUID();
  const replacement = crypto.randomUUID();
  const build = '5'.repeat(64);
  const sessionId = crypto.randomUUID();
  pendingServerActionsDb.insert({ id, actionType: 'safe-restart', sessionId, expectedServerBuildId: build });
  pendingServerActionsDb.claimForExecution(id);
  const nonce = pendingServerActionsDb.getById(id)!.executionAttemptNonce;
  pendingServerActionsDb.insert({ id: replacement, actionType: 'safe-restart', sessionId, expectedServerBuildId: build });
  setOidReceiptReaderForTests(() => [receiptFor(id, 'restart_deferred_restored')]);
  try {
    const response = await call('GET', '/api/system/pending', { user: OWNER });
    assert.equal(response.status, 200);
    assert.equal(pendingServerActionsDb.getById(id)?.error, `superseded_by:${replacement}`);
    assert.equal(pendingServerActionsDb.getById(id)?.executionAttemptNonce, nonce);
    assert.equal(pendingServerActionsDb.getById(replacement)?.status, 'pending');
  } finally { setOidReceiptReaderForTests(null); }
});

for (const [actionType, error, retryable] of [
  ['safe-restart', 'unknown_candidate', false],
  ['safe-restart', 'sensitive_candidate', false],
  ['safe-restart', 'live_work', true],
  ['safe-restart', 'unknown_candidate_extra', true],
  ['raw', 'unknown_candidate', true],
  ['custom-test', 'sensitive_candidate', true],
] as const) {
  // T-1684: a failed row is HISTORY (retryable from there), no longer a queue
  // entry — but the retry POLICY per reason code is unchanged and is what the
  // history item's `retryable` reports.
  test(`B-889 retry policy preserves ${actionType}/${error} in history`, async () => {
    const id = crypto.randomUUID();
    pendingServerActionsDb.insert({ id, actionType, sessionId: crypto.randomUUID() });
    pendingServerActionsDb.markFailed(id, error);
    const before = pendingServerActionsDb.getById(id);
    const response = await call('GET', '/api/system/pending?limit=200', { user: OWNER });
    const body = await response.json();
    assert.equal(body.actions.some((item: { id: string }) => item.id === id), false,
      'a failed row must not sit in the queue');
    const row = body.history.find((item: { id: string }) => item.id === id);
    assert.ok(row);
    assert.equal(row.kind, 'action');
    assert.equal(row.outcome, 'failure');
    assert.equal(row.retryable, retryable);
    assert.equal(row.reasonCode, error);
    assert.equal(Date.parse(row.expiresAt) - Date.parse(row.executedAt), 60 * 60 * 1000);
    assert.deepEqual(pendingServerActionsDb.getById(id), before);
  });
}


// ── T-1684: the command board's queue/history split ──────────────────────────
//
// The owner's rule: anything that ran — succeeded, failed, or with an outcome
// nobody can determine — leaves the queue for a history list that is deleted an
// hour later, and the yellow badge stays down for all of it.
test('T-1684 GET /pending splits the queue from a one-hour history with an honest verdict', async () => {
  // Other tests in this file leave rows behind, so the badge assertion below is
  // measured as a DELTA rather than an absolute count.
  const queuedBefore = pendingServerActionsDb.countActionable();
  const rows = {
    queued: crypto.randomUUID(),
    succeeded: crypto.randomUUID(),
    failed: crypto.randomUUID(),
    orphaned: crypto.randomUUID(),
    superseded: crypto.randomUUID(),
  };
  for (const id of Object.values(rows)) {
    pendingServerActionsDb.insert({ id, actionType: 'custom-test', sessionId: id });
  }
  // markSucceeded only settles a row this process CLAIMED (defence in depth), so
  // the fixture must go through the claim like the real execute path does.
  pendingServerActionsDb.claimForExecution(rows.succeeded);
  pendingServerActionsDb.markSucceeded(rows.succeeded, 'exit_0');
  pendingServerActionsDb.markFailed(rows.failed, 'timeout');
  pendingServerActionsDb.claimForExecution(rows.orphaned);
  getConnection().prepare(
    "UPDATE pending_server_actions SET executed_at = datetime('now', '-31 minutes') WHERE id = ?"
  ).run(rows.orphaned);
  pendingServerActionsDb.markSuperseded(rows.superseded, 'satisfied_by_server_start');

  setQueueMaintenanceClockForTests(() => 10_000_000);
  try {
    const body = await (await call('GET', '/api/system/pending?limit=200', { user: OWNER })).json();
    const byId = (list: { id: string }[], id: string) => list.find((item) => item.id === id);

    assert.ok(byId(body.actions, rows.queued), 'a pending row is the queue');
    for (const id of [rows.succeeded, rows.failed, rows.orphaned, rows.superseded]) {
      assert.equal(byId(body.actions, id), undefined, 'a settled row is never in the queue');
    }

    assert.equal(byId(body.history, rows.succeeded)!.outcome, 'success');
    assert.equal(byId(body.history, rows.succeeded)!.retryable, false);
    assert.equal(byId(body.history, rows.failed)!.outcome, 'failure');
    assert.equal(byId(body.history, rows.failed)!.retryable, true);
    // Maintenance settled the abandoned execution while serving this read.
    assert.equal(byId(body.history, rows.orphaned)!.outcome, 'unknown');
    assert.equal(byId(body.history, rows.orphaned)!.reasonCode, 'execution_unresolved');
    // The UI offers no retry for an abandoned execution, so the contract must
    // not claim one: re-running work that may have happened is the worse error.
    assert.equal(byId(body.history, rows.orphaned)!.retryable, false);
    assert.equal(byId(body.history, rows.superseded)!.outcome, 'unknown');
    for (const item of body.history) {
      assert.equal(item.kind, 'action');
      assert.equal(Date.parse(item.expiresAt) - Date.parse(item.executedAt), 60 * 60 * 1000);
    }
    // History is newest first.
    const stamps = body.history.map((item: { executedAt: string }) => Date.parse(item.executedAt));
    assert.deepEqual(stamps, [...stamps].sort((a: number, b: number) => b - a));

    // …and only the still-queued row may light the badge.
    assert.equal(pendingServerActionsDb.countActionable(), queuedBefore + 1,
      'four settled rows add nothing to the badge');

    // An hour later the history is gone, the queue is not.
    assert.ok(pendingServerActionsDb.pruneHistory(0) >= 4);
    const after = await (await call('GET', '/api/system/pending?limit=200', { user: OWNER })).json();
    assert.equal(after.history.length, 0);
    assert.ok(byId(after.actions, rows.queued));
  } finally {
    setQueueMaintenanceClockForTests(null);
    for (const id of Object.values(rows)) pendingServerActionsDb.deleteById(id);
  }
});

test('T-1684 DELETE /pending/:id also removes a settled history row', async () => {
  const id = crypto.randomUUID();
  pendingServerActionsDb.insert({ id, actionType: 'custom-test', sessionId: id });
  pendingServerActionsDb.claimForExecution(id);
  pendingServerActionsDb.markSucceeded(id, 'exit_0');

  const res = await call('DELETE', `/api/system/pending/${id}`, { user: OWNER });
  assert.equal(res.status, 200);
  assert.equal(pendingServerActionsDb.getById(id), null);
});

// ── qa-critic follow-up (T-1684): a request another run already satisfied ─────
//
// supersedeSiblings, the dedup collapse and the generation fence all settle a
// row whose WORK ALREADY HAPPENED. Classifying those as 'unknown' told the owner
// their request may not have run and showed the generic error string; they are
// successes, under one symbolic code the UI resolves to a written sentence.
for (const [name, storedError] of [
  ['a sibling of a global action that just ran', 'satisfied_by_same_generation_execution'],
  ['a click collapsed onto an equivalent pending row', 'satisfied_by_equivalent_pending_action'],
  ['a row fenced by the newer row that carried it', 'superseded_by:11111111-2222-3333-4444-555555555555'],
] as const) {
  test(`T-1684 history reports ${name} as satisfied by another execution`, async () => {
    const id = crypto.randomUUID();
    pendingServerActionsDb.insert({ id, actionType: 'custom-test', sessionId: id });
    pendingServerActionsDb.markSuperseded(id, storedError);
    try {
      const body = await (await call('GET', '/api/system/pending?limit=200', { user: OWNER })).json();
      const row = body.history.find((item: { id: string }) => item.id === id);
      assert.ok(row);
      assert.equal(row.outcome, 'success');
      assert.equal(row.reasonCode, 'satisfied_by_other_execution',
        'one symbolic code, so the UI has one message to write');
      assert.equal(row.retryable, false, 'the work is done — a retry would repeat it');
      assert.equal(pendingServerActionsDb.getById(id)?.error, storedError,
        'the stored reason is untouched; only the projection is normalised');
    } finally { pendingServerActionsDb.deleteById(id); }
  });
}

test('T-1684 a fence for a DIFFERENT build is not reported as satisfied', async () => {
  // `superseded_by_newer_server_candidate` looks similar and means the opposite:
  // that request never ran, because another generation replaced it.
  const id = crypto.randomUUID();
  pendingServerActionsDb.insert({ id, actionType: 'custom-test', sessionId: id });
  pendingServerActionsDb.markSuperseded(id, 'superseded_by_newer_server_candidate');
  try {
    const body = await (await call('GET', '/api/system/pending?limit=200', { user: OWNER })).json();
    const row = body.history.find((item: { id: string }) => item.id === id);
    assert.equal(row.outcome, 'unknown');
    assert.equal(row.reasonCode, 'superseded_by_newer_server_candidate');
  } finally { pendingServerActionsDb.deleteById(id); }
});


test('new legacy watcher candidate cannot enqueue or execute through either command-board entry', async () => {
  const buildId = 'd'.repeat(64); spawnCalls = [];
  setServerCandidateInspectorForTests(() => ({ allowed: true, code: 'ordinary_candidate', activationKind: 'legacy', expectedServerBuildId: buildId }));
  try {
    for (const endpoint of ['/api/system/pending', '/api/system/actions/safe-restart/run']) {
      const response = await call('POST', endpoint, { user: OWNER, body: { actionType: 'safe-restart', expectedServerBuildId: buildId, sessionId: 'denied-legacy-candidate' } });
      assert.equal(response.status, 422); assert.equal((await response.json()).code, 'node_update_button_required');
    }
    const id = crypto.randomUUID(); pendingServerActionsDb.insert({ id, actionType: 'safe-restart', expectedServerBuildId: buildId });
    const response = await call('POST', `/api/system/pending/${id}/execute`, { user: OWNER, body: {} });
    assert.equal(response.status, 422); assert.equal((await response.json()).code, 'node_update_button_required');
    assert.equal(spawnCalls.length, 0, 'no gate, guard or restart for a new legacy candidate');
  } finally { setServerCandidateInspectorForTests(null); }
});

test('B-1157 repeated consent, ensure and busy ticks retain one action through idle claim and pair inspection', async () => {
  // Isolate this scenario from unresolved claims deliberately retained by preceding route fixtures.
  getConnection().prepare("DELETE FROM pending_server_actions WHERE status = 'executing'").run();
  const fs = await import('node:fs');
  const local = await import('../../../scripts/lib/local-update-control.mjs');
  const { consumeNewestPreview } = await import('../../../scripts/preview-oid-consumer.mjs');
  const root = await mkdtemp(path.join(tmpDir, 'local-consent-'));
  const git = (...args: string[]) => realChildProcess.execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  const oldMode = process.env.NASSAJ_UPDATE_MODE;
  let actionId = '';
  try {
    git('init', '-q', '-b', 'main'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid');
    fs.writeFileSync(path.join(root, 'input'), 'fixture'); git('add', 'input'); git('commit', '-qm', 'fixture');
    const oid = git('rev-parse', 'HEAD'); fs.writeFileSync(path.join(root, '.env'), 'NASSAJ_UPDATE_MODE=local-main\n');
    await local.prepareLocalUpdate(root, { mode: 'local-main', expectedOid: oid, ownerId: '1', idempotencyKey: 'actual-route' });
    const previewRoot = createSealedLocalPreviewRoot(fs, root);
    const build = (domain: string) => async () => {
      const buildId = (domain === 'client' ? 'a' : 'b').repeat(64), directory = path.join(previewRoot, `${domain}-candidates`, buildId);
      fs.mkdirSync(directory, { recursive: true });
      fs.writeFileSync(path.join(directory, 'BUILD_PROVENANCE.json'), JSON.stringify({ artifact: domain, commit: oid, baseCommit: oid, dirty: false, buildId }));
      fs.writeFileSync(path.join(directory, 'asset'), 'fixture');
      if (domain === 'server') fs.writeFileSync(path.join(directory, 'OID_CONTROL_MANIFEST.json'), '{}');
      return { buildId };
    };
    await consumeNewestPreview(root, { materialize: async () => root, buildClient: build('client'), buildServer: build('server') }, { mode: 'local-main', domains: ['client', 'server'] });
    const state = local.readLocalUpdate(root);
    const consent = await local.confirmLocalUpdate(root, { mode: 'local-main', ownerId: '1', sequence: state.sequence, expectedRevision: state.revision, targetDigest: state.targetDigest });
    assert.deepEqual(await local.confirmLocalUpdate(root, { mode: 'local-main', ownerId: '1', sequence: state.sequence,
      expectedRevision: state.revision, targetDigest: state.targetDigest }), consent);
    const enqueueIds: string[] = [];
    const ensure = () => actualLocalControl.ensureLocalUpdateAction(`local-update:${state.sequence}`, (row: any) => {
      const queued = pendingServerActionsDb.enqueueGenerationBoundGlobal(row); actionId = queued.row.id; enqueueIds.push(actionId);
    }, root);
    await ensure(); await ensure();
    const stableActionId = actionId;
    assert.deepEqual(enqueueIds, [stableActionId, stableActionId]);
    assert.ok(actionId); actualLocalControl.inspectLocalUpdateAction(pendingServerActionsDb.getById(actionId), root); localFixtureRoot = root; process.env.NASSAJ_UPDATE_MODE = 'local-main'; spawnCalls = [];
    setServerCandidateInspectorForTests(() => assert.fail('authorized local pair must not enter standalone classifier'));
    setOidReceiptReaderForTests(() => [receiptFor(actionId, 'restart_deferred_restored', { sequence: state.sequence, oid, gate: 6 })]);
    const manual = await call('POST', `/api/system/pending/${actionId}/execute`, { user: OWNER });
    assert.equal(manual.status, 409); assert.equal((await manual.json()).code, 'local_update_button_required');
    assert.equal(spawnCalls.length, 0);
    const { createUpdateAutoActivator } = await import('../../services/update-auto-activator.js');
    let liveSessions = 2, executions = 0;
    const activator = createUpdateAutoActivator({
      jobs: actualLocalControl.localUpdateActivationJobs(root), prepareJob: ensure,
      listQueuedRestarts: () => pendingServerActionsDb.listActionable().map(row => ({ ...row, sourceUpdateJobId: row.reason })),
      countSessions: () => liveSessions, getUser: () => OWNER,
      executeAsOwner: async ({ id, user }: any) => {
        assert.equal(id, stableActionId); executions++;
        const reply = await executeActionRowAs({ id, user, trigger: 'local-update-activate' });
        if (executions === 1) {
          assert.equal(reply.status, 200, JSON.stringify(reply.body)); assert.equal(reply.body.status, 'deferred');
        } else { assert.equal(reply.status, 503, JSON.stringify(reply.body)); }
        return reply;
      },
    });
    for (let tick = 0; tick < 2; tick++) {
      await activator.tick();
      assert.equal(activator.statusFor(`local-update:${state.sequence}`)?.state, 'waiting_sessions');
      assert.equal(actionId, stableActionId); assert.equal(pendingServerActionsDb.getById(actionId)?.reason, `local-update:${state.sequence}`);
      assert.equal(executions, 0);
    }
    liveSessions = 0; await activator.tick();
    assert.equal(executions, 1); assert.ok(enqueueIds.every(id => id === stableActionId));
    assert.equal(spawnCalls.length, 1); assert.match(spawnCalls[0].args[0], /preview-oid-capsule-launcher/);
    assert.equal(pendingServerActionsDb.getById(actionId)?.status, 'pending');
    assert.deepEqual(local.readLocalUpdate(root).consent, consent.consent);
    // B-1158: the real route intentionally preserves an executing claim when the launcher exits without a receipt.
    setOidReceiptReaderForTests(() => []); oidExitCode = 0;
    await activator.tick(); assert.equal(executions, 2);
    assert.equal(pendingServerActionsDb.getById(actionId)?.status, 'executing');
    const unresolvedRows = getConnection().prepare('SELECT * FROM pending_server_actions ORDER BY id').all();
    const unresolved = pendingServerActionsDb.getById(actionId)!; assert.ok(unresolved.executionAttemptNonce);
    for (let tick = 0; tick < 2; tick++) {
      await activator.tick();
      assert.equal(activator.statusFor(`local-update:${state.sequence}`)?.state, 'waiting_row');
      assert.equal(executions, 2); assert.equal(actionId, stableActionId);
      assert.deepEqual(getConnection().prepare('SELECT * FROM pending_server_actions ORDER BY id').all(), unresolvedRows);
    }
    assert.equal(spawnCalls.length, 2);
  } finally {
    pendingServerActionsDb.deleteById(actionId);
    oidExitCode = 6; localFixtureRoot = null; setServerCandidateInspectorForTests(null); setOidReceiptReaderForTests(null);
    if (oldMode === undefined) delete process.env.NASSAJ_UPDATE_MODE; else process.env.NASSAJ_UPDATE_MODE = oldMode;
    await rm(root, { recursive: true, force: true });
  }
});

/** Real v2 descriptor and disk receipts; native execution remains outside this route suite. */
async function tripleReceiptFixture(state = 'restart_deferred_restored') {
  const fs = await import('node:fs');
  const { createHash } = await import('node:crypto');
  const { computeOidTripleTargetDigest } = await import('../../../scripts/lib/oid-triple-target.mjs');
  const root = await mkdtemp(path.join(tmpDir, 'triple-receipt-'));
  realChildProcess.execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
  const target: any = { schema: 'nassaj-oid-triple-target/v2', generationNames: ['nodeModules', 'server', 'client'],
    installRuntime: { nodeBinarySha256: 'a'.repeat(64), nodeVersion: process.version, nodeModuleAbi: process.versions.modules,
      napi: process.versions.napi, platform: process.platform, arch: process.arch, npmVersion: '12.0.2', npmCliSha256: 'b'.repeat(64) } };
  for (const key of ['clientBuildId', 'serverBuildId', 'clientTreeSha256', 'serverTreeSha256', 'nodeModulesTreeSha256',
    'dependencyContractSha256', 'packageJsonSha256', 'packageLockSha256', 'installPolicySha256', 'controlManifestSha256']) target[key] = 'c'.repeat(64);
  realChildProcess.execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-qm', 'fixture'], { cwd: root });
  const oid = realChildProcess.execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  const id = crypto.randomUUID(), sequence = 1, group = 'event-0000000000000001';
  const targetDigest = computeOidTripleTargetDigest({ sequence, group, sourceOid: oid, target });
  pendingServerActionsDb.insert({ id, actionType: 'safe-restart', reason: `local-update:${sequence}`,
    expectedServerBuildId: target.serverBuildId, activationIdentitySha256: targetDigest, releaseCommit: oid });
  pendingServerActionsDb.claimForExecution(id);
  const transactionNonce = pendingServerActionsDb.getById(id)!.executionAttemptNonce;
  const receipt: any = { schema: 'nassaj-oid-control-transaction/v2', generationNames: target.generationNames,
    actionId: id, sequence, group, oid, targetDigest, transactionNonce, buildId: target.serverBuildId, state,
    oldStopIntentAt: Date.now(), error: 'oid_triple_not_started',
    pair: { target, targetDigest, previous: { ...target }, databaseState: 'PRE_CANDIDATE' } };
  localFixtureRoot = root;
  const gate = actualMaintenance.createUpdateMaintenanceGate({ projectPath: root });
  const record = () => {
    if (['pair_served', 'pair_rolled_back'].includes(receipt.state)) {
      receipt.bootNonce = 'f'.repeat(64);
      receipt.pair.databaseState = receipt.state === 'pair_served' ? 'TARGET_VERIFIED' : 'PRE_CANDIDATE';
      receipt.pair.receipt = { schema: 'nassaj-oid-triple-terminal/v2', generationNames: target.generationNames,
        nodeModulesTreeSha256: target.nodeModulesTreeSha256, outcome: receipt.state === 'pair_served' ? 'activated' : 'rolled_back',
        transactionNonce, targetDigest, clientBuildId: target.clientBuildId, serverBuildId: target.serverBuildId, pid: 123, startTime: '456' };
      receipt.persistence = { online: { state: 'verified', status: 'online', dumpSha256: 'a'.repeat(64),
        pid: 123, startTime: '456', bootNonce: receipt.bootNonce } };
      const bytes = JSON.stringify(receipt.pair.receipt);
      receipt.pair.receiptSha256 = createHash('sha256').update(bytes).digest('hex');
      fs.writeFileSync(path.join(root, '.git', `nassaj-oid-pair-receipt-${transactionNonce}.json`), bytes, { mode: 0o600 });
      fs.writeFileSync(path.join(root, '.git', `nassaj-oid-pair-serving-${transactionNonce}.json`), JSON.stringify({
        ...receipt.pair.receipt, schema: 'nassaj-oid-triple-serving/v2', outcome: 'served', sequence, actionId: id, servedAt: Date.now() }), { mode: 0o600 });
    }
    fs.writeFileSync(path.join(root, '.git', `nassaj-oid-control-transaction-${sequence}-${transactionNonce}.json`), JSON.stringify(receipt), { mode: 0o600 });
  };
  record(); setOidReceiptReaderForTests(() => readOidTransactionReceipts(path.join(root, '.git')));
  return { root, id, receipt, gate, record, async close() {
    setOidReceiptReaderForTests(null); localFixtureRoot = null; pendingServerActionsDb.deleteById(id);
    await rm(root, { recursive: true, force: true });
  } };
}

for (const [state, status, error] of [
  ['restart_deferred_restored', 'pending', 'oid_control_deferred'], ['pair_served', 'succeeded', 'oid_loaded'],
  ['pair_rolled_back', 'superseded', 'oid_rolled_back'], ['manual_recovery_required', 'failed', 'oid_manual_recovery_required'],
]) test(`B-1160 typed v2 ${state} settles the exact attempt`, async () => {
  const fixture = await tripleReceiptFixture(state);
  try {
    if (state === 'manual_recovery_required') {
      fixture.receipt.error = 'oid_triple_recovery_requires_retained_executor'; fixture.receipt.pair.databaseState = 'UNKNOWN'; fixture.record();
    }
    const nonce = pendingServerActionsDb.getById(fixture.id)!.executionAttemptNonce;
    await call('GET', '/api/system/pending', { user: OWNER });
    assert.equal(pendingServerActionsDb.getById(fixture.id)?.status, status);
    assert.equal(pendingServerActionsDb.getById(fixture.id)?.error, error);
    assert.equal(pendingServerActionsDb.getById(fixture.id)?.executionAttemptNonce, nonce);
    const outcome = await (await call('GET', `/api/system/pending/${fixture.id}/outcome`, { user: OWNER })).json();
    assert.equal(outcome.currentActionOutcome.reasonCode, error);
    assert.equal(outcome.currentActionOutcome.retryable, status === 'pending');
    await call('GET', '/api/system/pending', { user: OWNER });
    assert.equal(pendingServerActionsDb.getById(fixture.id)?.status, status);
  } finally { await fixture.close(); }
});

const invalidTripleReceipts: Record<string, (receipt: any) => void> = {
  'wrong action': r => { r.actionId = crypto.randomUUID(); },
  'wrong attempt': r => { r.transactionNonce = '0'.repeat(64); },
  'wrong build': r => { r.buildId = '0'.repeat(64); },
  'wrong sequence': r => { r.sequence++; },
  'wrong group': r => { r.group = 'event-0000000000000042'; },
  'wrong OID': r => { r.oid = '0'.repeat(40); },
  'wrong digest': r => { r.pair.targetDigest = '0'.repeat(64); },
  'wrong top digest': r => { r.targetDigest = '0'.repeat(64); },
  'incomplete target': r => { delete r.pair.target.dependencyContractSha256; },
  'wrong generation names': r => { r.generationNames = ['server', 'client']; },
  'legacy loaded': r => { r.state = 'loaded'; },
  'unknown state': r => { r.state = 'triple_magic'; },
  'unproven deferred': r => { r.error = 'different'; },
  'UNKNOWN deferred': r => { r.pair.databaseState = 'UNKNOWN'; },
  'stopped deferred': r => { r.oldStoppedAt = Date.now(); },
  'booted deferred': r => { r.bootDirection = 'target'; },
  'boot nonce deferred': r => { r.bootNonce = 'f'.repeat(64); },
  'online deferred': r => { r.persistence = { online: {} }; },
};
for (const [name, mutate] of Object.entries(invalidTripleReceipts)) test(`B-1160 ${name} cannot release executing fence`, async () => {
  const fixture = await tripleReceiptFixture();
  try {
    mutate(fixture.receipt); fixture.record();
    await call('GET', '/api/system/pending', { user: OWNER });
    assert.equal(pendingServerActionsDb.getById(fixture.id)?.status, 'executing');
  } finally { await fixture.close(); }
});

test('B-1160 a child grant or absent durable serving proof cannot settle an attempt', async () => {
  const fs = await import('node:fs');
  for (const state of ['restart_deferred_restored', 'pair_served']) {
    const fixture = await tripleReceiptFixture(state);
    try {
      if (state === 'pair_served') fs.unlinkSync(path.join(fixture.root, '.git', `nassaj-oid-pair-serving-${fixture.receipt.transactionNonce}.json`));
      else fs.writeFileSync(path.join(fixture.gate.paths.controlRoot, `oid-child-${fixture.receipt.transactionNonce}.json`), '{}');
      await call('GET', '/api/system/pending', { user: OWNER });
      assert.equal(pendingServerActionsDb.getById(fixture.id)?.status, 'executing');
    } finally { await fixture.close(); }
  }
});

test('B-1160 deferred triple permits a new confirmed attempt, never an automatic retry', async () => {
  const fs = await import('node:fs');
  const local = await import('../../../scripts/lib/local-update-control.mjs');
  const { consumeNewestPreview } = await import('../../../scripts/preview-oid-consumer.mjs');
  const { createUpdateAutoActivator } = await import('../../services/update-auto-activator.js');
  const fixture = await tripleReceiptFixture();
  const oldMode = process.env.NASSAJ_UPDATE_MODE;
  let nextId: string | undefined;
  try {
    process.env.NASSAJ_UPDATE_MODE = 'local-main'; fs.writeFileSync(path.join(fixture.root, '.env'), 'NASSAJ_UPDATE_MODE=local-main\n');
    const previewRoot = createSealedLocalPreviewRoot(fs, fixture.root);
    const initial = await local.prepareLocalUpdate(fixture.root, { mode: 'local-main', ownerId: '1',
      expectedOid: fixture.receipt.oid, idempotencyKey: 'first-attempt' });
    // Model the capsule's already-durable failed event and cleared consent; no SQL reset or requeue.
    const eventFile = path.join(fixture.root, '.git', 'nassaj-preview-oid-event-control-0000000000000001.json');
    const event = JSON.parse(fs.readFileSync(eventFile, 'utf8'));
    event.localUpdate = { ...initial, phase: 'failed', consent: null, target: fixture.receipt.pair.target,
      targetDigest: fixture.receipt.targetDigest };
    fs.writeFileSync(eventFile, JSON.stringify(event));
    const nonce = pendingServerActionsDb.getById(fixture.id)!.executionAttemptNonce;
    await call('GET', '/api/system/pending', { user: OWNER });
    assert.equal(pendingServerActionsDb.getById(fixture.id)?.status, 'pending');
    let executions = 0;
    const ensure = (job: any) => actualLocalControl.ensureLocalUpdateAction(job.id, (row: any) => {
      nextId = pendingServerActionsDb.enqueueGenerationBoundGlobal(row).row.id;
    }, fixture.root);
    const activator = createUpdateAutoActivator({ jobs: actualLocalControl.localUpdateActivationJobs(fixture.root),
      prepareJob: ensure, listQueuedRestarts: () => pendingServerActionsDb.listActionable()
        .filter(row => row.id === fixture.id || row.id === nextId).map(row => ({ ...row, sourceUpdateJobId: row.reason })),
      countSessions: () => 0, getUser: () => OWNER, executeAsOwner: async ({ id, user }: any) => {
        executions++; assert.notEqual(id, fixture.id);
        return executeActionRowAs({ id, user, trigger: 'local-update-activate' });
      } });
    spawnCalls = []; await activator.tick(); await activator.tick();
    assert.equal(executions, 0); assert.equal(spawnCalls.length, 0);
    assert.equal((await local.prepareLocalUpdate(fixture.root, { mode: 'local-main', ownerId: '1',
      expectedOid: fixture.receipt.oid, idempotencyKey: 'first-attempt' })).phase, 'failed');
    const prepared = await local.prepareLocalUpdate(fixture.root, { mode: 'local-main', ownerId: '1',
      expectedOid: fixture.receipt.oid, idempotencyKey: 'new-button-attempt' });
    assert.equal(prepared.sequence, initial.sequence + 1); assert.equal(prepared.oid, initial.oid);
    const build = (domain: string) => async () => {
      const buildId = (domain === 'client' ? 'a' : 'c').repeat(64);
      const directory = path.join(previewRoot, `${domain}-candidates`, buildId);
      fs.mkdirSync(directory, { recursive: true });
      fs.writeFileSync(path.join(directory, 'BUILD_PROVENANCE.json'), JSON.stringify({ artifact: domain,
        commit: prepared.oid, baseCommit: prepared.oid, dirty: false, buildId }));
      fs.writeFileSync(path.join(directory, 'asset'), 'fixture');
      if (domain === 'server') fs.writeFileSync(path.join(directory, 'OID_CONTROL_MANIFEST.json'), '{}');
      return { buildId };
    };
    await consumeNewestPreview(fixture.root, { buildTriple: async () => {
      const client = await build('client')(), server = await build('server')();
      return retryTripleTargetFixture(fixture.root, prepared, fixture.receipt.pair.target, client.buildId, server.buildId);
    } }, { mode: 'local-main', domains: ['client', 'server'] });
    await activator.tick(); assert.equal(executions, 0);
    const ready = local.readLocalUpdate(fixture.root);
    assert.equal(ready.target.schema, 'nassaj-oid-triple-target/v2');
    assert.deepEqual(ready.target.generationNames, ['nodeModules', 'server', 'client']);
    await local.confirmLocalUpdate(fixture.root, { mode: 'local-main', ownerId: '1', sequence: ready.sequence,
      expectedRevision: ready.revision, targetDigest: ready.targetDigest });
    setOidReceiptReaderForTests(() => []); oidExitCode = 0;
    await activator.tick();
    assert.equal(executions, 1); assert.equal(spawnCalls.length, 1);
    assert.notEqual(nextId, fixture.id);
    assert.equal(pendingServerActionsDb.getById(fixture.id)?.status, 'superseded');
    assert.equal(pendingServerActionsDb.getById(fixture.id)?.executionAttemptNonce, nonce);
    assert.equal(pendingServerActionsDb.getById(nextId!)?.status, 'executing');
    assert.notEqual(pendingServerActionsDb.getById(nextId!)?.executionAttemptNonce, nonce);
    await activator.tick(); assert.equal(executions, 1, 'missing receipt retains B-1158 fence without another launch');
  } finally {
    oidExitCode = 6;
    if (oldMode === undefined) delete process.env.NASSAJ_UPDATE_MODE; else process.env.NASSAJ_UPDATE_MODE = oldMode;
    if (nextId) pendingServerActionsDb.deleteById(nextId);
    await fixture.close();
  }
});

test('B-1160 conflicting v2 evidence cannot settle an otherwise valid deferred receipt', async () => {
  const fixture = await tripleReceiptFixture();
  try {
    for (const conflicting of [{ ...fixture.receipt, buildId: '0'.repeat(64) }, receiptFor(fixture.id, 'loaded')]) {
      setOidReceiptReaderForTests(() => [fixture.receipt, conflicting]);
      await call('GET', '/api/system/pending', { user: OWNER });
      assert.equal(pendingServerActionsDb.getById(fixture.id)?.status, 'executing');
      const outcome = await (await call('GET', `/api/system/pending/${fixture.id}/outcome`, { user: OWNER })).json();
      assert.equal(outcome.currentActionOutcome.reasonCode, 'receipt_conflict');
    }
  } finally { await fixture.close(); }
});

test('B-1160 a closed or unreadable maintenance gate cannot authorize deferred retry', async () => {
  const fs = await import('node:fs');
  const fixture = await tripleReceiptFixture();
  let update: any;
  try {
    update = await fixture.gate.beginUpdate({ transactionId: 'update-transaction-1234', expectedVersion: '1.44.0.2',
      originalHead: 'a'.repeat(40), targetCommit: 'b'.repeat(40) }, { waitMs: 100 });
    await call('GET', '/api/system/pending', { user: OWNER });
    assert.equal(pendingServerActionsDb.getById(fixture.id)?.status, 'executing');
    update.release(); update = null;
    fs.writeFileSync(fixture.gate.paths.journal, '{');
    await call('GET', '/api/system/pending', { user: OWNER });
    assert.equal(pendingServerActionsDb.getById(fixture.id)?.status, 'executing');
  } finally { update?.release(); await fixture.close(); }
});


/** A tiny sealed dependency fixture; its native-probe field is a declared test double. */
async function retryTripleTargetFixture(root: string, state: any, previousTarget: any, clientBuildId: string, serverBuildId: string) {
  const fs = await import('node:fs');
  const { createHash } = await import('node:crypto');
  const { verifyLocalCandidate } = await import('../../../scripts/lib/local-update-control.mjs');
  const { hashDependencyTreeV2 } = await import('../../../scripts/lib/dependency-tree-identity-v2.mjs');
  const { canonicalTripleJson } = await import('../../../scripts/lib/oid-triple-target.mjs');
  const { computeDependencyContractV2 } = await import('../../../scripts/lib/oid-dependency-candidate.mjs');
  const parent = path.join(root, '.nassaj-local-preview/dependency-candidates');
  const evidenceParent = path.join(root, '.nassaj-local-preview/dependency-evidence');
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 }); fs.mkdirSync(evidenceParent, { mode: 0o700 });
  const temporary = path.join(parent, 'fixture'); fs.mkdirSync(temporary, { mode: 0o700 });
  fs.writeFileSync(path.join(temporary, 'fixture.js'), 'export default 1;', { mode: 0o400 });
  const tree = hashDependencyTreeV2(temporary, { requireSealed: true });
  fs.renameSync(temporary, path.join(parent, tree.sha256));
  const client = verifyLocalCandidate(root, state, 'client', clientBuildId);
  const server = verifyLocalCandidate(root, state, 'server', serverBuildId);
  const installPolicy = { fixture: true };
  const target = { ...previousTarget, clientBuildId, serverBuildId, clientTreeSha256: client.treeSha256,
    serverTreeSha256: server.treeSha256, controlManifestSha256: server.controlManifestSha256,
    nodeModulesTreeSha256: tree.sha256,
    installPolicySha256: createHash('sha256').update(canonicalTripleJson(installPolicy)).digest('hex') };
  target.dependencyContractSha256 = computeDependencyContractV2(target);
  const evidence = { ...target, schema: 'nassaj-oid-dependency-candidate/v2', tree, installPolicy,
    nativeProbe: { schema: 'nassaj-oid-native-probe/v2', processExited: true, nodeModulesTreeSha256: tree.sha256,
      nodeVersion: target.installRuntime.nodeVersion, nodeModuleAbi: target.installRuntime.nodeModuleAbi } };
  fs.writeFileSync(path.join(evidenceParent, `${target.dependencyContractSha256}.json`), JSON.stringify(evidence), { mode: 0o600 });
  return target;
}
