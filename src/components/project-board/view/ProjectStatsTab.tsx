import { useTranslation } from 'react-i18next';
import { ProjectSkillsSection } from '../../participants/ObservedSkills';
import type { TFunction } from 'i18next';
import {
  AlertTriangle,
  AlignLeft,
  Bot,
  CalendarDays,
  FileCode,
  HardDrive,
  MessagesSquare,
  RefreshCw,
  Timer,
} from 'lucide-react';

import { cn } from '../../../lib/utils';
import {
  COST_DASH,
  formatCostCount,
  formatCostUsd,
} from '../../chat/view/subcomponents/conversationCostFormat';
import {
  buildSparkline,
  buildDailyWindow,
  formatBytes,
  formatDayLabel,
  formatRelativeTime,
  ledgerLagInDays,
  spanInDays,
  toDay,
  type BreakdownEntry,
  type CodebaseStats,
  type CodeFileRow,
  type CodebaseStatsIncompleteReason,
  type ProjectAgentEntry,
  type ProjectCost,
  type ProjectStats,
  type ProjectStatsGap,
} from '../projectStatsHelpers';

type ProjectStatsTabProps = {
  stats: ProjectStats | null;
  /** The header total's payload; used only as a fallback for pricesAsOf/partial. */
  cost: ProjectCost | null;
  /** The working tree's own measurements (T-1169); absent → the section is not drawn. */
  codeStats?: CodebaseStats | null;
  /** Initial measurements are still being fetched. */
  isLoading?: boolean;
  /** All measurement endpoints failed; partial endpoint failures still render data. */
  loadError?: string | null;
  /** Re-scans the working tree. Absent → the refresh control is not offered. */
  onRefreshCodeStats?: () => void;
};

function incompleteReasonLabel(
  reason: CodebaseStatsIncompleteReason,
  t: TFunction<'projectBoard'>,
): string {
  const options = { count: reason.count };
  switch (reason.code) {
    case 'FILE_LIMIT':
      return t('stats.codebaseReasonFileLimit', {
        ...options,
        defaultValue: 'File limit reached ({{count}} occurrence)',
      });
    case 'DIRECTORY_LIMIT':
      return t('stats.codebaseReasonDirectoryLimit', {
        ...options,
        defaultValue: 'Directory limit reached ({{count}} occurrence)',
      });
    case 'DIRECTORY_ENTRY_LIMIT':
      return t('stats.codebaseReasonDirectoryEntryLimit', {
        ...options,
        defaultValue: 'A directory exceeded its entry limit ({{count}} occurrence)',
      });
    case 'DEPTH_LIMIT':
      return t('stats.codebaseReasonDepthLimit', {
        ...options,
        defaultValue: 'Maximum directory depth reached ({{count}} occurrence)',
      });
    case 'DIRECTORY_UNREADABLE':
      return t('stats.codebaseReasonDirectoryUnreadable', {
        ...options,
        defaultValue: 'Unreadable directory skipped ({{count}} occurrence)',
      });
    case 'FILE_STAT_FAILED':
      return t('stats.codebaseReasonFileStat', {
        ...options,
        defaultValue: 'File metadata could not be read ({{count}} occurrence)',
      });
    case 'FILE_READ_FAILED':
      return t('stats.codebaseReasonFileRead', {
        ...options,
        defaultValue: 'File contents could not be read ({{count}} occurrence)',
      });
    case 'LINE_FILE_TOO_LARGE':
      return t('stats.codebaseReasonLargeLineFile', {
        ...options,
        defaultValue: 'Large file omitted from line count ({{count}} occurrence)',
      });
    case 'TIME_BUDGET_EXCEEDED':
      return t('stats.codebaseReasonTimeBudget', {
        ...options,
        defaultValue: 'Scan time budget reached ({{count}} occurrence)',
      });
    case 'READ_BYTE_BUDGET_EXCEEDED':
      return t('stats.codebaseReasonByteBudget', {
        ...options,
        defaultValue: 'Read-byte budget reached ({{count}} occurrence)',
      });
    default:
      return t('stats.codebaseReasonUnknown', {
        ...options,
        code: reason.code,
        defaultValue: '{{code}} limited the scan ({{count}} occurrence)',
      });
  }
}

