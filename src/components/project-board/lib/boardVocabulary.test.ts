/**
 * The vocabulary map, pinned against the exact failures measured on three live
 * boards on 2026-07-29 — not against invented words.
 *
 * What was actually wrong, in the owner's words: "النعمان والديوان لا يعرضان
 * اللوحة بشكل جيد". Measured:
 *
 *   AlNuman     31 of 64 tasks (48%) rendered in NO column, and because every
 *               finished task is spelled "closed" rather than "done", the board
 *               reported 0% completion for a project that is 47% done.
 *   nassaj-dev 101 of 553 tasks (18%) invisible: todo, pending, blocked,
 *               backlog, deferred, cancelled.
 *   Diwan         7 of 71 tasks  (9%) invisible; 16 issue rows printed the
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

import { boardCounts, overallProgress, phaseTaskStats } from './boardStats';
import {
  normalizeIssueStatus,
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
    // AlNuman spells every completed task "closed" — 30 of its 64 tasks.
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
    // Diwan: 16 rows rendered the literal text "issues.severity.undefined".
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
  // AlNuman in miniature: work that is finished, spelled the way it spells it.
  const state = {
    $version: 1,
    project: 'AlNuman',
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
});
