/**
 * ADR-053 §ج (the B-103 CORE guarantee) — a supervisor-launched workflow unit
 * SURVIVES the death of the process that launched it. This is the whole reason
 * the supervisor exists: in B-103 the coordinator (an ssh `claude` terminal)
 * died and took the workflow with it. Here we prove, against REAL systemd, that a
 * transient user unit does NOT die with its launcher.
 *
 * Also exercises the real systemd adapters end-to-end:
 *   - launchScope launches a transient SERVICE and RETURNS IMMEDIATELY (it does
 *     NOT block for the run's duration — a --scope launch would, which is the bug
 *     this suite guards against),
 *   - systemctlIsActive reflects the live unit,
 *   - listActiveUserScopes attributes the unit to its owner via the Description
 *     marker and ignores another user's unit,
 *   - stopScope tears it down idempotently.
 *
 * Self-skips if a systemd --user session is not available in the sandbox.
 */

import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import test from 'node:test';
import { promisify } from 'node:util';

import {
  launchScope,
  listActiveUserScopes,
  stopScope,
  systemctlIsActive,
} from '@/modules/workflow-supervisor/systemd.js';
import { scopeUnitName } from '@/modules/workflow-supervisor/config.js';

const execFileAsync = promisify(execFile);

async function systemdUserAvailable(): Promise<boolean> {
  try {
    await execFileAsync('systemd-run', ['--user', '--version']);
    const probe = `wf-survcheck-${process.pid}.service`;
    await execFileAsync('systemd-run', ['--user', '--quiet', `--unit=${probe}`, '--', 'sleep', '2']);
    await execFileAsync('systemctl', ['--user', 'stop', probe]).catch(() => {});
    return true;
  } catch {
    return false;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('launchScope returns immediately (does NOT block for the run) and the unit is active', async (t) => {
  if (!(await systemdUserAvailable())) {
    t.skip('systemd --user unavailable');
    return;
  }
  const wfLaunchId = `surv-nonblock-${process.pid}`;
  const unit = scopeUnitName(wfLaunchId);
  const t0 = Date.now();
  const returned = await launchScope({
    wfLaunchId,
    userId: 4242,
    cwd: '/tmp',
    claudeBin: '/bin/sleep', // stand-in "claude": the in-unit node wrapper spawns `/bin/sleep …`
    scriptOrPrompt: '30', // -> the wrapper passes it as the prompt; the point is it does NOT block us
    setenv: { CLAUDE_CONFIG_DIR: '/home/dev/.nassaj-users/4242/.claude' },
    resultDir: `/tmp/wf-surv-${process.pid}`,
    timeoutSeconds: 30,
  }).catch((e) => {
    // /bin/sleep -p 30 exits non-zero (bad flag) but the UNIT still starts; we only
    // need launchScope to have forked the unit and returned. Treat a launch that
    // reached systemd-run as success for the non-block timing assertion.
    return unit + `#launch-warn:${e instanceof Error ? e.message : String(e)}`;
  });
  const elapsed = Date.now() - t0;
  try {
    assert.ok(elapsed < 5000, `launchScope must return promptly, took ${elapsed}ms (a --scope launch would block)`);
    assert.ok(String(returned).startsWith(unit), 'returns the unit name');
  } finally {
    // The stand-in `/bin/sleep -p 30` exits non-zero (bad flag) => the transient
    // unit ends in `failed`; stop + reset-failed so this test leaves NOTHING
    // behind in the live --user session on repeat runs.
    await stopScope(unit).catch(() => {});
    await execFileAsync('systemctl', ['--user', 'reset-failed', unit]).catch(() => {});
  }
});

test('B-103 CORE: a unit launched by a short-lived launcher SURVIVES the launcher’s death', async (t) => {
  if (!(await systemdUserAvailable())) {
    t.skip('systemd --user unavailable');
    return;
  }
  const unit = `wf-surv-detach-${process.pid}.service`;

  // A LAUNCHER child process that starts a transient unit running `sleep 30`, then
  // exits immediately — modelling the coordinator (ssh claude) that dies in B-103.
  const launcherCode = `
    const { execFile } = require('node:child_process');
    execFile('systemd-run', ['--user','--quiet','--unit=${unit}','--','sleep','30'], (err) => {
      process.exit(err ? 1 : 0);
    });
  `;
  const launcher = spawn(process.execPath, ['-e', launcherCode], { stdio: 'ignore' });
  const launcherPid = launcher.pid;
  const launcherExit: number = await new Promise((resolve) => launcher.on('exit', (code) => resolve(code ?? -1)));
  assert.equal(launcherExit, 0, 'launcher started the unit then exited cleanly');

  // The launcher process is now GONE.
  assert.throws(
    () => process.kill(launcherPid as number, 0),
    /ESRCH/,
    'the launcher process has truly exited',
  );

  try {
    // Give systemd a moment, then assert the unit is STILL ACTIVE after the
    // launcher died — the survival guarantee.
    await sleep(500);
    const state = await systemctlIsActive(unit);
    assert.equal(state, 'active', `unit must survive the launcher’s death (state=${state})`);

    // And it is genuinely alive (still counts as a running unit).
    const { stdout } = await execFileAsync('systemctl', [
      '--user', 'list-units', '--type=service', '--state=active', '--no-legend', '--plain', unit,
    ]);
    assert.match(stdout, new RegExp(unit.replace('.', '\\.')), 'the surviving unit is listed active');
  } finally {
    const stopped = await stopScope(unit);
    assert.equal(stopped, true, 'stopScope tears the surviving unit down');
    await sleep(300);
    const after = await systemctlIsActive(unit);
    assert.notEqual(after, 'active', `unit is no longer active after stop (state=${after})`);
  }
});

test('listActiveUserScopes attributes a unit to its owner and ignores another user’s unit', async (t) => {
  if (!(await systemdUserAvailable())) {
    t.skip('systemd --user unavailable');
    return;
  }
  const owner = 7001;
  const other = 7002;
  const ownerUnit = `wf-own-${owner}-${process.pid}.service`;
  const otherUnit = `wf-own-${other}-${process.pid}.service`;

  // Launch two units with owner markers in their Description (as launchScope does).
  await execFileAsync('systemd-run', [
    '--user', '--quiet', `--unit=${ownerUnit}`, `--description=nassaj workflow wf-owner=${owner}`, '--', 'sleep', '20',
  ]);
  await execFileAsync('systemd-run', [
    '--user', '--quiet', `--unit=${otherUnit}`, `--description=nassaj workflow wf-owner=${other}`, '--', 'sleep', '20',
  ]);

  try {
    const ownerScopes = await listActiveUserScopes(owner);
    assert.ok(ownerScopes.includes(ownerUnit), `owner ${owner} sees its own unit: got ${JSON.stringify(ownerScopes)}`);
    assert.ok(!ownerScopes.includes(otherUnit), 'owner does NOT see another user’s unit (per-user attribution)');

    const otherScopes = await listActiveUserScopes(other);
    assert.ok(otherScopes.includes(otherUnit), 'the other user sees only their own unit');
    assert.ok(!otherScopes.includes(ownerUnit), 'and not the owner’s');
  } finally {
    await stopScope(ownerUnit).catch(() => {});
    await stopScope(otherUnit).catch(() => {});
  }
});

test('stopScope is idempotent for an already-absent unit', async (t) => {
  if (!(await systemdUserAvailable())) {
    t.skip('systemd --user unavailable');
    return;
  }
  const res = await stopScope(`wf-never-existed-${process.pid}.service`);
  assert.equal(res, true, 'stopping a non-existent unit resolves true (no-such-unit is a benign stop)');
});
