// B-1349: FIRST import — HOME becomes a /var/tmp sandbox before anything reads it.
import '@/shared/__tests__/sandbox-home.js';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  _resetSchedulerPruneClock,
  isSchedulerRunning,
  runAutoUpdateTick,
  runDailySnapshotPrune,
  SNAPSHOT_PRUNE_PERIOD_MS,
  startHarnessAutoUpdateScheduler,
  stopHarnessAutoUpdateScheduler,
  type SchedulerDeps,
} from './scheduler.js';
import {
  _resetHarnessLeases,
  acquireHarnessLease,
  activeHarnessJobId,
  releaseHarnessLease,
} from './lease.js';

const enabled = { enabled: true, intervalMinutes: 720 };

test('server boot arms the scheduler after background admission without an immediate update', () => {
  let updateCalls = 0;
  startHarnessAutoUpdateScheduler({
    getSettings: () => enabled,
    runUpdate: async () => { updateCalls += 1; },
  });
  assert.equal(isSchedulerRunning(), true);
  assert.equal(updateCalls, 0, 'arming a 720-minute timer must not execute an updater at boot');
  stopHarnessAutoUpdateScheduler();

  const serverIndex = readFileSync(path.resolve(
    path.dirname(fileURLToPath(import.meta.url)), '../../../index.js',
  ), 'utf8');
  assert.ok(
    serverIndex.indexOf('startHarnessAutoUpdateScheduler();')
      > serverIndex.indexOf('await backgroundLifecycle.prepare();'),
    'server startup must arm scheduling only after background admission',
  );
});

test('a disabled toggle skips the whole sweep', async () => {
  const attempted: string[] = [];
  const result = await runAutoUpdateTick({
    getSettings: () => ({ enabled: false, intervalMinutes: 720 }),
    markRun: () => {},
    runUpdate: async (p) => attempted.push(p),
  });
  assert.deepEqual(result, []);
  assert.deepEqual(attempted, []);
});

test('an enabled tick attempts ONLY harnesses whose built-in updater is verified off', async () => {
  const attempted: string[] = [];
  const marked: string[] = [];
  const skipped: Array<{ provider: string; reason: string }> = [];
  const deps: SchedulerDeps = {
    getSettings: () => enabled,
    markRun: (at) => marked.push(at),
    runUpdate: async (p) => attempted.push(p),
    logSkip: (entry) => skipped.push(entry),
    now: () => 0,
  };
  const result = await runAutoUpdateTick(deps);

  // glm + deepseek have no CLI at all — never even considered.
  assert.ok(!result.includes('glm'));
  assert.ok(!result.includes('deepseek'));
  assert.ok(!skipped.some((s) => s.provider === 'glm' || s.provider === 'deepseek'));

  // Native self-updaters are ineligible without exact rollback, while the
  // recoverable npm/git harnesses still lack verified built-in updater knobs.
  assert.deepEqual(result, []);
  assert.deepEqual(attempted, result);
  assert.equal(marked.length, 1); // last-run stamped once

  // hermes is recoverably updatable, so it reaches the knob gate and is
  // skipped for that reason — not because it is "managed externally" any more.
  const hermesSkip = skipped.find((s) => s.provider === 'hermes');
  assert.ok(hermesSkip, 'hermes is considered by the sweep');
  assert.equal(hermesSkip!.reason, 'autoupdater-disable-unverified');
  // Same gate keeps qwen manual until devops verifies its knob; kimi's knob is
  // verified (T-1873) but kimi is button-only.
  assert.ok(skipped.some((s) => s.provider === 'qwen' && s.reason === 'autoupdater-disable-unverified'));
  assert.ok(skipped.some((s) => s.provider === 'kimi' && s.reason === 'manual-only'));
});

test('the scheduler never invokes an ineligible native self-updater', async () => {
  const attempted: string[] = [];
  const result = await runAutoUpdateTick({
    getSettings: () => enabled,
    markRun: () => {},
    logSkip: () => {},
    runUpdate: async (p) => {
      attempted.push(p);
      throw new Error(`unexpected scheduler update: ${p}`);
    },
  });
  assert.deepEqual(attempted, result);
  assert.deepEqual(result, []);
});

test('scheduler leaves native harness leases untouched because they are ineligible', async () => {
  _resetHarnessLeases();
  for (const provider of ['claude', 'opencode']) {
    assert.ok('lease' in acquireHarnessLease(provider, `manual-${provider}`));
  }

  try {
    const result = await runAutoUpdateTick({
      getSettings: () => enabled,
      markRun: () => {},
      logSkip: () => {},
    });

    assert.deepEqual(result, []);
    assert.equal(activeHarnessJobId('claude'), 'manual-claude');
    assert.equal(activeHarnessJobId('opencode'), 'manual-opencode');
  } finally {
    releaseHarnessLease('claude', 'manual-claude');
    releaseHarnessLease('opencode', 'manual-opencode');
    _resetHarnessLeases();
  }
});

test('T-1871: every snapshot-backed harness is skipped as manual-only', async () => {
  const skipped: Array<{ provider: string; reason: string }> = [];
  const attempted: string[] = [];
  await runAutoUpdateTick({
    getSettings: () => enabled,
    markRun: () => {},
    logSkip: (entry) => skipped.push(entry),
    runUpdate: async (p) => attempted.push(p),
  });
  for (const id of ['claude', 'codex', 'antigravity', 'cursor', 'opencode']) {
    assert.ok(skipped.some((s) => s.provider === id && s.reason === 'manual-only'), id);
  }
  assert.deepEqual(attempted, []);
});

test('T-1871: snapshot retention runs at most once a day on the scheduler tick', () => {
  _resetSchedulerPruneClock();
  let runs = 0;
  let now = 5_000;
  const deps: SchedulerDeps = { now: () => now, prune: () => { runs += 1; } };
  assert.equal(runDailySnapshotPrune(deps), true);
  now += SNAPSHOT_PRUNE_PERIOD_MS - 1;
  assert.equal(runDailySnapshotPrune(deps), false);
  now += 1;
  assert.equal(runDailySnapshotPrune(deps), true);
  assert.equal(runs, 2);
  // A failing prune never breaks the tick.
  now += SNAPSHOT_PRUNE_PERIOD_MS;
  assert.equal(runDailySnapshotPrune({ now: () => now, prune: () => { throw new Error('disk'); } }), true);
  _resetSchedulerPruneClock();
});
