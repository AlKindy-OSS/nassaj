import assert from 'node:assert/strict';
import test from 'node:test';

import { AppError } from '@/shared/utils.js';

import { HARNESS_UPDATE_DESCRIPTORS } from './descriptors.js';
import {
  _resetHarnessLaunches,
  beginHarnessLaunch,
  clearHarnessRecoveryBlocked,
  isHarnessRecoveryBlocked,
} from './spawn-admission.js';
import { _resetHarnessLeases, isHarnessLeased } from './lease.js';
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
  for (const id of ['kimi', 'qwen', 'hermes']) clearHarnessRecoveryBlocked(id);
}

interface Recorder {
  commands: Array<{ cmd: string; args: string[]; env: NodeJS.ProcessEnv }>;
  audits: Array<{ action: string; metadata: Record<string, unknown>; userId: number | null }>;
}

function recorder(): Recorder {
  return { commands: [], audits: [] };
}

const depsFor = (rec: Recorder, over: Partial<UpdateServiceDeps> = {}): UpdateServiceDeps => ({
  hasLiveSession: () => false,
  hasUnregisteredLaunch: async () => false,
  pinEnabled: () => false,
  runCommand: async (cmd, args, opts) => {
    rec.commands.push({ cmd, args, env: opts.env });
    return ok();
  },
  runVersion: async () => '1.0.0',
  audit: (action, metadata, userId) => rec.audits.push({ action, metadata, userId }),
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
  const job = await startHarnessUpdate('kimi', {
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
    provider: 'kimi', fromVersion: '0.42.0', toVersion: '0.43.0', exitCode: 0, trigger: 'manual',
  });
  assert.equal(success.userId, 7);
});

test('a downgrade is rejected and the exact previous version is restored', async () => {
  reset();
  const rec = recorder();
  const versions = ['1.2.0', '1.1.9', '1.2.0'];
  const job = await startHarnessUpdate('kimi', {
    deps: depsFor(rec, { runVersion: async () => versions.shift() ?? '1.2.0' }),
  });
  await _awaitHarnessJob(job.jobId);
  assert.equal(getHarnessUpdateJob(job.jobId)!.error?.code, 'update_unverified');
  assert.ok(rec.commands.some((entry) => entry.args.includes('@moonshot-ai/kimi-code@1.2.0')));
});

