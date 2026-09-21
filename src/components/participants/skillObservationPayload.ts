import type { SkillCoverage, SkillSummary, SkillObservation, SessionSkillProjection, ProjectSkillProjection } from '../../../shared/skillObservations';

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const isCount = (value: unknown) => Number.isSafeInteger(value) && (value as number) >= 0;
const isId = (value: unknown) => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
const isNullableId = (value: unknown) => value === null || isId(value);
const isDate = (value: unknown) => value === null || (typeof value === 'string' && value.length <= 40 && Number.isFinite(Date.parse(value)));
const COVERAGE_REASONS: Record<SkillCoverage['reasons'][number], true> = {
  scan_budget: true, source_limit: true, line_limit: true, memory_limit: true,
  lookup_limit: true, response_limit: true, discovery_limit: true,
  source_unavailable: true, source_changed: true, unresolved_attribution: true,
  ambiguous_origin: true, aborted: true, cold_cache: true, unknown_timestamp: true,
};

function isSummary(value: unknown): value is SkillSummary {
  if (!isRecord(value) || value.totalActual !== null) return false;
  const keys = ['observedDistinct', 'invocationAttempts', 'invocationSucceeded', 'invocationFailed', 'invocationPending', 'invocationUnknown', 'readSucceeded', 'readFailed', 'readPending', 'readUnknown'];
  return keys.every(key => isCount(value[key])) && value.invocationAttempts === Number(value.invocationSucceeded) + Number(value.invocationFailed) + Number(value.invocationPending) + Number(value.invocationUnknown);
}

function isCoverage(value: unknown): value is SkillCoverage {
  return isRecord(value) && ['complete', 'partial', 'unsupported', 'unavailable'].includes(String(value.state))
    && isCount(value.scannedSources) && isCount(value.discoveredSources) && typeof value.discoveryComplete === 'boolean'
    && isRecord(value.detector) && ['limited', 'unsupported'].includes(String(value.detector.state))
    && Array.isArray(value.detector.capabilities) && value.detector.capabilities.every(item => ['native_invocation', 'structured_read', 'literal_shell_read'].includes(String(item)))
    && Array.isArray(value.detector.reasons) && value.detector.reasons.every(item => ['unsupported_provider', 'unobserved_execution_possible', 'unsupported_tool_shape'].includes(String(item)))
    && Array.isArray(value.reasons) && value.reasons.every(reason => typeof reason === 'string' && Object.prototype.hasOwnProperty.call(COVERAGE_REASONS, reason))
    && isDate(value.asOf)
    && (value.nextCursor === null || (typeof value.nextCursor === 'string' && value.nextCursor.length <= 2048));
}

function isObservation(value: unknown): value is SkillObservation {
  return isRecord(value) && isId(value.id) && isId(value.skillKey) && isId(value.rootSessionId) && isId(value.sourceSessionId)
    && isNullableId(value.actorId) && isNullableId(value.actorToolCallId) && isNullableId(value.turnId)
    && typeof value.skillName === 'string' && value.skillName.length <= 120
    && ['claude', 'codex'].includes(String(value.provider)) && ['root', 'subagent', 'unknown'].includes(String(value.actorKind))
    && ['invocation', 'read'].includes(String(value.evidence)) && ['pending', 'succeeded', 'failed', 'unknown'].includes(String(value.outcome))
    && ['transcript', 'live'].includes(String(value.source)) && ['exact', 'unknown'].includes(String(value.attribution)) && isDate(value.occurredAt);
}

/** Reject malformed data rather than coercing missing counters into zero. */
export function readSessionSkillProjection(value: unknown): SessionSkillProjection | null {
  return isRecord(value) && isSummary(value.summary) && isCoverage(value.coverage)
    && Array.isArray(value.observations) && value.observations.length <= 200 && value.observations.every(isObservation)
    ? value as SessionSkillProjection : null;
}

/** Project payload is additive and independently validated from cost statistics. */
export function readProjectSkillProjection(value: unknown): ProjectSkillProjection | null {
  if (!isRecord(value) || !isSummary(value.summary) || !isCoverage(value.coverage)) return null;
  if (!['eligibleSessions', 'scannedSessions', 'partialSessions', 'unavailableSessions'].every(key => isCount(value[key]))) return null;
  if (!Array.isArray(value.rows) || value.rows.length > 100 || !value.rows.every(row => isRecord(row) && isId(row.skillKey) && typeof row.skillName === 'string' && row.skillName.length <= 120 && isSummary(row.summary))) return null;
  return value as ProjectSkillProjection;
}
