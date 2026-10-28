/**
 * ADR-219 S1 — the single relay dispatcher.
 *
 * Claims `queued` rows (and `deferred_quota` rows whose retry time passed), one
 * per target session and at most three at a time, and delivers each by a RESUME
 * TURN only, when the target has no live run, under the target owner's profile
 * and the mode read ONCE at the gate (qa ح-2), with a USD cap, a wall-clock cap
 * and the scheduling tools disallowed.
 *
 * HUMAN WINS (qa م-2): liveness is re-checked right before the claim, after
 * every async check; a turn refused as `session_busy` is requeued without
 * spending an attempt.
 *
 * EXACTLY-ONCE (م-8): the row's CSPRNG ref rides in the wrapper's opening tag.
 * The claim records the transcript size; after the turn only the bytes appended
 * since then are scanned for the one proof row shape (qa م-7): proven ⇒ ledger
 * (kind `peer`) then `delivered`; unproven ⇒ back to `queued`. On boot, before
 * any claim, a `delivering` row is repaired from the ledger or the proof — never
 * re-run — or returned to `queued`.
 *
 * DRAIN / KILL SWITCH: paused (drain) or disabled (NASSAJ_PEER_RELAY_DELIVERY=0)
 * ⇒ nothing is claimed; `refuse` stays on every spawn regardless.
 */

import type { PeerMessageRow } from '@/modules/database/index.js';

import { chargeFromTotals, modeCategory, PEER_QUOTA_DEFER_PERCENT } from './peer-policy.js';
import { createPeerDeliveryTurn, VERIFIED_RELAY_CLI_VERSIONS, type PeerDeliveryTurn, type PeerTurnResult } from './peer-run.js';
import { buildPeerWrapper, isPeerDeliveryProof } from './peer-wire.js';

const TICK_MS = 5000;
const BATCH = 3;
const MAX_ATTEMPTS = 3;
const RETRY_BACKOFF_MS = 60 * 1000;
const BUSY_RETRY_MS = 15 * 1000;
const QUOTA_RETRY_MS = 15 * 60 * 1000;
/** Without a recorded offset (a legacy row), only this tail is scanned. */
const UNKNOWN_OFFSET_TAIL_BYTES = 256 * 1024;

/** Delivery is on unless NASSAJ_PEER_RELAY_DELIVERY=0 (qa م-9); refuse is never affected. */
export function isPeerDeliveryEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.NASSAJ_PEER_RELAY_DELIVERY !== '0';
}

export type PeerTurnOutcome = { started: boolean; code: string | null; permanent: boolean };

type RowState = PeerMessageRow['state'];
type Transition = (id: string, from: RowState, to: RowState, change: {
  cause?: string | null; nextAttemptAt?: number | null; costUsd?: number | null; nowMs: number; refundAttempt?: boolean;
}) => boolean;

export type PeerDispatcherDependencies = {
  now: () => number;
  enabled: () => boolean;
  listDeliverable: (nowMs: number, limit: number) => PeerMessageRow[];
  listDelivering: () => PeerMessageRow[];
  claim: (id: string, nowMs: number, proofScanOffset: number | null) => boolean;
  transition: Transition;
  getRow: (id: string) => PeerMessageRow | undefined;
  isSessionRunLive: (sessionId: string) => boolean;
  /** Version of the claude CLI a resume turn would run; null when unreadable. */
  cliVersion: () => Promise<string | null>;
  /** Highest usage percent on the target user's own CLAUDE_CONFIG_DIR; null when unknown. */
  quotaPercent: (userId: number) => Promise<number | null>;
  /** The target's recorded effective mode for its owner, read once per delivery (null = unknown). */
  sessionMode: (sessionId: string, ownerUserId: number | null) => string | null;
  senderName: (sessionId: string) => string;
  transcriptPath: (sessionId: string) => string | null;
  transcriptSize: (jsonlPath: string) => number | null;
  hasProof: (jsonlPath: string, fromOffset: number, isProof: (row: unknown) => boolean) => boolean;
  ledgerHas: (sessionId: string, peerMessageId: string) => boolean;
  ledgerCommit: (sessionId: string, row: PeerMessageRow) => void;
  costBaseline: (sessionId: string) => number | null;
  /** The cost ledger's measured session total (fallback when the total delta is unusable). */
  ledgerCostUsd: (sessionId: string, userId: number) => Promise<number | null>;
  runTurn: (row: PeerMessageRow, turn: PeerDeliveryTurn, permissionMode: string) => Promise<PeerTurnOutcome>;
  publish: (row: PeerMessageRow) => void;
  log: (level: 'info' | 'warn' | 'error', msg: string, meta: Record<string, unknown>) => void;
};

function isProven(deps: PeerDispatcherDependencies, row: PeerMessageRow): boolean {
  const jsonlPath = deps.transcriptPath(row.to_session_id);
  if (!jsonlPath) return false;
  const size = deps.transcriptSize(jsonlPath) ?? 0;
  const from = row.proof_scan_offset ?? Math.max(0, size - UNKNOWN_OFFSET_TAIL_BYTES);
  try {
    return deps.hasProof(jsonlPath, from, (line) => isPeerDeliveryProof(line, row.ref_token));
  } catch {
    return false;
  }
}

