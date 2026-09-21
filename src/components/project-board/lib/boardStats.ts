/**
 * Board arithmetic shared by the overview and the tabs split out of it.
 *
 * These functions were inline in BoardOverview.tsx while it was one long page.
 * They moved here unchanged when the page became several tabs — the overview
 * still needs phase/sprint progress for its timeline, and the tasks tab needs
 * the same sprint stats, so a single definition keeps the two from drifting.
 */

import type { BoardPhase, BoardTask, ProjectBoardState } from '../types';

import { normalizeIssueStatus, normalizePhaseStatus, normalizeTaskStatus } from './boardVocabulary';

/**
 * Every count below goes through the vocabulary map rather than comparing the
 * raw string. A board that writes "closed" instead of "done" is stating the same
 * fact, and reading it literally understated SampleTwo's completion by 30 tasks.
 */
const bucketOf = (task: BoardTask) => normalizeTaskStatus(task.status).bucket;

/** DOM anchor for an issue row, target of the bug-task → issue visual link. */
export function issueAnchorId(issueId: string): string {
  return `board-issue-${issueId}`;
}

/** The sprint marked status:"current", or null (v1 files have no sprints). */
export function currentSprintId(state: ProjectBoardState): string | null {
  return (state.sprints ?? []).find((sprint) => sprint.status === 'current')?.id ?? null;
}

/** Completion stats of the tasks assigned to one sprint. */
export function sprintTaskStats(state: ProjectBoardState, sprintId: string) {
  const sprintTasks = (state.tasks ?? []).filter(
    (task) => task.sprint === sprintId && bucketOf(task) !== 'cancelled',
  );
  const done = sprintTasks.filter((task) => bucketOf(task) === 'done').length;
  const total = sprintTasks.length;
  return { done, total, progress: total ? Math.round((done / total) * 100) : 0 };
}

/**
 * Real completion of one phase, computed from the phase's tasks (spec: owner
 * complaint — status:"done" printed 100% on a phase that was 469/781 tasks
 * done, and the file's phases[].progress field drifts from the tasks it is
 * supposed to summarise). Percentage = done ÷ (total − cancelled). Cancelled
 * tasks are excluded from the denominator so a dropped task never drags the
 * bar down. `status:"done"` no longer short-circuits to 100 — a phase marked
 * done with unfinished tasks now reads its real percentage. A phase with no
 * tasks at all has nothing to compute from: `progress` is `null` and
 * `hasTasks` is `false`, never the legacy manual `phases[].progress` field
 * and never a bare 0.
 *
 * This is the TASK-derived figure only. What such a phase should DISPLAY, and
 * what it contributes to the overall bar, is `phaseProgress` below — which
 * falls back to the phase's own status when there are no tasks to read.
 */
export function phaseTaskStats(
  state: ProjectBoardState,
  phase: BoardPhase,
): { done: number; total: number; progress: number | null; hasTasks: boolean } {
  // A cancelled task is dropped from the denominator so it never drags the bar
  // down — including the boards that spell it "wontfix", "dropped" or "rejected".
  const phaseTasks = (state.tasks ?? []).filter(
    (task) => task.phase === phase.id && bucketOf(task) !== 'cancelled',
  );
  const total = phaseTasks.length;
  const done = phaseTasks.filter((task) => bucketOf(task) === 'done').length;

  if (total === 0) {
    return { done: 0, total: 0, progress: null, hasTasks: false };
  }
  return { done, total, progress: Math.round((done / total) * 100), hasTasks: true };
}

/**
 * The percentage one phase should show, tasks first and status only as a last
 * resort (B-1249).
 *
 * - A phase WITH non-cancelled tasks reads those tasks and nothing else. Its
 *   status is a label, not a measurement: `status:"done"` over 472/785 finished
 *   tasks is 60%, not 100% (T-1809).
 * - A phase WITHOUT tasks has no measurement at all, so the status is the only
 *   statement the file makes: closed → 100, not started → 0, in flight →
 *   unknown (`null`, drawn «—»). The hand-written `phases[].progress` field is
 *   never read — it is the figure that drifted in the first place.
 * - `null` means "the file says nothing", and is excluded from the average
 *   rather than counted as zero.
 */
