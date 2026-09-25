import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  isSchedulerRunning,
  runAutoUpdateTick,
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
  // Same gate keeps the npm harnesses manual until devops verifies their knob.
  for (const id of ['kimi', 'qwen']) {
    assert.ok(skipped.some((s) => s.provider === id && s.reason === 'autoupdater-disable-unverified'), id);
  }
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
