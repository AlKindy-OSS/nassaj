// B-1349: FIRST import — HOME becomes a /var/tmp sandbox before anything reads it.
import '@/shared/__tests__/sandbox-home.js';
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
import { OPENCODE_LATEST_RELEASE_URL } from './descriptors.js';
import { recordJobVersionChange, type SeenMap, type VersionLedger } from './version-drift.js';

/** In-memory drift ledger (the production one is app_config). */
function memoryLedger(initial: SeenMap = {}): VersionLedger & { map: () => SeenMap } {
  let state: SeenMap = structuredClone(initial);
  return {
    map: () => state,
    read: () => structuredClone(state),
    write: (next) => { state = structuredClone(next); },
  };
}

const baseDeps = (over: Partial<VersionStatusDeps> = {}): VersionStatusDeps => ({
  now: () => 1_000,
  isLeased: () => false,
  activeJobId: () => null,
  getJob: () => null,
  recoveryBlocked: () => false,
  pinEnabled: () => false,
  runVersion: async () => null,
  fetchNpmLatest: async () => null,
  fetchGithubLatest: async () => null,
  versionLedger: memoryLedger(),
  driftAudit: () => {},
  compatVerified: () => false,
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

test('T-1871: a snapshot-backed native self-updater is updatable, manual only', async () => {
  _resetLatestCache();
  const s = await getHarnessVersionStatus('cursor', baseDeps({
    runVersion: async () => '2026.07.23-e383d2b',
  }));
  assert.equal(s!.state, 'updatable');
  assert.equal(s!.installedVersion, '2026.07.23-e383d2b');
  assert.equal(s!.latestVersion, null);
  assert.equal(s!.upToDate, null);
  assert.equal(s!.updatable, true);
  assert.equal(s!.manualOnly, true);
  assert.equal(s!.reason, 'no-latest-probe');
  assert.equal(s!.notices, undefined, 'cursor has no extra dialog facts');
});

test('T-1871 qa 8: agy rows say its data is not backed up and it may self-update', async () => {
  _resetLatestCache();
  const s = await getHarnessVersionStatus('agy', baseDeps({ runVersion: async () => '1.2.12' }));
  assert.equal(s!.provider, 'antigravity');
  assert.deepEqual(s!.notices, { dataNotBackedUp: true, selfUpdating: true });
  assert.equal(s!.manualOnly, true);
});

test('binary missing → no-cli/not-installed, never a crash', async () => {
  _resetLatestCache();
  const s = await getHarnessVersionStatus('qwen', baseDeps({ runVersion: async () => null }));
  assert.equal(s!.state, 'no-cli');
  assert.equal(s!.reason, 'not-installed');
  assert.equal(s!.updatable, false);
});

test('armed pin over kimi (snapshot-backed, ADR-189) is not refused outright', async () => {
  _resetLatestCache();
  const s = await getHarnessVersionStatus('kimi', baseDeps({
    runVersion: async () => '0.42.0',
    pinEnabled: () => true,
  }));
  // Leaving the pin needs a pinBreak ack at update time (T-1871 §9), like opencode.
  assert.notEqual(s!.reason, 'pinned');
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
  for (const row of all) {
    assert.ok(typeof row.checkedAt === 'string');
    assert.ok('activeJobId' in row);
  }
});

// ---------------------------------------------------------------------------
// T-1871 stage 2: compatibility, target compatibility, drift, new probes.
// Fixtures are the measured 2026-09-27 values (docs/ops/t1871-measurements.md).
// ---------------------------------------------------------------------------

test('opencode 1.18.33 (pin 1.18.32, flag off) → incompatible in GLM carrier mode', async () => {
  _resetLatestCache();
  const s = await getHarnessVersionStatus('opencode', baseDeps({
    runVersion: async () => '1.18.33',
    fetchGithubLatest: async () => '1.18.33',
  }));
  assert.equal(s!.state, 'updatable');
  assert.equal(s!.updatable, true, 'T-1871 stage 3: snapshot-backed, manual only');
  assert.deepEqual(s!.restoreCompatible, { version: '1.18.32', verified: false });
  assert.equal(s!.compatibility?.state, 'incompatible');
  assert.equal(s!.compatibility?.reason, 'glm-carrier-blocked');
  assert.equal(s!.latestVersion, '1.18.33');
  assert.equal(s!.upToDate, true);
  assert.equal(s!.targetCompatibility?.reason, 'glm-carrier-blocked');
});

test('opencode latest probe uses the fixed GitHub URL', async () => {
  _resetLatestCache();
  const urls: string[] = [];
  await getHarnessVersionStatus('opencode', baseDeps({
    runVersion: async () => '1.18.33',
    fetchGithubLatest: async (url) => { urls.push(url); return '1.18.33'; },
  }));
  assert.deepEqual(urls, [OPENCODE_LATEST_RELEASE_URL]);
  assert.match(OPENCODE_LATEST_RELEASE_URL, /^https:\/\/api\.github\.com\/repos\/anomalyco\/opencode\/releases\/latest$/);
});

test('kimi 2.1.1 (pin 0.28.1, flag off) → untested pin-mismatch-unreviewed; target judged too', async () => {
  _resetLatestCache();
  const s = await getHarnessVersionStatus('kimi', baseDeps({
    runVersion: async () => '2.1.1',
    fetchNpmLatest: async () => '2.1.2',
  }));
  assert.equal(s!.compatibility?.state, 'untested');
  assert.equal(s!.compatibility?.reason, 'pin-mismatch-unreviewed');
  assert.equal(s!.targetCompatibility?.state, 'untested');
  assert.equal(s!.reason, 'update-available');
});

test('restore-compatible offer turns verified only from the durable flag', async () => {
  _resetLatestCache();
  const s = await getHarnessVersionStatus('opencode', baseDeps({
    runVersion: async () => '1.18.32',
    compatVerified: (id) => id === 'opencode',
  }));
  assert.deepEqual(s!.restoreCompatible, { version: '1.18.32', verified: true });
  const kimi = await getHarnessVersionStatus('kimi', baseDeps({ runVersion: async () => '2.1.1' }));
  assert.equal(kimi!.restoreCompatible, undefined, 'kimi restore dropped (stale pin)');
});

test('armed pin: a snapshot-backed pinned harness stays updatable (pinBreak ack instead)', async () => {
  _resetLatestCache();
  const s = await getHarnessVersionStatus('opencode', baseDeps({
    runVersion: async () => '1.18.33',
    pinEnabled: () => true,
  }));
  assert.equal(s!.updatable, true);
  assert.notEqual(s!.reason, 'pinned');
  assert.equal(s!.compatibility?.reason, 'pin-armed-blocked');
});

test('armed pin: kimi row carries incompatible compatibility', async () => {
  _resetLatestCache();
  const s = await getHarnessVersionStatus('kimi', baseDeps({
    runVersion: async () => '2.1.1',
    pinEnabled: () => true,
  }));
  assert.equal(s!.compatibility?.state, 'incompatible');
});

test('claude/codex npm probes feed an updatable manual-only row', async () => {
  _resetLatestCache();
  const pkgs: string[] = [];
  const deps = baseDeps({
    runVersion: async () => '2.1.280 (Claude Code)',
    fetchNpmLatest: async (pkg) => { pkgs.push(pkg); return '2.1.283'; },
  });
  const s = await getHarnessVersionStatus('claude', deps);
  assert.equal(s!.state, 'updatable');
  assert.equal(s!.installedVersion, '2.1.280');
  assert.equal(s!.latestVersion, '2.1.283');
  assert.equal(s!.upToDate, false);
  assert.equal(s!.updatable, true);
  assert.equal(s!.reason, 'update-available');
  assert.equal(s!.compatibility?.state, 'baseline');
  assert.equal(s!.compatibility?.asOf, '2026-09-27');
  assert.equal(s!.targetCompatibility?.reason, 'not-baselined');
  await getHarnessVersionStatus('codex', baseDeps({
    runVersion: async () => 'codex-cli 0.156.0',
    fetchNpmLatest: async (pkg) => { pkgs.push(pkg); return '0.157.1'; },
  }));
  assert.deepEqual(pkgs, ['@anthropic-ai/claude-code', '@openai/codex']);
});

test('a failed latest probe keeps latest null and no target', async () => {
  _resetLatestCache();
  const s = await getHarnessVersionStatus('claude', baseDeps({ runVersion: async () => '2.1.280' }));
  assert.equal(s!.latestVersion, null);
  assert.equal(s!.upToDate, null);
  assert.equal(s!.targetCompatibility, undefined);
});

test('rows without a readable version carry no compatibility/drift', async () => {
  _resetLatestCache();
  const ledger = memoryLedger();
  const none = await getHarnessVersionStatus('qwen', baseDeps({ versionLedger: ledger }));
  assert.equal(none!.compatibility, undefined);
  assert.equal(none!.drift, undefined);
  const hosted = await getHarnessVersionStatus('deepseek', baseDeps({ versionLedger: ledger }));
  assert.equal(hosted!.compatibility, undefined);
  assert.deepEqual(ledger.map(), {}, 'nothing observed, nothing stored');
});

test('drift: first sighting seeds the ledger with no drift and no audit', async () => {
  _resetLatestCache();
  const ledger = memoryLedger();
  const audits: unknown[] = [];
  const s = await getHarnessVersionStatus('antigravity', baseDeps({
    runVersion: async () => '1.2.11',
    versionLedger: ledger,
    driftAudit: (m) => audits.push(m),
  }));
  assert.deepEqual(s!.drift, { detected: false });
  assert.equal(ledger.map().antigravity.version, '1.2.11');
  assert.equal(audits.length, 0);
});

test('drift: unchanged version → no drift, no audit', async () => {
  _resetLatestCache();
  const ledger = memoryLedger({ cursor: { version: '2026.09.18-9a7762b', at: 'x', drift: null } });
  const audits: unknown[] = [];
  const s = await getHarnessVersionStatus('cursor', baseDeps({
    runVersion: async () => '2026.09.18-9a7762b',
    versionLedger: ledger,
    driftAudit: (m) => audits.push(m),
  }));
  assert.deepEqual(s!.drift, { detected: false });
  assert.equal(audits.length, 0);
});

test('drift: change made by a Nassaj job is not drift', async () => {
  _resetLatestCache();
  const ledger = memoryLedger({ kimi: { version: '0.42.0', at: 'x', drift: null } });
  const audits: unknown[] = [];
  recordJobVersionChange('kimi', '2.1.1', { ledger, nowIso: () => '2026-09-27T07:00:00.000Z' });
  const s = await getHarnessVersionStatus('kimi', baseDeps({
    runVersion: async () => '2.1.1',
    versionLedger: ledger,
    driftAudit: (m) => audits.push(m),
  }));
  assert.deepEqual(s!.drift, { detected: false });
  assert.equal(audits.length, 0);
});

test('drift: external change → drift reported on every read, ONE audit row', async () => {
  _resetLatestCache();
  const ledger = memoryLedger({ antigravity: { version: '1.2.11', at: 'x', drift: null } });
  const audits: Array<Record<string, string>> = [];
  const t = Date.parse('2026-09-27T07:00:38.000Z');
  const deps = baseDeps({
    now: () => t,
    runVersion: async () => '1.2.12',
    versionLedger: ledger,
    driftAudit: (m) => audits.push(m),
  });
  const first = await getHarnessVersionStatus('antigravity', deps);
  invalidateInstalledVersion('antigravity');
  const second = await getHarnessVersionStatus('antigravity', deps);
  const expected = { detected: true, from: '1.2.11', to: '1.2.12', at: '2026-09-27T07:00:38.000Z' };
  assert.deepEqual(first!.drift, expected);
  assert.deepEqual(second!.drift, expected);
  assert.deepEqual(audits, [{ provider: 'antigravity', from: '1.2.11', to: '1.2.12' }]);

  // A second external change is a new drift and a second (single) row.
  _resetLatestCache();
  await getHarnessVersionStatus('antigravity', baseDeps({
    runVersion: async () => '1.2.13', versionLedger: ledger, driftAudit: (m) => audits.push(m),
  }));
  assert.equal(audits.length, 2);
  assert.deepEqual(audits[1], { provider: 'antigravity', from: '1.2.12', to: '1.2.13' });
});

test('drift: a failing ledger omits the field and never fails the read', async () => {
  _resetLatestCache();
  const s = await getHarnessVersionStatus('cursor', baseDeps({
    runVersion: async () => '2026.09.18-9a7762b',
    versionLedger: { read: () => { throw new Error('db down'); }, write: () => {} },
  }));
  assert.equal(s!.drift, undefined);
  assert.equal(s!.compatibility?.state, 'baseline');
});
