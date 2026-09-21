import { useTranslation } from 'react-i18next';
import {
  Bug,
  CheckCircle2,
  Circle,
  CircleDot,
  FileText,
  KanbanSquare,
  XCircle,
} from 'lucide-react';

import { cn } from '../../../lib/utils';
import { boardCounts, overallProgress, phaseProgress, phaseTaskStats } from '../lib/boardStats';
import { normalizePhaseStatus } from '../lib/boardVocabulary';
import type { ProjectBoardState } from '../types';

/** The tabs the overview's summary row can send the reader to. */
export type OverviewTarget = 'tasks' | 'issues' | 'decisions';

type BoardOverviewProps = {
  state: ProjectBoardState;
  /** Opens one of the tabs split out of this page. */
  onNavigate?: (target: OverviewTarget) => void;
};

function PhaseTimeline({ state }: { state: ProjectBoardState }) {
  const { t } = useTranslation('projectBoard');

  if (!state.phases?.length) {
    return null;
  }

  return (
    <section>
      <h3 className="mb-3 text-sm font-semibold text-foreground">{t('phases.title')}</h3>
      <ol className="relative space-y-0 border-s-2 border-border ps-5">
        {state.phases.map((phase) => {
          // Read through the same vocabulary the arithmetic uses, so a board
          // that writes "planned"/"open"/"deferred" gets the marker its state
          // deserves instead of a blank node (no new styles, just wider reach).
          const phaseState = normalizePhaseStatus(phase.status).bucket;
          // The phase the plan marks status:"current", shown as a «planned» chip.
          const isPlannedCurrent = phaseState === 'current';
          const { done, total, hasTasks } = phaseTaskStats(state, phase);
          // Tasks when there are tasks, the phase's own status when there are
          // none, «—» only when neither states anything (B-1249).
          const progress = phaseProgress(state, phase);

          return (
            <li key={phase.id} className="relative pb-5 last:pb-0">
              <span
                className={cn(
                  'absolute -start-[1.65rem] top-0.5 flex h-5 w-5 items-center justify-center rounded-full border-2 bg-background',
                  phaseState === 'done' && 'border-green-500 text-green-500',
                  isPlannedCurrent && 'border-primary text-primary',
                  phaseState === 'pending' && 'border-border text-muted-foreground',
                  phaseState === 'cancelled' && 'border-border text-muted-foreground',
                )}
              >
                {phaseState === 'done' && <CheckCircle2 className="h-3.5 w-3.5" />}
                {phaseState !== 'done' && isPlannedCurrent && (
                  <CircleDot className="h-3.5 w-3.5" />
                )}
                {phaseState === 'pending' && !isPlannedCurrent && (
                  <Circle className="h-3 w-3" />
                )}
                {phaseState === 'cancelled' && <XCircle className="h-3.5 w-3.5" />}
              </span>

              <div className="flex flex-wrap items-center gap-2">
                <span className="font-mono text-xs text-muted-foreground">{phase.id}</span>
                <span
                  className={cn(
                    'text-sm font-medium',
                    phaseState === 'cancelled'
                      ? 'text-muted-foreground line-through'
                      : 'text-foreground',
                  )}
                >
                  {phase.title}
                </span>
                {isPlannedCurrent && (
                  <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
                    {t('phases.planned')}
                  </span>
                )}
              </div>

              <div className="mt-2 flex max-w-md items-center gap-2">
                <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
                  {/* A phase whose progress nothing states — in flight with no
                      tasks — has no percentage to fill the bar with: an empty
                      track, not a fabricated 0%. */}
                  {progress !== null && (
                    <div
                      className={cn(
                        'h-full rounded-full transition-all',
                        progress === 100 ? 'bg-green-500' : 'bg-primary',
                      )}
                      style={{ width: `${progress}%` }}
                    />
                  )}
                </div>
                {/* «N% (done/total)» when tasks are the source. A taskless phase
                    has no counts to show, so it prints the bare percentage its
                    status states — and «—» when the status states nothing. */}
                <span className="text-end text-[11px] tabular-nums text-muted-foreground">
                  {hasTasks
                    ? t('phases.progressCount', { progress, done, total })
                    : progress !== null
                      ? `${progress}%`
                      : '—'}
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
 * "Overview" tab — the project at a glance: how far along it is and how the
 * phases are progressing.
 *
 * It used to carry the task board, every issue and every decision as well. On a
 * real board that is hundreds of rows in one scroll, which buries the two things
 * an overview exists to answer — how far along, and what is happening now. Those
 * lists are tabs of their own; what stays here is the glance, plus counters that
 * lead to them.
 */
export default function BoardOverview({ state, onNavigate }: BoardOverviewProps) {
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

        <PhaseTimeline state={state} />
      </div>
    </div>
  );
}
