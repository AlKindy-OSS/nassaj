import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { EngineRestampIntent } from '@/modules/database/index.js';

import {
  coordinateEngineRestamp,
  EngineRestampCoordinationError,
  UNKNOWN_ENGINE_RESTAMP_ROLLBACK_REASON,
  type EngineRestampCoordinatorPorts,
} from './engine-restamp-coordinator.service.js';
import type {
  EngineRestampModelStoreBoundary,
  EngineRestampModelStoreEntry,
  EngineRestampStoreOwner,
} from './engine-restamp-model-store.service.js';
import type { RestampReservation } from './engine-switch-liveness.service.js';

const SESSION = 'session-a';
const OPERATION = '123e4567-e89b-42d3-a456-426614174000';
const oldEntry: EngineRestampModelStoreEntry = Object.freeze({ provider: 'claude', sessionId: SESSION,
  supported: true, changed: true, model: 'old-model', updatedAt: '2026-09-24T10:00:00.000Z' });
const input = Object.freeze({ sessionId: SESSION, provider: 'claude' as const,
  targetEngine: 'openai', targetModel: 'new-model', acknowledgedExport: true });

function intent(state: Parameters<EngineRestampCoordinatorPorts['buildIntent']>[0]): EngineRestampIntent {
  return {
    schema: 'nassaj-engine-restamp-intent/v1', operationId: OPERATION, sessionId: SESSION,
    ownerProcess: { uid: 1000, pid: 100, bootId: 'boot', startTicks: '1' },
    actor: { kind: 'jwt', userId: 1, authorizationGeneration: 1 },
    projectBinding: { kind: 'project', projectId: 'project', participantUserId: 1,
      controllerUserId: 1, authorityFenceSha256: 'a'.repeat(64) },
    fromPin: state.fromPin, toPin: { engine: input.targetEngine, source: 'user_switch' },
    fromModel: state.fromModel, toModel: { changed: true, model: input.targetModel },
    turnsExported: state.turnsExported, acknowledgedExport: state.acknowledgedExport,
    phase: 'prepared', revision: 1, requestSha256: 'b'.repeat(64),
    createdAt: '2026-09-24T12:00:00.000Z',
  };
}

function fixture(overrides: Partial<EngineRestampCoordinatorPorts> = {}) {
  const events: string[] = [];
  const entries: Record<string, EngineRestampModelStoreEntry> = { [`claude:${SESSION}`]: oldEntry };
  let digest = 'digest-0'; let writes = 0; let pin = { engine: 'anthropic', source: 'server_verdict' };
  let canonical = 'prepared';
  const reservation = Object.freeze({ sessionId: SESSION, identity: Object.freeze({}) }) as RestampReservation;
  const owner = Object.freeze(Object.create(null)) as EngineRestampStoreOwner;
  const boundary: EngineRestampModelStoreBoundary = {
    readOrdinary: () => { events.push('read-ordinary'); return { document: { version: 1, entries: { ...entries } }, digest }; },
    mintOwner: (_intent, nextCanonical) => { events.push(`mint:${nextCanonical}`); assert.equal(nextCanonical, canonical); return owner; },
    readOwned: () => { events.push('read-owned'); return { document: { version: 1, entries: { ...entries } }, digest }; },
    writeOwned: (_owner, mutation, expectedDigest) => {
      events.push(`write:${mutation.entry?.model ?? 'clear'}`); assert.equal(expectedDigest, digest);
      const key = `${mutation.provider}:${mutation.sessionId}`;
      if (mutation.entry) entries[key] = mutation.entry; else delete entries[key];
      writes += 1; digest = `digest-${writes}`;
    },
  };
  const ports: EngineRestampCoordinatorPorts = {
    withBoundary: async <T>(_sessionId: string, operation: (value: EngineRestampModelStoreBoundary) => Promise<T>) => {
      events.push('boundary-open'); try { return await operation(boundary); } finally { events.push('boundary-close'); }
    },
    readPin: () => { events.push('read-pin'); return pin; },
    reserve: () => { events.push('reserve'); return reservation; },
    release: () => { events.push('release'); return true; },
    countAssistantTurns: () => { events.push('count'); return 2; },
    buildIntent: state => { events.push('build-intent'); return intent(state); },
    prepareIntent: () => { events.push('prepare'); return canonical; },
    advanceIntent: (_sessionId, expected) => {
      events.push('advance'); assert.equal(expected, canonical); canonical = 'target-observed'; return canonical;
    },
    commitTarget: () => { events.push('commit'); pin = { engine: input.targetEngine, source: 'user_switch' }; return undefined; },
    settleRollback: () => { events.push('settle-rollback'); return undefined; },
    nowIso: () => '2026-09-24T12:00:00.000Z',
    ...overrides,
  };
  return { events, entries, ports, getPin: () => pin };
}

