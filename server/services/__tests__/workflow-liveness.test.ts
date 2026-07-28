/**
 * ADR-053 / T-53-B1 — workflow liveness (pid source + م-3 classifier).
 *
 * Proves the B-103 visibility primitive: a background workflow whose coordinator
 * turn already ended is judged RUNNING / ORPHAN / COMPLETED from the CHILD PID
 * combined with the journal's real key sets and freshness. The key sets are read
 * from the SAME parser reconcile uses (`readJournalKeySets`) applied to the REAL
 * incident/completed journals on disk (no synthetic fixtures — lesson
 * `feedback_synthetic_fixtures_false_confidence`).
 *
 * The load-bearing rule under test is م-3 (the 6th mandatory condition): a dead
 * pid whose journal is NOT quiet is RUNNING (conservative), never COMPLETED — so
 * a grandchild orphan still flushing after the root died is never prematurely
 * declared finished.
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { readJournalKeySets } from '@/modules/providers/list/claude/workflow-reconcile.service.js';
import {
  classifyWorkflowLiveness,
  forgetWorkflowPid,
  isPidAlive,
  isWorkflowProcessAlive,
  probeWorkflowLiveness,
  registerWorkflowPid,
  resolveWorkflowPid,
  trackedWorkflowPidCount,
} from '@/services/workflow-liveness.js';
import {
  COMPLETED_JOURNAL_LINES,
  INCIDENT_JOURNAL_LINES,
  toJsonl,
} from '@/services/__tests__/__fixtures__/wf-real-journals.js';

const QUIET_MS = 5000;
const NOW_MS = Date.parse('2026-06-27T15:00:00.000Z');
// Journal last written 6 min before "now" => well past the quiet window.
const QUIET_MTIME_MS = NOW_MS - 6 * 60_000;
// Journal written 1s ago => inside the quiet window (still being flushed).
const FRESH_MTIME_MS = NOW_MS - 1000;

/**
 * Writes `lines` to a temp journal and returns its real key-set booleans via the
 * production parser — so the classifier is driven by the SAME derivation the
 * reconcile/status paths use, on the SAME real rows.
 */
