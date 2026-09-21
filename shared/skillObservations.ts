/** ADR-144: evidence is an observed attempt, never proof of instruction compliance. */
export type SkillObservation = {
  id: string;
  provider: 'claude' | 'codex';
  sourceSessionId: string;
  rootSessionId: string;
  turnId: string | null;
  actorId: string | null;
  actorToolCallId: string | null;
  actorKind: 'root' | 'subagent' | 'unknown';
  skillKey: string;
  skillName: string;
  evidence: 'invocation' | 'read';
  outcome: 'pending' | 'succeeded' | 'failed' | 'unknown';
  occurredAt: string | null;
  source: 'transcript' | 'live';
  attribution: 'exact' | 'unknown';
};
export type SkillSummary = {
  observedDistinct: number;
  invocationAttempts: number;
  invocationSucceeded: number;
  invocationFailed: number;
  invocationPending: number;
  invocationUnknown: number;
  readSucceeded: number;
  readFailed: number;
  readPending: number;
  readUnknown: number;
  totalActual: null;
};
export type SkillCoverageReason = 'scan_budget' | 'source_limit' | 'line_limit' | 'memory_limit'
  | 'lookup_limit' | 'response_limit' | 'discovery_limit' | 'source_unavailable' | 'source_changed'
  | 'unresolved_attribution' | 'ambiguous_origin' | 'aborted' | 'cold_cache' | 'unknown_timestamp';
export type SkillCoverage = {
  state: 'complete' | 'partial' | 'unsupported' | 'unavailable';
  scannedSources: number;
  discoveredSources: number;
  discoveryComplete: boolean;
  detector: {
    state: 'limited' | 'unsupported';
    capabilities: Array<'native_invocation' | 'structured_read' | 'literal_shell_read'>;
    reasons: Array<'unsupported_provider' | 'unobserved_execution_possible' | 'unsupported_tool_shape'>;
  };
  reasons: SkillCoverageReason[];
  asOf: string | null;
  nextCursor: string | null;
};
export type SessionSkillProjection = {
  observations: SkillObservation[];
  summary: SkillSummary;
  coverage: SkillCoverage;
};
export type ProjectSkillProjection = {
  summary: SkillSummary;
  rows: Array<{ skillKey: string; skillName: string; summary: SkillSummary }>;
  coverage: SkillCoverage;
  eligibleSessions: number;
  scannedSessions: number;
  partialSessions: number;
  unavailableSessions: number;
};
