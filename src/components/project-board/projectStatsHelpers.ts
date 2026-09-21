/**
 * projectStatsHelpers — pure normalisation + geometry for the project statistics
 * tab and the cumulative total shown in the board header.
 *
 * The honesty rules of ADR-078 are enforced HERE, not in the views, so they are
 * testable and cannot be "fixed" by a styling change:
 *
 *  • A number we do not have is `null`, never 0. `null` reaches the view as a
 *    dash, so an older server (endpoint absent) or a model with no official
 *    price can never be rendered as `$0.00`.
 *  • A calendar day INSIDE the measured range with no spend is a real, measured
 *    zero — that one is legitimate, and it is the only zero this file invents
 *    (see fillDailyGaps: without it a two-week silence draws as a dense bar row
 *    and reads like continuous work).
 *  • Nothing is derived by guessing: shares are computed only from the amounts
 *    the server actually priced, so an unpriced model dilutes nothing.
 *
 * The payloads are normalised defensively (arrays OR maps, several key spellings)
 * because the two endpoints are young; an unexpected shape must degrade to
 * "unavailable", never to a confident wrong figure.
 */

/** `GET /api/projects/:projectId/cost` → the `cost` field. */
export type ProjectCost = {
  /** null = not computed; the view shows a dash, never 0.00. */
  totalUsd: number | null;
  /** false = some models had no official price (they are named in unpricedModels). */
  complete: boolean;
  unpricedModels: string[];
  assumedModels: string[];
  firstDay: string | null;
  lastDay: string | null;
  pricesAsOf: string | null;
};

export type DailyCost = {
  day: string;
  costUsd: number;
  complete: boolean;
  unpriced: boolean;
  assumed: boolean;
};

/** One row of the vendor/model breakdown. `share` is 0..1 of the priced total. */
export type BreakdownEntry = {
  label: string;
  costUsd: number | null;
  share: number;
  requests: number | null;
  /** False means the priced amount is a floor because some usage was not priced. */
  complete: boolean;
  unpriced: boolean;
  assumed: boolean;
};

export type ProjectAgentEntry = {
  name: string;
  invocations: number;
  kind: 'model' | 'subagent';
};

export type ProjectStatsGap = { harness: string; reason: string };

/** `GET /api/projects/:projectId/stats` → the `stats` field. */
import { readProjectSkillProjection } from '../participants/skillObservationPayload';

export type ProjectStats = {
  skills?: import('../../../shared/skillObservations').ProjectSkillProjection | null;
  skillsStale?: boolean;
  totalUsd: number | null;
  /** Unknown completeness is conservative: false, never an unearned "complete". */
  complete: boolean;
  unpricedModels: string[];
  assumedModels: string[];
  gaps: ProjectStatsGap[];
  daily: DailyCost[];
  activeDays: number | null;
  firstActivity: string | null;
  lastActivity: string | null;
  dataThrough: string | null;
  projectActivityThrough: string | null;
  conversations: number | null;
  agents: ProjectAgentEntry[] | null;
  byVendor: BreakdownEntry[];
  byModel: BreakdownEntry[];
  pricesAsOf: string | null;
};

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** A finite number, or null. Negative amounts are treated as unknown, not as credit. */
function asAmount(value: unknown): number | null {
  const amount = typeof value === 'number' ? value : Number.NaN;
  return Number.isFinite(amount) && amount >= 0 ? amount : null;
}

/** A non-negative integer count, or null when the server did not report one. */
function asCount(value: unknown): number | null {
  const count = typeof value === 'number' ? value : Number.NaN;
  return Number.isFinite(count) && count >= 0 ? Math.round(count) : null;
}

function asText(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function asStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => asText(item)).filter((item): item is string => item !== null);
}

/** First amount-shaped field present, so `costUsd` / `totalUsd` / `usd` all work. */
function pickAmount(row: Record<string, unknown>): number | null {
  for (const key of ['costUsd', 'totalUsd', 'usd', 'cost', 'amountUsd']) {
    if (key in row) return asAmount(row[key]);
  }
  return null;
}

