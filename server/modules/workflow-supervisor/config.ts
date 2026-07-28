/**
 * Workflow-supervisor configuration & the master feature flag (ADR-053,
 * M-BG-2-CODE — the durable external workflow launcher for B-103).
 *
 * MASTER FLAG: WORKFLOW_SUPERVISOR
 * -------------------------------
 * The ENTIRE feature is gated behind this single env flag. It defaults OFF, and
 * when OFF every entry point in this module is a hard no-op:
 *   - the durable-task intent writer (durable-task) writes NOTHING,
 *   - the standalone supervisor loop refuses to start,
 *   - the scope-liveness source is never consulted (the pid path is unchanged).
 * There is therefore ZERO behavior change on the critical path while the flag is
 * off — the whole module is dormant code. Turning it on is the only thing that
 * activates any of it.
 *
 * WHY A SHARED PARSER (not scattered `process.env` reads)
 * ------------------------------------------------------
 * A single `isSupervisorEnabled()` keeps the on/off semantics identical at every
 * call site (bridge, supervisor, liveness) so the no-op guarantee cannot drift
 * between them. Accepts the same '1'/'true' truthy convention as the existing
 * ENABLE_ULTRACODE_WORKFLOWS / WORKFLOW_RECONCILE flags for consistency.
 */

import { existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/** Truthy values that turn a flag ON, matching the repo's existing convention. */
const TRUTHY = new Set(['1', 'true', 'yes', 'on']);

/**
 * Master gate for the whole workflow-supervisor feature. OFF by default: when
 * this returns false every code path in the module is a no-op (see file header).
 * Read live (not cached) so a test can flip the env between cases.
 */
export function isSupervisorEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.WORKFLOW_SUPERVISOR;
  return typeof raw === 'string' && TRUTHY.has(raw.trim().toLowerCase());
}

/**
 * Per-user cap on concurrently running workflow scopes (ADR-053 §ج-4). A launch
 * intent that would exceed this is rejected/queued rather than launched, so a
 * user cannot exhaust host memory with unbounded parallel `claude -p` scopes.
 * Overridable via WORKFLOW_SUPERVISOR_MAX_PER_USER; defaults to a conservative 3.
 */
export function maxConcurrentPerUser(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number.parseInt(env.WORKFLOW_SUPERVISOR_MAX_PER_USER ?? '', 10);
  return Number.isInteger(raw) && raw > 0 ? raw : 3;
}

/**
 * HOST-WIDE cap on concurrently running workflow scopes across ALL users (§ج-5,
 * الشرط 7). The per-user cap alone cannot bound total memory when many users
 * launch at once (the 2026-06-06 OOM lesson): N users × per-user cap could still
 * exhaust the host. This global cap is the second gate — over it, an (N+1)th
 * launch is QUEUED on disk (never OOM, never a silent drop). Overridable via
 * WORKFLOW_SUPERVISOR_MAX_GLOBAL; defaults to a conservative 8.
 */
export function maxConcurrentGlobal(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number.parseInt(env.WORKFLOW_SUPERVISOR_MAX_GLOBAL ?? '', 10);
  return Number.isInteger(raw) && raw > 0 ? raw : 8;
}

/**
 * Root of the control-file tree the chat bridge writes intents into and the
 * supervisor reads them from. Mirrors the runner-bridge's file-only contract
 * (ADR-RUNNER-BRIDGE-001): the two processes share ONLY these files, never a
 * socket or DB handle. Overridable via WORKFLOW_SUPERVISOR_STATE_DIR for tests.
 *
 * Layout:
 *   <root>/intents/<userId>/<wfLaunchId>.json   — chat writes, supervisor reads
 *   <root>/scopes/<wfLaunchId>/supervisor.json  — supervisor writes, UI reads
 *   <root>/scopes/<wfLaunchId>/pause            — stop control file
 */
export function supervisorStateRoot(env: NodeJS.ProcessEnv = process.env): string {
  return (
    env.WORKFLOW_SUPERVISOR_STATE_DIR ||
    path.join(os.homedir(), '.local', 'share', 'nassaj-dev', 'workflow-supervisor')
  );
}

export function intentsDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(supervisorStateRoot(env), 'intents');
}

export function scopesDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(supervisorStateRoot(env), 'scopes');
}

/** Per-user intent directory: <root>/intents/<userId>. */
export function userIntentDir(userId: number, env: NodeJS.ProcessEnv = process.env): string {
  return path.join(intentsDir(env), String(userId));
}

