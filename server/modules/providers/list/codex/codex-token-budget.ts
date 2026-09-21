/** T-1777: native usage only. Published model capacities are not session measurements. */
export type ContextSnapshot = {
  version: 1;
  provider: 'codex' | 'claude';
  sessionId: string | null;
  modelId: string | null;
  usedTokens: number | null;
  windowTokens: number | null;
  usageKind: 'last_request_input' | 'native_reported_context' | 'unknown';
  source: string;
  observedAt: string | null;
  nativeCompactTokens: number | null;
  proposedCompactTokens: number | null;
  newSessionTokens: number | null;
};

/** ADR-161: one native cache observation, independent of occupancy and cost. */
export type CacheSnapshot = {
  version: 1;
  provider: 'codex' | 'claude';
  sessionId: string | null;
  modelId: string | null;
  source: string;
  scope: 'last_request' | 'turn' | 'session';
  observedAt: string | null;
  receivedAt: string;
  eventId: string | null;
  sequence: number | null;
  transport: 'live' | 'history';
  inputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
};

/** Preserve original event metadata; receipt time is never evidence of freshness. */
export function cacheObservationMetadata(event: any, transport: CacheSnapshot['transport']) {
  return {
    observedAt: typeof event?.timestamp === 'string' && Number.isFinite(Date.parse(event.timestamp)) ? event.timestamp : null,
    receivedAt: new Date().toISOString(),
    eventId: nativeContextId(event?.uuid ?? event?.id),
    sequence: nativeTokenCount(event?.sequence), transport,
  };
}

export type CodexTokenBudget = {
  used: number | null;
  total: number | null;
  totalReported: boolean;
  inputTokens: number | null;
  outputTokens: number | null;
  breakdown: { input: number | null; output: number | null };
  cumulativeUsed?: number | null;
  cumulativeInputTokens?: number | null;
  cumulativeOutputTokens?: number | null;
  cumulativeReported?: boolean;
  contextSnapshot?: ContextSnapshot;
  cacheSnapshot?: CacheSnapshot | null;
};

