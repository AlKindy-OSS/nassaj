import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { closeConnection } from '@/modules/database/connection.js';
import { initializeDatabase } from '@/modules/database/init-db.js';
import { appConfigDb } from '@/modules/database/repositories/app-config.js';

import {
  EngineRestampIntentError,
  canonicalizeEngineRestampIntent,
  engineRestampIntentsDb,
  engineRestampRequestSha256,
  type EngineRestampIntent,
} from './engine-restamp-intent.db.js';
import {
  insertRawEngineRestampIntentFixture,
  seedRawEngineRestampIntentFixtures,
} from './engine-restamp-intent.test-harness.js';

function fixture(sessionId = 'session-a'): EngineRestampIntent {
  const intent = {
    schema: 'nassaj-engine-restamp-intent/v1', operationId: '123e4567-e89b-42d3-a456-426614174000', sessionId,
    ownerProcess: { uid: 1000, pid: 42, bootId: '12345678-1234-1234-1234-123456789012', startTicks: '123' },
    actor: { kind: 'device', userId: 7, authorizationGeneration: 3, deviceSessionId: 'device-a', slotId: 'slot-a', deviceGeneration: 9 },
    projectBinding: { kind: 'project', projectId: 'project-a', participantUserId: 7, controllerUserId: 7, authorityFenceSha256: 'a'.repeat(64) },
    fromPin: { engine: 'glm', source: 'server_verdict' }, toPin: { engine: 'anthropic', source: 'user_switch' },
    fromModel: { changed: true, model: 'old-model' }, toModel: { changed: true, model: 'new-model' },
    turnsExported: 1, acknowledgedExport: true, phase: 'prepared', revision: 1,
    requestSha256: '0'.repeat(64), createdAt: '2026-09-24T12:00:00.000Z',
  } as EngineRestampIntent;
  intent.requestSha256 = engineRestampRequestSha256(intent);
  return intent;
}

test('strict engine-restamp intent insert, CAS and delete retain exact canonical value', async () => {
  const root = await mkdtemp('/var/tmp/nassaj-engine-intent-');
  closeConnection(); process.env.DATABASE_PATH = path.join(root, 'db.sqlite'); await initializeDatabase();
  try {
    const initial = fixture();
    const canonical = engineRestampIntentsDb.prepare(initial);
    assert.equal(engineRestampIntentsDb.read(initial.sessionId)?.canonical, canonical);
    assert.throws(() => engineRestampIntentsDb.prepare(initial), (error: unknown) =>
      error instanceof EngineRestampIntentError && error.code === 'ENGINE_RESTAMP_INTENT_CONFLICT');
    const next = { ...initial, phase: 'target_observed', revision: 2 } as EngineRestampIntent;
    const nextCanonical = engineRestampIntentsDb.compareAndSet(initial.sessionId, canonical, next);
    assert.equal(engineRestampIntentsDb.read(initial.sessionId)?.intent.phase, 'target_observed');
    assert.throws(() => engineRestampIntentsDb.deleteExact(initial.sessionId, canonical));
    engineRestampIntentsDb.deleteExact(initial.sessionId, nextCanonical);
    assert.equal(engineRestampIntentsDb.has(initial.sessionId), false);
  } finally { closeConnection(); delete process.env.DATABASE_PATH; await rm(root, { recursive: true, force: true }); }
});

