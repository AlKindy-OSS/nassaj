/**
 * T-1871 stage 3b — manual rollback (C-A dataLoss rules), restore-compatible
 * (opencode only, verified flag only after a real run), owner recovery out of
 * rollback_failed, and the snapshot listing. /var/tmp fixtures, stubbed
 * updater and asset installer only.
 */

// B-1349: FIRST import — HOME becomes a /var/tmp sandbox before anything reads it.
import '@/shared/__tests__/sandbox-home.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, beforeEach, test } from 'node:test';

import { initializeDatabase } from '@/modules/database/index.js';
import { AppError } from '@/shared/utils.js';

import { _resetHarnessLeases, isHarnessLeased } from './lease.js';
import {
  listHarnessSnapshots,
  startManualRollback,
  startRecovery,
  startRestoreCompatible,
} from './rollback.service.js';
import { loadManifest } from './snapshot/manifest.js';
import { restoreStores } from './snapshot/store-backup.js';
import { removeFixture, writeFixtureFile } from './snapshot/__tests__/fixtures.js';
import { _setSnapshotRuntimeOverrides } from './snapshot-runtime.js';
import {
  _resetHarnessLaunches,
  beginHarnessLaunch,
  clearHarnessRecoveryBlocked,
  isHarnessRecoveryBlocked,
} from './spawn-admission.js';
import { _setSharedSpawnLedger } from './spawn-ledger.js';
import { _awaitHarnessJob, _resetHarnessJobs, getHarnessUpdateJob, startHarnessUpdate } from './update.service.js';
import {
  codexInstaller,
  fakeAsset,
  installCodex,
  installSingleFile,
  liveVersion,
  makeWorld,
  writeStore,
  type World,
} from './__tests__/harness-world.js';

const worlds: World[] = [];
let w: World;

before(async () => {
  await initializeDatabase();
});

