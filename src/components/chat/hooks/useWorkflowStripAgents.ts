/**
 * Workflow agents, adapted to the composer strip's row shape.
 *
 * THE GAP THIS CLOSES
 * -------------------
 * `useRunProgress` derives the strip's rows from `chatMessages` — one row per
 * `Task`/`Agent` container in the transcript. A `Workflow` run has no such
 * container: its agents live only on disk under the session's
 * `subagents/workflows` directory. So a session that fanned out nine workflow
 * agents showed a bare "Working…" bar, while a session delegating with the
 * `Agent` tool showed four live rows. Same strip, two data paths, one of them
 * missing. This hook is the missing one: it reads the polled workflow store
 * (already fed by `useActiveWorkflows`) and maps its agents onto `RunAgent`.
 *
 * WHY IT DOES NOT REUSE `useRunProgress`
 * -------------------------------------
 * That hook is documented as a PER-REPLY indicator, bounded to messages after the
 * last human prompt so it appears and disappears with each reply. Workflow agents
 * are the opposite: the `Workflow` tool returns in milliseconds (measured: 12ms)
 * and its agents then run for hours across many replies. Folding them into that
 * scan would break its contract in both directions. They are merged only at the
 * presentation layer, in `AgentStatusCard`.
 *
 * HONESTY OF EACH FIELD
 * ---------------------
 *   - `type`   — the workflow's short id + the agent's ordinal. NOT a subagent
 *     type: the journal records `{type,key,agentId}` only, and `meta.json` says
 *     `workflow-subagent` for every agent, so a specific type would be invented.
 *   - `description` — the server's best-effort label, or '' when the prompt did
 *     not open with a short task line. Never a truncated wall of context.
 *   - `callCount` / `currentTool` — derived from the agent's own transcript. Unlike
 *     the `Agent`-tool rows (whose child-tool enrichment exists only on the live
 *     WS stream), these survive a page refresh because their source is disk.
 *   - `childTools` — deliberately undefined: the per-tool history is not fetched,
 *     and an empty array would render as "no tool calls recorded" for an agent
 *     that has made dozens.
 */

import { useMemo } from 'react';

import { useSessionWorkflows } from '../../../stores/workflowStatusStore';
import {
  deriveWorkflowUiState,
  type WorkflowUiDescriptor,
} from '../../../stores/workflowStatus';
import { pickPrimaryWorkflow } from '../../../shared/view/WorkflowStatusBadge';
import type { RunAgent } from './useRunProgress';

/** Statuses whose agents are worth showing in the strip at all. */
const SURFACED_STATUSES = new Set(['running', 'unknown', 'frozen']);

/**
 * Rows for every workflow of this session whose liveness still warrants showing
 * its agents. An `orphan` workflow is excluded on purpose: its dedicated badge
 * already says the run died, and repeating its agents as strip rows next to a
 * live run's agents would blur "working now" with "died earlier".
 */
export function useWorkflowStripAgents(sessionId?: string | null): RunAgent[] {
  const workflows = useSessionWorkflows(sessionId);

  return useMemo<RunAgent[]>(() => {
    const rows: RunAgent[] = [];
    for (const wf of workflows) {
      if (!SURFACED_STATUSES.has(wf.status)) continue;
      // Short, recognisable handle: `wf_10000000-demo` → `10000000`.
      const shortId = wf.wfId.replace(/^wf_/, '').split('-')[0] ?? wf.wfId;
      for (const agent of wf.agents) {
        rows.push({
          id: `${wf.wfId}:${agent.agentId}`,
          type: `${shortId} · #${agent.ordinal}`,
          description: agent.label ?? '',
          status: agent.status,
          // Never a "current tool" for a row that is not live: for a stale agent
          // that string is the tool it died on, and rendering it as `now …` is
          // precisely the lie this feature exists to remove.
          currentTool: agent.status === 'running' ? agent.currentTool ?? undefined : undefined,
          callCount: agent.callCount,
          startedAt: agent.updatedAt ? new Date(agent.updatedAt).getTime() : 0,
          childTools: undefined,
        });
      }
    }
    return rows;
  }, [workflows]);
}

/**
 * The UI descriptor of the workflow whose rows the strip is showing, or null.
 *
 * WHY THIS EXISTS (the display lie it removes)
 * -------------------------------------------
 * The card used to print a HARD-CODED "Background workflow running" whenever the
 * coordinator was idle and any row was on screen (AgentStatusCard: `backgroundOnly`).
 * But `SURFACED_STATUSES` above admits `unknown` and `frozen` too — so a run whose
 * liveness the server had already refused to vouch for, and a run explicitly
 * SIGSTOPped, both rendered as the word "running". The server's honest verdict
 * existed the whole time and simply never reached the component.
 *
 * Same source and same precedence as the sidebar badge (`pickPrimaryWorkflow`),
 * so the card and the badge can never disagree about one session.
 */
export function useWorkflowStripStatus(
  sessionId?: string | null,
): WorkflowUiDescriptor | null {
  const workflows = useSessionWorkflows(sessionId);

  return useMemo<WorkflowUiDescriptor | null>(() => {
    const surfaced = workflows.filter((wf) => SURFACED_STATUSES.has(wf.status));
    const primary = pickPrimaryWorkflow(surfaced);
    if (!primary) return null;
    return deriveWorkflowUiState(primary.status, primary.agentsDone, primary.agentsTotal);
  }, [workflows]);
}
