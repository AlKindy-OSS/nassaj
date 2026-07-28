import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, Package } from 'lucide-react';

import { cn } from '../../../lib/utils';
import { computeCriticalPath, DAY_MS, durationDays, parseDay } from '../lib/cpm';
import type { CpmResult } from '../lib/cpm';
import type {
  BoardDeliverable,
  BoardScheduleItem,
  DeliverableStatus,
  ProjectBoardState,
} from '../types';

type ScheduleViewProps = {
  state: ProjectBoardState;
};

/** Shared row template so the axis header and every Gantt row stay aligned. */
const ROW_GRID = 'grid grid-cols-[minmax(9rem,15rem)_minmax(0,1fr)] gap-x-3';

const DELIVERABLE_STYLES: Record<DeliverableStatus, string> = {
  pending: 'bg-muted text-muted-foreground border-border',
  in_progress: 'bg-blue-500/10 text-blue-600 dark:text-blue-400 border-blue-500/30',
  delivered: 'bg-purple-500/10 text-purple-600 dark:text-purple-400 border-purple-500/30',
  accepted: 'bg-green-500/10 text-green-600 dark:text-green-400 border-green-500/30',
  rejected: 'bg-destructive/10 text-destructive border-destructive/30',
};

/** DOM anchor for a deliverable row, target of the schedule → deliverable link. */
function deliverableAnchorId(deliverableId: string): string {
  return `board-deliverable-${deliverableId}`;
}

type TimelineRange = { min: number; span: number };

/** Min/max day window over all valid schedule dates; null without any date. */
function timelineRange(items: BoardScheduleItem[]): TimelineRange | null {
  const days: number[] = [];
  for (const item of items) {
    const start = parseDay(item.start);
    const end = parseDay(item.end);
    if (start !== null) days.push(start);
    if (end !== null) days.push(end);
  }
  if (!days.length) return null;
  const min = Math.min(...days);
  return { min, span: Math.max(1, Math.max(...days) - min) };
}

function dayPct(day: number, range: TimelineRange): number {
  return ((day - range.min) / range.span) * 100;
}

type AxisTick = { pct: number; label: string };

/** First-of-month ticks across the range, thinned to at most ~12 labels. */
function monthTicks(range: TimelineRange, locale: string): AxisTick[] {
  const formatter = new Intl.DateTimeFormat(locale, {
    month: 'short',
    year: '2-digit',
    timeZone: 'UTC',
  });
  const first = new Date(range.min * DAY_MS);
  const cursor = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth(), 1));
  const ticks: AxisTick[] = [];
  while (Math.round(cursor.getTime() / DAY_MS) <= range.min + range.span) {
    const day = Math.round(cursor.getTime() / DAY_MS);
    if (day >= range.min) {
      ticks.push({ pct: dayPct(day, range), label: formatter.format(cursor) });
    }
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }
  const step = Math.ceil(ticks.length / 12);
  return step > 1 ? ticks.filter((_, index) => index % step === 0) : ticks;
}

type PhaseGroup = { key: string; title: string | null; items: BoardScheduleItem[] };

/** Groups schedule items by phase, ordered like `state.phases`; unknown phases trail. */
function groupByPhase(state: ProjectBoardState, items: BoardScheduleItem[]): PhaseGroup[] {
  const groups = new Map<string, BoardScheduleItem[]>();
  for (const item of items) {
    const key = item.phase ?? '';
    groups.set(key, [...(groups.get(key) ?? []), item]);
  }
  const ordered: PhaseGroup[] = [];
  for (const phase of state.phases ?? []) {
    const own = groups.get(phase.id);
    if (own) {
      ordered.push({ key: phase.id, title: phase.title, items: own });
      groups.delete(phase.id);
    }
  }
  for (const [key, rest] of groups) {
    ordered.push({ key, title: null, items: rest });
  }
  return ordered;
}

function clampProgress(value: unknown): number {
  return Math.max(0, Math.min(100, Number(value) || 0));
}

type BarTooltipProps = {
  item: BoardScheduleItem;
  critical: boolean;
};