/** Per-scope state directory: <root>/scopes/<wfLaunchId>. */
export function scopeStateDir(wfLaunchId: string, env: NodeJS.ProcessEnv = process.env): string {
  return path.join(scopesDir(env), wfLaunchId);
}

/**
 * Root of the per-task ARTIFACT tree (§أ-2). The transient unit's result-capture
 * wrapper writes result.json[.partial] + DONE here, and the durable task record
 * (task.json) is persisted alongside for the later monitor. Kept SEPARATE from
 * `scopes/` (which holds supervisor.json/pause) in phase 2 to avoid touching the
 * shipped scope-status/lifecycle read paths; phase 3 may consolidate under
 * `tasks/` per the design's exact layout. Overridable via the shared state root.
 */
export function tasksDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(supervisorStateRoot(env), 'tasks');
}

/** Per-task artifact directory: <root>/tasks/<taskId>. taskId === wfLaunchId. */
export function taskArtifactDir(taskId: string, env: NodeJS.ProcessEnv = process.env): string {
  return path.join(tasksDir(env), taskId);
}

/**
 * Per-conversation exactly-once delivery ledger dir (§أ-2). The monitor writes
 * `<conversationId>.done` here (atomic, batch-level) as the PRIMARY exactly-once
 * key for card delivery. Kept 0700 like the rest of the web-originated tree.
 */
export function handoffsDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(supervisorStateRoot(env), 'handoffs');
}

/**
 * The single-owner flock file for the permanent monitor (الشرط 5, §ب-0/§ب-2).
 * runSupervisor acquires an advisory flock(2) on this path at boot; a second
 * instance fails to acquire and exits quietly. flock(2) is released by the kernel
 * on ANY death (including kill -9), so a restart re-acquires with no stale lock —
 * the property that makes the crash-safety criteria sound.
 */
export function supervisorLockPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(supervisorStateRoot(env), 'supervisor.lock');
}

/**
 * Grace window (ms) for the DONE-absent reconciliation rule (§أ-3). When a unit
 * is terminal but `DONE` is missing, the classifier waits this long and re-checks
 * before deciding PARTIAL-untrusted/CRASHED — closing the race where is-active
 * flips terminal a few ms before the wrapper writes DONE. Design ~10s, tunable.
 */
export function reconcileGraceMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number.parseInt(env.WORKFLOW_SUPERVISOR_RECONCILE_GRACE_MS ?? '', 10);
  return Number.isInteger(raw) && raw >= 0 ? raw : 10_000;
}

/**
 * C1 (T-820 audit) — cap on the number of PENDING (queued-on-disk) intents a
 * single user may hold. The route rejects a launch with 429 over this cap so a
 * malicious owner cannot flood the intents dir (each queued intent costs a
 * GATE2 + systemctl probe every tick). Defaults to a generous-but-bounded 50.
 */
export function maxPendingIntentsPerUser(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number.parseInt(env.WORKFLOW_SUPERVISOR_MAX_PENDING_PER_USER ?? '', 10);
  return Number.isInteger(raw) && raw > 0 ? raw : 50;
}

/**
 * C1 (T-820 audit) — TTL for a stuck intent. The monitor's periodic sweep
 * deletes an intent file older than this (a queued intent that never admitted, or
 * a corrupt file that never parses) so the disk queue cannot grow unbounded.
 * Defaults to 24h.
 */
export function intentSweepMaxAgeMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number.parseInt(env.WORKFLOW_SUPERVISOR_INTENT_TTL_MS ?? '', 10);
  return Number.isInteger(raw) && raw > 0 ? raw : 24 * 60 * 60 * 1000;
}

/**
 * C1 (T-820 audit) — back-off between re-processing attempts for a SINGLE queued
 * intent. Without it, every queued intent re-runs GATE2 + a full systemctl probe
 * on EVERY poll tick (the amplification the audit flagged). With it, a queued
 * intent is retried at most once per this interval. Defaults to 30s.
 */
export function queuedRetryBackoffMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number.parseInt(env.WORKFLOW_SUPERVISOR_QUEUE_BACKOFF_MS ?? '', 10);
  return Number.isInteger(raw) && raw >= 0 ? raw : 30_000;
}

/**
 * Interval (ms) between the monitor's stale-intent sweeps (C1). The sweep is far
 * cheaper than the poll, so it runs on its own slower cadence. Defaults to 5min.
 */
