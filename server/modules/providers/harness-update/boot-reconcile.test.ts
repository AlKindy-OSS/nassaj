/**
 * T-1871 stage 3b — boot reconcile, one test per §8 crash phase (qa condition
 * 9), plus the boot ordering in server/index.js. Every crash is seeded on a
 * /var/tmp fixture with the real snapshot libraries; `--version` is emulated.
 */

// B-1349: FIRST import — HOME becomes a /var/tmp sandbox before anything reads it.
import '@/shared/__tests__/sandbox-home.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { after, before, beforeEach, test } from 'node:test';

import { initializeDatabase } from '@/modules/database/index.js';

import { reconcileHarnessSnapshots } from './boot-reconcile.js';
import { isUpdaterGroupAlive, processStartToken, updaterGroupOf } from './harness-lock.js';
import { takeBinarySnapshot } from './snapshot/binary-snapshot.js';
import { hashFile } from './snapshot/durable-fs.js';
import {
  loadManifest,
  persistRestore,
  writeManifest,
  type HarnessSnapshotManifest,
  type ManifestState,
} from './snapshot/manifest.js';
import { jobSnapshotDir } from './snapshot/paths.js';
import { backupStores, CODEX_STORE, enumerateStoreCoverage, restoreStores } from './snapshot/store-backup.js';
import { removeFixture } from './snapshot/__tests__/fixtures.js';
import { codexLayout } from './snapshot-layouts.js';
import { _setSnapshotRuntimeOverrides } from './snapshot-runtime.js';
import {
  _resetHarnessLaunches,
  clearHarnessRecoveryBlocked,
  isHarnessRecoveryBlocked,
  isSpawnBlockedForRunProvider,
  markHarnessRecoveryBlocked,
} from './spawn-admission.js';
import { _setSharedSpawnLedger } from './spawn-ledger.js';
import { codexInstaller, installCodex, liveVersion, makeWorld, writeStore, type World } from './__tests__/harness-world.js';

const worlds: World[] = [];
let w: World;

before(async () => {
  await initializeDatabase();
});

beforeEach(() => {
  _resetHarnessLaunches();
  for (const id of ['claude', 'codex', 'antigravity', 'cursor', 'opencode']) clearHarnessRecoveryBlocked(id);
  w = makeWorld();
  worlds.push(w);
  _setSnapshotRuntimeOverrides(w.rt);
  _setSharedSpawnLedger(w.ledger);
});

after(() => {
  _setSnapshotRuntimeOverrides(null);
  _setSharedSpawnLedger(null);
  for (const x of worlds) removeFixture(x.root);
});

const JOB = 'job-crash';

interface Seeded {
  dir: string;
  store: string;
  launcher: string;
  manifest: HarnessSnapshotManifest;
}

/** A codex job snapshotted for real, persisted in `state`; `updated` = the updater already ran. */
function seed(state: ManifestState, updated: boolean): Seeded {
  const { codexHome } = installCodex(w, '1.0.0');
  const store = path.join(codexHome, 'state_5.sqlite');
  writeStore(store, 'v1');
  const launcher = path.join(w.home, '.local', 'bin', 'codex');
  const dir = jobSnapshotDir(w.snapshotRoot, 'codex', JOB);
  const binary = takeBinarySnapshot(codexLayout(launcher), dir);
  const stores = backupStores(enumerateStoreCoverage([CODEX_STORE], w.home), dir, () => {});
  const manifest: HarnessSnapshotManifest = {
    schema: 1, jobId: JOB, harness: 'codex', kind: 'update', trigger: 'manual', userId: 1,
    createdAt: w.clock.now, expiresAt: w.clock.now + 7 * 24 * 3600 * 1000, state,
    stateHistory: [{ state, at: w.clock.now }],
    from: { version: '1.0.0', binarySha256: hashFile(fs.realpathSync(launcher)).sha256, treeSha256: binary.treeSha256 },
    to: null, binary, stores, restore: null, counted: false,
  };
  writeManifest(dir, manifest);
  markHarnessRecoveryBlocked('codex');
  if (updated) {
    codexInstaller(w, '2.0.0')('codex', ['update'], { CODEX_HOME: codexHome });
    fs.writeFileSync(store, 'v2-migrated');
  }
  return { dir, store, launcher, manifest };
}

