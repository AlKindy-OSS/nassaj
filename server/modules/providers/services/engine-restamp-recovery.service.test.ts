import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, beforeEach, mock, test } from 'node:test';

import BetterSqlite3 from 'better-sqlite3';

import {
  createEngineRestampIntentRepository,
  engineRestampIntentKey,
  type EngineRestampIntent,
} from '@/modules/database/index.js';

const root = fs.mkdtempSync('/var/tmp/nassaj-engine-recovery-');
const previousDatabasePath = process.env.DATABASE_PATH;
const databasePath = path.join(root, 'db.sqlite');
fs.writeFileSync(databasePath, '', { flag: 'wx', mode: 0o600 });
assert.equal(fs.statSync(databasePath).mode & 0o777, 0o600);
process.env.DATABASE_PATH = databasePath;

const legacyAccessAttempts: string[] = [];
const existsSync = fs.existsSync;
mock.method(fs, 'existsSync', candidate => {
  if (String(candidate).endsWith('/database/auth.db')) {
    legacyAccessAttempts.push(`exists:${String(candidate)}`);
    throw new Error('engine-restamp recovery fixture forbids legacy database reads');
  }
  return existsSync(candidate);
});
mock.method(fs, 'copyFileSync', (source, destination) => {
  legacyAccessAttempts.push(`copy:${String(source)}:${String(destination)}`);
  throw new Error('engine-restamp recovery fixture forbids legacy database copies');
});

const database = await import('@/modules/database/index.js');
// eslint-disable-next-line boundaries/dependencies -- named harness is the reviewed reserved-prefix fixture writer.
const harness = await import('@/modules/database/repositories/engine-restamp-intent.test-harness.js');
const recovery = await import('./engine-restamp-recovery.service.js');
await database.initializeDatabase();
assert.deepEqual(legacyAccessAttempts, []);
mock.restoreAll();

after(() => {
  mock.restoreAll();
  database.closeConnection();
  if (previousDatabasePath === undefined) delete process.env.DATABASE_PATH;
  else process.env.DATABASE_PATH = previousDatabasePath;
  fs.rmSync(root, { recursive: true, force: true });
});

function intent(index: number): EngineRestampIntent {
  const value = {
    schema: 'nassaj-engine-restamp-intent/v1',
    operationId: `123e4567-e89b-42d3-a456-${String(index + 1).padStart(12, '0')}`,
    sessionId: `recovery-session-${String(index).padStart(4, '0')}`,
    ownerProcess: { uid: process.getuid(), pid: process.pid,
      bootId: '12345678-1234-1234-1234-123456789012', startTicks: '1' },
    actor: { kind: 'jwt' as const, userId: 1, authorizationGeneration: 1 },
    projectBinding: { kind: 'projectless' as const, workspaceId: '/fixture',
      authorityFenceSha256: 'a'.repeat(64) },
    fromPin: { engine: 'anthropic', source: 'server_verdict' },
    toPin: { engine: 'openai', source: 'user_switch' as const },
    fromModel: { changed: true, model: 'old-model' },
    toModel: { changed: true as const, model: 'new-model' },
    turnsExported: 0, acknowledgedExport: false,
    phase: 'target_observed' as const, revision: 2,
    requestSha256: '0'.repeat(64), createdAt: '2026-09-24T12:00:00.000Z',
  } satisfies EngineRestampIntent;
  value.requestSha256 = database.engineRestampRequestSha256(value);
  return value;
}

beforeEach(() => harness.clearRawEngineRestampIntentFixtures());

test('empty E5 inspection is clear and performs zero database writes', () => {
  const before = database.getConnection().prepare('SELECT total_changes() AS changes').get() as { changes: number };
  const clear = recovery.inspectEngineRestampStartupRecovery();
  const afterChanges = database.getConnection().prepare('SELECT total_changes() AS changes').get() as { changes: number };
  assert.deepEqual(clear, {
    status: 'clear', scope: 'healthy', observedIntentRows: 0, attemptableIntentRows: 0,
    unresolvedIntentRows: 0, canonicalIntentBytesRead: 0, modelBytesRead: 0,
    modelBytesWritten: 0, promotions: 0, databaseChanges: 0,
    elapsedMs: clear.elapsedMs, reasons: [],
  });
  assert.equal(afterChanges.changes, before.changes);
});

