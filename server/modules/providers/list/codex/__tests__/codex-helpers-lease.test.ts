/**
 * ADR-206 S2 (§3.2, §3.3): the memory check for the per-turn helpers switch and its
 * accounting-only lease in `turn_resource_leases`.
 *
 * Proves: own lease excluded from own check (79% alone → helpers); 79/80 boundary; the
 * read-time age rule (orphan 9% lease older than 120 s counts 0); monotone reserve (a child
 * that exits does not bring it back); BEGIN IMMEDIATE visibility between two connections;
 * no refusal path (DB/lease failure → B = 0); H5 exit proofs and the six leak scenarios.
 *
 * Runner: node scripts/run-isolated-node-tests.mjs server <this file>
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import Database from 'better-sqlite3';

// eslint-disable-next-line boundaries/dependencies -- the real strict scan, run over the in-memory /proc
import { scanTaggedProcesses, type TaggedScanResult, type TaggedScanTarget } from '@/modules/execution-permissions/tagged-process-scan.js';
// eslint-disable-next-line boundaries/dependencies -- turn-supervisor has no barrel
import { CODEX_LEASE_MAX_AGE_MS, sumCodexSdkLeaseMemory } from '@/modules/turn-supervisor/resource-admission.js';

import { decideCodexHelpers } from '../codex-helpers-switch.js';
import {
  CODEX_LEASE_STALE_MS,
  CODEX_TURN_RESERVE_PERCENT,
  CodexHelpersLeases,
  codexLeaseExitProof,
  codexLeaseOwnerId,
  codexUnrealisedReserve,
  type CodexLeaseDeps,
  type CodexLeaseEnd,
} from '../codex-helpers-lease.js';

import { FakeProcFs, SERVER_PID, msToTicks, ticksToMs } from './fake-proc.js';

const SCHEMA = `CREATE TABLE IF NOT EXISTS turn_resource_leases (
  lease_id TEXT PRIMARY KEY, turn_id TEXT NOT NULL, user_id INTEGER NOT NULL,
  owner_id TEXT NOT NULL, owner_pid INTEGER NOT NULL CHECK (owner_pid > 0),
  cpu_reserved REAL NOT NULL CHECK (cpu_reserved >= 0),
  memory_reserved REAL NOT NULL CHECK (memory_reserved >= 0),
  status TEXT NOT NULL DEFAULT 'active', created_at_ms INTEGER NOT NULL,
  heartbeat_at_ms INTEGER NOT NULL, exit_proof_at_ms INTEGER, exit_proof_kind TEXT,
  released_at_ms INTEGER,
  CHECK (status = 'active' OR (exit_proof_at_ms IS NOT NULL AND released_at_ms IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS one_active_turn ON turn_resource_leases(turn_id) WHERE status = 'active';`;

const TOTAL_KB = 1_000_000; // 1% of host = 10_000 kB

/** The /proc clock runs this far behind the wall clock (drift since boot), as on a real host. */
const PROC_OFFSET_MS = 3_000;
const START_WALL_MS = ticksToMs(10_000) + PROC_OFFSET_MS;

/**
 * The host: wall clock, memory, and an in-memory /proc scanned by the REAL strict scan, so
 * `hidden` and `notBeforeMs` behave exactly as on a host (start-time filtered per target).
 */
type Host = {
  now: number;
  memoryPercent: number;
  fsx: FakeProcFs;
  nextPid: number;
  /** Forces the next scans to report a transient failure. */
  uncertain: boolean;
  scans: TaggedScanTarget[][];
};

const procNow = (host: Host): number => host.now - PROC_OFFSET_MS;

/** Replaces the tagged tree of `tag` with processes of the given RSS (kB), started at `startProcMs`. */
function setTree(host: Host, tag: string, sizes: number[], startProcMs = procNow(host)): void {
  clearTree(host, tag);
  for (const rssKb of sizes) {
    host.fsx.add({
      pid: (host.nextPid += 1), ppid: SERVER_PID, comm: 'codex', startTicks: msToTicks(startProcMs),
      env: ['pm_id=4', `CCUI_PROCESS_TAG=${tag}`], rssKb,
    });
  }
}

