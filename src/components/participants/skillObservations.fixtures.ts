import type { SkillObservation, SessionSkillProjection } from '../../../shared/skillObservations';
import { summarizeSkillObservations } from './skillObservationHelpers';

/** Synthetic public DTO evidence, deliberately containing no local paths. */
export function observation(overrides: Partial<SkillObservation> = {}): SkillObservation {
  return { id: 'event-1', provider: 'claude', rootSessionId: 'session-root', sourceSessionId: 'session-child', turnId: null,
    actorId: 'actor-1', actorToolCallId: 'call-1', actorKind: 'subagent', skillKey: 'skill-1', skillName: 'diagnosing-bugs',
    evidence: 'read', outcome: 'succeeded', occurredAt: '2026-09-06T10:00:00Z', source: 'transcript', attribution: 'exact', ...overrides };
}

/** A complete source scan still has a limited detector. */
export function projection(observations: SkillObservation[] = [observation()]): SessionSkillProjection {
  return { observations, summary: summarizeSkillObservations(observations), coverage: { state: 'complete', scannedSources: 2, discoveredSources: 2,
    discoveryComplete: true, detector: { state: 'limited', capabilities: ['structured_read'], reasons: ['unobserved_execution_possible'] },
    reasons: [], asOf: '2026-09-06T10:00:00Z', nextCursor: null } };
}
