/**
 * Parent-side checks on a Vega / Vega-Lite spec before it reaches the frame.
 *
 * A sandboxed frame may share the page's main thread (browsers do not always
 * isolate opaque-origin frames into their own process), so a spec that asks for
 * unbounded work — a billion-row `sequence`, a `cross` of two big sequences, or
 * a `timer` event stream that recomputes forever — could freeze the whole tab.
 * Such specs are shown as source instead. Specs are data, so this is a plain
 * structural walk; nothing is evaluated.
 */

/** Largest sequence allowed on its own. */
export const MAX_SEQUENCE_ROWS = 100_000;
/** Largest sequence allowed when the spec also has a `cross` transform (rows²). */
export const MAX_SEQUENCE_ROWS_WITH_CROSS = 1_000;

type Json = unknown;

function isRecord(value: Json): value is Record<string, Json> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** Row count of a sequence definition, or Infinity when it is not a plain bounded number range. */
function sequenceRows(def: Record<string, Json>): number {
  const { start = 0, stop, step = 1 } = def;
  if (typeof start !== 'number' || typeof stop !== 'number' || typeof step !== 'number') return Infinity;
  if (!Number.isFinite(start) || !Number.isFinite(stop) || !Number.isFinite(step) || step === 0) return Infinity;
  const rows = Math.ceil((stop - start) / step);
  return rows > 0 ? rows : 0;
}

const TIMER_RE = /(^|[^\w-])timer\b/i;

function mentionsTimer(events: Json): boolean {
  if (typeof events === 'string') return TIMER_RE.test(events);
  if (Array.isArray(events)) return events.some(mentionsTimer);
  if (isRecord(events)) {
    if (events.type === 'timer') return true;
    return Object.values(events).some(mentionsTimer);
  }
  return false;
}

type Findings = { maxSequence: number; hasCross: boolean; hasTimer: boolean };

function walk(node: Json, found: Findings, depth: number): void {
  if (depth > 64) {
    found.maxSequence = Infinity;
    return;
  }
  if (Array.isArray(node)) {
    node.forEach((child) => walk(child, found, depth + 1));
    return;
  }
  if (!isRecord(node)) return;
  if (node.type === 'sequence') found.maxSequence = Math.max(found.maxSequence, sequenceRows(node));
  if (isRecord(node.sequence)) found.maxSequence = Math.max(found.maxSequence, sequenceRows(node.sequence));
  if (node.type === 'cross') found.hasCross = true;
  // Vega: signal `on[].events`, `streams`; Vega-Lite: param `select.on` / `clear`.
  for (const key of ['events', 'on', 'clear', 'between', 'source']) {
    if (key in node && mentionsTimer(node[key])) found.hasTimer = true;
  }
  Object.values(node).forEach((child) => walk(child, found, depth + 1));
}

/** Returns a short reason when the spec must not run, else `null`. */
export function checkSpecBudget(spec: Json): string | null {
  const found: Findings = { maxSequence: 0, hasCross: false, hasTimer: false };
  walk(spec, found, 0);
  if (found.hasTimer) return 'timer events are not allowed in chat charts';
  const cap = found.hasCross ? MAX_SEQUENCE_ROWS_WITH_CROSS : MAX_SEQUENCE_ROWS;
  if (found.maxSequence > cap) return `sequence too large (limit ${cap} rows)`;
  return null;
}

/**
 * Removes `usermeta.embedOptions`: vega-embed merges it over the options the
 * frame sets, so a spec could otherwise turn the AST interpreter off, re-enable
 * the actions menu, or swap the refusing loader.
 */
export function stripEmbedOptions<T>(spec: T): T {
  if (!isRecord(spec) || !isRecord(spec.usermeta) || !('embedOptions' in spec.usermeta)) return spec;
  const { embedOptions: _dropped, ...usermeta } = spec.usermeta;
  return { ...spec, usermeta } as T;
}
