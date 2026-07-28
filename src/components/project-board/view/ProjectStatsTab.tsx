import { useTranslation } from 'react-i18next';
import { AlertTriangle, Bot, CalendarDays, MessagesSquare, Timer } from 'lucide-react';

import { cn } from '../../../lib/utils';
import {
  COST_DASH,
  formatCostCount,
  formatCostUsd,
} from '../../chat/view/subcomponents/conversationCostFormat';
import {
  buildSparkline,
  fillDailyGaps,
  formatDayLabel,
  spanInDays,
  toDay,
  type BreakdownEntry,
  type ProjectCost,
  type ProjectStats,
} from '../projectStatsHelpers';

type ProjectStatsTabProps = {
  stats: ProjectStats | null;
  /** The header total's payload; used only as a fallback for pricesAsOf/partial. */
  cost: ProjectCost | null;
};

/** The sparkline viewBox: fixed geometry, scaled by CSS to the panel's width. */
const SPARK_WIDTH = 300;
const SPARK_HEIGHT = 40;
/** Days drawn at most. Beyond this the bars are thinner than a hairline. */
const SPARK_MAX_DAYS = 90;

/**
 * One headline figure. A `null` value is a dash — the tile never invents a 0,
 * and it says so in its own title so the dash is not read as "nothing happened".
 */
function StatTile({
  icon,
  label,
  value,
  hint,
}: {
  icon: React.ReactNode;
  label: string;
  value: string | null;
  hint?: string | null;
}) {
  const { t } = useTranslation('projectBoard');
  const unknown = value === null;

  return (
    <div className="rounded-xl border border-border/60 bg-card p-3">
      <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
        {icon}
        <span>{label}</span>
      </div>
      <div
        className={cn(
          'mt-1 text-sm font-semibold tabular-nums',
          unknown ? 'text-muted-foreground' : 'text-foreground',
        )}
        title={unknown ? t('stats.unavailable', { defaultValue: 'Not available' }) : undefined}
      >
        <bdi>{value ?? COST_DASH}</bdi>
      </div>
      {hint && <div className="mt-0.5 truncate text-[10px] text-muted-foreground">{hint}</div>}
    </div>
  );
}

