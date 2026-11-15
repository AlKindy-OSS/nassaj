/**
 * T-1871 stage 3b — the §8 state machine end to end on /var/tmp fixtures
 * (stubbed updater, emulated `--version`; no real harness, install or member
 * data is touched). Covers succeeded / noop / rolled_back / rollback_failed,
 * PREFLIGHT_CHANGED, preflight refusals, the pinBreak ack and the durable
 * fence scoped to one harness.
 */

// B-1349: FIRST import — HOME becomes a /var/tmp sandbox before anything reads it.
import '@/shared/__tests__/sandbox-home.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, beforeEach, test } from 'node:test';

import { initializeDatabase } from '@/modules/database/index.js';
import { PINNED_VENDOR_DIGESTS } from '@/services/isolation/vendor-binary-integrity.js';
import { AppError } from '@/shared/utils.js';
import { HarnessBinaryUnresolvedError, tryResolveHarnessBinary } from '@/shared/harness-binaries.js';

import { HARNESS_UPDATE_DESCRIPTORS } from './descriptors.js';
import { _resetHarnessLeases, isHarnessLeased } from './lease.js';
import { loadManifest } from './snapshot/manifest.js';
import { snapshotError } from './snapshot/errors.js';
import { removeFixture, writeFixtureFile } from './snapshot/__tests__/fixtures.js';
import { currentBootId, processStartToken } from './harness-lock.js';
import { runHarnessUpdateCommand } from './run-command.js';
import { _setSnapshotRuntimeOverrides } from './snapshot-runtime.js';
import {
  _resetHarnessLaunches,
  clearHarnessRecoveryBlocked,
  isHarnessRecoveryBlocked,
  isSpawnBlockedForRunProvider,
} from './spawn-admission.js';
import { _setSharedSpawnLedger } from './spawn-ledger.js';
import { _awaitHarnessJob, _resetHarnessJobs, getHarnessUpdateJob, startHarnessUpdate } from './update.service.js';
import {
  codexInstaller,
  installCodex,
  installSingleFile,
  liveVersion,
  makeWorld,
  ok,
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

const codeOf = (c: string) => (e: unknown) => e instanceof AppError && e.code === c;

test('guard: every snapshot-backed harness resolves inside the fixture world (never a real install)', () => {
  const env = w.rt.cleanEnv!();
  const inside = (p: string) => path.isAbsolute(p) && !path.relative(w.root, p).startsWith('..');
  // T-1873: the registry resolves from the operator home (the world's HOME);
  // an uninstalled harness is unresolved, never a real install elsewhere.
  for (const d of Object.values(HARNESS_UPDATE_DESCRIPTORS).filter((x) => x.snapshot)) {
    const binary = tryResolveHarnessBinary(d.id);
    if (binary !== null) assert.ok(inside(binary), `${d.id} resolves outside the fixture: ${binary}`);
    else assert.throws(() => d.resolveBinary(), HarnessBinaryUnresolvedError);
    const argv = d.updateArgv(env);
    if (argv) assert.ok(inside(argv.cmd), `${d.id} updater outside the fixture`);
  }
  installSingleFile(w, '.opencode/bin/opencode', '1.0.0');
  assert.ok(inside(HARNESS_UPDATE_DESCRIPTORS.opencode.resolveBinary()));
});
const launcher = () => path.join(w.home, '.local', 'bin', 'codex');

async function run(id: string, opts: Parameters<typeof startHarnessUpdate>[1] = {}) {
  const job = await startHarnessUpdate(id, { userId: 1, ...opts });
  await _awaitHarnessJob(job.jobId);
  return { initial: job, final: getHarnessUpdateJob(job.jobId)!, jobDir: path.join(w.snapshotRoot, id, job.jobId) };
}

function codexWithStores(): { member: string; host: string } {
  const { codexHome } = installCodex(w, '1.0.0');
  const member = path.join(codexHome, 'state_5.sqlite');
  const host = path.join(w.home, '.codex', 'state_5.sqlite');
  writeStore(member, 'member-v1');
  writeStore(`${member}-wal`, 'member-wal-v1');
  writeStore(host, 'host-v1');
  return { member, host };
}

test('codex success: snapshot + store backup, succeeded, ledger recorded, fence cleared', async () => {
  const stores = codexWithStores();
  w.updater = codexInstaller(w, '2.0.0', 0, () => fs.appendFileSync(stores.member, '-migrated'));
  const { final, jobDir } = await run('codex');
  assert.equal(final.status, 'succeeded');
  assert.equal(final.fromVersion, '1.0.0');
  assert.equal(final.toVersion, '2.0.0');
  assert.equal(liveVersion(launcher()), '2.0.0');
  const m = loadManifest(jobDir);
  assert.equal(m.state, 'succeeded');
  assert.equal(m.counted, true);
  assert.equal(m.stores?.sets.length, 2, 'host + member set');
  assert.notEqual(m.stores?.postFingerprint, m.stores?.preFingerprint);
  assert.deepEqual(w.ledger.spawnFactsSince('codex', final.jobId), { firstSpawnAt: null, count: 0, unknown: false });
  assert.equal(isHarnessRecoveryBlocked('codex'), false);
  assert.equal(isHarnessLeased('codex'), false);
  assert.deepEqual(w.versionChanges, [{ id: 'codex', version: '2.0.0' }]);
  const env = w.commands[0].env;
  assert.equal(env.CODEX_HOME, path.join(w.home, '.nassaj-users', '1', '.codex'));
  assert.equal(env.CODEX_INSTALL_DIR, path.join(w.home, '.local', 'bin'));
});

test('noop: exit 0 with the same version and bytes discards the snapshot', async () => {
  installCodex(w, '1.0.0');
  w.updater = () => ok();
  const { final, jobDir } = await run('codex');
  assert.equal(final.status, 'noop');
  assert.equal(fs.existsSync(jobDir), false);
  assert.ok(w.audits.some((a) => a.action === 'harness_update_noop'));
  assert.equal(isHarnessRecoveryBlocked('codex'), false);
});

test('failed updater → auto rollback: binary links, bytes and changed stores restored', async () => {
  const stores = codexWithStores();
  w.updater = codexInstaller(w, '2.0.0', 1, () => fs.writeFileSync(stores.member, 'corrupted-by-updater'));
  const { final, jobDir } = await run('codex');
  assert.equal(final.status, 'rolled_back');
  assert.equal(final.error?.code, 'update_failed');
  assert.equal(liveVersion(launcher()), '1.0.0');
  assert.equal(fs.readFileSync(stores.member, 'utf8'), 'member-v1');
  assert.equal(fs.readFileSync(`${stores.member}-wal`, 'utf8'), 'member-wal-v1');
  assert.equal(loadManifest(jobDir).state, 'rolled_back');
  assert.equal(isHarnessRecoveryBlocked('codex'), false);
});

test('same version but changed bytes is rolled back (never a silent success)', async () => {
  const file = installSingleFile(w, '.local/bin/agy', 'agy 1.2.12');
  w.updater = () => {
    fs.writeFileSync(file, 'agy 1.2.12\n#tampered');
    return ok();
  };
  const { final } = await run('agy');
  assert.equal(final.status, 'rolled_back');
  assert.equal(fs.readFileSync(file, 'utf8'), 'agy 1.2.12');
});

test('a downgrade is rolled back', async () => {
  installCodex(w, '1.0.0');
  w.updater = codexInstaller(w, '0.9.0');
  const { final } = await run('codex');
  assert.equal(final.status, 'rolled_back');
  assert.equal(liveVersion(launcher()), '1.0.0');
});

test('PREFLIGHT_CHANGED: the install moved between preflight and mutation → abandoned, updater never ran', async () => {
  installCodex(w, '1.0.0');
  let reads = 0;
  w.versionOverride = () => (reads++ === 0 ? 'codex-cli 1.0.0' : 'codex-cli 1.0.1');
  const { final, jobDir } = await run('codex');
  assert.equal(final.status, 'failed');
  assert.equal(final.error?.code, 'PREFLIGHT_CHANGED');
  assert.equal(w.commands.length, 0);
  assert.equal(loadManifest(jobDir).state, 'abandoned');
  assert.equal(fs.existsSync(path.join(jobDir, 'binary')), false);
});

test('rollback_failed blocks ONLY that harness; lease retained; audit alerts the owner', async () => {
  installCodex(w, '1.0.0');
  installSingleFile(w, '.opencode/bin/opencode', 'opencode 1.18.32');
  w.updater = codexInstaller(w, '2.0.0', 1);
  let reads = 0;
  // preflight + recheck read 1.0.0, verify reads 2.0.0, the post-restore proof lies.
  w.versionOverride = () => ['codex-cli 1.0.0', 'codex-cli 1.0.0', 'codex-cli 2.0.0'][reads++] ?? 'codex-cli 9.9.9';
  const { final, jobDir } = await run('codex');
  assert.equal(final.status, 'rollback_failed');
  assert.equal(loadManifest(jobDir).state, 'rollback_failed');
  assert.equal(isHarnessRecoveryBlocked('codex'), true);
  assert.equal(isHarnessLeased('codex'), true, 'lease retained for codex');
  assert.equal(isSpawnBlockedForRunProvider('codex'), true);
  assert.equal(isSpawnBlockedForRunProvider('opencode'), false, 'other harnesses unaffected');
  assert.ok(w.audits.some((a) => a.action === 'harness_update_rollback_failed' && a.metadata.ownerAlert === true));
  await assert.rejects(() => startHarnessUpdate('codex', { userId: 1 }), codeOf('HARNESS_UPDATE_IN_PROGRESS'));
});

test('an unquiesced timeout never restores under a live writer: rollback_failed at once', async () => {
  installCodex(w, '1.0.0');
  w.updater = () => ok({ code: null, timedOut: true, quiesced: false });
  const { final, jobDir } = await run('codex');
  assert.equal(final.status, 'rollback_failed');
  assert.equal(loadManifest(jobDir).state, 'rollback_failed');
  assert.equal(isHarnessRecoveryBlocked('codex'), true);
});

test('preflight refusals: 507 disk (97.1 %), 507 count cap, 423 store in use — nothing written', async () => {
  codexWithStores();
  const statfs = () => ({ blocks: 1000, bfree: 30, bsize: 1 });
  _setSnapshotRuntimeOverrides({ ...w.rt, statfs });
  await assert.rejects(() => startHarnessUpdate('codex', { userId: 1 }), codeOf('INSUFFICIENT_STORAGE'));
  _setSnapshotRuntimeOverrides({ ...w.rt, assertNoHolders: () => { throw new AppError('x', { code: 'STORE_IN_USE', statusCode: 423 }); } });
  await assert.rejects(() => startHarnessUpdate('codex', { userId: 1 }), codeOf('STORE_IN_USE'));
  _setSnapshotRuntimeOverrides(w.rt);
  for (const id of ['a1', 'a2', 'a3', 'a4']) fs.mkdirSync(path.join(w.snapshotRoot, 'codex', id, 'binary'), { recursive: true });
  await assert.rejects(() => startHarnessUpdate('codex', { userId: 1 }), codeOf('SNAPSHOT_COUNT_CAP'));
  assert.equal(w.commands.length, 0);
  assert.equal(isHarnessLeased('codex'), false, 'lease released on every refusal');
});

test('B-1468: STORE_ACCESS_UNPROVABLE during the store backup names unchecked processes on the job', async () => {
  codexWithStores();
  let calls = 0;
  const unchecked = [{ pid: 21, comm: 'node', reason: 'fd_unreadable', cmdline: 'never' }];
  _setSnapshotRuntimeOverrides({
    ...w.rt,
    assertNoHolders: () => {
      calls += 1;
      if (calls > 1) {
        throw snapshotError('STORE_ACCESS_UNPROVABLE', { uncheckedProcesses: unchecked, uncheckedProcessCount: 30 });
      }
    },
  });
  const { final } = await run('codex');
  assert.equal(final.status, 'failed');
  assert.equal(final.error?.code, 'STORE_ACCESS_UNPROVABLE');
  const shown = [{ pid: 21, comm: 'node', reason: 'fd_unreadable' }];
  assert.deepEqual(final.error?.uncheckedProcesses, shown);
  assert.equal(final.error?.uncheckedProcessCount, 30);
  assert.equal(w.commands.length, 0, 'the updater never ran');
  final.error!.uncheckedProcesses![0].comm = 'mutated';
  final.error!.uncheckedProcesses!.push({ pid: 1, comm: 'x' });
  assert.deepEqual(getHarnessUpdateJob(final.jobId)!.error?.uncheckedProcesses, shown);
});

test('a launcher that is not the measured layout is refused before any change', async () => {
  writeFixtureFile(launcher(), 'codex-cli 1.0.0', 0o755);
  await assert.rejects(() => startHarnessUpdate('codex', { userId: 1 }), codeOf('SNAPSHOT_LAYOUT_MISMATCH'));
  // claude must be a versions/<v> link; a plain file launcher is not snapshot-able.
  installSingleFile(w, '.local/bin/claude', '2.1.280 (Claude Code)');
  await assert.rejects(() => startHarnessUpdate('claude', { userId: 1 }), codeOf('SNAPSHOT_LAYOUT_MISMATCH'));
  assert.equal(w.commands.length, 0);
  assert.equal(isHarnessLeased('claude'), false);
});

test('claude versioned-file layout: hard-link snapshot, failed update restores the launcher link', async () => {
  const versions = path.join(w.home, '.local', 'share', 'claude', 'versions');
  writeFixtureFile(path.join(versions, '2.1.280'), '2.1.280 (Claude Code)', 0o755);
  fs.mkdirSync(path.join(w.home, '.local', 'bin'), { recursive: true });
  const bin = path.join(w.home, '.local', 'bin', 'claude');
  fs.symlinkSync(path.join(versions, '2.1.280'), bin);
  w.updater = () => {
    writeFixtureFile(path.join(versions, '2.1.283'), '2.1.283 (Claude Code)', 0o755);
    fs.rmSync(bin);
    fs.symlinkSync(path.join(versions, '2.1.283'), bin);
    fs.rmSync(path.join(versions, '2.1.280'));
    return ok({ code: 3 });
  };
  const { final } = await run('claude');
  assert.equal(final.status, 'rolled_back');
  assert.equal(fs.readlinkSync(bin), path.join(versions, '2.1.280'));
  assert.equal(liveVersion(bin), '2.1.280');
  assert.ok(!fs.readlinkSync(bin).includes('harness-snapshots'), 'never linked into the snapshot root');
});

test('owner decision 2026-09-29: opencode updates past its pinned release with no ack', async () => {
  const pinsBefore = structuredClone(PINNED_VENDOR_DIGESTS);
  const file = installSingleFile(w, '.opencode/bin/opencode', 'opencode 1.18.32');
  writeStore(path.join(w.home, '.local', 'share', 'opencode', 'opencode.db'), 'db');
  _setSnapshotRuntimeOverrides({ ...w.rt, pinArmed: () => false, latestVersion: async () => '1.18.40' });
  w.updater = () => {
    fs.writeFileSync(file, 'opencode 1.18.40');
    return ok();
  };
  const accepted = await startHarnessUpdate('opencode', { userId: 1 });
  await _awaitHarnessJob(accepted.jobId);
  assert.equal(getHarnessUpdateJob(accepted.jobId)!.status, 'succeeded');
  assert.deepEqual(PINNED_VENDOR_DIGESTS, pinsBefore);
});

test('pinBreak: with the opt-in pin armed, leaving the opencode pin needs a server-built ack', async () => {
  const pinsBefore = structuredClone(PINNED_VENDOR_DIGESTS);
  const file = installSingleFile(w, '.opencode/bin/opencode', 'opencode 1.17.18');
  writeStore(path.join(w.home, '.local', 'share', 'opencode', 'opencode.db'), 'db');
  _setSnapshotRuntimeOverrides({ ...w.rt, pinArmed: () => true, latestVersion: async () => '1.18.40' });
  let required: { kind: string; token: string; textEn: string; textAr: string }[] = [];
  await assert.rejects(() => startHarnessUpdate('opencode', { userId: 1 }), (e: unknown) => {
    assert.ok(e instanceof AppError && e.code === 'CONFIRMATION_REQUIRED');
    required = (e.details as { required: typeof required }).required;
    return true;
  });
  assert.equal(required.length, 1);
  assert.equal(required[0].kind, 'pinBreak');
  assert.match(required[0].textEn, /blocked in every mode until version 1\.18\.32 is restored/);
  assert.equal(w.commands.length, 0);
  const tampered = [{ kind: 'pinBreak', token: `${required[0].token}x` }];
  await assert.rejects(() => startHarnessUpdate('opencode', { userId: 1, acks: tampered }), codeOf('CONFIRMATION_REQUIRED'));
  const again = await startHarnessUpdate('opencode', { userId: 1 }).catch((e: AppError) => e.details as { required: typeof required });
  w.updater = () => {
    fs.writeFileSync(file, 'opencode 1.18.40');
    return ok();
  };
  const accepted = await startHarnessUpdate('opencode', { userId: 1, acks: [{ kind: 'pinBreak', token: (again as { required: typeof required }).required[0].token }] });
  await _awaitHarnessJob(accepted.jobId);
  assert.equal(getHarnessUpdateJob(accepted.jobId)!.status, 'succeeded');
  assert.deepEqual(PINNED_VENDOR_DIGESTS, pinsBefore);
});

test('a live session skips the update without a snapshot (scheduler retries later)', async () => {
  installCodex(w, '1.0.0');
  _setSnapshotRuntimeOverrides({ ...w.rt, hasLiveSession: () => true });
  const job = await startHarnessUpdate('codex', { userId: 1 });
  assert.equal(job.status, 'skipped_live_session');
  assert.equal(fs.existsSync(path.join(w.snapshotRoot, 'codex', job.jobId)), false);
  assert.equal(isHarnessLeased('codex'), false);
});

test('B-1474: a live workflow unit skips with live_session_active and audits a manual run', async () => {
  installCodex(w, '1.0.0');
  _setSnapshotRuntimeOverrides({ ...w.rt, hasUnregisteredLaunch: async () => 'live_unit' });
  const job = await startHarnessUpdate('codex', { userId: 1 });
  assert.equal(job.status, 'skipped_live_session');
  assert.equal(job.error?.code, 'live_session_active');
  assert.equal(w.commands.length, 0);
  const skipped = w.audits.filter((a) => a.action === 'harness_update_skipped');
  assert.deepEqual(skipped.map((a) => a.metadata), [{ provider: 'codex', kind: 'live_unit', leg: null, cause: null }]);
});

test('B-1474: a throwing presence leg is gate_unverifiable naming leg=presence', async () => {
  installCodex(w, '1.0.0');
  _setSnapshotRuntimeOverrides({ ...w.rt, hasLiveSession: () => { throw new Error('registry down'); } });
  const job = await startHarnessUpdate('codex', { userId: 1 });
  assert.equal(job.status, 'skipped_live_session');
  assert.equal(job.error?.code, 'live_gate_unverifiable');
  assert.match(job.log.at(-1) ?? '', /leg=presence, cause=error/);
  assert.doesNotMatch(JSON.stringify(job), /registry down/);
  const skipped = w.audits.filter((a) => a.action === 'harness_update_skipped');
  assert.deepEqual(skipped.map((a) => a.metadata), [{ provider: 'codex', kind: 'gate_unverifiable', leg: 'presence', cause: 'error' }]);
  assert.equal(w.commands.length, 0);
  assert.equal(isHarnessLeased('codex'), false);
});

test('C-1: the updater process group is persisted in the manifest as soon as it is spawned', async () => {
  installCodex(w, '1.0.0');
  const install = codexInstaller(w, '2.0.0');
  _setSnapshotRuntimeOverrides({
    ...w.rt,
    runCommand: async (cmd, args, opts) => {
      opts.onSpawn?.(4242);
      return install(cmd, args, opts.env);
    },
  });
  const { final, jobDir } = await run('codex');
  assert.equal(final.status, 'succeeded');
  assert.deepEqual(loadManifest(jobDir).updater, { pgid: 4242, startToken: processStartToken(4242), bootId: currentBootId() });
  assert.match(currentBootId() ?? '', /^[0-9a-f-]{36}$/);
});

test('C-1: an updater whose group cannot be recorded is killed at once (the run fails)', async () => {
  const started = Date.now();
  const result = await runHarnessUpdateCommand('/bin/sh', ['-c', 'sleep 30'], {
    env: { PATH: '/usr/bin:/bin' },
    cwd: w.root,
    timeoutMs: 20_000,
    onSpawn: () => { throw new Error('manifest write failed'); },
  });
  assert.notEqual(result.code, 0);
  assert.ok(Date.now() - started < 10_000, 'killed, not waited out');
});
