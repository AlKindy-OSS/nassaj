/**
 * ADR-206 §6 (S4) integration: the cleanup against real processes. Only this test's own
 * `sleep` children (cwd /var/tmp) exist with the tag; the signal seam refuses any other pid,
 * so a bug can never reach a foreign process.
 */
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { after, describe, it } from 'node:test';

import { cleanupCodexTurnProcesses, codexTurnLaunchMs, defaultCleanupDeps } from '../codex-turn-cleanup.js';
import { defaultProcScanDeps, isProcessAlive, readProcStat } from '../../../../execution-permissions/tagged-process-scan.js';

const SERVER_PM_ID = `test-${process.pid}`;
const children: ChildProcess[] = [];

function sleeper(env: Record<string, string>, detached: boolean): Promise<ChildProcess> {
  const base = { PATH: process.env.PATH ?? '/usr/bin:/bin' };
  const child = spawn('sleep', ['60'], { cwd: '/var/tmp', env: { ...base, ...env }, stdio: 'ignore', detached });
  children.push(child);
  return new Promise((resolve, reject) => {
    child.once('spawn', () => resolve(child));
    child.once('error', reject);
  });
}

after(() => {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
});

const alive = (child: ChildProcess): boolean => {
  try {
    const stat = readProcStat(child.pid!, defaultProcScanDeps());
    return isProcessAlive({ pid: child.pid!, startTicks: stat.startTicks });
  } catch { return false; }
};

describe('cleanupCodexTurnProcesses on real processes', () => {
  it('kills only the tagged same-pm_id sleep; a foreign pm_id sibling and an untagged one live', async () => {
    const tag = `pe-${randomUUID()}`;
    const launchMs = codexTurnLaunchMs();
    const target = await sleeper({ CCUI_PROCESS_TAG: tag, pm_id: SERVER_PM_ID }, true);
    const foreign = await sleeper({ CCUI_PROCESS_TAG: tag, pm_id: `${SERVER_PM_ID}-other` }, true);
    const untagged = await sleeper({ pm_id: SERVER_PM_ID }, true);
    const prefixed = await sleeper({ CCUI_PROCESS_TAG: `${tag}X`, pm_id: SERVER_PM_ID }, true);
    const own = new Set([target.pid, foreign.pid, untagged.pid, prefixed.pid]);
    const base = defaultCleanupDeps();
    const signalled: number[] = [];
    const result = await cleanupCodexTurnProcesses({ tag, launchMs }, {
      ...base,
      scan: { ...base.scan, ownPmId: SERVER_PM_ID },
      signal: (pid, sig) => {
        if (!own.has(pid)) throw new Error(`refused to signal foreign pid ${pid}`);
        signalled.push(pid);
        process.kill(pid, sig);
      },
    });
    assert.deepEqual(signalled, [target.pid]);
    assert.equal(result.outcome, 'absent');
    assert.deepEqual(result.stopped.map(proc => proc.pid), [target.pid]);
    assert.equal(alive(target), false);
    assert.equal(alive(foreign), true);
    assert.equal(alive(untagged), true);
    assert.equal(alive(prefixed), true);
  });

  it('a tagged process started before the launch mark (beyond 1 s) is not a candidate', async () => {
    const tag = `pe-${randomUUID()}`;
    const early = await sleeper({ CCUI_PROCESS_TAG: tag, pm_id: SERVER_PM_ID }, true);
    const base = defaultCleanupDeps();
    const signalled: number[] = [];
    await cleanupCodexTurnProcesses({ tag, launchMs: codexTurnLaunchMs() + 1_500 }, {
      ...base,
      scan: { ...base.scan, ownPmId: SERVER_PM_ID },
      signal: (pid) => { signalled.push(pid); },
    });
    assert.deepEqual(signalled, []);
    assert.equal(alive(early), true);
  });
});
