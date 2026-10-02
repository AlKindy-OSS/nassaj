/**
 * B-1474 — probeUserWorkflowUnits decides "no user manager" only from
 * root-owned paths, never from sockets a same-uid process could delete, and
 * runs systemctl with an explicit env. Real temp dirs under /var/tmp; exec,
 * getuid and the roots are injected (no global fs mocking).
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, test } from 'node:test';

import {
  launchScope,
  probeUserWorkflowUnits,
  userManagerEnv,
  UserUnitProbeError,
  type LaunchExec,
  type ProbeExec,
  type UserUnitProbeOptions,
} from '@/modules/workflow-supervisor/systemd.js';

const uid = process.getuid?.() ?? 0;
let root = '';
let systemdRoot = '';
let runUserRoot = '';

before(() => {
  root = fs.mkdtempSync(path.join('/var/tmp', 'b1474-probe-'));
  systemdRoot = path.join(root, 'systemd-system');
  runUserRoot = path.join(root, 'run-user');
  fs.mkdirSync(systemdRoot);
  fs.mkdirSync(runUserRoot);
});

after(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

/** A runtime dir for `id` under the fake /run/user, recreated per test. */
function runtimeDir(id: number): string {
  const dir = path.join(runUserRoot, String(id));
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir);
  return dir;
}

function base(over: Partial<UserUnitProbeOptions> = {}): UserUnitProbeOptions {
  return { platform: 'linux', getuid: () => uid, systemdRoot, runUserRoot, basePath: '/usr/bin:/bin', ...over };
}

const neverExec: ProbeExec = async () => {
  throw new Error('systemctl must not run');
};

function rejecting(err: Record<string, unknown>): ProbeExec {
  return async () => {
    throw Object.assign(new Error('exec failed'), err);
  };
}

async function reasonOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (error) {
    assert.ok(error instanceof UserUnitProbeError, `expected UserUnitProbeError, got ${String(error)}`);
    return error.reason;
  }
  assert.fail('probe should have thrown');
}

test('unsupported platform or missing getuid → unsupported', async () => {
  assert.deepEqual(await probeUserWorkflowUnits(base({ platform: 'darwin', exec: neverExec })), { state: 'unsupported' });
  assert.deepEqual(await probeUserWorkflowUnits(base({ getuid: undefined, exec: neverExec })), { state: 'unsupported' });
});

test('/run/systemd/system absent → no_systemd', async () => {
  const res = await probeUserWorkflowUnits(base({ systemdRoot: path.join(root, 'missing'), exec: neverExec }));
  assert.deepEqual(res, { state: 'no_systemd' });
});

test('runtime dir absent → manager_absent (systemctl never runs)', async () => {
  fs.rmSync(path.join(runUserRoot, String(uid)), { recursive: true, force: true });
  assert.deepEqual(await probeUserWorkflowUnits(base({ exec: neverExec })), { state: 'manager_absent' });
});

test('ANTI-SPOOF: runtime dir present but private socket deleted + systemctl fails → systemctl_failed', async () => {
  const dir = runtimeDir(uid);
  assert.equal(fs.existsSync(path.join(dir, 'systemd', 'private')), false);
  const reason = await reasonOf(probeUserWorkflowUnits(base({
    exec: rejecting({ code: 1, stderr: 'Failed to connect to bus: No such file or directory' }),
  })));
  assert.equal(reason, 'systemctl_failed');
});

test('runtime dir owned by another uid → bad_runtime_dir', async () => {
  const other = uid + 1;
  runtimeDir(other); // created by this process, so owned by `uid`, not `other`
  const reason = await reasonOf(probeUserWorkflowUnits(base({ getuid: () => other, exec: neverExec })));
  assert.equal(reason, 'bad_runtime_dir');
});

test('runtime path that is a file → bad_runtime_dir', async () => {
  const p = path.join(runUserRoot, String(uid));
  fs.rmSync(p, { recursive: true, force: true });
  fs.writeFileSync(p, '');
  const reason = await reasonOf(probeUserWorkflowUnits(base({ exec: neverExec })));
  assert.equal(reason, 'bad_runtime_dir');
});

