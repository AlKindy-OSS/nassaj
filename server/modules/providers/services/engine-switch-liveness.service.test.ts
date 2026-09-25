import assert from 'node:assert/strict';
import test from 'node:test';

import {
  isEngineRestampReserved,
  isEngineRestampRecoveryReservationCurrent,
  releaseEngineRestamp,
  releaseEngineRestampRecovery,
  reserveEngineRestamp,
  reserveEngineRestampRecovery,
  resetEngineSwitchLivenessProbe,
  setEngineSwitchLivenessProbe,
} from './engine-switch-liveness.service.js';

test('restamp reservation is atomic, opaque and exact-token released', () => {
  resetEngineSwitchLivenessProbe();
  setEngineSwitchLivenessProbe(() => ({ busy: false, reason: null }));
  const first = reserveEngineRestamp('session-a');
  assert.ok(first);
  assert.equal(isEngineRestampReserved('session-a'), true);
  assert.equal(reserveEngineRestamp('session-a'), null);
  assert.equal(releaseEngineRestamp({ sessionId: 'session-a', identity: {} } as never), false);
  assert.equal(releaseEngineRestamp(first), true);
  assert.equal(isEngineRestampReserved('session-a'), false);
  resetEngineSwitchLivenessProbe();
});

test('plain objects cannot reserve the startup recovery path or invoke runtime liveness', () => {
  resetEngineSwitchLivenessProbe();
  let runtimeProbeCalls = 0;
  setEngineSwitchLivenessProbe(() => { runtimeProbeCalls += 1; throw new Error('must not run'); });
  const reservation = reserveEngineRestampRecovery(Object.freeze({}), Object.freeze({}));
  assert.equal(reservation, null);
  assert.equal(runtimeProbeCalls, 0);
  assert.equal(isEngineRestampRecoveryReservationCurrent(Object.freeze({}) as never), false);
  assert.equal(releaseEngineRestampRecovery(Object.freeze({}) as never), false);
  resetEngineSwitchLivenessProbe();
});

test('running or unknown liveness never reserves', () => {
  resetEngineSwitchLivenessProbe();
  assert.equal(reserveEngineRestamp('unwired'), null);
  setEngineSwitchLivenessProbe(() => ({ busy: true, reason: 'live' }));
  assert.equal(reserveEngineRestamp('busy'), null);
  assert.equal(isEngineRestampReserved('busy'), false);
  resetEngineSwitchLivenessProbe();
});
