import crypto from 'node:crypto';

import type Database from 'better-sqlite3';

import { createEngineRestampIntentRepository, getConnection } from '@/modules/database/index.js';
import type { EngineRestampIntent } from '@/modules/database/index.js';

import {
  isEngineRestampStartupRecoveryAttemptCurrent,
  isEngineRestampStartupRecoveryPredecessorIntent,
} from '../../../bootstrap-startup-context.js'; // eslint-disable-line boundaries/no-unknown -- governed claim owner.

/**
 * engine-switch-liveness.service.ts — ADR-099/T-1237.
 *
 * The engine re-stamp route must refuse to move a session that is mid-turn: the
 * environment of a running process cannot be changed, so a switch applied under
 * it would let that turn finish on the OLD vendor while the database claims the
 * new one — the exact drift the pin exists to prevent.
 *
 * The predicate itself lives in `claude-sdk.js`, which is NOT a module and may
 * not be imported from inside one (eslint `boundaries/no-unknown`). So it is
 * INJECTED at the composition root, exactly as the session-activity carrier
 * injects its liveness probes — and for the same reason: the route must mirror
 * the one live registry, never keep a second idea of what is running.
 *
 * FAIL-CLOSED, and in the opposite direction to the activity carrier. That one
 * degrades to "not processing" because an un-wired READ should not throw. This
 * one degrades to "busy", because an un-wired WRITE that assumes the session is
 * idle would corrupt the very state it was asked to protect. A missed injection
 * therefore disables switching — visibly — instead of silently permitting the
 * unsafe case.
 */

/** Answers "is a turn executing (or detached-but-registered) for this session?" */
export type EngineSwitchLivenessProbe = (
  sessionId: string,
) => { busy: boolean; reason: 'live' | 'detached' | null };

let probe: EngineSwitchLivenessProbe | null = null;
export type RestampReservation = Readonly<{ sessionId: string; identity: object }>;
const restampReservations = new Map<string, RestampReservation>();
const MAX_RESTAMP_RESERVATIONS = 1024;
declare const engineRestampRecoveryReservationBrand: unique symbol;
export type EngineRestampRecoveryReservation = Readonly<{
  readonly [engineRestampRecoveryReservationBrand]: true;
}>;
type RecoveryReservationRecord = Readonly<{
  publicReservation: EngineRestampRecoveryReservation;
  sessionId: string;
  operationId: string;
  canonicalSha256: string;
  canonical: string;
  claim: object;
  db: Database.Database;
}>;
const recoveryReservations = new Map<string, RecoveryReservationRecord>();
let recoveryReservationRecords = new WeakMap<object, RecoveryReservationRecord>();
const MAX_RECOVERY_RESERVATIONS = 64;
const sha256 = (value: string): string => crypto.createHash('sha256').update(value, 'utf8').digest('hex');

/**
 * Wires the probe from the app entry. MUST be the same registry the spawn path
 * reads; passing a re-implementation would fork the truth this mirrors.
 */
export function setEngineSwitchLivenessProbe(next: EngineSwitchLivenessProbe | null): void {
  probe = next ?? null;
}

/** Test seam: drops back to the fail-closed default. */
export function resetEngineSwitchLivenessProbe(): void {
  probe = null;
  restampReservations.clear();
  recoveryReservations.clear();
  recoveryReservationRecords = new WeakMap<object, RecoveryReservationRecord>();
}

function deleteRecoveryReservation(record: RecoveryReservationRecord): void {
  if (recoveryReservations.get(record.sessionId) !== record) return;
  recoveryReservations.delete(record.sessionId);
  recoveryReservationRecords.delete(record.publicReservation);
}

function recoveryReservationState(record: RecoveryReservationRecord): 'current' | 'stale' | 'unknown' {
  if (!isEngineRestampStartupRecoveryAttemptCurrent(record.claim)) return 'stale';
  try {
    if (getConnection() !== record.db) return 'stale';
    const current = createEngineRestampIntentRepository(record.db).read(record.sessionId);
    return current?.canonical === record.canonical
      && current.intent.operationId === record.operationId
      && sha256(current.canonical) === record.canonicalSha256 ? 'current' : 'stale';
  } catch {
    return 'unknown';
  }
}

function pruneStaleRecoveryReservations(sessionId?: string): void {
  const records = sessionId === undefined
    ? [...recoveryReservations.values()]
    : [recoveryReservations.get(sessionId)].filter((record): record is RecoveryReservationRecord => record !== undefined);
  for (const record of records) {
    if (recoveryReservationState(record) === 'stale') deleteRecoveryReservation(record);
  }
}

