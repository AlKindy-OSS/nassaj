/**
 * ADR-218: read-only view of a session's Workflow agents as session-agent rows.
 * The source stays the existing workflow status scan (journal + liveness); the
 * `/workflows/active` endpoint is untouched. Rows are rebuilt on every
 * snapshot, so they are never stored in the registry.
 */

import { workflowStatusService, type ActiveWorkflow } from '../workflow-status.service.js';

import type { AgentAccuracy, AgentState, PublicAgentRow } from './registry.js';

type SessionWorkflow = Omit<ActiveWorkflow, 'projectId'>;

/** Workflow agent status → row state: `stale` claims neither life nor death. */
const STATE: Readonly<Record<string, AgentState>> = { running: 'running', done: 'done', stale: 'unknown' };

const epoch = (iso: string | null | undefined, fallback: number): number => {
  const parsed = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(parsed) ? parsed : fallback;
};

/**
 * A row is `live` when the workflow's liveness is proven (`running`: its process,
 * or its supervisor scope, is alive) and the agent's own status is not `stale`;
 * orphan/unknown/frozen workflows and stale agents are `reconstructed`.
 */
const accuracyOf = (workflow: SessionWorkflow, agentStatus: string): AgentAccuracy =>
  (workflow.status === 'running' && agentStatus !== 'stale' ? 'live' : 'reconstructed');

/** Maps the workflows of one session to agent rows (`key` = `wf:<wfId>:<agentId>`). */
export function workflowAgentRows(sessionId: string, workflows: readonly SessionWorkflow[], now: number): PublicAgentRow[] {
  return workflows.flatMap((workflow) => workflow.agents.map((agent) => {
    const lastEventAt = epoch(agent.updatedAt, epoch(workflow.updatedAt, now));
    const state = STATE[agent.status] ?? 'unknown';
    return {
      key: `wf:${workflow.wfId}:${agent.agentId}`,
      sessionId,
      source: 'workflow' as const,
      agentId: agent.agentId,
      toolUseIds: [],
      label: agent.label ?? `${workflow.wfId} #${agent.ordinal}`,
      ...(agent.model ? { model: agent.model } : {}),
      ...(agent.effort ? { effort: agent.effort } : {}),
      background: true,
      state,
      startedAt: lastEventAt,
      ...(state === 'done' ? { endedAt: lastEventAt } : {}),
      lastEventAt,
      accuracy: accuracyOf(workflow, agent.status),
    };
  }));
}

/** Workflow agent rows of one session (injected into the session agents service). */
export async function readSessionWorkflowAgents(sessionId: string): Promise<PublicAgentRow[]> {
  const now = Date.now();
  return workflowAgentRows(sessionId, await workflowStatusService.getSessionWorkflows(sessionId, { now }), now);
}