function pickLabel(row: Record<string, unknown>, preferredKeys: string[] = []): string | null {
  for (const key of [...preferredKeys, 'label', 'vendor', 'model', 'name', 'key', 'id']) {
    const text = asText(row[key]);
    if (text) return text;
  }
  return null;
}

/**
 * Normalises a `byVendor` / `byModel` breakdown from either an array of rows or
 * a plain map, sorts it by amount (unpriced rows last — they are unknown, not
 * cheap) and computes each row's share of the PRICED total only.
 */
export function normalizeBreakdown(
  raw: unknown,
  options: { preferredLabelKeys?: string[] } = {},
): BreakdownEntry[] {
  const rows: {
    label: string;
    costUsd: number | null;
    requests: number | null;
    complete: boolean;
    unpriced: boolean;
    assumed: boolean;
  }[] = [];

  if (Array.isArray(raw)) {
    for (const item of raw) {
      const row = asRecord(item);
      if (!row) continue;
      const label = pickLabel(row, options.preferredLabelKeys);
      if (!label) continue;
      rows.push({
        label,
        costUsd: pickAmount(row),
        requests: asCount(row.requests),
        complete: row.complete === true,
        unpriced: row.unpriced === true,
        assumed: row.assumed === true,
      });
    }
  } else {
    const map = asRecord(raw);
    if (!map) return [];
    for (const [label, value] of Object.entries(map)) {
      if (!label.trim()) continue;
      const nested = asRecord(value);
      rows.push({
        label: label.trim(),
        costUsd: nested ? pickAmount(nested) : asAmount(value),
        requests: nested ? asCount(nested.requests) : null,
        complete: nested ? nested.complete === true : false,
        unpriced: nested ? nested.unpriced === true : false,
        assumed: nested ? nested.assumed === true : false,
      });
    }
  }

  const pricedTotal = rows.reduce((sum, row) => sum + (row.costUsd ?? 0), 0);

  return rows
    .sort((a, b) => {
      if (a.costUsd === null && b.costUsd === null) return a.label.localeCompare(b.label);
      if (a.costUsd === null) return 1;
      if (b.costUsd === null) return -1;
      return b.costUsd - a.costUsd;
    })
    .map((row) => ({
      ...row,
      share: pricedTotal > 0 && row.costUsd !== null ? row.costUsd / pricedTotal : 0,
    }));
}

function normalizeGaps(raw: unknown): ProjectStatsGap[] {
  if (!Array.isArray(raw)) return [];
  const gaps: ProjectStatsGap[] = [];
  for (const item of raw) {
    const row = asRecord(item);
    if (!row) continue;
    const harness = asText(row.harness);
    const reason = asText(row.reason);
    if (harness !== null && reason !== null) gaps.push({ harness, reason });
  }
  return gaps;
}

function normalizeAgents(raw: unknown): ProjectAgentEntry[] | null {
  if (raw === null || raw === undefined) return null;
  if (!Array.isArray(raw)) return null;

  const agents: ProjectAgentEntry[] = [];
  for (const item of raw) {
    const row = asRecord(item);
    if (!row) continue;
    const name = asText(row.name);
    const invocations = asCount(row.invocations);
    const kind = row.kind === 'model' || row.kind === 'subagent' ? row.kind : null;
    if (name !== null && invocations !== null && kind !== null) {
      agents.push({ name, invocations, kind });
    }
  }
  // An older or malformed roster without `kind` must not make base models look
  // like delegated agents. Preserve the distinction as unknown until rescanned.
  if (raw.length > 0 && agents.length === 0) return null;
  return agents;
}