/** Atomically proves no running turn and reserves this boot's session boundary. */
export function reserveEngineRestamp(sessionId: string): RestampReservation | null {
  pruneStaleRecoveryReservations(sessionId);
  if (!sessionId || restampReservations.has(sessionId) || recoveryReservations.has(sessionId)
      || restampReservations.size >= MAX_RESTAMP_RESERVATIONS) return null;
  const state = isEngineSwitchBlocked(sessionId);
  if (state.busy) return null;
  const reservation = Object.freeze({ sessionId, identity: Object.freeze({}) });
  restampReservations.set(sessionId, reservation);
  return reservation;
}

/** Exact-token release prevents an old operation from releasing its replacement. */
export function releaseEngineRestamp(reservation: RestampReservation): boolean {
  if (restampReservations.get(reservation.sessionId) !== reservation) return false;
  restampReservations.delete(reservation.sessionId);
  return true;
}

export function isEngineRestampReserved(sessionId: string): boolean {
  pruneStaleRecoveryReservations(sessionId);
  return restampReservations.has(sessionId) || recoveryReservations.has(sessionId);
}

/** Exact-token check used by the model-store owner capability. */
export function isEngineRestampReservationCurrent(reservation: RestampReservation): boolean {
  return restampReservations.get(reservation.sessionId) === reservation;
}

/** Reserve one exact predecessor intent under the current governed startup recovery attempt. */
export function reserveEngineRestampRecovery(
  claim: object,
  candidate: object,
): EngineRestampRecoveryReservation | null {
  pruneStaleRecoveryReservations();
  if (!isEngineRestampStartupRecoveryAttemptCurrent(claim)
      || recoveryReservations.size >= MAX_RECOVERY_RESERVATIONS) return null;
  const db = getConnection();
  const repository = createEngineRestampIntentRepository(db);
  const stored = repository.validateRecoveryCandidate(candidate);
  if (!stored || restampReservations.has(stored.intent.sessionId)
      || recoveryReservations.has(stored.intent.sessionId)
      || !isEngineRestampStartupRecoveryPredecessorIntent(claim, stored.intent.ownerProcess)) return null;
  const publicReservation = Object.freeze(Object.create(null)) as EngineRestampRecoveryReservation;
  const record = Object.freeze({ publicReservation, sessionId: stored.intent.sessionId,
    operationId: stored.intent.operationId, canonical: stored.canonical,
    canonicalSha256: sha256(stored.canonical), claim, db });
  recoveryReservations.set(stored.intent.sessionId, record);
  recoveryReservationRecords.set(publicReservation, record);
  return publicReservation;
}

/** Recheck the exact claim, tuple and durable intent for a recovery reservation. */
export function isEngineRestampRecoveryReservationCurrent(
  reservation: EngineRestampRecoveryReservation,
): boolean {
  const record = recoveryReservationRecords.get(reservation);
  if (!record || recoveryReservations.get(record.sessionId) !== record) return false;
  const state = recoveryReservationState(record);
  if (state === 'stale') {
    deleteRecoveryReservation(record);
    return false;
  }
  return state === 'current';
}

/** Internal batch gate: exact admitted connection and still-live startup attempt. */
export function isEngineRestampRecoveryClaimCurrent(claim: object, db: Database.Database): boolean {
  try {
    return getConnection() === db && isEngineRestampStartupRecoveryAttemptCurrent(claim);
  } catch {
    return false;
  }
}

/** Exact internal binding check for the governed E5 frozen batch owner. */
export function isEngineRestampRecoveryReservationBound(
  reservation: EngineRestampRecoveryReservation,
  claim: object,
  db: Database.Database,
  intent: EngineRestampIntent,
  canonical: string,
): boolean {
  const record = recoveryReservationRecords.get(reservation);
  if (!record || recoveryReservations.get(record.sessionId) !== record
      || record.claim !== claim || record.db !== db || record.sessionId !== intent.sessionId
      || record.operationId !== intent.operationId || record.canonical !== canonical
      || record.canonicalSha256 !== sha256(canonical)) return false;
  return isEngineRestampRecoveryReservationCurrent(reservation);
}

/** Exact-token release prevents one recovery tuple from releasing another. */
export function releaseEngineRestampRecovery(reservation: EngineRestampRecoveryReservation): boolean {
  const record = recoveryReservationRecords.get(reservation);
  if (!record || recoveryReservations.get(record.sessionId) !== record) return false;
  deleteRecoveryReservation(record);
  return true;
}

/**
 * @returns `{busy:true, reason:'unwired'}` when no probe was injected — see the
 *   fail-closed note above.
 */
export function isEngineSwitchBlocked(
  sessionId: string,
): { busy: boolean; reason: string | null } {
  if (!probe) return { busy: true, reason: 'unwired' };
  try {
    return probe(sessionId);
  } catch {
    // A throwing probe is an unknown state, and unknown means unsafe here.
    return { busy: true, reason: 'probe-error' };
  }
}
