import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, mock, test } from 'node:test';

import type { EngineRestampIntent } from './engine-restamp-intent.db.js';

const root = fs.mkdtempSync('/var/tmp/nassaj-e4-settlement-');
const priorDb = process.env.DATABASE_PATH;
const priorWorkspace = process.env.WORKSPACES_ROOT;
const priorMembership = process.env.PROJECT_MEMBERSHIP_ENFORCE;
const fixtureDatabasePath = path.join(root, 'db.sqlite');
fs.writeFileSync(fixtureDatabasePath, '', { flag: 'wx', mode: 0o600 });
assert.equal(fs.statSync(fixtureDatabasePath).mode & 0o777, 0o600);
process.env.DATABASE_PATH = fixtureDatabasePath;
process.env.WORKSPACES_ROOT = root;
process.env.PROJECT_MEMBERSHIP_ENFORCE = '1';

const legacyAccessAttempts: string[] = [];
const existsSync = fs.existsSync;
mock.method(fs, 'existsSync', candidate => {
  if (String(candidate).endsWith('/database/auth.db')) {
    legacyAccessAttempts.push(`exists:${String(candidate)}`);
    throw new Error('engine-restamp fixture forbids legacy database reads');
  }
  return existsSync(candidate);
});
mock.method(fs, 'copyFileSync', (source, destination) => {
  legacyAccessAttempts.push(`copy:${String(source)}:${String(destination)}`);
  throw new Error('engine-restamp fixture forbids legacy database copies');
});

const database = await import('@/modules/database/index.js');
const access = await import('@/modules/database/repositories/project-access.js');
const settlement = await import('./engine-restamp-settlement.db.js');
const authority = await import('./engine-restamp-authority.js');
await database.initializeDatabase();
assert.deepEqual(legacyAccessAttempts, []);
mock.restoreAll();

after(() => {
  mock.restoreAll();
  database.closeConnection();
  if (priorDb === undefined) delete process.env.DATABASE_PATH; else process.env.DATABASE_PATH = priorDb;
  if (priorWorkspace === undefined) delete process.env.WORKSPACES_ROOT; else process.env.WORKSPACES_ROOT = priorWorkspace;
  if (priorMembership === undefined) delete process.env.PROJECT_MEMBERSHIP_ENFORCE;
  else process.env.PROJECT_MEMBERSHIP_ENFORCE = priorMembership;
  fs.rmSync(root, { recursive: true, force: true });
});

let sequence = 0;
type ActorKind = 'jwt' | 'device' | 'ck';

