// B-1349: FIRST import — HOME becomes a /var/tmp sandbox before anything reads it.
// eslint-disable-next-line import-x/order -- must evaluate before every other import
import { SANDBOX_HOME } from '@/shared/__tests__/sandbox-home.js';
import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import { probeUserWorkflowUnits, UserUnitProbeError, type UserUnitProbe } from '@/modules/workflow-supervisor/index.js';
import { installFakeHarnessBinary } from '@/shared/__tests__/harness-binary-fixtures.js';
import { AppError } from '@/shared/utils.js';

import { HARNESS_UPDATE_DESCRIPTORS } from './descriptors.js';
import { isHarnessPinRefused } from './version-status.service.js';
import {
  _resetHarnessLaunches,
  beginHarnessLaunch,
  clearHarnessRecoveryBlocked,
  isHarnessRecoveryBlocked,
} from './spawn-admission.js';
import { _resetHarnessLeases, isHarnessLeased } from './lease.js';
import { defaultHasUnregisteredLaunch } from './run-command.js';
import {
  _awaitHarnessJob,
  _resetHarnessJobs,
  getHarnessUpdateJob,
  isHarnessSpawnBlocked,
  runHarnessUpdateCommand,
  startHarnessUpdate,
  type RunResult,
  type UpdateServiceDeps,
} from './update.service.js';

const ok = (over: Partial<RunResult> = {}): RunResult => ({ code: 0, stdout: '', stderr: '', timedOut: false, ...over });

function reset(): void {
  _resetHarnessLeases();
  _resetHarnessJobs();
  _resetHarnessLaunches();
  for (const id of ['kimi', 'qwen']) clearHarnessRecoveryBlocked(id);
}

interface Recorder {
  commands: Array<{ cmd: string; args: string[]; env: NodeJS.ProcessEnv }>;
  audits: Array<{ action: string; metadata: Record<string, unknown>; userId: number | null }>;
  versionChanges: Array<{ id: string; version: string }>;
}

function recorder(): Recorder {
  return { commands: [], audits: [], versionChanges: [] };
}

/**
 * Resolver env pinned inside the test HOME (the isolated runner sets HOME to
 * the case dir): qwen would otherwise resolve through PATH to a real install.
 */
const QWEN_FIXTURE_PATH = path.join(SANDBOX_HOME, '.local', 'bin', 'qwen');
// T-1873: the registry only resolves an installed CLI; lay the npm harness
// launcher out under the test HOME exactly as measured.
// kimi is a native snapshot harness (ADR-189); the legacy npm flow here is
// exercised through qwen.
installFakeHarnessBinary(SANDBOX_HOME, 'qwen');

const depsFor = (rec: Recorder, over: Partial<UpdateServiceDeps> = {}): UpdateServiceDeps => ({
  cleanEnv: () => ({ PATH: '/usr/bin:/bin', QWEN_PATH: QWEN_FIXTURE_PATH }),
  hasLiveSession: () => false,
  hasUnregisteredLaunch: async () => null,
  pinEnabled: () => false,
  runCommand: async (cmd, args, opts) => {
    rec.commands.push({ cmd, args, env: opts.env });
    return ok();
  },
  runVersion: async () => '1.0.0',
  audit: (action, metadata, userId) => rec.audits.push({ action, metadata, userId }),
  recordVersionChange: (id, version) => rec.versionChanges.push({ id, version }),
  ...over,
});

