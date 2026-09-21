/**
 * The vocabulary map, pinned against the exact failures measured on three live
 * boards on 2026-07-29 — not against invented words.
 *
 * What was actually wrong, in the owner's words: "مشروع-ج ومشروع-ب لا يعرضان
 * اللوحة بشكل جيد". Measured:
 *
 *   SampleTwo     31 of 64 tasks (48%) rendered in NO column, and because every
 *               finished task is spelled "closed" rather than "done", the board
 *               reported 0% completion for a project that is 47% done.
 *   nassaj-dev 101 of 553 tasks (18%) invisible: todo, pending, blocked,
 *               backlog, deferred, cancelled.
 *   SampleOne         7 of 71 tasks  (9%) invisible; 16 issue rows printed the
 *               literal string "issues.severity.undefined" on screen.
 *
 * The invariant these tests defend is not "every synonym is mapped" — no list
 * can promise that. It is: **an unrecognised value is still displayed**. A word
 * nobody anticipated must land in a visible bucket and keep its label.
 *
 * RUNNER: NODE_ENV=test npx vitest run src/components/project-board/lib/boardVocabulary.test.ts
 */
import { describe, expect, it } from 'vitest';

import type { ProjectBoardState } from '../types';

import { boardCounts, overallProgress, phaseProgress, phaseTaskStats } from './boardStats';
import {
  normalizeIssueStatus,
  normalizePhaseStatus,
  normalizeSeverity,
  normalizeTaskStatus,
  taskKindStyle,
} from './boardVocabulary';

describe('task status vocabulary', () => {
  it('CRUX: never drops a value — an unknown word is bucketed and kept readable', () => {
    const view = normalizeTaskStatus('sharded-out-to-vendor');

    // It must land in a column a human will actually look at…
    expect(view.bucket).toBe('open');
    // …and it must still be flagged and labelled, not silently normalised away.
    expect(view.unknown).toBe(true);
    expect(view.redundant).toBe(false);
    expect(view.raw).toBe('sharded-out-to-vendor');
  });

  it('reads the words the live boards actually use as finished work', () => {
    // SampleTwo spells every completed task "closed" — 30 of its 64 tasks.
    for (const word of ['closed', 'fixed', 'resolved', 'accepted', 'completed', 'merged']) {
      expect(normalizeTaskStatus(word).bucket, word).toBe('done');
    }
  });

  it('keeps not-started work visible however the board words it', () => {
    for (const word of ['todo', 'pending', 'backlog', 'blocked', 'deferred', 'planned']) {
      expect(normalizeTaskStatus(word).bucket, word).toBe('open');
    }
  });

  it('marks stuck work so it is not mistaken for untouched work', () => {
    // Both sit in the open column; only one needs someone to unblock it.
    expect(normalizeTaskStatus('blocked').needsAttention).toBe(true);
    expect(normalizeTaskStatus('todo').needsAttention).toBe(false);
  });

  it('separates cancelled from open so it never inflates the backlog', () => {
    for (const word of ['cancelled', 'wontfix', 'dropped', 'rejected', 'superseded']) {
      expect(normalizeTaskStatus(word).bucket, word).toBe('cancelled');
    }
  });

  it('does not repeat on the card what the column header already says', () => {
    expect(normalizeTaskStatus('done').redundant).toBe(true);
    // "closed" means done but does not SAY done — the card keeps the word.
    expect(normalizeTaskStatus('closed').redundant).toBe(false);
  });

  it('tolerates the shapes a hand-edited file produces', () => {
    expect(normalizeTaskStatus('In Progress').bucket).toBe('in_progress');
    expect(normalizeTaskStatus('  DONE  ').bucket).toBe('done');
    // Missing entirely: still a row, still visible.
    expect(normalizeTaskStatus(undefined).bucket).toBe('open');
    expect(normalizeTaskStatus(undefined).raw).toBe('unknown');
  });
});