/** Repairs one row left `delivering`; returns its new state. */
function repairRow(deps: PeerDispatcherDependencies, row: PeerMessageRow): RowState {
  const nowMs = deps.now();
  if (deps.ledgerHas(row.to_session_id, row.id)) {
    deps.transition(row.id, 'delivering', 'delivered', { cause: row.cause ?? 'repaired', nowMs });
    return 'delivered';
  }
  if (isProven(deps, row)) {
    deps.ledgerCommit(row.to_session_id, row);
    deps.transition(row.id, 'delivering', 'delivered', { cause: 'repaired', nowMs });
    return 'delivered';
  }
  deps.transition(row.id, 'delivering', 'queued', { cause: 'repaired_requeue', nowMs });
  return 'queued';
}

function publishById(deps: PeerDispatcherDependencies, id: string): void {
  const row = deps.getRow(id);
  if (row) deps.publish(row);
}

function end(deps: PeerDispatcherDependencies, row: PeerMessageRow, to: RowState, cause: string,
  nextAttemptAt: number | null = null): void {
  if (deps.transition(row.id, row.state, to, { cause, nextAttemptAt, nowMs: deps.now() })) publishById(deps, row.id);
}

type GateVerdict = { go: false } | { go: true; mode: string; jsonlPath: string };

/**
 * Pre-claim gates. A live target or an unreadable CLI version leaves the row
 * queued; no transcript fails it (no proof possible); an unverified CLI refuses
 * it; a target mode no longer in the sender's category refuses it (ح-2); ≥ 90 %
 * quota defers it; no recorded mode refuses it (mode_unknown). The mode returned —
 * the target's recorded effective mode, never the transcript — is the ONE the turn runs under.
 */
async function gate(deps: PeerDispatcherDependencies, row: PeerMessageRow): Promise<GateVerdict> {
  if (deps.isSessionRunLive(row.to_session_id)) return { go: false };
  const jsonlPath = deps.transcriptPath(row.to_session_id);
  if (!jsonlPath) { end(deps, row, 'failed', 'no_transcript'); return { go: false }; }
  const version = await deps.cliVersion().catch(() => null);
  if (version === null) return { go: false };
  if (!VERIFIED_RELAY_CLI_VERSIONS.has(version)) { end(deps, row, 'refused', 'unverified_cli'); return { go: false }; }
  const mode = deps.sessionMode(row.to_session_id, row.to_user_id);
  if (mode === null) { end(deps, row, 'refused', 'mode_unknown'); return { go: false }; }
  if (modeCategory(mode) !== row.from_mode) { end(deps, row, 'refused', 'mode_mismatch_at_delivery'); return { go: false }; }
  const percent = row.to_user_id === null ? null : await deps.quotaPercent(row.to_user_id).catch(() => null);
  if (percent !== null && percent >= PEER_QUOTA_DEFER_PERCENT) {
    end(deps, row, 'deferred_quota', 'deferred_quota', deps.now() + QUOTA_RETRY_MS);
    return { go: false };
  }
  return { go: true, mode, jsonlPath };
}

/** The charge of a proven turn: total delta, else the cost ledger's delta; clamped ≥ 0. */
async function measureCharge(deps: PeerDispatcherDependencies, row: PeerMessageRow, results: PeerTurnResult[],
  baseline: number | null, ledgerBefore: number | null): Promise<number | null> {
  const last = results.length > 0 ? results[results.length - 1]!.totalCostUsd : null;
  const fromTotals = chargeFromTotals(last, baseline);
  if (fromTotals !== null) return fromTotals;
  if (ledgerBefore === null || row.to_user_id === null) return null;
  const after = await deps.ledgerCostUsd(row.to_session_id, row.to_user_id).catch(() => null);
  return after === null ? null : Math.max(0, after - ledgerBefore);
}

type Costs = { baseline: number | null; ledgerBefore: number | null };

async function settle(deps: PeerDispatcherDependencies, claimed: PeerMessageRow, outcome: PeerTurnOutcome,
  results: PeerTurnResult[], costs: Costs): Promise<void> {
  const nowMs = deps.now();
  if (isProven(deps, claimed)) {
    deps.ledgerCommit(claimed.to_session_id, claimed);
    const costUsd = await measureCharge(deps, claimed, results, costs.baseline, costs.ledgerBefore);
    const budgetStop = results.some((r) => r.subtype === 'error_max_budget_usd');
    deps.transition(claimed.id, 'delivering', 'delivered', { cause: budgetStop ? 'budget_stop' : outcome.code, costUsd, nowMs });
  } else if (outcome.code === 'session_busy') {
    deps.transition(claimed.id, 'delivering', 'queued', { cause: 'session_busy', nextAttemptAt: nowMs + BUSY_RETRY_MS,
      nowMs, refundAttempt: true });
  } else if (outcome.permanent || claimed.attempts >= MAX_ATTEMPTS) {
    deps.transition(claimed.id, 'delivering', 'failed', { cause: outcome.code ?? 'no_delivery_proof', nowMs });
  } else {
    deps.transition(claimed.id, 'delivering', 'queued', { cause: outcome.code ?? (outcome.started ? 'no_delivery_proof' : 'not_started'),
      nextAttemptAt: nowMs + RETRY_BACKOFF_MS, nowMs });
  }
  publishById(deps, claimed.id);
}

