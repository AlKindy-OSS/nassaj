/**
 * Honest UI-state derivation for a background workflow (B-103, ADR-053).
 *
 * The server's GET /api/providers/workflows/active endpoint answers "which of MY
 * background workflows are still running or orphaned?". It only ever emits
 * `running` and `orphan` today (a COMPLETED workflow is dropped server-side), but
 * this derivation is deliberately TOTAL (M2) over four statuses so no envelope
 * shape — present or future — can break the UI:
 *
 *   running → «يعمل»  (+ optional progress, pulsing)
 *   unknown → «حيوية غير معروفة — أعد الفحص»  (neutral — NEVER claims death)
 *   orphan, done = 0            → «خرجت العملية — بلا مخرجات»
 *   orphan, 0 < done < total    → «توقّف — جزئي (done/total)»
 *   orphan, done ≥ total        → «توقّف — المخرجات ناقصة»  (NEVER n/n for a dead run)
 *   frozen  → «مُجمَّد»
 *
 * The badge (WorkflowStatusBadge) turns the returned descriptor into a
 * shape+text pill — colour is only ever a secondary cue. Pure and side-effect
 * free so it is shared by the session badge, the chat header, and the project
 * rollup, and unit-tested in isolation.
 */

/**
 * Workflow liveness as surfaced by the endpoint. The server contract emits only
 * `running | orphan`; `unknown` and `frozen` are accepted here so the derivation
 * stays total against defensive / future envelope shapes and never throws.
 */
export type ActiveWorkflowStatus = 'running' | 'unknown' | 'orphan' | 'frozen';

/**
 * One delegated agent inside a workflow, as the server reads it off disk.
 *
 * These have NO client-side equivalent: a `Workflow` run writes no `Task`/`Agent`
 * container into the session transcript, so `useRunProgress` — which derives the
 * composer strip's rows from `chatMessages` — is structurally blind to them. This
 * is their only source, and the reason the strip showed nothing for a session
 * that had just fanned out nine agents.
 */
export type WorkflowAgent = {
  /** Journal agent id — stable across polls; the React key. */
  agentId: string;
  /** 1-based delegation order within the workflow. */
  ordinal: number;
  status: 'running' | 'done';
  /** Tool calls issued so far, read from the agent's own transcript. */
  callCount: number;
  /** Most recent tool while running; null when done or unknown. */
  currentTool: string | null;
  /** Short task label when derivable from the prompt; null otherwise. */
  label: string | null;
  /** Last write to this agent's transcript (ISO), or null. */
  updatedAt: string | null;
};

/** One active (running or orphaned) workflow owned by the caller. */
export type ActiveWorkflow = {
  sessionId: string;
  wfId: string;
  status: ActiveWorkflowStatus;
  /** Unique result keys observed so far (progress numerator). */
  agentsDone: number;
  /** Unique started keys (progress denominator; >= agentsDone). */
  agentsTotal: number;
  /** Journal mtime (ISO), or null when the journal was unreadable. */
  updatedAt: string | null;
  /** Per-agent rows for the composer strip; empty when none are known yet. */
  agents: WorkflowAgent[];
  /** True when the agent list was cut at the server's per-workflow cap. */
  agentsTruncated: boolean;
};

/**
 * Envelope returned by the endpoint. The counters make the declared scan cap
 * observable so "scanned everything, found nothing" is distinguishable from
 * "hit the cap, did NOT look at everything".
 */
export type ActiveWorkflowsEnvelope = {
  workflows: ActiveWorkflow[];
  /** Distinct sessions the caller owns (before the cap). */
  eligible: number;
  /** Sessions actually inspected this call (<= eligible, <= cap). */
  scanned: number;
  /** True when eligible > scanned: NOT every owned session was scanned. */
  capped: boolean;
};

/** Discrete UI states the badge renders — one per honest outcome above. */
export type WorkflowUiState =
  | 'running'
  | 'unknown'
  | 'orphan_empty'
  | 'orphan_partial'
  | 'orphan_incomplete'
  | 'frozen';

export type WorkflowUiDescriptor = {
  state: WorkflowUiState;
  /** i18n key under `workflowStatus.*` for the visible label. */
  labelKey: string;
  /** i18n key under `workflowStatus.*` for the title/hint. */
  hintKey: string;
  /** Only the live `running` state pulses. */
  pulse: boolean;
  /**
   * Progress fraction to render beside the label, or null. Shown for `running`
   * (optional live progress) and `orphan_partial`. NEVER emitted for a dead run
   * that reached its denominator (`orphan_incomplete`) — a completed-looking
   * n/n on a workflow that produced no final result would be a lie.
   */
  progress: { done: number; total: number } | null;
};