/** Reject coercion, non-finite values, negative counts and unsafe integers. */
export function nativeTokenCount(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/** Keep native identifiers bounded; a missing model must never inherit another model's window. */
export function nativeContextId(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= 256
    && !/[\s\x00-\x1f\x7f]/.test(value) ? value : null;
}

function sumCounts(a: number | null, b: number | null): number | null {
  return a === null || b === null ? null : nativeTokenCount(a + b);
}

function isNativeTokenCountEvent(event: any): boolean {
  return event?.type === 'event_msg' && event?.payload?.type === 'token_count';
}

/** Extract native context occupancy separately from request and cumulative consumption. */
export function extractCodexTokenBudget(event: any, model?: unknown, sessionId?: unknown, transport: CacheSnapshot['transport'] = 'live'): CodexTokenBudget | null {
  const info = event?.info ?? event?.payload?.info ?? event?.usage?.info;
  const last = info?.last_token_usage ?? event?.usage?.last_token_usage;
  const cumulative = info?.total_token_usage ?? event?.usage?.total_token_usage;
  // SDK turn.completed usage aggregates a turn's requests; it is not a context snapshot.
  const turn = event?.type === 'turn.completed' ? event?.usage : null;
  if (!last && !cumulative && !turn) return null;
  const inputTokens = nativeTokenCount(last?.input_tokens);
  const outputTokens = nativeTokenCount(last?.output_tokens);
  const consumption = cumulative ?? turn;
  const cumulativeInputTokens = nativeTokenCount(consumption?.input_tokens);
  const cumulativeOutputTokens = nativeTokenCount(consumption?.output_tokens);
  const nativeTokenCountEvent = isNativeTokenCountEvent(event);
  const window = nativeTokenCount(info?.model_context_window ?? event?.usage?.model_context_window);
  const total = nativeTokenCountEvent && window !== null && window > 0 ? window : null;
  // Codex's persisted token_count event reports the active context as
  // last_token_usage.total_tokens. It is usable only with the positive window
  // attested by that same event; request input and session totals are different
  // measurements and must never stand in for occupancy.
  const nativeContextTokens = total === null ? null : nativeTokenCount(last?.total_tokens);
  const cacheUsage = last ?? cumulative ?? turn;
  const cacheSnapshot: CacheSnapshot = {
    version: 1, provider: 'codex', sessionId: nativeContextId(sessionId), modelId: nativeContextId(model),
    source: turn && !last && !cumulative ? 'codex.turn.completed' : 'codex.token_count',
    scope: last ? 'last_request' : cumulative ? 'session' : 'turn',
    ...cacheObservationMetadata(event, transport),
    inputTokens: nativeTokenCount(cacheUsage?.input_tokens),
    cacheReadTokens: nativeTokenCount(cacheUsage?.cached_input_tokens), cacheWriteTokens: null,
  };
  return {
    cacheSnapshot,
    used: nativeContextTokens, total, totalReported: total !== null, inputTokens, outputTokens,
    breakdown: { input: inputTokens, output: outputTokens },
    cumulativeUsed: nativeTokenCount(consumption?.total_tokens) ?? sumCounts(cumulativeInputTokens, cumulativeOutputTokens),
    cumulativeInputTokens, cumulativeOutputTokens, cumulativeReported: Boolean(cumulative),
    contextSnapshot: {
      version: 1, provider: 'codex', sessionId: nativeContextId(sessionId), modelId: nativeContextId(model),
      usedTokens: nativeContextTokens, windowTokens: total,
      usageKind: nativeContextTokens !== null ? 'native_reported_context' : 'unknown',
      source: turn ? 'codex.turn.completed' : 'codex.token_count',
      observedAt: typeof event?.timestamp === 'string' && Number.isFinite(Date.parse(event.timestamp)) ? event.timestamp : null,
      nativeCompactTokens: null, proposedCompactTokens: null, newSessionTokens: null,
    },
  };
}

/** Never carry a stale window or occupancy across turns, model switches, restoration or compaction. */
export function accumulateCodexCoordinatorUsage(
  previous: CodexTokenBudget | null | undefined,
  turn: CodexTokenBudget,
): CodexTokenBudget {
  if (!previous || turn.cumulativeReported) return turn;
  return {
    ...turn,
    cumulativeUsed: sumCounts(previous.cumulativeUsed ?? null, turn.cumulativeUsed ?? null),
    cumulativeInputTokens: sumCounts(previous.cumulativeInputTokens ?? null, turn.cumulativeInputTokens ?? null),
    cumulativeOutputTokens: sumCounts(previous.cumulativeOutputTokens ?? null, turn.cumulativeOutputTokens ?? null),
    cumulativeReported: false,
  };
}

/** Accept only a native history sample observed during this exact turn and identity. */
export function selectCodexPostTurnUsage(
  candidate: CodexTokenBudget | null | undefined,
  identity: { sessionId: unknown; modelId: unknown; notBefore: unknown },
): CodexTokenBudget | null {
  const snapshot = candidate?.contextSnapshot;
  const sessionId = nativeContextId(identity.sessionId);
  const modelId = nativeContextId(identity.modelId);
  const startedAt = typeof identity.notBefore === 'string'
    ? Date.parse(identity.notBefore)
    : Number.NaN;
  const observedAt = typeof snapshot?.observedAt === 'string'
    ? Date.parse(snapshot.observedAt)
    : Number.NaN;
  if (
    !candidate
    || !sessionId
    || !modelId
    || snapshot?.usageKind !== 'native_reported_context'
    || snapshot.source !== 'codex.token_count'
    || snapshot.sessionId !== sessionId
    || snapshot.modelId !== modelId
    || !Number.isFinite(startedAt)
    || !Number.isFinite(observedAt)
    || observedAt < startedAt
  ) return null;
  return candidate;
}
