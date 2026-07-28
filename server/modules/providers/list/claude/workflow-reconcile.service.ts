import fsp from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';
import { createReadStream } from 'node:fs';
import type { Stats } from 'node:fs';

import type { AnyRecord, NormalizedMessage } from '@/shared/types.js';
import { createNormalizedMessage } from '@/shared/utils.js';

/**
 * ADR-048 — Workflow Completion Reconcile (incident 2026-06-27, wf_ef5ba242-b4b).
 *
 * THE BUG THIS CORRECTS (visibility desync, NOT work loss): a background
 * `Workflow` run is launched from a Claude session via the Agent SDK. On a
 * server `restart`, `treekill:false` (B-N-DRAIN) keeps the workflow's subagents
 * alive as orphans — they finish and write their `result` rows into
 * `<sessionDir>/subagents/workflows/wf_<id>/journal.jsonl`. But the drain count
 * (`countActiveSessionsByProvider`) only sees in-memory provider sessions, never
 * workflows, so the parent process exits immediately and the replacement process
 * emits a `run.stopped` task-notification (truthful at its timestamp, but
 * earlier than the real completion) with no later correction path. The work
 * lands on disk while the UI shows "stopped".
 *
 * The root cause lives in the Claude Code SDK layer (no workflow-completion
 * tracking across restart). nassaj cannot patch the SDK; it reconciles in its
 * own layer by READING the on-disk trace the SDK leaves behind (journal.jsonl).
 *
 * SCOPE BOUNDARY — inline-restart ONLY; NOT the DurableTask authority (T-825)
 * -------------------------------------------------------------------------
 * This service is the completion detector for exactly ONE case: an INLINE
 * `Workflow`-tool run (ultracode, executed inside the coordinator's own query()
 * process) whose `run.stopped` card was emitted by a server RESTART before its
 * orphaned journal finished landing on disk. Its whole authority is the
 * SDK-owned `<sessionDir>/subagents/workflows/wf_<id>/journal.jsonl` trace, and
 * it fires ONLY when a `run.stopped` notification exists (findLatestStopped...).
 *
 * It has NO authority over B-103 DurableTask background tasks (ADR-053). Their
 * SINGLE completion authority is `result.json` + the `DONE` sentinel under
 * `<supervisorStateRoot>/tasks/<taskId>/`, read ONLY by the permanent monitor
 * (`workflow-supervisor/monitor.ts` — looksTerminal / classifyTerminal). The two
 * detectors read DISJOINT trees AND DISJOINT shapes: reconcile never reads the
 * supervisor `tasks/` root and never keys off `result.json`/`DONE`; the monitor
 * never reads a `subagents/workflows/` journal. A DurableTask can therefore never
 * be claimed here — a property locked by the boundary tests in the sibling
 * `__tests__/workflow-reconcile.service.test.ts` (the "(ز) authority boundary" set).
 *
 * T-825 is a scope RESTRICTION, not a removal. `DEFAULT_QUIET_MS`,
 * `readJournalKeySets`, and `buildReconcileMessage` are shared EXPORTED surface
 * with live consumers (workflow-status.service.ts, workflow-liveness.js, and the
 * B-103 Tier-A card contract). When this inline path is finally retired — AFTER
 * inline background workflows migrate to DurableTask (T-828) — those symbols are
 * EXTRACTED to a neutral module, NEVER deleted, so their consumers keep working.
 *
 * C5 — SETTLED STATE (incident wf_ef5ba242-b4b, 16 started / 15 result):
 * the original completeness gate required `startedKeys ⊆ resultKeys` (every
 * started work item produced a result). That mis-classified the COMMON orphan
 * shape — a workflow that produced real output but left one subagent hanging at
 * restart, so one `started` key never gained its `result` row — as "not
 * complete", and the stopped notification was never corrected (the incident:
 * 16/15 across that journal, 346/318 across all journals). The classifier now
 * distinguishes two correctable terminal states from the un-correctable null:
 *   - 'completed' — startedKeys⊆resultKeys (agentsDone == agentsTotal). [as before]
 *   - 'settled'   — startedKeys⊄resultKeys but resultKeys.size≥1, the journal is
 *                   quiet, and its mtime is past the stopped row: real work
 *                   landed yet a subagent stayed hanging (agentsDone < agentsTotal).
 *   - null        — resultKeys.size==0, or not quiet, or mtime≤stopped: no signal.
 * The freshness gates (quiet window + mtime > stopped) still apply to BOTH
 * correctable states, so a still-writing orphan is never prematurely declared
 * settled mid-flight.
 *
 * DESIGN CONSTRAINTS (ADR-048):
 * - Read-only. Never writes the SDK-owned transcript and never touches the
 *   drain / B-N-DRAIN / shutdown-drain path.
 * - Fail-safe: any anomaly (missing folder, malformed line, unknown shape, stat
 *   failure, empty result set) yields NO correction, never throws, logs only
 *   via console.debug. The caller continues with its original payload as if this
 *   service did not exist (mirrors transcript-parser's "never throws on bad
 *   input" contract).
 * - Behind the `WORKFLOW_RECONCILE` flag (default OFF) so the byte-for-byte
 *   prior behaviour is preserved when disabled and the coupling to the internal
 *   journal.jsonl shape (which an upstream upgrade may change) is isolated.
 * - The correction is a DERIVED synthetic message appended to the
 *   getSessionMessages payload — not persisted — so disabling the flag removes
 *   it without a trace.
 */