test('file target precedes phase successor and synchronous target commit', async () => {
  const state = fixture();
  const result = await coordinateEngineRestamp(input, state.ports);
  assert.equal(result.operationId, OPERATION);
  assert.equal(state.entries[`claude:${SESSION}`]?.model, 'new-model');
  assert.deepEqual(state.getPin(), { engine: 'openai', source: 'user_switch' });
  assert.deepEqual(state.events, ['boundary-open','read-ordinary','read-pin','reserve','count','build-intent',
    'prepare','mint:prepared','write:new-model','read-owned','advance','mint:target-observed',
    'commit','release','boundary-close']);
});

test('export recount happens under reservation and denial creates no intent or file effect', async () => {
  const state = fixture({ countAssistantTurns: () => { state.events.push('count'); return 1; } });
  await assert.rejects(coordinateEngineRestamp({ ...input, acknowledgedExport: false }, state.ports),
    /ENGINE_EXPORT_NOT_ACKNOWLEDGED/);
  assert.deepEqual(state.events, ['boundary-open','read-ordinary','read-pin','reserve','count','release','boundary-close']);
  assert.equal(state.entries[`claude:${SESSION}`]?.model, 'old-model');
});

test('target commit failure restores the exact entry then settles rollback', async () => {
  const primary = new Error('commit-failed');
  let reason: string | undefined;
  const state = fixture({
    commitTarget: () => { state.events.push('commit'); throw primary; },
    settleRollback: value => { state.events.push('settle-rollback'); reason = value.reason; return undefined; },
  });
  await assert.rejects(coordinateEngineRestamp(input, state.ports), error => error === primary);
  assert.equal(state.entries[`claude:${SESSION}`], oldEntry);
  assert.equal(reason, UNKNOWN_ENGINE_RESTAMP_ROLLBACK_REASON);
  assert.ok(state.events.indexOf('write:old-model') < state.events.indexOf('settle-rollback'));
  assert.ok(state.events.indexOf('settle-rollback') < state.events.indexOf('release'));
});

test('rollback classification uses an allowlisted code and drops sensitive error text', async () => {
  const primary = Object.assign(new Error('failure /home/user/private token=secret-value'), {
    code: 'ENGINE_RESTAMP_TARGET_READBACK_MISMATCH',
  });
  let reason: string | undefined;
  const state = fixture({
    commitTarget: () => { state.events.push('commit'); throw primary; },
    settleRollback: value => { state.events.push('settle-rollback'); reason = value.reason; return undefined; },
  });
  await assert.rejects(coordinateEngineRestamp(input, state.ports), error => error === primary);
  assert.equal(reason, 'ENGINE_RESTAMP_TARGET_READBACK_MISMATCH');
  assert.equal(reason?.includes('/home/user/private'), false);
  assert.equal(reason?.includes('secret-value'), false);
});

test('phase CAS failure compensates with the still-current prepared owner', async () => {
  const primary = new Error('phase-cas-failed');
  const state = fixture({ advanceIntent: () => { state.events.push('advance'); throw primary; } });
  await assert.rejects(coordinateEngineRestamp(input, state.ports), error => error === primary);
  assert.equal(state.entries[`claude:${SESSION}`], oldEntry);
  assert.equal(state.events.filter(event => event === 'mint:prepared').length, 1);
  assert.ok(state.events.includes('settle-rollback'));
});

test('unsafe compensation preserves the primary and durable blocker truthfully', async () => {
  const primary = new Error('commit-failed');
  let reads = 0;
  const state = fixture({
    readPin: () => { state.events.push('read-pin'); reads += 1;
      return reads === 1 ? { engine: 'anthropic', source: 'server_verdict' } : { engine: 'other', source: 'user_switch' }; },
    commitTarget: () => { state.events.push('commit'); throw primary; },
  });
  await assert.rejects(coordinateEngineRestamp(input, state.ports), error => {
    assert.ok(error instanceof EngineRestampCoordinationError);
    assert.equal(error.cause, primary); assert.equal(error.errors[0], primary);
    assert.match(String((error.errors[1] as Error).message), /PIN_MISMATCH/); return true;
  });
  assert.equal(state.events.includes('settle-rollback'), false);
  assert.equal(state.entries[`claude:${SESSION}`]?.model, 'new-model');
  assert.ok(state.events.indexOf('release') > state.events.indexOf('commit'));
});