describe('issue vocabulary', () => {
  it('CRUX: a missing severity yields no chip — never a printed translation key', () => {
    // SampleOne: 16 rows rendered the literal text "issues.severity.undefined".
    expect(normalizeSeverity(undefined)).toBeNull();
    expect(normalizeSeverity('')).toBeNull();
    expect(normalizeSeverity('critical')).toBe('critical');
    expect(normalizeSeverity('blocker')).toBe('critical');
  });

  it('treats an unrecognised status as unresolved rather than as done', () => {
    const view = normalizeIssueStatus('escalated-to-vendor');
    // Assuming a defect is fixed because its word is unfamiliar hides work.
    expect(view.resolved).toBe(false);
    expect(view.unknown).toBe(true);
  });

  it('counts an in-progress issue as still costing something', () => {
    expect(normalizeIssueStatus('in_progress').resolved).toBe(false);
    expect(normalizeIssueStatus('resolved').resolved).toBe(true);
    expect(normalizeIssueStatus('wontfix').resolved).toBe(true);
  });
});

describe('task kind', () => {
  it('keeps an unlisted kind visible instead of hiding the chip', () => {
    // 76 tasks across the three boards use kinds outside the four styled ones.
    expect(taskKindStyle('maintenance')).toBeTruthy();
    expect(taskKindStyle('security')).toBeTruthy();
    expect(taskKindStyle('bug')).toContain('destructive');
    // No kind at all is still no chip.
    expect(taskKindStyle(undefined)).toBeNull();
  });
});

