// B-1349: FIRST import — HOME becomes a /var/tmp sandbox before anything reads it.
import '@/shared/__tests__/sandbox-home.js';
import assert from 'node:assert/strict';
import test from 'node:test';

import { UserUnitProbeError, type UserUnitProbe } from '@/modules/workflow-supervisor/index.js';
import { AppError } from '@/shared/utils.js';

import { HARNESS_UPDATE_DESCRIPTORS } from './descriptors.js';
import { isHarnessPinRefused } from './version-status.service.js';
import { _resetHarnessLaunches, beginHarnessLaunch } from './spawn-admission.js';
import { _resetHarnessLeases, isHarnessLeased } from './lease.js';
import { defaultHasUnregisteredLaunch } from './run-command.js';
import {
  _resetHarnessJobs,
  runHarnessUpdateCommand,
  startHarnessUpdate,
  type UpdateServiceDeps,
} from './update.service.js';

/*
 * The legacy npm-prefix update path and its tests went with the last npm-prefix
 * harness (qwen, ADR-229). The update state machine is covered through the
 * snapshot harnesses in snapshot-update.test.ts and through dsh in npm-lock/.
 */

function reset(): void {
  _resetHarnessLeases();
  _resetHarnessJobs();
  _resetHarnessLaunches();
}

const recorder = (): { commands: string[] } => ({ commands: [] });

const depsFor = (rec: { commands: string[] }): UpdateServiceDeps => ({
  cleanEnv: () => ({ PATH: '/usr/bin:/bin' }),
  hasLiveSession: () => false,
  hasUnregisteredLaunch: async () => null,
  pinEnabled: () => false,
  runCommand: async (cmd) => {
    rec.commands.push(cmd);
    return { code: 0, stdout: '', stderr: '', timedOut: false };
  },
  runVersion: async () => '1.0.0',
  audit: () => {},
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

test('B-1474: defaultHasUnregisteredLaunch maps each probe verdict', async () => {
  reset();
  const probe = (p: UserUnitProbe) => async () => p;
  assert.equal(await defaultHasUnregisteredLaunch(['claude'], probe({ state: 'manager_absent' })), null);
  assert.equal(await defaultHasUnregisteredLaunch(['claude'], probe({ state: 'no_systemd' })), null);
  assert.equal(await defaultHasUnregisteredLaunch(['claude'], probe({ state: 'unsupported' })), null);
  assert.equal(await defaultHasUnregisteredLaunch(['claude'], probe({ state: 'present', units: [] })), null);
  assert.equal(await defaultHasUnregisteredLaunch(['claude'], probe({ state: 'present', units: ['wf-a.service'] })), 'live_unit');
  let probed = false;
  assert.equal(await defaultHasUnregisteredLaunch(['opencode'], async () => { probed = true; return { state: 'manager_absent' }; }), null);
  assert.equal(probed, false, 'non-claude harnesses never probe systemd');
  await assert.rejects(
    () => defaultHasUnregisteredLaunch(['claude'], async () => { throw new UserUnitProbeError('timeout'); }),
    UserUnitProbeError,
  );
  const release = beginHarnessLaunch('claude');
  assert.equal(await defaultHasUnregisteredLaunch(['claude'], probe({ state: 'manager_absent' })), 'live_launch');
  release();
});

test('armed pin: no live harness is refused outright — pinned ones are snapshot-backed', () => {
  // A pinned harness (opencode) is snapshot-backed, so an armed pin asks for a
  // server-built pinBreak ack instead of refused_pinned.
  for (const d of Object.values(HARNESS_UPDATE_DESCRIPTORS)) {
    assert.equal(isHarnessPinRefused(d, () => true), false, d.id);
  }
});

test('armed pin over a pinned NON-snapshot harness is refused (item 5 rule)', () => {
  const legacyPinned = { ...HARNESS_UPDATE_DESCRIPTORS.dsh, snapshot: null, pinKey: 'opencode' };
  assert.equal(isHarnessPinRefused(legacyPinned, () => true), true);
  assert.equal(isHarnessPinRefused(legacyPinned, () => false), false);
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