function createFixture(kind: ActorKind = 'jwt', actorOwnsProject = false) {
  sequence += 1;
  const suffix = String(sequence);
  const creator = database.userDb.createUser(`creator_${suffix}`, 'hash', 'user').id;
  const controller = database.userDb.createUser(`controller_${suffix}`, 'hash', 'user').id;
  const actorUser = database.userDb.createUser(`actor_${suffix}`, 'hash', 'user').id;
  const projectPath = fs.mkdtempSync(path.join(root, `project-${suffix}-`));
  const project = database.projectsDb.createProjectPath(projectPath, null, creator).project!;
  database.projectMembersDb.addAndRotateProjectAccess(project.project_id, actorUser, 'member', creator);
  if (actorOwnsProject) {
    database.getConnection().prepare('UPDATE projects SET created_by = ? WHERE project_id = ?')
      .run(actorUser, project.project_id);
    database.getConnection().prepare('DELETE FROM project_members WHERE project_id = ? AND user_id = ?')
      .run(project.project_id, actorUser);
  }
  const sessionId = `session-${suffix}`;
  database.sessionsDb.createSession(sessionId, 'claude', projectPath);
  database.participantsDb.recordSpawn(sessionId, controller, { provider: 'claude', projectPath });
  database.participantsDb.recordSpawn(sessionId, actorUser, { provider: 'claude', projectPath });
  const db = database.getConnection();
  db.prepare(`UPDATE sessions SET engine_provider = 'anthropic',
    engine_provider_source = 'server_verdict' WHERE session_id = ?`).run(sessionId);
  const user = database.userDb.getRawById(actorUser)!;
  let actor: EngineRestampIntent['actor'] = {
    kind: 'jwt', userId: actorUser, authorizationGeneration: user.authorization_generation,
  };
  if (kind === 'device') {
    const deviceSessionId = `device-${suffix}`, slotId = `slot-${suffix}`, now = Date.now();
    db.prepare(`INSERT INTO device_sessions(id,secret_hash,expires_at,revoked_at,active_slot_id,generation,created_at)
      VALUES(?,?,?,NULL,NULL,1,?)`).run(deviceSessionId, `secret-${suffix}`, now + 60_000, now);
    db.prepare(`INSERT INTO device_account_slots(id,device_session_id,user_id,created_at,last_used_at,password_stamp,revoked_at)
      VALUES(?,?,?,?,?,?,NULL)`).run(slotId, deviceSessionId, actorUser, now, now, user.password_changed_at);
    db.prepare('UPDATE device_sessions SET active_slot_id = ? WHERE id = ?').run(slotId, deviceSessionId);
    actor = { kind: 'device', userId: actorUser, authorizationGeneration: user.authorization_generation,
      deviceSessionId, slotId, deviceGeneration: 1 };
  } else if (kind === 'ck') {
    const key = db.prepare(`INSERT INTO api_keys(user_id,key_name,key_digest,key_prefix,is_active)
      VALUES(?,?,?,?,1)`).run(actorUser, `key-${suffix}`, `digest-${suffix}`, `prefix-${suffix}`);
    const currentGeneration = database.userDb.getRawById(actorUser)!.authorization_generation;
    actor = { kind: 'ck', userId: actorUser, authorizationGeneration: currentGeneration,
      authenticationCredentialId: `api-key:${Number(key.lastInsertRowid)}` };
  }
  const fence = access.captureWorkspaceTopologyFence(projectPath, actorUser, {
    sessionId, consent: 'control',
  })!;
  const captured = authority.captureEngineRestampAuthority({ sessionId, actor,
    workspaceFence: fence, controllerUserId: controller });
  const prepared = {
    schema: 'nassaj-engine-restamp-intent/v1', operationId: `123e4567-e89b-42d3-a456-${suffix.padStart(12, '0')}`,
    sessionId, ownerProcess: { uid: process.getuid(), pid: process.pid,
      bootId: '12345678-1234-1234-1234-123456789012', startTicks: '1' },
    actor, projectBinding: captured.projectBinding,
    fromPin: { engine: 'anthropic', source: 'server_verdict' },
    toPin: { engine: 'openai', source: 'user_switch' },
    fromModel: { changed: false, model: null }, toModel: { changed: true, model: 'gpt-5' },
    turnsExported: 1, acknowledgedExport: true, phase: 'prepared', revision: 1,
    requestSha256: '0'.repeat(64), createdAt: '2026-09-24T12:00:00.000Z',
  } as EngineRestampIntent;
  prepared.requestSha256 = database.engineRestampRequestSha256(prepared);
  const firstCanonical = database.engineRestampIntentsDb.prepare(prepared);
  const intent = { ...prepared, phase: 'target_observed', revision: 2 } as EngineRestampIntent;
  const canonical = database.engineRestampIntentsDb.compareAndSet(sessionId, firstCanonical, intent);
  return { db, actorUser, controller, project, sessionId, captured, intent, canonical };
}

function assertBlocked(
  fixture: ReturnType<typeof createFixture>,
  expectedPin = { engine: 'anthropic', source: 'server_verdict' },
  expectedCanonical = fixture.canonical,
): void {
  assert.throws(() => settlement.commitEngineRestampTarget(
    fixture.captured, fixture.intent, fixture.canonical));
  assert.deepEqual(database.sessionsDb.getSessionEnginePin(fixture.sessionId), expectedPin);
  assert.equal(database.engineRestampIntentsDb.read(fixture.sessionId)?.canonical, expectedCanonical);
  const audits = fixture.db.prepare(`SELECT COUNT(*) AS count FROM audit_log
    WHERE action = 'engine_restamped' AND metadata LIKE ?`).get(`%${fixture.intent.operationId}%`) as { count: number };
  assert.equal(audits.count, 0);
}