test('spawn env is cleanSpawnEnv output — no host secrets, no CLAUDE_CONFIG_DIR', async () => {
  reset();
  process.env.JWT_SECRET = 'super-secret';
  process.env.CLAUDE_CONFIG_DIR = '/home/op/.claude';
  process.env.NASSAJ_PROVIDER_SECRETS_KEY = 'master';
  const rec = recorder();
  // Do NOT inject cleanEnv — exercise the real cleanSpawnEnv default.
  const job = await startHarnessUpdate('kimi', {
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
  const job = await startHarnessUpdate('kimi', {
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
  assert.equal(isHarnessLeased('kimi'), false);
});

test('TOCTOU: the lease is held BEFORE the live-session check runs', async () => {
  reset();
  const rec = recorder();
  // The gate observes the lease state AT THE MOMENT it is consulted. If the
  // check still ran first, this would be false and a turn starting in between
  // would race the binary swap (the qa-critic finding).
  let leasedWhenChecked: boolean | null = null;
  const job = await startHarnessUpdate('kimi', {
    deps: depsFor(rec, {
      hasLiveSession: () => {
        leasedWhenChecked = isHarnessLeased('kimi');
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
  const release = beginHarnessLaunch('kimi');
  const job = await startHarnessUpdate('kimi', {
    deps: depsFor(rec, { hasLiveSession: () => false, hasUnregisteredLaunch: undefined }),
  });
  assert.equal(job.status, 'skipped_live_session');
  assert.equal(job.error?.code, 'live_session_active');
  assert.equal(rec.commands.length, 0);
  assert.equal(isHarnessLeased('claude'), false);
  release();

  // Once the child is gone the same call proceeds (the registry is not sticky).
  let versionCall = 0;
  const after = await startHarnessUpdate('kimi', {
    deps: depsFor(rec, {
      hasUnregisteredLaunch: async () => false,
      runVersion: async () => (versionCall++ === 0 ? '1.0.0' : '1.1.0'),
    }),
  });
  await _awaitHarnessJob(after.jobId);
  assert.equal(getHarnessUpdateJob(after.jobId)!.status, 'succeeded');
});

test('a gate that cannot answer fails CLOSED (never updates under a live turn)', async () => {
  reset();
  const rec = recorder();
  const job = await startHarnessUpdate('kimi', {
    deps: depsFor(rec, {
      hasUnregisteredLaunch: async () => { throw new Error('systemctl unavailable'); },
    }),
  });
  assert.equal(job.status, 'skipped_live_session');
  assert.equal(rec.commands.length, 0);
});

test('single-flight: a second update while one runs throws 409 with activeJobId', async () => {
  reset();
  const rec = recorder();
  let release!: () => void;
  const pending = new Promise<RunResult>((res) => {
    release = () => res(ok());
  });
  const first = await startHarnessUpdate('kimi', {
    deps: depsFor(rec, { runCommand: async () => pending }),
  });
  await assert.rejects(
    () => startHarnessUpdate('kimi', { deps: depsFor(rec) }),
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

test('armed pin over a pinned harness → refused_pinned, update never runs (item 5)', async () => {
  reset();
  const rec = recorder();
  const job = await startHarnessUpdate('kimi', {
    deps: depsFor(rec, { pinEnabled: () => true }),
  });
  assert.equal(job.status, 'refused_pinned');
  // Addendum 3 names this code `pinned_refused` on the wire; the client keys its
  // message off it, so the old ad-hoc 'PINNED' would render "update failed".
  assert.equal(getHarnessUpdateJob(job.jobId)!.error?.code, 'pinned_refused');
  assert.ok(getHarnessUpdateJob(job.jobId)!.error?.messageAr);
  assert.equal(rec.commands.length, 0);
});

test('npm-prefix failure → recovery reinstalls the captured previous version', async () => {
  reset();
  const rec = recorder();
  const job = await startHarnessUpdate('kimi', {
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
  // recovery: npm install --prefix <..> @moonshot-ai/kimi-code@0.42.0
  const recovery = rec.commands[1];
  assert.equal(recovery.cmd, 'npm');
  assert.ok(recovery.args.includes('@moonshot-ai/kimi-code@0.42.0'));
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

test('native self-updaters without exact rollback are ineligible', async () => {
  reset();
  const rec = recorder();
  await assert.rejects(() => startHarnessUpdate('cursor', { deps: depsFor(rec) }),
    (error: unknown) => error instanceof AppError && error.code === 'HARNESS_NOT_UPDATABLE');
  assert.equal(rec.commands.length, 0);
});

test('an installation without an exact prior version is refused before update', async () => {
  reset();
  const rec = recorder();
  const job = await startHarnessUpdate('kimi', {
    deps: depsFor(rec, { runVersion: async () => null }),
  });
  await _awaitHarnessJob(job.jobId);
  assert.equal(getHarnessUpdateJob(job.jobId)!.error?.code, 'installation_unrecognized');
  assert.equal(rec.commands.length, 0);
});

test('a dirty git installation is refused without reset or update', async () => {
  reset();
  const rec = recorder();
  const exactRevision = 'a'.repeat(40);
  const job = await startHarnessUpdate('hermes', {
    deps: depsFor(rec, {
      cleanEnv: () => ({ PATH: '/usr/bin', HERMES_PATH: '/home/user/bin/hermes' }),
      runVersion: async () => 'Hermes Agent v0.17.0',
      runCommand: async (cmd, args, opts) => {
        rec.commands.push({ cmd, args, env: opts.env });
        if (args[0] === 'rev-parse') return ok({ stdout: `${exactRevision}\n` });
        if (args[0] === 'status') return ok({ stdout: ' M local-file\n' });
        return ok();
      },
    }),
  });
  await _awaitHarnessJob(job.jobId);
  assert.equal(getHarnessUpdateJob(job.jobId)!.error?.code, 'dirty_installation');
  assert.equal(rec.commands.some((command) => command.args[0] === 'update'), false);
  assert.equal(rec.commands.some((command) => command.args[0] === 'reset'), false);
});

test('a lease blocks new spawns of the same harness', async () => {
  reset();
  const rec = recorder();
  let release!: () => void;
  const pending = new Promise<RunResult>((res) => {
    release = () => res(ok());
  });
  const job = await startHarnessUpdate('kimi', {
    deps: depsFor(rec, { runCommand: async () => pending }),
  });
  assert.equal(isHarnessSpawnBlocked('kimi'), true);
  assert.equal(isHarnessSpawnBlocked('qwen'), false);
  release();
  await _awaitHarnessJob(job.jobId);
  assert.equal(isHarnessSpawnBlocked('kimi'), false);
});

test('unknown harness → 404, non-updatable harness → 400', async () => {
  reset();
  await assert.rejects(() => startHarnessUpdate('gemini'), (e: unknown) => {
    assert.ok(e instanceof AppError);
    assert.equal(e.statusCode, 404);
    return true;
  });
  // hermes is updatable now (Addendum 3); glm has no CLI at all.
  await assert.rejects(() => startHarnessUpdate('glm'), (e: unknown) => {
    assert.ok(e instanceof AppError);
    assert.equal(e.statusCode, 400);
    return true;
  });
});

test('hermes updates through the git-shallow path (Addendum 3)', async () => {
  reset();
  const rec = recorder();
  const job = await startHarnessUpdate('hermes', {
    deps: depsFor(rec, {
      cleanEnv: () => ({ PATH: '/usr/bin', HERMES_PATH: '/home/user/bin/hermes' }),
      runVersion: (() => {
        let call = 0;
        return async () => (call++ === 0 ? 'Hermes Agent v0.17.0' : 'Hermes Agent v0.18.0');
      })(),
      runCommand: async (cmd, args, opts) => {
        rec.commands.push({ cmd, args, env: opts.env });
        return ok({ stdout: args[0] === 'rev-parse' ? `${'b'.repeat(40)}\n` : '' });
      },
    }),
  });
  await _awaitHarnessJob(job.jobId);
  assert.equal(getHarnessUpdateJob(job.jobId)!.status, 'succeeded');
  assert.deepEqual(rec.commands[0].args, ['rev-parse', '--verify', 'HEAD']);
  assert.deepEqual(rec.commands[1].args, ['status', '--porcelain', '--untracked-files=normal']);
  assert.deepEqual(rec.commands[2].args, ['rev-parse', '--verify', '@{upstream}']);
  assert.deepEqual(rec.commands[3].args, ['update', '--yes']);
});

test('hermes uses one captured checkout for preflight, update, verification and recovery', async () => {
  reset();
  const descriptor = HARNESS_UPDATE_DESCRIPTORS.hermes;
  const originalCheckout = descriptor.gitCheckoutDir;
  const checkout = '/var/tmp/nassaj-hermes-override';
  descriptor.gitCheckoutDir = checkout;
  const commands: Array<{ cmd: string; args: string[]; cwd?: string }> = [];
  const versionBinaries: string[] = [];
  try {
    const job = await startHarnessUpdate('hermes', {
      deps: depsFor(recorder(), {
        cleanEnv: () => ({ PATH: '/usr/bin' }),
        runVersion: async (binary) => {
          versionBinaries.push(binary);
          return 'Hermes Agent v0.17.0';
        },
        runCommand: async (cmd, args, opts) => {
          commands.push({ cmd, args, cwd: opts.cwd });
          if (args[0] === 'update') return ok({ code: 1 });
          if (args[0] === 'rev-parse') return ok({ stdout: `${'c'.repeat(40)}\n` });
          return ok();
        },
      }),
    });
    await _awaitHarnessJob(job.jobId);
    assert.equal(getHarnessUpdateJob(job.jobId)!.error?.code, 'update_failed');
    assert.deepEqual(new Set(versionBinaries), new Set([`${checkout}/venv/bin/hermes`]));
    assert.ok(commands.every(({ cwd }) => cwd === checkout));
    const update = commands.find(({ args }) => args[0] === 'update');
    assert.equal(update?.cmd, `${checkout}/venv/bin/hermes`);
    const reinstall = commands.find(({ args }) => args[0] === 'pip');
    assert.ok(reinstall?.args.includes(`${checkout}/venv/bin/python`));
  } finally {
    descriptor.gitCheckoutDir = originalCheckout;
  }
});

test('finished jobs are pruned: the store never grows past its cap (item 10)', async () => {
  reset();
  const rec = recorder();
  const ids: string[] = [];
  for (let i = 0; i < 55; i += 1) {
    const job = await startHarnessUpdate('kimi', { deps: depsFor(rec) });
    await _awaitHarnessJob(job.jobId);
    ids.push(job.jobId);
  }
  const kept = ids.filter((id) => getHarnessUpdateJob(id) !== null);
  assert.ok(kept.length <= 50, `job store capped, kept ${kept.length}`);
  // The newest job is always still readable (its poll must not 404).
  assert.ok(getHarnessUpdateJob(ids.at(-1)!));
});