/** Valid `{day, costUsd}` points only, ascending by day. Bad rows are dropped. */
export function normalizeDaily(raw: unknown): DailyCost[] {
  if (!Array.isArray(raw)) return [];
  const points: DailyCost[] = [];
  for (const item of raw) {
    const row = asRecord(item);
    if (!row) continue;
    const day = asText(row.day) ?? asText(row.date);
    if (!day || !ISO_DAY.test(day)) continue;
    const costUsd = pickAmount(row);
    // A day the server listed without a priced amount contributes no bar, but it
    // must not become a fabricated 0 in the total either — it is simply skipped.
    if (costUsd === null) continue;
    points.push({
      day,
      costUsd,
      complete: row.complete === true,
      unpriced: row.unpriced === true,
      assumed: row.assumed === true,
    });
  }
  return points.sort((a, b) => a.day.localeCompare(b.day));
}

/**
 * `{ success, cost }` → ProjectCost, or null when there is nothing honest to
 * show (older server, error body, or a payload with no total at all).
 */
export function normalizeProjectCost(raw: unknown): ProjectCost | null {
  const envelope = asRecord(raw);
  if (!envelope) return null;
  if (envelope.success === false) return null;
  const cost = asRecord(envelope.cost) ?? envelope;

  const totalUsd = asAmount(cost.totalUsd);
  if (totalUsd === null) return null;

  return {
    totalUsd,
    complete: cost.complete === true,
    unpricedModels: asStringList(cost.unpricedModels),
    assumedModels: asStringList(cost.assumedModels),
    firstDay: asText(cost.firstDay),
    lastDay: asText(cost.lastDay),
    pricesAsOf: asText(cost.pricesAsOf),
  };
}

/**
 * `{ success, stats }` → ProjectStats, or null when the payload carries no
 * usable figure at all (rendering an empty shell is worse than rendering
 * nothing — it implies the project has no activity).
 */
export function normalizeProjectStats(raw: unknown): ProjectStats | null {
  const envelope = asRecord(raw);
  if (!envelope) return null;
  if (envelope.success === false) return null;
  const stats = asRecord(envelope.stats) ?? envelope;

  const normalized: ProjectStats = {
    skills: readProjectSkillProjection(stats.skills),
    totalUsd: asAmount(stats.totalUsd),
    complete: stats.complete === true,
    unpricedModels: asStringList(stats.unpricedModels),
    assumedModels: asStringList(stats.assumedModels),
    gaps: normalizeGaps(stats.gaps),
    daily: normalizeDaily(stats.daily),
    activeDays: asCount(stats.activeDays),
    firstActivity: asText(stats.firstActivity),
    lastActivity: asText(stats.lastActivity),
    dataThrough: asText(stats.dataThrough),
    projectActivityThrough: asText(stats.projectActivityThrough),
    conversations: asCount(stats.conversations),
    agents: normalizeAgents(stats.agents),
    byVendor: normalizeBreakdown(stats.byVendor, {
      preferredLabelKeys: ['displayName', 'vendor'],
    }),
    byModel: normalizeBreakdown(stats.byModel, { preferredLabelKeys: ['model'] }),
    pricesAsOf: asText(stats.pricesAsOf),
  };

  const hasSomething =
    normalized.skills != null ||
    normalized.totalUsd !== null ||
    normalized.daily.length > 0 ||
    normalized.activeDays !== null ||
    normalized.conversations !== null ||
    normalized.agents !== null ||
    normalized.byVendor.length > 0 ||
    normalized.byModel.length > 0;

  return hasSomething ? normalized : null;
}

// ── calendar ────────────────────────────────────────────────────────────────

/** Parses an ISO day at UTC noon, so a DST shift can never move it a day. */
function parseDay(day: string | null): number | null {
  if (!day || !ISO_DAY.test(day)) return null;
  const time = Date.parse(`${day}T12:00:00Z`);
  return Number.isFinite(time) ? time : null;
}

const DAY_MS = 86_400_000;

function toIsoDay(time: number): string {
  return new Date(time).toISOString().slice(0, 10);
}

/** Inclusive day count between two ISO days, or null if either is unusable. */
export function spanInDays(first: string | null, last: string | null): number | null {
  const from = parseDay(first);
  const to = parseDay(last);
  if (from === null || to === null || to < from) return null;
  return Math.round((to - from) / DAY_MS) + 1;
}

