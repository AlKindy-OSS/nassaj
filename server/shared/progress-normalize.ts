/**
 * ADR-199: provider-neutral run progress.
 *
 * Every provider adapter maps its own plan/todo and subagent signals through
 * these helpers so the `plan` and `subagent` fields on NormalizedMessage share
 * one vocabulary, one size bound and one text-only rule, whatever the harness.
 * The same validators re-bound the fields when history is projected, so a
 * malformed or oversized value never reaches a client.
 */

export type ProgressItemStatus = 'pending' | 'in_progress' | 'completed';
export type ProgressPlanItem = { id: string; label: string; status: ProgressItemStatus };
/**
 * ADR-199 Addendum A §12: done/total over the FULL list after exclusions, so the
 * percent stays exact when `items` is cut at PLAN_MAX_ITEMS.
 */
export type ProgressPlanCounts = { done: number; total: number };
export type ProgressPlan = { source: 'tool' | 'artifact'; items: ProgressPlanItem[]; counts?: ProgressPlanCounts };
export type SubagentState = 'started' | 'running' | 'completed' | 'failed';
export type ProgressSubagent = { id: string; parentId: string | null; label: string; state: SubagentState };

export const PLAN_MAX_ITEMS = 50;
export const PLAN_LABEL_MAX_CHARS = 200;
export const SUBAGENT_LABEL_MAX_CHARS = 120;
const ID_MAX_CHARS = 200;
/** Entries scanned for `counts`; bounds the work a hostile or runaway list can cause. */
export const PLAN_COUNT_MAX_ENTRIES = 10_000;

const PLAN_SOURCES: ReadonlySet<string> = new Set(['tool', 'artifact']);
const SUBAGENT_STATES: ReadonlySet<string> = new Set(['started', 'running', 'completed', 'failed']);

/** Provider status words mapped onto the three neutral plan states. */
const STATUS_VOCABULARY: Readonly<Record<string, ProgressItemStatus>> = Object.freeze({
  pending: 'pending', todo: 'pending', not_started: 'pending', open: 'pending', queued: 'pending',
  in_progress: 'in_progress', active: 'in_progress', running: 'in_progress', doing: 'in_progress',
  started: 'in_progress',
  completed: 'completed', complete: 'completed', done: 'completed', finished: 'completed',
});

/**
 * ADR-199 Addendum A §4: statuses that remove an item from the snapshot, so it
 * counts in neither the numerator nor the denominator of the percent.
 */
const EXCLUDED_STATUSES: ReadonlySet<string> = new Set(['deleted', 'cancelled', 'canceled', 'skipped']);

/**
 * C0/C1 controls, the Arabic letter mark, zero-width and bidi marks/overrides/
 * isolates, line/paragraph separators, invisible operators and the BOM.
 */
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u2028-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/g;

/**
 * Maps a provider status word to the neutral vocabulary. Case, spaces and
 * hyphens are ignored; any unknown or non-string value is `pending`, so an
 * unrecognized item never inflates the completion percent.
 */
export function normalizePlanStatus(value: unknown): ProgressItemStatus {
  if (typeof value !== 'string') return 'pending';
  const key = value.trim().toLowerCase().replace(/[\s-]+/g, '_');
  return STATUS_VOCABULARY[key] ?? 'pending';
}

/** True when a provider status drops the item from the plan (deleted, cancelled, skipped). */
export function isExcludedPlanStatus(value: unknown): boolean {
  return typeof value === 'string' && EXCLUDED_STATUSES.has(value.trim().toLowerCase().replace(/[\s-]+/g, '_'));
}

/**
 * Plain-text label: strings only, control and bidi-override characters removed,
 * whitespace collapsed, cut to `maxChars` code points with a trailing ellipsis.
 * @returns the label, or '' for a non-string or blank value.
 */
export function toPlainLabel(value: unknown, maxChars: number): string {
  if (typeof value !== 'string') return '';
  const text = value.replace(CONTROL_CHARS, ' ').replace(/\s+/g, ' ').trim();
  const chars = Array.from(text);
  if (chars.length <= maxChars) return text;
  return `${chars.slice(0, Math.max(0, maxChars - 1)).join('').trimEnd()}…`;
}