test('reserved prefix and strict canonical validation fail closed', async () => {
  const root = await mkdtemp('/var/tmp/nassaj-engine-reserved-');
  closeConnection(); process.env.DATABASE_PATH = path.join(root, 'db.sqlite'); await initializeDatabase();
  try {
    assert.throws(() => appConfigDb.set(`engine_restamp.v1:${'a'.repeat(64)}`, '{}'), /APP_CONFIG_RESERVED_PREFIX/);
    assert.throws(() => appConfigDb.delete(`engine_restamp.v1:${'a'.repeat(64)}`), /APP_CONFIG_RESERVED_PREFIX/);
    appConfigDb.set('ordinary.fixture', '1');
    assert.equal(appConfigDb.delete('ordinary.fixture'), true);
    const valid = fixture('session-b');
    const reordered = { ...valid, actor: { ...valid.actor } } as EngineRestampIntent;
    assert.equal(engineRestampRequestSha256(valid), engineRestampRequestSha256(reordered));
    assert.throws(() => canonicalizeEngineRestampIntent({ ...valid, extra: true } as never),
      (error: unknown) => error instanceof EngineRestampIntentError);
    assert.throws(() => canonicalizeEngineRestampIntent({ ...valid, requestSha256: 'b'.repeat(64) }),
      (error: unknown) => error instanceof EngineRestampIntentError);
  } finally { closeConnection(); delete process.env.DATABASE_PATH; await rm(root, { recursive: true, force: true }); }
});

test('raw stored values are bounded and typed before JSON parsing', async () => {
  const root = await mkdtemp('/var/tmp/nassaj-engine-read-bound-');
  closeConnection(); process.env.DATABASE_PATH = path.join(root, 'db.sqlite'); await initializeDatabase();
  try {
    insertRawEngineRestampIntentFixture('exact-bound', ' '.repeat(8192));
    assert.throws(() => engineRestampIntentsDb.read('exact-bound'), (error: unknown) =>
      error instanceof EngineRestampIntentError && error.code === 'ENGINE_RESTAMP_INTENT_MALFORMED');
    insertRawEngineRestampIntentFixture('over-bound', ' '.repeat(8193));
    assert.throws(() => engineRestampIntentsDb.read('over-bound'), (error: unknown) =>
      error instanceof EngineRestampIntentError && error.code === 'ENGINE_RESTAMP_INTENT_TOO_LARGE');
    insertRawEngineRestampIntentFixture('non-text', Buffer.from('{}'));
    assert.throws(() => engineRestampIntentsDb.read('non-text'), (error: unknown) =>
      error instanceof EngineRestampIntentError && error.code === 'ENGINE_RESTAMP_INTENT_MALFORMED');
  } finally { closeConnection(); delete process.env.DATABASE_PATH; await rm(root, { recursive: true, force: true }); }
});

test('reserved intent count admits 1024 and rejects 1025', async () => {
  const root = await mkdtemp('/var/tmp/nassaj-engine-count-bound-');
  closeConnection(); process.env.DATABASE_PATH = path.join(root, 'db.sqlite'); await initializeDatabase();
  try {
    seedRawEngineRestampIntentFixtures(1023);
    engineRestampIntentsDb.prepare(fixture('intent-1024'));
    assert.throws(() => engineRestampIntentsDb.prepare(fixture('intent-1025')), (error: unknown) =>
      error instanceof EngineRestampIntentError && error.code === 'ENGINE_RESTAMP_INTENT_LIMIT');
  } finally { closeConnection(); delete process.env.DATABASE_PATH; await rm(root, { recursive: true, force: true }); }
});

test('captured authority and process identities must be positive', () => {
  const cases = [
    { actor: { ...fixture().actor, userId: 0 } },
    { actor: { ...fixture().actor, authorizationGeneration: 0 } },
    { actor: { ...fixture().actor, deviceGeneration: 0 } },
    { projectBinding: { ...fixture().projectBinding, participantUserId: 0 } },
    { projectBinding: { ...fixture().projectBinding, controllerUserId: 0 } },
    { ownerProcess: { ...fixture().ownerProcess, pid: 0 } },
    { ownerProcess: { ...fixture().ownerProcess, startTicks: '0' } },
  ];
  for (const change of cases) {
    const invalid = { ...fixture(), ...change } as EngineRestampIntent;
    assert.throws(() => canonicalizeEngineRestampIntent(invalid), (error: unknown) =>
      error instanceof EngineRestampIntentError);
  }
});
