import assert from 'node:assert/strict';
import test from 'node:test';

import {
  beginIdentityTransition,
  cancelIdentityTransition,
  commitIdentityTransition,
  enterPasswordChangeOnlyMode,
  exitPasswordChangeOnlyMode,
  getIdentityBarrierSnapshot,
  identityRequestSignal,
  isCurrentIdentityReconciliation,
  isIdentityRevocationClose,
  lockIdentityBarrier,
  receiveIdentityBarrierSnapshot,
  reconcileRevokedIdentity,
  stabilizeIdentityBarrier,
} from './accountIdentityBarrier';

test.afterEach(() => {
  stabilizeIdentityBarrier(getIdentityBarrierSnapshot().version);
});

const nextRemoteVersion = (version: string): string => {
  const [clock] = version.split(':', 1);
  return `${(parseInt(clock, 36) + 1).toString(36)}:remote`;
};

test('begin aborts in-flight requests and rejects every new ordinary request', () => {
  const inFlight = identityRequestSignal();
  const version = beginIdentityTransition('switch');
  assert.equal(inFlight.aborted, true);
  assert.throws(() => identityRequestSignal(), { name: 'AbortError' });
  cancelIdentityTransition(version);
  assert.equal(identityRequestSignal().aborted, false);
});

test('password-change-only mode blocks general requests without broadcasting a stable identity', () => {
  enterPasswordChangeOnlyMode();
  assert.equal(getIdentityBarrierSnapshot().phase, 'limited');
  assert.throws(() => identityRequestSignal(), { name: 'AbortError' });
  exitPasswordChangeOnlyMode();
  assert.equal(getIdentityBarrierSnapshot().phase, 'stable');
  assert.equal(identityRequestSignal().aborted, false);
});

test('a committed transition remains fenced until explicit stabilization', () => {
  const version = beginIdentityTransition('remove');
  commitIdentityTransition(version, 'remove');
  assert.equal(getIdentityBarrierSnapshot().phase, 'committed');
  assert.throws(() => identityRequestSignal(), { name: 'AbortError' });
  stabilizeIdentityBarrier(version);
  assert.equal(getIdentityBarrierSnapshot().phase, 'stable');
});

test('cleanup failure is fail-closed and cannot be released by a stale tab', () => {
  const version = beginIdentityTransition('logout');
  commitIdentityTransition(version, 'logout');
  lockIdentityBarrier(version, 'cleanup_failed');
  receiveIdentityBarrierSnapshot({ phase: 'stable', version, reason: '' });
  receiveIdentityBarrierSnapshot({ phase: 'stable', version: '0:older', reason: '' });
  const remoteVersion = nextRemoteVersion(version);
  receiveIdentityBarrierSnapshot({ phase: 'changing', version: remoteVersion, reason: 'remote_add' });
  receiveIdentityBarrierSnapshot({ phase: 'stable', version: remoteVersion, reason: 'transition_cancelled' });
  assert.equal(getIdentityBarrierSnapshot().phase, 'locked');
  assert.throws(() => identityRequestSignal(), { name: 'AbortError' });
});

test('newer cross-tab versions supersede older local state', () => {
  const version = beginIdentityTransition('switch');
  commitIdentityTransition(version, 'switch');
  assert.equal(isCurrentIdentityReconciliation(version), true);
  const remoteVersion = nextRemoteVersion(version);
  receiveIdentityBarrierSnapshot({ phase: 'committed', version: remoteVersion, reason: 'remote_switch' });
  assert.equal(isCurrentIdentityReconciliation(version), false);
  assert.deepEqual(getIdentityBarrierSnapshot(), {
    phase: 'committed', version: remoteVersion, reason: 'remote_switch',
  });
});

test('a committed transition cannot be unlocked by an equal-version cancellation', () => {
  const version = beginIdentityTransition('switch');
  commitIdentityTransition(version, 'switch');
  cancelIdentityTransition(version);
  receiveIdentityBarrierSnapshot({ phase: 'stable', version, reason: 'transition_cancelled' });
  assert.equal(getIdentityBarrierSnapshot().phase, 'committed');
});

test('untrusted persisted and cross-tab versions are bounded before comparison', () => {
  const before = getIdentityBarrierSnapshot();
  receiveIdentityBarrierSnapshot({
    phase: 'committed', version: `${'z'.repeat(10_000)}:remote`, reason: 'switch',
  });
  assert.deepEqual(getIdentityBarrierSnapshot(), before);
  receiveIdentityBarrierSnapshot({
    phase: 'committed', version: 'zzzzzzzzzzzzzzzz:remote', reason: 'switch',
  });
  assert.deepEqual(getIdentityBarrierSnapshot(), before);
});

test('repeated 4401 revocations share one global reconciliation fence', () => {
  assert.equal(isIdentityRevocationClose(4401), true);
  assert.equal(isIdentityRevocationClose(1006), false);
  reconcileRevokedIdentity();
  const first = getIdentityBarrierSnapshot();
  reconcileRevokedIdentity();
  assert.equal(first.phase, 'committed');
  assert.deepEqual(getIdentityBarrierSnapshot(), first);
});