const PROVIDER = 'claude';

/**
 * Default quiet window (ms). The reconcile only declares completion once the
 * journal has been idle for at least this long, so a still-running orphan that
 * is mid-write is never prematurely reported as complete.
 *
 * EXPORTED (T-53-B1, ADR-053): the workflow liveness classifier reuses the SAME
 * quiet threshold so the "journal is still being written" judgement is
 * consistent between the restart-only reconcile path and the B-103 liveness
 * path. Exporting the constant does not change any reconcile behaviour.
 */
export const DEFAULT_QUIET_MS = 5000;

/**
 * Reads the `WORKFLOW_RECONCILE` flag. OFF unless explicitly truthy — mirrors
 * the `ghostDetachEnabled()` gate idiom in claude-sdk.js. While OFF the service
 * is a no-op and getSessionMessages behaves exactly as before.
 */
export function workflowReconcileEnabled(): boolean {
  const raw = process.env.WORKFLOW_RECONCILE;
  if (typeof raw !== 'string') {
    return false;
  }
  const value = raw.trim().toLowerCase();
  return value === '1' || value === 'true' || value === 'yes' || value === 'on';
}

/**
 * Resolves the quiet-window threshold from `WORKFLOW_RECONCILE_QUIET_MS`,
 * falling back to {@link DEFAULT_QUIET_MS} for an unset/invalid value.
 */
