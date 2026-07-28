/**
 * RunnerStatusLine — «سطر حالة المِنوال»
 * =======================================
 *
 * A single, explicit status line answering the owner's question at a glance:
 * «is al-Minwāl working, and where exactly?». Rendered at the top of the runner
 * overlay, above PhaseTimeline.
 *
 *   🟢 al-Minwāl working — Phase S3: Multi-currency · Task WI-42.12 · Cycle 3
 *   ⚪ Idle
 *
 * Single source of truth: cycle-history.json → RunnerStatus.history.current —
 * the exact same data that feeds RunnerJourney, so the two never disagree.
 * ADR-RUNNER-BRIDGE-001: read-only. Never writes runner files.
 *
 * Additive: renders null unless `registered && history != null`, so the board is
 * byte-for-byte unchanged for projects with no runner.
 *
 * RTL-first: logical properties throughout. a11y: a live status is conveyed by
 * text + icon (never color alone); aria-live announces transitions.
 */

import { useTranslation } from 'react-i18next';
import { Bot, CircleDot, Pause, XCircle } from 'lucide-react';

import { cn } from '../../lib/utils';
import type { BoardPhase } from '../project-board/types';

import type { CycleHistory } from './useRunner';

// ─── constants ───────────────────────────────────────────────────────────────

/** After this many seconds without a heartbeat we consider the runner stale. */
const STALE_THRESHOLD_S = 180; // mirrors RunnerJourney

// ─── types ───────────────────────────────────────────────────────────────────

export type RunnerStatusLineProps = {
  /** Board phases — used to resolve the active phase title. */
  phases: BoardPhase[];
  /** Cycle journey log. null → the line is hidden entirely. */
  history: CycleHistory | null;
  /** True when the runner is registered with this project (guard). */
  registered: boolean;
  /** supervisor.session.exit_reason — suppresses «may be frozen» when ended. */
  sessionExitReason?: string | null;
};

type LineState = 'running' | 'awaiting' | 'interrupted' | 'failed' | 'idle';

// ─── helpers ─────────────────────────────────────────────────────────────────

function secondsSince(iso: string | null | undefined): number {
  if (!iso) return Infinity;
  const diff = (Date.now() - new Date(iso).getTime()) / 1000;
  return isFinite(diff) ? diff : Infinity;
}

/** Tailwind classes + the icon for each line state. */
const LINE_STYLES: Record<LineState, string> = {
  running: 'border-green-500/40 bg-green-500/10 text-green-700 dark:text-green-400',
  awaiting: 'border-blue-500/40 bg-blue-500/10 text-blue-600 dark:text-blue-400',
  interrupted: 'border-yellow-500/40 bg-yellow-500/10 text-yellow-700 dark:text-yellow-400',
  failed: 'border-destructive/40 bg-destructive/10 text-destructive',
  idle: 'border-border bg-muted text-muted-foreground',
};

// ─── component ───────────────────────────────────────────────────────────────

export default function RunnerStatusLine({
  phases,
  history,
  registered,
  sessionExitReason,
}: RunnerStatusLineProps) {
  const { t } = useTranslation('projectBoard');

  // Additive guard — identical to RunnerJourney's.
  if (!registered || !history) {
    return null;
  }

  const current = history.current;
  const status = current?.status ?? 'idle';
  const stage = current?.stage;
  const phaseId = current?.phase_id ?? null;
  const taskId = current?.task_id ?? null;
  const cycle = current?.cycle;
  const stale = sessionExitReason == null && secondsSince(current?.heartbeat_at) > STALE_THRESHOLD_S;

  // Derive the line state from the current cycle status/stage.
  const lineState: LineState = (() => {
    if (sessionExitReason != null) {
      // Session ended: clean → idle, recoverable → interrupted, else failed.
      if (sessionExitReason === 'clean') return 'idle';
      if (sessionExitReason === 'rate-limit') return 'interrupted';
      const FAILED = new Set(['failed', 'oom', 'killed', 'error', 'crash', 'hung-stopped']);
      return FAILED.has(sessionExitReason) ? 'failed' : 'interrupted';
    }
    if (status === 'failed') return 'failed';
    if (status === 'interrupted') return 'interrupted';
    if (stage === 'awaiting_approval') return 'awaiting';
    if (status === 'running') return 'running';
    return 'idle';
  })();

  const isLive = lineState === 'running';
  const phase = phaseId ? phases.find((p) => p.id === phaseId) : undefined;

  // Build the human-readable summary parts (only when actively working).
  const showDetails = lineState !== 'idle' && (phaseId || taskId || cycle != null);

  return (
    <div
      className={cn(
        'flex flex-wrap items-center gap-x-2 gap-y-1 rounded-xl border px-3 py-2 text-xs font-medium',
        LINE_STYLES[lineState],
      )}
      aria-live="polite"
      aria-atomic="true"
    >
      {/* State icon — color is never the sole signal. */}
      <span className="inline-flex items-center gap-1.5">
        {lineState === 'running' && (
          <CircleDot className={cn('h-3.5 w-3.5', !stale && 'motion-safe:animate-pulse')} aria-hidden="true" />
        )}
        {lineState === 'awaiting' && <CircleDot className="h-3.5 w-3.5" aria-hidden="true" />}
        {lineState === 'interrupted' && <Pause className="h-3.5 w-3.5" aria-hidden="true" />}
        {lineState === 'failed' && <XCircle className="h-3.5 w-3.5" aria-hidden="true" />}
        {lineState === 'idle' && <Bot className="h-3.5 w-3.5" aria-hidden="true" />}
        <span>{t(`runner.statusLine.${lineState}`)}</span>
      </span>

      {showDetails && (
        <>
          {phaseId && (
            <>
              <span className="opacity-40" aria-hidden="true">·</span>
              <span>
                {t('runner.phase')} <span className="font-mono" dir="ltr">{phaseId}</span>
                {phase && <>: {phase.title}</>}
              </span>
            </>
          )}
          {taskId && (
            <>
              <span className="opacity-40" aria-hidden="true">·</span>
              <span>
                {t('runner.task')} <span className="font-mono" dir="ltr">{taskId}</span>
              </span>
            </>
          )}
          {cycle != null && (
            <>
              <span className="opacity-40" aria-hidden="true">·</span>
              <span>{t('runner.journey.cycleN', { n: cycle })}</span>
            </>
          )}
          {stale && isLive && (
            <span className="opacity-60">({t('runner.journey.stale')})</span>
          )}
        </>
      )}
    </div>
  );
}
