/**
 * Sub-agent outcome wording and counts (agent-progress study §3.2/§4.3, P0):
 * one plain label per state, so a failed, stopped or unknown agent never reads
 * as a success, and a counts line that never folds a failure into "done".
 */

import type { TFunction } from 'i18next';

import type { SubagentInferredCause, SubagentOutcome } from '../../../../../shared/subagent-states';

export type RowOutcome = 'running' | 'stale' | SubagentOutcome;

/** Row state from the row status and its outcome; a `done` row without one is a success. */
export function rowOutcome(agent: { status: 'running' | 'done' | 'stale'; outcome?: SubagentOutcome }): RowOutcome {
  if (agent.status !== 'done') return agent.status;
  return agent.outcome ?? 'completed';
}

/** True for an end that is not a success (failed, stopped, unknown). */
export function isUnsuccessfulOutcome(outcome: RowOutcome): boolean {
  return outcome === 'failed' || outcome === 'stopped' || outcome === 'unknown';
}

/** Short label of a row state; an owner stop says so. */
export function outcomeLabel(t: TFunction, outcome: RowOutcome, cause?: SubagentInferredCause): string {
  switch (outcome) {
    case 'running': return t('agentActivity.running', { defaultValue: 'Running' });
    case 'stale': return t('agentActivity.stale', { defaultValue: 'No signal' });
    case 'completed': return t('agentActivity.done', { defaultValue: 'Succeeded' });
    case 'failed': return t('agentActivity.failed', { defaultValue: 'Failed' });
    case 'stopped': return cause === 'owner'
      ? t('agentActivity.stoppedByOwner', { defaultValue: 'Stopped by owner' })
      : t('agentActivity.stopped', { defaultValue: 'Stopped' });
    default: return t('agentActivity.unknownOutcome', { defaultValue: 'No end signal' });
  }
}

/** Tooltip explaining a non-success end and, when inferred, its cause; '' otherwise. */
export function outcomeTooltip(t: TFunction, outcome: RowOutcome, cause?: SubagentInferredCause): string {
  if (outcome === 'failed') return t('agentActivity.failedTooltip', { defaultValue: 'The agent reported a failure.' });
  if (outcome === 'stopped') {
    return cause === 'owner'
      ? t('agentActivity.stoppedByOwnerTooltip', { defaultValue: 'The run was stopped while this agent was working.' })
      : t('agentActivity.stoppedTooltip', { defaultValue: 'The harness reported that the agent stopped before finishing.' });
  }
  if (outcome !== 'unknown') return '';
  return cause === 'timeout'
    ? t('agentActivity.unknownTimeoutTooltip', { defaultValue: 'No signal from this agent for over 6 hours.' })
    : t('agentActivity.unknownProcessExitTooltip', {
      defaultValue: 'Its process ended without reporting how this agent finished.',
    });
}

/** Badge tone per non-success end (tokens, not raw colours where the theme has one). */
export const OUTCOME_BADGE_CLASS: Readonly<Record<'failed' | 'stopped' | 'unknown', string>> = {
  failed: 'bg-destructive/10 text-destructive',
  stopped: 'bg-muted text-muted-foreground',
  unknown: 'bg-muted text-muted-foreground',
};

export type AgentOutcomeCounts = Record<'succeeded' | 'failed' | 'stopped' | 'unknown' | 'running', number>;

/** Rows per outcome; `stale` rows are neither running nor ended and are not counted. */
export function countAgentOutcomes(
  agents: ReadonlyArray<{ status: 'running' | 'done' | 'stale'; outcome?: SubagentOutcome }>,
): AgentOutcomeCounts {
  const counts: AgentOutcomeCounts = { succeeded: 0, failed: 0, stopped: 0, unknown: 0, running: 0 };
  for (const agent of agents) {
    const outcome = rowOutcome(agent);
    if (outcome === 'completed') counts.succeeded += 1;
    else if (outcome !== 'stale') counts[outcome] += 1;
  }
  return counts;
}

const COUNT_KEYS: ReadonlyArray<[keyof AgentOutcomeCounts, string, string]> = [
  ['succeeded', 'agentActivity.agentsCompleted', '{{n}} succeeded'],
  ['failed', 'agentActivity.agentsFailed', '{{n}} failed'],
  ['stopped', 'agentActivity.agentsStopped', '{{n}} stopped'],
  ['unknown', 'agentActivity.agentsUnknown', '{{n}} no end signal'],
  ['running', 'agentActivity.agentsRunning', '{{n}} running'],
];

/**
 * The single counts indicator (52f3419a6), broken down by outcome so a failure
 * is never counted as done: «2 نجحوا · 1 فشل · 1 يعمل». Zero parts are left out.
 * `count` drives Arabic plural forms; `n` is the locale-formatted number.
 */
export function agentCountsLabel(t: TFunction, locale: string, counts: AgentOutcomeCounts): string {
  return COUNT_KEYS
    .filter(([key]) => counts[key] > 0)
    .map(([key, i18nKey, defaultValue]) => t(i18nKey, {
      count: counts[key], n: counts[key].toLocaleString(locale), defaultValue,
    }))
    .join(' · ');
}