/** CSS-only hover/focus card with the item details (shown below the bar). */
function BarTooltip({ item, critical }: BarTooltipProps) {
  const { t, i18n } = useTranslation('projectBoard');
  const days = durationDays(item);

  return (
    <div
      dir={i18n.dir()}
      role="tooltip"
      className="pointer-events-none invisible absolute start-0 top-full z-20 mt-1.5 w-max max-w-72 rounded-md border border-border bg-popover p-2.5 text-popover-foreground shadow-md group-focus-within:visible group-hover:visible"
    >
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="font-mono text-[10px] text-muted-foreground">{item.id}</span>
        <span className="text-xs font-medium">{item.title}</span>
        {critical && (
          <span className="rounded-full border border-destructive/30 bg-destructive/10 px-1.5 py-0.5 text-[10px] font-medium text-destructive">
            {t('schedule.critical')}
          </span>
        )}
        {item.milestone && (
          <span className="rounded-full border border-border bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
            {t('schedule.legendMilestone')}
          </span>
        )}
      </div>
      <div className="mt-1.5 space-y-0.5 text-[11px] text-muted-foreground">
        <p dir="ltr" className="text-start font-mono">
          {item.start ?? '—'} → {item.end ?? '—'}
        </p>
        {!item.milestone && <p>{t('schedule.durationDays', { days })}</p>}
        <p>{t('schedule.progress', { value: clampProgress(item.progress) })}</p>
        {item.owner && <p>{t('schedule.owner', { name: item.owner })}</p>}
        {item.deliverable && <p>{t('schedule.deliverable', { id: item.deliverable })}</p>}
        {Boolean(item.depends?.length) && (
          <p>{t('schedule.dependsOn', { ids: (item.depends ?? []).join(', ') })}</p>
        )}
      </div>
    </div>
  );
}

type GanttRowProps = {
  item: BoardScheduleItem;
  range: TimelineRange;
  critical: boolean;
  onDeliverableClick: (deliverableId: string) => void;
};

function GanttRow({ item, range, critical, onDeliverableClick }: GanttRowProps) {
  const { t } = useTranslation('projectBoard');
  const start = parseDay(item.start);
  const end = parseDay(item.end);
  const progress = clampProgress(item.progress);
  const milestoneDay = item.milestone ? (end ?? start) : null;
  const barLabel = `${item.id} ${item.title}${critical ? ` — ${t('schedule.critical')}` : ''}`;

  return (
    <div className={ROW_GRID}>
      <div className="flex min-w-0 items-center gap-1.5 py-0.5">
        <span className="flex-shrink-0 font-mono text-[10px] text-muted-foreground">{item.id}</span>
        <span className="truncate text-xs text-foreground" title={item.title}>
          {item.title}
        </span>
        {critical && (
          <span className="flex-shrink-0 rounded-full border border-destructive/30 bg-destructive/10 px-1.5 py-0.5 text-[10px] font-medium text-destructive">
            {t('schedule.critical')}
          </span>
        )}
        {item.deliverable && (
          <button
            type="button"
            onClick={() => onDeliverableClick(item.deliverable as string)}
            title={t('schedule.deliverableLink', { id: item.deliverable })}
            aria-label={t('schedule.deliverableLink', { id: item.deliverable })}
            className="inline-flex flex-shrink-0 items-center gap-1 rounded-full border border-border bg-muted px-1.5 py-0.5 font-mono text-[10px] font-medium text-muted-foreground transition-colors hover:text-primary"
          >
            <Package className="h-2.5 w-2.5" />
            {item.deliverable}
          </button>
        )}
      </div>

      {/* Time always flows left→right, even in RTL locales. */}
      <div dir="ltr" className="relative h-7 rounded bg-muted/30">
        {milestoneDay !== null ? (
          <div
            tabIndex={0}
            aria-label={barLabel}
            className="group absolute top-1/2 -translate-x-1/2 -translate-y-1/2 p-1 outline-none"
            style={{ left: `${dayPct(milestoneDay, range)}%` }}
          >
            <span
              className={cn(
                'block h-3 w-3 rotate-45 rounded-[2px] border',
                critical
                  ? 'border-red-600 bg-red-500/80'
                  : 'border-primary bg-primary/80',
              )}
            />
            <BarTooltip item={item} critical={critical} />
          </div>
        ) : (
          start !== null &&
          end !== null && (
            <div
              tabIndex={0}
              aria-label={barLabel}
              className="group absolute inset-y-1 outline-none"
              style={{
                left: `${dayPct(start, range)}%`,
                width: `${Math.max(dayPct(end, range) - dayPct(start, range), 1)}%`,
              }}
            >
              <div
                className={cn(
                  'h-full overflow-hidden rounded-sm',
                  critical ? 'bg-red-500/25' : 'bg-primary/20',
                )}
              >
                <div
                  className={cn('h-full', critical ? 'bg-red-500/80' : 'bg-primary/70')}
                  style={{ width: `${progress}%` }}
                />
              </div>
              <BarTooltip item={item} critical={critical} />
            </div>
          )
        )}
      </div>
    </div>
  );
}

