/**
 * T-2094 qa condition 2: an update takes the harness lease and, synchronously
 * in the same call, drains the harness's pooled ACP processes — before any
 * code after the lease (preflight, snapshot, binary replace) can run.
 */
// B-1349: FIRST import — HOME becomes a /var/tmp sandbox before anything reads it.
import '@/shared/__tests__/sandbox-home.js';
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

import { createAcpProcessPool } from '../shared/acp/acp-process-pool.js';

import { _resetHarnessLeases, acquireHarnessLease, releaseHarnessLease } from './lease.js';
import { _resetHarnessLaunches, beginHarnessLaunch } from './spawn-admission.js';

afterEach(() => { _resetHarnessLeases(); _resetHarnessLaunches(); });

function handle() {
  const h = { pid: 1, killed: 0, kill() { h.killed += 1; }, onExit() {} };
  return h;
}

test('acquiring the antigravity lease kills idle pooled agy processes before it returns', () => {
  const pool = createAcpProcessPool({ provider: 'antigravity', capacity: () => 12 });
  const idle = pool.acquire({ key: 'a', userId: 1, fingerprint: 'f', cwd: '/p', spawn: handle });
  pool.release(idle.entry);
  const got = acquireHarnessLease('antigravity', 'job-1');
  assert.ok('lease' in got);
  assert.equal((idle.entry.handle as any).killed, 1, 'killed synchronously, before the updater continues');
  assert.equal(pool.size(), 0);
  pool.shutdown();
});

test('race: a turn admitted before the lease keeps running (and blocks the update); one after is refused', () => {
  const pool = createAcpProcessPool({ provider: 'antigravity', capacity: () => 12 });
  const releaseLaunch = beginHarnessLaunch('antigravity');
  const busy = pool.acquire({ key: 'b', userId: 1, fingerprint: 'f', cwd: '/p', spawn: handle });
  acquireHarnessLease('antigravity', 'job-2');
  assert.equal((busy.entry.handle as any).killed, 0, 'the live turn is not killed');
  assert.throws(() => beginHarnessLaunch('antigravity'), /updat/i, 'no new turn during the update');
  pool.release(busy.entry);
  releaseLaunch();
  assert.equal((busy.entry.handle as any).killed, 1, 'retired by the drain: killed when its turn ended');
  releaseHarnessLease('antigravity', 'job-2');
  pool.shutdown();
});

test('a lease conflict does not drain; other harnesses do not drain antigravity', () => {
  const pool = createAcpProcessPool({ provider: 'antigravity', capacity: () => 12 });
  acquireHarnessLease('codex', 'job-3');
  const idle = pool.acquire({ key: 'c', userId: 1, fingerprint: 'f', cwd: '/p', spawn: handle });
  pool.release(idle.entry);
  acquireHarnessLease('codex', 'job-4');
  assert.equal((idle.entry.handle as any).killed, 0);
  pool.shutdown();
});
