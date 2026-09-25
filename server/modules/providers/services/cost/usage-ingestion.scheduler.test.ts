import assert from 'node:assert/strict';
import test from 'node:test';

import {
  UsageIngestionScheduler,
  usageIngestBackfillEnabled,
} from './usage-ingestion.scheduler.js';
import type { ConversationIngestOutcome, IngestContext } from './usage-ingestion.service.js';

const context = (manifest?: IngestContext['manifest']): IngestContext => ({
  sessionId: 'session-1', provider: 'claude', transcriptPath: '/disk/root.jsonl', manifest,
});
const done = (caughtUp = true): ConversationIngestOutcome => ({
  skipped: false, caughtUp, ingestComplete: caughtUp, eventsWritten: 1, madeProgress: false,
});

test('writer/backfill flags fail closed and off scheduling is a permanent no-op', async () => {
  const previous = process.env.USAGE_INGEST_BACKFILL;
  try {
    delete process.env.USAGE_INGEST_BACKFILL;
    assert.equal(usageIngestBackfillEnabled(), false);
    let calls = 0;
    const scheduler = new UsageIngestionScheduler({
      writerMode: () => 'off',
      resolveContext: async () => context(),
      ingest: async () => { calls += 1; return done(); },
    });
    assert.equal(await scheduler.schedule({ provider: 'claude', filePath: '/disk/root.jsonl' }), null);
    assert.equal(calls, 0);
  } finally {
    if (previous === undefined) delete process.env.USAGE_INGEST_BACKFILL;
    else process.env.USAGE_INGEST_BACKFILL = previous;
  }
});

test('scheduler activity invokes lazy v3 maintenance while off mode performs no writes', async () => {
  let maintenanceCalls = 0;
  const on = new UsageIngestionScheduler({ writerMode: () => 'on', maintenance: () => { maintenanceCalls += 1; },
    resolveContext: async () => context(), ingest: async () => done() });
  await on.schedule({ provider: 'claude', filePath: '/disk/root.jsonl' });
  assert.equal(maintenanceCalls, 1);
  const off = new UsageIngestionScheduler({ writerMode: () => 'off', maintenance: () => { maintenanceCalls += 1; } });
  assert.equal(await off.schedule({ provider: 'claude', filePath: '/disk/root.jsonl' }), null);
  assert.equal(maintenanceCalls, 1);
});

test('concurrent changes coalesce into one running pass plus one dirty pass', async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let calls = 0;
  let resolutions = 0;
  const scheduler = new UsageIngestionScheduler({
    writerMode: () => 'on', retryDelayMs: 0,
    resolveContext: async () => { resolutions += 1; return context(); },
    ingest: async () => { calls += 1; if (calls === 1) await gate; return done(); },
  });
  const first = scheduler.schedule({ provider: 'claude', filePath: '/disk/root.jsonl' });
  await new Promise<void>((resolve) => setImmediate(resolve));
  const second = scheduler.schedule({ provider: 'claude', filePath: '/disk/root.jsonl' });
  const third = scheduler.schedule({ provider: 'claude', filePath: '/disk/root.jsonl' });
  release();
  await Promise.all([first, second, third]);
  assert.equal(calls, 2);
  assert.equal(resolutions, 2, 'one initial resolve plus one refresh for the coalesced dirty pass');
});

test('schedule defers context resolution beyond the caller hot path', async () => {
  let order = '';
  const scheduler = new UsageIngestionScheduler({
    writerMode: () => 'on',
    resolveContext: async () => { order += 'resolve'; return context(); },
    ingest: async () => done(),
  });
  order += 'before;';
  const scheduled = scheduler.schedule({ provider: 'claude', filePath: '/disk/root.jsonl' });
  order += 'after;';
  assert.equal(order, 'before;after;', 'schedule itself performs no session scan/manifest work');
  await scheduled;
  assert.equal(order, 'before;after;resolve');
});

test('partial no-progress is bounded and only a later watcher event retries it', async () => {
  let calls = 0;
  const scheduler = new UsageIngestionScheduler({
    writerMode: () => 'on', retryDelayMs: 0,
    resolveContext: async () => context(),
    ingest: async () => {
      calls += 1;
      if (calls === 1) throw new Error('temporary');
      return done(calls >= 3);
    },
  });
  const partial = await scheduler.schedule({ provider: 'claude', filePath: '/disk/root.jsonl' });
  assert.equal(partial?.caughtUp, false);
  assert.equal(calls, 2, 'one retry for the error, then stop on partial/no-progress');
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(calls, 2, 'no autonomous dirty loop spins on the partial record');
  const completed = await scheduler.schedule({ provider: 'claude', filePath: '/disk/root.jsonl' });
  assert.equal(completed?.caughtUp, true);
  assert.equal(calls, 3);
});

