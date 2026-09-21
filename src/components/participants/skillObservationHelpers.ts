import type { SkillObservation, SkillSummary, SessionSkillProjection } from '../../../shared/skillObservations';
import type { RunAgent } from '../chat/hooks/useRunProgress';

/** Summarize already-authoritative evidence without classifying tool text. */
export function summarizeSkillObservations(observations: SkillObservation[]): SkillSummary {
  const unique = [...new Map(observations.map(item => [item.id, item])).values()];
  const count = (evidence: string, outcome: string) => unique.filter(item => item.evidence === evidence && item.outcome === outcome).length;
  return {
    observedDistinct: new Set(unique.map(item => item.skillKey)).size,
    invocationAttempts: unique.filter(item => item.evidence === 'invocation').length,
    invocationSucceeded: count('invocation', 'succeeded'), invocationFailed: count('invocation', 'failed'),
    invocationPending: count('invocation', 'pending'), invocationUnknown: count('invocation', 'unknown'),
    readSucceeded: count('read', 'succeeded'), readFailed: count('read', 'failed'),
    readPending: count('read', 'pending'), readUnknown: count('read', 'unknown'), totalActual: null,
  };
}

/** Join only verified native card IDs; identical role names never establish ownership. */
export function attachObservedSkills(agents: RunAgent[], projection: SessionSkillProjection | null, stale = false): RunAgent[] {
  if (!projection) return agents;
  const ids = new Map<string, number>();
  for (const agent of agents) ids.set(agent.id, (ids.get(agent.id) ?? 0) + 1);
  return agents.map(agent => ({
    ...agent,
    skillsStale: stale,
    observedSkills: projection.observations.filter(item => item.attribution === 'exact'
      && item.actorKind === 'subagent' && item.actorToolCallId === agent.id && ids.get(agent.id) === 1),
    skillCoverage: ids.get(agent.id) !== 1 ? { ...projection.coverage, state: 'unavailable', reasons: [...projection.coverage.reasons, 'unresolved_attribution'] } : projection.coverage.nextCursor && projection.coverage.state === 'complete' ? { ...projection.coverage, state: 'partial' } : projection.coverage,
  }));
}