beforeEach(() => {
  _resetHarnessLeases();
  _resetHarnessJobs();
  _resetHarnessLaunches();
  for (const id of ['codex', 'opencode', 'cursor', 'antigravity', 'claude']) clearHarnessRecoveryBlocked(id);
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

const codeOf = (c: string) => (e: unknown) => e instanceof AppError && e.code === c;
type Required = { kind: string; token: string; textEn: string; facts: Record<string, unknown> }[];

async function requiredOf(p: Promise<unknown>): Promise<Required> {
  try {
    await p;
  } catch (e) {
    assert.ok(e instanceof AppError && e.code === 'CONFIRMATION_REQUIRED', String(e));
    return (e.details as { required: Required }).required;
  }
  throw new Error('expected CONFIRMATION_REQUIRED');
}

/** A succeeded codex update (1.0.0 → 2.0.0) whose member store the update migrated. */
async function succeededCodexRun(): Promise<{ jobId: string; store: string }> {
  const { codexHome } = installCodex(w, '1.0.0');
  const store = path.join(codexHome, 'state_5.sqlite');
  writeStore(store, 'v1');
  w.updater = codexInstaller(w, '2.0.0', 0, () => fs.writeFileSync(store, 'v2-migrated'));
  const job = await startHarnessUpdate('codex', { userId: 1 });
  await _awaitHarnessJob(job.jobId);
  assert.equal(getHarnessUpdateJob(job.jobId)!.status, 'succeeded');
  return { jobId: job.jobId, store };
}

/**
 * Changes the MAC's last char. A 32-byte HMAC in base64url ends in one of 16
 * chars, so a fixed replacement ('A') was a no-op ~1 run in 16 (flaky 409 test).
 */
const tamper = (token: string): string => token.slice(0, -1) + (token.endsWith('A') ? 'E' : 'A');

const launcher = () => path.join(w.home, '.local', 'bin', 'codex');

test('binary-only rollback needs no dataLoss ack even after spawns; data stays', async () => {
  const run = await succeededCodexRun();
  beginHarnessLaunch('codex')();
  const job = await startManualRollback({ harness: 'codex', jobId: run.jobId, scope: 'binary', acks: undefined, userId: 1 });
  await _awaitHarnessJob(job.jobId);
  assert.equal(getHarnessUpdateJob(job.jobId)!.status, 'rolled_back');
  assert.equal(liveVersion(launcher()), '1.0.0');
  assert.equal(fs.readFileSync(run.store, 'utf8'), 'v2-migrated', 'binary scope never touches data');
  assert.equal(isHarnessRecoveryBlocked('codex'), false);
});

test('binary+data after a spawn → 409 dataLoss (facts from the ledger), then restores with the ack', async () => {
  const run = await succeededCodexRun();
  w.clock.now += 1000;
  beginHarnessLaunch('codex')();
  const req = { harness: 'codex', jobId: run.jobId, scope: 'binary+data', userId: 1 };
  const required = await requiredOf(startManualRollback({ ...req, acks: undefined }));
  assert.equal(required.length, 1);
  assert.equal(required[0].kind, 'dataLoss');
  assert.equal(required[0].facts.spawnCount, 1);
  assert.equal(required[0].facts.storeCount, 1);
  assert.match(required[0].textEn, /started 1 time\(s\)/);
  const tampered = [{ kind: 'dataLoss', token: tamper(required[0].token) }];
  await assert.rejects(() => startManualRollback({ ...req, acks: tampered }), codeOf('CONFIRMATION_REQUIRED'));
  const fresh = await requiredOf(startManualRollback({ ...req, acks: undefined }));
  const job = await startManualRollback({ ...req, acks: [{ kind: 'dataLoss', token: fresh[0].token }] });
  await _awaitHarnessJob(job.jobId);
  assert.equal(getHarnessUpdateJob(job.jobId)!.status, 'rolled_back');
  assert.equal(fs.readFileSync(run.store, 'utf8'), 'v1');
  assert.ok(fs.readdirSync(path.dirname(run.store)).some((n) => n.includes('.nassaj-pre-restore-')), 'current data kept aside');
});

test('facts change between 409 and resend (another spawn) → fresh 409', async () => {
  const run = await succeededCodexRun();
  beginHarnessLaunch('codex')();
  const req = { harness: 'codex', jobId: run.jobId, scope: 'binary+data', userId: 1 };
  const first = await requiredOf(startManualRollback({ ...req, acks: undefined }));
  beginHarnessLaunch('codex')();
  const second = await requiredOf(startManualRollback({ ...req, acks: [{ kind: 'dataLoss', token: first[0].token }] }));
  assert.equal(second[0].facts.spawnCount, 2);
});

test('no spawn but an external store write → 409; a missing ledger → 409 "unknown number"', async () => {
  const run = await succeededCodexRun();
  const req = { harness: 'codex', jobId: run.jobId, scope: 'binary+data', userId: 1, acks: undefined };
  fs.writeFileSync(run.store, 'written-outside-nassaj');
  const byStore = await requiredOf(startManualRollback(req));
  assert.equal(byStore[0].facts.changedStores, 1);
  assert.equal(byStore[0].facts.spawnCount, 0);
  fs.writeFileSync(run.store, 'v2-migrated');
  fs.rmSync(path.join(w.home, '.local', 'share', 'nassaj', 'harness-spawn-ledger.json'));
  const byLedger = await requiredOf(startManualRollback(req));
  assert.equal(byLedger[0].facts.spawnCount, null);
  assert.match(byLedger[0].textEn, /an unknown number of time\(s\)/);
});

test('unchanged stores and no spawn → binary+data restores without an ack', async () => {
  const run = await succeededCodexRun();
  const job = await startManualRollback({ harness: 'codex', jobId: run.jobId, scope: 'binary+data', acks: undefined, userId: 1 });
  await _awaitHarnessJob(job.jobId);
  assert.equal(getHarnessUpdateJob(job.jobId)!.status, 'rolled_back');
  assert.equal(fs.readFileSync(run.store, 'utf8'), 'v1');
});

test('refusals: unknown/expired run 404, bad scope 400, tampered snapshot 409, name conflict 409', async () => {
  const run = await succeededCodexRun();
  const base = { harness: 'codex', scope: 'binary', acks: undefined, userId: 1 };
  await assert.rejects(() => startManualRollback({ ...base, jobId: '../x' }), codeOf('SNAPSHOT_NOT_FOUND'));
  await assert.rejects(() => startManualRollback({ ...base, jobId: run.jobId, scope: 'all' }), codeOf('INVALID_ROLLBACK_SCOPE'));
  await assert.rejects(() => startManualRollback({ ...base, harness: 'qwen', jobId: run.jobId }), codeOf('SNAPSHOT_NOT_FOUND'));
  // A different install now owns the version name (new inode, snapshot link untouched).
  const liveEntry = path.join(w.home, '.nassaj-users', '1', '.codex', 'packages', 'standalone', 'releases', '1.0.0', 'bin', 'codex');
  fs.rmSync(liveEntry);
  writeFixtureFile(liveEntry, 'codex-cli 1.0.0-other', 0o755);
  await assert.rejects(() => startManualRollback({ ...base, jobId: run.jobId }), codeOf('ORIGIN_NAME_CONFLICT'));
  // An in-place (O_TRUNC) write of the snapshot copy is caught before anything is restored.
  fs.writeFileSync(path.join(w.snapshotRoot, 'codex', run.jobId, 'binary', '1.0.0', 'bin', 'codex'), 'x');
  await assert.rejects(() => startManualRollback({ ...base, jobId: run.jobId }), codeOf('SNAPSHOT_TAMPERED'));
  w.clock.now += 8 * 24 * 3600 * 1000;
  await assert.rejects(() => startManualRollback({ ...base, jobId: run.jobId }), codeOf('SNAPSHOT_NOT_FOUND'));
  assert.equal(isHarnessLeased('codex'), false);
});

test('restore-compatible: 404 for every harness but opencode', async () => {
  for (const id of ['claude', 'codex', 'kimi', 'qwen', 'antigravity', 'cursor']) {
    await assert.rejects(() => startRestoreCompatible(id, { userId: 1, acks: undefined }), codeOf('NOT_RESTORE_COMPATIBLE'));
  }
});

test('restore-compatible: verified install succeeds and only then marks the path verified', async () => {
  const bin = installSingleFile(w, '.opencode/bin/opencode', 'opencode 1.18.32');
  const pinned = path.join(w.root, 'pinned-opencode');
  writeFixtureFile(pinned, 'opencode 1.17.18', 0o755);
  _setSnapshotRuntimeOverrides({
    ...w.rt,
    compatAsset: fakeAsset(pinned, '1.17.18'),
    installCompatAsset: async (opts) => {
      assert.equal(opts.spec?.version, '1.17.18');
      fs.copyFileSync(pinned, opts.destPath);
    },
  });
  assert.equal(w.compatVerified.has('opencode'), false);
  const job = await startRestoreCompatible('opencode', { userId: 1, acks: undefined });
  await _awaitHarnessJob(job.jobId);
  assert.equal(getHarnessUpdateJob(job.jobId)!.status, 'succeeded');
  assert.equal(liveVersion(bin), '1.17.18');
  assert.equal(w.compatVerified.has('opencode'), true);
});

test('restore-compatible: an install refusal rolls back and never marks verified', async () => {
  const bin = installSingleFile(w, '.opencode/bin/opencode', 'opencode 1.18.32');
  _setSnapshotRuntimeOverrides({
    ...w.rt,
    installCompatAsset: async (opts) => {
      fs.writeFileSync(opts.destPath, 'half-written');
      throw new AppError('x', { code: 'ASSET_ENTRY_NAME_MISMATCH', statusCode: 502 });
    },
  });
  const job = await startRestoreCompatible('opencode', { userId: 1, acks: undefined });
  await _awaitHarnessJob(job.jobId);
  assert.equal(getHarnessUpdateJob(job.jobId)!.status, 'rolled_back');
  assert.equal(liveVersion(bin), '1.18.32');
  assert.equal(w.compatVerified.has('opencode'), false);
});

/** Drives codex into rollback_failed (the post-restore proof lies once). */
async function failedCodex(): Promise<string> {
  installCodex(w, '1.0.0');
  w.updater = codexInstaller(w, '2.0.0', 1);
  let reads = 0;
  w.versionOverride = () => ['codex-cli 1.0.0', 'codex-cli 1.0.0', 'codex-cli 2.0.0'][reads++] ?? 'codex-cli 9.9.9';
  const job = await startHarnessUpdate('codex', { userId: 1 });
  await _awaitHarnessJob(job.jobId);
  assert.equal(getHarnessUpdateJob(job.jobId)!.status, 'rollback_failed');
  w.versionOverride = null;
  return job.jobId;
}

test('recovery: nothing pending → 409; bad action → 400', async () => {
  await assert.rejects(() => startRecovery('codex', { action: 'retry', userId: 1 }), codeOf('NO_RECOVERY_PENDING'));
  await assert.rejects(() => startRecovery('codex', { action: 'reset', userId: 1 }), codeOf('INVALID_RECOVERY_ACTION'));
});

test('recovery retry restores and unblocks only that harness', async () => {
  const jobId = await failedCodex();
  const result = await startRecovery('codex', { action: 'retry', userId: 1 });
  assert.ok('jobId' in result);
  await _awaitHarnessJob(result.jobId);
  assert.equal(getHarnessUpdateJob(result.jobId)!.status, 'rolled_back');
  assert.equal(loadManifest(path.join(w.snapshotRoot, 'codex', jobId)).state, 'rolled_back');
  assert.equal(liveVersion(launcher()), '1.0.0');
  assert.equal(isHarnessRecoveryBlocked('codex'), false);
  assert.equal(isHarnessLeased('codex'), false);
});

test('recovery acknowledge needs a readable live version, then clears the block', async () => {
  const jobId = await failedCodex();
  w.versionOverride = () => null;
  await assert.rejects(() => startRecovery('codex', { action: 'acknowledge', userId: 1 }), codeOf('RECOVERY_UNVERIFIED'));
  assert.equal(isHarnessRecoveryBlocked('codex'), true);
  w.versionOverride = null;
  const result = await startRecovery('codex', { action: 'acknowledge', userId: 1 });
  assert.deepEqual(result, { provider: 'codex', status: 'acknowledged' });
  assert.equal(isHarnessRecoveryBlocked('codex'), false);
  assert.equal(loadManifest(path.join(w.snapshotRoot, 'codex', jobId)).state, 'abandoned');
  assert.ok(w.audits.some((a) => a.action === 'harness_recovery_acknowledged'));
});

test('snapshot listing: facts only — no paths, no member ids', async () => {
  const run = await succeededCodexRun();
  beginHarnessLaunch('codex')();
  const list = listHarnessSnapshots('codex');
  assert.equal(list.length, 1);
  assert.equal(list[0].jobId, run.jobId);
  assert.equal(list[0].state, 'succeeded');
  assert.equal(list[0].storeCount, 1);
  assert.deepEqual(list[0].dataRestore, { requiresAck: true, firstSpawnAt: w.clock.now, spawnCount: 1, storesChanged: null, unknown: false });
  const text = JSON.stringify(list);
  assert.ok(!text.includes(w.home) && !text.includes('.nassaj-users') && !text.includes('/'), text);
  assert.deepEqual(listHarnessSnapshots('qwen'), []);
  // The GET never hashes stores: an unreadable store does not break (or slow) it.
  fs.chmodSync(run.store, 0o000);
  try {
    assert.equal(listHarnessSnapshots('codex')[0].dataRestore.storesChanged, null);
  } finally {
    fs.chmodSync(run.store, 0o644);
  }
  assert.throws(() => listHarnessSnapshots('nope'), codeOf('SNAPSHOT_NOT_FOUND'));
});

test('M-1: acknowledge settles a half-swapped store journal before abandoning', async () => {
  const { codexHome } = installCodex(w, '1.0.0');
  const store = path.join(codexHome, 'state_5.sqlite');
  writeStore(store, 'v1');
  w.updater = codexInstaller(w, '2.0.0', 1, () => fs.writeFileSync(store, 'v2'));
  let reads = 0;
  w.versionOverride = () => ['codex-cli 1.0.0', 'codex-cli 1.0.0', 'codex-cli 2.0.0'][reads++] ?? 'codex-cli 9.9.9';
  const job = await startHarnessUpdate('codex', { userId: 1 });
  await _awaitHarnessJob(job.jobId);
  w.versionOverride = null;
  const dir = path.join(w.snapshotRoot, 'codex', job.jobId);
  fs.writeFileSync(store, 'v3-after-failure');
  assert.throws(() => restoreStores(dir, loadManifest(dir), 'auto', {
    now: w.clock.now, assertNoHolders: () => {}, beforeStep: (phase) => { if (phase === 'swapping') throw new Error('crash'); },
  }));
  assert.equal(loadManifest(dir).restore?.phase, 'swapping');
  await startRecovery('codex', { action: 'acknowledge', userId: 1 });
  const m = loadManifest(dir);
  assert.equal(m.state, 'abandoned');
  assert.equal(m.restore?.phase, 'committed', 'rolled forward, never left half-swapped');
  assert.equal(fs.readFileSync(store, 'utf8'), 'v1');
});

test('M-1: a journal that cannot be settled refuses the acknowledgement (409)', async () => {
  const { codexHome } = installCodex(w, '1.0.0');
  const store = path.join(codexHome, 'state_5.sqlite');
  writeStore(store, 'v1');
  w.updater = codexInstaller(w, '2.0.0', 1, () => fs.writeFileSync(store, 'v2'));
  let reads = 0;
  w.versionOverride = () => ['codex-cli 1.0.0', 'codex-cli 1.0.0', 'codex-cli 2.0.0'][reads++] ?? 'codex-cli 9.9.9';
  const job = await startHarnessUpdate('codex', { userId: 1 });
  await _awaitHarnessJob(job.jobId);
  w.versionOverride = null;
  const dir = path.join(w.snapshotRoot, 'codex', job.jobId);
  assert.throws(() => restoreStores(dir, loadManifest(dir), 'auto', {
    now: w.clock.now, assertNoHolders: () => {}, beforeStep: (phase) => { if (phase === 'swapping') throw new Error('crash'); },
  }));
  const staged = loadManifest(dir).restore!.files.find((op) => op.op === 'stage')!;
  fs.rmSync((staged as { temp: string }).temp);
  fs.writeFileSync(store, 'neither backup nor staged');
  await assert.rejects(() => startRecovery('codex', { action: 'acknowledge', userId: 1 }), codeOf('RECOVERY_UNVERIFIED'));
  assert.equal(loadManifest(dir).state, 'rollback_failed');
  assert.equal(isHarnessRecoveryBlocked('codex'), true);
});