test('writer transient failures stop after exactly three attempts', async () => {
  let calls = 0;
  const scheduler = new UsageIngestionScheduler({
    writerMode: () => 'on', retryDelayMs: 0,
    resolveContext: async () => context(),
    ingest: async () => { calls += 1; throw new Error('transient-writer-failure'); },
    recordFailure: () => {},
  });
  await assert.rejects(
    scheduler.schedule({ provider: 'claude', filePath: '/disk/retry.jsonl' }),
    /transient-writer-failure/,
  );
  assert.equal(calls, 3, 'the retry budget is three total writer attempts');
});

test('late child dirties the root and refreshes context before the second pass', async () => {
  let version = 1;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const observed: number[] = [];
  let calls = 0;
  const scheduler = new UsageIngestionScheduler({
    writerMode: () => 'on', retryDelayMs: 0,
    resolveContext: async () => ({ ...context(), parserVersion: version }),
    ingest: async (value) => {
      calls += 1;
      observed.push(value.parserVersion!);
      if (calls === 1) await gate;
      return done();
    },
  });
  const first = scheduler.schedule({ provider: 'claude', filePath: '/disk/root.jsonl' });
  await new Promise<void>((resolve) => setImmediate(resolve));
  version = 2;
  const child = scheduler.schedule({ provider: 'claude', filePath: '/disk/root/child.jsonl' });
  release();
  await Promise.all([first, child]);
  assert.deepEqual(observed, [1, 2]);
});

