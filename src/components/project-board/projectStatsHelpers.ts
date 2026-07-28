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
  firstDay: string | null;
  lastDay: string | null;
  pricesAsOf: string | null;
};

export type DailyCost = { day: string; costUsd: number };

/** One row of the vendor/model breakdown. `share` is 0..1 of the priced total. */
export type BreakdownEntry = { label: string; costUsd: number | null; share: number };

/** `GET /api/projects/:projectId/stats` → the `stats` field. */
export type ProjectStats = {
  totalUsd: number | null;
  daily: DailyCost[];
  activeDays: number | null;
  firstActivity: string | null;
  lastActivity: string | null;
  conversations: number | null;
  agents: number | null;
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

function pickLabel(row: Record<string, unknown>): string | null {
  for (const key of ['label', 'vendor', 'model', 'name', 'key', 'id']) {
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
export function normalizeBreakdown(raw: unknown): BreakdownEntry[] {
  const rows: { label: string; costUsd: number | null }[] = [];

  if (Array.isArray(raw)) {
    for (const item of raw) {
      const row = asRecord(item);
      if (!row) continue;
      const label = pickLabel(row);
      if (!label) continue;
      rows.push({ label, costUsd: pickAmount(row) });
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
    points.push({ day, costUsd });
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
    complete: cost.complete !== false,
    unpricedModels: asStringList(cost.unpricedModels),
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
    totalUsd: asAmount(stats.totalUsd),
    daily: normalizeDaily(stats.daily),
    activeDays: asCount(stats.activeDays),
    firstActivity: asText(stats.firstActivity),
    lastActivity: asText(stats.lastActivity),
    conversations: asCount(stats.conversations),
    agents: asCount(stats.agents),
    byVendor: normalizeBreakdown(stats.byVendor),
    byModel: normalizeBreakdown(stats.byModel),
    pricesAsOf: asText(stats.pricesAsOf),
  };

  const hasSomething =
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

  const byDay = new Map<string, number>();
  for (const point of sorted) {
    // Duplicate days are summed rather than overwritten — a lost bar would
    // silently shrink the visible history.
    byDay.set(point.day, (byDay.get(point.day) ?? 0) + point.costUsd);
  }

  const series: DailyCost[] = [];
  for (let time = start; time <= end; time += DAY_MS) {
    const day = toIsoDay(time);
    series.push({ day, costUsd: byDay.get(day) ?? 0 });
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
  options: { width?: number; height?: number; gap?: number } = {},
): Sparkline | null {
  if (series.length === 0) return null;
  const width = options.width ?? 100;
  const height = options.height ?? 24;
  const gap = options.gap ?? 0.15;

  const maxUsd = series.reduce((max, point) => Math.max(max, point.costUsd), 0);
  const slot = width / series.length;
  const barWidth = Math.max(slot * (1 - gap), slot * 0.25);

  const bars = series.map((point, index) => {
    // A positive day always keeps a visible sliver: rounding a real $0.30 next
    // to a $900 peak down to nothing would show "no work" on a day there was.
    const ratio = maxUsd > 0 ? point.costUsd / maxUsd : 0;
    const barHeight = point.costUsd > 0 ? Math.max(height * ratio, height * 0.06) : 0;
    return {
      day: point.day,
      costUsd: point.costUsd,
      x: index * slot + (slot - barWidth) / 2,
      y: height - barHeight,
      width: barWidth,
      height: barHeight,
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
