import { getConnection } from '../connection.js';

import { recordStrictAuditOnConnection } from './audit-log.js';
import {
  assertEngineRestampAuthorityOnConnection,
  type EngineRestampAuthorityCapture,
} from './engine-restamp-authority.js';
import {
  canonicalizeEngineRestampIntent,
  createEngineRestampIntentRepository,
  type EngineRestampIntent,
} from './engine-restamp-intent.db.js';

const fail = (code: string): never => { throw new Error(code); };
export const UNKNOWN_ENGINE_RESTAMP_ROLLBACK_REASON = 'ENGINE_RESTAMP_FAILURE_UNKNOWN' as const;
const SAFE_ROLLBACK_REASONS = new Set([
  'ENGINE_RESTAMP_AUTHORITY_STALE', 'ENGINE_RESTAMP_CREDENTIAL_STALE',
  'ENGINE_RESTAMP_DEVICE_STALE', 'ENGINE_RESTAMP_INTENT_CAS_MISMATCH',
  'ENGINE_RESTAMP_INTENT_CONTEXT_MISMATCH', 'ENGINE_RESTAMP_INTENT_PHASE_STALE',
  'ENGINE_RESTAMP_INTENT_STALE', 'ENGINE_RESTAMP_PARTICIPANT_STALE',
  'ENGINE_RESTAMP_PRINCIPAL_STALE', 'ENGINE_RESTAMP_PROJECT_BINDING_STALE',
  'ENGINE_RESTAMP_PROJECT_FENCE_STALE', 'ENGINE_RESTAMP_SESSION_PIN_STALE',
  'ENGINE_RESTAMP_SYNCHRONOUS_SETTLEMENT_REQUIRED', 'ENGINE_RESTAMP_TARGET_READBACK_MISMATCH',
]);
const normalizeRollbackReason = (reason: unknown): string =>
  typeof reason === 'string' && SAFE_ROLLBACK_REASONS.has(reason)
    ? reason
    : UNKNOWN_ENGINE_RESTAMP_ROLLBACK_REASON;

/** Atomically commits the target pin, strict audit and exact intent deletion. */
export function commitEngineRestampTarget(
  capture: EngineRestampAuthorityCapture,
  intent: EngineRestampIntent,
  canonical: string,
): undefined {
  const db = getConnection();
  db.transaction(() => {
    const repository = createEngineRestampIntentRepository(db);
    const stored = repository.read(intent.sessionId) ?? fail('ENGINE_RESTAMP_INTENT_STALE');
    if (stored.canonical !== canonical || canonicalizeEngineRestampIntent(intent) !== canonical) {
      fail('ENGINE_RESTAMP_INTENT_STALE');
    }
    const exactIntent = stored.intent;
    if (exactIntent.phase !== 'target_observed' || exactIntent.revision !== 2) {
      fail('ENGINE_RESTAMP_INTENT_PHASE_STALE');
    }
    assertEngineRestampAuthorityOnConnection(db, capture, exactIntent);
    const updated = db.prepare(`UPDATE sessions SET engine_provider = ?, engine_provider_source = ?
      WHERE session_id = ? AND engine_provider IS ? AND engine_provider_source IS ?`).run(
      exactIntent.toPin.engine, exactIntent.toPin.source, exactIntent.sessionId,
      exactIntent.fromPin.engine, exactIntent.fromPin.source);
    if (updated.changes !== 1) fail('ENGINE_RESTAMP_SESSION_PIN_STALE');
    recordStrictAuditOnConnection(db, 'engine_restamped', { userId: exactIntent.actor.userId, metadata: {
      operationId: exactIntent.operationId, sessionId: exactIntent.sessionId,
      fromEngine: exactIntent.fromPin.engine, toEngine: exactIntent.toPin.engine,
      model: exactIntent.toModel.model, turnsExported: exactIntent.turnsExported,
      acknowledgedExport: exactIntent.acknowledgedExport, outcome: 'restamped',
    } });
    repository.deleteExact(exactIntent.sessionId, canonical);
  }).immediate();
  return undefined;
}

/** Atomically records an exact same-process rollback and removes its durable blocker. */
export function settleEngineRestampRollback(
  intent: EngineRestampIntent,
  canonical: string,
  reason: string,
): undefined {
  const db = getConnection();
  db.transaction(() => {
    const repository = createEngineRestampIntentRepository(db);
    const stored = repository.read(intent.sessionId) ?? fail('ENGINE_RESTAMP_INTENT_STALE');
    if (stored.canonical !== canonical || canonicalizeEngineRestampIntent(intent) !== canonical) {
      fail('ENGINE_RESTAMP_INTENT_STALE');
    }
    const exactIntent = stored.intent;
    const pin = db.prepare(`SELECT 1 FROM sessions WHERE session_id = ?
      AND engine_provider IS ? AND engine_provider_source IS ?`).get(
      exactIntent.sessionId, exactIntent.fromPin.engine, exactIntent.fromPin.source);
    if (!pin) fail('ENGINE_RESTAMP_SESSION_PIN_STALE');
    recordStrictAuditOnConnection(db, 'engine_pin_decision', { userId: exactIntent.actor.userId, metadata: {
      operationId: exactIntent.operationId, sessionId: exactIntent.sessionId,
      decision: 'restamp_rolled_back', reason: normalizeRollbackReason(reason),
    } });
    repository.deleteExact(exactIntent.sessionId, canonical);
  }).immediate();
  return undefined;
}

/** Produces the only concrete synchronous DB settlement callbacks accepted by the coordinator. */
export function createEngineRestampDatabaseSettlement(capture: EngineRestampAuthorityCapture): Readonly<{
  commitTarget: (state: Readonly<{ intent: EngineRestampIntent; canonical: string }>) => undefined;
  settleRollback: (state: Readonly<{ intent: EngineRestampIntent; canonical: string; reason: string }>) => undefined;
}> {
  return Object.freeze({
    commitTarget: state => commitEngineRestampTarget(capture, state.intent, state.canonical),
    settleRollback: state => settleEngineRestampRollback(state.intent, state.canonical, state.reason),
  });
}