function resolveQuietMs(): number {
  const parsed = Number.parseInt(process.env.WORKFLOW_RECONCILE_QUIET_MS ?? '', 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_QUIET_MS;
}

/**
 * Terminal settlement state of a reconciled workflow (C5):
 * - 'completed' — every started key has a matching result key
 *   (agentsDone == agentsTotal).
 * - 'settled'   — at least one result landed but some started key has no result
 *   (agentsDone < agentsTotal): the orphan produced work yet left a subagent
 *   hanging. Still a correction, but a partial one.
 */
export type WorkflowSettlementStatus = 'completed' | 'settled';

/**
 * One reconciled workflow whose journal has been quiet since after the stopped
 * notification. `status` distinguishes a fully completed workflow from a settled
 * (partial) one; `agentsDone`/`agentsTotal` are resultKeys vs startedKeys, so
 * `agentsDone === agentsTotal` exactly when `status === 'completed'`.
 */
export type WorkflowReconcileResult = {
  wfId: string;
  status: WorkflowSettlementStatus;
  agentsDone: number;
  agentsTotal: number;
  /** journal.jsonl mtime as ISO — used as the derived correction timestamp. */
  completedAt: string;
};

/**
 * Reads one workflow `journal.jsonl` and folds it into the started/result key
 * sets. `key` is a content hash the SDK assigns per work item; matching is by
 * key (NOT by raw line count) because a single key can appear in multiple
 * `started` lines (retry/escalation) yet only needs one `result` to be
 * considered done.
 *
 * Fail-safe per line: a corrupted JSON line is skipped (concurrent-write safe),
 * not fatal. A missing/unreadable journal yields empty sets so the caller
 * treats the workflow as "not complete" rather than erroring.
 *
 * EXPORTED (T-53-B1, ADR-053): reused verbatim by the workflow liveness path so
 * both the restart reconcile and the B-103 liveness read the journal through
 * ONE parser (single source of the started/result key semantics). Its behaviour
 * is unchanged — this is a visibility export only.
 */
export async function readJournalKeySets(
  journalPath: string,
): Promise<{ startedKeys: Set<string>; resultKeys: Set<string> }> {
  const startedKeys = new Set<string>();
  const resultKeys = new Set<string>();

  let rl: readline.Interface | null = null;
  try {
    rl = readline.createInterface({
      input: createReadStream(journalPath),
      crlfDelay: Infinity,
    });

    for await (const line of rl) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }

      let entry: AnyRecord;
      try {
        entry = JSON.parse(trimmed) as AnyRecord;
      } catch {
        // Skip malformed lines that can happen during concurrent journal writes.
        continue;
      }

      const key = entry.key;
      if (typeof key !== 'string' || !key) {
        continue;
      }

      if (entry.type === 'started') {
        startedKeys.add(key);
      } else if (entry.type === 'result') {
        resultKeys.add(key);
      }
      // Unknown `type` values are ignored (forward-compatible, fail-safe).
    }
  } catch (error) {
    // Missing/unreadable journal => treat as "no signal", never throw.
    console.debug(
      `[workflow-reconcile] could not read journal ${journalPath}:`,
      error instanceof Error ? error.message : String(error),
    );
    return { startedKeys: new Set(), resultKeys: new Set() };
  } finally {
    rl?.close();
  }

  return { startedKeys, resultKeys };
}

/**
 * Classifies a workflow's terminal settlement from its key sets (C5).
 * Freshness (quiet window + mtime > stopped) is enforced by the caller; this is
 * the pure key-set verdict:
 *
 *   - 'completed' — startedKeys.size ≥ 1 AND every started key has a result key
 *                   (startedKeys ⊆ resultKeys); agentsDone == agentsTotal.
 *   - 'settled'   — startedKeys ⊄ resultKeys BUT resultKeys.size ≥ 1: at least
 *                   one work item produced output while ≥ 1 started key never
 *                   gained a result (the orphan that left a subagent hanging);
 *                   agentsDone < agentsTotal.
 *   - null        — resultKeys.size == 0: no work was ever produced. That is the
 *                   absence of a finished workflow (e.g. results-only or
 *                   started-only noise), not a settlement — no correction.
 *
 * Pure and total: no I/O, never throws.
 */
function classifyWorkflowSettlement(
  startedKeys: Set<string>,
  resultKeys: Set<string>,
): WorkflowSettlementStatus | null {
  // No result row at all => nothing landed => never correct (conservative).
  if (resultKeys.size === 0) {
    return null;
  }

  // 'completed' requires at least one started key, all matched by a result.
  if (startedKeys.size >= 1) {
    let allMatched = true;
    for (const key of startedKeys) {
      if (!resultKeys.has(key)) {
        allMatched = false;
        break;
      }
    }
    if (allMatched) {
      return 'completed';
    }
  }

  // Otherwise there is real output (resultKeys.size ≥ 1) but at least one started
  // key is unmatched (or there are no started keys at all to "complete"): the
  // orphan produced work yet left a subagent hanging => 'settled'.
  return 'settled';
}