async function keysFromRealJournal(lines: Array<Record<string, unknown>>): Promise<{
  startedKeyCount: number;
  resultKeyCount: number;
  allStartedResulted: boolean;
}> {
  const dir = await mkdtemp(path.join(tmpdir(), 'wf-liveness-'));
  try {
    const journalPath = path.join(dir, 'journal.jsonl');
    await writeFile(journalPath, toJsonl(lines), 'utf8');
    const { startedKeys, resultKeys } = await readJournalKeySets(journalPath);
    let allStartedResulted = startedKeys.size >= 1;
    for (const key of startedKeys) {
      if (!resultKeys.has(key)) {
        allStartedResulted = false;
        break;
      }
    }
    return { startedKeyCount: startedKeys.size, resultKeyCount: resultKeys.size, allStartedResulted };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// ============================================================================
// isPidAlive — the raw child-pid probe
// ============================================================================

test('isPidAlive: this very process is alive', () => {
  assert.equal(isPidAlive(process.pid), true, 'the running test process must read as alive');
});

test('isPidAlive: a reaped short-lived child reads as dead', async () => {
  // Spawn a process that exits immediately, wait for its exit, then probe. Its
  // pid is no longer a live process (reaped by Node) => ESRCH => dead.
  const child = spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore' });
  const pid = child.pid as number;
  await new Promise<void>((resolve) => child.on('exit', () => resolve()));
  // Give the OS a beat to fully reap before probing.
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(isPidAlive(pid), false, 'an exited+reaped child pid must read as dead');
});

test('isPidAlive: invalid/nonsense pids are dead (fail-safe)', () => {
  assert.equal(isPidAlive(null as unknown as number), false);
  assert.equal(isPidAlive(undefined as unknown as number), false);
  assert.equal(isPidAlive(0), false);
  assert.equal(isPidAlive(-1), false);
  assert.equal(isPidAlive(1.5 as unknown as number), false);
});

// ============================================================================
// pid registry — survives past turn-end, self-prunes on death
// ============================================================================

test('registry: register/resolve round-trips a live pid; invalid ignored', () => {
  const sid = 'sess-live';
  forgetWorkflowPid(sid);
  registerWorkflowPid(sid, process.pid);
  assert.equal(resolveWorkflowPid(sid), process.pid);

  // Invalid registrations are ignored (no overwrite to a bad value).
  registerWorkflowPid(sid, 0);
  registerWorkflowPid(sid, -5);
  assert.equal(resolveWorkflowPid(sid), process.pid, 'a live pid is not clobbered by invalid ones');

  forgetWorkflowPid(sid);
  assert.equal(resolveWorkflowPid(sid), null, 'forget clears the mapping');
});

test('registry: isWorkflowProcessAlive is true for a live pid and self-prunes a dead one', async () => {
  const liveSid = 'sess-alive';
  forgetWorkflowPid(liveSid);
  registerWorkflowPid(liveSid, process.pid);
  assert.equal(isWorkflowProcessAlive(liveSid), true);

  const deadSid = 'sess-dead';
  forgetWorkflowPid(deadSid);
  const child = spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore' });
  const pid = child.pid as number;
  await new Promise<void>((resolve) => child.on('exit', () => resolve()));
  await new Promise((r) => setTimeout(r, 50));
  registerWorkflowPid(deadSid, pid);
  assert.equal(trackedWorkflowPidCount() >= 1, true, 'dead pid is tracked before the probe');
  assert.equal(isWorkflowProcessAlive(deadSid), false, 'a dead pid reads as not alive');
  assert.equal(resolveWorkflowPid(deadSid), null, 'the dead mapping is pruned so the registry stays bounded');

  forgetWorkflowPid(liveSid);
});

test('registry: an unknown session is not alive (never claim liveness without a pid)', () => {
  assert.equal(isWorkflowProcessAlive('never-registered'), false);
});

// ============================================================================
// probeWorkflowLiveness — {known, alive, frozen}; `known` captured BEFORE prune
// ============================================================================

test('probe: an unknown session => {known:false, alive:false, frozen:false}', () => {
  forgetWorkflowPid('probe-unknown');
  assert.deepEqual(probeWorkflowLiveness('probe-unknown'), {
    known: false,
    alive: false,
    frozen: false,
  });
});

test('probe: a live pid => known + alive, not frozen', () => {
  const sid = 'probe-live';
  forgetWorkflowPid(sid);
  registerWorkflowPid(sid, process.pid);
  const p = probeWorkflowLiveness(sid);
  assert.equal(p.known, true);
  assert.equal(p.alive, true);
  assert.equal(p.frozen, false);
  forgetWorkflowPid(sid);
});

test('probe (M1): a dead pid reads known:true (captured before prune) + alive:false, then prunes', async () => {
  // THE M1 guard: a recorded-then-dead pid must remain "known" so the classifier
  // calls it ORPHAN — distinct from an unregistered survivor (known:false => UNKNOWN).
  const sid = 'probe-dead';
  forgetWorkflowPid(sid);
  const child = spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore' });
  const pid = child.pid as number;
  await new Promise<void>((resolve) => child.on('exit', () => resolve()));
  await new Promise((r) => setTimeout(r, 50));

  registerWorkflowPid(sid, pid);
  const p = probeWorkflowLiveness(sid);
  assert.equal(p.known, true, 'a recorded-but-dead pid is still KNOWN (captured before pruning)');
  assert.equal(p.alive, false, 'the pid is dead');
  assert.equal(p.frozen, false);
  assert.equal(resolveWorkflowPid(sid), null, 'the dead pid is pruned after the probe');
});

test('probe (F1): a SIGSTOP-frozen pid reads frozen:true and is NOT pruned', async () => {
  // Real /proc verification of the frozen ('T') state, matching the
  // session-process-monitor badge. Spawn a long-lived child, stop it, probe.
  const sid = 'probe-frozen';
  forgetWorkflowPid(sid);
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  const pid = child.pid as number;
  try {
    await new Promise((r) => setTimeout(r, 50));
    registerWorkflowPid(sid, pid);
    process.kill(pid, 'SIGSTOP');
    await new Promise((r) => setTimeout(r, 80)); // let the kernel move it to 'T'

    const p = probeWorkflowLiveness(sid);
    assert.equal(p.frozen, true, 'a SIGSTOP-ed pid is frozen (/proc state T)');
    assert.equal(p.known, true);
    assert.equal(p.alive, true, 'a stopped process is still present (not dead)');
    assert.equal(resolveWorkflowPid(sid), pid, 'a frozen pid is alive => not pruned');
  } finally {
    try { process.kill(pid, 'SIGCONT'); } catch { /* ignore */ }
    child.kill('SIGKILL');
    forgetWorkflowPid(sid);
  }
});

// ============================================================================
// classifyWorkflowLiveness — م-3 + M1 (known/unknown) + F1 (frozen), REAL keys
// ============================================================================

test('classify: pid ALIVE => RUNNING regardless of journal state (authoritative)', async () => {
  const incident = await keysFromRealJournal(INCIDENT_JOURNAL_LINES);
  const verdict = classifyWorkflowLiveness({
    alive: true,
    known: true,
    frozen: false,
    ...incident,
    journalMtimeMs: QUIET_MTIME_MS, // even quiet + orphaned keys
    now: NOW_MS,
    quietMs: QUIET_MS,
  });
  assert.equal(verdict, 'RUNNING', 'a live child pid means the workflow tree is up');
});

test('classify (م-3): pid DEAD + journal NOT quiet => RUNNING (no premature COMPLETED)', async () => {
  // The COMPLETED journal has every started key resulted; if quiet it would be
  // COMPLETED. But inside the quiet window a grandchild may still be flushing —
  // م-3 forces the conservative RUNNING so completion is never announced early.
  const completed = await keysFromRealJournal(COMPLETED_JOURNAL_LINES);
  const verdict = classifyWorkflowLiveness({
    alive: false,
    known: true,
    frozen: false,
    ...completed,
    journalMtimeMs: FRESH_MTIME_MS, // written 1s ago => not quiet
    now: NOW_MS,
    quietMs: QUIET_MS,
  });
  assert.equal(verdict, 'RUNNING', 'dead pid but still-writing journal must stay RUNNING (م-3)');
});

test('classify: pid DEAD + known + quiet + INCIDENT keys (one orphan) => ORPHAN', async () => {
  const incident = await keysFromRealJournal(INCIDENT_JOURNAL_LINES);
  assert.equal(incident.startedKeyCount, 16, 'real incident: 16 unique started keys');
  assert.equal(incident.resultKeyCount, 15, 'real incident: 15 unique result keys');
  assert.equal(incident.allStartedResulted, false, 'one started key never resulted (the orphan)');

  const verdict = classifyWorkflowLiveness({
    alive: false,
    known: true, // a pid WAS recorded and died => a real B-103 orphan
    frozen: false,
    ...incident,
    journalMtimeMs: QUIET_MTIME_MS,
    now: NOW_MS,
    quietMs: QUIET_MS,
  });
  assert.equal(verdict, 'ORPHAN', 'dead+known pid, quiet, unfinished => visible orphan');
});

test('classify (M1): same INCIDENT keys but UNKNOWN pid (survivor) => UNKNOWN, not a false ORPHAN', async () => {
  // THE false-orphan fix: identical real key sets to the ORPHAN case above, but no
  // pid was ever recorded (the restart-survivor shape: in-memory pid Map emptied
  // on boot). Liveness is unproven => must NOT be declared a death.
  const incident = await keysFromRealJournal(INCIDENT_JOURNAL_LINES);
  const verdict = classifyWorkflowLiveness({
    alive: false,
    known: false, // no pid ever recorded — cannot claim it died
    frozen: false,
    ...incident,
    journalMtimeMs: QUIET_MTIME_MS,
    now: NOW_MS,
    quietMs: QUIET_MS,
  });
  assert.equal(verdict, 'UNKNOWN', 'no recorded pid => unproven liveness, never a false ORPHAN (M1)');
});

test('classify (M1): restart survivor — no pid, quiet EMPTY journal => UNKNOWN', () => {
  // A workflow folder that survived a restart with an empty/absent journal and no
  // recorded pid: unproven, not swallowed, not a false death.
  const verdict = classifyWorkflowLiveness({
    alive: false,
    known: false,
    frozen: false,
    startedKeyCount: 0,
    resultKeyCount: 0,
    allStartedResulted: false,
    journalMtimeMs: 0,
    now: NOW_MS,
    quietMs: QUIET_MS,
  });
  assert.equal(verdict, 'UNKNOWN');
});

test('classify: pid DEAD + quiet + COMPLETED keys (all resulted) => COMPLETED (regardless of known)', async () => {
  const completed = await keysFromRealJournal(COMPLETED_JOURNAL_LINES);
  assert.equal(completed.startedKeyCount, 7, 'real completed: 7 unique started keys');
  assert.equal(completed.resultKeyCount, 7, 'real completed: 7 unique result keys');
  assert.equal(completed.allStartedResulted, true, 'every started key resulted');

  // COMPLETED must hold whether or not the pid is still known.
  for (const known of [true, false]) {
    const verdict = classifyWorkflowLiveness({
      alive: false,
      known,
      frozen: false,
      ...completed,
      journalMtimeMs: QUIET_MTIME_MS,
      now: NOW_MS,
      quietMs: QUIET_MS,
    });
    assert.equal(verdict, 'COMPLETED', `dead pid, quiet, all resulted => completed (known=${known})`);
  }
});

test('classify: pid DEAD + known + quiet + NO journal (mtime 0) + no keys => ORPHAN', () => {
  // A workflow folder with no journal at all but a recorded-then-dead pid: mtime 0
  // is treated as quiet, and a known-dead pid with no results is a real orphan.
  const verdict = classifyWorkflowLiveness({
    alive: false,
    known: true,
    frozen: false,
    startedKeyCount: 0,
    resultKeyCount: 0,
    allStartedResulted: false,
    journalMtimeMs: 0,
    now: NOW_MS,
    quietMs: QUIET_MS,
  });
  assert.equal(verdict, 'ORPHAN', 'dead+known pid + empty/absent journal => orphan (surfaced)');
});

test('classify: pid DEAD + known + quiet + started={A,B}/result={A,C} => partial ORPHAN', async () => {
  // Partial-orphan shape from REAL incident rows: two started keys {A,B} but the
  // results cover A and a DIFFERENT key C (B never resulted). agentsTotal>agentsDone.
  const startedRows = INCIDENT_JOURNAL_LINES.filter((l) => l.type === 'started');
  const resultRows = INCIDENT_JOURNAL_LINES.filter((l) => l.type === 'result');
  const A = startedRows[0].key;
  const B = startedRows[1].key;
  const aResult = resultRows.find((r) => r.key === A);
  const cResult = resultRows.find((r) => r.key !== A && r.key !== B); // result for an un-started key
  assert.ok(aResult && cResult, 'real incident rows must yield an A-result and a distinct C-result');

  const partial = await keysFromRealJournal([startedRows[0], startedRows[1], aResult!, cResult!]);
  assert.equal(partial.startedKeyCount, 2, 'started {A,B}');
  assert.equal(partial.resultKeyCount, 2, 'result {A,C}');
  assert.equal(partial.allStartedResulted, false, 'B never resulted => not clean');

  const verdict = classifyWorkflowLiveness({
    alive: false,
    known: true,
    frozen: false,
    ...partial,
    journalMtimeMs: QUIET_MTIME_MS,
    now: NOW_MS,
    quietMs: QUIET_MS,
  });
  assert.equal(verdict, 'ORPHAN', 'a started key left hanging with a known-dead pid => partial orphan');
});

test('classify (F1): frozen => FROZEN, taking precedence over alive AND over completed keys', async () => {
  const completed = await keysFromRealJournal(COMPLETED_JOURNAL_LINES);
  // Even with all-resulted keys and alive true, a STOPPED ('T') pid surfaces FROZEN.
  const verdict = classifyWorkflowLiveness({
    alive: true,
    known: true,
    frozen: true,
    ...completed,
    journalMtimeMs: QUIET_MTIME_MS,
    now: NOW_MS,
    quietMs: QUIET_MS,
  });
  assert.equal(verdict, 'FROZEN', 'a frozen pid is reported FROZEN, matching the process badge');
});

// ============================================================================
// The decisive-source invariant (ADR-053:100): pid is authoritative even when
// the in-memory session/activeSessions view is empty. We model "activeSessions
// empty" as "no registry pid at all" (dropped at turn-end) vs "pid still alive".
// ============================================================================

test('invariant: with the in-memory view gone, the CHILD PID is the decisive liveness source', () => {
  const sid = 'sess-decisive';
  forgetWorkflowPid(sid);

  // Turn ended: no pid registered yet (mirrors activeSessions/registry empty).
  assert.equal(isWorkflowProcessAlive(sid), false, 'no pid => cannot claim alive (defers to journal)');

  // The run path registered the real child pid before turn-end; it survives.
  registerWorkflowPid(sid, process.pid);
  assert.equal(
    isWorkflowProcessAlive(sid),
    true,
    'the surviving child pid — NOT activeSessions — decides the workflow is still alive',
  );

  forgetWorkflowPid(sid);
});