function GanttLegend() {
  const { t } = useTranslation('projectBoard');

  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[10px] text-muted-foreground">
      <span className="flex items-center gap-1.5">
        <span className="h-2 w-5 rounded-sm bg-primary/70" />
        {t('schedule.legendScheduled')}
      </span>
      <span className="flex items-center gap-1.5">
        <span className="h-2 w-5 rounded-sm bg-red-500/80" />
        {t('schedule.legendCritical')}
      </span>
      <span className="flex items-center gap-1.5">
        <span className="h-2 w-2 rotate-45 rounded-[1px] border border-primary bg-primary/80" />
        {t('schedule.legendMilestone')}
      </span>
    </div>
  );
}

type GanttChartProps = {
  state: ProjectBoardState;
  items: BoardScheduleItem[];
  cpm: CpmResult;
  onDeliverableClick: (deliverableId: string) => void;
};

function GanttChart({ state, items, cpm, onDeliverableClick }: GanttChartProps) {
  const { t, i18n } = useTranslation('projectBoard');
  const range = useMemo(() => timelineRange(items), [items]);
  const groups = useMemo(() => groupByPhase(state, items), [state, items]);
  const ticks = useMemo(
    () => (range ? monthTicks(range, i18n.language) : []),
    [range, i18n.language],
  );

  return (
    <section>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-foreground">{t('schedule.title')}</h3>
        <GanttLegend />
      </div>

      {cpm.warnings.length > 0 && (
        <div className="mb-3 flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[11px] text-amber-700 dark:text-amber-400">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" />
          <span>
            {cpm.warnings.map((warning) => t(`schedule.cpm.${warning}`)).join(' ')}
          </span>
        </div>
      )}

      {!range ? (
        <p className="rounded-lg border border-dashed border-border/60 px-3 py-4 text-center text-[11px] text-muted-foreground">
          {t('schedule.noDates')}
        </p>
      ) : (
        <div className="rounded-xl border border-border/60 bg-card p-3">
          <div className={ROW_GRID}>
            <div />
            <div dir="ltr" className="relative h-5 border-b border-border/60">
              {ticks.map((tick) => (
                <span
                  key={tick.pct}
                  className="absolute top-0 -translate-x-1/2 whitespace-nowrap text-[10px] tabular-nums text-muted-foreground"
                  style={{ left: `${tick.pct}%` }}
                >
                  {tick.label}
                </span>
              ))}
            </div>
          </div>

          <div className="mt-2 space-y-3">
            {groups.map((group) => (
              <div key={group.key || '__none__'}>
                <div className="mb-1 flex items-center gap-2">
                  {group.key && (
                    <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
                      {group.key}
                    </span>
                  )}
                  {group.title && (
                    <span className="text-[11px] font-medium text-muted-foreground">
                      {group.title}
                    </span>
                  )}
                </div>
                <div className="space-y-1">
                  {group.items.map((item) => (
                    <GanttRow
                      key={item.id}
                      item={item}
                      range={range}
                      critical={cpm.criticalIds.has(item.id)}
                      onDeliverableClick={onDeliverableClick}
                    />
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}

type DeliverableRowProps = {
  deliverable: BoardDeliverable;
  /** Schedule items that deliver this deliverable (reverse of schedule[].deliverable). */
  deliveredBy: string[];
  highlighted: boolean;
};

function DeliverableRow({ deliverable, deliveredBy, highlighted }: DeliverableRowProps) {
  const { t } = useTranslation('projectBoard');
  const due = parseDay(deliverable.due);
  const today = Math.floor(Date.now() / DAY_MS);
  const overdue =
    due !== null && due < today && !['delivered', 'accepted'].includes(deliverable.status);

  return (
    <div
      id={deliverableAnchorId(deliverable.id)}
      className={cn(
        'rounded-lg border border-border/60 bg-card p-3 transition-shadow duration-300',
        highlighted && 'ring-2 ring-primary/60',
      )}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-[10px] text-muted-foreground">{deliverable.id}</span>
        <span className="text-sm font-medium text-foreground">{deliverable.title}</span>
        <span
          className={cn(
            'rounded-full border px-2 py-0.5 text-[10px] font-medium',
            DELIVERABLE_STYLES[deliverable.status] ?? DELIVERABLE_STYLES.pending,
          )}
        >
          {t(`deliverables.statuses.${deliverable.status}`, { defaultValue: deliverable.status })}
        </span>
        {overdue && (
          <span className="rounded-full border border-destructive/30 bg-destructive/10 px-2 py-0.5 text-[10px] font-medium text-destructive">
            {t('deliverables.overdue')}
          </span>
        )}
        <span className="ms-auto flex items-center gap-3 text-[11px] text-muted-foreground">
          {deliverable.phase && (
            <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px]">
              {deliverable.phase}
            </span>
          )}
          {deliverable.due && (
            <span className={cn('tabular-nums', overdue && 'font-medium text-destructive')}>
              {t('deliverables.due', { date: deliverable.due })}
            </span>
          )}
        </span>
      </div>
      <div className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
        {deliverable.acceptance && (
          <span>
            <span className="font-medium">{t('deliverables.acceptance')}:</span>{' '}
            {deliverable.acceptance}
          </span>
        )}
        {deliverable.owner && <span>{deliverable.owner}</span>}
        {deliveredBy.length > 0 && (
          <span className="font-mono text-[10px]">
            {t('deliverables.deliveredBy', { ids: deliveredBy.join(', ') })}
          </span>
        )}
      </div>
    </div>
  );
}

function DeliverablesList({
  state,
  highlightedId,
}: {
  state: ProjectBoardState;
  highlightedId: string | null;
}) {
  const { t } = useTranslation('projectBoard');
  const deliverables = state.deliverables ?? [];

  // Reverse index: deliverable id → schedule item ids that produce it.
  const deliveredByIndex = useMemo(() => {
    const index = new Map<string, string[]>();
    for (const item of state.schedule ?? []) {
      if (item.deliverable) {
        index.set(item.deliverable, [...(index.get(item.deliverable) ?? []), item.id]);
      }
    }
    return index;
  }, [state.schedule]);

  if (!deliverables.length) {
    return null;
  }

  return (
    <section>
      <h3 className="mb-3 text-sm font-semibold text-foreground">{t('deliverables.title')}</h3>
      <div className="space-y-2">
        {deliverables.map((deliverable) => (
          <DeliverableRow
            key={deliverable.id}
            deliverable={deliverable}
            deliveredBy={deliveredByIndex.get(deliverable.id) ?? []}
            highlighted={deliverable.id === highlightedId}
          />
        ))}
      </div>
    </section>
  );
}

/**
 * Waterfall tab: hand-written CSS-grid Gantt (no chart library) with the
 * critical path computed via lib/cpm, plus the deliverables list.
 */
export default function ScheduleView({ state }: ScheduleViewProps) {
  const items = useMemo(() => state.schedule ?? [], [state.schedule]);
  const cpm = useMemo(() => computeCriticalPath(items), [items]);
  const [highlightedDeliverable, setHighlightedDeliverable] = useState<string | null>(null);
  const highlightTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Schedule chip → deliverable row: scroll to it and flash it briefly.
  const handleDeliverableClick = useCallback((deliverableId: string) => {
    document
      .getElementById(deliverableAnchorId(deliverableId))
      ?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    setHighlightedDeliverable(deliverableId);
    if (highlightTimer.current) {
      clearTimeout(highlightTimer.current);
    }
    highlightTimer.current = setTimeout(() => setHighlightedDeliverable(null), 2200);
  }, []);

  useEffect(
    () => () => {
      if (highlightTimer.current) {
        clearTimeout(highlightTimer.current);
      }
    },
    [],
  );

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-4xl space-y-8 px-4 py-5 sm:px-6">
        <GanttChart
          state={state}
          items={items}
          cpm={cpm}
          onDeliverableClick={handleDeliverableClick}
        />
        <DeliverablesList state={state} highlightedId={highlightedDeliverable} />
      </div>
    </div>
  );
}
