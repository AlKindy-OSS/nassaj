import { useTranslation } from 'react-i18next';
import {
  Bot,
  Bug,
  CheckCircle2,
  Circle,
  CircleDot,
  FileText,
  KanbanSquare,
  XCircle,
} from 'lucide-react';

import { cn } from '../../../lib/utils';
import RunnerJourney from '../../runner/RunnerJourney';
import RunnerStatusLine from '../../runner/RunnerStatusLine';
import type { CycleHistory } from '../../runner/useRunner';
import { boardCounts, overallProgress, phaseTaskStats } from '../lib/boardStats';
import type { ProjectBoardState } from '../types';

/** The tabs the overview's summary row can send the reader to. */
export type OverviewTarget = 'tasks' | 'issues' | 'decisions';

type BoardOverviewProps = {
  state: ProjectBoardState;
  /** Opens one of the tabs split out of this page. */
  onNavigate?: (target: OverviewTarget) => void;
  /** Runner overlay (ADR-RUNNER-BRIDGE-001): the task/phase the running session
   *  currently targets, from the runner's activity.json. All optional → the
   *  board is unchanged when the runner is idle or absent. */
  runnerActivePhaseId?: string | null;
  runnerRunning?: boolean;
  /** Cycle journey log for the MinwalJourney section. null → section hidden. */
  runnerHistory?: CycleHistory | null;
  /** True when the project is registered with the runner. */
  runnerRegistered?: boolean;
  /**
   * supervisor.session.exit_reason — forwarded to RunnerJourney to suppress
   * the «may be frozen» warning when the session has already ended.
   */
  runnerSessionExitReason?: string | null;
};

