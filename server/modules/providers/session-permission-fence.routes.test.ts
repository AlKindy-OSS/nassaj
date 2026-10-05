/**
 * T-1910 S4 route tests: "continue here" acknowledgement of a SESSION permission fence.
 *
 * Real router + real audited lift core against an isolated temp SQLite DB. Process-level
 * containment is injected (deterministic) except for the live tagged-process case, which spawns
 * a real process carrying CCUI_PROCESS_TAG=pe-<decisionId> and uses the default host scan.
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { appendFile, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';

import express from 'express';

process.env.JWT_SECRET = 'session-fence-ack-test-secret-0123456789abcdef';
delete process.env.PROJECT_MEMBERSHIP_ENFORCE;
const tmpDir = await mkdtemp(path.join(process.env.NASSAJ_TEST_TMP || tmpdir(), 'session-fence-ack-'));
process.env.DATABASE_PATH = path.join(tmpDir, 'db.sqlite');

const { closeConnection, getConnection, initializeDatabase } = await import('@/modules/database/index.js');
const { createHostContainment, describeFences } = await import('@/modules/execution-permissions/index.js');
const { createSessionPermissionFenceRouter } = await import('./session-permission-fence.routes.js');

closeConnection();
await initializeDatabase();

type TestUser = { id: number; username: string; role: string; authenticationKind: string; deviceSessionId?: string };
const OWNER: TestUser = { id: 1, username: 'owner', role: 'owner', authenticationKind: 'session' };
const WRITER: TestUser = {
  id: 2, username: 'writer', role: 'user', authenticationKind: 'device_session', deviceSessionId: 'dev-session-42',
};
const OUTSIDER: TestUser = { id: 3, username: 'outsider', role: 'user', authenticationKind: 'session' };
const SESSION = 'sess-fenced-1';

const db = getConnection();
const seedUser = db.prepare('INSERT INTO users (id, username, password_hash, role) VALUES (?, ?, ?, ?)');
for (const u of [OWNER, WRITER, OUTSIDER]) seedUser.run(u.id, u.username, 'x', u.role);
db.prepare("INSERT INTO projects (project_id, project_path, created_by) VALUES ('p1', '/w/p1', 1)").run();
db.prepare("INSERT INTO project_members (project_id, user_id) VALUES ('p1', 2)").run();
db.prepare("INSERT INTO sessions (session_id, provider, project_path) VALUES (?, 'claude', '/w/p1')").run(SESSION);

type Containment = { scans: Array<{ tags: string[]; notBeforeMs: number }>; scan: string; alive: Set<number> };
const fake: Containment = { scans: [], scan: 'absent', alive: new Set() };
let onScan: (() => void) | null = null;
const containment = {
  scanTags: (tags: readonly string[], notBeforeMs: number) => {
    fake.scans.push({ tags: [...tags], notBeforeMs });
    onScan?.();
    return fake.scan as 'absent';
  },
  childAlive: (child: { pid: number }) => fake.alive.has(child.pid),
};
const notified: Array<{ ownerUserId: number; sessionId: string; operationId: string }> = [];

let currentUser: TestUser = WRITER;
const app = express();
app.use(express.json());
app.use((req, _res, next) => { (req as express.Request & { user: TestUser }).user = currentUser; next(); });
app.use('/api/sessions', createSessionPermissionFenceRouter({
  containment,
  notifyDecisionOwner: (notice) => notified.push({ ...notice }),
  limits: { ackPerUser: 100, ackPerSession: 100, ackGlobal: 100 },
}));
app.use('/real/sessions', createSessionPermissionFenceRouter({
  containment: createHostContainment(() => false), limits: { ackPerUser: 100 },
}));
app.use('/limited/sessions', createSessionPermissionFenceRouter({ containment, limits: { ackPerUser: 2 } }));
app.use('/shared/sessions', createSessionPermissionFenceRouter({
  containment, limits: { ackPerUser: 100, ackPerSession: 2, ackGlobal: 2 },
}));

const server = app.listen(0);
await new Promise<void>((resolve) => server.once('listening', () => resolve()));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

async function call(method: string, urlPath: string, user: TestUser = WRITER) {
  currentUser = user;
  const res = await fetch(base + urlPath, { method, headers: { 'content-type': 'application/json' } });
  return { status: res.status, body: await res.json() as Record<string, any> };
}
const ack = (user: TestUser = WRITER, prefix = '/api/sessions', session = SESSION) =>
  call('POST', `${prefix}/${session}/permission-fence/acknowledge`, user);

let decisionSeq = 0;
function seedDecision(opts: { sessionId?: string | null; userId?: number; leaseStatus?: string;
  state?: string; outcome?: string | null; child?: number; createdAtMs?: number } = {}): string {
  decisionSeq += 1;
  const id = `dec-${decisionSeq}-${Date.now()}`;
  const state = opts.state ?? 'terminal';
  const outcome = opts.outcome === undefined ? (state === 'terminal' ? 'reconciled_unknown' : null) : opts.outcome;
  const created = opts.createdAtMs ?? Date.now();
  db.prepare(`INSERT INTO permission_launch_decisions
    (decision_id,user_id,principal_id,authentication_kind,authorization_generation,launch_id,session_id,
     project_id,workspace_digest,provider,body,engine,entrypoint,purpose,requested_profile,
     contract_version,profile_digest,capability_digest,release_build,protocol_generation,
     verdict,state,terminal_outcome,created_at_ms,updated_at_ms)
    VALUES (?,?,?,'session',1,?,?,'p1','1234567890123456','claude','claude','sdk','ws.chat','spawn',
     'full','v1','profile','capability','build',1,'authorized',?,?,?,?)`)
    .run(id, opts.userId ?? 1, `user:${opts.userId ?? 1}`, id,
      opts.sessionId === undefined ? SESSION : opts.sessionId, state, outcome, created, created);
  const leaseStatus = opts.leaseStatus ?? 'terminal';
  const terminal = ['terminal', 'revoked'].includes(leaseStatus);
  db.prepare(`INSERT INTO permission_admission_leases
    (lease_id,decision_id,purpose,protocol_generation,owner_id,owner_pid,owner_boot_id,owner_start_ticks,
     effect_identity,status,expires_at_ms,claimed_at_ms,terminal_at_ms,created_at_ms,updated_at_ms,
     effect_child_pid,effect_child_boot_id,effect_child_start_ticks)
    VALUES (?,?,'spawn',1,'owner',123,'boot','42',?,?,?,?,?,?,?,?,?,?)`)
    .run(`lease:${id}`, id, `effect:${id}`, leaseStatus, Date.now() + 60_000,
      leaseStatus === 'issued' ? null : created, terminal ? created + 1 : null, created, created,
      opts.child ?? null, opts.child ? 'boot' : null, opts.child ? '77' : null);
  return id;
}
function fenceSession(decisionId: string, sessionId = SESSION, createdAtMs = Date.now()) {
  db.prepare(`INSERT INTO permission_effect_fences
    (scope_kind, scope_key, protocol_generation, decision_id, reason_code, created_at_ms)
    VALUES ('session', ?, 1, ?, 'RECONCILED_EFFECT_UNKNOWN', ?)`).run(sessionId, decisionId, createdAtMs);
}
const fenceRow = (sessionId = SESSION) => db.prepare(`SELECT decision_id AS decisionId FROM permission_effect_fences
  WHERE scope_kind = 'session' AND scope_key = ?`).get(sessionId) as { decisionId: string } | undefined;
const clearFences = () => db.prepare('DELETE FROM permission_effect_fences').run();
const journal = async () => (await readFile(`${process.env.DATABASE_PATH}.fence-lifts.jsonl`, 'utf8'))
  .trim().split('\n').map((line) => JSON.parse(line));

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  closeConnection();
  await rm(tmpDir, { recursive: true, force: true });
});

test('GET hides an unknown session (404) and reports no fence for a clean session', async () => {
  assert.equal((await call('GET', '/api/sessions/no-such-session/permission-fence')).status, 404);
  assert.equal((await call('GET', '/api/sessions/bad%20id/permission-fence')).status, 404);
  const clean = await call('GET', `/api/sessions/${SESSION}/permission-fence`);
  assert.deepEqual(clean.body, { fenced: false, canAcknowledge: false });
});

test('GET describes the session fence without paths; only writers may acknowledge', async () => {
  const decision = seedDecision();
  fenceSession(decision);
  const forWriter = await call('GET', `/api/sessions/${SESSION}/permission-fence`);
  assert.equal(forWriter.status, 200);
  assert.deepEqual(forWriter.body, {
    fenced: true, scope: 'session', reason: 'RECONCILED_EFFECT_UNKNOWN', decisionUserId: 1,
    canAcknowledge: true, contained: true, containment: 'contained',
  });
  const forOutsider = await call('GET', `/api/sessions/${SESSION}/permission-fence`, OUTSIDER);
  assert.equal(forOutsider.status, 200);
  assert.equal(forOutsider.body.canAcknowledge, false);
  assert.ok(!JSON.stringify(forWriter.body).includes('/w/p1'));
});

test('POST by a non-writer is 403 and the fence stays', async () => {
  const refused = await ack(OUTSIDER);
  assert.equal(refused.status, 403);
  assert.equal(refused.body.code, 'not_writer');
  assert.ok(fenceRow());
});

test('writer acknowledgement lifts through the journal with full attribution, then is idempotent', async () => {
  const fence = fenceRow();
  assert.ok(fence);
  fake.scans.length = 0;
  const lifted = await ack();
  assert.equal(lifted.status, 200);
  assert.deepEqual(lifted.body, { lifted: true });
  assert.equal(fenceRow(), undefined);
  assert.ok(fake.scans.length >= 2, 'containment re-scanned inside the lift transaction');
  assert.ok(fake.scans.every((scan) => scan.tags.includes(`pe-${fence.decisionId}`)));

  const records = await journal();
  const intent = records.find((record) => record.event === 'lift_intent');
  assert.equal(intent.actor, 'nassaj-user:2:device:dev-session-42');
  assert.equal(intent.force, false);
  assert.equal(intent.forceExternal, true);
  assert.equal(intent.acknowledgementIsProof, false);
  assert.deepEqual(intent.attribution, {
    path: 'session_acknowledge', actorUserId: 2, actorDeviceSessionId: 'dev-session-42', decisionOwnerUserId: 1,
  });
  assert.equal(intent.snapshot.fence.scopeKey, SESSION);
  assert.ok(records.some((record) => record.event === 'lift_committed' && record.operationId === intent.operationId));

  const audit = db.prepare("SELECT user_id AS userId, metadata FROM audit_log WHERE action = 'permission_fence_acknowledged'")
    .all() as Array<{ userId: number; metadata: string }>;
  assert.equal(audit.length, 1);
  assert.equal(audit[0].userId, 2);
  assert.deepEqual(JSON.parse(audit[0].metadata), {
    operationId: intent.operationId, sessionId: SESSION, actorUserId: 2, actorDeviceSessionId: 'dev-session-42',
    decisionOwnerUserId: 1, ownerNotificationRequired: true, ownerNotificationAttempted: true,
    completionAuditRecorded: true, acknowledgementIsProof: false,
  });
  assert.deepEqual(notified, [{ ownerUserId: 1, sessionId: SESSION, operationId: intent.operationId }]);

  // qa M4: a durable owner-visible record on the owner route, independent of push.
  const owner = describeFences(db);
  assert.equal(owner.recentAcknowledgementsAvailable, true);
  assert.deepEqual(owner.recentAcknowledgements, [{
    operationId: intent.operationId, sessionId: SESSION, actorUserId: 2, actorDeviceSessionId: 'dev-session-42',
    decisionOwnerUserId: 1, decisionId: fence.decisionId, atMs: intent.atMs, committed: true,
  }]);

  const again = await ack();
  assert.equal(again.status, 200);
  assert.deepEqual(again.body, { lifted: false, reason: 'not_fenced' });
});

test('an acknowledged (journal-committed) decision is not re-proven; a new unknown one is', async () => {
  const [old] = (await journal()).find((record) => record.event === 'lift_intent').snapshot.decisions;
  const fresh = seedDecision();
  fenceSession(fresh);
  fake.scans.length = 0;
  const lifted = await ack(OWNER);
  assert.equal(lifted.status, 200);
  assert.ok(fake.scans.every((scan) => !scan.tags.includes(`pe-${old.decision_id}`)));
  assert.ok(fake.scans.every((scan) => scan.tags.includes(`pe-${fresh}`)));
  assert.equal(notified.length, 1, 'no notification when the actor owns the decision');
});

test('a fence of another scope is never liftable here (409 not_session_scope)', async () => {
  db.prepare(`INSERT INTO permission_effect_fences
    (scope_kind, scope_key, protocol_generation, decision_id, reason_code, created_at_ms)
    VALUES ('user_provider_purpose', '2:claude:catalog', 1, NULL, 'RECONCILED_EFFECT_UNKNOWN', ?)`).run(Date.now());
  const view = await call('GET', `/api/sessions/${SESSION}/permission-fence`);
  assert.deepEqual(view.body, { fenced: true, canAcknowledge: false });
  const refused = await ack();
  assert.equal(refused.status, 409);
  assert.deepEqual(refused.body, { lifted: false, reason: 'not_session_scope' });
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM permission_effect_fences WHERE scope_kind = 'user_provider_purpose'")
    .get() as { n: number }).n, 1);
  clearFences();
});

test('a live process carrying the decision tag keeps the fence (real host scan)', async () => {
  const decision = seedDecision({ createdAtMs: Date.now() });
  fenceSession(decision);
  const child = spawn('sleep', ['30'], {
    env: { PATH: process.env.PATH, CCUI_PROCESS_TAG: `pe-${decision}` }, stdio: 'ignore',
  });
  try {
    await new Promise((resolve) => setTimeout(resolve, 100));
    const view = await call('GET', `/real/sessions/${SESSION}/permission-fence`);
    assert.equal(view.body.contained, false);
    const refused = await ack(WRITER, '/real/sessions');
    assert.equal(refused.status, 409);
    assert.deepEqual(refused.body, { lifted: false, reason: 'not_contained' });
    assert.equal(fenceRow()?.decisionId, decision);
  } finally {
    await new Promise<void>((resolve) => { child.once('exit', () => resolve()); child.kill('SIGKILL'); });
  }
  clearFences();
});

test('an open lease in the session scope is 409 leases_open', async () => {
  const open = seedDecision({ state: 'started', leaseStatus: 'active' });
  const decision = seedDecision();
  fenceSession(decision);
  const refused = await ack();
  assert.equal(refused.status, 409);
  assert.deepEqual(refused.body, { lifted: false, reason: 'leases_open' });
  assert.ok(fenceRow());
  db.prepare(`UPDATE permission_launch_decisions SET state = 'terminal', terminal_outcome = 'succeeded'
    WHERE decision_id = ?`).run(open);
  db.prepare(`UPDATE permission_admission_leases SET status = 'terminal', terminal_at_ms = 1
    WHERE decision_id = ?`).run(open);
  clearFences();
});

test('every unresolved unknown decision is proven: one live recorded child refuses the lift', async () => {
  const unproven = seedDecision({ child: 4242 });
  const decision = seedDecision();
  fenceSession(decision);
  fake.alive.add(4242);
  fake.scans.length = 0;
  const refused = await ack();
  assert.equal(refused.status, 409);
  assert.deepEqual(refused.body, { lifted: false, reason: 'not_contained' });
  assert.ok(fenceRow());
  fake.alive.delete(4242);
  const lifted = await ack();
  assert.equal(lifted.status, 200);
  const scanned = fake.scans.at(-1)?.tags ?? [];
  assert.ok(scanned.includes(`pe-${unproven}`) && scanned.includes(`pe-${decision}`));
});

test('an uncertain scan is transient (not_contained); an env-hidden process is terminal (not_provable)', async () => {
  fenceSession(seedDecision());
  try {
    for (const [scan, reason] of [['uncertain', 'not_contained'], ['hidden', 'not_provable']]) {
      fake.scan = scan;
      const refused = await ack();
      assert.equal(refused.status, 409);
      assert.equal(refused.body.reason, reason);
      const view = await call('GET', `/api/sessions/${SESSION}/permission-fence`);
      assert.equal(view.body.contained, false);
      assert.equal(view.body.containment, reason);
    }
  } finally { fake.scan = 'absent'; }
  clearFences();
});

test('a decision without a lease can never be proven (not_provable)', async () => {
  const decision = seedDecision();
  db.prepare('DELETE FROM permission_admission_leases WHERE decision_id = ?').run(decision);
  fenceSession(decision);
  const refused = await ack();
  assert.equal(refused.status, 409);
  assert.equal(refused.body.reason, 'not_provable');
  // Settle it so later tests in this session are not permanently unprovable.
  db.prepare("UPDATE permission_launch_decisions SET terminal_outcome = 'failed' WHERE decision_id = ?").run(decision);
  clearFences();
});

test('CAS: a fence replaced between the check and the lift is refused and kept', async () => {
  const first = seedDecision();
  fenceSession(first, SESSION, 1000);
  const replacement = seedDecision();
  let swapped = false;
  onScan = () => {
    if (swapped) return;
    swapped = true;
    db.prepare(`UPDATE permission_effect_fences SET decision_id = ?, created_at_ms = 2000
      WHERE scope_kind = 'session' AND scope_key = ?`).run(replacement, SESSION);
  };
  try {
    const refused = await ack();
    assert.equal(refused.status, 409);
    assert.equal(refused.body.reason, 'fence_changed');
    assert.equal(fenceRow()?.decisionId, replacement);
  } finally { onScan = null; }
  clearFences();
});

test('acknowledgement is rate limited per user (429)', async () => {
  const statuses = [];
  for (let i = 0; i < 3; i += 1) statuses.push((await ack(OUTSIDER, '/limited/sessions')).status);
  assert.deepEqual(statuses, [403, 403, 429]);
});

test('a session in a project subdirectory is acknowledgeable by a project writer (qa M1)', async () => {
  const nested = 'sess-nested-1';
  // sessions.project_path has an FK to projects; a legacy/unregistered-subdir row bypasses it.
  db.pragma('foreign_keys = OFF');
  try {
    db.prepare("INSERT INTO sessions (session_id, provider, project_path) VALUES (?, 'claude', '/w/p1/packages/api')")
      .run(nested);
  } finally { db.pragma('foreign_keys = ON'); }
  db.prepare('INSERT INTO session_participants (session_id, user_id) VALUES (?, 2)').run(nested);
  fenceSession(seedDecision({ sessionId: nested }), nested);
  // The participant read arm resolves the subdirectory through findOwningProject (ADR-172);
  // the writer check must use the same resolver, not the exact project_path lookup.
  process.env.PROJECT_MEMBERSHIP_ENFORCE = '1';
  try {
    const view = await call('GET', `/api/sessions/${nested}/permission-fence`);
    assert.equal(view.status, 200);
    assert.equal(view.body.canAcknowledge, true);
    assert.equal((await ack(OUTSIDER, '/api/sessions', nested)).status, 404, 'non-member cannot even see it');
    const lifted = await ack(WRITER, '/api/sessions', nested);
    assert.equal(lifted.status, 200);
    assert.deepEqual(lifted.body, { lifted: true });
  } finally { delete process.env.PROJECT_MEMBERSHIP_ENFORCE; }
});

test('an unverified (platform) actor may read but never acknowledge (qa M2)', async () => {
  fenceSession(seedDecision());
  const platform: TestUser = { ...WRITER, authenticationKind: 'platform_unverified' };
  assert.equal((await call('GET', `/api/sessions/${SESSION}/permission-fence`, platform)).status, 200);
  const refused = await ack(platform);
  assert.equal(refused.status, 403);
  assert.equal(refused.body.code, 'unverified_actor');
  assert.ok(fenceRow());
  clearFences();
});

test('404/403 probes cannot drain the per-session or global buckets (qa M3)', async () => {
  for (let i = 0; i < 5; i += 1) {
    assert.equal((await ack(OUTSIDER, '/shared/sessions', `ghost-${i}`)).status, 404);
    assert.equal((await ack(OUTSIDER, '/shared/sessions')).status, 403);
  }
  assert.equal((await ack(WRITER, '/shared/sessions')).status, 200);
  assert.equal((await ack(WRITER, '/shared/sessions')).status, 200);
  assert.equal((await ack(WRITER, '/shared/sessions')).status, 429, 'writers still share the bounded buckets');
});

test('a torn fence journal can never be proven (409 not_provable) and hides owner history', async () => {
  fenceSession(seedDecision());
  await appendFile(`${process.env.DATABASE_PATH}.fence-lifts.jsonl`, '{"event":"lift_intent"');
  const refused = await ack();
  assert.equal(refused.status, 409);
  assert.equal(refused.body.reason, 'not_provable');
  assert.ok(fenceRow());
  assert.equal(describeFences(db).recentAcknowledgementsAvailable, false);
});
