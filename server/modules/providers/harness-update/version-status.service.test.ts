import assert from 'node:assert/strict';
import test from 'node:test';

import {
  _resetLatestCache,
  getAllHarnessVersionStatuses,
  getHarnessVersionStatus,
  INSTALLED_TTL_MS,
  invalidateInstalledVersion,
  LATEST_RATE_LIMIT_MS,
  LATEST_TTL_MS,
  type VersionStatusDeps,
} from './version-status.service.js';

const baseDeps = (over: Partial<VersionStatusDeps> = {}): VersionStatusDeps => ({
  now: () => 1_000,
  isLeased: () => false,
  activeJobId: () => null,
  getJob: () => null,
  recoveryBlocked: () => false,
  pinEnabled: () => false,
  runVersion: async () => null,
  fetchNpmLatest: async () => null,
  ...over,
});

test('no-cli providers report state no-cli, nothing updatable', async () => {
  _resetLatestCache();
  const glm = await getHarnessVersionStatus('glm', baseDeps());
  assert.equal(glm!.state, 'no-cli');
  assert.equal(glm!.updatable, false);
  assert.equal(glm!.reason, 'updates with opencode');
  assert.equal(glm!.installedVersion, null);
});

test('hermes reports updatable with a read installed version (Addendum 3)', async () => {
  _resetLatestCache();
  const hermes = await getHarnessVersionStatus('hermes', baseDeps({
    runVersion: async () => 'Hermes Agent v0.17.0 (2026.6.19)',
  }));
  assert.equal(hermes!.state, 'updatable');
  assert.equal(hermes!.installedVersion, '0.17.0');
  assert.equal(hermes!.updatable, true);
  // No cheap "latest" probe for a git build: nothing is compared, so the UI must
  // not claim "Latest" — it offers the idempotent updater instead.
  assert.equal(hermes!.upToDate, null);
  assert.equal(hermes!.reason, 'no-latest-probe');
});

test('the installed-version probe is TTL-cached and invalidated by an update', async () => {
  _resetLatestCache();
  let reads = 0;
  const deps = baseDeps({
    runVersion: async () => { reads += 1; return '0.42.0'; },
    fetchNpmLatest: async () => '0.42.0',
  });
  await getHarnessVersionStatus('kimi', deps);
  await getHarnessVersionStatus('kimi', deps);
  await getHarnessVersionStatus('kimi', deps);
  assert.equal(reads, 1, 'three status reads spawn ONE `--version` child');

  // An update changing the bytes must not leave a stale version on screen.
  invalidateInstalledVersion('kimi');
  await getHarnessVersionStatus('kimi', deps);
  assert.equal(reads, 2);

  // And the TTL expires on its own.
  await getHarnessVersionStatus('kimi', baseDeps({
    now: () => 1_000 + INSTALLED_TTL_MS + 1,
    runVersion: async () => { reads += 1; return '0.43.0'; },
    fetchNpmLatest: async () => '0.43.0',
  }));
  assert.equal(reads, 3);
});

test('kimi up-to-date: installed === npm latest', async () => {
  _resetLatestCache();
  const s = await getHarnessVersionStatus('kimi', baseDeps({
    runVersion: async () => '0.42.0',
    fetchNpmLatest: async () => '0.42.0',
  }));
  assert.equal(s!.state, 'updatable');
  assert.equal(s!.installedVersion, '0.42.0');
  assert.equal(s!.latestVersion, '0.42.0');
  assert.equal(s!.upToDate, true);
  assert.equal(s!.updatable, true);
  assert.equal(s!.reason, null);
});

test('kimi update-available when latest is newer', async () => {
  _resetLatestCache();
  const s = await getHarnessVersionStatus('kimi', baseDeps({
    runVersion: async () => '0.42.0',
    fetchNpmLatest: async () => '0.43.0',
  }));
  assert.equal(s!.upToDate, false);
  assert.equal(s!.reason, 'update-available');
});

test('FAIL-CLOSED: probe failure with no cache → state unknown, never a crash', async () => {
  _resetLatestCache();
  const s = await getHarnessVersionStatus('kimi', baseDeps({
    runVersion: async () => '0.42.0',
    fetchNpmLatest: async () => null,
  }));
  assert.equal(s!.state, 'unknown');
  assert.equal(s!.latestVersion, null);
  assert.equal(s!.upToDate, null);
  assert.equal(s!.reason, 'probe-failed');
});

test('stale-on-network-failure: an expired cache is served, marked latest-stale', async () => {
  _resetLatestCache();
  // Prime the cache with a success at t=1000.
  await getHarnessVersionStatus('qwen', baseDeps({
    now: () => 1_000,
    runVersion: async () => '0.23.0',
    fetchNpmLatest: async () => '0.23.0',
  }));
  // Later than TTL + rate-limit, the probe fails but the stale value survives.
  const later = 1_000 + LATEST_TTL_MS + LATEST_RATE_LIMIT_MS + 1;
  const s = await getHarnessVersionStatus('qwen', baseDeps({
    now: () => later,
    runVersion: async () => '0.23.0',
    fetchNpmLatest: async () => null,
  }));
  assert.equal(s!.state, 'updatable');
  assert.equal(s!.latestVersion, '0.23.0');
  assert.equal(s!.reason, 'latest-stale');
});

