/**
 * ADR-206 §6 (S4): strict candidate rule, identity re-verification and outcome mapping for
 * the Codex abort-path cleanup. Fake /proc only: nothing real is read or signalled.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  CODEX_BREAKER_ABORT_REASON,
  CODEX_CLEANUP_RESCAN_ROUNDS,
  cleanupCodexTurnProcesses,
  codexFallbackRunTag,
  codexStoppedProcessesNotice,
  decideCodexTurnCleanup,
  mapCodexStartedOutcome,
} from '../codex-turn-cleanup.js';
import { scanTaggedProcesses } from '../../../../execution-permissions/tagged-process-scan.js';
import { FakeProcFs, GOD_PID, SERVER_PID, msToTicks, ticksToMs } from './fake-proc.js';

const TAG = 'pe-7a6b5c4d-3e2f-4a1b-9c8d-7e6f5a4b3c2d';
const PAIR = `CCUI_PROCESS_TAG=${TAG}`;
const LAUNCH_MS = ticksToMs(5_000);
const AFTER = msToTicks(LAUNCH_MS) + 50;

const run = (fs: FakeProcFs) => cleanupCodexTurnProcesses({ tag: TAG, launchMs: LAUNCH_MS }, fs.cleanupDeps());
const signalled = (fs: FakeProcFs) => fs.signals.map(entry => `${entry.sig}:${entry.pid}`);

describe('decideCodexTurnCleanup (§6 when)', () => {
  const base = {
    effectAttempted: true, succeeded: false, aborted: false, abortReason: undefined,
    errored: false, completedReply: false,
  };
  it('never cleans up after a successful turn, even with a late abort signal', () => {
    assert.equal(decideCodexTurnCleanup({ ...base, succeeded: true }), null);
    assert.equal(decideCodexTurnCleanup({ ...base, succeeded: true, aborted: true }), null);
  });
  it('an error after the first completed reply does not clean up', () => {
    assert.equal(decideCodexTurnCleanup({ ...base, errored: true, completedReply: true }), null);
  });
  it('an error before the first completed reply cleans up', () => {
    assert.equal(decideCodexTurnCleanup({ ...base, errored: true }), 'error');
  });
  it('user stop and breaker always clean up, even after a completed reply', () => {
    assert.equal(decideCodexTurnCleanup({ ...base, aborted: true, completedReply: true }), 'user_abort');
    assert.equal(decideCodexTurnCleanup({
      ...base, aborted: true, abortReason: CODEX_BREAKER_ABORT_REASON, completedReply: true,
    }), 'breaker');
  });
  it('nothing to clean before the SDK effect seam', () => {
    assert.equal(decideCodexTurnCleanup({ ...base, effectAttempted: false, aborted: true }), null);
  });
});

describe('mapCodexStartedOutcome (§3.4)', () => {
  const absent = { outcome: 'absent' as const, stopped: [] };
  it('abort with every survivor gone settles cancelled', () => {
    assert.equal(mapCodexStartedOutcome({ aborted: true, failed: true, cleanup: absent }), 'cancelled');
  });
  for (const outcome of ['hidden', 'uncertain', 'present'] as const) {
    it(`cleanup ${outcome} settles reconciled_unknown (fence path)`, () => {
      assert.equal(mapCodexStartedOutcome({ aborted: true, failed: false, cleanup: { outcome, stopped: [] } }),
        'reconciled_unknown');
      assert.equal(mapCodexStartedOutcome({ aborted: false, failed: true, cleanup: { outcome, stopped: [] } }),
        'reconciled_unknown');
    });
  }
  it('no cleanup keeps today\'s mapping', () => {
    assert.equal(mapCodexStartedOutcome({ aborted: false, failed: true, cleanup: null }), 'failed');
    assert.equal(mapCodexStartedOutcome({ aborted: false, failed: false, cleanup: null }), 'succeeded');
  });
});

describe('strict candidate rule (§6 rules 1-6)', () => {
  it('kills only the exact pair: a longer tag with the same prefix and a prefixed key survive', async () => {
    const fs = new FakeProcFs()
      .add({ pid: 601, ppid: SERVER_PID, comm: 'codex', startTicks: AFTER, env: [PAIR, 'pm_id=4'] })
      .add({ pid: 602, ppid: 1, comm: 'sleep', startTicks: AFTER, env: [`${PAIR}X`] })
      .add({ pid: 603, ppid: 1, comm: 'sleep', startTicks: AFTER, env: [`X${PAIR}`] })
      .add({ pid: 604, ppid: 1, comm: 'sleep', startTicks: AFTER, env: [`CCUI_PROCESS_TAG=${TAG.slice(0, -1)}`] });
    const result = await run(fs);
    assert.deepEqual(signalled(fs), ['SIGTERM:601']);
    assert.deepEqual(result, { outcome: 'absent', stopped: [{ pid: 601, comm: 'codex' }] });
  });

  it('another uid and a process started before launch - 1 s are never candidates', async () => {
    const fs = new FakeProcFs()
      .add({ pid: 610, ppid: 1, uid: 1001, startTicks: AFTER, env: [PAIR] })
      .add({ pid: 611, ppid: 1, startTicks: msToTicks(LAUNCH_MS) - 101, env: [PAIR] })
      .add({ pid: 612, ppid: 1, comm: 'edge', startTicks: msToTicks(LAUNCH_MS) - 100, env: [PAIR] });
    await run(fs);
    assert.deepEqual(signalled(fs), ['SIGTERM:612'], 'only the one inside the 1 s btime slack');
  });

  it('a tagged orphan reparented to init (same uid, after launch) is killed', async () => {
    const fs = new FakeProcFs().add({ pid: 620, ppid: 1, comm: 'sleep', startTicks: AFTER, env: [PAIR, 'pm_id=4'] });
    const result = await run(fs);
    assert.deepEqual(signalled(fs), ['SIGTERM:620']);
    assert.equal(result.outcome, 'absent');
  });

  it('a pm2 app carrying the tag is never killed: foreign pm_id, or God-daemon ancestry', async () => {
    const fs = new FakeProcFs()
      .add({ pid: 630, ppid: 1, comm: 'app', startTicks: AFTER, env: [PAIR, 'pm_id=9'] })
      .add({ pid: 631, ppid: GOD_PID, comm: 'app2', startTicks: AFTER, env: [PAIR, 'pm_id=4'] })
      .add({ pid: 632, ppid: 631, comm: 'worker', startTicks: AFTER, env: [PAIR] })
      .add({ pid: 633, ppid: 1, comm: 'PM2 v6.0.0: God', startTicks: AFTER, env: [PAIR] })
      .add({ pid: 634, ppid: 633, comm: 'app3', startTicks: AFTER, env: [PAIR] });
    const result = await run(fs);
    assert.deepEqual(signalled(fs), []);
    assert.equal(result.outcome, 'absent', 'excluded pm2 processes are not the turn\'s');
  });

  it('a server-tree descendant under the God daemon is still a candidate (server reached first)', async () => {
    const fs = new FakeProcFs()
      .add({ pid: 640, ppid: SERVER_PID, comm: 'codex', startTicks: AFTER, env: [PAIR, 'pm_id=4'] })
      .add({ pid: 641, ppid: 640, comm: 'bash', startTicks: AFTER, env: [PAIR, 'pm_id=4'] });
    await run(fs);
    assert.deepEqual(signalled(fs), ['SIGTERM:640', 'SIGTERM:641']);
  });

  it('the server, its ancestors and the God daemon are never targeted, even when tagged', async () => {
    const fs = new FakeProcFs();
    fs.procs.get(SERVER_PID)!.env = [PAIR, 'pm_id=4'];
    fs.procs.get(SERVER_PID)!.startTicks = AFTER;
    fs.procs.get(GOD_PID)!.env = [PAIR];
    fs.procs.get(GOD_PID)!.startTicks = AFTER;
    fs.daemonPids = [];
    fs.add({ pid: 450, ppid: 1, comm: 'tini', startTicks: AFTER, env: [PAIR] });
    fs.procs.get(GOD_PID)!.ppid = 450;
    await run(fs);
    assert.deepEqual(signalled(fs), []);
  });

  it('an unreadable environ is hidden: not killed, and the outcome is not absent', async () => {
    const fs = new FakeProcFs()
      .add({ pid: 650, ppid: 1, comm: 'agent', startTicks: AFTER, hiddenEnviron: true })
      .add({ pid: 651, ppid: SERVER_PID, comm: 'codex', startTicks: AFTER, env: [PAIR] });
    const result = await run(fs);
    assert.deepEqual(signalled(fs), ['SIGTERM:651']);
    assert.equal(result.outcome, 'hidden');
    assert.equal(mapCodexStartedOutcome({ aborted: true, failed: false, cleanup: result }), 'reconciled_unknown');
  });

  it('the scan returns pids with RSS for the breaker and skips zombies', () => {
    const fs = new FakeProcFs()
      .add({ pid: 660, ppid: SERVER_PID, startTicks: AFTER, env: [PAIR], rssKb: 300 })
      .add({ pid: 661, ppid: 660, startTicks: AFTER, env: [PAIR], rssKb: 700 })
      .add({ pid: 662, ppid: 660, startTicks: AFTER, env: [PAIR], rssKb: 900, state: 'Z' });
    const scan = scanTaggedProcesses([{ tag: TAG, notBeforeMs: LAUNCH_MS }], fs.deps());
    assert.deepEqual(scan.byTag.get(TAG)?.map(proc => [proc.pid, proc.rssKb]), [[660, 300], [661, 700]]);
  });
});

describe('signals and identity (§6 action)', () => {
  it('SIGKILLs a survivor after the 5 s grace, re-verified as itself', async () => {
    const fs = new FakeProcFs().add({ pid: 700, ppid: 1, comm: 'stubborn', startTicks: AFTER, env: [PAIR] });
    fs.onSignal = (pid, sig, proc) => { if (sig === 'SIGKILL') proc.procs.delete(pid); };
    const result = await run(fs);
    assert.deepEqual(signalled(fs), ['SIGTERM:700', 'SIGKILL:700']);
    assert.deepEqual(result, { outcome: 'absent', stopped: [{ pid: 700, comm: 'stubborn' }] });
  });

  it('pid reuse between SIGTERM and SIGKILL: the new process is never SIGKILLed', async () => {
    const fs = new FakeProcFs().add({ pid: 710, ppid: 1, comm: 'old', startTicks: AFTER, env: [PAIR] });
    fs.onSignal = (pid, sig, proc) => {
      if (sig === 'SIGTERM') proc.add({ pid, ppid: 1, comm: 'reused', startTicks: AFTER + 7, env: [PAIR, 'pm_id=9'] });
    };
    await run(fs);
    assert.deepEqual(signalled(fs), ['SIGTERM:710']);
    assert.equal(fs.procs.get(710)?.comm, 'reused', 'the newcomer is untouched');
  });

  it('pid reuse at the SIGKILL re-verification (after the grace) is refused', async () => {
    const fs = new FakeProcFs().add({ pid: 715, ppid: 1, comm: 'old', startTicks: AFTER, env: [PAIR] });
    fs.onSignal = () => {};
    const deps = fs.cleanupDeps();
    const graceEnd = fs.clock + 5_000;
    deps.scan = { ...deps.scan, readFile: (file: string) => {
      // The reused pid belongs to a pm2 app (foreign pm_id), so the rescan never adopts it
      // either; only the start-ticks re-verification stands between it and SIGKILL.
      if (file === '/proc/715/status' && fs.clock >= graceEnd && fs.procs.get(715)?.comm === 'old') {
        fs.add({ pid: 715, ppid: 1, comm: 'reused', startTicks: AFTER + 7, env: [PAIR, 'pm_id=9'] });
      }
      return fs.readFile(file);
    } };
    await cleanupCodexTurnProcesses({ tag: TAG, launchMs: LAUNCH_MS }, deps);
    assert.deepEqual(signalled(fs), ['SIGTERM:715'], 'no SIGKILL to the newcomer');
  });

  it('pid reuse before SIGTERM (start ticks changed after the scan) is refused', async () => {
    const fs = new FakeProcFs().add({ pid: 720, ppid: 1, startTicks: AFTER, env: [PAIR] });
    const deps = fs.cleanupDeps();
    const realRead = fs.readFile;
    let statReads = 0;
    deps.scan = { ...deps.scan, readFile: (file: string) => {
      // The reused pid is a pm2 app (foreign pm_id), so the rescan never adopts it either.
      if (file === '/proc/720/stat' && ++statReads > 1) Object.assign(fs.procs.get(720)!, { startTicks: AFTER + 3, env: [PAIR, 'pm_id=9'] });
      return realRead(file);
    } };
    await cleanupCodexTurnProcesses({ tag: TAG, launchMs: LAUNCH_MS }, deps);
    assert.deepEqual(signalled(fs), []);
  });

  it('a process that survives SIGKILL makes the outcome present (reconciled_unknown)', async () => {
    const fs = new FakeProcFs().add({ pid: 730, ppid: 1, comm: 'D-state', startTicks: AFTER, env: [PAIR] });
    fs.onSignal = () => {};
    const result = await run(fs);
    assert.deepEqual(signalled(fs), ['SIGTERM:730', 'SIGKILL:730']);
    assert.equal(result.outcome, 'present');
    assert.deepEqual(result.stopped, []);
    assert.equal(mapCodexStartedOutcome({ aborted: true, failed: false, cleanup: result }), 'reconciled_unknown');
  });

  it('rescans after the grace: a tagged newcomer forked during SIGTERM is stopped too', async () => {
    const fs = new FakeProcFs().add({ pid: 800, ppid: 1, comm: 'codex', startTicks: AFTER, env: [PAIR] });
    fs.onSignal = (pid, sig, proc) => {
      proc.procs.delete(pid);
      if (pid === 800 && sig === 'SIGTERM') proc.add({ pid: 801, ppid: 1, comm: 'child', startTicks: AFTER + 5, env: [PAIR] });
    };
    const result = await run(fs);
    assert.deepEqual(signalled(fs), ['SIGTERM:800', 'SIGTERM:801']);
    assert.equal(result.outcome, 'absent', 'no needless reconciled_unknown fence');
    assert.deepEqual(result.stopped.map(proc => proc.pid), [800, 801]);
  });

  it('a newcomer that ignores SIGTERM is SIGKILLed in its round, with identity re-verified', async () => {
    const fs = new FakeProcFs().add({ pid: 810, ppid: 1, comm: 'codex', startTicks: AFTER, env: [PAIR] });
    fs.onSignal = (pid, sig, proc) => {
      if (pid === 810) {
        proc.procs.delete(pid);
        proc.add({ pid: 811, ppid: 1, comm: 'stubborn', startTicks: AFTER + 5, env: [PAIR] });
      } else if (sig === 'SIGKILL') proc.procs.delete(pid);
    };
    const result = await run(fs);
    assert.deepEqual(signalled(fs), ['SIGTERM:810', 'SIGTERM:811', 'SIGKILL:811']);
    assert.equal(result.outcome, 'absent');
  });

  it('the rescan is bounded: a process that keeps forking ends in present, not a loop', async () => {
    let next = 900;
    const fs = new FakeProcFs().add({ pid: next, ppid: 1, startTicks: AFTER, env: [PAIR] });
    fs.onSignal = (pid, _sig, proc) => {
      proc.procs.delete(pid);
      next += 1;
      proc.add({ pid: next, ppid: 1, startTicks: AFTER + next, env: [PAIR] });
    };
    const result = await run(fs);
    assert.equal(fs.signals.filter(entry => entry.sig === 'SIGTERM').length, 1 + CODEX_CLEANUP_RESCAN_ROUNDS);
    assert.equal(result.outcome, 'present');
  });

  it('an unreadable /proc yields uncertain, never absent', async () => {
    const fs = new FakeProcFs();
    const deps = fs.cleanupDeps();
    deps.scan = { ...deps.scan, listPids: () => { throw new Error('EMFILE'); } };
    const result = await cleanupCodexTurnProcesses({ tag: TAG, launchMs: LAUNCH_MS }, deps);
    assert.equal(result.outcome, 'uncertain');
  });
});

describe('tag uniqueness (§6, qa condition 5)', () => {
  it('N concurrent fallback tags are distinct random UUIDs', () => {
    const tags = Array.from({ length: 500 }, () => codexFallbackRunTag());
    assert.equal(new Set(tags).size, tags.length);
    for (const tag of tags) assert.match(tag, /^codex-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
  });
});

describe('user notice', () => {
  it('names the stopped processes and the breaker memory level', () => {
    const text = codexStoppedProcessesNotice('breaker', {
      outcome: 'absent', stopped: [{ pid: 7, comm: 'node' }, { pid: 8, comm: 'sleep' }],
    }, { memoryPercent: 93.4 });
    assert.match(text, /قاطع الذاكرة/u);
    assert.match(text, /93%/u);
    assert.match(text, /node \(7\)، sleep \(8\)/u);
  });
});
