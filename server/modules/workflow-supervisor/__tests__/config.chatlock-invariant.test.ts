/**
 * T-823 condition 3 — the chat-lock timing invariant validator (config.ts).
 * validateChatLockConfig couples the two knobs so a bad manual override cannot
 * silently open a fail-open window on the critical path:
 *   - the shipped defaults are SAFE (wait = hold + 5s ≥ hold + required grace),
 *   - wait < hold + grace is REJECTED (human could fail-open while the injector holds),
 *   - either knob over its ceiling is REJECTED,
 *   - the boundary wait == hold + required grace is accepted (≥).
 * Pure function ⇒ offline. The supervisor calls this at boot and exits fail-closed
 * on !ok (proven by monitor/soak; here we lock the arithmetic).
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  validateChatLockConfig,
  CHAT_LOCK_REQUIRED_GRACE_MS,
  CHAT_LOCK_WAIT_MS_CEILING,
  INJECTOR_MAX_HOLD_MS_CEILING,
  INJECTOR_SIGKILL_GRACE_MS,
} from '@/modules/workflow-supervisor/config.js';

function env(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  // Start from a CLEAN base so an ambient WORKFLOW_SUPERVISOR_* from the outer
  // shell cannot skew the arithmetic under test.
  return { WORKFLOW_SUPERVISOR: '1', WORKFLOW_SUPERVISOR_CHAT_LOCK: '1', ...extra };
}

test('required grace is strictly greater than the injector SIGKILL grace (no boundary tie)', () => {
  assert.ok(
    CHAT_LOCK_REQUIRED_GRACE_MS > INJECTOR_SIGKILL_GRACE_MS,
    'the human must keep waiting past the injector kill+release, never tie it',
  );
});

test('shipped defaults satisfy the invariant', () => {
  const v = validateChatLockConfig(env());
  assert.equal(v.ok, true, JSON.stringify(v));
  assert.equal(v.holdMs, 90_000);
  assert.equal(v.waitMs, 95_000); // hold + 5s default coupling
});

test('wait < hold + required grace is REJECTED (fail-open window)', () => {
  // hold 90s, wait 91s → floor = 90s + grace(3s) = 93s; 91s < 93s ⇒ broken.
  const v = validateChatLockConfig(
    env({
      WORKFLOW_SUPERVISOR_HANDOFF_MAX_HOLD_MS: '90000',
      WORKFLOW_SUPERVISOR_CHAT_LOCK_WAIT_MS: '91000',
    }),
  );
  assert.equal(v.ok, false);
  assert.ok(!v.ok && v.problems.some((p) => /injectorMaxHoldMs\+grace/.test(p)));
});

test('boundary wait == hold + required grace is ACCEPTED (>=)', () => {
  const hold = 90_000;
  const v = validateChatLockConfig(
    env({
      WORKFLOW_SUPERVISOR_HANDOFF_MAX_HOLD_MS: String(hold),
      WORKFLOW_SUPERVISOR_CHAT_LOCK_WAIT_MS: String(hold + CHAT_LOCK_REQUIRED_GRACE_MS),
    }),
  );
  assert.equal(v.ok, true, JSON.stringify(v));
});

test('wait over its ceiling is REJECTED (unbounded human block)', () => {
  const v = validateChatLockConfig(
    env({ WORKFLOW_SUPERVISOR_CHAT_LOCK_WAIT_MS: String(CHAT_LOCK_WAIT_MS_CEILING + 1) }),
  );
  assert.equal(v.ok, false);
  assert.ok(!v.ok && v.problems.some((p) => /chatLockWaitMs=.*exceeds ceiling/.test(p)));
});

test('hold over its ceiling is REJECTED', () => {
  const v = validateChatLockConfig(
    env({ WORKFLOW_SUPERVISOR_HANDOFF_MAX_HOLD_MS: String(INJECTOR_MAX_HOLD_MS_CEILING + 1) }),
  );
  assert.equal(v.ok, false);
  assert.ok(!v.ok && v.problems.some((p) => /injectorMaxHoldMs=.*exceeds ceiling/.test(p)));
});

test('a safe non-default tuning (small hold + coupled wait) passes', () => {
  const v = validateChatLockConfig(
    env({
      WORKFLOW_SUPERVISOR_HANDOFF_MAX_HOLD_MS: '10000',
      WORKFLOW_SUPERVISOR_CHAT_LOCK_WAIT_MS: '13000',
    }),
  );
  assert.equal(v.ok, true, JSON.stringify(v));
});