export function phaseProgress(state: ProjectBoardState, phase: BoardPhase): number | null {
  const { progress, hasTasks } = phaseTaskStats(state, phase);
  if (hasTasks) {
    return progress;
  }
  return normalizePhaseStatus(phase.status).derivedProgress;
}

/**
 * Project-wide completion percentage (spec: ~/.claude/wiki/project-board.md,
 * "متوسط progress المراحل غير الملغاة، مرجّحاً بعدد مهام كل مرحلة إن وُجدت مهام،
 * وإلا متوسطاً بسيطاً") — computed in the UI, never read from the file.
 *
 * Average of the non-cancelled phases' `phaseProgress`, where a phase that has
 * tasks weighs its NON-CANCELLED task count and a taskless phase weighs 1. That
 * is the spec's two clauses in one pass: boards whose phases all carry tasks get
 * the weighted average, a board with no tasks anywhere gets the plain average.
 *
 * Dropping taskless phases entirely (the shape this file shipped between
 * T-1809 and B-1249) inflated every real board — nassaj-app, six of whose seven
 * phases are not started and carry no task rows, read 43% instead of 23%. A
 * planned-but-untouched phase is part of the plan and counts as zero; only a
 * phase whose progress is genuinely unknown (in flight with no tasks, or an
 * unrecognised status word) leaves both the sum and the weight.
 *
 * Returns null only when nothing is left to average: no phases, all cancelled,
 * or every remaining phase has an unknown progress.
 */
export function overallProgress(state: ProjectBoardState): number | null {
  const phases = (state.phases ?? []).filter(
    (phase) => normalizePhaseStatus(phase.status).bucket !== 'cancelled',
  );
  if (!phases.length) {
    return null;
  }

  // Cancelled tasks are out of the per-phase percentage, so they must be out of
  // its weight too — otherwise a phase of ten dropped tasks and one real one
  // would pull eleven times its actual substance.
  const taskCounts = new Map<string, number>();
  for (const task of state.tasks ?? []) {
    if (bucketOf(task) === 'cancelled') {
      continue;
    }
    taskCounts.set(task.phase, (taskCounts.get(task.phase) ?? 0) + 1);
  }

  let weightSum = 0;
  let progressSum = 0;
  for (const phase of phases) {
    const progress = phaseProgress(state, phase);
    if (progress === null) {
      continue;
    }
    // A taskless phase has no task count to weigh; it enters as one voice.
    const weight = taskCounts.get(phase.id) ?? 1;
    weightSum += weight;
    progressSum += progress * weight;
  }

  if (weightSum === 0) {
    return null;
  }

  return Math.round(Math.max(0, Math.min(100, progressSum / weightSum)));
}

/**
 * Headline counts for the overview's summary row — the numbers that tell the
 * owner whether a tab is worth opening. `openIssues` is separated from the
 * total because an issue list is only urgent in proportion to what is still open.
 */
export function boardCounts(state: ProjectBoardState) {
  const tasks = state.tasks ?? [];
  const issues = state.issues ?? [];
  return {
    tasks: tasks.length,
    tasksDone: tasks.filter((task) => bucketOf(task) === 'done').length,
    tasksInProgress: tasks.filter((task) => bucketOf(task) === 'in_progress').length,
    issues: issues.length,
    // "Open" here means unresolved — an issue marked `in_progress` is still
    // costing someone something, so it belongs in the number that raises alarm.
    openIssues: issues.filter((issue) => !normalizeIssueStatus(issue.status).resolved).length,
    decisions: (state.decisions ?? []).length,
  };
}
