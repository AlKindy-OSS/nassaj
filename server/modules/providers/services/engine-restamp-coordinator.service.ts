import type { EngineRestampIntent } from '@/modules/database/index.js';

import {
  type EngineRestampModelStoreBoundary,
  type EngineRestampModelStoreEntry,
  type EngineRestampStoreOwner,
} from './engine-restamp-model-store.service.js';
import type { RestampReservation } from './engine-switch-liveness.service.js';

type Pin = Readonly<{ engine: string | null; source: string | null }>;
type Model = Readonly<{ changed: boolean; model: string | null }>;

export type EngineRestampCoordinatorInput = Readonly<{
  sessionId: string; provider: 'claude'; targetEngine: string; targetModel: string;
  acknowledgedExport: boolean;
}>;

export type EngineRestampCoordinatorPorts = Readonly<{
  withBoundary: <T>(sessionId: string, operation: (boundary: EngineRestampModelStoreBoundary) => Promise<T>) => Promise<T>;
  readPin: (sessionId: string) => Pin | null;
  reserve: (sessionId: string) => RestampReservation | null;
  release: (reservation: RestampReservation) => boolean;
  countAssistantTurns: (sessionId: string) => number;
  buildIntent: (state: Readonly<{ fromPin: Pin; fromModel: Model; turnsExported: number; acknowledgedExport: boolean }>) => EngineRestampIntent;
  prepareIntent: (intent: EngineRestampIntent) => string;
  advanceIntent: (sessionId: string, expectedCanonical: string, next: EngineRestampIntent) => string;
  commitTarget: (state: Readonly<{ intent: EngineRestampIntent; canonical: string }>) => undefined;
  settleRollback: (state: Readonly<{ intent: EngineRestampIntent; canonical: string; reason: string }>) => undefined;
  nowIso: () => string;
}>;

export type EngineRestampCoordinatorResult = Readonly<{
  operationId: string; turnsExported: number; fromPin: Pin; toPin: Pin;
}>;

export class EngineRestampCoordinationError extends Error {
  readonly code: 'ENGINE_RESTAMP_RECONCILIATION_REQUIRED' | 'ENGINE_RESTAMP_POST_COMMIT_RELEASE_FAILED';
  readonly errors: readonly unknown[];
  readonly notStarted: boolean;
  readonly retryable = false;
  constructor(
    readonly operationId: string | null,
    primary: unknown,
    settlementErrors: unknown[],
    readonly effectState: 'not_started' | 'settled' | 'outcome_unknown' | 'committed',
  ) {
    const code = effectState === 'committed'
      ? 'ENGINE_RESTAMP_POST_COMMIT_RELEASE_FAILED'
      : 'ENGINE_RESTAMP_RECONCILIATION_REQUIRED';
    super(code, { cause: primary });
    this.name = 'EngineRestampCoordinationError';
    this.code = code;
    this.notStarted = effectState === 'not_started';
    this.errors = Object.freeze([primary, ...settlementErrors]);
  }
}

const samePin = (left: Pin | null, right: Pin): boolean =>
  left !== null && left.engine === right.engine && left.source === right.source;
const modelOf = (entry: EngineRestampModelStoreEntry | undefined): Model => ({
  changed: entry?.changed === true,
  model: entry?.changed === true ? entry.model : null,
});
const sameModel = (left: Model, right: Model): boolean =>
  left.changed === right.changed && left.model === right.model;
const requireSynchronousVoid = (value: unknown): void => {
  if (value !== undefined) throw new Error('ENGINE_RESTAMP_SYNCHRONOUS_SETTLEMENT_REQUIRED');
};
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
const classifyRollbackReason = (error: unknown): string => {
  const candidate = error && typeof error === 'object' && 'code' in error
    && typeof (error as { code?: unknown }).code === 'string'
    ? (error as { code: string }).code
    : error instanceof Error ? error.message : undefined;
  return candidate && SAFE_ROLLBACK_REASONS.has(candidate)
    ? candidate
    : UNKNOWN_ENGINE_RESTAMP_ROLLBACK_REASON;
};
function validateIntent(
  input: EngineRestampCoordinatorInput,
  intent: EngineRestampIntent,
  fromPin: Pin,
  fromModel: Model,
  turnsExported: number,
): void {
  if (intent.sessionId !== input.sessionId || !samePin(intent.fromPin, fromPin)
      || intent.toPin.engine !== input.targetEngine || intent.toPin.source !== 'user_switch'
      || !sameModel(intent.fromModel, fromModel) || intent.toModel.changed !== true
      || intent.toModel.model !== input.targetModel || intent.turnsExported !== turnsExported
      || intent.acknowledgedExport !== input.acknowledgedExport
      || intent.phase !== 'prepared' || intent.revision !== 1) {
    throw new Error('ENGINE_RESTAMP_INTENT_CONTEXT_MISMATCH');
  }
}

function targetEntry(input: EngineRestampCoordinatorInput, nowIso: string): EngineRestampModelStoreEntry {
  return Object.freeze({ provider: input.provider, sessionId: input.sessionId, supported: true,
    changed: true, model: input.targetModel, updatedAt: nowIso });
}

/**
 * Runs the reviewed file-first restamp state machine behind injected synchronous DB seams.
 * This core is intentionally not route-wired until the C3 inventory and startup gate pass.
 */