export function intentSweepIntervalMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number.parseInt(env.WORKFLOW_SUPERVISOR_SWEEP_INTERVAL_MS ?? '', 10);
  return Number.isInteger(raw) && raw > 0 ? raw : 5 * 60 * 1000;
}

/**
 * The systemd UNIT name for a launch id. Kept in one place so the bridge,
 * supervisor, liveness source, and force-stop all agree on the exact name.
 *
 * TRANSIENT SERVICE, NOT --scope (correctness fix over the ADR's illustrative
 * `--scope`): `systemd-run --user --scope -- cmd` BLOCKS the launcher until the
 * command finishes, which would (a) serialize the supervisor's poll loop behind
 * one long workflow, (b) defeat the per-user concurrency cap, and (c) force
 * supervisor.json to be written on COMPLETION instead of at the moment of launch
 * (violating fito T-241). A transient `--unit=wf-*.service` returns immediately,
 * is owned by the user systemd manager, and OUTLIVES the launcher — which is the
 * exact B-103 survival guarantee. Hence the `.service` suffix.
 */
export function scopeUnitName(wfLaunchId: string): string {
  return `wf-${wfLaunchId}.service`;
}

// ===========================================================================
// T-822 (المرحلة 4) — Tier-B injector + per-conversation chat lock + cost
// governance. EVERYTHING below is DOUBLY gated: the master WORKFLOW_SUPERVISOR
// flag AND the dedicated sub-flag WORKFLOW_SUPERVISOR_CHAT_LOCK. The sub-flag is
// the single switch that couples the two lock takers (the live chat seam in
// claude-sdk.js AND the injector) — they engage together or not at all, so the
// injector never writes a resumed turn into a jsonl the chat is not also
// serializing. Both default OFF: with them off, the critical path is
// byte-identical to T-821 (no lock, no Tier-B, cards only).
// ===========================================================================

/**
 * The T-822 sub-flag. Gates BOTH the critical-path chat lock (claude-sdk.js) and
 * the Tier-B injector. Requires the master flag too (fail-closed on either off).
 * Kept SEPARATE from the master so a deployment can run the whole T-821 delivery
 * (cards, monitor) with ZERO critical-path touch, and only opt into the 502-risk
 * seam by flipping THIS flag explicitly (§ح-3 mitigation, defense in depth).
 */
export function isChatTurnLockEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  if (!isSupervisorEnabled(env)) {
    return false;
  }
  const raw = env.WORKFLOW_SUPERVISOR_CHAT_LOCK;
  return typeof raw === 'string' && TRUTHY.has(raw.trim().toLowerCase());
}

/** Per-conversation advisory-lock dir (§ج-4). BOTH the live chat path and the
 * injector flock `<conversationId>.lock` here to serialize jsonl appends. 0700. */
export function chatLocksDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(supervisorStateRoot(env), 'chat-locks');
}

/**
 * Ceiling (ms) the LIVE chat path waits for the per-conversation lock when it
 * finds it held by an injector (the rare case: an injection started just before
 * a human turn). DEFAULT is `injectorMaxHoldMs + 5s` so it is ALWAYS ≥ the
 * injector's own hold cap — under normal + capped operation the injector always
 * releases FIRST and the human acquires cleanly (zero concurrent append, §ج-4
 * criterion). A genuine timeout past this ceiling means the injector exceeded
 * even its own hard cap (a bug) ⇒ the chat proceeds fail-OPEN for the human
 * (§ح-3) with an audit line — never an infinite block on the critical path.
 */
export function chatLockWaitMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number.parseInt(env.WORKFLOW_SUPERVISOR_CHAT_LOCK_WAIT_MS ?? '', 10);
  if (Number.isInteger(raw) && raw >= 0) {
    return raw;
  }
  return injectorMaxHoldMs(env) + 5_000;
}

/**
 * Hard cap (ms) the injector may HOLD the per-conversation lock for one Tier-B
 * turn (§ج-4 constraint 3). A leaf-only turn (consume a ≤32KB result + a short
 * reply, no subagents/tools) is short in practice; this bounds a hung turn: at
 * the cap the injector kills its `claude` child and releases the lock (the task
 * stays handoff-pending, retried later — never lost). So the injector never
 * holds the lock "minutes open" and the human is never starved.
 */
