/**
 * ADR-053 §ج-4 — per-user workflow concurrency cap (admitLaunch).
 *
 * Proves the NEW cap component (the runner's single global flock has no per-user
 * notion): a user may launch while strictly below the cap, is DENIED at/over it,
 * and — critically — a lister that THROWS fails CLOSED (treated as saturated),
 * never as empty, so a systemctl blip can never open the floodgate into OOM.
 *
 * Pure: the active-scope lister is injected, so no systemd is touched here.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { admitLaunch } from '@/modules/workflow-supervisor/concurrency.js';
import { maxConcurrentPerUser } from '@/modules/workflow-supervisor/config.js';

/** A lister returning a fixed count of fake unit names for `userId`. */
const listerReturning = (n: number) => async (userId: number): Promise<string[]> =>
  Array.from({ length: n }, (_v, i) => `wf-${userId}-${i}.service`);

/** The env seam so the cap is deterministic regardless of the host env. */
function envWithCap(cap: number): NodeJS.ProcessEnv {
  return { WORKFLOW_SUPERVISOR_MAX_PER_USER: String(cap) };
}

test('config: cap defaults to 3 and honors a valid override; rejects garbage', () => {
  assert.equal(maxConcurrentPerUser({}), 3, 'default is a conservative 3');
  assert.equal(maxConcurrentPerUser({ WORKFLOW_SUPERVISOR_MAX_PER_USER: '5' }), 5);
  assert.equal(maxConcurrentPerUser({ WORKFLOW_SUPERVISOR_MAX_PER_USER: '0' }), 3, '0 is invalid => default');
  assert.equal(maxConcurrentPerUser({ WORKFLOW_SUPERVISOR_MAX_PER_USER: '-2' }), 3, 'negative => default');
  assert.equal(maxConcurrentPerUser({ WORKFLOW_SUPERVISOR_MAX_PER_USER: 'abc' }), 3, 'non-numeric => default');
});

test('admit: strictly BELOW the cap is admitted', async () => {
  const env = envWithCap(3);
  for (const active of [0, 1, 2]) {
    const res = await admitLaunch(7, listerReturning(active), env);
    assert.equal(res.admit, true, `active=${active} < 3 must admit`);
    assert.equal(res.active, active);
    assert.equal(res.cap, 3);
  }
});

test('admit: AT the cap is denied (the Nth+1 launch is refused, not OOM-launched)', async () => {
  const env = envWithCap(3);
  const res = await admitLaunch(7, listerReturning(3), env);
  assert.equal(res.admit, false, 'active == cap must deny');
  assert.equal(res.active, 3);
  assert.equal(res.cap, 3);
  if (!res.admit) {
    assert.match(res.reason, /concurrency cap reached \(3\/3\)/);
  }
});

test('admit: OVER the cap is denied', async () => {
  const env = envWithCap(2);
  const res = await admitLaunch(7, listerReturning(5), env);
  assert.equal(res.admit, false, 'active > cap must deny');
  assert.equal(res.active, 5);
  assert.equal(res.cap, 2);
});

test('admit: a THROWING lister fails CLOSED (deny, treated as at-capacity — never an accidental admit)', async () => {
  const env = envWithCap(3);
  const throwingLister = async (): Promise<string[]> => {
    throw new Error('systemctl unavailable');
  };
  const res = await admitLaunch(7, throwingLister, env);
  assert.equal(res.admit, false, 'a lister error must deny, not admit');
  assert.equal(res.active, res.cap, 'reported as saturated (active == cap)');
  if (!res.admit) {
    assert.match(res.reason, /could not enumerate active scopes \(fail-closed deny\)/);
  }
});

test('admit: the cap is per-user — the lister is queried with the SAME userId it is asked to admit', async () => {
  const env = envWithCap(3);
  const seen: number[] = [];
  const spyLister = async (userId: number): Promise<string[]> => {
    seen.push(userId);
    return []; // user has no active scopes
  };
  await admitLaunch(42, spyLister, env);
  assert.deepEqual(seen, [42], 'admission counts THIS user’s scopes only');
});
