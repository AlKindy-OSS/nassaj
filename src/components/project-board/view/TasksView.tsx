import { useTranslation } from 'react-i18next';
import { Bug } from 'lucide-react';

import { cn } from '../../../lib/utils';
import { RunnerTaskDot } from '../../runner/RunnerOverlayBits';
import { currentSprintId, sprintTaskStats } from '../lib/boardStats';
import { normalizeTaskStatus, taskKindStyle } from '../lib/boardVocabulary';
import type { TaskBucket, TaskStatusView } from '../lib/boardVocabulary';
import type { BoardSprint, BoardTask, ProjectBoardState } from '../types';

const TASK_COLUMNS: TaskBucket[] = ['open', 'in_progress', 'done'];

/** Highlighted bar for the single sprint with status="current" (schema 1.1). */
function CurrentSprintBar({ state }: { state: ProjectBoardState }) {
  const { t } = useTranslation('projectBoard');
  const sprint = (state.sprints ?? []).find((entry) => entry.status === 'current');

  if (!sprint) {
    return null;
  }

  const phase = (state.phases ?? []).find((entry) => entry.id === sprint.phase);
  const { done, total, progress } = sprintTaskStats(state, sprint.id);

  return (
    <div className="rounded-xl border border-primary/30 bg-primary/5 p-3.5">
      <div className="flex flex-wrap items-center gap-2">
        <span className="rounded-full bg-primary/10 px-2 py-0.5 text-[11px] font-medium text-primary">
          {t('sprint.current')}
        </span>
        <span className="font-mono text-xs text-muted-foreground">{sprint.id}</span>
        <span className="text-sm font-medium text-foreground">{sprint.goal}</span>
      </div>
      <div className="mt-2.5 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[11px] text-muted-foreground">
        <span className="rounded bg-muted px-1.5 py-0.5 font-mono">{sprint.phase}</span>
        {phase && <span>{phase.title}</span>}
        {sprint.started && <span>{t('sprint.started', { date: sprint.started })}</span>}
        <span className="tabular-nums">{t('sprint.taskCount', { done, total })}</span>
        <span className="flex min-w-32 flex-1 items-center gap-2">
          <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
            <span
              className="block h-full rounded-full bg-primary transition-all"
              style={{ width: `${progress}%` }}
            />
          </span>
          <span className="w-9 text-end tabular-nums">{progress}%</span>
        </span>
      </div>
    </div>
  );
}

/** Collapsed secondary list of planned/done sprints. */
function OtherSprintRow({ sprint, state }: { sprint: BoardSprint; state: ProjectBoardState }) {
  const { t } = useTranslation('projectBoard');
  const { done, total } = sprintTaskStats(state, sprint.id);

  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border/60 bg-card px-3 py-2">
      <span className="font-mono text-[10px] text-muted-foreground">{sprint.id}</span>
      <span
        className={cn(
          'rounded-full border px-2 py-0.5 text-[10px] font-medium',
          sprint.status === 'done'
            ? 'border-green-500/30 bg-green-500/10 text-green-600 dark:text-green-400'
            : 'bg-muted text-muted-foreground border-border',
        )}
      >
        {t(`sprint.status.${sprint.status}`, { defaultValue: sprint.status })}
      </span>
      <span className="text-xs text-foreground">{sprint.goal}</span>
      <span className="ms-auto flex items-center gap-3 text-[10px] tabular-nums text-muted-foreground">
        <span className="font-mono">{sprint.phase}</span>
        {sprint.ended && <span>{t('sprint.ended', { date: sprint.ended })}</span>}
        <span>{t('sprint.taskCount', { done, total })}</span>
      </span>
    </div>
  );
}

