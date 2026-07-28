/**
 * Board arithmetic shared by the overview and the tabs split out of it.
 *
 * These functions were inline in BoardOverview.tsx while it was one long page.
 * They moved here unchanged when the page became several tabs — the overview
 * still needs phase/sprint progress for its timeline, and the tasks tab needs
 * the same sprint stats, so a single definition keeps the two from drifting.
 */

import type { BoardPhase, BoardTask, ProjectBoardState } from '../types';

import { normalizeIssueStatus, normalizeTaskStatus } from './boardVocabulary';

/**
 * Every count below goes through the vocabulary map rather than comparing the
 * raw string. A board that writes "closed" instead of "done" is stating the same
 * fact, and reading it literally understated AlNuman's completion by 30 tasks.
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
 * complaint — the file's phases[].progress was stale and contradicted the tasks).
 * Percentage = done ÷ (total − cancelled). Cancelled tasks are excluded from the
 * denominator so a dropped task never drags the bar down. A phase marked
 * status:"done" always reads 100%. When the phase has no tasks at all we fall
 * back to the legacy phases[].progress field (`hasTasks=false`), so phase-only
 * (taskless) boards keep rendering exactly as before.
 */
export function phaseTaskStats(
  state: ProjectBoardState,
  phase: BoardPhase,
): { done: number; total: number; progress: number; hasTasks: boolean } {
  // A cancelled task is dropped from the denominator so it never drags the bar
  // down — including the boards that spell it "wontfix", "dropped" or "rejected".
  const phaseTasks = (state.tasks ?? []).filter(
    (task) => task.phase === phase.id && bucketOf(task) !== 'cancelled',
  );
  const total = phaseTasks.length;
  const done = phaseTasks.filter((task) => bucketOf(task) === 'done').length;

  if (phase.status === 'done') {
    return { done, total, progress: 100, hasTasks: total > 0 };
  }
  if (total === 0) {
    // No tasks for this phase → use the legacy manual progress field as fallback.
    const legacy = Math.max(0, Math.min(100, Number(phase.progress) || 0));
    return { done: 0, total: 0, progress: legacy, hasTasks: false };
  }
  return { done, total, progress: Math.round((done / total) * 100), hasTasks: true };
}

/**
 * Project-wide completion percentage (spec: ~/.claude/wiki/project-board.md) —
 * computed in the UI, never read from the file. Average of the non-cancelled
 * phases' progress, weighted by each phase's task count when the project has
 * tasks (a phase without tasks weighs 1 so it is not zeroed out), simple
 * average otherwise. Done phases count as 100, matching the phase bars.
 * Returns null when there is nothing to average (no phases / all cancelled).
 */
export function overallProgress(state: ProjectBoardState): number | null {
  const phases = (state.phases ?? []).filter((phase) => phase.status !== 'cancelled');
  if (!phases.length) {
    return null;
  }

  const tasks = state.tasks ?? [];
  const taskCounts = new Map<string, number>();
  for (const task of tasks) {
    taskCounts.set(task.phase, (taskCounts.get(task.phase) ?? 0) + 1);
  }

  let weightSum = 0;
  let progressSum = 0;
  for (const phase of phases) {
    // Real progress from the phase's tasks (falls back to phases[].progress only
    // when the phase has no tasks) — keeps the overall bar consistent with the
    // per-phase bars below, which now also derive from tasks.
    const progress = phaseTaskStats(state, phase).progress;
    const weight = tasks.length ? Math.max(1, taskCounts.get(phase.id) ?? 0) : 1;
    weightSum += weight;
    progressSum += progress * weight;
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
