/**
 * ADR-218 — merges the server's agents registry into the card's rows.
 *
 * Two sources describe the same agents differently:
 *   - stream rows (`useRunProgress`): rich detail (current tool, child tools,
 *     calls) but only for the current reply;
 *   - registry rows (`useSessionAgents`): every agent of the session, and the
 *     authority on whether it is still alive or how it ended.
 * Join: a registry row matches a stream row when its `toolUseIds` (or its
 * `agentId`) contain the stream row's id. A match keeps the stream detail and
 * takes the registry state; an unmatched registry row becomes a row of its own.
 * Workflow registry rows already shown through `/workflows/active` are dropped.
 */

import type { SubagentOutcome } from '../../../../shared/subagent-states';

import type { SessionAgentRow, SessionAgentState } from './useSessionAgents';
import type { RunAgent } from './useRunProgress';

/** How long a registry-only row stays on the card after it ended. */
export const RECENTLY_ENDED_MS = 2 * 60 * 1000;

const OUTCOME: Readonly<Record<Exclude<SessionAgentState, 'running'>, SubagentOutcome>> = {
  done: 'completed',
  failed: 'failed',
  stopped: 'stopped',
  unknown: 'unknown',
};

const isEstimated = (row: SessionAgentRow): boolean => row.accuracy === 'reconstructed' || row.state === 'unknown';

/** Registry state as card fields (status + outcome); a live row has no current tool once ended. */
function stateFields(row: SessionAgentRow): Pick<RunAgent, 'status' | 'outcome'> {
  if (row.state === 'running') return { status: 'running', outcome: undefined };
  return { status: 'done', outcome: OUTCOME[row.state] };
}

/** A registry row with no stream counterpart, as a card row. */
function rowFromRegistry(row: SessionAgentRow): RunAgent {
  return {
    id: row.key,
    type: row.agentType ?? '',
    agentName: row.agentType,
    model: row.model,
    effort: row.effort,
    description: row.label,
    ...stateFields(row),
    callCount: 0,
    startedAt: row.startedAt,
    estimated: isEstimated(row),
  };
}

/** Stream detail with the registry's verdict on liveness. */
function overlay(agent: RunAgent, row: SessionAgentRow): RunAgent {
  const fields = stateFields(row);
  const merged: RunAgent = { ...agent, ...fields, estimated: isEstimated(row) };
  if (fields.status !== 'running') merged.currentTool = undefined;
  if (!merged.model && row.model) merged.model = row.model;
  if (!merged.effort && row.effort) merged.effort = row.effort;
  return merged;
}

/** Ended long enough ago that a registry-only row no longer belongs on the card. */
function endedLongAgo(row: SessionAgentRow, now: number): boolean {
  if (row.state === 'running') return false;
  return now - (row.endedAt ?? row.lastEventAt) > RECENTLY_ENDED_MS;
}

/**
 * @param stream   current-reply rows (useRunProgress)
 * @param workflow `/workflows/active` rows (ids `<wfId>:<agentId>`)
 * @param registry server snapshot rows for the open session
 * @param now      epoch ms, for the "recently ended" window
 * @returns stream rows (registry state applied), registry-only rows, workflow rows
 */
export function mergeSessionAgents(
  stream: readonly RunAgent[],
  workflow: readonly RunAgent[],
  registry: readonly SessionAgentRow[],
  now: number,
): RunAgent[] {
  if (registry.length === 0) return [...stream, ...workflow];
  const byRef = new Map<string, SessionAgentRow>();
  for (const row of registry) {
    for (const id of row.toolUseIds) byRef.set(id, row);
    if (row.agentId && row.source !== 'workflow') byRef.set(row.agentId, row);
  }
  const matched = new Set<string>();
  const merged = stream.map((agent) => {
    const row = byRef.get(agent.id);
    if (!row) return agent;
    matched.add(row.key);
    return overlay(agent, row);
  });
  const workflowIds = new Set(workflow.map((agent) => agent.id));
  const extra = registry.filter((row) => {
    if (matched.has(row.key) || endedLongAgo(row, now)) return false;
    return !(row.source === 'workflow' && workflowIds.has(row.key.replace(/^wf:/, '')));
  });
  return [...merged, ...extra.map(rowFromRegistry), ...workflow];
}

/**
 * Epoch ms when the next registry-only ended row leaves the window, or null.
 * Lets the card schedule one re-render instead of ticking.
 */
export function nextRegistryExpiry(registry: readonly SessionAgentRow[], now: number): number | null {
  let next: number | null = null;
  for (const row of registry) {
    if (row.state === 'running') continue;
    const expiry = (row.endedAt ?? row.lastEventAt) + RECENTLY_ENDED_MS;
    if (expiry > now && (next === null || expiry < next)) next = expiry;
  }
  return next;
}
