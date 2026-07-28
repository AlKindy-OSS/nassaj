/**
 * The board file's REAL vocabulary, mapped onto the four states the UI draws.
 *
 * `types.ts` declares `TaskStatus = 'open' | 'in_progress' | 'done'`. The boards
 * on disk do not obey it — measured across three live projects:
 *
 *   AlNuman     31 of 64 tasks (48%)  status: closed, blocked
 *   nassaj-dev 101 of 553 tasks (18%)  status: todo, pending, blocked, backlog,
 *                                              deferred, cancelled
 *   Diwan         7 of 71 tasks  (9%)  status: fixed, accepted, todo
 *
 * The kanban filtered on `task.status === column`, so every one of those rows
 * rendered in NO column and simply vanished — and because the progress bars are
 * derived the same way, 30 finished ("closed") AlNuman tasks also counted
 * against its completion instead of for it. The board did not look broken; it
 * looked like a project with half the work missing, which is worse.
 *
 * The rule this module exists to enforce: **an unrecognised value is displayed,
 * never dropped**. Anything unmapped lands in a visible bucket AND keeps its raw
 * label on screen, so a new word in a board file shows up as a word the owner
 * can read rather than as a silently missing row.
 */

import type { IssueSeverity } from '../types';

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------

/** The columns the kanban draws. `cancelled` is drawn apart, not discarded. */
export type TaskBucket = 'open' | 'in_progress' | 'done' | 'cancelled';

const TASK_STATUS_SYNONYMS: Record<string, TaskBucket> = {
  // done — work that is finished, however the board words it
  done: 'done',
  closed: 'done',
  complete: 'done',
  completed: 'done',
  finished: 'done',
  fixed: 'done',
  resolved: 'done',
  accepted: 'done',
  verified: 'done',
  merged: 'done',
  shipped: 'done',
  released: 'done',

  // in progress — someone is on it right now
  in_progress: 'in_progress',
  'in-progress': 'in_progress',
  inprogress: 'in_progress',
  doing: 'in_progress',
  active: 'in_progress',
  wip: 'in_progress',
  review: 'in_progress',
  in_review: 'in_progress',
  reviewing: 'in_progress',
  verifying: 'in_progress',
  testing: 'in_progress',

  // open — not started, whatever the reason
  open: 'open',
  todo: 'open',
  'to-do': 'open',
  to_do: 'open',
  new: 'open',
  pending: 'open',
  planned: 'open',
  backlog: 'open',
  blocked: 'open',
  deferred: 'open',
  waiting: 'open',
  on_hold: 'open',
  'on-hold': 'open',

  // cancelled — deliberately dropped; must not weigh on progress…
  cancelled: 'cancelled',
  canceled: 'cancelled',
  wontfix: 'cancelled',
  dropped: 'cancelled',
  rejected: 'cancelled',
  obsolete: 'cancelled',
  superseded: 'cancelled',
  duplicate: 'cancelled',
};

/**
 * States that mean "open, but stuck" — the ones an owner must act on. They share
 * the open column with plain todo items, so the card marks them; otherwise a
 * blocked task is indistinguishable from one nobody has picked up yet.
 */
const ATTENTION_STATUSES = new Set(['blocked', 'waiting', 'on_hold', 'on-hold', 'deferred']);

export type TaskStatusView = {
  bucket: TaskBucket;
  /** The word the file used, normalised for display (never empty). */
  raw: string;
  /** True when `raw` says no more than the column header already does. */
  redundant: boolean;
  /** True when the vocabulary does not know this word — shown, never dropped. */
  unknown: boolean;
  /** Blocked / on hold / deferred: open, but stuck. */
  needsAttention: boolean;
};

const normalizeWord = (value: unknown): string =>
  typeof value === 'string' ? value.trim().toLowerCase().replace(/\s+/g, '_') : '';

export function normalizeTaskStatus(raw: unknown): TaskStatusView {
  const word = normalizeWord(raw);
  const mapped = TASK_STATUS_SYNONYMS[word];
  const bucket: TaskBucket = mapped ?? 'open';

  return {
    bucket,
    raw: word || 'unknown',
    // The column already says "Done"; repeating it on every card is noise.
    redundant: Boolean(mapped) && word === bucket,
    unknown: !mapped,
    needsAttention: ATTENTION_STATUSES.has(word),
  };
}

