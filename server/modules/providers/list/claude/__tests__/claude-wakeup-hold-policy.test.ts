/** B-1699 (qa C2): bounds of a scheduled wake-up hold. */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  createWakeupHoldBudget,
  peakUsagePercent,
  planWakeupHold,
  readWakeupHoldConfig,
} from '../claude-wakeup-hold-policy.js';

test('defaults are 6 h, 48 pulses, 60 s margin, 30 min listener grace; 0 disables', () => {
  const config = readWakeupHoldConfig({});
  assert.deepEqual(config, { enabled: true, marginMs: 60_000, totalMaxMs: 21_600_000, maxPulses: 48,
    listenerGraceMs: 1_800_000, listenerPollMs: 60_000 });
  assert.equal(readWakeupHoldConfig({ CLAUDE_SDK_SCHEDULED_WAKEUP_HOLD: '0' }).enabled, false);
  assert.equal(readWakeupHoldConfig({ CLAUDE_SDK_SCHEDULED_WAKEUP_MAX_PULSES: 'x' }).maxPulses, 48);
});

test('the total cap counts from the FIRST schedule and never re-anchors', () => {
  let clock = 1_000;
  const config = readWakeupHoldConfig({ CLAUDE_SDK_SCHEDULED_WAKEUP_TOTAL_MAX_MS: '500' });
  const budget = createWakeupHoldBudget(config, () => clock);
  budget.onScheduled();
  clock = 1_400;
  budget.onScheduled();
  assert.equal(budget.totalCapAt(), 1_500);
  assert.equal(budget.exhausted(), false);
  clock = 1_500;
  assert.equal(budget.exhausted(), true);
});

test('the pulse limit ends the hold after that many wake-up turns', () => {
  const config = readWakeupHoldConfig({ CLAUDE_SDK_SCHEDULED_WAKEUP_MAX_PULSES: '2' });
  const budget = createWakeupHoldBudget(config, () => 0);
  budget.onScheduled();
  budget.onFired();
  const wake = { nextWakeAt: 10_000, openEnded: false };
  assert.equal(planWakeupHold(wake, budget, config, 1e9, 0)?.hasOwnProperty('delayMs'), true);
  budget.onFired();
  assert.deepEqual(planWakeupHold(wake, budget, config, 1e9, 0), { release: 'scheduled-wakeup-total-cap' });
});

test('the plan takes the earliest of wake time + margin, idle cap and total cap', () => {
  const config = readWakeupHoldConfig({ CLAUDE_SDK_SCHEDULED_WAKEUP_MARGIN_MS: '100',
    CLAUDE_SDK_SCHEDULED_WAKEUP_TOTAL_MAX_MS: '10000' });
  const budget = createWakeupHoldBudget(config, () => 0);
  budget.onScheduled();
  assert.deepEqual(planWakeupHold({ nextWakeAt: 500, openEnded: false }, budget, config, 5_000, 0),
    { delayMs: 600, reason: 'scheduled-wakeup-expired' });
  assert.deepEqual(planWakeupHold({ nextWakeAt: 9_000, openEnded: false }, budget, config, 5_000, 0),
    { delayMs: 5_000, reason: 'scheduled-wakeup-cap' });
  assert.deepEqual(planWakeupHold({ nextWakeAt: null, openEnded: true }, budget, config, 5_000, 0),
    { delayMs: 10_000, reason: 'scheduled-wakeup-total-cap' }, 'a recurring cron ignores the idle cap');
  assert.equal(planWakeupHold({ nextWakeAt: null, openEnded: false }, budget, config, 5_000, 0), null);
  assert.deepEqual(planWakeupHold({ nextWakeAt: 500, openEnded: false }, budget,
    readWakeupHoldConfig({ CLAUDE_SDK_SCHEDULED_WAKEUP_HOLD: '0' }), 5_000, 0),
  { release: 'scheduled-wakeup-disabled' });
});

test('usage peak reads the session and weekly windows; unknown is null', () => {
  assert.equal(peakUsagePercent({ session: { utilization: 20 }, weeklyAllModels: { utilization: 93 } }), 93);
  assert.equal(peakUsagePercent({ session: null }), null);
  assert.equal(peakUsagePercent(undefined), null);
});