test('two child paths with one known session coalesce before context resolution', async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let resolutions = 0;
  let ingests = 0;
  const scheduler = new UsageIngestionScheduler({
    writerMode: () => 'on',
    resolveContext: async () => { resolutions += 1; return context(); },
    ingest: async () => { ingests += 1; if (ingests === 1) await gate; return done(); },
  });
  const first = scheduler.schedule({
    provider: 'claude', filePath: '/disk/root/child-a.jsonl', sessionId: 'shared',
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  const second = scheduler.schedule({
    provider: 'claude', filePath: '/disk/root/child-b.jsonl', sessionId: 'shared',
  });
  release();
  await Promise.all([first, second]);
  assert.equal(resolutions, 2, 'initial resolve plus one dirty refresh, never one resolve per path event');
  assert.equal(ingests, 2);
});

test('resolve failure records telemetry when request session identity is known', async () => {
  const failures: Array<{ sessionId: string | null; key: string }> = [];
  const scheduler = new UsageIngestionScheduler({
    writerMode: () => 'on', retryDelayMs: 0,
    resolveContext: async () => { throw new Error('resolver failed'); },
    ingest: async () => done(),
    recordFailure: (sessionId, key) => { failures.push({ sessionId, key }); },
  });
  await assert.rejects(scheduler.schedule({
    provider: 'codex', filePath: '/disk/root.jsonl', sessionId: 'known-session',
  }), /resolver failed/);
  assert.deepEqual(failures, [{ sessionId: 'known-session', key: 'codex:session:known-session' }]);
});

test('progressing multi-chunk work returns to the FIFO tail before continuing', async () => {
  const order: string[] = [];
  const passes = new Map<string, number>();
  const scheduler = new UsageIngestionScheduler({
    writerMode: () => 'on', concurrency: 1,
    resolveContext: async (request) => ({
      sessionId: request.sessionId!, provider: 'claude', transcriptPath: request.filePath,
    }),
    ingest: async (value) => {
      order.push(value.sessionId);
      const count = (passes.get(value.sessionId) ?? 0) + 1;
      passes.set(value.sessionId, count);
      return value.sessionId === 'large' && count === 1
        ? { ...done(false), madeProgress: true, eventsWritten: 4 }
        : value.sessionId === 'large' ? { ...done(true), eventsWritten: 6 } : done(true);
    },
  });
  const large = scheduler.schedule({ provider: 'claude', filePath: '/large', sessionId: 'large' });
  const small = scheduler.schedule({ provider: 'claude', filePath: '/small', sessionId: 'small' });
  const [largeOutcome] = await Promise.all([large, small]);
  assert.deepEqual(order, ['large', 'small', 'large']);
  assert.equal(largeOutcome?.eventsWritten, 10, 'backfill receives the cumulative count from every chunk pass');
});


test('local admission denial retains ingestion and retries after OPEN without another file event', async () => {
  const { setApplicationWriterGateForTests } = await import('../../../../services/update-writer-lease.js');
  const previousMode = process.env.NASSAJ_UPDATE_MODE, previousEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = 'test'; process.env.NASSAJ_UPDATE_MODE = 'local-main';
  let closed = true, resolved = 0, writes = 0, failures = 0;
  setApplicationWriterGateForTests({ async acquireWriterLease() {
    if (closed) throw new Error('update_maintenance_active');
    return { release() {} };
  } });
  const scheduler = new UsageIngestionScheduler({ writerMode: () => 'on',
    resolveContext: async () => { resolved++; return context(); },
    ingest: async () => { writes++; return done(); }, recordFailure: () => { failures++; },
  });
  try {
    const pending = scheduler.schedule({ provider: 'claude', filePath: '/disk/root.jsonl' });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(resolved, 0); assert.equal(writes, 0); assert.equal(failures, 0);
    closed = false;
    await pending;
    assert.equal(writes, 1); assert.equal(failures, 0);
  } finally {
    scheduler.close(); setApplicationWriterGateForTests(null);
    if (previousMode === undefined) delete process.env.NASSAJ_UPDATE_MODE; else process.env.NASSAJ_UPDATE_MODE = previousMode;
    if (previousEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = previousEnv;
  }
});

test('a contended lock is deferred, while a control-plane fault rejects instead of looping', async () => {
  const { setApplicationWriterGateForTests } = await import('../../../../services/update-writer-lease.js');
  const previousMode = process.env.NASSAJ_UPDATE_MODE, previousEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = 'test'; process.env.NASSAJ_UPDATE_MODE = 'local-main';
  // What a real concurrent update raises. The private list this replaced waited
  // on `update_lock_timeout` — a code the gate never raises — so this exact
  // case rejected the job rather than retrying it.
  let code: string | null = 'update_lock_contended', writes = 0, failures = 0;
  setApplicationWriterGateForTests({ async acquireWriterLease() {
    if (code) throw new Error(code);
    return { release() {} };
  } });
  const scheduler = new UsageIngestionScheduler({ writerMode: () => 'on',
    resolveContext: async () => context(),
    ingest: async () => { writes++; return done(); }, recordFailure: () => { failures++; },
  });
  try {
    const deferred = scheduler.schedule({ provider: 'claude', filePath: '/disk/root.jsonl' });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(writes, 0, 'a contended lock must not be treated as a failure');
    code = null;
    await deferred;
    assert.equal(writes, 1); assert.equal(failures, 0);

    // A fault never heals by waiting: retrying it for ever would hide a broken
    // control plane behind a job that simply never completes.
    code = 'update_journal_invalid';
    await assert.rejects(
      scheduler.schedule({ provider: 'claude', filePath: '/disk/other.jsonl', sessionId: 'other' }),
      (error: Error) => error.message === 'update_journal_invalid',
    );
  } finally {
    scheduler.close(); setApplicationWriterGateForTests(null);
    if (previousMode === undefined) delete process.env.NASSAJ_UPDATE_MODE; else process.env.NASSAJ_UPDATE_MODE = previousMode;
    if (previousEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = previousEnv;
  }
});

/**
 * B-1253 M-4 — a transient gate refusal is waited out, but only for a BOUNDED
 * time.
 *
 * The loop this replaced was `while (!this.closed)` with a fixed 1s sleep, no
 * counter and no backoff. A holder that never releases the flock — a SIGSTOPped
 * process, a pattern actually used on this fleet to save quota — kept it
 * spinning for ever while `this.active` stayed raised, so the concurrency slots
 * leaked one at a time until ALL usage ingestion stopped, silently. The clock
 * is injected here so the schedule is proven without any real waiting.
 */
async function withStoppedGate(
  body: (harness: { sleeps: number[]; setClosed: (value: boolean) => void }) => Promise<void>,
  code = 'update_lock_contended',
): Promise<void> {
  const { setApplicationWriterGateForTests } = await import('../../../../services/update-writer-lease.js');
  const previousMode = process.env.NASSAJ_UPDATE_MODE, previousEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = 'test'; process.env.NASSAJ_UPDATE_MODE = 'local-main';
  let closed = true;
  const sleeps: number[] = [];
  setApplicationWriterGateForTests({ async acquireWriterLease() {
    if (closed) throw new Error(code);
    return { release() {} };
  } } as never);
  try {
    await body({ sleeps, setClosed: (value: boolean) => { closed = value; } });
  } finally {
    setApplicationWriterGateForTests(null as never);
    if (previousMode === undefined) delete process.env.NASSAJ_UPDATE_MODE; else process.env.NASSAJ_UPDATE_MODE = previousMode;
    if (previousEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = previousEnv;
  }
}

test('B-1253: a stuck lock holder exhausts a BOUNDED budget instead of spinning for ever', async () => {
  await withStoppedGate(async ({ sleeps }) => {
    const errors: unknown[][] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => { errors.push(args); };
    let ingests = 0;
    const scheduler = new UsageIngestionScheduler({
      writerMode: () => 'on',
      resolveContext: async () => context(),
      ingest: async () => { ingests += 1; return done(); },
      recordFailure: () => {},
      gateBaseDelayMs: 10,
      gateMaxDelayMs: 40,
      gateMaxWaits: 5,
      sleep: async (ms: number) => { sleeps.push(ms); },
    });
    try {
      // The gate NEVER reopens — the SIGSTOPped-holder scenario.
      await assert.rejects(
        scheduler.schedule({ provider: 'claude', filePath: '/disk/root.jsonl' }) as Promise<unknown>,
        /gave up waiting for the update gate after 5 attempts/,
        'the job must END, not wait for ever',
      );
      assert.equal(ingests, 0, 'nothing was ingested behind a closed gate');
      assert.deepEqual(sleeps, [10, 20, 40, 40, 40],
        'exponential up to the cap, then flat at the cap — never unbounded and never a busy loop');
      const audible = errors.filter((line) => String(line[0]).includes('usage-ingestion-gate-wait-exhausted'));
      assert.equal(audible.length, 1, 'the give-up is logged exactly once — silence is what made this undiagnosable');
    } finally {
      console.error = originalError;
      scheduler.close();
    }
  });
});

test('B-1253: the ingestion slot is RELEASED when the budget is exhausted, so later jobs still run', async () => {
  await withStoppedGate(async ({ sleeps, setClosed }) => {
    const originalError = console.error;
    console.error = () => {};
    let ingests = 0;
    const scheduler = new UsageIngestionScheduler({
      writerMode: () => 'on',
      concurrency: 1,
      resolveContext: async () => context(),
      ingest: async () => { ingests += 1; return done(); },
      recordFailure: () => {},
      gateBaseDelayMs: 1, gateMaxDelayMs: 1, gateMaxWaits: 2,
      sleep: async (ms: number) => { sleeps.push(ms); },
    });
    try {
      await assert.rejects(
        scheduler.schedule({ provider: 'claude', filePath: '/disk/a.jsonl', sessionId: 'a' }) as Promise<unknown>,
        /gave up waiting/,
      );
      // THE REGRESSION: with the old spin, `this.active` stayed raised and the
      // single slot was gone for good — every later job queued behind a job
      // that would never finish.
      setClosed(false);
      const outcome = await scheduler.schedule({ provider: 'claude', filePath: '/disk/b.jsonl', sessionId: 'b' });
      assert.ok(outcome, 'a later job still runs: the slot was given back');
      assert.equal(ingests, 1);
    } finally {
      console.error = originalError;
      scheduler.close();
    }
  });
});

test('B-1253: a NON-deferrable gate fault still rejects immediately, with no waiting at all', async () => {
  await withStoppedGate(async ({ sleeps }) => {
    const scheduler = new UsageIngestionScheduler({
      writerMode: () => 'on',
      resolveContext: async () => context(),
      ingest: async () => done(),
      recordFailure: () => {},
      sleep: async (ms: number) => { sleeps.push(ms); },
    });
    try {
      await assert.rejects(
        scheduler.schedule({ provider: 'claude', filePath: '/disk/root.jsonl' }) as Promise<unknown>,
        /update_journal_invalid/,
        'a corrupt journal is a fault: it reaches the caller unchanged, never a "gave up waiting" message',
      );
      assert.deepEqual(sleeps, [], 'a fault is not retried even once');
    } finally {
      scheduler.close();
    }
  }, 'update_journal_invalid');
});

test('B-1253: a gate that reopens within budget still succeeds, after backing off', async () => {
  await withStoppedGate(async ({ sleeps, setClosed }) => {
    let ingests = 0;
    const scheduler = new UsageIngestionScheduler({
      writerMode: () => 'on',
      resolveContext: async () => context(),
      ingest: async () => { ingests += 1; return done(); },
      recordFailure: () => {},
      gateBaseDelayMs: 5, gateMaxDelayMs: 100, gateMaxWaits: 10,
      // The maintenance window ends during the third wait.
      sleep: async (ms: number) => { sleeps.push(ms); if (sleeps.length === 3) setClosed(false); },
    });
    try {
      const outcome = await scheduler.schedule({ provider: 'claude', filePath: '/disk/root.jsonl' });
      assert.ok(outcome, 'the deferral still does its job: the work is not lost');
      assert.equal(ingests, 1);
      assert.deepEqual(sleeps, [5, 10, 20], 'and it backed off while waiting');
    } finally {
      scheduler.close();
    }
  });
});