function clearTree(host: Host, tag: string): void {
  for (const [pid, proc] of host.fsx.procs) {
    if (proc.env?.includes(`CCUI_PROCESS_TAG=${tag}`)) host.fsx.procs.delete(pid);
  }
}

/** A same-uid process with an unreadable environ (systemd --user, ssh-agent …). */
function addHidden(host: Host, startProcMs: number): number {
  const pid = (host.nextPid += 1);
  host.fsx.add({ pid, ppid: 1, comm: 'ssh-agent', startTicks: msToTicks(startProcMs), hiddenEnviron: true });
  return pid;
}

function scanFor(host: Host) {
  return (targets: readonly TaggedScanTarget[]): TaggedScanResult => {
    host.scans.push([...targets]);
    if (host.uncertain) return { byTag: new Map(), hidden: false, uncertain: true };
    return scanTaggedProcesses(targets, host.fsx.deps());
  };
}

type SetupOptions = Partial<CodexLeaseDeps> & {
  database?: Database.Database;
  serverIdentity?: { bootId: string; pid: number; startTicks: string };
};

function setup(options: SetupOptions = {}) {
  const { database: given, serverIdentity, ...overrides } = options;
  const db = given ?? new Database(':memory:');
  db.exec(SCHEMA);
  const host: Host = {
    now: START_WALL_MS, memoryPercent: 50, fsx: new FakeProcFs(), nextPid: 1_000, uncertain: false, scans: [],
  };
  // Long-lived same-uid daemons with unreadable environ, started at boot: always on a real host.
  addHidden(host, ticksToMs(50));
  const timers: Array<() => void> = [];
  const warnings: string[] = [];
  let seq = 0;
  const deps: CodexLeaseDeps = {
    db: () => db,
    sample: async () => ({ cpuPercent: 10, memoryPercent: host.memoryPercent, measuredAt: host.now }),
    now: () => host.now,
    leaseId: () => `lease-${(seq += 1)}`,
    identity: () => serverIdentity ?? { bootId: 'boot-a', pid: process.pid, startTicks: '500' },
    scan: scanFor(host),
    procClockNowMs: () => procNow(host),
    totalMemoryKb: () => TOTAL_KB,
    startTimer: (tick) => { timers.push(tick); return () => { timers.splice(timers.indexOf(tick), 1); }; },
    log: { warn: (message) => { warnings.push(message); }, info: () => {} },
    ...overrides,
  };
  const leases = new CodexHelpersLeases(deps);
  return { db, host, leases, timers, warnings };
}

type Row = { lease_id: string; owner_id: string; memory_reserved: number; status: string; exit_proof_kind: string | null; heartbeat_at_ms: number };
const rows = (db: Database.Database): Row[] => db.prepare('SELECT * FROM turn_resource_leases ORDER BY lease_id').all() as Row[];
const active = (db: Database.Database): Row[] => rows(db).filter(row => row.status === 'active');

const decide = (leases: CodexHelpersLeases, tag: string, userId: number | null = 1) => decideCodexHelpers({
  level: 'delegate', env: {}, projectRoles: async () => null,
  cpu: () => ({ percent: 10, source: 'window' }),
  memoryOk: () => leases.reserve({ tag, userId }),
});

test('ownerId is codex-sdk:<bootId>:<pid>:<startTicks>; reserve is 3 × 1% of host (V1 calibration)', () => {
  assert.equal(codexLeaseOwnerId({ bootId: 'b', pid: 7, startTicks: '99' }), 'codex-sdk:b:7:99');
  assert.equal(CODEX_TURN_RESERVE_PERCENT, 3);
});

test('a turn at 79% alone gets helpers; its own lease is not in its own check', async () => {
  const { db, host, leases } = setup();
  host.memoryPercent = 79;
  const decision = await decide(leases, 'pe-a');
  assert.equal(decision.helpers, true);
  const [row] = active(db);
  assert.equal(row.memory_reserved, 3);
  assert.match(row.owner_id, /^codex-sdk:boot-a:\d+:500$/u);
  assert.equal((db.prepare('SELECT cpu_reserved, turn_id FROM turn_resource_leases').get() as { cpu_reserved: number; turn_id: string }).cpu_reserved, 0);
  assert.equal((db.prepare('SELECT turn_id FROM turn_resource_leases').get() as { turn_id: string }).turn_id, 'codex:pe-a');
});