/**
 * Scans the session's `subagents/workflows/` directory and returns one
 * {@link WorkflowReconcileResult} per workflow that is provably settled
 * ('completed' OR 'settled', C5) AND fresh relative to the stopped notification.
 *
 * SCOPE (T-825): the ONLY directory read is `<sessionDir>/subagents/workflows/`,
 * and the ONLY completion signal recognized is a `wf_<id>/journal.jsonl` with
 * started/result keys. It never reads the supervisor `tasks/` tree nor a
 * DurableTask `result.json`/`DONE` — so it cannot claim a DurableTask's
 * completion. See the module header and the "(ز) authority boundary" tests.
 *
 * Freshness (both mandatory, ADR-048):
 *   (a) mtime(journal) > stoppedAt      — last written AFTER the stopped notice
 *   (b) now - mtime(journal) >= QUIET_MS — no write is currently in flight
 *
 * @param sessionDir  `<projectDir>/<transcriptSessionId>` (same base
 *                    getSessionMessages already computes for B-30 subagents).
 * @param stoppedAtMs Epoch ms of the background `run.stopped` row that the UI is
 *                    about to render. Workflows older than this are ignored.
 *
 * Read-only and fail-safe end to end: a missing `workflows` directory, an
 * unreadable journal, or a failed stat all degrade to "no correction" with a
 * console.debug note, never a throw.
 */
export async function findReconciledWorkflows(
  sessionDir: string,
  stoppedAtMs: number,
  options: { quietMs?: number; now?: number } = {},
): Promise<WorkflowReconcileResult[]> {
  const quietMs = options.quietMs ?? resolveQuietMs();
  const now = options.now ?? Date.now();
  const workflowsDir = path.join(sessionDir, 'subagents', 'workflows');

  let entries: string[];
  try {
    entries = await fsp.readdir(workflowsDir);
  } catch (error) {
    const fileError = error as NodeJS.ErrnoException;
    if (fileError.code !== 'ENOENT') {
      // A real read error (not "simply no workflows") is still non-fatal.
      console.debug(`[workflow-reconcile] could not list ${workflowsDir}:`, fileError.message);
    }
    return [];
  }

  const reconciled: WorkflowReconcileResult[] = [];

  for (const entry of entries) {
    if (!entry.startsWith('wf_')) {
      continue;
    }

    const journalPath = path.join(workflowsDir, entry, 'journal.jsonl');

    let journalStat: Stats;
    try {
      journalStat = await fsp.stat(journalPath);
    } catch {
      // No journal in this workflow folder yet => no signal for it.
      continue;
    }

    const journalMtimeMs = journalStat.mtimeMs;

    // Freshness (a): must have been written AFTER the stopped notification.
    if (!(journalMtimeMs > stoppedAtMs)) {
      continue;
    }
    // Freshness (b): quiet long enough that no orphan is still writing.
    if (now - journalMtimeMs < quietMs) {
      continue;
    }

    const { startedKeys, resultKeys } = await readJournalKeySets(journalPath);
    const status = classifyWorkflowSettlement(startedKeys, resultKeys);
    if (status === null) {
      continue;
    }

    reconciled.push({
      wfId: entry,
      status,
      // agentsDone = matched result keys; agentsTotal = started keys. For a
      // 'settled' workflow with no started rows at all (results-only orphan),
      // total falls back to resultKeys.size so agentsDone never exceeds total.
      agentsDone: resultKeys.size,
      agentsTotal: Math.max(startedKeys.size, resultKeys.size),
      completedAt: new Date(journalMtimeMs).toISOString(),
    });
  }

  return reconciled;
}

/**
 * Arabic correction copy per settlement status (C5). 'completed' = every agent
 * finished; 'settled' = real work landed but some agents never completed.
 */
const RECONCILE_CONTENT: Record<WorkflowSettlementStatus, string> = {
  completed: 'اكتملت المهمة الخلفية',
  settled: 'هدأت المهمة الخلفية (بعض الوكلاء لم يُكملوا)',
};