function SprintsSection({ state }: { state: ProjectBoardState }) {
  const { t } = useTranslation('projectBoard');
  const sprints = state.sprints ?? [];
  const others = sprints.filter((sprint) => sprint.status !== 'current');

  // v1 file (no sprints array) → render nothing, board looks exactly as before.
  if (!sprints.length) {
    return null;
  }

  return (
    <section className="space-y-2">
      <CurrentSprintBar state={state} />
      {others.length > 0 && (
        <details className="group">
          <summary className="cursor-pointer select-none text-xs font-medium text-muted-foreground transition-colors hover:text-foreground">
            {t('sprint.others', { count: others.length })}
          </summary>
          <div className="mt-2 space-y-2">
            {others.map((sprint) => (
              <OtherSprintRow key={sprint.id} sprint={sprint} state={state} />
            ))}
          </div>
        </details>
      )}
    </section>
  );
}

type TaskCardProps = {
  task: BoardTask;
  status: TaskStatusView;
  currentSprint: string | null;
  onIssueClick: (issueId: string) => void;
  runnerActiveTaskId?: string | null;
};

function TaskCard({ task, status, currentSprint, onIssueClick, runnerActiveTaskId }: TaskCardProps) {
  const { t } = useTranslation('projectBoard');
  const kindStyle = taskKindStyle(task.kind);

  return (
    <div className="rounded-lg border border-border/60 bg-card p-2.5">
      <div className="flex items-start justify-between gap-2">
        <p
          className={cn(
            'text-xs text-foreground',
            (status.bucket === 'done' || status.bucket === 'cancelled') && 'text-muted-foreground',
            status.bucket === 'cancelled' && 'line-through',
          )}
        >
          {task.title}
        </p>
        <span className="flex flex-shrink-0 items-center gap-1.5 font-mono text-[10px] text-muted-foreground">
          {task.id}
          <RunnerTaskDot taskId={task.id} activeTaskId={runnerActiveTaskId} />
        </span>
      </div>
      <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[10px] text-muted-foreground">
        {kindStyle && (
          <span className={cn('rounded-full border px-1.5 py-0.5 font-medium', kindStyle)}>
            {t(`tasksSection.kind.${task.kind}`, { defaultValue: task.kind })}
          </span>
        )}
        {/* The file's own word, kept whenever the column header does not already
            say it — "blocked" and "deferred" sit in the open column but are not
            the same as untouched, and an unmapped word must stay readable. */}
        {!status.redundant && (
          <span
            className={cn(
              'rounded-full border px-1.5 py-0.5 font-medium',
              status.needsAttention
                ? 'border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400'
                : 'border-border bg-muted',
            )}
          >
            {t(`tasksSection.status.${status.raw}`, { defaultValue: status.raw })}
          </span>
        )}
        {task.issue && (
          <button
            type="button"
            onClick={() => onIssueClick(task.issue as string)}
            title={t('tasksSection.issueLink', { id: task.issue })}
            aria-label={t('tasksSection.issueLink', { id: task.issue })}
            className="inline-flex items-center gap-1 rounded-full border border-destructive/30 bg-destructive/10 px-1.5 py-0.5 font-mono font-medium text-destructive transition-colors hover:bg-destructive/20"
          >
            <Bug className="h-2.5 w-2.5" />
            {task.issue}
          </button>
        )}
        <span className="rounded bg-muted px-1.5 py-0.5 font-mono">{task.phase}</span>
        {task.sprint && (
          <span
            className={cn(
              'rounded px-1.5 py-0.5 font-mono',
              task.sprint === currentSprint ? 'bg-primary/10 text-primary' : 'bg-muted',
            )}
          >
            {task.sprint}
          </span>
        )}
        {task.owner && <span>{task.owner}</span>}
        {task.closed && <span>{task.closed}</span>}
      </div>
    </div>
  );
}

/**
 * Sort weight inside a column: current-sprint tasks first, then tasks
 * scheduled in other sprints, then backlog (no sprint). With no current
 * sprint (v1 files) every task weighs the same and the order is unchanged.
 */