test('the 65th intent stays unresolved without model effects', () => {
  for (let index = 0; index < 65; index += 1) database.engineRestampIntentsDb.prepare(intent(index));
  const bounded = recovery.inspectEngineRestampStartupRecovery();
  assert.equal(bounded.status, 'blocked_degraded');
  assert.equal(bounded.scope, 'affected_sessions_only');
  assert.equal(bounded.observedIntentRows, 65);
  assert.equal(bounded.attemptableIntentRows, 64);
  assert.equal(bounded.unresolvedIntentRows, 65);
  assert.ok(bounded.canonicalIntentBytesRead <= 512 * 1024);
  assert.deepEqual({ reads: bounded.modelBytesRead, writes: bounded.modelBytesWritten,
    promotions: bounded.promotions }, { reads: 0, writes: 0, promotions: 0 });
  assert.deepEqual(bounded.reasons,
    ['intent_attempt_limit_reached', 'positive_recovery_authority_unavailable']);
  assert.equal(bounded.databaseChanges, 0);
});

test('only exact scan objects validate and duplicate session rows fail closed', () => {
  const canonical = database.engineRestampIntentsDb.prepare(intent(700));
  const candidate = database.engineRestampIntentsDb.scanRecoveryCandidates().candidates[0];
  assert.ok(candidate);
  assert.equal(database.engineRestampIntentsDb.validateRecoveryCandidate(candidate)?.canonical, canonical);
  assert.equal(database.engineRestampIntentsDb.validateRecoveryCandidate({ ...candidate }), null);
  harness.insertRawEngineRestampIntentKeyFixture('f'.repeat(64), canonical);
  assert.equal(database.engineRestampIntentsDb.validateRecoveryCandidate(candidate), null);
});

test('a scan candidate is bound to the exact database that emitted it', () => {
  const firstDb = new BetterSqlite3(':memory:');
  const secondDb = new BetterSqlite3(':memory:');
  try {
    for (const db of [firstDb, secondDb]) db.exec('CREATE TABLE app_config (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    const firstRepository = createEngineRestampIntentRepository(firstDb);
    const secondRepository = createEngineRestampIntentRepository(secondDb);
    const value = intent(701);
    const canonical = firstRepository.prepare(value);
    secondDb.prepare('INSERT INTO app_config(key,value) VALUES (?,?)')
      .run(engineRestampIntentKey(value.sessionId), canonical);
    const candidate = firstRepository.scanRecoveryCandidates().candidates[0];
    assert.ok(candidate);
    assert.equal(firstRepository.validateRecoveryCandidate(candidate)?.canonical, canonical);
    assert.equal(secondRepository.validateRecoveryCandidate(candidate), null);
  } finally {
    firstDb.close();
    secondDb.close();
  }
});

test('malformed and oversized intent values stay blocked without content effects', () => {
  harness.insertRawEngineRestampIntentFixture('malformed', '{');
  harness.insertRawEngineRestampIntentFixture('oversized', 'x'.repeat(8193));
  const malformed = recovery.inspectEngineRestampStartupRecovery();
  assert.equal(malformed.observedIntentRows, 2);
  assert.equal(malformed.attemptableIntentRows, 0);
  assert.equal(malformed.canonicalIntentBytesRead, 1);
  assert.ok(malformed.reasons.includes('intent_malformed'));
  assert.equal(malformed.reasons.at(-1), 'positive_recovery_authority_unavailable');
  assert.equal(malformed.databaseChanges, 0);
});

test('the 1025th metadata row degrades without materializing intent values', () => {
  harness.seedRawEngineRestampIntentFixtures(1025);
  const overflow = recovery.inspectEngineRestampStartupRecovery();
  assert.equal(overflow.observedIntentRows, 1025);
  assert.equal(overflow.attemptableIntentRows, 0);
  assert.equal(overflow.canonicalIntentBytesRead, 0);
  assert.deepEqual(overflow.reasons, ['intent_scan_limit_exceeded',
    'intent_attempt_limit_reached', 'positive_recovery_authority_unavailable']);
  assert.deepEqual({ reads: overflow.modelBytesRead, writes: overflow.modelBytesWritten,
    promotions: overflow.promotions }, { reads: 0, writes: 0, promotions: 0 });
  assert.equal(overflow.databaseChanges, 0);
});

for (const [name, error] of [
  ['busy', Object.assign(new Error('busy'), { code: 'SQLITE_BUSY' })],
  ['error', new Error('fixture database error')],
] as const) {
  test(`database ${name} is reported as degraded without inferred success`, t => {
    t.mock.method(database.engineRestampIntentsDb, 'scanRecoveryCandidates', () => { throw error; });
    const result = recovery.inspectEngineRestampStartupRecovery();
    assert.deepEqual(result, { status: 'blocked_degraded', scope: 'affected_sessions_only',
      observedIntentRows: 0, attemptableIntentRows: 0, unresolvedIntentRows: 0,
      canonicalIntentBytesRead: 0, modelBytesRead: 0, modelBytesWritten: 0,
      promotions: 0, databaseChanges: null, elapsedMs: result.elapsedMs,
      reasons: ['database_scan_failed'] });
  });
}
