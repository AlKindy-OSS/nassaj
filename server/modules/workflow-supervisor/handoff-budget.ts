/**
 * handoff-budget — §د cost governance for Tier-B delivery. A Tier-B turn costs a
 * full ~73k-token turn on the USER's Max-plan session budget (5-hour window), so
 * `card-only` is the default and Tier-B is metered: per-conversation AND per-user
 * DAILY token ceilings, plus a kill switch (config). Over budget ⇒ the injector
 * DEGRADES to a card-only notification (no LLM turn) with an audit line.
 *
 * DAY-BUCKETED, APPEND-ONLY DELTAS (T-823 condition 6 — RMW-race hardening):
 * counters live under `<root>/budget/<UTC-day>/<subject>.log` as an append-only
 * JSONL of `{turns,tokens}` DELTAS; a read SUMS the file. This REPLACES the prior
 * read-modify-write on a single total file, which lost concurrent increments if
 * delivery ever ran in parallel (qa-critic البؤرة 5: "لضاعت زيادات العدّاد ⇒ نقص
 * عدّ ⇒ تجاوز إنفاق"). Each record is tiny (< PIPE_BUF) and written with a single
 * O_APPEND `appendFileSync`, so concurrent appenders on a LOCAL fs never interleave
 * and never lose an increment — no lock, no RMW window. A torn/partial final line
 * (crash mid-append) is simply not summed (the 6.5% lesson: parse-or-ignore),
 * self-healing on the next record; the loss is at most one delta and only ever
 * UNDER-counts by a bounded amount (cost, never a safety break). Pure functions
 * (env + a `now` seam) ⇒ fully unit-testable offline. Buckets are named by day so
 * a periodic sweep (or none) trivially bounds growth; yesterday's log is simply
 * never read again once the day rolls.
 *
 * NETWORK-FS CAVEAT: O_APPEND atomicity holds on local filesystems (the deployment:
 * ~/.local/share). On NFS it is not guaranteed — covered by the OWNER's condition-5
 * live soak (the same network-fs concern the T-822 gate deferred for byte-tearing).
 *
 * PRE-CHARGE, NOT POST: the BEFORE check adds a conservative per-turn ESTIMATE to
 * the running total (we cannot know the real cost until the turn runs), so the
 * budget trips slightly EARLY rather than overspending. After the turn the injector
 * records the ACTUAL usage (from the result JSON) so the ledger of spend is honest.
 */

import fs from 'node:fs';
import path from 'node:path';

import {
  budgetDir,
  handoffTokensPerConversationMax,
  handoffTokensPerUserMax,
  handoffTurnTokenEstimate,
} from './config.js';

export type Spend = { turns: number; tokens: number };

const ZERO: Spend = { turns: 0, tokens: 0 };