for (const state of ['snapshotting', 'snapshotted', 'recheck'] as const) {
  test(`crash in ${state} → snapshot deleted, abandoned, fence cleared`, async () => {
    const s = seed(state, false);
    const report = await reconcileHarnessSnapshots();
    assert.equal(report.abandoned, 1);
    // abandoned is terminal: boot retention then drops the whole job dir.
    assert.equal(fs.existsSync(path.join(s.dir, 'binary')), false);
    assert.equal(fs.existsSync(s.dir), false);
    assert.equal(liveVersion(s.launcher), '1.0.0');
    assert.equal(isHarnessRecoveryBlocked('codex'), false);
  });
}

test('crash in mutating with live == from → abandoned, nothing restored', async () => {
  const s = seed('mutating', false);
  const report = await reconcileHarnessSnapshots();
  assert.equal(report.abandoned, 1);
  assert.equal(report.rolledBack, 0);
  assert.equal(fs.existsSync(s.dir), false);
  assert.equal(fs.readFileSync(s.store, 'utf8'), 'v1');
  assert.equal(isHarnessRecoveryBlocked('codex'), false);
});

for (const state of ['mutating', 'verifying'] as const) {
  test(`crash in ${state} after the updater ran → autoRollback (binary + changed stores)`, async () => {
    const s = seed(state, true);
    const report = await reconcileHarnessSnapshots();
    assert.equal(report.rolledBack, 1);
    assert.equal(loadManifest(s.dir).state, 'rolled_back');
    assert.equal(liveVersion(s.launcher), '1.0.0');
    assert.equal(fs.readFileSync(s.store, 'utf8'), 'v1');
    assert.equal(isHarnessRecoveryBlocked('codex'), false);
  });
}

test('crash in recovering during store swapping → rolled forward, then binary restored', async () => {
  const s = seed('recovering', true);
  assert.throws(() => restoreStores(s.dir, s.manifest, 'auto', {
    now: w.clock.now,
    assertNoHolders: () => {},
    beforeStep: (phase) => { if (phase === 'swapping') throw new Error('crash'); },
  }));
  assert.equal(loadManifest(s.dir).restore?.phase, 'swapping');
  const report = await reconcileHarnessSnapshots();
  assert.equal(report.rolledBack, 1);
  const m = loadManifest(s.dir);
  assert.equal(m.state, 'rolled_back');
  assert.equal(m.restore?.phase, 'committed');
  assert.equal(fs.readFileSync(s.store, 'utf8'), 'v1');
  assert.equal(liveVersion(s.launcher), '1.0.0');
});

test('crash in recovering after a reverted store journal → restore redone', async () => {
  const s = seed('recovering', true);
  assert.throws(() => restoreStores(s.dir, s.manifest, 'auto', {
    now: w.clock.now,
    assertNoHolders: () => {},
    beforeStep: (phase) => { if (phase === 'asiding') throw new Error('crash'); },
  }));
  assert.equal(loadManifest(s.dir).restore?.phase, 'reverted');
  assert.equal(fs.readFileSync(s.store, 'utf8'), 'v2-migrated');
  await reconcileHarnessSnapshots();
  assert.equal(loadManifest(s.dir).state, 'rolled_back');
  assert.equal(fs.readFileSync(s.store, 'utf8'), 'v1');
});

test('crash in manual_restoring (binary scope) → the owner-requested restore completes', async () => {
  const s = seed('manual_restoring', true);
  persistRestore(s.dir, loadManifest(s.dir), {
    kind: 'manual', scope: 'binary', startedAt: w.clock.now, phase: 'staging', files: [], dataLossAck: false,
  });
  const report = await reconcileHarnessSnapshots();
  assert.equal(report.rolledBack, 1);
  assert.equal(liveVersion(s.launcher), '1.0.0');
  assert.equal(fs.readFileSync(s.store, 'utf8'), 'v2-migrated', 'binary scope keeps data');
  assert.equal(loadManifest(s.dir).restore?.phase, 'committed');
});

