/**
 * ADR-173 rev.3 P1: the pure half of "one run per session" — who a run belongs
 * to, which phase it is in, when it counts as stuck (qa condition 5: an in-flight
 * tool call is never stuck), and the launch reservation with its safety valve
 * (qa condition 2: the valve aborts the overdue launch and revokes it; never concurrency).
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createLaunchReservations,
  createRunActivity,
  describeRunOccupancy,
  isForeignRunSender,
  readLaunchReservationMaxMs,
  readRunStuckAfterMs,
} from '../claude-run-occupancy.js';

const MIN = 60_000;

test('a sender is foreign unless it names the run owner; two anonymous sides are one user', () => {
  assert.equal(isForeignRunSender(1, 1), false);
  assert.equal(isForeignRunSender(1, '1'), false);
  assert.equal(isForeignRunSender(1, 2), true);
  assert.equal(isForeignRunSender(1, null), true, 'an anonymous sender is not the owner');
  assert.equal(isForeignRunSender(null, 2), true, 'a member is not an anonymous run owner');
  assert.equal(isForeignRunSender(null, undefined), false);
});

test('thresholds: 15 min stuck and 180 s launch valve by default, configurable', () => {
  assert.equal(readRunStuckAfterMs({}), 15 * MIN);
  assert.equal(readRunStuckAfterMs({ CLAUDE_RUN_STUCK_AFTER_MS: '5000' }), 5000);
  assert.equal(readRunStuckAfterMs({ CLAUDE_RUN_STUCK_AFTER_MS: 'nope' }), 15 * MIN);
  assert.equal(readLaunchReservationMaxMs({}), 180_000);
  assert.equal(readLaunchReservationMaxMs({ CLAUDE_LAUNCH_RESERVATION_MAX_MS: '50' }), 50);
});

test('run activity tracks the last event, open tool calls, quiet and pending tasks', () => {
  let now = 1000;
  const activity = createRunActivity(() => now);
  assert.deepEqual(activity.snapshot(), { lastEventAt: 1000, openToolUses: 0, quiet: false, pendingTasks: 0 });
  now = 2000;
  activity.observe({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tu_1' }] } },
    { quiet: false, pending: 0 });
  assert.equal(activity.snapshot().openToolUses, 1);
  assert.equal(activity.snapshot().lastEventAt, 2000);
  activity.observe({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu_1' }] } },
    { quiet: true, pending: 2 });
  assert.deepEqual(activity.snapshot(), { lastEventAt: 2000, openToolUses: 0, quiet: true, pendingTasks: 2 });
});

const snapshot = (over: Record<string, unknown> = {}) => ({
  lastEventAt: 0, openToolUses: 0, quiet: false, pendingTasks: 0, ...over,
});
const base = { wakeOnly: false, pendingApproval: false, now: 20 * MIN, stuckAfterMs: 15 * MIN };

test('phase: a wake-only hold is scheduled_wake, a quiet held run post_result, otherwise running', () => {
  assert.equal(describeRunOccupancy({ ...base, activity: snapshot(), wakeOnly: true }).phase, 'scheduled_wake');
  assert.equal(describeRunOccupancy({ ...base, activity: snapshot({ quiet: true }) }).phase, 'post_result');
  assert.equal(describeRunOccupancy({ ...base, activity: snapshot() }).phase, 'running');
  assert.equal(describeRunOccupancy({ ...base, activity: null }).phase, 'running');
});

test('stuck only while running, silent past the threshold, with no approval, task or open tool call', () => {
  assert.equal(describeRunOccupancy({ ...base, activity: snapshot() }).stuck, true);
  assert.equal(describeRunOccupancy({ ...base, activity: snapshot({ lastEventAt: 6 * MIN }) }).stuck, false,
    'silent for 14 min is not stuck');
  assert.equal(describeRunOccupancy({ ...base, activity: snapshot(), pendingApproval: true }).stuck, false);
  assert.equal(describeRunOccupancy({ ...base, activity: snapshot({ pendingTasks: 1 }) }).stuck, false);
  assert.equal(describeRunOccupancy({ ...base, activity: snapshot({ openToolUses: 1 }) }).stuck, false,
    'qa condition 5: a long silent tool is not stuck');
  assert.equal(describeRunOccupancy({ ...base, activity: snapshot({ quiet: true }) }).stuck, false);
  assert.equal(describeRunOccupancy({ ...base, activity: snapshot(), wakeOnly: true }).stuck, false);
  assert.equal(describeRunOccupancy({ ...base, activity: null }).stuck, false, 'no activity proves nothing');
});

test('M-b: a silent run whose CLI process is known dead is stuck despite an open tool call or task', () => {
  const dead = { ...base, processDead: true };
  assert.equal(describeRunOccupancy({ ...dead, activity: snapshot({ openToolUses: 1 }) }).stuck, true);
  assert.equal(describeRunOccupancy({ ...dead, activity: snapshot({ pendingTasks: 2 }) }).stuck, true);
  assert.equal(describeRunOccupancy({ ...dead, activity: snapshot({ lastEventAt: 6 * MIN, openToolUses: 1 }) }).stuck,
    false, 'still needs the silence threshold');
  assert.equal(describeRunOccupancy({ ...dead, activity: snapshot({ quiet: true }) }).stuck, false);
  assert.equal(describeRunOccupancy({ ...base, processDead: false, activity: snapshot({ openToolUses: 1 }) }).stuck,
    false, 'alive or unknown liveness keeps qa condition 5');
});

test('a launch reservation admits one launcher per session and is released by its own token only', () => {
  const reservations = createLaunchReservations({ maxMs: () => 60_000, onExpire: () => {} });
  const a = Symbol('a');
  const b = Symbol('b');
  assert.equal(reservations.reserve('s1', 1, a), true);
  assert.equal(reservations.reserve('s1', 2, b), false, 'the loser is refused');
  assert.equal(reservations.holder('s1')?.userId, 1);
  reservations.release('s1', b);
  assert.equal(reservations.holder('s1')?.userId, 1, 'another token never frees it');
  assert.equal(reservations.reserve('s2', 2, b), true, 'sessions are independent');
  reservations.release('s1', a);
  reservations.release('s2', b);
  assert.equal(reservations.holder('s1'), null);
  assert.equal(reservations.reserve('s1', 2, b), true);
  reservations.release('s1', b);
});

test('T-2093: a reservation records the clientMsgId of the launching turn', () => {
  const reservations = createLaunchReservations({ maxMs: () => 60_000, onExpire: () => {} });
  const a = Symbol('a');
  const b = Symbol('b');
  assert.equal(reservations.reserve('s1', 1, a, 'turn-a'), true);
  assert.equal(reservations.holder('s1')?.clientMsgId, 'turn-a');
  assert.equal(reservations.reserve('s2', 1, b), true);
  assert.equal(reservations.holder('s2')?.clientMsgId, null, 'no client id: legacy launch');
  reservations.release('s1', a);
  reservations.release('s2', b);
});

test('the safety valve aborts an overdue launch, then frees and revokes its reservation', async () => {
  const expired: Array<[string, unknown]> = [];
  const reservations = createLaunchReservations({
    maxMs: () => 20, onExpire: (sessionId, userId) => { expired.push([sessionId, userId]); },
  });
  const token = Symbol('a');
  let aborted = 0;
  assert.equal(reservations.reserve('s1', 7, token), true);
  reservations.attachAbort('s1', token, () => { aborted += 1; });
  assert.equal(reservations.holds('s1', token), true);
  await new Promise((resolve) => { setTimeout(resolve, 60); });
  assert.deepEqual(expired, [['s1', 7]], 'logged once');
  assert.equal(aborted, 1, 'the hung launch is aborted');
  assert.equal(reservations.holder('s1'), null, 'freed');
  assert.equal(reservations.isRevoked(token), true, 'the aborted launch may never register');
  const next = Symbol('b');
  assert.equal(reservations.reserve('s1', 8, next), true);
  reservations.release('s1', token);
  assert.equal(reservations.holder('s1')?.userId, 8, 'a late release of the revoked token frees nothing');
  assert.equal(reservations.isRevoked(token), false, 'its launch ended: nothing left to revoke');
  reservations.release('s1', next);
});

test('cancel: a privileged stop of a launching session aborts, frees and revokes it', () => {
  const reservations = createLaunchReservations({ maxMs: () => 60_000, onExpire: () => {} });
  const token = Symbol('a');
  let aborted = 0;
  reservations.reserve('s1', 7, token);
  assert.deepEqual(reservations.cancel('s1'), { userId: 7, aborted: false }, 'no controller yet: revoked only');
  assert.equal(reservations.isRevoked(token), true);
  assert.equal(reservations.holds('s1', token), false);
  const second = Symbol('b');
  reservations.reserve('s1', 8, second);
  reservations.attachAbort('s1', second, () => { aborted += 1; });
  assert.deepEqual(reservations.cancel('s1'), { userId: 8, aborted: true });
  assert.equal(aborted, 1);
  assert.equal(reservations.cancel('s1'), null, 'nothing launching');
  reservations.release('s1', token);
  reservations.release('s1', second);
});