/**
 * The codebase block: what the project's files are, next to what its
 * conversations cost. Two independent measurements on one tab — neither is
 * derived from the other, and each renders only when its own payload arrived.
 */
function CodebaseSection({
  codeStats,
  onRefresh,
}: {
  codeStats: CodebaseStats;
  onRefresh?: () => void;
}) {
  const { t, i18n } = useTranslation('projectBoard');
  const locale = i18n.language || 'en';
  const topFiles = Math.max(1, codeStats.byExtension[0]?.files ?? 1);
  const scannedLabel =
    codeStats.scannedAt === null ? null : formatRelativeTime(codeStats.scannedAt, locale);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-[11px] font-medium text-muted-foreground">
          {t('stats.codebaseTitle', { defaultValue: 'Codebase' })}
        </span>
        <div className="flex flex-wrap items-center gap-2">
          {scannedLabel && (
            <span className="text-[10px] text-muted-foreground">
              {t('stats.codebaseScanned', {
                defaultValue: 'Scanned {{time}}',
                time: scannedLabel,
              })}
            </span>
          )}
          {onRefresh && (
            <button
              type="button"
              onClick={onRefresh}
              className="inline-flex items-center gap-1 rounded-lg border border-border/60 px-2 py-1 text-[10px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              <RefreshCw className="h-3 w-3" aria-hidden="true" />
              {t('stats.codebaseRefreshExplicit', { defaultValue: 'Rescan codebase' })}
            </button>
          )}
        </div>
      </div>

      {!codeStats.complete && (
        <div className="text-[10px] leading-relaxed text-warning">
          <p>
            {t('stats.codebaseIncomplete', {
              defaultValue: 'The scan is incomplete — aggregate measurements are minimums (≥).',
            })}
          </p>
          {codeStats.incompleteReasons.length > 0 && (
            <ul className="mt-1 list-disc space-y-0.5 ps-4">
              {codeStats.incompleteReasons.map((reason) => (
                <li key={reason.code}>{incompleteReasonLabel(reason, t)}</li>
              ))}
            </ul>
          )}
        </div>
      )}

      <div className="grid grid-cols-1 gap-3 min-[420px]:grid-cols-3">
        <StatTile
          icon={<HardDrive className="h-3.5 w-3.5" />}
          label={t('stats.codebaseSize', { defaultValue: 'Total size' })}
          value={
            codeStats.totalBytes === null
              ? null
              : `${codeStats.complete ? '' : '≥'}${formatBytes(codeStats.totalBytes, locale)}`
          }
        />
        <StatTile
          icon={<AlignLeft className="h-3.5 w-3.5" />}
          label={t('stats.codebaseLines', { defaultValue: 'Lines' })}
          value={
            codeStats.totalLines === null
              ? null
              : `${codeStats.complete ? '' : '≥'}${formatCostCount(codeStats.totalLines)}`
          }
          hint={
            codeStats.linesCounted !== null && codeStats.linesCounted < codeStats.fileCount
              ? t('stats.codebaseLinesOf', {
                  defaultValue: 'in {{counted}} text files',
                  counted: formatCostCount(codeStats.linesCounted),
                })
              : null
          }
        />
        <StatTile
          icon={<FileCode className="h-3.5 w-3.5" />}
          label={t('stats.codebaseFiles', { defaultValue: 'Files' })}
          value={`${codeStats.complete ? '' : '≥'}${formatCostCount(codeStats.fileCount)}`}
        />
      </div>

      {codeStats.byExtension.length > 0 && (
        <div className="rounded-xl border border-border/60 bg-card p-3">
          <div className="mb-2 text-[11px] font-medium text-muted-foreground">
            {t('stats.codebaseTypes', { defaultValue: 'File types' })}
          </div>
          <div className="space-y-2">
            {codeStats.byExtension.map((row) => (
              <div key={row.extension}>
                <div className="flex items-baseline gap-2 text-xs">
                  <bdi className="min-w-0 flex-1 truncate font-mono text-[11px] text-foreground">
                    {row.extension}
                  </bdi>
                  <bdi className="shrink-0 tabular-nums text-muted-foreground">
                    {codeStats.complete ? '' : '≥'}{formatCostCount(row.files)}
                  </bdi>
                </div>
                <div className="mt-1 h-1 overflow-hidden rounded-full bg-muted">
                  <div
                    className="h-full rounded-full bg-primary/70"
                    style={{ width: `${Math.round((row.files / topFiles) * 100)}%` }}
                  />
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="grid gap-3 sm:grid-cols-2">
        <FileList
          title={
            codeStats.complete
              ? t('stats.codebaseRecent', { defaultValue: 'Recently modified' })
              : t('stats.codebaseRecentScanned', {
                  defaultValue: 'Recently modified among scanned files',
                })
          }
          rows={codeStats.recentlyModified}
          render={(row) =>
            row.modifiedAt === null ? null : formatRelativeTime(row.modifiedAt, locale)
          }
        />
        <FileList
          title={
            codeStats.complete
              ? t('stats.codebaseLargest', { defaultValue: 'Largest files' })
              : t('stats.codebaseLargestScanned', {
                  defaultValue: 'Largest among scanned files',
                })
          }
          rows={codeStats.largestFiles}
          render={(row) => (row.bytes === null ? null : formatBytes(row.bytes, locale))}
        />
      </div>
    </div>
  );
}

/** File rows: a project-relative path plus one measurement. */
function FileList({
  title,
  rows,
  render,
}: {
  title: string;
  rows: CodeFileRow[];
  render: (row: CodeFileRow) => string | null;
}) {
  if (rows.length === 0) return null;

  return (
    <div className="rounded-xl border border-border/60 bg-card p-3">
      <div className="mb-2 text-[11px] font-medium text-muted-foreground">{title}</div>
      <div className="space-y-1.5">
        {rows.map((row) => (
          <div key={row.path} className="flex items-baseline gap-2 text-xs">
            {/* A path is Latin and slash-separated: isolated so RTL never reorders it. */}
            <bdi dir="ltr" className="min-w-0 flex-1 truncate font-mono text-[11px] text-foreground">
              {row.path}
            </bdi>
            <bdi className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
              {render(row) ?? COST_DASH}
            </bdi>
          </div>
        ))}
      </div>
    </div>
  );
}

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

function CostHeadline({
  totalUsd,
  complete,
  unpricedModels,
  assumedModels,
}: {
  totalUsd: number | null;
  complete: boolean;
  unpricedModels: string[];
  assumedModels: string[];
}) {
  const { t } = useTranslation('projectBoard');

  return (
    <div className="rounded-xl border border-border/60 bg-card p-4">
      <div className="text-[11px] text-muted-foreground">
        {t('stats.totalMeasuredLabel', {
          defaultValue: 'API-equivalent usage value (all ledger history)',
        })}
      </div>
      <div className="mt-1 flex flex-wrap items-baseline gap-2">
        <bdi className="text-2xl font-semibold tabular-nums text-foreground">
          {formatCostUsd(totalUsd)}
        </bdi>
        {!complete && (
          <span className="inline-flex items-center gap-1 rounded-full border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 text-[10px] font-medium text-warning">
            <AlertTriangle className="h-3 w-3" />
            {t('stats.partialShort', { defaultValue: 'Partial' })}
          </span>
        )}
      </div>
      <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">
        {t('stats.apiEquivalent', {
          defaultValue:
            'Flat subscriptions are not billed per token: this is the API-equivalent value of the usage measured in the project ledger, not an amount charged.',
        })}
      </p>
      {!complete && unpricedModels.length > 0 && (
        <p className="mt-1 text-[11px] leading-relaxed text-warning">
          {t('stats.partialModels', {
            defaultValue: 'Partial total — no official price for: {{models}}',
            models: unpricedModels.join(', '),
          })}
        </p>
      )}
      {assumedModels.length > 0 && (
        <p className="mt-1 text-[11px] leading-relaxed text-warning">
          {t('stats.assumedModels', {
            defaultValue: 'Estimated from a compatible price for: {{models}}',
            models: assumedModels.join(', '),
          })}
        </p>
      )}
    </div>
  );
}

function GapList({ gaps }: { gaps: ProjectStatsGap[] }) {
  const { t } = useTranslation('projectBoard');
  if (gaps.length === 0) return null;
  return (
    <div className="rounded-xl border border-warning/40 bg-warning/5 p-3">
      <div className="mb-2 text-[11px] font-medium text-warning">
        {t('stats.measurementGaps', { defaultValue: 'Measurement gaps' })}
      </div>
      <div className="space-y-1.5">
        {gaps.map((gap) => (
          <div key={`${gap.harness}:${gap.reason}`} className="text-[11px] text-muted-foreground">
            <bdi className="font-mono text-foreground">{gap.harness}</bdi>
            <span aria-hidden="true"> — </span>
            <span>{gap.reason}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function AgentList({ agents }: { agents: ProjectAgentEntry[] }) {
  const { t } = useTranslation('projectBoard');
  if (agents.length === 0) return null;

  const groups = [
    {
      kind: 'subagent' as const,
      title: t('stats.subagentRoster', { defaultValue: 'Measured delegated agents' }),
    },
    {
      kind: 'model' as const,
      title: t('stats.modelRoster', { defaultValue: 'Measured base models' }),
    },
  ];

  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {groups.map((group) => {
        const rows = agents.filter((agent) => agent.kind === group.kind);
        if (rows.length === 0) return null;
        return (
          <div key={group.kind} className="rounded-xl border border-border/60 bg-card p-3">
            <div className="mb-2 text-[11px] font-medium text-muted-foreground">{group.title}</div>
            <div className="space-y-1.5">
              {rows.map((agent) => (
                <div key={agent.name} className="flex min-w-0 items-baseline gap-2 text-xs">
                  <bdi className="min-w-0 flex-1 truncate font-mono text-[11px] text-foreground">
                    {agent.name}
                  </bdi>
                  <span className="shrink-0 text-[10px] text-muted-foreground">
                    {t('stats.invocations', {
                      defaultValue: '{{count}} invocations',
                      count: agent.invocations,
                    })}
                  </span>
                </div>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/** Vendor/model rows: amount + share bar. An unpriced row shows a dash, not 0.00. */
function BreakdownList({ title, entries }: { title: string; entries: BreakdownEntry[] }) {
  const { t } = useTranslation('projectBoard');
  if (entries.length === 0) return null;

  return (
    <div className="rounded-xl border border-border/60 bg-card p-3">
      <div className="mb-2 text-[11px] font-medium text-muted-foreground">{title}</div>
      <div className="space-y-2">
        {entries.map((entry, index) => (
          <div
            key={`${entry.label}:${entry.costUsd ?? 'unknown'}:${entry.requests ?? 'unknown'}:${index}`}
          >
            <div className="flex items-baseline gap-2 text-xs">
              {/* Latin model ids and amounts are isolated so RTL never reorders them. */}
              <bdi className="min-w-0 flex-1 truncate font-mono text-[11px] text-foreground">
                {entry.label}
              </bdi>
              <bdi className="shrink-0 tabular-nums text-muted-foreground">
                {entry.costUsd === null
                  ? COST_DASH
                  : `${entry.assumed ? '≈' : entry.unpriced ? '≥' : ''}${formatCostUsd(entry.costUsd)}`}
              </bdi>
            </div>
            {entry.unpriced && entry.assumed && entry.costUsd !== null && (
              <div className="mt-0.5 text-[10px] text-warning">
                {t('stats.breakdownFloorWithEstimates', {
                  defaultValue: 'Partial estimate; some usage remains unpriced',
                })}
              </div>
            )}
            {entry.unpriced && !entry.assumed && entry.costUsd !== null && (
              <div className="mt-0.5 text-[10px] text-warning">
                {t('stats.breakdownFloor', { defaultValue: 'Priced minimum; some usage is unpriced' })}
              </div>
            )}
            {entry.unpriced && entry.costUsd === null && (
              <div className="mt-0.5 text-[10px] text-warning">
                {t('stats.unpricedBreakdown', { defaultValue: 'No official price' })}
              </div>
            )}
            {entry.assumed && !entry.unpriced && (
              <div className="mt-0.5 text-[10px] text-warning">
                {t('stats.assumedBreakdown', { defaultValue: 'Compatible price estimate' })}
              </div>
            )}
            {entry.requests !== null && (
              <div className="mt-0.5 text-[10px] text-muted-foreground">
                {t('stats.requests', {
                  defaultValue: '{{count}} requests',
                  count: entry.requests,
                })}
              </div>
            )}
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
export default function ProjectStatsTab({
  stats,
  cost,
  codeStats = null,
  isLoading = false,
  loadError = null,
  onRefreshCodeStats,
}: ProjectStatsTabProps) {
  const { t, i18n } = useTranslation('projectBoard');
  const locale = i18n.language || 'en';
  const isRtl = typeof i18n.dir === 'function' ? i18n.dir() === 'rtl' : false;

  if (isLoading && !stats && !cost && !codeStats) {
    return (
      <div
        className="h-full overflow-hidden p-4"
        role="status"
        aria-busy="true"
        aria-label={t('stats.loading', { defaultValue: 'Loading project statistics' })}
      >
        <div className="mx-auto flex max-w-3xl animate-pulse flex-col gap-4" aria-hidden="true">
          <div className="h-28 rounded-xl border border-border/60 bg-muted/40" />
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {Array.from({ length: 4 }, (_, index) => (
              <div key={index} className="h-20 rounded-xl border border-border/60 bg-muted/40" />
            ))}
          </div>
          <div className="h-28 rounded-xl border border-border/60 bg-muted/40" />
        </div>
      </div>
    );
  }

  if (loadError && !stats && !cost && !codeStats) {
    return (
      <div className="flex h-full items-center justify-center p-8 text-center" role="alert">
        <div className="max-w-sm rounded-xl border border-destructive/30 bg-destructive/5 px-5 py-4">
          <AlertTriangle className="mx-auto mb-2 h-5 w-5 text-destructive" aria-hidden="true" />
          <p className="text-sm text-foreground">
            {loadError === 'statistics-unavailable'
              ? t('stats.endpointUnavailable', {
                  defaultValue: 'Statistics are not available for this project server.',
                })
              : t('stats.loadError', {
                  defaultValue: 'Project statistics could not be loaded. Try again shortly.',
                })}
          </p>
          {loadError === 'statistics-load-failed' && onRefreshCodeStats && (
            <button
              type="button"
              onClick={onRefreshCodeStats}
              className="mx-auto mt-3 inline-flex items-center gap-1.5 rounded-lg border border-border/60 bg-card px-3 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-accent"
            >
              <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
              {t('stats.retry', { defaultValue: 'Try again' })}
            </button>
          )}
        </div>
      </div>
    );
  }

  // The two payloads are independent: an unpriced project still has files, and a
  // priced one on an older server has no walk. Only when BOTH are missing is
  // there nothing to show.
  if (!stats) {
    if (cost || codeStats) {
      const firstDay = cost?.firstDay ?? null;
      const lastDay = cost?.lastDay ?? null;
      const span = spanInDays(firstDay, lastDay);
      return (
        <div className="h-full overflow-y-auto p-4">
          <div className="mx-auto flex max-w-3xl flex-col gap-4">
            {cost && (
              <>
                <CostHeadline
                  totalUsd={cost.totalUsd}
                  complete={cost.complete}
                  unpricedModels={cost.unpricedModels}
                  assumedModels={cost.assumedModels}
                />
                {(firstDay || lastDay) && (
                  <div className="grid grid-cols-1 gap-3 min-[420px]:grid-cols-3">
                    <StatTile
                      icon={<Timer className="h-3.5 w-3.5" />}
                      label={t('stats.ledgerSpan', { defaultValue: 'Measured ledger coverage' })}
                      value={span === null ? null : formatCostCount(span)}
                    />
                    <StatTile
                      icon={<CalendarDays className="h-3.5 w-3.5" />}
                      label={t('stats.ledgerFirstActivity', {
                        defaultValue: 'First ledger activity',
                      })}
                      value={formatDayLabel(firstDay, locale)}
                    />
                    <StatTile
                      icon={<CalendarDays className="h-3.5 w-3.5" />}
                      label={t('stats.dataThrough', { defaultValue: 'Data measured through' })}
                      value={formatDayLabel(lastDay, locale)}
                    />
                  </div>
                )}
              </>
            )}
            {codeStats && (
              <CodebaseSection codeStats={codeStats} onRefresh={onRefreshCodeStats} />
            )}
            {!cost && (
              <p className="text-[10px] text-muted-foreground">
                {t('stats.empty', {
                  defaultValue: 'No cost data has been measured for this project yet.',
                })}
              </p>
            )}
          </div>
        </div>
      );
    }

    return (
      <div className="flex h-full items-center justify-center p-8 text-center text-sm text-muted-foreground">
        {t('stats.empty', { defaultValue: 'No cost data has been measured for this project yet.' })}
      </div>
    );
  }

  const totalComesFromStats = stats.totalUsd !== null;
  const totalUsd = stats.totalUsd ?? cost?.totalUsd ?? null;
  const complete = totalComesFromStats ? stats.complete : (cost?.complete ?? false);
  const unpricedModels = totalComesFromStats
    ? stats.unpricedModels
    : (cost?.unpricedModels ?? []);
  const assumedModels = totalComesFromStats
    ? stats.assumedModels
    : (cost?.assumedModels ?? []);
  const pricesAsOf = stats.pricesAsOf ?? cost?.pricesAsOf ?? null;

  const firstDay = toDay(stats.firstActivity) ?? cost?.firstDay ?? null;
  const lastDay = toDay(stats.lastActivity) ?? cost?.lastDay ?? null;
  const dataThrough = toDay(stats.dataThrough) ?? lastDay;
  const projectActivityThrough = toDay(stats.projectActivityThrough);
  const ledgerLagDays = ledgerLagInDays(dataThrough, projectActivityThrough);
  const span = spanInDays(firstDay, lastDay);

  const dailyWindow = buildDailyWindow(stats.daily, dataThrough, SPARK_MAX_DAYS);
  const series = dailyWindow?.points ?? [];
  const spark = buildSparkline(series, {
    width: SPARK_WIDTH,
    height: SPARK_HEIGHT,
    rangeStart: dailyWindow?.startDay,
    rangeEnd: dailyWindow?.endDay,
  });
  const peakUsd = spark?.maxUsd ?? 0;

  return (
    <div className="h-full overflow-y-auto p-4">
      <div className="mx-auto flex max-w-3xl flex-col gap-4">
        {/* Headline: the lifetime figure and, inseparable from it, what it is not. */}
        <CostHeadline
          totalUsd={totalUsd}
          complete={complete}
          unpricedModels={unpricedModels}
          assumedModels={assumedModels}
        />

        {ledgerLagDays !== null && ledgerLagDays > 2 && (
          <div className="rounded-xl border border-warning/40 bg-warning/5 p-3 text-[11px] leading-relaxed text-warning">
            {t('stats.ledgerActivityComparison', {
              defaultValue:
                'Latest ledger activity: {{dataDate}} · Latest indexed project activity: {{activityDate}}',
              dataDate: formatDayLabel(dataThrough, locale),
              activityDate: formatDayLabel(projectActivityThrough, locale),
            })}
          </div>
        )}

        {/* Working rhythm. */}
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <StatTile
            icon={<CalendarDays className="h-3.5 w-3.5" />}
            label={t('stats.pricedActiveDays', {
              defaultValue: 'Days represented in ledger',
            })}
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
            label={t('stats.ledgerSpan', { defaultValue: 'Measured ledger coverage' })}
            value={span === null ? null : formatCostCount(span)}
            hint={formatDayLabel(firstDay, locale)}
          />
          <StatTile
            icon={<MessagesSquare className="h-3.5 w-3.5" />}
            label={t('stats.ledgerConversations', {
              defaultValue: 'Conversations in ledger',
            })}
            value={stats.conversations === null ? null : formatCostCount(stats.conversations)}
          />
          <StatTile
            icon={<Bot className="h-3.5 w-3.5" />}
            label={t('stats.measuredDelegatedAgents', {
              defaultValue: 'Delegated agents measured',
            })}
            value={
              stats.agents === null
                ? null
                : formatCostCount(stats.agents.filter((agent) => agent.kind === 'subagent').length)
            }
          />
        </div>

        {stats.agents && <AgentList agents={stats.agents} />}
        <ProjectSkillsSection skills={stats.skills} stale={stats.skillsStale} />

        <GapList gaps={stats.gaps} />

        {/* Daily cost — an inline SVG, no charting dependency. */}
        {spark && (
          <div className="rounded-xl border border-border/60 bg-card p-3">
            <div className="mb-2 flex items-baseline justify-between gap-2">
              <span className="text-[11px] font-medium text-muted-foreground">
                {t('stats.dailyLastDays', {
                  defaultValue: 'Daily priced usage — last {{days}} days',
                  days: SPARK_MAX_DAYS,
                })}
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
                  className={cn(
                    bar.assumed ? 'fill-primary/40' : bar.unpriced ? 'fill-warning' : 'fill-primary/70',
                  )}
                >
                  <title>
                    {bar.unpriced && bar.costUsd === 0
                      ? `${bar.day} · ${t('stats.dailyUnpriced', { defaultValue: 'Unpriced usage' })}`
                      : bar.assumed && bar.unpriced
                        ? `${bar.day} · ≈${formatCostUsd(bar.costUsd)} · ${t('stats.dailyMixedEstimate', { defaultValue: 'Partial estimate; some usage remains unpriced' })}`
                        : `${bar.day} · ${bar.assumed ? '≈' : bar.unpriced ? '≥' : ''}${formatCostUsd(bar.costUsd)}`}
                  </title>
                </rect>
              ))}
            </svg>
            <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-[9px] text-muted-foreground">
              <span>{t('stats.dailyLegendComplete', { defaultValue: '■ Complete priced value' })}</span>
              <span>{t('stats.dailyLegendEstimate', { defaultValue: '■ ≈ Estimated value' })}</span>
              <span>{t('stats.dailyLegendFloor', { defaultValue: '■ ≥ Priced floor / unpriced usage' })}</span>
              {spark.bars.some((bar) => bar.assumed && bar.unpriced) && (
                <span>
                  {t('stats.dailyLegendMixed', {
                    defaultValue: '■ ≈ Partial estimate; some usage remains unpriced',
                  })}
                </span>
              )}
            </div>
            <div className="mt-1 flex justify-between text-[10px] text-muted-foreground">
              <bdi>{formatDayLabel(dailyWindow?.startDay ?? null, locale)}</bdi>
              <bdi>{formatDayLabel(dailyWindow?.endDay ?? null, locale)}</bdi>
            </div>
          </div>
        )}

        {/* First/last activity as dates, next to the rhythm they explain. */}
        {(firstDay || lastDay) && (
          <div className="grid grid-cols-1 gap-3 min-[420px]:grid-cols-2">
            <StatTile
              icon={<CalendarDays className="h-3.5 w-3.5" />}
              label={t('stats.ledgerFirstActivity', { defaultValue: 'First ledger activity' })}
              value={formatDayLabel(firstDay, locale)}
            />
            <StatTile
              icon={<CalendarDays className="h-3.5 w-3.5" />}
              label={t('stats.dataThrough', { defaultValue: 'Latest ledger activity' })}
              value={formatDayLabel(dataThrough, locale)}
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

        {/* The working tree, under the money it produced. */}
        {codeStats && (
          <>
            <div className="border-t border-border/60" />
            <CodebaseSection codeStats={codeStats} onRefresh={onRefreshCodeStats} />
          </>
        )}
      </div>
    </div>
  );
}
