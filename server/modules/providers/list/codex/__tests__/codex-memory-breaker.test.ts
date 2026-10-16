/**
 * ADR-206 §3.4 (S3): the Codex memory breaker. Injected seams only: no real /proc scan,
 * no real abort of anything but an in-test AbortController. One real-process case writes
 * oom_score_adj on this test's own `sleep` child under /var/tmp.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { describe, it } from 'node:test';

import {
  BREAKER_COOLDOWN_MS,
  CodexMemoryBreaker,
  pickBreakerCulprit,
  raiseOomScoreAdj,
  readHostMemory,
  type BreakerDeps,
  type HostMemory,
} from '../codex-memory-breaker.js';
import { CODEX_BREAKER_ABORT_REASON } from '../codex-turn-cleanup.js';
import type { TaggedProcess, TaggedScanResult } from '../../../../execution-permissions/tagged-process-scan.js';

const TOTAL_KB = 10_000_000;
const memAt = (percent: number): HostMemory => ({ totalKb: TOTAL_KB, availableKb: TOTAL_KB * (1 - percent / 100) });
const procs = (...rss: number[]): TaggedProcess[] => rss.map((rssKb, index) => ({
  pid: 1000 + index + rss.length * 10, startTicks: '1', comm: 'p', rssKb,
}));

type Harness = {
  breaker: CodexMemoryBreaker;
  memory: { value: HostMemory | null };
  cpu: { value: number | null };
  trees: Map<string, TaggedProcess[]>;
  clock: { now: number };
  oom: number[];
  logs: string[];
  timers: { started: number; stopped: number };
};

function harness(): Harness {
  const h = {
    memory: { value: memAt(50) as HostMemory | null },
    cpu: { value: 10 as number | null },
    trees: new Map<string, TaggedProcess[]>(),
    clock: { now: 1_000_000 },
    oom: [] as number[],
    logs: [] as string[],
    timers: { started: 0, stopped: 0 },
  };
  const deps: BreakerDeps = {
    readMemory: () => h.memory.value,
    readCpuPercent: () => h.cpu.value,
    scan: (): TaggedScanResult => ({ byTag: h.trees, hidden: false, uncertain: false }),
    setOomScoreAdj: pid => { h.oom.push(pid); },
    now: () => h.clock.now,
    startTimer: () => { h.timers.started += 1; return () => { h.timers.stopped += 1; }; },
    log: { info: message => { h.logs.push(message); }, warn: message => { h.logs.push(message); } },
  };
  return { ...h, breaker: new CodexMemoryBreaker(deps) };
}

function turn(h: Harness, tag: string, helpers = true) {
  const controller = new AbortController();
  const handle = h.breaker.register({
    tag, launchMs: 0, helpers,
    isAborted: () => controller.signal.aborted,
    abort: reason => controller.abort(reason),
  });
  return { controller, handle };
}

const ticks = (h: Harness, count: number, stepMs = 2_000) => {
  for (let index = 0; index < count; index += 1) { h.clock.now += stepMs; h.breaker.tick(); }
};

describe('CodexMemoryBreaker trigger', () => {
  it('never kills on CPU: 100% CPU with memory below 92% for many samples', () => {
    const h = harness();
    const a = turn(h, 'a');
    h.trees.set('a', procs(5_000_000));
    h.cpu.value = 100;
    h.memory.value = memAt(91.9);
    ticks(h, 20);
    assert.equal(a.controller.signal.aborted, false);
    assert.ok(h.logs.some(line => /CPU busy/u.test(line)), 'CPU only logs a notice');
  });

  it('needs 3 consecutive samples at or above 92%; a dip resets the count', () => {
    const h = harness();
    const a = turn(h, 'a');
    h.trees.set('a', procs(2_000_000));
    h.memory.value = memAt(92);
    ticks(h, 2);
    h.memory.value = memAt(80);
    ticks(h, 1);
    h.memory.value = memAt(95);
    ticks(h, 2);
    assert.equal(a.controller.signal.aborted, false);
    ticks(h, 1);
    assert.equal(a.controller.signal.aborted, true);
    assert.equal(a.controller.signal.reason, CODEX_BREAKER_ABORT_REASON);
    assert.equal(Math.round(a.handle.breach()?.memoryPercent ?? 0), 95);
  });

  it('unreadable memory never triggers', () => {
    const h = harness();
    const a = turn(h, 'a');
    h.trees.set('a', procs(5_000_000));
    h.memory.value = null;
    ticks(h, 10);
    assert.equal(a.controller.signal.aborted, false);
  });
});

describe('CodexMemoryBreaker culprit', () => {
  it('picks the biggest tree, not the newest turn', () => {
    const h = harness();
    const older = turn(h, 'older');
    const newer = turn(h, 'newer');
    h.trees.set('older', procs(1_500_000, 900_000));
    h.trees.set('newer', procs(1_100_000));
    h.memory.value = memAt(96);
    ticks(h, 3);
    assert.equal(older.controller.signal.aborted, true);
    assert.equal(newer.controller.signal.aborted, false);
  });

  it('skips trees under 10% of host memory: log, no kill', () => {
    const h = harness();
    const a = turn(h, 'a');
    h.trees.set('a', procs(999_999));
    h.memory.value = memAt(99);
    ticks(h, 9);
    assert.equal(a.controller.signal.aborted, false);
    assert.ok(h.logs.some(line => /no delegating Codex tree/u.test(line)));
  });

  it('B = 0 turns are never targets, even when largest', () => {
    const h = harness();
    const direct = turn(h, 'direct', false);
    const helper = turn(h, 'helper', true);
    h.trees.set('direct', procs(6_000_000));
    h.trees.set('helper', procs(1_000_000));
    h.memory.value = memAt(97);
    ticks(h, 3);
    assert.equal(direct.controller.signal.aborted, false);
    assert.equal(helper.controller.signal.aborted, true);
  });

  it('pickBreakerCulprit ignores already aborted turns', () => {
    const scan = { byTag: new Map([['x', procs(5_000_000)], ['y', procs(2_000_000)]]), hidden: false, uncertain: false };
    const picked = pickBreakerCulprit([
      { tag: 'x', helpers: true, isAborted: () => true },
      { tag: 'y', helpers: true, isAborted: () => false },
    ], scan, TOTAL_KB);
    assert.equal(picked?.turn.tag, 'y');
  });
});

describe('CodexMemoryBreaker cooldown', () => {
  it('holds 30 s after an abort, then needs fresh samples', () => {
    const h = harness();
    const first = turn(h, 'first');
    const second = turn(h, 'second');
    h.trees.set('first', procs(3_000_000));
    h.trees.set('second', procs(2_000_000));
    h.memory.value = memAt(97);
    ticks(h, 3);
    assert.equal(first.controller.signal.aborted, true);
    const abortedAt = h.clock.now;
    ticks(h, 14);
    assert.ok(h.clock.now - abortedAt < BREAKER_COOLDOWN_MS);
    assert.equal(second.controller.signal.aborted, false, 'cooldown holds');
    ticks(h, 1);
    assert.ok(h.clock.now - abortedAt >= BREAKER_COOLDOWN_MS);
    assert.equal(second.controller.signal.aborted, true, 'after 30 s and >= 3 fresh samples');
  });
});

describe('CodexMemoryBreaker lifecycle and oom_score_adj', () => {
  it('sets oom_score_adj once per tagged process the sampler sees, for B = 0 turns too', () => {
    const h = harness();
    turn(h, 'a', false);
    h.trees.set('a', procs(10, 20));
    ticks(h, 3);
    assert.deepEqual(h.oom, h.trees.get('a')!.map(proc => proc.pid));
  });

  it('starts the sampler on the first turn and stops it with the last', () => {
    const h = harness();
    const a = turn(h, 'a');
    const b = turn(h, 'b');
    assert.equal(h.timers.started, 1);
    a.handle.unregister();
    assert.equal(h.timers.stopped, 0);
    b.handle.unregister();
    assert.equal(h.timers.stopped, 1);
  });

  it('raiseOomScoreAdj writes 1000 only when lower, and never on pid <= 1 or the server', () => {
    const writes: string[] = [];
    const files = (current: string) => ({ read: () => current, write: (file: string, data: string) => { writes.push(`${file}=${data}`); } });
    assert.equal(raiseOomScoreAdj(4242, files('0\n')), true);
    assert.equal(raiseOomScoreAdj(4243, files('1000\n')), true);
    assert.equal(raiseOomScoreAdj(1, files('0')), false);
    assert.equal(raiseOomScoreAdj(process.pid, files('0')), false);
    assert.deepEqual(writes, ['/proc/4242/oom_score_adj=1000']);
  });

  it('a same-uid process gets oom_score_adj 1000 without privilege (own sleep child)', async () => {
    const child = spawn('sleep', ['30'], { cwd: '/var/tmp', stdio: 'ignore' });
    try {
      await new Promise(resolve => child.once('spawn', resolve));
      assert.equal(raiseOomScoreAdj(child.pid!), true);
      assert.equal(fs.readFileSync(`/proc/${child.pid}/oom_score_adj`, 'utf8').trim(), '1000');
    } finally {
      child.kill('SIGKILL');
    }
  });

  it('readHostMemory parses /proc/meminfo and rejects nonsense', () => {
    const text = 'MemTotal:       16000000 kB\nMemFree:  1 kB\nMemAvailable:    4000000 kB\n';
    assert.deepEqual(readHostMemory(() => text), { totalKb: 16_000_000, availableKb: 4_000_000 });
    assert.equal(readHostMemory(() => 'MemTotal: 0 kB\n'), null);
    assert.equal(readHostMemory(() => { throw new Error('EACCES'); }), null);
  });
});