/** UTC day bucket (YYYY-MM-DD) for `now`. */
export function dayBucket(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

function bucketDir(env: NodeJS.ProcessEnv, now: number): string {
  return path.join(budgetDir(env), dayBucket(now));
}

/** counter log name for a subject (append-only JSONL of deltas). userId is an
 * integer; conversationId is strict-charset (both validated upstream), so neither
 * can escape the dir. `.log` (not `.json`) — it is a delta stream, not one total. */
function counterFile(kind: 'user' | 'conv', id: string | number): string {
  return `${kind}-${id}.log`;
}

/** Sum the append-only delta log for a subject. Each line is a `{turns,tokens}`
 * delta; a torn/unparseable line (crash mid-append) is skipped, not fatal (the
 * 6.5% lesson — parse-or-ignore). Missing file ⇒ zero. */
function readCounter(dir: string, name: string): Spend {
  let raw: string;
  try {
    raw = fs.readFileSync(path.join(dir, name), 'utf8');
  } catch {
    return { ...ZERO };
  }
  let turns = 0;
  let tokens = 0;
  for (const line of raw.split('\n')) {
    const s = line.trim();
    if (!s) continue;
    try {
      const o = JSON.parse(s) as Partial<Spend>;
      if (Number.isFinite(o.turns)) turns += Number(o.turns);
      if (Number.isFinite(o.tokens)) tokens += Number(o.tokens);
    } catch {
      /* torn/partial line ⇒ ignore (self-heals on next record) */
    }
  }
  return { turns, tokens };
}

/** Read the current spend for a subject on `now`'s day. Missing ⇒ zero. */
export function readSpend(
  env: NodeJS.ProcessEnv,
  kind: 'user' | 'conv',
  id: string | number,
  now: number = Date.now(),
): Spend {
  return readCounter(bucketDir(env, now), counterFile(kind, id));
}

export type BudgetVerdict =
  | { exceeded: false }
  | {
      exceeded: true;
      scope: 'conversation' | 'user';
      limit: number;
      current: number;
      estimate: number;
    };

/**
 * The BEFORE gate: would injecting ONE turn for this (conversation,user) push
 * either daily ceiling over? Uses the conservative pre-charge estimate. Returns
 * the FIRST ceiling that trips (conversation checked first — the tighter one).
 */
export function wouldExceedBudget(
  env: NodeJS.ProcessEnv,
  input: { userId: number; conversationId: string; estimateTokens?: number },
  now: number = Date.now(),
): BudgetVerdict {
  const estimate = input.estimateTokens ?? handoffTurnTokenEstimate(env);
  const convSpend = readSpend(env, 'conv', input.conversationId, now);
  const convMax = handoffTokensPerConversationMax(env);
  if (convSpend.tokens + estimate > convMax) {
    return {
      exceeded: true,
      scope: 'conversation',
      limit: convMax,
      current: convSpend.tokens,
      estimate,
    };
  }
  const userSpend = readSpend(env, 'user', input.userId, now);
  const userMax = handoffTokensPerUserMax(env);
  if (userSpend.tokens + estimate > userMax) {
    return { exceeded: true, scope: 'user', limit: userMax, current: userSpend.tokens, estimate };
  }
  return { exceeded: false };
}

/**
 * Add (turns, tokens) to one subject's daily counter by APPENDING one delta line
 * (NOT a read-modify-write). O_APPEND (`fs.appendFileSync`, 'a' flag) makes the
 * single small write atomic on a local fs, so two concurrent deliveries each land
 * their whole delta with neither lost — the RMW race the prior total-file design
 * had (T-823 condition 6). The file is created 0600; the day dir 0700.
 */
function addToCounter(
  env: NodeJS.ProcessEnv,
  kind: 'user' | 'conv',
  id: string | number,
  add: Spend,
  now: number,
): void {
  const dir = bucketDir(env, now);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(dir, 0o700);
  } catch {
    /* best-effort */
  }
  // One compact delta record per append. Kept far below PIPE_BUF (4096) so a
  // single O_APPEND write is indivisible under concurrency on a local fs.
  const line = JSON.stringify({ turns: add.turns, tokens: add.tokens }) + '\n';
  fs.appendFileSync(path.join(dir, counterFile(kind, id)), line, { mode: 0o600 });
}

/**
 * Record the ACTUAL spend of one delivered turn against BOTH the per-conversation
 * and per-user daily counters (one turn, `tokens` tokens). Best-effort but atomic:
 * an fs failure here must not undo a committed delivery, so callers ignore throws.
 */
export function recordSpend(
  env: NodeJS.ProcessEnv,
  input: { userId: number; conversationId: string; tokens: number; turns?: number },
  now: number = Date.now(),
): void {
  const add: Spend = { turns: input.turns ?? 1, tokens: Math.max(0, Math.round(input.tokens)) };
  addToCounter(env, 'conv', input.conversationId, add, now);
  addToCounter(env, 'user', input.userId, add, now);
}

/**
 * Best-effort token count from a `claude -p --output-format json` result object.
 * Sums input+output(+cache) usage when present; falls back to the configured
 * per-turn estimate so the counter is never under-charged on an odd result shape.
 */
export function tokensFromResult(env: NodeJS.ProcessEnv, resultObj: unknown): number {
  const est = handoffTurnTokenEstimate(env);
  if (!resultObj || typeof resultObj !== 'object') {
    return est;
  }
  const usage = (resultObj as { usage?: Record<string, unknown> }).usage;
  if (!usage || typeof usage !== 'object') {
    return est;
  }
  const n = (v: unknown): number => (Number.isFinite(v) ? Number(v) : 0);
  const total =
    n(usage.input_tokens) +
    n(usage.output_tokens) +
    n(usage.cache_read_input_tokens) +
    n(usage.cache_creation_input_tokens);
  return total > 0 ? total : est;
}