test('79/80 boundary includes the other turns\' unrealised reserve; 80 is not below 80', async () => {
  const { db, host, leases } = setup();
  host.memoryPercent = 70;
  assert.equal((await decide(leases, 'pe-first')).helpers, true, '70 + 0 < 80');
  host.memoryPercent = 76.99;
  assert.equal((await decide(leases, 'pe-second')).helpers, true, '76.99 + 3 < 80');
  host.memoryPercent = 74;
  const third = await decide(leases, 'pe-third');
  assert.deepEqual([third.helpers, third.reason], [false, 'host_memory_high'], '74 + 6 = 80 is not below 80');
  assert.equal(active(db).length, 2, 'no lease when B = 0');
  const lone = setup();
  lone.host.memoryPercent = 80;
  assert.equal((await decide(lone.leases, 'pe-lone')).helpers, false, 'alone at 80 is not below 80');
});

test('M1: an orphan codex-sdk lease older than 120 s with 9% stored counts 0 in the Codex check', async () => {
  const { db, host, leases } = setup();
  db.prepare(
    `INSERT INTO turn_resource_leases (lease_id, turn_id, user_id, owner_id, owner_pid, cpu_reserved,
       memory_reserved, status, created_at_ms, heartbeat_at_ms) VALUES ('orphan', 'codex:pe-gone', 1,
       'codex-sdk:old-boot:1:1', 1, 0, 9, 'active', ?, ?)`,
  ).run(host.now - CODEX_LEASE_MAX_AGE_MS - 1, host.now);
  host.memoryPercent = 75;
  assert.equal((await decide(leases, 'pe-new')).helpers, true, '75 + 0 < 80 although 9% is stored');
  assert.equal(sumCodexSdkLeaseMemory(db, host.now), 3, 'only the new lease counts');
});

test('M2: the reserve follows peak growth, never rises when a child exits, 0 after 120 s', async () => {
  const { db, host, leases } = setup();
  await decide(leases, 'pe-g');
  const created = host.now;
  leases.tick();
  assert.equal(active(db)[0].memory_reserved, 3, 'before the first stream event: full reserve');
  setTree(host, 'pe-g', [20_000]); // root tree 2% at the first stream event
  leases.firstStreamEvent('pe-g', procNow(host));
  host.now += 2_000;
  setTree(host, 'pe-g', [20_000, 10_000]); // a child adds 1%
  leases.tick();
  assert.equal(active(db)[0].memory_reserved, 2, '3 − 1');
  host.now += 2_000;
  setTree(host, 'pe-g', [20_000]); // the child exits before 120 s
  leases.tick();
  assert.equal(active(db)[0].memory_reserved, 2, 'peak growth keeps the reserve down');
  host.now += 2_000;
  setTree(host, 'pe-g', [20_000, 150_000]); // more than estimated
  leases.tick();
  assert.equal(active(db)[0].memory_reserved, 0, 'growth above the estimate gives 0, not negative');
  host.now = created + CODEX_LEASE_MAX_AGE_MS;
  assert.equal(codexUnrealisedReserve({ reservePercent: 9, ageMs: CODEX_LEASE_MAX_AGE_MS, baselinePercent: null, peakGrowthPercent: 0 }), 0);
  assert.equal(codexUnrealisedReserve({ reservePercent: 9, ageMs: 1, baselinePercent: null, peakGrowthPercent: 5 }), 9);
});

test('a scan failure leaves the reserve unchanged and still heartbeats', async () => {
  const { db, host, leases } = setup();
  await decide(leases, 'pe-u');
  setTree(host, 'pe-u', [10_000]);
  leases.firstStreamEvent('pe-u', procNow(host));
  host.uncertain = true;
  setTree(host, 'pe-u', [10_000, 50_000]);
  host.now += 2_000;
  leases.tick();
  const [row] = active(db);
  assert.equal(row.memory_reserved, 3);
  assert.equal(row.heartbeat_at_ms, host.now);
});