function withRequestDigest(intent: EngineRestampIntent): EngineRestampIntent {
  const next = structuredClone(intent);
  next.requestSha256 = database.engineRestampRequestSha256(next);
  return next;
}

function assertRollbackBlocked(
  fixture: ReturnType<typeof createFixture>,
  intent: EngineRestampIntent,
): void {
  assert.throws(() => settlement.settleEngineRestampRollback(
    intent, fixture.canonical, settlement.UNKNOWN_ENGINE_RESTAMP_ROLLBACK_REASON));
  assert.deepEqual(database.sessionsDb.getSessionEnginePin(fixture.sessionId), {
    engine: 'anthropic', source: 'server_verdict',
  });
  assert.equal(database.engineRestampIntentsDb.read(fixture.sessionId)?.canonical, fixture.canonical);
  const audits = fixture.db.prepare(`SELECT COUNT(*) AS count FROM audit_log
    WHERE action = 'engine_pin_decision' AND metadata LIKE ?`).get(
    `%${fixture.intent.operationId}%`) as { count: number };
  assert.equal(audits.count, 0);
}

test('target pin, strict audit and exact intent deletion commit atomically', () => {
  const fixture = createFixture();
  assert.equal(settlement.commitEngineRestampTarget(fixture.captured, fixture.intent, fixture.canonical), undefined);
  assert.deepEqual(database.sessionsDb.getSessionEnginePin(fixture.sessionId), {
    engine: 'openai', source: 'user_switch',
  });
  assert.equal(database.engineRestampIntentsDb.has(fixture.sessionId), false);
  const audit = fixture.db.prepare(`SELECT action FROM audit_log WHERE action = 'engine_restamped'
    AND metadata LIKE ?`).get(`%${fixture.intent.operationId}%`);
  assert.ok(audit);
});

test('JWT generation revocation after capture rolls the entire target settlement back', async () => {
  const fixture = createFixture();
  await Promise.resolve();
  fixture.db.prepare('UPDATE users SET authorization_generation = authorization_generation + 1 WHERE id = ?')
    .run(fixture.actorUser);
  assertBlocked(fixture);
});

test('device generation and active-slot dimensions are exact', () => {
  const fixture = createFixture('device');
  fixture.db.prepare('UPDATE device_sessions SET generation = generation + 1 WHERE id = ?')
    .run((fixture.intent.actor as Extract<EngineRestampIntent['actor'], { kind: 'device' }>).deviceSessionId);
  assertBlocked(fixture);
});

test('device active slot and revocation dimensions are exact', () => {
  const slot = createFixture('device');
  const actor = slot.intent.actor as Extract<EngineRestampIntent['actor'], { kind: 'device' }>;
  const other = database.userDb.getRawById(slot.controller)!;
  const replacement = `replacement-${slot.sessionId}`; const now = Date.now();
  slot.db.prepare(`INSERT INTO device_account_slots(id,device_session_id,user_id,created_at,last_used_at,password_stamp,revoked_at)
    VALUES(?,?,?,?,?,?,NULL)`).run(replacement, actor.deviceSessionId, slot.controller, now, now, other.password_changed_at);
  slot.db.prepare('UPDATE device_sessions SET active_slot_id = ? WHERE id = ?')
    .run(replacement, actor.deviceSessionId);
  assertBlocked(slot);

  const revoked = createFixture('device');
  const revokedActor = revoked.intent.actor as Extract<EngineRestampIntent['actor'], { kind: 'device' }>;
  revoked.db.prepare('UPDATE device_sessions SET revoked_at = ? WHERE id = ?')
    .run(Date.now(), revokedActor.deviceSessionId);
  assertBlocked(revoked);
});