export function injectorMaxHoldMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number.parseInt(env.WORKFLOW_SUPERVISOR_HANDOFF_MAX_HOLD_MS ?? '', 10);
  return Number.isInteger(raw) && raw > 0 ? raw : 90_000;
}

// ---------------------------------------------------------------------------
// T-823 (المرحلة 5) — chat-lock timing INVARIANT + boot-time assertion.
// (qa-critic T-822 gate, condition 3: "حصر علوي على chatLockWaitMs + تأكيد إقلاعي
//  للثابت chatLockWaitMs ≥ injectorMaxHoldMs+grace".)
//
// WHY: the two knobs are coupled. If a manual override lowers chatLockWaitMs (or
// raises injectorMaxHoldMs) so the human's wait ceiling is NOT strictly greater
// than the injector's worst-case hold, a human turn can time out fail-OPEN WHILE
// the injector legitimately still holds the lock — the exact concurrent-jsonl-
// append this seam exists to prevent (§ج-4). The shipped DEFAULTS are coupled
// safely (chatLockWaitMs default = injectorMaxHoldMs + 5s), but a bad override is
// otherwise silent. The supervisor asserts this at boot and REFUSES to start when
// the sub-flag is on and the invariant is broken (fail-closed: no supervisor ⇒ no
// injection ⇒ no race — the only process that ever injects is the supervisor).
// ---------------------------------------------------------------------------

/**
 * The SIGTERM→SIGKILL grace (ms) the resume-turn runner allows its `claude` child
 * at the hold cap before the hard kill. Defined HERE as the single source of truth
 * (resume-turn-runner imports it) so the invariant below reasons about the injector's
 * TRUE worst-case hold = injectorMaxHoldMs + this grace + fd-close latency.
 */
export const INJECTOR_SIGKILL_GRACE_MS = 2_000;

/**
 * The minimum margin (ms) chatLockWaitMs must exceed injectorMaxHoldMs by. It must
 * be STRICTLY greater than INJECTOR_SIGKILL_GRACE_MS so the human keeps waiting
 * until the injector has definitely released (kill + fd close), never a boundary
 * tie. = SIGKILL grace (2s) + 1s scheduling/close margin. The shipped default wait
 * (hold + 5s) clears this comfortably.
 */
export const CHAT_LOCK_REQUIRED_GRACE_MS = INJECTOR_SIGKILL_GRACE_MS + 1_000;

/** Upper bound (ms) on how long a human turn may EVER wait on the seam (condition
 * 3's "حصر علوي"). A wait beyond this is a misconfiguration, not a valid tuning —
 * the human must never be blocked minutes on the critical path. */
export const CHAT_LOCK_WAIT_MS_CEILING = 300_000; // 5 min

/** Upper bound (ms) on the injector's per-turn hold. Bounds the OTHER knob so the
 * invariant (wait ≥ hold + grace, wait ≤ wait-ceiling) stays satisfiable. */
export const INJECTOR_MAX_HOLD_MS_CEILING = 240_000; // 4 min

export type ChatLockConfigVerdict =
  | { ok: true; holdMs: number; waitMs: number }
  | { ok: false; holdMs: number; waitMs: number; problems: string[] };

/**
 * Validate the coupled chat-lock timing knobs (pure — env in, verdict out; fully
 * unit-testable). Callers (the supervisor at boot) decide whether to warn or exit.
 * Checks, in order: hold ≤ ceiling, wait ≤ ceiling, and the core safety invariant
 * wait ≥ hold + CHAT_LOCK_REQUIRED_GRACE_MS.
 */
export function validateChatLockConfig(
  env: NodeJS.ProcessEnv = process.env,
): ChatLockConfigVerdict {
  const holdMs = injectorMaxHoldMs(env);
  const waitMs = chatLockWaitMs(env);
  const problems: string[] = [];
  if (holdMs > INJECTOR_MAX_HOLD_MS_CEILING) {
    problems.push(
      `injectorMaxHoldMs=${holdMs} exceeds ceiling ${INJECTOR_MAX_HOLD_MS_CEILING} ` +
        `(WORKFLOW_SUPERVISOR_HANDOFF_MAX_HOLD_MS too large)`,
    );
  }
  if (waitMs > CHAT_LOCK_WAIT_MS_CEILING) {
    problems.push(
      `chatLockWaitMs=${waitMs} exceeds ceiling ${CHAT_LOCK_WAIT_MS_CEILING} ` +
        `(WORKFLOW_SUPERVISOR_CHAT_LOCK_WAIT_MS too large — a human would be blocked too long)`,
    );
  }
  const floor = holdMs + CHAT_LOCK_REQUIRED_GRACE_MS;
  if (waitMs < floor) {
    problems.push(
      `chatLockWaitMs=${waitMs} < injectorMaxHoldMs+grace (${holdMs}+${CHAT_LOCK_REQUIRED_GRACE_MS}=${floor}): ` +
        `a human turn could time out fail-OPEN while the injector still holds the lock ⇒ concurrent jsonl append`,
    );
  }
  return problems.length > 0
    ? { ok: false, holdMs, waitMs, problems }
    : { ok: true, holdMs, waitMs };
}