test('BEGIN IMMEDIATE: two connections see each other\'s lease; a held write lock gives B = 0', async () => {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'codex-lease-'));
  const file = path.join(dir, 'leases.db');
  try {
    const one = setup({ database: new Database(file, { timeout: 0 }) });
    const two = setup({ database: new Database(file, { timeout: 0 }), serverIdentity: { bootId: 'boot-a', pid: 2, startTicks: '9' } });
    one.host.memoryPercent = 77;
    two.host.memoryPercent = 77;
    assert.equal((await decide(one.leases, 'pe-one')).helpers, true);
    const second = await decide(two.leases, 'pe-two');
    assert.deepEqual([second.helpers, second.reason], [false, 'host_memory_high'], '77 + 3 (other turn) >= 80');

    const locker = new Database(file, { timeout: 0 });
    locker.exec('BEGIN IMMEDIATE');
    two.host.memoryPercent = 10;
    const locked = await decide(two.leases, 'pe-three');
    assert.deepEqual([locked.helpers, locked.reason], [false, 'measurement_unavailable'], 'busy lock: B = 0, never a refusal');
    locker.exec('ROLLBACK');
    locker.close();
    one.db.close();
    two.db.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('no refusal path: DB missing, insert failure, stale or bad sample, missing context → B = 0', async () => {
  const broken = setup();
  broken.db.exec('DROP TABLE turn_resource_leases');
  const noTable = await decide(broken.leases, 'pe-x');
  assert.deepEqual([noTable.helpers, noTable.reason], [false, 'measurement_unavailable']);

  const throwing = setup();
  const throwingLeases = new CodexHelpersLeases({
    ...(throwing.leases as unknown as { deps: CodexLeaseDeps }).deps,
    db: () => { throw new Error('SQLITE_CANTOPEN'); },
  });
  assert.equal((await decide(throwingLeases, 'pe-y')).helpers, false);

  const dup = setup();
  dup.db.exec(`CREATE TRIGGER no_insert BEFORE INSERT ON turn_resource_leases BEGIN SELECT RAISE(ABORT, 'disk full'); END;`);
  const insertFailed = await decide(dup.leases, 'pe-z');
  assert.deepEqual([insertFailed.helpers, insertFailed.reason], [false, 'measurement_unavailable']);
  assert.equal(dup.leases.liveCount, 0);

  const stale = setup({ sample: async () => ({ cpuPercent: 1, memoryPercent: 1, measuredAt: 0 }) });
  assert.equal((await decide(stale.leases, 'pe-s')).helpers, false);
  const nan = setup({ sample: async () => ({ cpuPercent: 1, memoryPercent: Number.NaN, measuredAt: 1_000_000 }) });
  assert.equal((await decide(nan.leases, 'pe-n')).helpers, false);
  const sampleThrows = setup({ sample: async () => { throw new Error('meminfo'); } });
  assert.equal((await decide(sampleThrows.leases, 'pe-t')).helpers, false);
  await assert.rejects(() => setup().leases.reserve({ tag: '', userId: 1 }));
});

const ended = (overrides: Partial<CodexLeaseEnd> = {}): CodexLeaseEnd => ({
  started: true, succeeded: false, cleanup: null, notBeforeMs: null, ...overrides,
});

test('exit proof: success → process_exit; abort/error → process_dead only on absent', () => {
  const absent = () => 'absent' as const;
  assert.equal(codexLeaseExitProof(ended({ succeeded: true }), absent, 5)?.kind, 'process_exit');
  assert.equal(codexLeaseExitProof(ended({ cleanup: { outcome: 'absent' } }), () => 'present', 5)?.kind, 'process_dead');
  for (const outcome of ['present', 'hidden', 'uncertain'] as const) {
    assert.equal(codexLeaseExitProof(ended({ cleanup: { outcome } }), absent, 5), null, outcome);
    assert.equal(codexLeaseExitProof(ended(), () => outcome, 5), null, outcome);
  }
  assert.equal(codexLeaseExitProof(ended(), absent, 5)?.kind, 'process_dead');
  assert.equal(codexLeaseExitProof(ended(), () => { throw new Error('x'); }, 5), null);
});

/** One reclaimer tick past the stale window. */
function afterStale(host: Host, leases: CodexHelpersLeases): number {
  host.now += CODEX_LEASE_STALE_MS + 1;
  return leases.reclaim();
}

test('H5 leak 1: normal end releases with process_exit; the ticker stops', async () => {
  const { db, leases, timers } = setup();
  await decide(leases, 'pe-1');
  assert.equal(timers.length, 1, 'per-lease heartbeat ticker runs');
  assert.equal(leases.finish('pe-1', ended({ succeeded: true })), 'released');
  assert.deepEqual(rows(db).map(row => [row.status, row.exit_proof_kind]), [['released', 'process_exit']]);
  leases.tick();
  assert.equal(timers.length, 0);
  assert.equal(leases.finish('pe-1', ended({ succeeded: true })), 'none', 'idempotent');
});

test('H5 leak 2: abort with codex alive past SIGTERM → retained, released once the tag is gone', async () => {
  const { db, host, leases } = setup();
  await decide(leases, 'pe-2');
  setTree(host, 'pe-2', [30_000]);
  assert.equal(leases.finish('pe-2', ended({ cleanup: { outcome: 'present' } })), 'retained');
  assert.equal(afterStale(host, leases), 0, 'tag present: kept');
  assert.equal(active(db).length, 1);
  clearTree(host, 'pe-2');
  assert.equal(leases.reclaim(), 1);
  assert.deepEqual(rows(db).map(row => row.exit_proof_kind), ['process_dead']);
  // The killed variant: cleanup proves absent → released at once.
  await decide(leases, 'pe-2b');
  assert.equal(leases.finish('pe-2b', ended({ cleanup: { outcome: 'absent' } })), 'released');
  assert.equal(active(db).length, 0);
});

test('H5 leak 3: a turn that never started is released at once with dispatch_not_started, no scan', async () => {
  const { db, host, leases } = setup();
  await decide(leases, 'pe-3');
  // Even a fresh unreadable process (that would make any scan `hidden`) does not matter:
  // no SDK effect was attempted, so no process can carry the tag.
  addHidden(host, procNow(host));
  const scansBefore = host.scans.length;
  assert.equal(leases.finish('pe-3', ended({ started: false })), 'released');
  assert.equal(host.scans.length, scansBefore, 'no scan needed');
  assert.deepEqual(rows(db).map(row => [row.status, row.exit_proof_kind]), [['released', 'dispatch_not_started']]);
  assert.equal(sumCodexSdkLeaseMemory(db, host.now), 0, 'holds nothing at once, not for 120 s');
});

test('a started turn without cleanup and without a launch mark scans from created_at − 5 s', async () => {
  const { db, host, leases } = setup();
  await decide(leases, 'pe-3b');
  const createdProc = procNow(host);
  host.now += 1_000;
  assert.equal(leases.finish('pe-3b', ended()), 'released');
  assert.deepEqual(host.scans.at(-1), [{ tag: 'pe-3b', notBeforeMs: createdProc - 5_000 }]);
  assert.equal(active(db).length, 0);
});

test('H5 leak 4: a release that throws leaves the row to the reclaimer', async () => {
  const { db, host, leases } = setup({
    release: () => { throw new Error('SQLITE_BUSY'); },
  });
  await decide(leases, 'pe-4');
  assert.equal(leases.finish('pe-4', ended({ succeeded: true })), 'retained');
  assert.equal(leases.liveCount, 0, 'no longer heartbeated');
  const healthy = new CodexHelpersLeases({ ...(leases as unknown as { deps: CodexLeaseDeps }).deps, release: undefined as never });
  host.now += CODEX_LEASE_STALE_MS + 1;
  assert.equal(healthy.reclaim(), 1);
  assert.equal(active(db).length, 0);
});

test('H5 leak 5: simulated restart — other ownerId, absent → released; present → retained until absent', async () => {
  const old = setup({ serverIdentity: { bootId: 'boot-a', pid: 4242, startTicks: '1' } });
  await decide(old.leases, 'pe-gone');
  await decide(old.leases, 'pe-alive');
  const next = setup({ database: old.db, serverIdentity: { bootId: 'boot-a', pid: 5151, startTicks: '2' } });
  next.host.now = old.host.now;
  setTree(next.host, 'pe-alive', [10_000]);
  next.host.now += 5_000;
  assert.equal(next.leases.reclaim(), 0, 'not stale yet');
  assert.equal(afterStale(next.host, next.leases), 1);
  assert.deepEqual(active(old.db).map(row => row.lease_id), ['lease-2']);
  clearTree(next.host, 'pe-alive');
  assert.equal(next.leases.reclaim(), 1);
  assert.equal(active(old.db).length, 0);
});

test('reclaimer: long-lived unreadable daemons (started before the lease) never block it', async () => {
  const { db, host, leases } = setup();
  await decide(leases, 'pe-old-hidden');
  leases.finish('pe-old-hidden', ended({ cleanup: { outcome: 'uncertain' } }));
  // ssh-agent / gpg-agent started an hour before the lease, as on the real host.
  addHidden(host, procNow(host) - 3_600_000);
  assert.equal(afterStale(host, leases), 1);
  assert.deepEqual(rows(db).map(row => row.exit_proof_kind), ['process_dead']);
});

test('reclaimer floor is created_at − 5 s in the /proc clock: older tag carriers are ignored', async () => {
  const { db, host, leases } = setup();
  await decide(leases, 'pe-floor');
  leases.finish('pe-floor', ended({ cleanup: { outcome: 'present' } }));
  const createdProc = procNow(host);
  setTree(host, 'pe-floor', [5_000], createdProc - 4_000); // inside the 5 s floor: counts
  assert.equal(afterStale(host, leases), 0);
  assert.deepEqual(host.scans.at(-1), [{ tag: 'pe-floor', notBeforeMs: createdProc - 5_000 }]);
  setTree(host, 'pe-floor', [5_000], createdProc - 7_000); // before floor − 1 s slack: not ours
  assert.equal(leases.reclaim(), 1);
  assert.equal(active(db).length, 0);
});

test('H5 leak 6: pid reuse of the old server pid does not keep or wrongly free a lease', async () => {
  const old = setup({ serverIdentity: { bootId: 'boot-a', pid: process.pid, startTicks: '1' } });
  await decide(old.leases, 'pe-reuse');
  // Same pid, new start ticks: a different instance. Reclaim is tag-based, never pid-based.
  const next = setup({
    database: old.db, serverIdentity: { bootId: 'boot-a', pid: process.pid, startTicks: '2' }, leaseId: () => 'next-live',
  });
  next.host.now = old.host.now;
  setTree(next.host, 'pe-reuse', [10_000]);
  assert.equal(afterStale(next.host, next.leases), 0, 'tag present: retained although the pid is alive');
  clearTree(next.host, 'pe-reuse');
  assert.equal(next.leases.reclaim(), 1);
  // A live lease of this instance is never reclaimed, even when stale.
  assert.equal((await decide(next.leases, 'pe-live')).helpers, true);
  next.host.now += CODEX_LEASE_STALE_MS * 3;
  assert.equal(next.leases.reclaim(), 0);
  // A hidden process started after the lease may be the turn's: it proves nothing.
  next.leases.finish('pe-live', ended({ cleanup: { outcome: 'hidden' } }));
  const hiddenPid = addHidden(next.host, procNow(next.host));
  assert.equal(afterStale(next.host, next.leases), 0);
  next.host.fsx.procs.delete(hiddenPid);
  assert.equal(next.leases.reclaim(), 1);
});

test('a leaked lease reserves nothing after 120 s, so it cannot lower B for others', async () => {
  const { host, leases } = setup();
  await decide(leases, 'pe-leak');
  leases.finish('pe-leak', ended({ cleanup: { outcome: 'uncertain' } }));
  host.memoryPercent = 78;
  assert.equal((await decide(leases, 'pe-x1')).helpers, false, '78 + 3 (young leak) >= 80');
  host.now += CODEX_LEASE_MAX_AGE_MS;
  assert.equal((await decide(leases, 'pe-x2')).helpers, true, '78 + 0 < 80');
});