/** Coerce a possibly-dirty count to a safe non-negative integer. */
function safeCount(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

/**
 * Derive the honest UI descriptor from a workflow's status + progress counters.
 * Total: any unrecognised status collapses to the neutral `unknown` state, which
 * asks the user to re-scan rather than asserting the run is dead.
 */
export function deriveWorkflowUiState(
  status: ActiveWorkflowStatus | string,
  agentsDone: number,
  agentsTotal: number,
): WorkflowUiDescriptor {
  const done = safeCount(agentsDone);
  // The denominator can never be below what we have already observed.
  const total = Math.max(safeCount(agentsTotal), done);

  if (status === 'running') {
    return {
      state: 'running',
      labelKey: 'workflowStatus.running',
      hintKey: 'workflowStatus.runningHint',
      pulse: true,
      progress: total > 0 ? { done, total } : null,
    };
  }

  if (status === 'frozen') {
    return {
      state: 'frozen',
      labelKey: 'workflowStatus.frozen',
      hintKey: 'workflowStatus.frozenHint',
      pulse: false,
      progress: null,
    };
  }

  if (status === 'orphan') {
    if (done <= 0) {
      return {
        state: 'orphan_empty',
        labelKey: 'workflowStatus.orphanEmpty',
        hintKey: 'workflowStatus.orphanEmptyHint',
        pulse: false,
        progress: null,
      };
    }
    if (done < total) {
      return {
        state: 'orphan_partial',
        labelKey: 'workflowStatus.orphanPartial',
        hintKey: 'workflowStatus.orphanPartialHint',
        pulse: false,
        progress: { done, total },
      };
    }
    // done >= total (> 0): the process exited having "started == resulted" but
    // still counts as an orphan → its outputs are incomplete. Never show n/n.
    return {
      state: 'orphan_incomplete',
      labelKey: 'workflowStatus.orphanIncomplete',
      hintKey: 'workflowStatus.orphanIncompleteHint',
      pulse: false,
      progress: null,
    };
  }

  // 'unknown' and any unexpected status: neutral liveness, no death claim.
  return {
    state: 'unknown',
    labelKey: 'workflowStatus.unknown',
    hintKey: 'workflowStatus.unknownHint',
    pulse: false,
    progress: null,
  };
}

/**
 * Tailwind classes for the badge pill, keyed by UI state. Colour is a secondary
 * cue only (each state also carries a distinct icon + text): running reads as
 * live (indigo, distinct from the green process badge), orphans as needs-
 * attention (amber), unknown as neutral, frozen as paused.
 */
export const WORKFLOW_UI_STATE_STYLES: Record<WorkflowUiState, string> = {
  running: 'border-indigo-500/30 bg-indigo-500/10 text-indigo-600 dark:text-indigo-400',
  unknown: 'border-slate-500/40 bg-slate-500/10 text-slate-600 dark:text-slate-300',
  orphan_empty: 'border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400',
  orphan_partial: 'border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400',
  orphan_incomplete: 'border-orange-500/40 bg-orange-500/10 text-orange-700 dark:text-orange-400',
  frozen: 'border-sky-500/30 bg-sky-500/10 text-sky-600 dark:text-sky-400',
};

/**
 * Normalises a raw endpoint envelope into a safe, well-typed shape: drops
 * malformed workflow entries, clamps counters, and guarantees array/number
 * types. Defensive because this feeds an honesty-critical UI — a garbled row
 * must degrade to "nothing", never crash or mislead.
 */
/**
 * Normalises the per-workflow agent list. Same contract as the envelope itself: a
 * malformed row is DROPPED rather than rendered half-known, because every field
 * here ends up as a claim about a running process on the user's screen. An agent
 * with no id cannot be keyed or de-duplicated, so it cannot be shown at all.
 */
export function normalizeWorkflowAgents(raw: unknown): WorkflowAgent[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const agents: WorkflowAgent[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const a = entry as Record<string, unknown>;
    const agentId = typeof a.agentId === 'string' ? a.agentId : '';
    if (!agentId) continue;
    const status = a.status === 'done' ? 'done' : 'running';
    agents.push({
      agentId,
      ordinal: safeCount(typeof a.ordinal === 'number' ? a.ordinal : 0),
      status,
      callCount: safeCount(typeof a.callCount === 'number' ? a.callCount : 0),
      // A finished agent never carries a "current" tool: showing its last one
      // would read as still-in-flight.
      currentTool:
        status === 'running' && typeof a.currentTool === 'string' && a.currentTool
          ? a.currentTool
          : null,
      label: typeof a.label === 'string' && a.label.trim() ? a.label.trim() : null,
      updatedAt: typeof a.updatedAt === 'string' ? a.updatedAt : null,
    });
  }
  return agents;
}

export function normalizeWorkflowsEnvelope(raw: unknown): ActiveWorkflowsEnvelope {
  const empty: ActiveWorkflowsEnvelope = { workflows: [], eligible: 0, scanned: 0, capped: false };
  if (!raw || typeof raw !== 'object') {
    return empty;
  }
  const obj = raw as Record<string, unknown>;
  const rawList = Array.isArray(obj.workflows) ? obj.workflows : [];
  const workflows: ActiveWorkflow[] = [];
  for (const entry of rawList) {
    if (!entry || typeof entry !== 'object') continue;
    const w = entry as Record<string, unknown>;
    const sessionId = typeof w.sessionId === 'string' ? w.sessionId : '';
    const wfId = typeof w.wfId === 'string' ? w.wfId : '';
    if (!sessionId || !wfId) continue;
    const status = typeof w.status === 'string' ? w.status : 'unknown';
    workflows.push({
      agents: normalizeWorkflowAgents(w.agents),
      agentsTruncated: w.agentsTruncated === true,
      sessionId,
      wfId,
      status: (status === 'running' || status === 'orphan' || status === 'frozen'
        ? status
        : 'unknown') as ActiveWorkflowStatus,
      agentsDone: safeCount(typeof w.agentsDone === 'number' ? w.agentsDone : 0),
      agentsTotal: safeCount(typeof w.agentsTotal === 'number' ? w.agentsTotal : 0),
      updatedAt: typeof w.updatedAt === 'string' ? w.updatedAt : null,
    });
  }
  return {
    workflows,
    eligible: safeCount(typeof obj.eligible === 'number' ? obj.eligible : 0),
    scanned: safeCount(typeof obj.scanned === 'number' ? obj.scanned : 0),
    capped: obj.capped === true,
  };
}