test('spawn ENOENT → systemctl_missing; killed by timeout → timeout', async () => {
  runtimeDir(uid);
  assert.equal(await reasonOf(probeUserWorkflowUnits(base({ exec: rejecting({ code: 'ENOENT' }) }))), 'systemctl_missing');
  assert.equal(
    await reasonOf(probeUserWorkflowUnits(base({ exec: rejecting({ killed: true, signal: 'SIGTERM', code: null }) }))),
    'timeout',
  );
});

test('error message is fixed; raw stderr stays on the bounded detail field', async () => {
  runtimeDir(uid);
  const stderr = `secret-ish ${'x'.repeat(500)}`;
  try {
    await probeUserWorkflowUnits(base({ exec: rejecting({ code: 1, stderr }) }));
    assert.fail('should throw');
  } catch (error) {
    assert.ok(error instanceof UserUnitProbeError);
    assert.doesNotMatch(error.message, /secret-ish/);
    assert.ok(error.detail.length <= 200);
  }
});

test('success parses wf units; env is explicit and ignores a polluted XDG_RUNTIME_DIR', async () => {
  const dir = runtimeDir(uid);
  const saved = process.env.XDG_RUNTIME_DIR;
  process.env.XDG_RUNTIME_DIR = '/polluted/by/member';
  let seen: { file: string; args: string[]; env: NodeJS.ProcessEnv; timeout: number; maxBuffer: number } | null = null;
  try {
    const res = await probeUserWorkflowUnits(base({
      exec: async (file, args, opts) => {
        seen = { file, args, ...opts };
        return { stdout: 'wf-a.service loaded active running x\nother.service loaded active running\n wf-b.service loaded active running y\n', stderr: '' };
      },
    }));
    assert.deepEqual(res, { state: 'present', units: ['wf-a.service', 'wf-b.service'] });
  } finally {
    if (saved === undefined) delete process.env.XDG_RUNTIME_DIR;
    else process.env.XDG_RUNTIME_DIR = saved;
  }
  assert.ok(seen);
  const s = seen as { file: string; args: string[]; env: NodeJS.ProcessEnv; timeout: number; maxBuffer: number };
  assert.equal(s.file, 'systemctl');
  assert.deepEqual(s.args, ['--user', 'list-units', '--type=service', '--state=active', '--no-legend', '--plain', 'wf-*.service']);
  assert.deepEqual(s.env, {
    PATH: '/usr/bin:/bin',
    XDG_RUNTIME_DIR: dir,
    DBUS_SESSION_BUS_ADDRESS: `unix:path=${dir}/bus`,
    LC_ALL: 'C',
  });
  assert.equal(s.timeout, 5000);
  assert.equal(s.maxBuffer, 256 * 1024);
});

