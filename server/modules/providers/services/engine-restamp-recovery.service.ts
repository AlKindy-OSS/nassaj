import { engineRestampIntentsDb, getConnection } from '@/modules/database/index.js';

export const ENGINE_RESTAMP_STARTUP_RECOVERY_LIMITS = Object.freeze({
  maxIntentAttempts: 64,
  maxIntentCanonicalBytesRead: 512 * 1024,
  maxModelBytesRead: 24 * 1024 * 1024,
  maxModelBytesWritten: 8 * 1024 * 1024,
  maxPromotions: 1,
  maxWallMs: 5_000,
});

export type EngineRestampStartupRecoverySummary = Readonly<{
  status: 'clear' | 'blocked_degraded';
  scope: 'healthy' | 'affected_sessions_only';
  observedIntentRows: number;
  attemptableIntentRows: number;
  unresolvedIntentRows: number;
  canonicalIntentBytesRead: number;
  modelBytesRead: 0;
  modelBytesWritten: 0;
  promotions: 0;
  databaseChanges: 0 | null;
  elapsedMs: number;
  reasons: readonly string[];
}>;

/**
 * Performs the bounded, read-only E5 startup inspection.
 * Positive rollback intentionally remains unavailable until the governed claim,
 * recovery reservation and batch-owner seams are accepted and connected.
 */
export function inspectEngineRestampStartupRecovery(): EngineRestampStartupRecoverySummary {
  const startedAt = Date.now();
  let scan: ReturnType<typeof engineRestampIntentsDb.scanRecoveryCandidates>;
  let databaseChanges: 0 | null = 0;
  try {
    const db = getConnection();
    const before = (db.prepare('SELECT total_changes() AS changes').get() as { changes: number }).changes;
    scan = engineRestampIntentsDb.scanRecoveryCandidates();
    const after = (db.prepare('SELECT total_changes() AS changes').get() as { changes: number }).changes;
    if (after !== before) throw new Error('ENGINE_RESTAMP_RECOVERY_INSPECTION_MUTATED_DATABASE');
  } catch {
    databaseChanges = null;
    const elapsedMs = Math.max(0, Date.now() - startedAt);
    return Object.freeze({ status: 'blocked_degraded', scope: 'affected_sessions_only',
      observedIntentRows: 0, attemptableIntentRows: 0, unresolvedIntentRows: 0,
      canonicalIntentBytesRead: 0, modelBytesRead: 0, modelBytesWritten: 0,
      promotions: 0, databaseChanges, elapsedMs,
      reasons: Object.freeze(['database_scan_failed']) });
  }
  const elapsedMs = Math.max(0, Date.now() - startedAt);
  const reasons: string[] = [];
  if (scan.overflow) reasons.push('intent_scan_limit_exceeded');
  if (scan.attemptLimitReached) reasons.push('intent_attempt_limit_reached');
  if (scan.byteLimitReached) reasons.push('intent_byte_limit_reached');
  if (scan.malformedRows > 0) reasons.push('intent_malformed');
  if (elapsedMs > ENGINE_RESTAMP_STARTUP_RECOVERY_LIMITS.maxWallMs) reasons.push('wall_time_exceeded');
  if (scan.observedRows > 0) reasons.push('positive_recovery_authority_unavailable');
  const blocked = scan.observedRows > 0 || reasons.length > 0;
  return Object.freeze({ status: blocked ? 'blocked_degraded' : 'clear',
    scope: blocked ? 'affected_sessions_only' : 'healthy',
    observedIntentRows: scan.observedRows, attemptableIntentRows: scan.candidates.length,
    unresolvedIntentRows: scan.observedRows, canonicalIntentBytesRead: scan.canonicalBytesRead,
    modelBytesRead: 0, modelBytesWritten: 0, promotions: 0, elapsedMs,
    databaseChanges,
    reasons: Object.freeze(reasons) });
}