/**
 * Builds the DERIVED `task_reconcile` correction row appended to the
 * getSessionMessages payload. It carries `isTaskNotification:true` and a
 * `taskStatus` of the reconciled state ('completed' | 'settled', C5) so it
 * travels the existing task-notification card path on the frontend, and
 * `originKind:'task-notification'` so it is never attributed to the user. The
 * Arabic `content` matches the status. `timestamp` = journal mtime so it sorts
 * AFTER the stopped row it corrects. No `path` field — the journal has none.
 */
export function buildReconcileMessage(
  sessionId: string,
  reconciled: WorkflowReconcileResult,
): NormalizedMessage {
  return createNormalizedMessage({
    kind: 'task_reconcile',
    provider: PROVIDER,
    sessionId,
    timestamp: reconciled.completedAt,
    isTaskNotification: true,
    taskStatus: reconciled.status,
    content: RECONCILE_CONTENT[reconciled.status],
    wfId: reconciled.wfId,
    agentsDone: reconciled.agentsDone,
    agentsTotal: reconciled.agentsTotal,
    originKind: 'task-notification',
  });
}

/**
 * Top-level reconcile entry consumed by getSessionMessages.
 *
 * Returns derived `task_reconcile` correction rows (possibly empty). A no-op
 * when the flag is OFF, when there is no background stopped notification, or
 * when no workflow is both complete and fresh. Always read-only, never throws.
 *
 * @param sessionId   The app/session id stamped on the derived messages.
 * @param sessionDir  `<projectDir>/<transcriptSessionId>` from getSessionMessages.
 * @param stoppedAtMs Epoch ms of the latest background `run.stopped` row, or
 *                    `null` when the session has none (then this is a no-op).
 */
export async function reconcileWorkflowMessages(
  sessionId: string,
  sessionDir: string,
  stoppedAtMs: number | null,
  options: { quietMs?: number; now?: number } = {},
): Promise<NormalizedMessage[]> {
  try {
    if (!workflowReconcileEnabled()) {
      return [];
    }
    if (stoppedAtMs === null || !Number.isFinite(stoppedAtMs)) {
      return [];
    }

    const reconciled = await findReconciledWorkflows(sessionDir, stoppedAtMs, options);
    return reconciled.map((entry) => buildReconcileMessage(sessionId, entry));
  } catch (error) {
    // Defensive top-level guard: the reconcile must never break history loads.
    console.debug(
      '[workflow-reconcile] unexpected failure, skipping correction:',
      error instanceof Error ? error.message : String(error),
    );
    return [];
  }
}

/**
 * Detects the latest background `run.stopped` task-notification timestamp (epoch
 * ms) among already-parsed transcript rows, or `null` when none exists.
 *
 * A background stop is a user-role row whose SDK origin is `task-notification`
 * and whose string content carries `<status>stopped</status>`. Matching the
 * origin kind first keeps this robust to summary wording changes. The LATEST
 * such row wins so a workflow re-launched after a previous stop is reconciled
 * against the most recent stop, not an older one.
 *
 * Operates on the raw JSONL entries getSessionMessages already holds in memory,
 * so no extra disk read is introduced. Fail-safe: unparseable timestamps and
 * unexpected shapes are skipped.
 */
export function findLatestStoppedNotificationMs(messages: AnyRecord[]): number | null {
  let latestMs: number | null = null;

  for (const entry of messages) {
    const originKind = (entry?.origin as AnyRecord | undefined)?.kind;
    if (originKind !== 'task-notification') {
      continue;
    }

    const content = entry?.message?.content;
    if (typeof content !== 'string' || !content.includes('<status>stopped</status>')) {
      continue;
    }

    const ts = entry?.timestamp;
    if (typeof ts !== 'string') {
      continue;
    }
    const ms = new Date(ts).getTime();
    if (!Number.isFinite(ms)) {
      continue;
    }

    if (latestMs === null || ms > latestMs) {
      latestMs = ms;
    }
  }

  return latestMs;
}