test('command runner bounds captured output and waits for timeout termination', async () => {
  const output = await runHarnessUpdateCommand(process.execPath, [
    '-e', "process.stdout.write('x'.repeat(100000))",
  ], { env: process.env, timeoutMs: 5_000 });
  assert.equal(output.code, 0);
  assert.ok(output.stdout.length < 66_000);
  assert.match(output.stdout, /output truncated/);

  const timed = await runHarnessUpdateCommand(process.execPath, [
    '-e', 'setInterval(() => {}, 1000)',
  ], { env: process.env, timeoutMs: 25 });
  assert.equal(timed.timedOut, true);
  assert.equal(timed.code, null);

  const grouped = await runHarnessUpdateCommand(process.execPath, [
    '-e',
    "const {spawn}=require('node:child_process'); const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'}); console.log(c.pid); setInterval(()=>{},1000)",
  ], { env: process.env, timeoutMs: 50 });
  assert.equal(grouped.quiesced, true);
  const grandchildPid = Number.parseInt(grouped.stdout.trim(), 10);
  assert.ok(Number.isSafeInteger(grandchildPid));
  let alive = true;
  for (let attempt = 0; attempt < 50 && alive; attempt += 1) {
    try { process.kill(grandchildPid, 0); } catch { alive = false; }
    if (alive) await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(alive, false, 'timeout waits until the update process group is quiescent');
});

test('success: runs the update, verifies a changed version, audits start+success', async () => {
  reset();
  const rec = recorder();
  let call = 0;
  const job = await startHarnessUpdate('qwen', {
    userId: 7,
    deps: depsFor(rec, { runVersion: async () => (call++ === 0 ? '0.42.0' : '0.43.0') }),
  });
  await _awaitHarnessJob(job.jobId);
  const final = getHarnessUpdateJob(job.jobId)!;
  assert.equal(final.status, 'succeeded');
  assert.equal(final.fromVersion, '0.42.0');
  assert.equal(final.toVersion, '0.43.0');
  assert.deepEqual(rec.audits.map((a) => a.action), ['harness_update_started', 'harness_update_succeeded']);
  const success = rec.audits[1];
  assert.deepEqual(success.metadata, {
    provider: 'qwen', fromVersion: '0.42.0', toVersion: '0.43.0', exitCode: 0, trigger: 'manual',
  });
  assert.equal(success.userId, 7);
  // T-1871: the verified change is recorded so the status read never calls it drift.
  assert.deepEqual(rec.versionChanges, [{ id: 'qwen', version: '0.43.0' }]);
});

test('T-1871: a rejected (non-advancing) update records no version change', async () => {
  reset();
  const rec = recorder();
  const job = await startHarnessUpdate('qwen', {
    userId: 7,
    deps: depsFor(rec, { runVersion: async () => '0.42.0' }),
  });
  await _awaitHarnessJob(job.jobId);
  assert.notEqual(getHarnessUpdateJob(job.jobId)!.status, 'succeeded');
  assert.deepEqual(rec.versionChanges, []);
});

test('T-1871: a failing drift ledger does not fail a verified update', async () => {
  reset();
  const rec = recorder();
  let call = 0;
  const job = await startHarnessUpdate('qwen', {
    userId: 7,
    deps: depsFor(rec, {
      runVersion: async () => (call++ === 0 ? '0.42.0' : '0.43.0'),
      recordVersionChange: () => { throw new Error('ledger down'); },
    }),
  });
  await _awaitHarnessJob(job.jobId);
  assert.equal(getHarnessUpdateJob(job.jobId)!.status, 'succeeded');
});

test('a downgrade is rejected and the exact previous version is restored', async () => {
  reset();
  const rec = recorder();
  const versions = ['1.2.0', '1.1.9', '1.2.0'];
  const job = await startHarnessUpdate('qwen', {
    deps: depsFor(rec, { runVersion: async () => versions.shift() ?? '1.2.0' }),
  });
  await _awaitHarnessJob(job.jobId);
  assert.equal(getHarnessUpdateJob(job.jobId)!.error?.code, 'update_unverified');
  assert.ok(rec.commands.some((entry) => entry.args.includes('@qwen-code/qwen-code@1.2.0')));
});

test('spawn env is cleanSpawnEnv output — no host secrets, no CLAUDE_CONFIG_DIR', async () => {
  reset();
  process.env.JWT_SECRET = 'super-secret';
  process.env.CLAUDE_CONFIG_DIR = '/home/op/.claude';
  process.env.NASSAJ_PROVIDER_SECRETS_KEY = 'master';
  const rec = recorder();
  // Do NOT inject cleanEnv — exercise the real cleanSpawnEnv default.
  const job = await startHarnessUpdate('qwen', {
    deps: {
      hasLiveSession: () => false,
      pinEnabled: () => false,
      runCommand: async (cmd, args, opts) => {
        rec.commands.push({ cmd, args, env: opts.env });
        return ok();
      },
      runVersion: async () => '0.42.0',
      audit: () => {},
    },
  });
  await _awaitHarnessJob(job.jobId);
  const env = rec.commands[0].env;
  assert.equal(env.JWT_SECRET, undefined);
  assert.equal(env.CLAUDE_CONFIG_DIR, undefined);
  assert.equal(env.NASSAJ_PROVIDER_SECRETS_KEY, undefined);
  assert.ok(typeof env.PATH === 'string'); // the updater still gets PATH
  delete process.env.JWT_SECRET;
  delete process.env.CLAUDE_CONFIG_DIR;
  delete process.env.NASSAJ_PROVIDER_SECRETS_KEY;
});

test('live session across users → skipped_live_session, update never runs', async () => {
  reset();
  const rec = recorder();
  const job = await startHarnessUpdate('qwen', {
    deps: depsFor(rec, { hasLiveSession: () => true }),
  });
  assert.equal(job.status, 'skipped_live_session');
  // Contract delta (Addendum 3): a distinct machine code, not a generic failure.
  assert.equal(job.error?.code, 'live_session_active');
  assert.ok(job.error?.messageAr);
  await _awaitHarnessJob(job.jobId);
  assert.equal(rec.commands.length, 0);
  // The lease taken for the check MUST be given back, or the harness would stay
  // spawn-blocked forever after a single skipped run.
  assert.equal(isHarnessLeased('qwen'), false);
});

test('TOCTOU: the lease is held BEFORE the live-session check runs', async () => {
  reset();
  const rec = recorder();
  // The gate observes the lease state AT THE MOMENT it is consulted. If the
  // check still ran first, this would be false and a turn starting in between
  // would race the binary swap (the qa-critic finding).
  let leasedWhenChecked: boolean | null = null;
  const job = await startHarnessUpdate('qwen', {
    deps: depsFor(rec, {
      hasLiveSession: () => {
        leasedWhenChecked = isHarnessLeased('qwen');
        return false;
      },
    }),
  });
  await _awaitHarnessJob(job.jobId);
  assert.equal(leasedWhenChecked, true, 'the single-flight lease is acquired first');
});

test('an UNREGISTERED launch blocks the update admission atomically', async () => {
  reset();
  const rec = recorder();
  // Nothing in the presence run registry, but a real claude child is alive.
  const release = beginHarnessLaunch('qwen');
  const job = await startHarnessUpdate('qwen', {
    deps: depsFor(rec, { hasLiveSession: () => false, hasUnregisteredLaunch: undefined }),
  });
  assert.equal(job.status, 'skipped_live_session');
  assert.equal(job.error?.code, 'live_session_active');
  assert.equal(rec.commands.length, 0);
  assert.equal(isHarnessLeased('claude'), false);
  release();

  // Once the child is gone the same call proceeds (the registry is not sticky).
  let versionCall = 0;
  const after = await startHarnessUpdate('qwen', {
    deps: depsFor(rec, {
      hasUnregisteredLaunch: async () => null,
      runVersion: async () => (versionCall++ === 0 ? '1.0.0' : '1.1.0'),
    }),
  });
  await _awaitHarnessJob(after.jobId);
  assert.equal(getHarnessUpdateJob(after.jobId)!.status, 'succeeded');
});

test('a gate that cannot answer fails CLOSED (never updates under a live turn)', async () => {
  reset();
  const rec = recorder();
  const job = await startHarnessUpdate('qwen', {
    deps: depsFor(rec, {
      hasUnregisteredLaunch: async () => { throw new Error('systemctl unavailable'); },
    }),
  });
  assert.equal(job.status, 'skipped_live_session');
  assert.equal(job.error?.code, 'live_gate_unverifiable');
  assert.equal(rec.commands.length, 0);
  assert.equal(isHarnessLeased('qwen'), false);
});

test('B-1474: a probe error names the unit_probe leg with a short cause only', async () => {
  reset();
  const rec = recorder();
  const job = await startHarnessUpdate('qwen', {
    userId: 3,
    deps: depsFor(rec, {
      hasUnregisteredLaunch: async () => { throw new UserUnitProbeError('systemctl_failed', 'Failed to connect to bus: secret-ish'); },
    }),
  });
  assert.equal(job.error?.code, 'live_gate_unverifiable');
  assert.doesNotMatch(JSON.stringify(job), /secret-ish/);
  const skipped = rec.audits.filter((a) => a.action === 'harness_update_skipped');
  assert.deepEqual(skipped.map((a) => a.metadata), [
    { provider: 'qwen', kind: 'gate_unverifiable', leg: 'unit_probe', cause: 'systemctl_failed' },
  ]);
  assert.equal(rec.commands.length, 0);
});

test('B-1474: an unclassified fault inside the real probe is still attributed to unit_probe', async () => {
  reset();
  const rec = recorder();
  const brokenProbe = () => probeUserWorkflowUnits({
    platform: 'linux', systemdRoot: '/', getuid: () => { throw new TypeError('unexpected'); },
  });
  const job = await startHarnessUpdate('qwen', {
    userId: 3,
    deps: depsFor(rec, { hasUnregisteredLaunch: (ids) => defaultHasUnregisteredLaunch([...ids, 'claude'], brokenProbe) }),
  });
  assert.equal(job.error?.code, 'live_gate_unverifiable');
  const skipped = rec.audits.filter((a) => a.action === 'harness_update_skipped');
  assert.deepEqual(skipped.map((a) => a.metadata), [
    { provider: 'qwen', kind: 'gate_unverifiable', leg: 'unit_probe', cause: 'probe_failed' },
  ]);
  assert.equal(rec.commands.length, 0);
});

test('B-1474: a scheduler-triggered skip writes no audit row', async () => {
  reset();
  const rec = recorder();
  const job = await startHarnessUpdate('qwen', {
    trigger: 'scheduler',
    deps: depsFor(rec, { hasLiveSession: () => true }),
  });
  assert.equal(job.error?.code, 'live_session_active');
  assert.equal(rec.audits.length, 0);
});

test('B-1474: no user manager for this uid (manager_absent) lets the update proceed', async () => {
  reset();
  const rec = recorder();
  let versionCall = 0;
  const job = await startHarnessUpdate('qwen', {
    deps: depsFor(rec, {
      // Force the claude leg so the injected probe is consulted.
      hasUnregisteredLaunch: (ids) => defaultHasUnregisteredLaunch([...ids, 'claude'], async () => ({ state: 'manager_absent' })),
      runVersion: async () => (versionCall++ === 0 ? '1.0.0' : '1.1.0'),
    }),
  });
  assert.equal(job.status, 'running');
  await _awaitHarnessJob(job.jobId);
  assert.equal(getHarnessUpdateJob(job.jobId)!.status, 'succeeded');
});

test('B-1474: defaultHasUnregisteredLaunch maps each probe verdict', async () => {
  reset();
  const probe = (p: UserUnitProbe) => async () => p;
  assert.equal(await defaultHasUnregisteredLaunch(['claude'], probe({ state: 'manager_absent' })), null);
  assert.equal(await defaultHasUnregisteredLaunch(['claude'], probe({ state: 'no_systemd' })), null);
  assert.equal(await defaultHasUnregisteredLaunch(['claude'], probe({ state: 'unsupported' })), null);
  assert.equal(await defaultHasUnregisteredLaunch(['claude'], probe({ state: 'present', units: [] })), null);
  assert.equal(await defaultHasUnregisteredLaunch(['claude'], probe({ state: 'present', units: ['wf-a.service'] })), 'live_unit');
  let probed = false;
  assert.equal(await defaultHasUnregisteredLaunch(['qwen'], async () => { probed = true; return { state: 'manager_absent' }; }), null);
  assert.equal(probed, false, 'non-claude harnesses never probe systemd');
  await assert.rejects(
    () => defaultHasUnregisteredLaunch(['claude'], async () => { throw new UserUnitProbeError('timeout'); }),
    UserUnitProbeError,
  );
  const release = beginHarnessLaunch('claude');
  assert.equal(await defaultHasUnregisteredLaunch(['claude'], probe({ state: 'manager_absent' })), 'live_launch');
  release();
});

test('single-flight: a second update while one runs throws 409 with activeJobId', async () => {
  reset();
  const rec = recorder();
  let release!: () => void;
  const pending = new Promise<RunResult>((res) => {
    release = () => res(ok());
  });
  const first = await startHarnessUpdate('qwen', {
    deps: depsFor(rec, { runCommand: async () => pending }),
  });
  await assert.rejects(
    () => startHarnessUpdate('qwen', { deps: depsFor(rec) }),
    (err: unknown) => {
      assert.ok(err instanceof AppError);
      assert.equal(err.statusCode, 409);
      assert.deepEqual(err.details, { activeJobId: first.jobId });
      return true;
    },
  );
  release();
  await _awaitHarnessJob(first.jobId);
});

test('armed pin: no live harness is refused outright — pinned ones are snapshot-backed', () => {
  // ADR-189: kimi (pinned) is now a native snapshot harness like opencode, so an
  // armed pin asks for a server-built pinBreak ack instead of refused_pinned.
  for (const d of Object.values(HARNESS_UPDATE_DESCRIPTORS)) {
    assert.equal(isHarnessPinRefused(d, () => true), false, d.id);
  }
});

test('armed pin over a pinned NON-snapshot harness is refused (item 5 rule)', () => {
  const legacyPinned = { ...HARNESS_UPDATE_DESCRIPTORS.qwen, pinKey: 'kimi' };
  assert.equal(isHarnessPinRefused(legacyPinned, () => true), true);
  assert.equal(isHarnessPinRefused(legacyPinned, () => false), false);
});

test('npm-prefix failure → recovery reinstalls the captured previous version', async () => {
  reset();
  const rec = recorder();
  const job = await startHarnessUpdate('qwen', {
    deps: depsFor(rec, {
      runVersion: async () => '0.42.0',
      runCommand: async (cmd, args, opts) => {
        rec.commands.push({ cmd, args, env: opts.env });
        // First command (the update) fails; recovery reinstall succeeds.
        return rec.commands.length === 1 ? ok({ code: 1 }) : ok();
      },
    }),
  });
  await _awaitHarnessJob(job.jobId);
  const final = getHarnessUpdateJob(job.jobId)!;
  assert.equal(final.status, 'failed');
  assert.equal(final.error?.code, 'update_failed');
  // recovery: npm install --prefix <..> @qwen-code/qwen-code@0.42.0
  const recovery = rec.commands[1];
  assert.equal(recovery.cmd, 'npm');
  assert.ok(recovery.args.includes('@qwen-code/qwen-code@0.42.0'));
  assert.equal(rec.audits.at(-1)!.action, 'harness_update_failed');
});

test('timeout with failed rollback leaves a durable recovery_failed block', async () => {
  reset();
  const rec = recorder();
  const job = await startHarnessUpdate('qwen', {
    deps: depsFor(rec, {
      runVersion: async () => '0.23.0',
      runCommand: async () => ok({ timedOut: true, code: null }),
    }),
  });
  await _awaitHarnessJob(job.jobId);
  assert.equal(getHarnessUpdateJob(job.jobId)!.error?.code, 'recovery_failed');
  assert.equal(isHarnessLeased('qwen'), true);
  _resetHarnessLeases(); // simulate process restart: in-memory lease is gone
  await assert.rejects(() => startHarnessUpdate('qwen', { deps: depsFor(rec) }),
    (error: unknown) => error instanceof AppError && error.code === 'HARNESS_RECOVERY_FAILED');
  clearHarnessRecoveryBlocked('qwen');
});

test('an unquiesced timeout never starts rollback and keeps the launch block', async () => {
  reset();
  const rec = recorder();
  const job = await startHarnessUpdate('qwen', {
    deps: depsFor(rec, {
      runVersion: async () => '0.23.0',
      runCommand: async (cmd, args, opts) => {
        rec.commands.push({ cmd, args, env: opts.env });
        return ok({ timedOut: true, code: null, quiesced: false });
      },
    }),
  });
  await _awaitHarnessJob(job.jobId);
  assert.equal(getHarnessUpdateJob(job.jobId)!.error?.code, 'recovery_failed');
  assert.equal(rec.commands.length, 1, 'rollback cannot race a process group still able to mutate');
  assert.equal(isHarnessLeased('qwen'), true);
  clearHarnessRecoveryBlocked('qwen');
});

test('a failed durable intent write prevents the first installation mutation', async () => {
  reset();
  let mutations = 0;
  const job = await startHarnessUpdate('qwen', {
    deps: depsFor(recorder(), {
      runVersion: async () => '0.23.0',
      markRecoveryIntent: () => { throw new Error('database unavailable'); },
      runCommand: async () => {
        mutations += 1;
        return ok();
      },
    }),
  });
  await _awaitHarnessJob(job.jobId);
  assert.equal(getHarnessUpdateJob(job.jobId)!.error?.code, 'recovery_intent_failed');
  assert.equal(mutations, 0);
});

test('a restart between durable intent and outcome keeps launches blocked', async () => {
  reset();
  let enterMutation!: () => void;
  const entered = new Promise<void>((resolve) => { enterMutation = resolve; });
  let finishMutation!: (result: RunResult) => void;
  const pendingMutation = new Promise<RunResult>((resolve) => { finishMutation = resolve; });
  let versionCall = 0;
  const job = await startHarnessUpdate('qwen', {
    deps: depsFor(recorder(), {
      runVersion: async () => (versionCall++ === 0 ? '0.23.0' : '0.24.0'),
      runCommand: async () => {
        enterMutation();
        return pendingMutation;
      },
    }),
  });
  await entered;
  assert.equal(isHarnessRecoveryBlocked('qwen'), true);
  _resetHarnessLeases();
  assert.throws(() => beginHarnessLaunch('qwen'), (error: Error & { code?: string }) =>
    error.code === 'harness_updating');
  finishMutation(ok());
  await _awaitHarnessJob(job.jobId);
  assert.equal(getHarnessUpdateJob(job.jobId)!.status, 'succeeded');
  assert.equal(isHarnessRecoveryBlocked('qwen'), false);
});

test('T-1871: the scheduler can never start a manual-only (snapshot-backed) harness', async () => {
  reset();
  const rec = recorder();
  for (const id of ['claude', 'codex', 'antigravity', 'cursor', 'opencode']) {
    await assert.rejects(() => startHarnessUpdate(id, { trigger: 'scheduler', deps: depsFor(rec) }),
      (error: unknown) => error instanceof AppError && error.code === 'HARNESS_MANUAL_ONLY');
  }
  assert.equal(rec.commands.length, 0);
  assert.equal(isHarnessLeased('cursor'), false);
});

test('an installation without an exact prior version is refused before update', async () => {
  reset();
  const rec = recorder();
  const job = await startHarnessUpdate('qwen', {
    deps: depsFor(rec, { runVersion: async () => null }),
  });
  await _awaitHarnessJob(job.jobId);
  assert.equal(getHarnessUpdateJob(job.jobId)!.error?.code, 'installation_unrecognized');
  assert.equal(rec.commands.length, 0);
});

test('a lease blocks new spawns of the same harness', async () => {
  reset();
  const rec = recorder();
  let release!: () => void;
  const pending = new Promise<RunResult>((res) => {
    release = () => res(ok());
  });
  const job = await startHarnessUpdate('qwen', {
    deps: depsFor(rec, { runCommand: async () => pending }),
  });
  assert.equal(isHarnessSpawnBlocked('qwen'), true);
  assert.equal(isHarnessSpawnBlocked('kimi'), false);
  release();
  await _awaitHarnessJob(job.jobId);
  assert.equal(isHarnessSpawnBlocked('qwen'), false);
});

test('unknown harness → 404, non-updatable harness → 400', async () => {
  reset();
  await assert.rejects(() => startHarnessUpdate('no-such-harness'), (e: unknown) => {
    assert.ok(e instanceof AppError);
    assert.equal(e.statusCode, 404);
    return true;
  });
  // glm has no CLI at all.
  await assert.rejects(() => startHarnessUpdate('glm'), (e: unknown) => {
    assert.ok(e instanceof AppError);
    assert.equal(e.statusCode, 400);
    return true;
  });
});

test('finished jobs are pruned: the store never grows past its cap (item 10)', async () => {
  reset();
  const rec = recorder();
  const ids: string[] = [];
  for (let i = 0; i < 55; i += 1) {
    const job = await startHarnessUpdate('qwen', { deps: depsFor(rec) });
    await _awaitHarnessJob(job.jobId);
    ids.push(job.jobId);
  }
  const kept = ids.filter((id) => getHarnessUpdateJob(id) !== null);
  assert.ok(kept.length <= 50, `job store capped, kept ${kept.length}`);
  // The newest job is always still readable (its poll must not 404).
  assert.ok(getHarnessUpdateJob(ids.at(-1)!));
});
