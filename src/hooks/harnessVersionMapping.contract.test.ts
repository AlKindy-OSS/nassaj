/**
 * harnessVersionMapping.contract.test.ts — the CLIENT↔SERVER contract test for
 * the per-harness version indicator (T-1749 / ADR-159, B-1097 finding 1).
 *
 * WHAT BROKE. The hook read `data.status / data.version / data.progressPercent`.
 * The server never sent any of those: `version-status.service.ts` returns
 * `{ state, installedVersion, latestVersion, upToDate, updatable, updating, … }`
 * and the job returns `{ percent, toVersion }`. Nothing crashed — the badge was
 * simply always `undefined`, which no type checked and no test caught.
 *
 * WHAT THIS PINS. Every fixture below is declared `as HarnessVersionStatus` /
 * `HarnessUpdateJob` — the SERVER's own contract types (`shared/harness-update.
 * contract.ts`, the same file the server compiles against). A field rename on
 * the server is therefore a COMPILE error in this file, and the assertions pin
 * the mapping rules themselves.
 *
 * Runner: node:test (`node scripts/run-isolated-node-tests.mjs src <file>`) —
 * the mappers are pure, so no jsdom/vitest is needed to exercise them.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import type {
  HarnessUpdateJob,
  HarnessVersionStatus,
} from '../../shared/harness-update.contract';
import { isTerminalJob, mapUpdateJob, mapVersionStatus, mayRetryAfterFreshStatus, normalizeHarnessProvider } from './harnessVersionMapping';

/** A contract-shaped status row; overrides are type-checked against the wire type. */
function status(over: Partial<HarnessVersionStatus> = {}): HarnessVersionStatus {
  return {
    provider: 'kimi',
    state: 'updatable',
    installedVersion: '0.42.0',
    latestVersion: '0.42.0',
    upToDate: true,
    updatable: true,
    reason: null,
    checkedAt: '2026-09-11T00:00:00.000Z',
    updating: false,
    activeJobId: null,
    ...over,
  };
}

function job(over: Partial<HarnessUpdateJob> = {}): HarnessUpdateJob {
  return {
    jobId: 'job-1',
    provider: 'kimi',
    status: 'running',
    phase: 'updating',
    percent: 40,
    log: [],
    fromVersion: '0.42.0',
    toVersion: null,
    error: null,
    ...over,
  };
}

test('up-to-date row → updatable, with the INSTALLED version (not `version`)', () => {
  const state = mapVersionStatus(status());
  assert.equal(state.status, 'current');
  assert.equal(state.version, '0.42.0');
  assert.equal(state.latestVersion, '0.42.0');
});

test('upToDate === false → update-available carries both versions', () => {
  const state = mapVersionStatus(status({
    upToDate: false, latestVersion: '0.43.0', reason: 'update-available',
  }));
  assert.equal(state.status, 'update-available');
  assert.equal(state.version, '0.42.0');
  assert.equal(state.latestVersion, '0.43.0');
});

test('updating wins over every other field (a job is running for this harness)', () => {
  const state = mapVersionStatus(status({ updating: true, activeJobId: 'job-9', upToDate: false }));
  assert.equal(state.status, 'running');
});

test('pinned refusal surfaces as its own state, not as "update available"', () => {
  const state = mapVersionStatus(status({ updatable: false, upToDate: null, reason: 'pinned' }));
  assert.equal(state.status, 'pinned-refused');
});

test('no-cli / managed-external / unknown pass through unchanged', () => {
  assert.equal(mapVersionStatus(status({
    state: 'no-cli', installedVersion: null, latestVersion: null, upToDate: null, updatable: false,
  })).status, 'no-cli');
  assert.equal(mapVersionStatus(status({
    state: 'managed-external', upToDate: null, updatable: false, reason: 'managed-external',
  })).status, 'managed-external');
  assert.equal(mapVersionStatus(status({
    state: 'unknown', latestVersion: null, upToDate: null, reason: 'probe-failed',
  })).status, 'unknown');
});

test('a native self-updater (no latest probe) is NOT reported as "Latest"', () => {
  // The server cannot compare, so upToDate is null and reason says why. The UI
  // must keep the reason so the section offers the idempotent update button.
  const state = mapVersionStatus(status({
    provider: 'cursor', installedVersion: '2026.07.23-e383d2b',
    latestVersion: null, upToDate: null, reason: 'no-latest-probe',
  }));
  assert.equal(state.status, 'unverified');
  assert.equal(state.reason, 'no-latest-probe');
});

