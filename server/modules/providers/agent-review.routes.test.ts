import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import Database from 'better-sqlite3';
import express from 'express';

import { AgentReviewError, applyAgentReviewSchema, AgentReviewIngestionRepository, apiKeysDb, userDb } from '../database/index.js';
import { createAuthenticatedLaunchActor, isAuthenticatedLaunchActorCurrent, type AuthenticatedLaunchActor } from '../execution-permissions/index.js';

import { createAgentReviewRouter } from './agent-review.routes.js';
import type { ReviewAccessSeams } from './services/agent-review-http-authority.js';

const generation = 'a'.repeat(64); const container = 'b'.repeat(64);
const endpoint = '/sessions/s/agent-reviews';
const command = { source: 'workflow', resultGeneration: generation, action: 'start_review', expectedRevision: 0, idempotencyKey: 'key-1' };
const ROOT = fileURLToPath(new URL('../../../', import.meta.url));

type Control = { actor: number; kind: string; missingPrincipal: boolean; read: boolean; write: boolean;
  live: boolean; projectPath: string; identityChecks: number; failAt: number; afterCapture?: () => void; actorCurrent?: (actor: AuthenticatedLaunchActor) => boolean };
type Context = { db: Database.Database; control: Control; call: (method?: string, body?: unknown, suffix?: string) => Promise<{ status: number; data: any }>;
  second: () => Database.Database };

function seed(db: Database.Database, source = 'workflow', gen = generation, sequence = 1): void {
  db.prepare('INSERT INTO agent_review_results VALUES (?,?,?,?,?,?,?,?,?,?)').run('s', source, 'agent-1', gen, container, sequence,
    'c'.repeat(64), 'd'.repeat(64), 'e'.repeat(64), '2026-09-24T00:00:00.000Z');
  db.prepare("INSERT INTO agent_review_states VALUES (?,?,?,?,'awaiting_review',0,NULL,NULL,NULL)").run('s', source, 'agent-1', gen);
  db.prepare('INSERT INTO agent_review_current VALUES (?,?,?,?,?,?,0,?)').run('s', source, 'agent-1', gen, container, sequence, '2026-09-24T00:00:00.000Z');
}