function taskSprintWeight(task: BoardTask, currentSprint: string | null): number {
  if (currentSprint && task.sprint === currentSprint) return 0;
  return task.sprint ? 1 : 2;
}

type TasksViewProps = {
  state: ProjectBoardState;
  /** Jumps to the issues tab and flashes the linked issue row. */
  onIssueClick: (issueId: string) => void;
  runnerActiveTaskId?: string | null;
};

/**
 * "Tasks" tab — the kanban board plus the sprints that schedule it.
 *
 * Sprints live here rather than in the overview because a sprint IS a slice of
 * this board: its bar reads "12/30 tasks", and the tasks it counts are the
 * cards directly below. Splitting them across tabs would put a number in one
 * place and its evidence in another.
 */
export default function TasksView({ state, onIssueClick, runnerActiveTaskId }: TasksViewProps) {
  const { t } = useTranslation('projectBoard');
  const tasks = state.tasks ?? [];
  const currentSprint = currentSprintId(state);

  // Bucket ONCE, then draw. Filtering each column on `task.status === column`
  // is what made 48% of one project's tasks render nowhere at all.
  const rows = tasks.map((task) => ({ task, status: normalizeTaskStatus(task.status) }));
  const cancelled = rows.filter((row) => row.status.bucket === 'cancelled');

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-4xl space-y-6 px-4 py-5 sm:px-6">
        <SprintsSection state={state} />

        {tasks.length ? (
          <section>
            <h3 className="mb-3 text-sm font-semibold text-foreground">{t('tasksSection.title')}</h3>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              {TASK_COLUMNS.map((column) => {
                const columnTasks = rows
                  .filter((row) => row.status.bucket === column)
                  .sort(
                    (a, b) =>
                      taskSprintWeight(a.task, currentSprint) -
                      taskSprintWeight(b.task, currentSprint),
                  );

                return (
                  <div key={column} className="rounded-xl border border-border/60 bg-muted/30 p-2.5">
                    <div className="mb-2 flex items-center justify-between px-1">
                      <span className="text-xs font-medium text-foreground">
                        {t(`tasksSection.${column}`)}
                      </span>
                      <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] tabular-nums text-muted-foreground">
                        {columnTasks.length}
                      </span>
                    </div>
                    <div className="space-y-2">
                      {columnTasks.length ? (
                        columnTasks.map(({ task, status }) => (
                          <TaskCard
                            key={task.id}
                            task={task}
                            status={status}
                            currentSprint={currentSprint}
                            onIssueClick={onIssueClick}
                            runnerActiveTaskId={runnerActiveTaskId}
                          />
                        ))
                      ) : (
                        <p className="px-1 py-2 text-center text-[11px] text-muted-foreground">
                          {t('tasksSection.empty')}
                        </p>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>

            {/* Cancelled work: excluded from the columns and from every
                percentage, but NOT from the page — a dropped task the owner can
                no longer find reads as a task that was lost. */}
            {cancelled.length > 0 && (
              <details className="group mt-3">
                <summary className="cursor-pointer select-none text-xs font-medium text-muted-foreground transition-colors hover:text-foreground">
                  {t('tasksSection.cancelled', {
                    defaultValue: 'Cancelled ({{count}})',
                    count: cancelled.length,
                  })}
                </summary>
                <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-3">
                  {cancelled.map(({ task, status }) => (
                    <TaskCard
                      key={task.id}
                      task={task}
                      status={status}
                      currentSprint={currentSprint}
                      onIssueClick={onIssueClick}
                      runnerActiveTaskId={runnerActiveTaskId}
                    />
                  ))}
                </div>
              </details>
            )}
          </section>
        ) : (
          <p className="rounded-lg border border-dashed border-border/60 px-3 py-6 text-center text-[11px] text-muted-foreground">
            {t('tasksSection.empty')}
          </p>
        )}
      </div>
    </div>
  );
}