describe('progress arithmetic reads the same vocabulary', () => {
  // SampleTwo in miniature: work that is finished, spelled the way it spells it.
  const state = {
    $version: 1,
    project: 'SampleTwo',
    phases: [{ id: 'P1', title: 'Build', status: 'current', progress: 0 }],
    tasks: [
      { id: 'T-1', title: 'a', phase: 'P1', status: 'closed' },
      { id: 'T-2', title: 'b', phase: 'P1', status: 'closed' },
      { id: 'T-3', title: 'c', phase: 'P1', status: 'todo' },
      { id: 'T-4', title: 'd', phase: 'P1', status: 'wontfix' },
    ],
    issues: [{ id: 'B-1', title: 'x', severity: 'high', status: 'in_progress' }],
    decisions: [],
  } as unknown as ProjectBoardState;

  it('CRUX: counts "closed" as done — the 0%-instead-of-47% bug', () => {
    const stats = phaseTaskStats(state, state.phases![0]);

    // 2 done of 3 countable (the cancelled one leaves the denominator).
    expect(stats.done).toBe(2);
    expect(stats.total).toBe(3);
    expect(stats.progress).toBe(67);
    expect(overallProgress(state)).toBe(67);
  });

  it('feeds the overview tiles the same normalised numbers', () => {
    const counts = boardCounts(state);

    expect(counts.tasksDone).toBe(2);
    // An issue being worked on is still an open cost.
    expect(counts.openIssues).toBe(1);
  });

  // T-1809: docs/project-state.json's real P0 phase (read 2026-09-18) is marked
  // status:"done" while only 472 of its 785 non-cancelled tasks (472 "done" or
  // "completed", 5 "cancelled"/"wontfix", the rest still open or in progress)
  // are actually finished — a live 60%, not the 100% a done-phase short-circuit
  // used to print.
  it('CRUX: a phase marked done with unfinished tasks reads its real percentage', () => {
    const doneCount = 472;
    const openCount = 785 - doneCount; // still open/in-progress, non-cancelled
    const cancelledCount = 5;
    const p0 = {
      $version: 1,
      project: 'nassaj-dev',
      phases: [{ id: 'P0', title: 'Foundations', status: 'done', progress: 100 }],
      tasks: [
        ...Array.from({ length: doneCount }, (_, i) => ({
          id: `done-${i}`,
          title: 't',
          phase: 'P0',
          status: 'done',
        })),
        ...Array.from({ length: openCount }, (_, i) => ({
          id: `open-${i}`,
          title: 't',
          phase: 'P0',
          status: 'pending',
        })),
        ...Array.from({ length: cancelledCount }, (_, i) => ({
          id: `cancelled-${i}`,
          title: 't',
          phase: 'P0',
          status: 'wontfix',
        })),
      ],
      issues: [],
      decisions: [],
    } as unknown as ProjectBoardState;

    const stats = phaseTaskStats(p0, p0.phases![0]);

    expect(stats.done).toBe(doneCount);
    expect(stats.total).toBe(doneCount + openCount);
    expect(stats.progress).toBe(60);
    expect(stats.hasTasks).toBe(true);
    expect(overallProgress(p0)).toBe(60);
  });

  it('a phase with no tasks has no TASK-derived figure — null, not 0 or the stored figure', () => {
    const taskless = {
      $version: 1,
      project: 'Empty',
      phases: [{ id: 'P9', title: 'Later', status: 'pending', progress: 40 }],
      tasks: [],
      issues: [],
      decisions: [],
    } as unknown as ProjectBoardState;

    const stats = phaseTaskStats(taskless, taskless.phases![0]);

    expect(stats.progress).toBeNull();
    expect(stats.hasTasks).toBe(false);
    // The stored `progress: 40` is never read — the status is, and it says the
    // phase has not started (B-1249): a tasks-free board still yields a number.
    expect(phaseProgress(taskless, taskless.phases![0])).toBe(0);
    expect(overallProgress(taskless)).toBe(0);
  });

  it('a phase whose tasks are all cancelled has nothing to compute either — null, not 0', () => {
    // P2 is NOT itself cancelled — it is a live, current phase whose every task
    // happened to be dropped. That must still read as "nothing to compute",
    // exactly like a phase with zero tasks, not as a phase stuck at 0%.
    const allCancelled = {
      $version: 1,
      project: 'Dropped',
      phases: [
        { id: 'P1', title: 'Has real tasks', status: 'current', progress: 0 },
        { id: 'P2', title: 'Every task dropped', status: 'current', progress: 0 },
      ],
      tasks: [
        { id: 'T-1', title: 'a', phase: 'P1', status: 'done' },
        { id: 'T-2', title: 'x', phase: 'P2', status: 'wontfix' },
        { id: 'T-3', title: 'y', phase: 'P2', status: 'cancelled' },
      ],
      issues: [],
      decisions: [],
    } as unknown as ProjectBoardState;

    const stats = phaseTaskStats(allCancelled, allCancelled.phases![1]);

    expect(stats.progress).toBeNull();
    expect(stats.hasTasks).toBe(false);
    // P2 is excluded from both the sum and the weight — only P1's 100% survives.
    expect(overallProgress(allCancelled)).toBe(100);
  });

  // B-1249: dropping taskless phases out of the average inflated every real
  // board. A phase that is planned but not started is part of the plan and
  // counts as zero; it is not "nothing to say".
  it('CRUX: a not-started taskless phase weighs into the average, it is not dropped', () => {
    const mixed = {
      $version: 1,
      project: 'Mixed',
      phases: [
        { id: 'P1', title: 'Has tasks', status: 'current', progress: 0 },
        { id: 'P2', title: 'No tasks yet', status: 'pending', progress: 0 },
      ],
      tasks: [
        { id: 'T-1', title: 'a', phase: 'P1', status: 'done' },
        { id: 'T-2', title: 'b', phase: 'P1', status: 'done' },
      ],
      issues: [],
      decisions: [],
    } as unknown as ProjectBoardState;

    // P1 = 100% weighing its 2 tasks, P2 = 0% weighing 1 (taskless phases enter
    // as one voice, per the spec's "weighted by task count if tasks exist"):
    // (100×2 + 0×1) / 3 = 66.7 → 67. NOT the 100 this file used to assert.
    expect(overallProgress(mixed)).toBe(67);
  });

  it('two taskless phases, one done one not started, average to a plain 50', () => {
    // No tasks anywhere on the board → the spec's "otherwise a simple average".
    const plain = {
      $version: 1,
      project: 'Plain',
      phases: [
        { id: 'P1', title: 'Shipped', status: 'done', progress: 0 },
        { id: 'P2', title: 'Later', status: 'pending', progress: 90 },
      ],
      tasks: [],
      issues: [],
      decisions: [],
    } as unknown as ProjectBoardState;

    expect(overallProgress(plain)).toBe(50);
  });

  it('CRUX: the nassaj-app shape — 1 populated phase + 6 taskless pending reads 23%, not 43%', () => {
    // nassaj-app's live board (read 2026-09-19): 7 phases, one `current` with
    // all 7 task rows (3 done → 43%), six `pending` with none. Dropping the six
    // printed 43% for a project that is 23% along.
    const nassajApp = {
      $version: 1,
      project: 'nassaj-app',
      phases: [
        { id: 'P0', title: 'Now', status: 'current', progress: 0 },
        ...Array.from({ length: 6 }, (_, i) => ({
          id: `P${i + 1}`,
          title: 'Later',
          status: 'pending',
          progress: 0,
        })),
      ],
      tasks: [
        ...Array.from({ length: 3 }, (_, i) => ({
          id: `d-${i}`,
          title: 't',
          phase: 'P0',
          status: 'done',
        })),
        ...Array.from({ length: 4 }, (_, i) => ({
          id: `o-${i}`,
          title: 't',
          phase: 'P0',
          status: 'open',
        })),
      ],
      issues: [],
      decisions: [],
    } as unknown as ProjectBoardState;

    expect(phaseProgress(nassajApp, nassajApp.phases![0])).toBe(43);
    // (43×7 + 0×6) / 13 = 23.2 → 23.
    expect(overallProgress(nassajApp)).toBe(23);
  });

  it('a taskless phase marked done reads 100, not «—»', () => {
    // SampleOne's S0: status "done", no task rows. It is finished; the board must
    // say so instead of shrugging.
    const sampleOneish = {
      $version: 1,
      project: 'SampleOne-ish',
      phases: [{ id: 'S0', title: 'Kickoff', status: 'done', progress: 0 }],
      tasks: [],
      issues: [],
      decisions: [],
    } as unknown as ProjectBoardState;

    expect(phaseProgress(sampleOneish, sampleOneish.phases![0])).toBe(100);
    expect(overallProgress(sampleOneish)).toBe(100);
  });

  it('a taskless phase in flight states nothing — «—», and leaves the average alone', () => {
    const inFlight = {
      $version: 1,
      project: 'InFlight',
      phases: [
        { id: 'P1', title: 'Shipped', status: 'done', progress: 0 },
        { id: 'P2', title: 'Under way, no rows yet', status: 'current', progress: 55 },
      ],
      tasks: [],
      issues: [],
      decisions: [],
    } as unknown as ProjectBoardState;

    expect(phaseProgress(inFlight, inFlight.phases![1])).toBeNull();
    // Only P1 is left to average — the unknown phase neither pads nor drags.
    expect(overallProgress(inFlight)).toBe(100);
  });

  it('derives a taskless phase from the words real boards use, not just the type union', () => {
    // Measured on disk: one external tool writes "planned", another "open",
    // fleet-node "deferred" and "cancelled".
    expect(normalizePhaseStatus('planned').derivedProgress).toBe(0);
    expect(normalizePhaseStatus('open').derivedProgress).toBe(0);
    expect(normalizePhaseStatus('deferred').derivedProgress).toBe(0);
    expect(normalizePhaseStatus('completed').derivedProgress).toBe(100);
    expect(normalizePhaseStatus('in_progress').derivedProgress).toBeNull();
    expect(normalizePhaseStatus('cancelled').bucket).toBe('cancelled');
    // A word nobody has seen before never invents a percentage.
    expect(normalizePhaseStatus('marinating').derivedProgress).toBeNull();
    expect(normalizePhaseStatus('marinating').unknown).toBe(true);
  });

  it('a cancelled phase written as "dropped" leaves the average, like "cancelled"', () => {
    const dropped = {
      $version: 1,
      project: 'Dropped phase',
      phases: [
        { id: 'P1', title: 'Real', status: 'done', progress: 0 },
        { id: 'P2', title: 'Abandoned', status: 'dropped', progress: 0 },
      ],
      tasks: [],
      issues: [],
      decisions: [],
    } as unknown as ProjectBoardState;

    // P2 is out entirely — a 0 here would have halved the figure.
    expect(overallProgress(dropped)).toBe(100);
  });

  it('weights a phase by its NON-cancelled tasks, so dropped rows cannot outvote real ones', () => {
    const weighting = {
      $version: 1,
      project: 'Weighting',
      phases: [
        { id: 'P1', title: 'One real task, ten dropped', status: 'current', progress: 0 },
        { id: 'P2', title: 'Two real tasks', status: 'current', progress: 0 },
      ],
      tasks: [
        { id: 'T-1', title: 'a', phase: 'P1', status: 'done' },
        ...Array.from({ length: 10 }, (_, i) => ({
          id: `x-${i}`,
          title: 't',
          phase: 'P1',
          status: 'wontfix',
        })),
        { id: 'T-2', title: 'b', phase: 'P2', status: 'open' },
        { id: 'T-3', title: 'c', phase: 'P2', status: 'open' },
      ],
      issues: [],
      decisions: [],
    } as unknown as ProjectBoardState;

    // Weights are 1 and 2, not 11 and 2: (100×1 + 0×2) / 3 = 33.
    // Counting the ten dropped rows would have printed 92%.
    expect(overallProgress(weighting)).toBe(33);
  });
});