test('rollback audit/delete failure follows the primary after exact model restoration', async () => {
  const primary = new Error('commit-failed'); const audit = new Error('rollback-audit-failed');
  const state = fixture({
    commitTarget: () => { state.events.push('commit'); throw primary; },
    settleRollback: () => { state.events.push('settle-rollback'); throw audit; },
  });
  await assert.rejects(coordinateEngineRestamp(input, state.ports), error => {
    assert.ok(error instanceof EngineRestampCoordinationError);
    assert.deepEqual(error.errors, [primary, audit]); assert.equal(error.cause, primary); return true;
  });
  assert.equal(state.entries[`claude:${SESSION}`], oldEntry);
});

test('a reservation for another session is rejected before recount and is not released', async () => {
  const tokenB = Object.freeze({ sessionId: 'session-b', identity: Object.freeze({}) }) as RestampReservation;
  const state = fixture({ reserve: () => { state.events.push('reserve-b'); return tokenB; } });
  await assert.rejects(coordinateEngineRestamp(input, state.ports), /RESERVATION_SESSION_MISMATCH/);
  assert.deepEqual(state.events, ['boundary-open','read-ordinary','read-pin','reserve-b','boundary-close']);
});

test('release denial before intent preserves the denial as primary and reports notStarted', async () => {
  const primary = new Error('recount-failed');
  const state = fixture({
    countAssistantTurns: () => { state.events.push('count'); throw primary; },
    release: () => { state.events.push('release-false'); return false; },
  });
  await assert.rejects(coordinateEngineRestamp(input, state.ports), error => {
    assert.ok(error instanceof EngineRestampCoordinationError);
    assert.equal(error.cause, primary); assert.equal(error.errors[0], primary);
    assert.match(String((error.errors[1] as Error).message), /RELEASE_MISMATCH/);
    assert.equal(error.notStarted, true); assert.equal(error.effectState, 'not_started'); return true;
  });
});

test('release throw after successful compensation follows the primary and reports settled', async () => {
  const primary = new Error('commit-failed'); const release = new Error('release-threw');
  const state = fixture({
    commitTarget: () => { state.events.push('commit'); throw primary; },
    release: () => { state.events.push('release-throw'); throw release; },
  });
  await assert.rejects(coordinateEngineRestamp(input, state.ports), error => {
    assert.ok(error instanceof EngineRestampCoordinationError);
    assert.deepEqual(error.errors, [primary, release]); assert.equal(error.cause, primary);
    assert.equal(error.notStarted, false); assert.equal(error.effectState, 'settled'); return true;
  });
  assert.equal(state.entries[`claude:${SESSION}`], oldEntry);
});

test('compensation and release failures retain deterministic primary-first ordering', async () => {
  const primary = new Error('commit-failed'); const audit = new Error('audit-failed');
  const release = new Error('release-threw');
  const state = fixture({
    commitTarget: () => { state.events.push('commit'); throw primary; },
    settleRollback: () => { state.events.push('settle-rollback'); throw audit; },
    release: () => { state.events.push('release-throw'); throw release; },
  });
  await assert.rejects(coordinateEngineRestamp(input, state.ports), error => {
    assert.ok(error instanceof EngineRestampCoordinationError);
    assert.deepEqual(error.errors, [primary, audit, release]); assert.equal(error.cause, primary);
    assert.equal(error.effectState, 'outcome_unknown'); return true;
  });
});

test('post-commit release failure is committed, non-retryable, and never compensates', async () => {
  const state = fixture({ release: () => { state.events.push('release-false'); return false; } });
  await assert.rejects(coordinateEngineRestamp(input, state.ports), error => {
    assert.ok(error instanceof EngineRestampCoordinationError);
    assert.equal(error.code, 'ENGINE_RESTAMP_POST_COMMIT_RELEASE_FAILED');
    assert.equal(error.notStarted, false); assert.equal(error.effectState, 'committed');
    assert.equal(error.retryable, false); assert.equal(error.errors.length, 1); return true;
  });
  assert.equal(state.events.includes('settle-rollback'), false);
  assert.equal(state.entries[`claude:${SESSION}`]?.model, 'new-model');
  assert.deepEqual(state.getPin(), { engine: 'openai', source: 'user_switch' });
});