async function fixture(run: (context: Context) => Promise<void>): Promise<void> {
  const artifacts = path.join(ROOT, '.artifacts'); await fs.mkdir(artifacts, { recursive: true });
  const directory = await fs.mkdtemp(path.join(artifacts, 'c4-http-')); const dbPath = path.join(directory, 'fixture.db');
  const db = new Database(dbPath, { timeout: 0 }); db.pragma('foreign_keys=ON');
  db.transaction(() => applyAgentReviewSchema(db)).immediate();
  db.exec("CREATE TABLE session_participants(session_id TEXT,user_id INTEGER,role TEXT,attribution TEXT); INSERT INTO session_participants VALUES ('s',1,'owner','spawn')");
  seed(db);
  const control: Control = { actor: 1, kind: 'session', missingPrincipal: false, read: true, write: true,
    live: true, projectPath: '/project', identityChecks: 0, failAt: Infinity };
  const seams: ReviewAccessSeams = {
    connection: () => db, actorCurrent: actor => control.live && (control.actorCurrent?.(actor) ?? true),
    session: (sessionId, _actor, mode) => {
      if (sessionId !== 's' || !control.read || (mode === 'write' && !control.write)) throw new AgentReviewError('session_not_found');
      return { provider: 'claude', project_path: control.projectPath };
    }, capture: () => { control.afterCapture?.(); return null; }, current: () => true,
  };
  const app = express(); app.use(express.json({ limit: '64kb' }));
  app.use((request, _response, next) => {
    const req = request as express.Request & { user: object; authenticatedPrincipal?: object; assertCurrentIdentity: () => boolean };
    req.user = { id: control.actor, role: control.actor === 1 ? 'user' : 'admin', status: 'active',
      authenticationKind: control.kind, authorizationGeneration: 1,
      ...(control.kind === 'ck' ? { authenticationCredentialId: 'api-key:7' } : {}),
      ...(control.kind === 'device_session' ? { deviceSessionId: 'device', slotId: 'slot', deviceGeneration: 1 } : {}) };
    if (!control.missingPrincipal) req.authenticatedPrincipal = Object.freeze(control.kind === 'ck'
      ? createAuthenticatedLaunchActor(req.user) : { kind: control.kind === 'session' ? 'jwt' : control.kind,
        userId: control.actor, authorizationGeneration: 1,
        ...(control.kind === 'device_session' ? { deviceSessionId: 'device', slotId: 'slot', deviceGeneration: 1 } : {}) });
    req.assertCurrentIdentity = () => ++control.identityChecks < control.failAt;
    next();
  });
  app.use(createAgentReviewRouter(db, seams));
  const server = app.listen(0, '127.0.0.1'); await new Promise<void>(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try { await run({ db, control, second: () => new Database(dbPath, { timeout: 0 }), call: async (method = 'GET', body, suffix = '') => {
    control.identityChecks = 0;
    const response = await fetch(base + endpoint + suffix, { method, headers: { 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, data: await response.json() };
  } }); }
  finally { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    db.close(); await fs.rm(directory, { recursive: true, force: true }); }
}

const patch = (ctx: Context, body: unknown = command) => ctx.call('PATCH', body, '/agent-1');
function receipts(db: Database.Database): number { return (db.prepare('SELECT COUNT(*) AS n FROM agent_review_receipts').get() as { n: number }).n; }

test('GET durable DTO, pagination and quarantine including empty-result scope perform zero writes', async () => fixture(async ctx => {
  const { db, call } = ctx;
  new AgentReviewIngestionRepository(db).recordIncident({ sessionId: 's', source: 'agent', sourceContainerId: 'f'.repeat(64), scope: 'container',
    scopeAgentId: '', reason: 'invalid_shape', lastCommittedOffset: 0, lastCommittedPrefixSha256: createHash('sha256').update('').digest('hex'),
    attemptEvidenceSha256: '0'.repeat(64), observation: { phase: 'preopen', failure: 'open_failed' } });
  const before = db.prepare('SELECT total_changes() AS n').get();
  const response = await call('GET', undefined, '?limit=1&incidentLimit=1');
  assert.equal(response.status, 200); assert.equal(response.data.canReview, true);
  assert.equal(response.data.availability, 'unavailable'); assert.equal(response.data.incidents.length, 1);
  assert.equal(response.data.rows[0].readOnly, false);
  assert.deepEqual(db.prepare('SELECT total_changes() AS n').get(), before);
  assert.equal((await call('GET', undefined, '?limit=101')).status, 400);
  assert.equal((await call('GET', undefined, '?completion=forged')).status, 400);
}));

test('PATCH exact replay precedes stale revision/generation; changed fingerprint conflicts with no partial writes', async () => fixture(async ctx => {
  assert.equal((await patch(ctx)).status, 200);
  assert.equal((await patch(ctx, { ...command, action: 'approve', expectedRevision: 1, idempotencyKey: 'key-2' })).status, 200);
  const newer = 'f'.repeat(64);
  ctx.db.prepare('INSERT INTO agent_review_results VALUES (?,?,?,?,?,?,?,?,?,?)').run('s', 'workflow', 'agent-1', newer, container, 2,
    '1'.repeat(64), '2'.repeat(64), '3'.repeat(64), '2026-09-24T00:00:01.000Z');
  ctx.db.prepare("INSERT INTO agent_review_states VALUES (?,?,?,?,'awaiting_review',0,NULL,NULL,NULL)").run('s', 'workflow', 'agent-1', newer);
  ctx.db.prepare("UPDATE agent_review_current SET result_generation=?,source_sequence=2,pointer_revision=1,selected_at='2026-09-24T00:00:01.000Z'").run(newer);
  const before = ctx.db.prepare('SELECT total_changes() AS n').get();
  const replay = await patch(ctx); assert.equal(replay.status, 200); assert.equal(replay.data.revision, 1);
  assert.deepEqual(ctx.db.prepare('SELECT total_changes() AS n').get(), before);
  assert.equal((await patch(ctx, { ...command, action: 'reject' })).data.error.code, 'idempotency_conflict');
  assert.equal(receipts(ctx.db), 2);
}));

test('admin role, missing/ambiguous spawn owner and read-only mandate cannot mutate', async () => fixture(async ctx => {
  ctx.control.actor = 2;
  assert.equal((await ctx.call()).data.canReview, false); assert.equal((await patch(ctx)).status, 403);
  ctx.control.actor = 1; ctx.control.write = false;
  assert.equal((await ctx.call()).data.canReview, false); assert.equal((await patch(ctx)).status, 404);
  ctx.control.write = true;
  ctx.db.exec("INSERT INTO session_participants VALUES ('s',2,'owner','spawn')");
  assert.equal((await patch(ctx)).status, 403); assert.equal(receipts(ctx.db), 0);
}));

for (const kind of ['session', 'device_session', 'ck']) {
  test(`${kind} current identity succeeds; revoke/rotation after capture fails before receipt`, async () => fixture(async ctx => {
    ctx.control.kind = kind;
    ctx.control.afterCapture = () => queueMicrotask(() => { ctx.control.live = false; });
    const before = ctx.db.prepare('SELECT total_changes() AS n').get();
    assert.equal((await patch(ctx)).data.error.code, 'identity_changed');
    assert.equal(receipts(ctx.db), 0); assert.deepEqual(ctx.db.prepare('SELECT total_changes() AS n').get(), before);
    ctx.control.afterCapture = undefined; ctx.control.live = true;
    assert.equal((await patch(ctx)).status, 200);
  }));
}

test('missing or unverified principal denied even with an identity callback returning true', async () => fixture(async ctx => {
  ctx.control.missingPrincipal = true; assert.equal((await patch(ctx)).data.error.code, 'identity_changed');
  ctx.control.missingPrincipal = false; ctx.control.kind = 'platform_unverified';
  assert.equal((await patch(ctx)).data.error.code, 'identity_changed'); assert.equal(receipts(ctx.db), 0);
}));

test('project rebind after await and identity loss before disclosure are fenced', async () => fixture(async ctx => {
  ctx.control.afterCapture = () => queueMicrotask(() => { ctx.control.projectPath = '/new-project'; });
  assert.equal((await patch(ctx)).data.error.code, 'project_access_changed'); assert.equal(receipts(ctx.db), 0);
  ctx.control.afterCapture = undefined; ctx.control.projectPath = '/project'; ctx.control.failAt = 4;
  const late = await patch(ctx);
  assert.deepEqual(late.data.error, { code: 'identity_changed', notStarted: false, effectState: 'outcome_unknown' });
  assert.equal(receipts(ctx.db), 1, 'late refusal does not misrepresent an already committed mutation');
}));

test('real second-connection SQLITE_BUSY maps fixed 409 with no mutation replay or SQL detail', async () => fixture(async ctx => {
  const other = ctx.second(); other.exec('BEGIN IMMEDIATE');
  try {
    const response = await patch(ctx); assert.equal(response.status, 409);
    assert.deepEqual(response.data, { error: { code: 'review_conflict' } }); assert.equal(receipts(ctx.db), 0);
  } finally { other.exec('ROLLBACK'); other.close(); }
}));

test('strict body, external read-only and unavailable generation reject without a receipt', async () => fixture(async ctx => {
  assert.equal((await patch(ctx, { ...command, actor: 1 })).status, 400);
  seed(ctx.db, 'external');
  assert.equal((await patch(ctx, { ...command, source: 'external' })).data.error.code, 'immutable_source');
  const row = (await ctx.call()).data.rows.find((value: any) => value.source === 'external'); assert.equal(row.readOnly, true);
  new AgentReviewIngestionRepository(ctx.db).recordIncident({ sessionId: 's', source: 'workflow', sourceContainerId: container,
    scope: 'identity', scopeAgentId: 'agent-1', reason: 'invalid_shape', lastCommittedOffset: 0,
    lastCommittedPrefixSha256: createHash('sha256').update('').digest('hex'), attemptEvidenceSha256: '0'.repeat(64), observation: { phase: 'preopen', failure: 'open_failed' } });
  assert.equal((await patch(ctx)).data.error.code, 'unavailable'); assert.equal(receipts(ctx.db), 0);
}));


for (const change of ['credential_revoked', 'authorization_generation_rotated']) {
  test(`CK canonical current checker denies ${change} with zero writes or receipt`, async t => fixture(async ctx => {
    ctx.control.kind = 'ck'; let keyLive = true; let currentGeneration = 1; let keyChecks = 0;
    t.mock.method(userDb, 'isAuthorizationPrincipalCurrent', (id: number, generation: number) => id === 1 && generation === currentGeneration);
    t.mock.method(apiKeysDb, 'isAuthenticationPrincipalCurrent', (id: number, user: number, generation: number) => {
      keyChecks++; assert.equal(id, 7); assert.equal(user, 1); assert.equal(generation, 1); return keyLive;
    });
    ctx.control.actorCurrent = isAuthenticatedLaunchActorCurrent;
    ctx.control.afterCapture = () => queueMicrotask(() => { if (change === 'credential_revoked') keyLive = false; else currentGeneration = 2; });
    const before = ctx.db.prepare('SELECT total_changes() AS n').get();
    assert.equal((await patch(ctx)).data.error.code, 'identity_changed');
    assert.ok(keyChecks >= 1); assert.equal(receipts(ctx.db), 0);
    assert.deepEqual(ctx.db.prepare('SELECT total_changes() AS n').get(), before);
  }));
}

test('two requests with the same revision produce one winner and one stale conflict', async () => fixture(async ctx => {
  const responses = await Promise.all([patch(ctx), patch(ctx, { ...command, idempotencyKey: 'competing-key' })]);
  assert.deepEqual(responses.map(response => response.status).sort(), [200, 409]);
  assert.equal(responses.find(response => response.status === 409)?.data.error.code, 'stale_revision');
  assert.equal(receipts(ctx.db), 1);
  assert.deepEqual(ctx.db.prepare('SELECT COUNT(*) AS n FROM agent_review_events').get(), { n: 1 });
}));