function PhaseTimeline({
  state,
  runnerActivePhaseId,
  runnerRunning,
}: {
  state: ProjectBoardState;
  runnerActivePhaseId?: string | null;
  runnerRunning?: boolean;
}) {
  const { t } = useTranslation('projectBoard');

  if (!state.phases?.length) {
    return null;
  }

  return (
    <section>
      <h3 className="mb-3 text-sm font-semibold text-foreground">{t('phases.title')}</h3>
      <ol className="relative space-y-0 border-s-2 border-border ps-5">
        {state.phases.map((phase) => {
          // Planned-current: the phase the plan marks status:"current". Kept as a
          // muted «planned» chip so it never competes with the live runner marker.
          const isPlannedCurrent = phase.status === 'current';
          // The single, unambiguous answer to «where is the runner?»: the phase
          // the runner is actually working on right now (checkpoint pointer).
          const isRunnerHere = Boolean(runnerRunning) && runnerActivePhaseId === phase.id;
          const { done, total, progress, hasTasks } = phaseTaskStats(state, phase);

          return (
            <li key={phase.id} className="relative pb-5 last:pb-0">
              <span
                className={cn(
                  'absolute -start-[1.65rem] top-0.5 flex h-5 w-5 items-center justify-center rounded-full border-2 bg-background',
                  phase.status === 'done' && 'border-green-500 text-green-500',
                  isRunnerHere && 'border-sky-500 text-sky-500',
                  isPlannedCurrent && !isRunnerHere && 'border-primary text-primary',
                  phase.status === 'pending' && !isRunnerHere && 'border-border text-muted-foreground',
                  phase.status === 'cancelled' && 'border-border text-muted-foreground',
                )}
              >
                {phase.status === 'done' && <CheckCircle2 className="h-3.5 w-3.5" />}
                {phase.status !== 'done' && isRunnerHere && (
                  <Bot className="h-3.5 w-3.5 motion-safe:animate-pulse" />
                )}
                {phase.status !== 'done' && !isRunnerHere && isPlannedCurrent && (
                  <CircleDot className="h-3.5 w-3.5" />
                )}
                {phase.status === 'pending' && !isRunnerHere && !isPlannedCurrent && (
                  <Circle className="h-3 w-3" />
                )}
                {phase.status === 'cancelled' && <XCircle className="h-3.5 w-3.5" />}
              </span>

              <div className="flex flex-wrap items-center gap-2">
                <span className="font-mono text-xs text-muted-foreground">{phase.id}</span>
                <span
                  className={cn(
                    'text-sm font-medium',
                    phase.status === 'cancelled'
                      ? 'text-muted-foreground line-through'
                      : 'text-foreground',
                  )}
                >
                  {phase.title}
                </span>
                {/* Live runner marker — the clear «🔵 al-Minwāl here» badge. */}
                {isRunnerHere && (
                  <span className="inline-flex items-center gap-1.5 rounded-full border border-sky-500/40 bg-sky-500/10 px-2 py-0.5 text-[11px] font-medium text-sky-600 dark:text-sky-400">
                    <span
                      aria-hidden="true"
                      className="inline-block h-1.5 w-1.5 rounded-full bg-current motion-safe:animate-pulse"
                    />
                    <Bot className="h-3 w-3" aria-hidden="true" />
                    {t('phases.runnerHere')}
                  </span>
                )}
                {/* Planning «current» kept muted as «planned», suppressed when the
                    runner marker is already on this phase to avoid double signals. */}
                {isPlannedCurrent && !isRunnerHere && (
                  <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
                    {t('phases.planned')}
                  </span>
                )}
              </div>

              <div className="mt-2 flex max-w-md items-center gap-2">
                <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
                  <div
                    className={cn(
                      'h-full rounded-full transition-all',
                      phase.status === 'done'
                        ? 'bg-green-500'
                        : isRunnerHere
                          ? 'bg-sky-500'
                          : 'bg-primary',
                    )}
                    style={{ width: `${progress}%` }}
                  />
                </div>
                {/* «N% (done/total)» — the real, task-derived figure. The count is
                    omitted for taskless phases that fall back to manual progress. */}
                <span className="text-end text-[11px] tabular-nums text-muted-foreground">
                  {hasTasks
                    ? t('phases.progressCount', { progress, done, total })
                    : `${progress}%`}
                </span>
              </div>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

/**
 * One summary tile: a headline count, a caption, and the tab it opens.
 *
 * The tiles exist because the tasks/issues/decisions lists left this page. A
 * split that only hides things costs the reader the glance they used to get by
 * scrolling — the tile gives that glance back and turns it into the way in.
 */
function SummaryTile({
  icon,
  value,
  detail,
  label,
  tone,
  onClick,
}: {
  icon: React.ReactNode;
  value: number;
  detail?: string;
  label: string;
  tone?: 'alert';
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={!onClick}
      className={cn(
        'flex flex-1 items-center gap-3 rounded-xl border border-border/60 bg-card px-3.5 py-3 text-start transition-colors',
        onClick && 'hover:border-border hover:bg-accent',
        !onClick && 'cursor-default',
      )}
    >
      <span
        className={cn(
          'flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg',
          tone === 'alert'
            ? 'bg-amber-500/10 text-amber-600 dark:text-amber-400'
            : 'bg-muted text-muted-foreground',
        )}
      >
        {icon}
      </span>
      <span className="min-w-0">
        <span className="flex items-baseline gap-1.5">
          <span className="text-lg font-semibold tabular-nums leading-none text-foreground">
            {value}
          </span>
          {detail && (
            <span className="truncate text-[11px] tabular-nums text-muted-foreground">{detail}</span>
          )}
        </span>
        <span className="mt-1 block truncate text-xs text-muted-foreground">{label}</span>
      </span>
    </button>
  );
}

/**
 * "Overview" tab — the project at a glance: how far along it is, where the
 * runner stands, and how the phases are progressing.
 *
 * It used to carry the task board, every issue and every decision as well. On a
 * real board that is hundreds of rows in one scroll, which buries the two things
 * an overview exists to answer — how far along, and what is happening now. Those
 * lists are tabs of their own; what stays here is the glance, plus counters that
 * lead to them.
 */
export default function BoardOverview({
  state,
  onNavigate,
  runnerActivePhaseId,
  runnerRunning,
  runnerHistory,
  runnerRegistered,
  runnerSessionExitReason,
}: BoardOverviewProps) {
  const { t } = useTranslation('projectBoard');
  const overall = overallProgress(state);
  const counts = boardCounts(state);

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-4xl space-y-8 px-4 py-5 sm:px-6">
        <header>
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="text-base font-semibold text-foreground">{state.project}</h2>
            {state.updated && (
              <span className="text-xs text-muted-foreground">
                {t('updated', { date: state.updated })}
              </span>
            )}
          </div>
          {overall !== null && (
            <div className="mt-3 flex items-center gap-3">
              <span className="text-xs font-medium text-muted-foreground">
                {t('overallProgress')}
              </span>
              <div
                role="progressbar"
                aria-label={t('overallProgress')}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={overall}
                className="h-2 flex-1 overflow-hidden rounded-full bg-muted"
              >
                <div
                  className={cn(
                    'h-full rounded-full transition-all',
                    overall === 100 ? 'bg-green-500' : 'bg-primary',
                  )}
                  style={{ width: `${overall}%` }}
                />
              </div>
              <span className="text-sm font-semibold tabular-nums text-foreground">
                {overall}%
              </span>
            </div>
          )}
        </header>

        {/* The glance that replaces the scroll: counts of what moved to its own tab. */}
        <div className="flex flex-col gap-3 sm:flex-row">
          <SummaryTile
            icon={<KanbanSquare className="h-4 w-4" />}
            value={counts.tasks}
            detail={t('summary.tasksDone', {
              defaultValue: '{{done}} done',
              done: counts.tasksDone,
            })}
            label={t('sections.tasks', { defaultValue: 'Tasks' })}
            onClick={onNavigate ? () => onNavigate('tasks') : undefined}
          />
          <SummaryTile
            icon={<Bug className="h-4 w-4" />}
            value={counts.issues}
            detail={t('summary.issuesOpen', {
              defaultValue: '{{open}} open',
              open: counts.openIssues,
            })}
            label={t('sections.issues', { defaultValue: 'Issues' })}
            tone={counts.openIssues > 0 ? 'alert' : undefined}
            onClick={onNavigate ? () => onNavigate('issues') : undefined}
          />
          <SummaryTile
            icon={<FileText className="h-4 w-4" />}
            value={counts.decisions}
            label={t('sections.decisions', { defaultValue: 'Decisions' })}
            onClick={onNavigate ? () => onNavigate('decisions') : undefined}
          />
        </div>

        {/* Explicit one-line runner status — «where is al-Minwāl right now».
            Additive: renders null unless the project is registered with it. */}
        <RunnerStatusLine
          phases={state.phases ?? []}
          history={runnerHistory ?? null}
          registered={Boolean(runnerRegistered)}
          sessionExitReason={runnerSessionExitReason ?? null}
        />

        <PhaseTimeline
          state={state}
          runnerActivePhaseId={runnerActivePhaseId}
          runnerRunning={runnerRunning}
        />
        {/* Runner journey overlay — additive, hidden when runner absent or no history */}
        <RunnerJourney
          phases={state.phases ?? []}
          history={runnerHistory ?? null}
          registered={Boolean(runnerRegistered)}
          sessionExitReason={runnerSessionExitReason ?? null}
        />
      </div>
    </div>
  );
}