test('rollback_failed stays blocked (owner alert); other harnesses are admitted', async () => {
  const s = seed('rollback_failed', true);
  const report = await reconcileHarnessSnapshots();
  assert.deepEqual(report.blocked, ['codex']);
  assert.equal(loadManifest(s.dir).state, 'rollback_failed');
  assert.equal(isHarnessRecoveryBlocked('codex'), true);
  assert.equal(isSpawnBlockedForRunProvider('codex'), true);
  assert.equal(isSpawnBlockedForRunProvider('opencode'), false);
  assert.ok(w.audits.some((a) => a.action === 'harness_update_rollback_failed' && a.metadata.ownerAlert === true));
});

test('a failed boot restore leaves the harness blocked', async () => {
  seed('mutating', true);
  w.versionOverride = (bin) => (bin.includes('codex') ? 'codex-cli 7.7.7' : null);
  const report = await reconcileHarnessSnapshots();
  assert.equal(report.rollbackFailed, 1);
  assert.equal(isHarnessRecoveryBlocked('codex'), true);
});

test('an unreadable manifest fails closed for that harness only', async () => {
  const dir = jobSnapshotDir(w.snapshotRoot, 'cursor', 'job-bad');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'manifest.json'), '{not json');
  const report = await reconcileHarnessSnapshots();
  assert.equal(report.invalid, 1);
  assert.deepEqual(report.blocked, ['cursor']);
  assert.equal(isHarnessRecoveryBlocked('cursor'), true);
  assert.equal(isHarnessRecoveryBlocked('codex'), false);
});

test('a job a live sibling process owns is left alone', async () => {
  const s = seed('mutating', true);
  const parent = process.ppid;
  fs.writeFileSync(path.join(w.snapshotRoot, '.codex.lock'), JSON.stringify({ pid: parent, start: processStartToken(parent), jobId: JOB }));
  const report = await reconcileHarnessSnapshots();
  assert.deepEqual(report.skippedElsewhere, ['codex']);
  assert.equal(loadManifest(s.dir).state, 'mutating');
  assert.equal(liveVersion(s.launcher), '2.0.0');
});

test('spawns stay blocked while reconcile runs, and open afterwards', async () => {
  seed('mutating', true);
  const seen: boolean[] = [];
  w.versionOverride = (bin) => {
    seen.push(isSpawnBlockedForRunProvider('codex'), isSpawnBlockedForRunProvider('cursor'));
    return fs.readFileSync(fs.realpathSync(bin), 'utf8');
  };
  await reconcileHarnessSnapshots();
  assert.ok(seen.length > 0 && seen.every(Boolean), 'every snapshot-backed harness blocked during reconcile');
  assert.equal(isSpawnBlockedForRunProvider('codex'), false);
  assert.equal(isSpawnBlockedForRunProvider('cursor'), false);
});

test('succeeded run without a ledger entry reads unknown; boot prune drops expired snapshots', async () => {
  const s = seed('succeeded', false);
  clearHarnessRecoveryBlocked('codex');
  assert.equal(w.ledger.spawnFactsSince('codex', JOB).unknown, true);
  w.clock.now += 8 * 24 * 3600 * 1000;
  await reconcileHarnessSnapshots();
  assert.equal(fs.existsSync(s.dir), false);
  assert.ok(w.audits.some((a) => a.action === 'harness_snapshot_pruned' && a.metadata.jobId === JOB));
});

test('server boot runs reconcile after the DB and before background admission, scheduler and listener', () => {
  const src = fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../index.js'), 'utf8');
  const at = (needle: string) => {
    const i = src.indexOf(needle);
    assert.ok(i >= 0, `missing ${needle}`);
    return i;
  };
  const reconcile = at('await reconcileHarnessSnapshots();');
  assert.ok(reconcile > at('await initializeDatabase();'));
  assert.ok(reconcile < at('await backgroundLifecycle.prepare();'));
  assert.ok(reconcile < at('startHarnessAutoUpdateScheduler();'));
  assert.ok(reconcile < at('await listenWithGuard({'));
});