async function runClaimed(deps: PeerDispatcherDependencies, claimed: PeerMessageRow, wrapped: string, mode: string,
  costs: Costs): Promise<void> {
  const results: PeerTurnResult[] = [];
  const turn = createPeerDeliveryTurn({ peerMessageId: claimed.id, chainId: claimed.chain_id, hop: claimed.hop,
    ref: claimed.ref_token, fromMode: claimed.from_mode, wrapped, onResult: (result) => results.push(result) });
  let outcome: PeerTurnOutcome;
  try {
    outcome = await deps.runTurn(claimed, turn, mode);
  } catch (error) {
    outcome = { started: turn.consumed, code: 'turn_threw', permanent: false };
    deps.log('error', 'peer relay turn threw', { id: claimed.id, error: error instanceof Error ? error.message : String(error) });
  }
  await settle(deps, claimed, outcome, results, costs);
}

/** Delivers one row end to end; a failed turn returns the row to the queue (or fails it). */
export async function deliverPeerRow(deps: PeerDispatcherDependencies, row: PeerMessageRow): Promise<void> {
  const verdict = await gate(deps, row);
  if (!verdict.go) return;
  const wrapped = buildPeerWrapper({ fromSessionId: row.from_session_id, fromName: deps.senderName(row.from_session_id),
    fromMode: row.from_mode, ref: row.ref_token, body: row.body });
  if (!wrapped) { end(deps, row, 'failed', 'invalid_attributes'); return; }
  // Both baselines before the turn: the total delta first, the cost ledger for a missing/negative one.
  const costs: Costs = { baseline: deps.costBaseline(row.to_session_id),
    ledgerBefore: row.to_user_id === null ? null : await deps.ledgerCostUsd(row.to_session_id, row.to_user_id).catch(() => null) };
  // Human wins: re-checked after every await, immediately before the claim.
  if (deps.isSessionRunLive(row.to_session_id)) return;
  if (!deps.claim(row.id, deps.now(), deps.transcriptSize(verdict.jsonlPath))) return;
  const claimed = deps.getRow(row.id) as PeerMessageRow;
  deps.publish(claimed);
  await runClaimed(deps, claimed, wrapped, verdict.mode, costs);
}

export type PeerDispatcher = {
  /** Boot repair, then the periodic claim loop. */
  start: () => void;
  /** Drain: claim nothing from now on (in-flight delivery finishes). */
  pause: () => void;
  stop: () => void;
  /** Asks for a tick soon (a row was queued). */
  kick: () => void;
  /** One pass (tests and the timer). */
  tick: () => Promise<void>;
  repairOnBoot: () => number;
};

function repairAll(deps: PeerDispatcherDependencies): number {
  let repaired = 0;
  for (const row of deps.listDelivering()) {
    repairRow(deps, row);
    repaired++;
  }
  return repaired;
}

/** Creates the dispatcher; nothing runs until start(). */
export function createPeerDispatcher(deps: PeerDispatcherDependencies): PeerDispatcher {
  let paused = false;
  let running: Promise<void> | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;
  // One row per target (listDeliverable), at most BATCH concurrent deliveries.
  const pass = async (): Promise<void> => {
    const rows = deps.listDeliverable(deps.now(), BATCH);
    await Promise.all(rows.map((row) => (paused ? undefined : deliverPeerRow(deps, row))));
  };
  const tick = async (): Promise<void> => {
    if (paused || running || !deps.enabled()) return running ?? undefined;
    running = pass().catch((error: unknown) => {
      deps.log('error', 'peer relay tick failed', { error: error instanceof Error ? error.message : String(error) });
    }).finally(() => { running = null; });
    return running;
  };
  return {
    start: () => {
      if (timer) return;
      try {
        const repaired = repairAll(deps);
        if (repaired > 0) deps.log('info', 'peer relay boot repair', { repaired });
      } catch (error) {
        deps.log('error', 'peer relay boot repair failed', { error: error instanceof Error ? error.message : String(error) });
      }
      timer = setInterval(() => { void tick(); }, TICK_MS);
      timer.unref?.();
    },
    pause: () => { paused = true; },
    stop: () => {
      paused = true;
      if (timer) clearInterval(timer);
      timer = null;
    },
    kick: () => { setTimeout(() => { void tick(); }, 0).unref?.(); },
    tick,
    repairOnBoot: () => repairAll(deps),
  };
}