test('maxBuffer overflow (killed=true) → systemctl_failed, not timeout', async () => {
  runtimeDir(uid);
  const reason = await reasonOf(probeUserWorkflowUnits(base({
    exec: rejecting({ code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER', killed: true, signal: 'SIGTERM' }),
  })));
  assert.equal(reason, 'systemctl_failed');
});

test('an unclassified failure inside the probe surfaces only as UserUnitProbeError(probe_failed)', async () => {
  runtimeDir(uid);
  const thrower = (): number => {
    throw new TypeError('getuid exploded');
  };
  assert.equal(await reasonOf(probeUserWorkflowUnits(base({ getuid: thrower, exec: neverExec }))), 'probe_failed');
  const badExec: ProbeExec = async () => ({ stdout: null as unknown as string, stderr: '' });
  assert.equal(await reasonOf(probeUserWorkflowUnits(base({ exec: badExec }))), 'probe_failed');
});

/** Restores process.env[key] after `fn`, whatever it does. */
async function withEnv(key: string, value: string, fn: () => Promise<void>): Promise<void> {
  const saved = process.env[key];
  process.env[key] = value;
  try {
    await fn();
  } finally {
    if (saved === undefined) delete process.env[key];
    else process.env[key] = saved;
  }
}

test('ONE MANAGER: launchScope forces XDG_RUNTIME_DIR/DBUS to /run/user/<uid> over a polluted env', async () => {
  const fakeClaude = path.join(root, 'claude');
  fs.writeFileSync(fakeClaude, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  let seen: { file: string; args: string[]; env: NodeJS.ProcessEnv } | null = null;
  const exec: LaunchExec = async (file, args, opts) => {
    seen = { file, args, env: opts.env };
  };
  await withEnv('CLAUDE_CLI_PATH', fakeClaude, () =>
    withEnv('XDG_RUNTIME_DIR', '/polluted/by/member', () =>
      withEnv('DBUS_SESSION_BUS_ADDRESS', 'unix:path=/polluted/bus', async () => {
        await launchScope({
          wfLaunchId: `b1474-${process.pid}`, userId: 7, cwd: root, scriptOrPrompt: 'p',
          setenv: {}, resultDir: root, exec,
        });
      })));
  assert.ok(seen);
  const s = seen as { file: string; args: string[]; env: NodeJS.ProcessEnv };
  assert.equal(s.file, 'systemd-run');
  assert.equal(s.args[0], '--user');
  const expected = userManagerEnv(uid);
  assert.equal(s.env.XDG_RUNTIME_DIR, `/run/user/${uid}`);
  assert.equal(s.env.XDG_RUNTIME_DIR, expected.XDG_RUNTIME_DIR);
  assert.equal(s.env.DBUS_SESSION_BUS_ADDRESS, expected.DBUS_SESSION_BUS_ADDRESS);
  assert.equal(s.env.PATH, process.env.PATH, 'the rest of the inherited env is kept');
});

test('probe and launcher derive the manager from the same helper', () => {
  assert.deepEqual(userManagerEnv(1000), {
    XDG_RUNTIME_DIR: '/run/user/1000',
    DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus',
  });
  assert.deepEqual(userManagerEnv(5, '/x/run-user').XDG_RUNTIME_DIR, '/x/run-user/5');
});

// --- the real execFile path (defaultProbeExec) against a fake systemctl --------

/** A bin dir holding a fake `systemctl` with `body`; PATH = bin + system dirs. */
function fakeSystemctl(body: string): string {
  const bin = fs.mkdtempSync(path.join(root, 'bin-'));
  fs.writeFileSync(path.join(bin, 'systemctl'), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return `${bin}:/usr/bin:/bin`;
}

test('real exec: systemctl receives exactly the explicit env and its output is parsed', async () => {
  const dir = runtimeDir(uid);
  const out = path.join(root, 'env.out');
  const basePath = fakeSystemctl(`env > '${out}'\necho 'wf-real.service loaded active running d'`);
  await withEnv('NASSAJ_B1474_LEAK', 'must-not-reach', () =>
    withEnv('XDG_RUNTIME_DIR', '/polluted/by/member', async () => {
      const res = await probeUserWorkflowUnits(base({ basePath }));
      assert.deepEqual(res, { state: 'present', units: ['wf-real.service'] });
    }));
  const env = Object.fromEntries(
    fs.readFileSync(out, 'utf8').trim().split('\n').map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
  );
  assert.equal(env.XDG_RUNTIME_DIR, dir);
  assert.equal(env.DBUS_SESSION_BUS_ADDRESS, `unix:path=${dir}/bus`);
  assert.equal(env.LC_ALL, 'C');
  assert.equal(env.PATH, basePath);
  assert.equal(env.NASSAJ_B1474_LEAK, undefined, 'nothing else is inherited');
});

test('real exec: exit 1 → systemctl_failed; overrun → timeout; huge output → systemctl_failed', async () => {
  runtimeDir(uid);
  assert.equal(
    await reasonOf(probeUserWorkflowUnits(base({ basePath: fakeSystemctl('echo boom >&2\nexit 1') }))),
    'systemctl_failed',
  );
  assert.equal(
    await reasonOf(probeUserWorkflowUnits(base({ basePath: fakeSystemctl('exec sleep 5'), timeoutMs: 150 }))),
    'timeout',
  );
  assert.equal(
    await reasonOf(probeUserWorkflowUnits(base({ basePath: fakeSystemctl('head -c 400000 /dev/zero') }))),
    'systemctl_failed',
  );
});