/** Whole-day lag between ledger coverage and observed project activity. */
export function ledgerLagInDays(
  dataThrough: string | null,
  projectActivityThrough: string | null,
): number | null {
  const ledger = parseDay(dataThrough);
  const activity = parseDay(projectActivityThrough);
  if (ledger === null || activity === null || activity <= ledger) return null;
  return Math.round((activity - ledger) / DAY_MS);
}

export type DailyWindow = {
  points: DailyCost[];
  startDay: string;
  endDay: string;
};

/** Sparse, calendar-positioned window ending at the latest indexed ledger day. */
export function buildDailyWindow(
  points: DailyCost[],
  endDay: string | null,
  maxDays = 90,
): DailyWindow | null {
  if (maxDays < 1) return null;
  const sorted = [...points].sort((a, b) => a.day.localeCompare(b.day));
  const end = parseDay(endDay) ?? parseDay(sorted.at(-1)?.day ?? null);
  if (end === null) return null;
  const start = end - (maxDays - 1) * DAY_MS;
  const byDay = new Map<string, DailyCost>();

  for (const point of sorted) {
    const time = parseDay(point.day);
    if (time === null || time < start || time > end) continue;
    const previous = byDay.get(point.day);
    byDay.set(
      point.day,
      previous
        ? {
            day: point.day,
            costUsd: previous.costUsd + point.costUsd,
            complete: previous.complete && point.complete,
            unpriced: previous.unpriced || point.unpriced,
            assumed: previous.assumed || point.assumed,
          }
        : { ...point },
    );
  }

  return {
    points: [...byDay.values()].sort((a, b) => a.day.localeCompare(b.day)),
    startDay: toIsoDay(start),
    endDay: toIsoDay(end),
  };
}

/**
 * Dense calendar series for the sparkline: every day between the first and last
 * measured point, capped to the most recent `maxDays`. The inserted zeros are
 * measured silence inside a known range, not unknown data.
 */
export function fillDailyGaps(points: DailyCost[], maxDays = 90): DailyCost[] {
  if (points.length === 0) return [];
  const sorted = [...points].sort((a, b) => a.day.localeCompare(b.day));
  const start = parseDay(sorted[0].day);
  const end = parseDay(sorted[sorted.length - 1].day);
  if (start === null || end === null) return sorted.slice(-maxDays);

  const byDay = new Map<string, DailyCost>();
  for (const point of sorted) {
    // Duplicate days are summed rather than overwritten — a lost bar would
    // silently shrink the visible history. Preserve the weakest completeness
    // and every qualification while combining them: aggregation must never
    // upgrade an estimated/unpriced day to a complete one.
    const previous = byDay.get(point.day);
    byDay.set(
      point.day,
      previous
        ? {
            day: point.day,
            costUsd: previous.costUsd + point.costUsd,
            complete: previous.complete && point.complete,
            unpriced: previous.unpriced || point.unpriced,
            assumed: previous.assumed || point.assumed,
          }
        : { ...point },
    );
  }

  const series: DailyCost[] = [];
  for (let time = start; time <= end; time += DAY_MS) {
    const day = toIsoDay(time);
    series.push(byDay.get(day) ?? {
      day,
      costUsd: 0,
      complete: true,
      unpriced: false,
      assumed: false,
    });
  }
  return series.length > maxDays ? series.slice(-maxDays) : series;
}

// ── sparkline geometry ──────────────────────────────────────────────────────

export type SparkBar = {
  day: string;
  costUsd: number;
  /** Distance from the LEFT edge of the viewBox — the SVG is drawn LTR and the
   *  component mirrors it as a whole under RTL, so time never reads backwards. */
  x: number;
  y: number;
  width: number;
  height: number;
  complete: boolean;
  unpriced: boolean;
  assumed: boolean;
};

export type Sparkline = {
  bars: SparkBar[];
  maxUsd: number;
  width: number;
  height: number;
};

