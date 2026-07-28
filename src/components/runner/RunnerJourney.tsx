/**
 * RunnerJourney — «مسار المِنوال عبر المراحل»
 * ==============================================
 *
 * Compact history log for the runner's cycle journey. Shows:
 *   1. A header pill: «المِنوال عند المرحلة X» with live/idle state.
 *   2. A flat list of cycle cards (most-recent last).
 *
 * Phase progress bars are intentionally NOT shown here — they are already
 * rendered by PhaseTimeline above. This avoids visual duplication.
 *
 * Design brief: docs/design/minwal-journey-brief.md
 * Data contract: runner-bridge.service.ts → RunnerStatus.history (CycleHistory)
 * ADR-RUNNER-BRIDGE-001: read-only. Never writes runner files.
 *
 * Additive: renders null unless `registered && history != null`.
 * The board is byte-for-byte unchanged for projects with no runner.
 *
 * RTL-first: logical properties (border-s, ps, -start-*) throughout.
 * a11y: color is never the sole signal; aria-live on the live indicator;
 *       animate-pulse wrapped in motion-safe:.
 */

import { useTranslation } from 'react-i18next';
import {
  Activity,
  Bot,
  CheckCircle2,
  Circle,
  Pause,
  XCircle,
} from 'lucide-react';

import { cn } from '../../lib/utils';
import type { BoardPhase } from '../project-board/types';

import type { CycleHistory, CycleRecord, CycleStageResult } from './useRunner';
import { UI_STATE_STYLES } from './runnerStatus';

// ─── constants ───────────────────────────────────────────────────────────────

/** After this many seconds without a heartbeat we consider the runner stale. */
const STALE_THRESHOLD_S = 180; // 3 × typical 60s tick

// ─── types ───────────────────────────────────────────────────────────────────

export type RunnerJourneyProps = {
  /** Board phases from docs/project-state.json — used only to look up the
   *  current-phase title for the header; progress bars are NOT re-rendered here. */
  phases: BoardPhase[];
  /**
   * Cycle journey log. null → section is hidden entirely (project not yet
   * registered / file absent). Passed from useRunner via ProjectBoardPanel.
   */
  history: CycleHistory | null;
  /** True when the runner is registered with this project (guard). */
  registered: boolean;
  /**
   * supervisor.session.exit_reason — used to suppress «may be frozen» when
   * the session has already ended (clean exit, OOM, etc.).
   * Omit / null when the supervisor has not started yet.
   */
  sessionExitReason?: string | null;
};

// ─── helpers ─────────────────────────────────────────────────────────────────

/** Seconds since a timestamp string. Returns Infinity on bad input. */
function secondsSince(iso: string | null | undefined): number {
  if (!iso) return Infinity;
  const diff = (Date.now() - new Date(iso).getTime()) / 1000;
  return isFinite(diff) ? diff : Infinity;
}

/**
 * True if a *running* session has a stale heartbeat (runner might be frozen).
 * Returns false when exitReason is set — the session already ended cleanly or
 * with an error; "may be frozen" does not apply to a finished process.
 */
function isHeartbeatStale(
  heartbeatAt: string | null | undefined,
  exitReason: string | null | undefined,
): boolean {
  // Session has an exit_reason → it is done (clean, failed, etc.), not frozen.
  if (exitReason != null) return false;
  return secondsSince(heartbeatAt) > STALE_THRESHOLD_S;
}

/** Tailwind classes for a cycle/stage status token. */
function cycleStatusClasses(status: string | undefined): string {
  switch (status) {
    case 'succeeded':
    case 'ok':
    case 'clean':
      return 'border-green-500/30 bg-green-500/10 text-green-600 dark:text-green-400';
    case 'failed':
    case 'unclean':
      return 'border-destructive/30 bg-destructive/10 text-destructive';
    case 'interrupted':
      return 'border-yellow-500/30 bg-yellow-500/10 text-yellow-700 dark:text-yellow-400';
    case 'running':
      return 'border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400';
    case 'awaiting':
      return 'border-blue-500/30 bg-blue-500/10 text-blue-600 dark:text-blue-400';
    case 'skipped':
    case 'pending':
    default:
      return 'border-border bg-muted text-muted-foreground';
  }
}

/** Icon for a cycle status. Accompanies the color so color is not the sole signal. */
function CycleStatusIcon({ status, className }: { status: string | undefined; className?: string }) {
  const cls = cn('h-3 w-3 flex-shrink-0', className);
  switch (status) {
    case 'succeeded':
    case 'ok':
    case 'clean':
      return <CheckCircle2 className={cls} />;
    case 'failed':
    case 'unclean':
      return <XCircle className={cls} />;
    case 'interrupted':
      return <Pause className={cls} />;
    case 'running':
      return <Activity className={cls} />;
    default:
      return <Circle className={cls} />;
  }
}