/**
 * Builds a plan snapshot from provider entries. Entries without a usable label
 * or with an excluded status are dropped and at most PLAN_MAX_ITEMS are kept.
 * `counts` covers every surviving entry (up to PLAN_COUNT_MAX_ENTRIES), not only
 * the kept ones; an unknown status counts as pending.
 * An item's id is the provider's own id when it supplies a non-empty string,
 * else the item's index in this snapshot.
 * @returns the plan, or null when no entry survives (the UI never shows 0%).
 */
export function buildProgressPlan(
  source: ProgressPlan['source'],
  entries: ReadonlyArray<{ id?: unknown; label: unknown; status: unknown }>,
): ProgressPlan | null {
  const items: ProgressPlanItem[] = [];
  let done = 0;
  let total = 0;
  for (const entry of entries.slice(0, PLAN_COUNT_MAX_ENTRIES)) {
    if (isExcludedPlanStatus(entry?.status)) continue;
    const keep = items.length < PLAN_MAX_ITEMS;
    const label = keep ? toPlainLabel(entry?.label, PLAN_LABEL_MAX_CHARS) : '';
    if (keep ? !label : !hasPlainLabel(entry?.label)) continue;
    const status = normalizePlanStatus(entry?.status);
    total += 1;
    if (status === 'completed') done += 1;
    if (!keep) continue;
    const id = typeof entry?.id === 'string' && entry.id ? entry.id.slice(0, ID_MAX_CHARS) : String(items.length);
    items.push({ id, label, status });
  }
  return items.length > 0 ? { source, items, counts: { done, total } } : null;
}

/** Cheap "would toPlainLabel return non-empty" check for entries past the item cap. */
function hasPlainLabel(value: unknown): boolean {
  return typeof value === 'string' && value.replace(CONTROL_CHARS, ' ').trim().length > 0;
}

/**
 * Accepts an untrusted `counts` only when it is consistent with the bounded
 * items: whole numbers, done ≤ total, total ≥ items kept, within the scan bound.
 */
function boundPlanCounts(value: unknown, itemCount: number): ProgressPlanCounts | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const { done, total } = value as { done?: unknown; total?: unknown };
  if (!Number.isSafeInteger(done) || !Number.isSafeInteger(total)) return null;
  const d = done as number;
  const t = total as number;
  if (d < 0 || d > t || t < itemCount || t > PLAN_COUNT_MAX_ENTRIES) return null;
  return { done: d, total: t };
}

/**
 * Builds a subagent lifecycle record.
 * @returns the record, or null when `id` is not a non-empty string or `state`
 *   is outside the neutral vocabulary.
 */
export function buildProgressSubagent(fields: {
  id: unknown; parentId?: unknown; label: unknown; state: unknown;
}): ProgressSubagent | null {
  const id = typeof fields.id === 'string' ? fields.id.slice(0, ID_MAX_CHARS) : '';
  if (!id || typeof fields.state !== 'string' || !SUBAGENT_STATES.has(fields.state)) return null;
  const parentId = typeof fields.parentId === 'string' && fields.parentId
    ? fields.parentId.slice(0, ID_MAX_CHARS)
    : null;
  return {
    id,
    parentId,
    label: toPlainLabel(fields.label, SUBAGENT_LABEL_MAX_CHARS),
    state: fields.state as SubagentState,
  };
}

/**
 * Re-validates an untrusted `plan` value (e.g. a cached history row) into a
 * fresh bounded copy that holds only the contract keys.
 * @returns the bounded plan, or null when the value is not a plan.
 */
export function boundProgressPlan(value: unknown): ProgressPlan | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const { source, items, counts } = value as { source?: unknown; items?: unknown; counts?: unknown };
  if (typeof source !== 'string' || !PLAN_SOURCES.has(source) || !Array.isArray(items)) return null;
  const entries = items.slice(0, PLAN_MAX_ITEMS).map((item: unknown) => {
    const record = item && typeof item === 'object' ? item as Record<string, unknown> : {};
    return { id: record.id, label: record.label, status: record.status };
  });
  const plan = buildProgressPlan(source as ProgressPlan['source'], entries);
  if (!plan) return null;
  const carried = boundPlanCounts(counts, plan.items.length);
  return carried ? { ...plan, counts: carried } : plan;
}

/**
 * Re-validates an untrusted `subagent` value into a fresh bounded copy.
 * @returns the bounded record, or null when the value is not a subagent record.
 */
export function boundProgressSubagent(value: unknown): ProgressSubagent | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  return buildProgressSubagent({
    id: record.id, parentId: record.parentId, label: record.label, state: record.state,
  });
}