/**
 * Bar geometry for an inline SVG (no charting dependency).
 * Returns null for an empty series so the view can omit the block entirely.
 */
export function buildSparkline(
  series: DailyCost[],
  options: {
    width?: number;
    height?: number;
    gap?: number;
    rangeStart?: string;
    rangeEnd?: string;
  } = {},
): Sparkline | null {
  if (series.length === 0) return null;
  const width = options.width ?? 100;
  const height = options.height ?? 24;
  const gap = options.gap ?? 0.15;

  const maxUsd = series.reduce((max, point) => Math.max(max, point.costUsd), 0);
  const rangeStart = parseDay(options.rangeStart ?? null) ?? parseDay(series[0]?.day ?? null);
  const rangeEnd = parseDay(options.rangeEnd ?? null) ?? parseDay(series.at(-1)?.day ?? null);
  const calendarDays =
    rangeStart !== null && rangeEnd !== null && rangeEnd >= rangeStart
      ? Math.round((rangeEnd - rangeStart) / DAY_MS) + 1
      : series.length;
  const slot = width / Math.max(1, calendarDays);
  const barWidth = Math.max(slot * (1 - gap), slot * 0.25);

  const bars = series.map((point, index) => {
    // A positive day always keeps a visible sliver: rounding a real $0.30 next
    // to a $900 peak down to nothing would show "no work" on a day there was.
    const ratio = maxUsd > 0 ? point.costUsd / maxUsd : 0;
    const hasMarker = point.costUsd > 0 || point.unpriced;
    const barHeight = hasMarker ? Math.max(height * ratio, height * 0.06) : 0;
    const pointTime = parseDay(point.day);
    const calendarIndex =
      rangeStart !== null && pointTime !== null
        ? Math.round((pointTime - rangeStart) / DAY_MS)
        : index;
    return {
      day: point.day,
      costUsd: point.costUsd,
      x: calendarIndex * slot + (slot - barWidth) / 2,
      y: height - barHeight,
      width: barWidth,
      height: barHeight,
      complete: point.complete,
      unpriced: point.unpriced,
      assumed: point.assumed,
    };
  });

  return { bars, maxUsd, width, height };
}

// ── display ─────────────────────────────────────────────────────────────────

/** ISO day → a short localised date; unusable input stays as-is. */
export function formatDayLabel(day: string | null, locale: string): string | null {
  const time = parseDay(day);
  if (time === null) return day;
  try {
    return new Intl.DateTimeFormat(locale, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      timeZone: 'UTC',
    }).format(new Date(time));
  } catch {
    return day;
  }
}

/** An activity timestamp (ISO day or full ISO datetime) → its ISO day. */
export function toDay(value: string | null): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (ISO_DAY.test(trimmed)) return trimmed;
  const time = Date.parse(trimmed);
  return Number.isFinite(time) ? toIsoDay(time) : null;
}

// ── Codebase statistics (T-1169) ────────────────────────────────────────────
//
// A second, independent payload on the same tab: the ledger prices
// CONVERSATIONS, this measures FILES. It is normalised here under the same
// honesty rule — an absent or malformed payload becomes `null` (the section
// simply does not render), never a confident zero.

/** One extension row of the file-type mix. */
export type CodeExtensionRow = { extension: string; files: number; bytes: number | null };

/** One file row (largest / recently modified). Path is project-relative. */
export type CodeFileRow = { path: string; bytes: number | null; modifiedAt: number | null };

/** `GET /api/projects/:projectId/code-stats` → the `codeStats` field. */
export type CodebaseStats = {
  totalBytes: number | null;
  totalLines: number | null;
  fileCount: number;
  linesCounted: number | null;
  complete: boolean;
  incompleteReasons: CodebaseStatsIncompleteReason[];
  /** True when the walk hit its file cap: every figure is a floor, and it says so. */
  truncated: boolean;
  byExtension: CodeExtensionRow[];
  largestFiles: CodeFileRow[];
  recentlyModified: CodeFileRow[];
  scannedAt: number | null;
};