// ─── sub-components ──────────────────────────────────────────────────────────

/**
 * Four stage dots: build → verify → verdict → gate.
 * Each dot is aria-hidden (decorative); the parent card carries the full label.
 */
function StageDots({
  stages,
  currentStage,
  isCurrentCycle,
}: {
  stages: CycleRecord['stages'] | undefined;
  currentStage: string | undefined;
  isCurrentCycle: boolean;
}) {
  const { t } = useTranslation('projectBoard');
  const STAGE_KEYS = ['build', 'verify', 'verdict', 'gate'] as const;

  return (
    <div className="mt-2 flex items-center gap-2" role="list" aria-label={t('runner.journey.phasesLabel')}>
      {STAGE_KEYS.map((key) => {
        const result: CycleStageResult | undefined = stages?.[key];
        const isActive = isCurrentCycle && currentStage === key;
        const status = result?.status ?? (isActive ? 'running' : 'pending');
        const label = t(`runner.journey.stage.${key}`);
        const modelLabel = result?.model ? ` · ${result.model}` : '';

        return (
          <div
            key={key}
            role="listitem"
            className="flex items-center gap-1"
            title={`${label}${modelLabel}`}
          >
            <span
              aria-hidden="true"
              className={cn(
                'h-2 w-2 rounded-full border',
                cycleStatusClasses(status),
                isActive && 'motion-safe:animate-pulse',
              )}
            />
            <span className="text-[10px] text-muted-foreground">{label}</span>
          </div>
        );
      })}
    </div>
  );
}

/** Full expanded card for a single cycle. */
function CycleCard({
  cycle,
  isCurrentCycle,
  currentStage,
  isStale,
}: {
  cycle: CycleRecord;
  isCurrentCycle: boolean;
  currentStage?: string;
  isStale?: boolean;
}) {
  const { t } = useTranslation('projectBoard');
  const n = cycle.cycle ?? '?';
  const status = cycle.status ?? (isCurrentCycle ? 'running' : 'pending');
  const taskId = cycle.task_id;
  const taskTitle = cycle.task_title;

  return (
    <div
      className={cn(
        'rounded-lg border p-2.5',
        isCurrentCycle
          ? 'border-primary/30 bg-primary/5'
          : 'border-border/60 bg-card',
      )}
      aria-label={t('runner.journey.cycleN', { n }) + (taskId ? ` · ${taskId}` : '')}
    >
      <div className="flex flex-wrap items-center gap-2">
        {/* Cycle number */}
        <span className="font-mono text-[10px] text-muted-foreground" dir="ltr">
          {t('runner.journey.cycleN', { n })}
        </span>

        {/* Task or phase ref */}
        {taskId && (
          <span className="font-mono text-[10px] text-muted-foreground" dir="ltr">
            {taskId}
          </span>
        )}
        {taskTitle && (
          <span className="text-xs text-foreground">{taskTitle}</span>
        )}

        {/* Status badge */}
        <span
          className={cn(
            'ms-auto inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-medium',
            cycleStatusClasses(status),
          )}
        >
          <CycleStatusIcon status={status} />
          {isCurrentCycle
            ? t(`runner.status.${status}`, { defaultValue: status })
            : t(`runner.journey.cycleStatus.${status}`, { defaultValue: status })}
        </span>

        {/* «هنا» indicator for current cycle */}
        {isCurrentCycle && (
          <span className="inline-flex items-center gap-1 rounded-full border border-primary/30 bg-primary/10 px-2 py-0.5 text-[10px] font-medium text-primary">
            <span
              aria-hidden="true"
              className="inline-block h-1.5 w-1.5 rounded-full bg-current motion-safe:animate-pulse"
            />
            {t('runner.journey.here')}
          </span>
        )}
      </div>

      {/* Stale warning */}
      {isCurrentCycle && isStale && (
        <p className="mt-1 text-[10px] text-muted-foreground">
          {t('runner.journey.stale')}
        </p>
      )}

      {/* Stage dots — shown for current cycle always; for closed cycles on expand */}
      {isCurrentCycle && (
        <StageDots
          stages={cycle.stages}
          currentStage={currentStage}
          isCurrentCycle={isCurrentCycle}
        />
      )}
    </div>
  );
}

// ─── main component ───────────────────────────────────────────────────────────

/**
 * RunnerJourney — مسار المِنوال عبر المراحل
 *
 * Placed in BoardOverview, below PhaseTimeline, visible only when
 * `registered && history != null`.
 */