export async function coordinateEngineRestamp(
  input: EngineRestampCoordinatorInput,
  ports: EngineRestampCoordinatorPorts,
): Promise<EngineRestampCoordinatorResult> {
  return ports.withBoundary(input.sessionId, async boundary => {
    const initialStore = boundary.readOrdinary();
    const key = `${input.provider}:${input.sessionId}`;
    const originalEntry = initialStore.document.entries[key];
    const fromModel = modelOf(originalEntry);
    const fromPin = ports.readPin(input.sessionId);
    if (!fromPin) throw new Error('ENGINE_RESTAMP_SESSION_NOT_FOUND');
    const reservation = ports.reserve(input.sessionId);
    if (!reservation) throw new Error('ENGINE_RESTAMP_SESSION_BUSY');
    if (reservation.sessionId !== input.sessionId) {
      throw new Error('ENGINE_RESTAMP_RESERVATION_SESSION_MISMATCH');
    }

    let current: { intent: EngineRestampIntent; canonical: string } | undefined;
    let owner: EngineRestampStoreOwner | undefined;
    let primary: unknown;
    const settlementErrors: unknown[] = [];
    let effectState: EngineRestampCoordinationError['effectState'] = 'not_started';
    let result: EngineRestampCoordinatorResult | undefined;
    let releaseFailed = false;
    try {
      const turnsExported = ports.countAssistantTurns(input.sessionId);
      if (!Number.isSafeInteger(turnsExported) || turnsExported < 0) {
        throw new Error('ENGINE_RESTAMP_TURN_COUNT_INVALID');
      }
      if (turnsExported > 0 && input.acknowledgedExport !== true) {
        throw new Error('ENGINE_EXPORT_NOT_ACKNOWLEDGED');
      }
      const intent = ports.buildIntent({ fromPin, fromModel, turnsExported,
        acknowledgedExport: input.acknowledgedExport });
      validateIntent(input, intent, fromPin, fromModel, turnsExported);
      current = { intent, canonical: ports.prepareIntent(intent) };
      owner = boundary.mintOwner(intent, current.canonical, reservation);

      effectState = 'outcome_unknown';
      boundary.writeOwned(owner, { provider: input.provider, sessionId: input.sessionId,
        entry: targetEntry(input, ports.nowIso()) }, initialStore.digest);
      const targetSnapshot = boundary.readOwned(owner);
      if (!sameModel(modelOf(targetSnapshot.document.entries[key]), intent.toModel)) {
        throw new Error('ENGINE_RESTAMP_TARGET_READBACK_MISMATCH');
      }
      const advanced = Object.freeze({ ...intent, phase: 'target_observed' as const,
        revision: intent.revision + 1 });
      current = { intent: advanced,
        canonical: ports.advanceIntent(input.sessionId, current.canonical, advanced) };
      owner = boundary.mintOwner(advanced, current.canonical, reservation);
      requireSynchronousVoid(ports.commitTarget(current));
      effectState = 'committed';
      result = { operationId: advanced.operationId, turnsExported, fromPin,
        toPin: { engine: advanced.toPin.engine, source: advanced.toPin.source } };
    } catch (error) {
      primary = error;
      if (current) {
        try {
          if (!owner) owner = boundary.mintOwner(current.intent, current.canonical, reservation);
          const observedPin = ports.readPin(input.sessionId);
          if (!samePin(observedPin, current.intent.fromPin)) {
            throw new Error('ENGINE_RESTAMP_COMPENSATION_PIN_MISMATCH');
          }
          const observed = boundary.readOwned(owner);
          const observedModel = modelOf(observed.document.entries[key]);
          if (sameModel(observedModel, current.intent.toModel)) {
            boundary.writeOwned(owner, { provider: input.provider, sessionId: input.sessionId,
              entry: originalEntry ?? null }, observed.digest);
            const restored = boundary.readOwned(owner);
            if (!sameModel(modelOf(restored.document.entries[key]), current.intent.fromModel)) {
              throw new Error('ENGINE_RESTAMP_COMPENSATION_READBACK_MISMATCH');
            }
          } else if (!sameModel(observedModel, current.intent.fromModel)) {
            throw new Error('ENGINE_RESTAMP_COMPENSATION_MODEL_MISMATCH');
          }
          requireSynchronousVoid(ports.settleRollback({
            ...current,
            reason: classifyRollbackReason(error),
          }));
          effectState = effectState === 'outcome_unknown' ? 'settled' : 'not_started';
        } catch (settlementError) { settlementErrors.push(settlementError); }
      }
    }
    try {
      if (!ports.release(reservation)) {
        releaseFailed = true;
        settlementErrors.push(new Error('ENGINE_RESTAMP_RESERVATION_RELEASE_MISMATCH'));
      }
    } catch (error) { releaseFailed = true; settlementErrors.push(error); }
    if (primary !== undefined) {
      if (settlementErrors.length > 0) {
        throw new EngineRestampCoordinationError(current?.intent.operationId ?? null,
          primary, settlementErrors, effectState);
      }
      throw primary;
    }
    if (releaseFailed) {
      const releasePrimary = settlementErrors.shift();
      throw new EngineRestampCoordinationError(current?.intent.operationId ?? null,
        releasePrimary, settlementErrors, effectState);
    }
    return result!;
  });
}