export type CodebaseStatsIncompleteReason = { code: string; count: number };

function asNonNegative(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : Number.NaN;
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function normalizeExtensionRows(raw: unknown): CodeExtensionRow[] {
  if (!Array.isArray(raw)) return [];
  const rows: CodeExtensionRow[] = [];
  for (const item of raw) {
    const row = asRecord(item);
    if (!row) continue;
    const extension = asText(row.extension);
    const files = asCount(row.files);
    if (extension === null || files === null) continue;
    rows.push({ extension, files, bytes: asNonNegative(row.bytes) });
  }
  return rows;
}

function normalizeFileRows(raw: unknown): CodeFileRow[] {
  if (!Array.isArray(raw)) return [];
  const rows: CodeFileRow[] = [];
  for (const item of raw) {
    const row = asRecord(item);
    if (!row) continue;
    const filePath = asText(row.path);
    if (filePath === null) continue;
    rows.push({
      path: filePath,
      bytes: asNonNegative(row.bytes),
      modifiedAt: asNonNegative(row.modifiedAt),
    });
  }
  return rows;
}

function normalizeIncompleteReasons(raw: unknown): CodebaseStatsIncompleteReason[] {
  if (!Array.isArray(raw)) return [];
  const reasons: CodebaseStatsIncompleteReason[] = [];
  for (const item of raw) {
    const row = asRecord(item);
    if (!row) continue;
    const code = asText(row.code);
    const count = asCount(row.count);
    if (code !== null && count !== null) reasons.push({ code, count });
  }
  return reasons;
}

export function normalizeCodebaseStats(raw: unknown): CodebaseStats | null {
  const envelope = asRecord(raw);
  if (!envelope) return null;
  const body = asRecord(envelope.codeStats) ?? asRecord(envelope.stats) ?? envelope;

  const fileCount = asCount(body.fileCount);
  // No file count = nothing was measured. Rendering the section with zeros here
  // would claim "we scanned, the project is empty" — which we do not know.
  if (fileCount === null) return null;

  return {
    totalBytes: asNonNegative(body.totalBytes),
    totalLines: asCount(body.totalLines),
    fileCount,
    linesCounted: asCount(body.linesCounted),
    complete: body.complete === true,
    incompleteReasons: normalizeIncompleteReasons(body.incompleteReasons),
    truncated: body.truncated === true,
    byExtension: normalizeExtensionRows(body.byExtension),
    largestFiles: normalizeFileRows(body.largestFiles),
    recentlyModified: normalizeFileRows(body.recentlyModified),
    scannedAt: asNonNegative(body.scannedAt),
  };
}

/** Bytes → `838.0 KB`. Binary-free decimal units, matching what file managers show. */
export function formatBytes(bytes: number, locale: string): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit += 1;
  }
  const digits = unit === 0 ? 0 : 1;
  try {
    return `${new Intl.NumberFormat(locale, {
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    }).format(value)} ${units[unit]}`;
  } catch {
    return `${value.toFixed(digits)} ${units[unit]}`;
  }
}

/** Epoch ms → a short relative label ("2 d"), or null when unknown. */
export function formatRelativeTime(epochMs: number, locale: string, now = Date.now()): string | null {
  if (!Number.isFinite(epochMs) || epochMs <= 0) return null;
  const seconds = Math.round((epochMs - now) / 1000);
  const table: [Intl.RelativeTimeFormatUnit, number][] = [
    ['second', 60],
    ['minute', 60],
    ['hour', 24],
    ['day', 30],
    ['month', 12],
    ['year', Number.POSITIVE_INFINITY],
  ];

  let value = seconds;
  for (const [unit, span] of table) {
    if (Math.abs(value) < span || span === Number.POSITIVE_INFINITY) {
      try {
        return new Intl.RelativeTimeFormat(locale, { numeric: 'auto', style: 'narrow' }).format(
          Math.round(value),
          unit,
        );
      } catch {
        return `${Math.round(value)} ${unit}`;
      }
    }
    value /= span;
  }
  return null;
}
