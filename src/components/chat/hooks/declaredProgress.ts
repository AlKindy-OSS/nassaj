/**
 * declaredProgress — completion percent that an agent REPORTS about itself in
 * prose, using the governance progress line:
 *
 *   ⏳ 40% · done: X · next: Y · left ~R min      (also `✅ 100% · …`)
 *
 * This is "declared" data: it is only as true as the agent that wrote it, so the
 * UI must label it as such and keep it distinct from the computed plan
 * fraction. The parser is deliberately tolerant (missing parts, Arabic labels,
 * Arabic-Indic digits) and never fabricates a value: no match ⇒ `null`.
 */

export interface DeclaredProgress {
  /** 0–100, clamped and rounded. */
  percent: number;
  done?: string;
  next?: string;
  /** Minutes left, as reported. */
  left?: number;
}

const ARABIC_INDIC_ZERO = 0x0660;
const EXTENDED_ARABIC_INDIC_ZERO = 0x06f0;

/** Map Arabic-Indic (٠-٩) and Persian (۰-۹) digits, and the Arabic decimal mark, to ASCII. */
function normalizeDigits(text: string): string {
  return text
    .replace(/[٠-٩]/g, (c) => String(c.charCodeAt(0) - ARABIC_INDIC_ZERO))
    .replace(/[۰-۹]/g, (c) => String(c.charCodeAt(0) - EXTENDED_ARABIC_INDIC_ZERO))
    .replace(/٫/g, '.');
}

// Marker + number + percent sign (ASCII % or Arabic ٪). Leading markdown noise
// (quote, bullet, bold, heading) is tolerated.
const HEAD_RE = /^[\s>*_#-]*[⏳✅]️?\s*(\d+(?:\.\d+)?)\s*[%٪]/u;
const SEGMENT_SPLIT_RE = /\s*[·•|]\s*/u;
const DONE_LABEL_RE = /^(?:done|تم|أنجز\S*|انجز\S*|منجز\S*)\s*[:：]\s*(.+)$/iu;
const NEXT_LABEL_RE = /^(?:next|التالي\S*|الخطوة التالية)\s*[:：]\s*(.+)$/iu;
const LEFT_LABEL_RE = /^(?:left|متبقي\S*|المتبقي\S*|تبقى|بقي)\s*[:：]?\s*~?\s*(\d+(?:\.\d+)?)/iu;

function readSegments(segments: string[]): Omit<DeclaredProgress, 'percent'> {
  const out: Omit<DeclaredProgress, 'percent'> = {};
  for (const raw of segments) {
    const segment = raw.trim();
    const done = DONE_LABEL_RE.exec(segment);
    if (done) { out.done = done[1].trim(); continue; }
    const next = NEXT_LABEL_RE.exec(segment);
    if (next) { out.next = next[1].trim(); continue; }
    const left = LEFT_LABEL_RE.exec(segment);
    if (left) out.left = Number(left[1]);
  }
  return out;
}

/** Parse ONE line; `null` when it is not a progress line. */
export function parseDeclaredProgressLine(line: string): DeclaredProgress | null {
  const normalized = normalizeDigits(line);
  const head = HEAD_RE.exec(normalized);
  if (!head) return null;
  const percent = Math.min(100, Math.max(0, Math.round(Number(head[1]))));
  const rest = normalized.slice(head[0].length).split(SEGMENT_SPLIT_RE);
  return { percent, ...readSegments(rest) };
}

/** Drop fenced code blocks (an unclosed fence runs to the end): quoted examples are not reports. */
function stripCodeFences(text: string): string {
  return text.replace(/^[ \t]*(```|~~~)[^\n]*\n[\s\S]*?(?:^[ \t]*\1[^\n]*$|(?![\s\S]))/gm, '');
}

/** Parse a whole text block; the LATEST progress line wins. */
export function parseLatestDeclaredProgress(text: string): DeclaredProgress | null {
  if (!text || (!text.includes('%') && !text.includes('٪'))) return null;
  const lines = stripCodeFences(text).split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const parsed = parseDeclaredProgressLine(lines[i]);
    if (parsed) return parsed;
  }
  return null;
}

export interface OverallPercent {
  percent: number;
  /** `tasks` = computed from the plan snapshot; the others are agent-reported. */
  source: 'tasks' | 'declared' | 'agents';
}

/** Minimal slice of RunProgress the resolver needs (avoids a circular import). */
interface OverallInput {
  done: number;
  total: number;
  inProgress: number;
  declaredPercent?: number | null;
  agents: Array<{ status: 'running' | 'done' | 'stale'; progress?: DeclaredProgress }>;
}

/**
 * Overall completion, in priority order: plan fraction (computed) →
 * coordinator's own declared line → average of the agents' values. The average
 * is only offered when EVERY agent has a value (declared, or done via its
 * tool_result = 100); one unknown agent makes the average a guess, so we hide it.
 */
export function resolveOverallPercent(input: OverallInput): OverallPercent | null {
  if (input.total > 0) {
    const ratio = Math.min(1, (input.done + 0.5 * input.inProgress) / input.total);
    return { percent: Math.round(ratio * 100), source: 'tasks' };
  }
  if (input.declaredPercent != null) {
    return { percent: input.declaredPercent, source: 'declared' };
  }
  if (input.agents.length === 0) return null;
  let sum = 0;
  for (const agent of input.agents) {
    const value = agent.status === 'done' ? 100 : agent.progress?.percent;
    if (value === undefined) return null;
    sum += value;
  }
  return { percent: Math.round(sum / input.agents.length), source: 'agents' };
}