export default function RunnerJourney({ phases, history, registered, sessionExitReason }: RunnerJourneyProps) {
  const { t } = useTranslation('projectBoard');

  // Guard: additive, never shown unless runner is registered and has history data
  if (!registered || !history) {
    return null;
  }

  const current = history.current;
  const cycles = history.cycles ?? [];
  const totalCycles = history.total_cycles ?? cycles.length;

  // Current cycle pseudo-record (in-flight, not yet in cycles[])
  const currentCycleRecord: CycleRecord | null = current
    ? {
        cycle: current.cycle,
        phase_id: current.phase_id,
        task_id: current.task_id,
        status: current.status ?? 'running',
        started_at: current.started_at,
        stages: {},
      }
    : null;

  const currentPhaseId = current?.phase_id ?? null;
  const currentStage = current?.stage;
  const currentStatus = current?.status ?? 'idle';
  const heartbeatAt = current?.heartbeat_at;
  const stale = isHeartbeatStale(heartbeatAt, sessionExitReason);

  // Derive the pill UI state from the current status/stage
  const pillUiState = (() => {
    if (currentStatus === 'failed') return 'failed';
    if (currentStatus === 'interrupted') return 'interrupted';
    if (currentStage === 'awaiting_approval') return 'awaiting_approval';
    if (currentStatus === 'running') {
      if (currentStage === 'build' || currentStage === 'fix' || currentStage === 'phase') return 'building';
      if (currentStage === 'verify' || currentStage === 'verdict' || currentStage === 'gate') return 'verifying';
      return 'running';
    }
    return 'idle';
  })();
  const isLive = pillUiState === 'building' || pillUiState === 'verifying' || pillUiState === 'running';

  // Look up the current phase title for the header (no progress bar re-render).
  const currentPhase = phases.find((p) => p.id === currentPhaseId);

  // Flat list of all cycle cards: closed cycles in order, then the in-flight one.
  const allCycles: CycleRecord[] = [...cycles];
  if (currentCycleRecord) {
    const alreadyIn = allCycles.some((c) => c.cycle === currentCycleRecord.cycle);
    if (!alreadyIn) allCycles.push(currentCycleRecord);
  }

  return (
    // No hard-coded dir: the journey is rendered entirely from `t(...)`, so it
    // inherits the document direction instead of forcing RTL on LTR locales.
    <section aria-labelledby="runner-journey-heading">
      {/* ── Header row ─────────────────────────────────────────────────────── */}
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <h3 id="runner-journey-heading" className="text-sm font-semibold text-foreground">
          {t('runner.journey.title')}
        </h3>

        {/* «المِنوال عند المرحلة X» position indicator */}
        {currentPhaseId && (
          <span
            className={cn(
              'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium',
              UI_STATE_STYLES[pillUiState],
            )}
            aria-live="polite"
            aria-atomic="true"
            aria-label={
              t('runner.journey.here') +
              (currentPhaseId ? ` · ${currentPhaseId}` : '') +
              (current ? ` · ${t('runner.journey.cycleN', { n: current.cycle ?? '?' })}` : '')
            }
          >
            <span
              aria-hidden="true"
              className={cn(
                'inline-block h-1.5 w-1.5 rounded-full bg-current',
                isLive && !stale && 'motion-safe:animate-pulse',
              )}
            />
            <Bot className="h-3 w-3" aria-hidden="true" />
            {/* Phase reference */}
            <span className="font-mono" dir="ltr">{currentPhaseId}</span>
            {currentPhase && (
              <>
                <span className="opacity-40" aria-hidden="true">·</span>
                <span>{currentPhase.title}</span>
              </>
            )}
            {/* Current cycle number */}
            {current && (
              <>
                <span className="opacity-40" aria-hidden="true">·</span>
                <span>{t('runner.journey.cycleN', { n: current.cycle ?? '?' })}</span>
              </>
            )}
            {/* «May be frozen» only when a session is actively running with stale heartbeat */}
            {stale && isLive && (
              <span className="ms-1 opacity-60">({t('runner.journey.stale')})</span>
            )}
          </span>
        )}

        {/* Total cycles count badge */}
        {totalCycles > 0 && (
          <span className="rounded-md border border-border bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
            {t('runner.journey.cyclesCount', { n: totalCycles })}
          </span>
        )}
      </div>

      {/* ── Cycle history list ──────────────────────────────────────────────── */}
      {allCycles.length === 0 ? (
        <p className="text-[11px] text-muted-foreground">{t('runner.journey.noCycles')}</p>
      ) : (
        <div className="space-y-2">
          {allCycles.map((cycle) => {
            const isCurrentCycle =
              currentCycleRecord !== null && cycle.cycle === currentCycleRecord.cycle;
            return (
              <CycleCard
                key={cycle.cycle ?? String(allCycles.indexOf(cycle))}
                cycle={cycle}
                isCurrentCycle={isCurrentCycle}
                currentStage={isCurrentCycle ? currentStage : undefined}
                isStale={isCurrentCycle ? stale : undefined}
              />
            );
          })}
        </div>
      )}
    </section>
  );
}