/** Per-conversation budget dir (§د). Daily token/turn counters, atomic. 0700. */
export function budgetDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(supervisorStateRoot(env), 'budget');
}

/**
 * §د cost governance — the per-conversation daily token ceiling. Over it, a
 * Tier-B delivery for that conversation DEGRADES to a card-only notification (no
 * LLM turn) with an audit line. ≈ 3–4 coalesced deliveries/day for one chat.
 */
export function handoffTokensPerConversationMax(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number.parseInt(env.WORKFLOW_SUPERVISOR_HANDOFF_TOKENS_CONV_MAX ?? '', 10);
  return Number.isInteger(raw) && raw > 0 ? raw : 300_000;
}

/** §د — the per-user daily token ceiling across ALL their conversations. */
export function handoffTokensPerUserMax(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number.parseInt(env.WORKFLOW_SUPERVISOR_HANDOFF_TOKENS_USER_MAX ?? '', 10);
  return Number.isInteger(raw) && raw > 0 ? raw : 1_000_000;
}

/**
 * §د — the pre-charge token estimate for ONE injected turn, used by the BEFORE
 * check (we cannot know the real cost until the turn runs). Conservative by
 * design (rounds a delivery UP so the budget trips slightly early rather than
 * overspending). The reference cold-turn cost from T-819 was ~31–58k; the design
 * quotes ~73k for a full turn — we default to the higher end for safety.
 */
export function handoffTurnTokenEstimate(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number.parseInt(env.WORKFLOW_SUPERVISOR_HANDOFF_TURN_TOKEN_ESTIMATE ?? '', 10);
  return Number.isInteger(raw) && raw > 0 ? raw : 73_000;
}

/** §هـ-3 — kill file: presence disables ALL Tier-B injection immediately
 * (degrade to card-only). A file, so an operator can flip it without a restart. */
export function injectKillFilePath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(supervisorStateRoot(env), 'HANDOFF_KILL');
}

/**
 * §هـ-3 kill switch — true when EITHER the env flag WORKFLOW_SUPERVISOR_HANDOFF_KILL
 * is truthy OR the kill file exists. Checked LIVE before every injection so the
 * operator can stop the cost surface instantly. Never throws (an fs error reads
 * as "not killed" — the env flag remains the hard switch).
 */
export function isInjectKillSwitchOn(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.WORKFLOW_SUPERVISOR_HANDOFF_KILL;
  if (typeof raw === 'string' && TRUTHY.has(raw.trim().toLowerCase())) {
    return true;
  }
  try {
    return existsSync(injectKillFilePath(env));
  } catch {
    return false;
  }
}

/** Optional model for the leaf handoff turn (a cheap/fast model is ideal). Null
 * ⇒ the CLI default. Override via WORKFLOW_SUPERVISOR_HANDOFF_MODEL. */
export function injectorModel(env: NodeJS.ProcessEnv = process.env): string | null {
  const raw = env.WORKFLOW_SUPERVISOR_HANDOFF_MODEL;
  return typeof raw === 'string' && raw.trim().length > 0 ? raw.trim() : null;
}

/** Audit log for the LIVE chat-lock seam (app process side), kept next to the
 * per-task audit.log tree. Best-effort; never on the hot path when the flag is off. */
export function chatLockAuditPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(supervisorStateRoot(env), 'chat-lock-audit.log');
}

/**
 * The tools a Tier-B turn is FORBIDDEN to use (الشرط 2, leaf-only). Task/Workflow
 * are the background-spawning tools; forbidding them (plus stripping the workflow
 * env in the injector) makes an injected turn structurally single-turn — it
 * cannot re-enter B-103 by launching more background work.
 */
export const LEAF_ONLY_DISALLOWED_TOOLS = ['Task', 'Workflow'] as const;
