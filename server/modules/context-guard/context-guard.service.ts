/**
 * Model-switch context guard (T-2087, ADR-223): refuses a turn, before it
 * starts, when the session's pinned model is smaller than the conversation.
 *
 * Measured only when the pinned model differs from the last model this
 * process admitted for the session (or, with no such memory — e.g. after a
 * restart — from the model observed in the session's own record). No pin, the
 * same model, `/compact`, an unmeasurable record or any failure → the turn
 * passes. Readings are cached per session for {@link CACHE_TTL_MS}, keyed by
 * the adapter's change marker, and dropped on compaction.
 */

import { evaluateFit } from './context-fit.js';
import {
  CONTEXT_GUARD_REFUSAL_CODE,
  type ContextFitAdapter,
  type ContextFitReport,
  type ContextGuardPort,
  type ContextGuardRefusal,
  type GuardSession,
  type Observation,
} from './types.js';

export const CACHE_TTL_MS = 30_000;
const COMPACTION_COMMAND = /^\/compact(\s|$)/;
const MAX_REMEMBERED_SESSIONS = 2_000;

/** True for `/compact` and `/compact <instructions>` at the start of the trimmed text. */
export function isCompactionCommand(command: unknown): boolean {
  return typeof command === 'string' && COMPACTION_COMMAND.test(command.trim());
}

export type ContextGuardDeps = {
  adapters: Readonly<Partial<Record<string, ContextFitAdapter>>>;
  /** The session's explicit model pin, or null when none is stored. */
  readPin: (provider: string, sessionId: string) => Promise<string | null>;
  readSession: (sessionId: string) => GuardSession | null;
  now?: () => number;
  ttlMs?: number;
};

export type ContextGuard = ContextGuardPort & {
  measure(input: { sessionId: string; model: string }): Promise<ContextFitReport>;
  lastAdmittedModel(sessionId: string): string | null;
};

type CachedObservation = { key: string; at: number; observation: Observation };

/** Per-instance memory: admissions and cached readings, both bounded. */
type GuardState = {
  admitted: Map<string, string>;
  cache: Map<string, CachedObservation>;
  now: () => number;
  ttlMs: number;
};

const UNKNOWN_OBSERVATION: Observation = { usedTokens: null, modelId: null };

/** Bounded insertion-ordered map: the oldest entry goes first. */
function remember<T>(map: Map<string, T>, key: string, value: T): void {
  map.delete(key);
  map.set(key, value);
  if (map.size > MAX_REMEMBERED_SESSIONS) map.delete(map.keys().next().value as string);
}

/** The session's reading, from the cache while the record's marker and the TTL hold. */
async function observe(state: GuardState, adapter: ContextFitAdapter, session: GuardSession): Promise<Observation> {
  const key = await adapter.observationKey(session);
  if (key === null) return UNKNOWN_OBSERVATION;
  const hit = state.cache.get(session.sessionId);
  if (hit && hit.key === key && state.now() - hit.at < state.ttlMs) return hit.observation;
  const observation = await adapter.observe(session);
  remember(state.cache, session.sessionId, { key, at: state.now(), observation });
  return observation;
}

/**
 * Fit of `model` against a reading. `normalized` is the adapter's id for the
 * model when the caller already has it (undefined → normalized here, once).
 */
async function report(
  state: GuardState, adapter: ContextFitAdapter, session: GuardSession,
  input: { model: string; observation: Observation; normalized?: string | null },
): Promise<ContextFitReport> {
  const { model, observation } = input;
  const previousModel = state.admitted.get(session.sessionId) ?? observation.modelId;
  const unknown: ContextFitReport = {
    verdict: 'unknown', used: observation.usedTokens, budget: null, window: null, model, previousModel,
  };
  if (observation.usedTokens === null) return unknown;
  const normalized = input.normalized !== undefined ? input.normalized : await adapter.normalizeModel(model, session);
  if (normalized === null) return unknown;
  const { windowTokens, reserveTokens } = await adapter.windowFor(normalized, session, observation);
  return { ...evaluateFit({ usedTokens: observation.usedTokens, windowTokens, reserveTokens }), model, previousModel };
}

/** The refusal for one turn on a pinned session, or null (and the pin is then admitted). */
async function decide(
  state: GuardState, deps: ContextGuardDeps, provider: string, sessionId: string,
): Promise<ContextGuardRefusal | null> {
  const adapter = deps.adapters[provider];
  if (!adapter) return null;
  const pin = (await deps.readPin(provider, sessionId))?.trim();
  if (!pin) return null;
  const last = state.admitted.get(sessionId);
  if (last === pin) return null;
  const session = deps.readSession(sessionId);
  if (!session || session.provider !== provider) return null;
  const observation = await observe(state, adapter, session);
  const normalized = await adapter.normalizeModel(pin, session);
  const unchanged = last === undefined && normalized !== null && normalized === observation.modelId;
  const fit = unchanged ? null : await report(state, adapter, session, { model: pin, observation, normalized });
  if (fit?.verdict === 'too_small' && fit.used !== null && fit.budget !== null) {
    return {
      code: CONTEXT_GUARD_REFUSAL_CODE,
      payload: {
        used: fit.used, budget: fit.budget, model: pin, previousModel: fit.previousModel,
        canCompactOnPrevious: adapter.compactsOnPreviousModel === true,
      },
    };
  }
  // Admission, not completion: the check passed for this pin, so the next
  // turn on the same pin is not measured again.
  remember(state.admitted, sessionId, pin);
  return null;
}

/** Builds a guard over the given adapters; state (admissions, cache) lives in the instance. */
export function createContextGuard(deps: ContextGuardDeps): ContextGuard {
  const state: GuardState = {
    admitted: new Map(), cache: new Map(), now: deps.now ?? Date.now, ttlMs: deps.ttlMs ?? CACHE_TTL_MS,
  };
  return {
    lastAdmittedModel: (sessionId) => state.admitted.get(sessionId) ?? null,
    async measure({ sessionId, model }) {
      const session = deps.readSession(sessionId);
      const adapter = session ? deps.adapters[session.provider] : undefined;
      if (!session || !adapter) {
        return {
          verdict: 'unknown', used: null, budget: null, window: null,
          model, previousModel: state.admitted.get(sessionId) ?? null,
        };
      }
      return report(state, adapter, session, { model, observation: await observe(state, adapter, session) });
    },
    async checkTurn({ provider, sessionId, command }) {
      if (!sessionId) return null;
      if (isCompactionCommand(command)) {
        state.cache.delete(sessionId);
        return null;
      }
      return decide(state, deps, provider, sessionId);
    },
  };
}