/** Vendor/model rows: amount + share bar. An unpriced row shows a dash, not 0.00. */
function BreakdownList({ title, entries }: { title: string; entries: BreakdownEntry[] }) {
  if (entries.length === 0) return null;

  return (
    <div className="rounded-xl border border-border/60 bg-card p-3">
      <div className="mb-2 text-[11px] font-medium text-muted-foreground">{title}</div>
      <div className="space-y-2">
        {entries.map((entry) => (
          <div key={entry.label}>
            <div className="flex items-baseline gap-2 text-xs">
              {/* Latin model ids and amounts are isolated so RTL never reorders them. */}
              <bdi className="min-w-0 flex-1 truncate font-mono text-[11px] text-foreground">
                {entry.label}
              </bdi>
              <bdi className="shrink-0 tabular-nums text-muted-foreground">
                {entry.costUsd === null ? COST_DASH : formatCostUsd(entry.costUsd)}
              </bdi>
            </div>
            <div className="mt-1 h-1 overflow-hidden rounded-full bg-muted">
              <div
                className="h-full rounded-full bg-primary/70"
                style={{ width: `${Math.round(entry.share * 100)}%` }}
              />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * The project statistics tab — cost, working rhythm and a vendor/model
 * breakdown, all measured server-side from provider transcripts (ADR-078).
 *
 * Two rules shape everything below and are worth stating once:
 *  • Flat subscriptions are not metered per token, so every amount here is an
 *    API-EQUIVALENT value; the caveat sits under the headline figure, not in a
 *    tooltip, because a number this large is exactly what gets misread as a bill.
 *  • Nothing missing is drawn as zero. Absent counters are dashes and an absent
 *    payload renders no block at all.
 */
export default function ProjectStatsTab({ stats, cost }: ProjectStatsTabProps) {
  const { t, i18n } = useTranslation('projectBoard');
  const locale = i18n.language || 'en';
  const isRtl = typeof i18n.dir === 'function' ? i18n.dir() === 'rtl' : false;

  if (!stats) {
    return (
      <div className="flex h-full items-center justify-center p-8 text-center text-sm text-muted-foreground">
        {t('stats.empty', { defaultValue: 'No cost data has been measured for this project yet.' })}
      </div>
    );
  }

  const totalUsd = stats.totalUsd ?? cost?.totalUsd ?? null;
  const complete = cost?.complete !== false;
  const unpricedModels = cost?.unpricedModels ?? [];
  const pricesAsOf = stats.pricesAsOf ?? cost?.pricesAsOf ?? null;

  const firstDay = toDay(stats.firstActivity) ?? cost?.firstDay ?? null;
  const lastDay = toDay(stats.lastActivity) ?? cost?.lastDay ?? null;
  const span = spanInDays(firstDay, lastDay);

  const series = fillDailyGaps(stats.daily, SPARK_MAX_DAYS);
  const spark = buildSparkline(series, { width: SPARK_WIDTH, height: SPARK_HEIGHT });
  const peakUsd = spark?.maxUsd ?? 0;

  return (
    <div className="h-full overflow-y-auto p-4">
      <div className="mx-auto flex max-w-3xl flex-col gap-4">
        {/* Headline: the lifetime figure and, inseparable from it, what it is not. */}
        <div className="rounded-xl border border-border/60 bg-card p-4">
          <div className="text-[11px] text-muted-foreground">
            {t('stats.totalLabel', { defaultValue: 'Total cost (all time)' })}
          </div>
          <div className="mt-1 flex flex-wrap items-baseline gap-2">
            <bdi className="text-2xl font-semibold tabular-nums text-foreground">
              {formatCostUsd(totalUsd)}
            </bdi>
            {!complete && (
              <span className="inline-flex items-center gap-1 rounded-full border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 text-[10px] font-medium text-amber-700 dark:text-amber-400">
                <AlertTriangle className="h-3 w-3" />
                {t('stats.partialShort', { defaultValue: 'Partial' })}
              </span>
            )}
          </div>
          <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">
            {t('stats.apiEquivalent', {
              defaultValue:
                'Flat subscriptions are not billed per token: this is the API-equivalent value of the usage measured for this project, not an amount charged.',
            })}
          </p>
          {!complete && unpricedModels.length > 0 && (
            <p className="mt-1 text-[11px] leading-relaxed text-amber-700 dark:text-amber-400">
              {t('stats.partialModels', {
                defaultValue: 'Partial total — no official price for: {{models}}',
                models: unpricedModels.join(', '),
              })}
            </p>
          )}
        </div>

        {/* Working rhythm. */}
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <StatTile
            icon={<CalendarDays className="h-3.5 w-3.5" />}
            label={t('stats.activeDays', { defaultValue: 'Active days' })}
            value={stats.activeDays === null ? null : formatCostCount(stats.activeDays)}
            hint={
              span !== null && stats.activeDays !== null
                ? t('stats.activeDaysOfSpan', {
                    defaultValue: 'of {{span}} days',
                    span: formatCostCount(span),
                  })
                : null
            }
          />
          <StatTile
            icon={<Timer className="h-3.5 w-3.5" />}
            label={t('stats.span', { defaultValue: 'Time span' })}
            value={span === null ? null : formatCostCount(span)}
            hint={formatDayLabel(firstDay, locale)}
          />
          <StatTile
            icon={<MessagesSquare className="h-3.5 w-3.5" />}
            label={t('stats.conversations', { defaultValue: 'Conversations' })}
            value={stats.conversations === null ? null : formatCostCount(stats.conversations)}
          />
          <StatTile
            icon={<Bot className="h-3.5 w-3.5" />}
            label={t('stats.agents', { defaultValue: 'Agents' })}
            value={stats.agents === null ? null : formatCostCount(stats.agents)}
          />
        </div>

        {/* Daily cost — an inline SVG, no charting dependency. */}
        {spark && (
          <div className="rounded-xl border border-border/60 bg-card p-3">
            <div className="mb-2 flex items-baseline justify-between gap-2">
              <span className="text-[11px] font-medium text-muted-foreground">
                {t('stats.dailyTitle', { defaultValue: 'Daily cost' })}
              </span>
              {peakUsd > 0 && (
                <span className="text-[10px] text-muted-foreground">
                  {t('stats.dailyPeak', { defaultValue: 'Peak' })}{' '}
                  <bdi className="tabular-nums">{formatCostUsd(peakUsd)}</bdi>
                </span>
              )}
            </div>
            <svg
              viewBox={`0 0 ${spark.width} ${spark.height}`}
              preserveAspectRatio="none"
              role="img"
              aria-label={t('stats.dailyTitle', { defaultValue: 'Daily cost' })}
              /* The bars are laid out left-to-right; under RTL the whole chart is
                 mirrored so the timeline still runs with the reading direction. */
              className={cn('h-10 w-full', isRtl && '-scale-x-100')}
            >
              {spark.bars.map((bar) => (
                <rect
                  key={bar.day}
                  x={bar.x}
                  y={bar.y}
                  width={bar.width}
                  height={bar.height}
                  className="fill-primary/70"
                >
                  <title>{`${bar.day} · ${formatCostUsd(bar.costUsd)}`}</title>
                </rect>
              ))}
            </svg>
            <div className="mt-1 flex justify-between text-[10px] text-muted-foreground">
              <bdi>{formatDayLabel(series[0]?.day ?? null, locale)}</bdi>
              <bdi>{formatDayLabel(series[series.length - 1]?.day ?? null, locale)}</bdi>
            </div>
          </div>
        )}

        {/* First/last activity as dates, next to the rhythm they explain. */}
        {(firstDay || lastDay) && (
          <div className="grid grid-cols-2 gap-3">
            <StatTile
              icon={<CalendarDays className="h-3.5 w-3.5" />}
              label={t('stats.firstActivity', { defaultValue: 'First activity' })}
              value={formatDayLabel(firstDay, locale)}
            />
            <StatTile
              icon={<CalendarDays className="h-3.5 w-3.5" />}
              label={t('stats.lastActivity', { defaultValue: 'Last activity' })}
              value={formatDayLabel(lastDay, locale)}
            />
          </div>
        )}

        <div className="grid gap-3 sm:grid-cols-2">
          <BreakdownList
            title={t('stats.byVendor', { defaultValue: 'By vendor' })}
            entries={stats.byVendor}
          />
          <BreakdownList
            title={t('stats.byModel', { defaultValue: 'By model' })}
            entries={stats.byModel}
          />
        </div>

        {pricesAsOf && (
          <p className="text-[10px] text-muted-foreground">
            {t('stats.pricesAsOf', { defaultValue: 'Prices as of {{date}}', date: pricesAsOf })}
          </p>
        )}
      </div>
    </div>
  );
}