test('CK credential must remain the exact active key', () => {
  const fixture = createFixture('ck');
  const credential = (fixture.intent.actor as Extract<EngineRestampIntent['actor'], { kind: 'ck' }>).authenticationCredentialId;
  fixture.db.prepare('UPDATE api_keys SET is_active = 0 WHERE id = ?').run(Number(credential.split(':')[1]));
  assertBlocked(fixture);
});

test('participant and controller rows are independently required', () => {
  const participant = createFixture();
  participant.db.prepare('DELETE FROM session_participants WHERE session_id = ? AND user_id = ?')
    .run(participant.sessionId, participant.actorUser);
  assertBlocked(participant);
  const controller = createFixture();
  controller.db.prepare('DELETE FROM session_participants WHERE session_id = ? AND user_id = ?')
    .run(controller.sessionId, controller.controller);
  assertBlocked(controller);
});

test('the captured controller must remain the sole spawn owner', () => {
  const fixture = createFixture();
  fixture.db.exec('DROP INDEX idx_session_participants_single_owner');
  try {
    fixture.db.prepare(`UPDATE session_participants SET role = 'owner'
      WHERE session_id = ? AND user_id = ?`).run(fixture.sessionId, fixture.actorUser);
    assertBlocked(fixture);
  } finally {
    fixture.db.prepare(`UPDATE session_participants SET role = 'participant'
      WHERE session_id = ? AND user_id = ?`).run(fixture.sessionId, fixture.actorUser);
    fixture.db.exec(`CREATE UNIQUE INDEX idx_session_participants_single_owner
      ON session_participants(session_id) WHERE role = 'owner'`);
  }
});

test('the session remains a Claude session inside the final transaction', () => {
  const fixture = createFixture();
  fixture.db.prepare("UPDATE sessions SET provider = 'codex' WHERE session_id = ?")
    .run(fixture.sessionId);
  assertBlocked(fixture);
});

test('project fence revocation after an await cannot be replaced by residual session access', async () => {
  const fixture = createFixture();
  await Promise.resolve();
  assert.equal(database.projectMembersDb.removeAndRotateProjectAccess(
    fixture.project.project_id, fixture.actorUser), true);
  assertBlocked(fixture);
});

test('project creator authority is rechecked rather than inferred from the old capture', () => {
  const fixture = createFixture('jwt', true);
  fixture.db.prepare('UPDATE projects SET created_by = ? WHERE project_id = ?')
    .run(fixture.controller, fixture.project.project_id);
  assertBlocked(fixture);
});

test('stale pin and stale exact intent revision both fail before audit or delete', () => {
  const pin = createFixture();
  pin.db.prepare(`UPDATE sessions SET engine_provider = 'other' WHERE session_id = ?`).run(pin.sessionId);
  assertBlocked(pin, { engine: 'other', source: 'server_verdict' });
  const stale = createFixture();
  const next = { ...stale.intent, revision: 3 } as EngineRestampIntent;
  const nextCanonical = database.engineRestampIntentsDb.compareAndSet(stale.sessionId, stale.canonical, next);
  assertBlocked(stale, { engine: 'anthropic', source: 'server_verdict' }, nextCanonical);
});

