/** Provider-neutral response-duration plumbing (ADR-126, B-822).
 *
 * The measurement itself is server-side wall clock and therefore identical for
 * every provider: stamp `startedAt` on the first provider-attested sign of model
 * work, stamp `completedAt` on the terminal frame, and persist the pair only
 * once a final assistant message really existed.  Only the JOIN KEY is
 * provider-specific — Claude has a transcript uuid, Codex has a rollout
 * `payload.id`, and the CLI runners have only the live normalized id.
 *
 * A runner that supplies a durable id gets both the per-message stamp on history
 * reload and the conversation total.  A runner that supplies its live id gets a
 * correct total only: `applyResponseTurnMetrics` is a strict id lookup, so an
 * unjoinable row is silently ignored on history rather than mis-attributed.
 */
import { randomUUID } from 'node:crypto';

import { responseTurnMetricsDb } from '@/modules/database/index.js';

/** Fields spread onto a terminal `complete` frame; empty when nothing was persisted. */
export type DurableTurnTiming = {
  responseTurnMetric?: {
    durationMs: number;
    startedAt: string;
    completedAt: string;
  };
  responseTurnDurationTotalMs?: number | null;
};

export type SettleTurnTimingInput = {
  sessionId: string | null | undefined;
  /** Durable assistant-message id when the provider has one, live id otherwise. */
  assistantMessageId: string | null | undefined;
  /** First provider-attested model activity; null when the turn never started. */
  startedAt: string | null | undefined;
  completedAt: string;
  /** Provider-owned turn identity; a fresh uuid when the provider has none. */
  turnId?: string;
};

/**
 * Persists one completed response and returns the fields the runner spreads onto
 * its `complete` frame.  Absence stays absence: any missing precondition, and any
 * rejected write, yields `{}` so the client shows "unknown" rather than a guess.
 */
export function settleTurnTiming(input: SettleTurnTimingInput): DurableTurnTiming {
  const { sessionId, assistantMessageId, startedAt } = input;
  if (!sessionId || !assistantMessageId || !startedAt) return {};

  const saved = responseTurnMetricsDb.recordCompleted({
    turnId: input.turnId || randomUUID(),
    sessionId,
    assistantMessageId,
    startedAt,
    completedAt: input.completedAt,
  });
  if (!saved.metric) return {};

  return {
    responseTurnMetric: {
      durationMs: saved.metric.durationMs,
      startedAt: saved.metric.startedAt,
      completedAt: saved.metric.completedAt,
    },
    responseTurnDurationTotalMs: responseTurnMetricsDb.sumSessionDuration(sessionId),
  };
}

/**
 * A normalized message counts as the model's first sign of work when it is a
 * thinking block, a tool call, a streamed delta, or assistant-authored text.
 * Ordering matters: thinking precedes text within a turn, so treating thinking
 * as activity is what lets `startedAt` land on the reasoning start rather than
 * on the first visible text — otherwise a model that thinks for seconds before
 * speaking (Opus) has its whole reasoning span excluded from the measured turn.
 * User echoes and tool *results* are not model work: the latter can arrive long
 * after the model began, so they must never open the timing window.
 */
export function isModelActivity(msg: { kind?: unknown; role?: unknown }): boolean {
  return msg.kind === 'thinking'
    || msg.kind === 'tool_use'
    || msg.kind === 'stream_delta'
    || (msg.kind === 'text' && msg.role === 'assistant');
}

/**
 * Tracks the first sign of model work for one run.
 *
 * Runners see model activity in many shapes (SDK item events, assistant deltas,
 * tool frames); they all funnel into `markModelActivity`, which is idempotent so
 * it can be called on every event without a guard at the call site.
 */
export function createTurnTimer(): {
  markModelActivity: () => void;
  startedAt: () => string | null;
} {
  let startedAt: string | null = null;
  return {
    markModelActivity: () => {
      if (!startedAt) startedAt = new Date().toISOString();
    },
    startedAt: () => startedAt,
  };
}