test('native self-updater without exact rollback stays managed externally', async () => {
  _resetLatestCache();
  const s = await getHarnessVersionStatus('cursor', baseDeps({
    runVersion: async () => '2026.07.23-e383d2b',
  }));
  assert.equal(s!.state, 'managed-external');
  assert.equal(s!.installedVersion, '2026.07.23-e383d2b');
  assert.equal(s!.latestVersion, null);
  assert.equal(s!.upToDate, null);
  assert.equal(s!.updatable, false);
  assert.equal(s!.reason, 'rollback-unavailable');
});

test('binary missing → no-cli/not-installed, never a crash', async () => {
  _resetLatestCache();
  const s = await getHarnessVersionStatus('qwen', baseDeps({ runVersion: async () => null }));
  assert.equal(s!.state, 'no-cli');
  assert.equal(s!.reason, 'not-installed');
  assert.equal(s!.updatable, false);
});

test('armed pin over a pinned harness → not updatable, reason pinned (item 5)', async () => {
  _resetLatestCache();
  const s = await getHarnessVersionStatus('kimi', baseDeps({
    runVersion: async () => '0.42.0',
    pinEnabled: () => true,
  }));
  assert.equal(s!.updatable, false);
  assert.equal(s!.reason, 'pinned');
});

test('a running job surfaces updating + activeJobId', async () => {
  _resetLatestCache();
  const s = await getHarnessVersionStatus('cursor', baseDeps({
    runVersion: async () => '2026.07.23-e383d2b',
    isLeased: () => true,
    activeJobId: () => 'job-xyz',
    getJob: () => ({
      jobId: 'job-xyz', provider: 'cursor', status: 'running', phase: 'updating',
      percent: 50, log: [], fromVersion: null, toVersion: null, error: null,
    }),
  }));
  assert.equal(s!.updating, true);
  assert.equal(s!.activeJobId, 'job-xyz');
});

test('durable recovery fence survives memory reset and skips unsafe probes', async () => {
  _resetLatestCache();
  let probes = 0;
  const s = await getHarnessVersionStatus('kimi', baseDeps({
    recoveryBlocked: () => true,
    runVersion: async () => { probes += 1; return '0.42.0'; },
    fetchNpmLatest: async () => { probes += 1; return '0.43.0'; },
  }));
  assert.equal(s!.reason, 'recovery_failed');
  assert.equal(s!.updatable, false);
  assert.equal(s!.updating, false);
  assert.equal(s!.activeJobId, null);
  assert.equal(probes, 0);
});

test('durable fence read failure fails closed without probing the binary', async () => {
  _resetLatestCache();
  let probes = 0;
  const s = await getHarnessVersionStatus('qwen', baseDeps({
    recoveryBlocked: () => { throw new Error('database unavailable'); },
    runVersion: async () => { probes += 1; return '0.23.0'; },
  }));
  assert.equal(s!.reason, 'recovery_failed');
  assert.equal(s!.updatable, false);
  assert.equal(s!.updating, false);
  assert.equal(probes, 0);
});

test('a coherent active mutation intent remains running without probing', async () => {
  _resetLatestCache();
  let probes = 0;
  const s = await getHarnessVersionStatus('qwen', baseDeps({
    recoveryBlocked: () => true,
    isLeased: () => true,
    activeJobId: () => 'job-running',
    getJob: () => ({
      jobId: 'job-running', provider: 'qwen', status: 'running', phase: 'updating',
      percent: 50, log: [], fromVersion: '0.23.0', toVersion: null, error: null,
    }),
    runVersion: async () => { probes += 1; return '0.23.0'; },
  }));
  assert.equal(s!.updating, true);
  assert.equal(s!.activeJobId, 'job-running');
  assert.equal(s!.updatable, false);
  assert.equal(s!.reason, null);
  assert.equal(probes, 0);
});

test('failed recovery holding a lease is not reported as endlessly running', async () => {
  _resetLatestCache();
  let probes = 0;
  const s = await getHarnessVersionStatus('qwen', baseDeps({
    recoveryBlocked: () => true,
    isLeased: () => true,
    activeJobId: () => 'job-failed',
    getJob: () => ({
      jobId: 'job-failed', provider: 'qwen', status: 'failed', phase: 'done',
      percent: 100, log: [], fromVersion: '0.23.0', toVersion: null,
      error: { code: 'recovery_failed', message: 'repair required' },
    }),
    runVersion: async () => { probes += 1; return '0.23.0'; },
  }));
  assert.equal(s!.reason, 'recovery_failed');
  assert.equal(s!.updating, false);
  assert.equal(s!.activeJobId, null);
  assert.equal(probes, 0);
});

test('getAll returns one row per harness in the contract shape', async () => {
  _resetLatestCache();
  const all = await getAllHarnessVersionStatuses(baseDeps({ runVersion: async () => '1.0.0' }));
  const ids = all.map((s) => s.provider);
  assert.ok(ids.includes('claude'));
  assert.ok(ids.includes('hermes'));
  assert.ok(ids.includes('glm'));
  assert.ok(!ids.includes('gemini')); // removed provider is not a harness
  for (const row of all) {
    assert.ok(typeof row.checkedAt === 'string');
    assert.ok('activeJobId' in row);
  }
});