test('commit and rollback reject every independently substituted intent field', () => {
  const substitutions: Array<readonly [string, (value: EngineRestampIntent) => EngineRestampIntent]> = [
    ['toPin', value => withRequestDigest({ ...value,
      toPin: { engine: 'substituted', source: 'user_switch' } })],
    ['toModel', value => withRequestDigest({ ...value,
      toModel: { changed: true, model: 'substituted' } })],
    ['operationId', value => ({ ...value,
      operationId: '223e4567-e89b-42d3-a456-426614174000' })],
    ['actor', value => withRequestDigest({ ...value,
      actor: { kind: 'jwt', userId: value.actor.userId + 1,
        authorizationGeneration: value.actor.authorizationGeneration } })],
    ['fromPin', value => withRequestDigest({ ...value,
      fromPin: { engine: 'substituted', source: 'server_verdict' } })],
    ['phase', value => ({ ...value, phase: 'prepared' })],
    ['revision', value => ({ ...value, revision: value.revision + 1 })],
  ];
  for (const [name, substitute] of substitutions) {
    const commit = createFixture();
    assert.throws(() => settlement.commitEngineRestampTarget(
      commit.captured, substitute(commit.intent), commit.canonical), undefined, `commit ${name}`);
    assert.deepEqual(database.sessionsDb.getSessionEnginePin(commit.sessionId), {
      engine: 'anthropic', source: 'server_verdict',
    });
    assert.equal(database.engineRestampIntentsDb.read(commit.sessionId)?.canonical, commit.canonical);
    const rollback = createFixture();
    assertRollbackBlocked(rollback, substitute(rollback.intent));
  }
});

test('audit failure rolls pin and intent deletion back in the same IMMEDIATE transaction', () => {
  const fixture = createFixture();
  fixture.db.exec(`CREATE TRIGGER fixture_engine_audit_fail BEFORE INSERT ON audit_log
    WHEN NEW.action = 'engine_restamped' BEGIN SELECT RAISE(ABORT, 'fixture_audit_fail'); END`);
  try { assertBlocked(fixture); }
  finally { fixture.db.exec('DROP TRIGGER fixture_engine_audit_fail'); }
});

test('exact intent delete failure rolls both target pin and success audit back', () => {
  const fixture = createFixture();
  fixture.db.exec(`CREATE TRIGGER fixture_engine_intent_delete_fail BEFORE DELETE ON app_config
    WHEN OLD.key LIKE 'engine_restamp.v1:%' BEGIN SELECT RAISE(ABORT, 'fixture_delete_fail'); END`);
  try { assertBlocked(fixture); }
  finally { fixture.db.exec('DROP TRIGGER fixture_engine_intent_delete_fail'); }
});

test('rollback settlement is exact, synchronous and preserves the pin', () => {
  const fixture = createFixture();
  assert.equal(settlement.settleEngineRestampRollback(
    fixture.intent, fixture.canonical, 'ENGINE_RESTAMP_TARGET_READBACK_MISMATCH'), undefined);
  assert.deepEqual(database.sessionsDb.getSessionEnginePin(fixture.sessionId), {
    engine: 'anthropic', source: 'server_verdict',
  });
  assert.equal(database.engineRestampIntentsDb.has(fixture.sessionId), false);
  const audit = fixture.db.prepare(`SELECT action FROM audit_log WHERE action = 'engine_pin_decision'
    AND metadata LIKE ?`).get(`%${fixture.intent.operationId}%`);
  assert.ok(audit);
});

test('rollback audit reason is allowlisted and never persists paths or tokens', () => {
  const fixture = createFixture();
  const sensitiveReason = 'ENOENT /home/user/private/model.json token=secret-value';
  settlement.settleEngineRestampRollback(fixture.intent, fixture.canonical, sensitiveReason);
  const row = fixture.db.prepare(`SELECT metadata FROM audit_log WHERE action = 'engine_pin_decision'
    AND metadata LIKE ?`).get(`%${fixture.intent.operationId}%`) as { metadata: string };
  assert.equal(row.metadata.includes('/home/user/private'), false);
  assert.equal(row.metadata.includes('secret-value'), false);
  assert.equal(row.metadata.includes(settlement.UNKNOWN_ENGINE_RESTAMP_ROLLBACK_REASON), true);
});

test('concrete settlement callbacks are non-thenable and expose no async continuation', () => {
  const fixture = createFixture();
  const ports = settlement.createEngineRestampDatabaseSettlement(fixture.captured);
  const result = ports.commitTarget({ intent: fixture.intent, canonical: fixture.canonical });
  assert.equal(result, undefined);
  assert.equal(typeof (result as unknown as { then?: unknown })?.then, 'undefined');
});
