/**
 * RUNNER BRIDGE — force-stop unit tests
 * =====================================
 *
 * forceStopRunner is the genuinely new control verb: an immediate kill of the
 * live systemd scope PLUS a durable soft pause (so the supervisor cannot relaunch
 * after the kill). These tests guard its contract (no real systemctl is run —
 * child_process.execFile is mocked):
 *
 *  - it writes the pause file FIRST with reason 'force-stop' (so a relaunch is
 *    blocked even if the scope kill races), then calls systemctl.
 *  - it targets the LIVE unit from supervisor.json session.unit when present,
 *    else the conventional `minwal-<name>.scope`.
 *  - it invokes systemctl with a PARAMETERIZED argv (no shell string), so the
 *    unit name can never inject a command.
 *  - it returns true when systemctl succeeds and when the unit is already
 *    inactive ("not loaded"/"not active"); false on any other failure, and the
 *    pause file is written regardless (re-arm is always resume).
 *
 * A separate module-mock setup from runner-bridge.service.test.ts (own tmp root +
 * own execFile double) so neither test contaminates the other's import graph.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { mkdir, writeFile, access, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { mock, after } from 'node:test';

// ---- fixtures: throwaway runner root, swapped in via env before import ----

const runnerRoot = mkdtempSync(path.join(os.tmpdir(), 'runner-forcestop-test-'));
process.env.NASSAJ_RUNNER_ROOT = runnerRoot;

const STATE = path.join(runnerRoot, 'state');

// ---- execFile double: capture argv, drive success / failure per test ----

type ExecFileCall = { file: string; args: string[] };
const execFileCalls: ExecFileCall[] = [];

// Behaviour the next execFile invocation should exhibit.
let execFileBehaviour: { ok: true } | { ok: false; stderr: string } = { ok: true };

// promisify(execFile) expects the node callback signature (err, stdout, stderr).
function execFileMock(
  file: string,
  args: string[],
  callback: (err: (Error & { stderr?: string }) | null, stdout: string, stderr: string) => void,
): void {
  execFileCalls.push({ file, args });
  if (execFileBehaviour.ok) {
    callback(null, '', '');
    return;
  }
  const err = new Error('Command failed') as Error & { stderr?: string };
  err.stderr = execFileBehaviour.stderr;
  callback(err, '', execFileBehaviour.stderr);
}

mock.module('child_process', {
  namedExports: {
    execFile: execFileMock,
  },
});

// projectsDb leaf is mocked so the barrel never opens sqlite.
mock.module('@/modules/database/repositories/projects.db.js', {
  namedExports: {
    projectsDb: { getProjectPathById: () => null },
  },
});

const { forceStopRunner, runnerPaths } = await import('./runner-bridge.service.js');

after(() => {
  rmSync(runnerRoot, { recursive: true, force: true });
});

// ---- helpers ----

async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

async function writeSupervisor(name: string, raw: string): Promise<void> {
  const dir = path.join(STATE, name);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'supervisor.json'), raw);
}

function resetExecFile(behaviour: typeof execFileBehaviour): void {
  execFileCalls.length = 0;
  execFileBehaviour = behaviour;
}

// ---- tests ----

test('forceStopRunner writes pause (reason force-stop) BEFORE killing, returns true', async () => {
  resetExecFile({ ok: true });
  const paths = runnerPaths('fs-alpha');

  const ok = await forceStopRunner('fs-alpha', 'owner-user');
  assert.equal(ok, true);

  // pause file written with the force-stop reason.
  assert.equal(await exists(paths.pause), true, 'pause file must exist after force-stop');
  const body = JSON.parse(await readFile(paths.pause, 'utf8')) as {
    reason?: string;
    by?: string;
    at?: string;
  };
  assert.equal(body.reason, 'force-stop', 'force-stop must mark the pause reason');
  assert.equal(body.by, 'owner-user');

  // systemctl invoked exactly once with the conventional scope name.
  assert.equal(execFileCalls.length, 1);
  assert.equal(execFileCalls[0].file, 'systemctl');
  assert.deepEqual(
    execFileCalls[0].args,
    ['--user', 'stop', 'minwal-fs-alpha.scope'],
    'parameterized argv: --user stop <conventional scope>',
  );
});

test('forceStopRunner targets the LIVE unit from supervisor.json session.unit', async () => {
  resetExecFile({ ok: true });
  await writeSupervisor(
    'fs-beta',
    JSON.stringify({
      session: { pid: 99, unit: 'minwal-fs-beta-sup.scope', exit_reason: null },
    }),
  );

  const ok = await forceStopRunner('fs-beta', 'owner');
  assert.equal(ok, true);
  assert.equal(execFileCalls.length, 1);
  assert.deepEqual(
    execFileCalls[0].args,
    ['--user', 'stop', 'minwal-fs-beta-sup.scope'],
    'must prefer the live unit recorded in supervisor.json',
  );
});

test('forceStopRunner: argv is parameterized (no shell) so the unit cannot inject', async () => {
  resetExecFile({ ok: true });
  // A hostile unit name from supervisor.json must travel as a single argv token,
  // never spliced into a shell command line.
  await writeSupervisor(
    'fs-inject',
    JSON.stringify({ session: { unit: 'evil.scope; rm -rf /' } }),
  );

  await forceStopRunner('fs-inject', 'owner');
  assert.equal(execFileCalls[0].file, 'systemctl');
  assert.equal(
    execFileCalls[0].args[2],
    'evil.scope; rm -rf /',
    'the unit name stays a single, un-evaluated argv element',
  );
});

test('forceStopRunner returns true when the unit is already inactive (not loaded)', async () => {
  resetExecFile({ ok: false, stderr: 'Failed to stop minwal-fs-gamma.scope: Unit not loaded.' });

  const ok = await forceStopRunner('fs-gamma', 'owner');
  assert.equal(ok, true, 'an already-stopped unit is a benign success');
  // pause still written so re-arm always goes through resume.
  assert.equal(await exists(runnerPaths('fs-gamma').pause), true);
});

test('forceStopRunner returns false on a real systemctl failure, but pause is still written', async () => {
  resetExecFile({ ok: false, stderr: 'Interactive authentication required.' });

  const ok = await forceStopRunner('fs-delta', 'owner');
  assert.equal(ok, false, 'a genuine systemctl error surfaces as false');
  assert.equal(
    await exists(runnerPaths('fs-delta').pause),
    true,
    'the durable soft pause must be written even when the scope kill fails',
  );
});
