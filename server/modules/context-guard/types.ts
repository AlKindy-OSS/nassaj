/**
 * Shared shapes of the model-switch context guard (T-2087, ADR-223). The guard
 * itself is provider-neutral; each adapter knows one provider's usage record.
 */

import type { FitVerdict } from './context-fit.js';

/** The persisted facts of one session the guard may rely on (never client data). */
export type GuardSession = {
  sessionId: string;
  provider: string;
  jsonlPath: string | null;
  /** The server-side engine pin (ADR-088); a non-official engine is not measured. */
  engineProvider: string | null;
};

/** One reading of a session's last request: its fill and the model that served it. */
export type Observation = {
  usedTokens: number | null;
  modelId: string | null;
  /** Windows the provider itself reported, per model, inside the same record. */
  windowsByModel?: Readonly<Record<string, number>>;
};

export type ModelWindow = { windowTokens: number | null; reserveTokens: number | null };

export type ContextFitAdapter = {
  /** True when the provider runs `/compact` on the previous (larger) model, not the pin. */
  compactsOnPreviousModel?: boolean;
  /** Comparable id for a pinned value (alias → full id), or null when it cannot be named. */
  normalizeModel(model: string, session: GuardSession): Promise<string | null>;
  /** Cheap change marker of the usage record (mtime, last row time); null → nothing to read. */
  observationKey(session: GuardSession): Promise<string | null>;
  /** Reads the last fill; an absent or compacted record yields `usedTokens: null`. */
  observe(session: GuardSession): Promise<Observation>;
  /** Window and reply reserve of a normalized model id. */
  windowFor(modelId: string, session: GuardSession, observation: Observation): Promise<ModelWindow>;
};

/** The route contract and the input to a refusal. */
export type ContextFitReport = {
  verdict: FitVerdict;
  used: number | null;
  budget: number | null;
  window: number | null;
  model: string;
  previousModel: string | null;
};

export const CONTEXT_GUARD_REFUSAL_CODE = 'context_guard_window_too_small';

/** Payload of a refused turn; the client builds the user-facing copy from it. */
export type ContextGuardRefusal = {
  code: typeof CONTEXT_GUARD_REFUSAL_CODE;
  payload: {
    used: number; budget: number; model: string; previousModel: string | null;
    /** Whether `/compact` would run on the previous model (only Claude reroutes it). */
    canCompactOnPrevious: boolean;
  };
};

/** What the dispatcher needs from the guard. */
export type ContextGuardPort = {
  checkTurn(input: { provider: string; sessionId: string | null; command: string }): Promise<ContextGuardRefusal | null>;
};