// ---------------------------------------------------------------------------
// Issues
// ---------------------------------------------------------------------------

/** `in_progress` is a real state on these boards, absent from the type union. */
export type IssueBucket = 'open' | 'in_progress' | 'fixed' | 'wontfix';

const ISSUE_STATUS_SYNONYMS: Record<string, IssueBucket> = {
  open: 'open',
  new: 'open',
  reported: 'open',
  confirmed: 'open',
  investigating: 'open',
  backlog: 'open',
  todo: 'open',

  in_progress: 'in_progress',
  'in-progress': 'in_progress',
  fixing: 'in_progress',
  verifying: 'in_progress',
  review: 'in_progress',

  fixed: 'fixed',
  resolved: 'fixed',
  closed: 'fixed',
  done: 'fixed',
  verified: 'fixed',

  wontfix: 'wontfix',
  'wont-fix': 'wontfix',
  wont_fix: 'wontfix',
  rejected: 'wontfix',
  duplicate: 'wontfix',
  obsolete: 'wontfix',
  invalid: 'wontfix',
};

export type IssueStatusView = {
  bucket: IssueBucket;
  raw: string;
  unknown: boolean;
  /** Drives ordering: unresolved issues lead the list. */
  resolved: boolean;
};

export function normalizeIssueStatus(raw: unknown): IssueStatusView {
  const word = normalizeWord(raw);
  const mapped = ISSUE_STATUS_SYNONYMS[word];
  // An unrecognised status is treated as OPEN on purpose: assuming a defect is
  // resolved because its status is unfamiliar hides work; assuming it is open
  // at worst shows it one row too high.
  const bucket: IssueBucket = mapped ?? 'open';

  return {
    bucket,
    raw: word || 'unknown',
    unknown: !mapped,
    resolved: bucket === 'fixed' || bucket === 'wontfix',
  };
}

const SEVERITIES = new Set<IssueSeverity>(['low', 'medium', 'high', 'critical']);

const SEVERITY_SYNONYMS: Record<string, IssueSeverity> = {
  blocker: 'critical',
  urgent: 'critical',
  sev1: 'critical',
  major: 'high',
  sev2: 'high',
  normal: 'medium',
  moderate: 'medium',
  sev3: 'medium',
  minor: 'low',
  trivial: 'low',
  cosmetic: 'low',
  nit: 'low',
};

/**
 * `null` when the file states no severity at all. The row must then say nothing
 * about severity — the previous code interpolated the missing value into a
 * translation key and printed the literal `issues.severity.undefined` on screen
 * (16 rows on Diwan's board).
 */
export function normalizeSeverity(raw: unknown): IssueSeverity | null {
  const word = normalizeWord(raw);
  if (SEVERITIES.has(word as IssueSeverity)) {
    return word as IssueSeverity;
  }
  return SEVERITY_SYNONYMS[word] ?? null;
}

// ---------------------------------------------------------------------------
// Task kind
// ---------------------------------------------------------------------------

/**
 * Kinds beyond the four styled ones are common (`maintenance`, `security`,
 * `doc`, `decision`, `arch`… — 76 tasks across the three boards). The chip used
 * to render only for a known kind, so those labels disappeared. Now an unknown
 * kind gets the neutral style and keeps its word.
 */
export function taskKindStyle(kind: unknown): string | null {
  const word = normalizeWord(kind);
  if (!word) {
    return null;
  }
  const known: Record<string, string> = {
    feature: 'bg-blue-500/10 text-blue-600 dark:text-blue-400 border-blue-500/30',
    bug: 'bg-destructive/10 text-destructive border-destructive/30',
    chore: 'bg-muted text-muted-foreground border-border',
    spike: 'bg-purple-500/10 text-purple-600 dark:text-purple-400 border-purple-500/30',
  };
  return known[word] ?? 'bg-muted text-muted-foreground border-border';
}
