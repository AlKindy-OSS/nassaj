import { describe, expect, it } from 'vitest';
import { attachObservedSkills, summarizeSkillObservations } from './skillObservationHelpers';
import { observation, projection } from './skillObservations.fixtures';
import { readSessionSkillProjection, readProjectSkillProjection } from './skillObservationPayload';
import type { RunAgent } from '../chat/hooks/useRunProgress';

const agent = (id: string): RunAgent => ({ id, type: 'backend-dev', description: id, status: 'running', callCount: 0, startedAt: 0 });

describe('authoritative skill evidence presentation', () => {
  it('keeps same-role actors distinct and refuses unknown/name-based ownership', () => {
    const payload = projection([observation(), observation({ id: 'event-2', actorToolCallId: 'call-2', skillKey: 'skill-2', skillName: 'security-review' }), observation({ id: 'event-3', actorToolCallId: 'call-1', attribution: 'unknown' }), observation({ id: 'event-4', actorToolCallId: 'backend-dev' })]);
    const rows = attachObservedSkills([agent('call-1'), agent('call-2')], payload);
    expect(rows.map(row => row.observedSkills?.map(item => item.id))).toEqual([['event-1'], ['event-2']]);
    expect(attachObservedSkills([agent('call-1'), agent('call-1')], payload).every(row => row.observedSkills?.length === 0)).toBe(true);
    expect(attachObservedSkills([agent('call-1'), agent('call-1')], payload).every(row => row.skillCoverage?.state === 'unavailable')).toBe(true);
    expect(attachObservedSkills([agent('call-1')], payload, true)[0].skillsStale).toBe(true);
  });
  it('deduplicates replay and separates failed attempts from successful reads', () => {
    const read = observation();
    const result = summarizeSkillObservations([read, read, observation({ id: 'event-2', evidence: 'invocation', outcome: 'failed' })]);
    expect(result).toMatchObject({ observedDistinct: 1, readSucceeded: 1, invocationAttempts: 1, invocationSucceeded: 0, invocationFailed: 1, totalActual: null });
  });
  it('marks a per-agent count partial when details have more pages', () => {
    const payload = projection(); payload.coverage.nextCursor = 'next-page';
    expect(attachObservedSkills([agent('call-1')], payload)[0].skillCoverage?.state).toBe('partial');
  });
  it('rejects malformed counters and raw actor paths', () => {
    expect(readSessionSkillProjection(projection())).not.toBeNull();
    const malformed = projection(); malformed.summary.invocationAttempts = 99;
    expect(readSessionSkillProjection(malformed)).toBeNull();
    expect(readSessionSkillProjection(projection([observation({ actorToolCallId: '/home/example' })]))).toBeNull();
    expect(readProjectSkillProjection({ summary: projection().summary })).toBeNull();
  });
  it('accepts every declared coverage reason in session and project payloads', () => {
    const payload = projection();
    payload.coverage.reasons = ['scan_budget', 'source_limit', 'line_limit', 'memory_limit', 'lookup_limit', 'response_limit', 'discovery_limit', 'source_unavailable', 'source_changed', 'unresolved_attribution', 'ambiguous_origin', 'aborted', 'cold_cache', 'unknown_timestamp'];
    expect(readSessionSkillProjection(payload)).not.toBeNull();
    expect(readProjectSkillProjection({ ...payload, rows: [], eligibleSessions: 1, scannedSessions: 1, partialSessions: 0, unavailableSessions: 0 })).not.toBeNull();
  });
  it('rejects unknown, inherited and non-string coverage reasons without coercion', () => {
    for (const reason of ['unrecognized_reason', '__proto__', 'toString', ['scan_budget'], { code: 'scan_budget' }, null, 0]) {
      const payload = projection();
      const malformed = { ...payload, coverage: { ...payload.coverage, reasons: [reason] } };
      expect(readSessionSkillProjection(malformed)).toBeNull();
      expect(readProjectSkillProjection({ ...malformed, rows: [], eligibleSessions: 1, scannedSessions: 1, partialSessions: 0, unavailableSessions: 0 })).toBeNull();
    }
  });
});