test('C-1: a live updater group from the crashed process is killed and proven dead before the restore', async () => {
  const s = seed('mutating', true);
  const child = spawn('/bin/sh', ['-c', 'sleep 60 & sleep 60'], { cwd: w.root, detached: true, stdio: 'ignore' });
  await new Promise((resolve) => setTimeout(resolve, 100));
  const group = updaterGroupOf(child.pid!);
  writeManifest(s.dir, { ...loadManifest(s.dir), updater: group });
  assert.equal(isUpdaterGroupAlive(group), true, 'precondition: the stub updater group runs');
  const report = await reconcileHarnessSnapshots();
  assert.equal(isUpdaterGroupAlive(group), false, 'every member of the group is dead');
  assert.equal(report.rolledBack, 1);
  assert.equal(liveVersion(s.launcher), '1.0.0');
});

test('C-1: an updater group that cannot be proven dead → rollback_failed, nothing restored', async () => {
  const s = seed('verifying', true);
  writeManifest(s.dir, { ...loadManifest(s.dir), updater: { pgid: 424242, startToken: 'x' } });
  const killed: number[] = [];
  _setSnapshotRuntimeOverrides({
    ...w.rt,
    updaterDeathWaitMs: 60,
    updaterGroup: { isAlive: () => true, kill: (g) => { killed.push(g.pgid); } },
  });
  const report = await reconcileHarnessSnapshots();
  assert.deepEqual(killed, [424242]);
  assert.equal(report.rollbackFailed, 1);
  assert.deepEqual(report.blocked, ['codex']);
  assert.equal(loadManifest(s.dir).state, 'rollback_failed');
  assert.equal(liveVersion(s.launcher), '2.0.0', 'never restored under a live writer');
  assert.equal(isHarnessRecoveryBlocked('codex'), true);
});

test('spec §8: an unmutated job whose live install moved is blocked, snapshot kept', async () => {
  const s = seed('snapshotted', true);
  const report = await reconcileHarnessSnapshots();
  assert.deepEqual(report.blocked, ['codex']);
  assert.equal(loadManifest(s.dir).state, 'rollback_failed');
  assert.ok(fs.existsSync(path.join(s.dir, 'binary')));
  assert.equal(isHarnessRecoveryBlocked('codex'), true);
});

test('M-2: an orphaned fence with every job terminal is cleared when live matches the newest end state', async () => {
  const s = seed('succeeded', false);
  writeManifest(s.dir, { ...loadManifest(s.dir), to: s.manifest.from });
  await reconcileHarnessSnapshots();
  assert.equal(isHarnessRecoveryBlocked('codex'), false);
});

test('M-2: an orphaned fence stays when live does not match the newest end state', async () => {
  const s = seed('rolled_back', true);
  const report = await reconcileHarnessSnapshots();
  assert.deepEqual(report.blocked, ['codex']);
  assert.equal(isHarnessRecoveryBlocked('codex'), true);
  assert.equal(liveVersion(s.launcher), '2.0.0', 'nothing is changed to "fix" the mismatch');
});

test('M-2: a fence with no manifest at all is left for the owner (unknown origin)', async () => {
  markHarnessRecoveryBlocked('cursor');
  await reconcileHarnessSnapshots();
  assert.equal(isHarnessRecoveryBlocked('cursor'), true);
});

test('a live group leader with another start token is a reused pid, not our updater', async () => {
  const child = spawn('/bin/sh', ['-c', 'sleep 30'], { cwd: w.root, detached: true, stdio: 'ignore' });
  await new Promise((resolve) => setTimeout(resolve, 50));
  const group = updaterGroupOf(child.pid!);
  try {
    assert.equal(isUpdaterGroupAlive(group), true);
    assert.equal(isUpdaterGroupAlive({ ...group, startToken: `${group.startToken}0` }), false);
    assert.equal(isUpdaterGroupAlive({ ...group, bootId: 'another-boot' }), false, 'recorded under another boot = dead');
    assert.equal(isUpdaterGroupAlive({ ...group, bootId: null }), true, 'legacy record without a boot id');
  } finally {
    process.kill(-group.pgid, 'SIGKILL');
  }
});