test('durable recovery fence wins over unknown and never becomes update-capable', () => {
  const state = mapVersionStatus(status({
    state: 'unknown', updatable: false, upToDate: null, latestVersion: null,
    reason: 'recovery_failed', activeJobId: null,
  }));
  assert.equal(state.status, 'failed');
  assert.equal(state.reason, 'recovery_failed');
  assert.equal(state.retryReady, false);
  assert.equal(mayRetryAfterFreshStatus(state), false);
});

test('updatable=false is respected even when the coarse wire state is updatable', () => {
  const state = mapVersionStatus(status({
    updatable: false, upToDate: null, reason: 'rollback-unavailable',
  }));
  assert.equal(state.status, 'managed-external');
  assert.equal(state.reason, 'rollback-unavailable');
});

test('job progress carries phase, percent, bounded-display log source and id', () => {
  const running = mapUpdateJob(job({ percent: 80, log: ['one', 'two'] }));
  assert.equal(running.status, 'running');
  assert.equal(running.progressPercent, 80);
  assert.equal(running.phase, 'updating');
  assert.equal(running.jobId, 'job-1');
  assert.deepEqual(running.log, ['one', 'two']);
  assert.equal(mapUpdateJob(job({ status: 'queued', phase: 'queued', percent: 0 })).status, 'queued');
});

test('a succeeded job reports `toVersion` as the new installed version', () => {
  const state = mapUpdateJob(job({
    status: 'succeeded', phase: 'done', percent: 100, toVersion: '0.43.0',
  }));
  assert.equal(state.status, 'succeeded');
  assert.equal(state.version, '0.43.0');
});

test('skipped_live_session and refused_pinned are NOT "update failed"', () => {
  const skipped = mapUpdateJob(job({
    status: 'skipped_live_session', phase: 'done', percent: 100,
    error: { code: 'live_session_active', message: 'busy' },
  }));
  assert.equal(skipped.status, 'skipped-live');
  assert.equal(skipped.reason, 'live_session_active');

  const pinned = mapUpdateJob(job({
    status: 'refused_pinned', phase: 'done', percent: 100,
    error: { code: 'pinned_refused', message: 'pinned' },
  }));
  assert.equal(pinned.status, 'pinned-refused');
  assert.equal(pinned.reason, 'pinned_refused');
});

test('a failed job keeps the server error CODE for the message lookup', () => {
  const state = mapUpdateJob(job({
    status: 'failed', phase: 'done', percent: 100,
    error: { code: 'update_timeout', message: 'Update timed out.' },
  }));
  assert.equal(state.status, 'failed');
  assert.equal(state.reason, 'update_timeout');
});

test('isTerminalJob matches the contract status union exactly', () => {
  const terminal: Array<HarnessUpdateJob['status']> = [
    'succeeded', 'failed', 'skipped_live_session', 'refused_pinned',
  ];
  const running: Array<HarnessUpdateJob['status']> = ['queued', 'running'];
  for (const s of terminal) assert.equal(isTerminalJob(s), true, s);
  for (const s of running) assert.equal(isTerminalJob(s), false, s);
});


test('aliases and GLM carrier resolve to the server harness id', () => {
  assert.equal(normalizeHarnessProvider('agy'), 'antigravity');
  assert.equal(normalizeHarnessProvider('cursor-agent'), 'cursor');
  assert.equal(normalizeHarnessProvider('glm'), 'opencode');
  assert.equal(normalizeHarnessProvider('deepseek'), 'deepseek');
});

test('recovery and rollback failures never expose retry; restored failures require fresh status', () => {
  const recovery = mapUpdateJob(job({ status: 'failed', error: { code: 'recovery_failed', message: 'repair' } }));
  assert.equal(mayRetryAfterFreshStatus(recovery), false);
  const rollback = mapUpdateJob(job({ status: 'failed', error: { code: 'rollback-unavailable', message: 'none' } }));
  assert.equal(mayRetryAfterFreshStatus(rollback), false);
  const ordinary = mapUpdateJob(job({ status: 'failed', error: { code: 'update_failed', message: 'restored' } }));
  assert.equal(mayRetryAfterFreshStatus(ordinary), false);
  assert.equal(mayRetryAfterFreshStatus({ ...ordinary, retryReady: true }), true);
});
