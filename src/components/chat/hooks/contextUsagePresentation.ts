/** Validated display values; transcript input is surfaced as a ring estimate when no live
 *  observation is available, but is never presented as current native-context occupancy. */
export function contextUsagePresentation(usage: Record<string, unknown> | null, provider: string, sessionId: string | null, modelId: string | null) {
  const candidate = usage?.contextSnapshot;
  const snapshot = candidate && typeof candidate === 'object' ? candidate as Record<string, unknown> : null;
  const identityValid = snapshot?.version === 1 && snapshot.provider === provider
    && Boolean(sessionId && modelId) && snapshot.sessionId === sessionId && snapshot.modelId === modelId
    && typeof snapshot.source === 'string' && snapshot.source.length > 0;
  const valid = identityValid
    && typeof snapshot?.observedAt === 'string' && Number.isFinite(Date.parse(snapshot?.observedAt as string));
  const current = valid && snapshot?.usageKind === 'native_reported_context';
  // A transcript snapshot (observedAt absent) whose usageKind is last_request_input carries
  // the last request's input tokens — the best available context-size estimate for past sessions.
  const transcriptEstimate = identityValid && !valid && snapshot?.usageKind === 'last_request_input';
  const used = current || transcriptEstimate ? finiteCount(snapshot?.usedTokens) : null;
  const window = valid || transcriptEstimate ? positiveCount(snapshot?.windowTokens) : null;
  const native = valid ? positiveCount(snapshot?.nativeCompactTokens) : null;
  const suppliedProposed = valid ? positiveCount(snapshot?.proposedCompactTokens) : null;
  const proposed = provider === 'claude' && valid ? 150_000
    : native !== null && suppliedProposed === Math.floor(native * 0.6) ? suppliedProposed : null;
  return {
    used, window, native, proposed,
    lastInput: valid && snapshot?.usageKind === 'last_request_input' ? finiteCount(snapshot?.usedTokens) : null,
    cumulative: finiteCount(usage?.cumulativeUsed),
    newSession: provider === 'claude' && valid ? 250_000 : null,
    source: valid ? snapshot?.source as string : null,
  };
}

function finiteCount(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function positiveCount(value: unknown): number | null {
  const count = finiteCount(value);
  return count !== null && count > 0 ? count : null;
}

/** Ignore reordered native events for the same identity; null explicitly clears a session. */
function newestContextOnly(current: Record<string, unknown> | null, incoming: Record<string, unknown> | null, origin: 'event' | 'hydration' = 'event') {
  if (!current || !incoming) return incoming;
  const a = current.contextSnapshot as Record<string, unknown> | undefined;
  const b = incoming.contextSnapshot as Record<string, unknown> | undefined;
  if (!a || !b || a.sessionId !== b.sessionId || a.provider !== b.provider) return incoming;
  // A delayed history request is not evidence that a live measurement expired.
  if (origin === 'hydration' && (a.usageKind === 'native_reported_context' || a.usageKind === 'unknown')
    && typeof a.observedAt === 'string' && Number.isFinite(Date.parse(a.observedAt))) return current;
  const previousTime = typeof a.observedAt === 'string' ? Date.parse(a.observedAt) : NaN;
  const incomingTime = typeof b.observedAt === 'string' ? Date.parse(b.observedAt) : NaN;
  return Number.isFinite(previousTime) && Number.isFinite(incomingTime) && incomingTime < previousTime ? current : incoming;
}

/** Validate one inclusive cache observation without merging counters or inventing time. */
export function cacheUsagePresentation(usage: Record<string, unknown> | null, provider: string, sessionId: string | null, modelId: string | null) {
  const snapshot = usage?.cacheSnapshot as Record<string, unknown> | null | undefined;
  const valid = snapshot?.version === 1 && Boolean(sessionId && modelId)
    && snapshot.provider === provider && snapshot.sessionId === sessionId && snapshot.modelId === modelId
    && typeof snapshot.source === 'string' && snapshot.source.trim().length > 0
    && ['last_request', 'turn', 'session'].includes(String(snapshot.scope));
  const input = valid ? finiteCount(snapshot?.inputTokens) : null;
  const read = valid ? finiteCount(snapshot?.cacheReadTokens) : null;
  const ratio = input !== null && input > 0 && read !== null && read <= input ? read / input : null;
  const observedAt = valid && typeof snapshot?.observedAt === 'string' && Number.isFinite(Date.parse(snapshot.observedAt)) ? snapshot.observedAt : null;
  return { input, read, ratio, observedAt, provider: valid ? provider : null, scope: valid ? String(snapshot?.scope) : null,
    source: valid ? String(snapshot?.source) : null, historical: valid && snapshot?.transport === 'history',
    state: ratio !== null ? 'valid' : input === 0 && read === 0 ? 'empty' : 'unknown' };
}

/** Preserve independent cache observations across context-only and late history updates. */
export function newestContextUsage(current: Record<string, unknown> | null, incoming: Record<string, unknown> | null, origin: 'event' | 'hydration' = 'event') {
  const context = newestContextOnly(current, incoming, origin);
  if (!current || !incoming || !context) return context;
  const previous = current.cacheSnapshot as Record<string, unknown> | null | undefined;
  const next = incoming.cacheSnapshot as Record<string, unknown> | null | undefined;
  const previousIdentity = previous ?? current.contextSnapshot as Record<string, unknown> | undefined;
  const nextIdentity = next ?? incoming.contextSnapshot as Record<string, unknown> | undefined;
  if (!previousIdentity || !nextIdentity || ['provider', 'sessionId', 'modelId'].some(key => previousIdentity[key] !== nextIdentity[key])) return context;
  let cache = next;
  if (origin === 'hydration' && (previous?.transport === 'live' || current.cacheSnapshot === null)) cache = current.cacheSnapshot as typeof next;
  else if (!Object.prototype.hasOwnProperty.call(incoming, 'cacheSnapshot')) cache = previous;
  else if (previous?.transport === 'live' && next?.transport === 'history') cache = previous;
  else if (previous && next && previous.source === next.source && previous.scope === next.scope) {
    const a = finiteCount(previous.sequence), b = finiteCount(next.sequence);
    if (a !== null && b !== null) cache = b < a ? previous : next;
    else if (typeof previous.observedAt === 'string' && typeof next.observedAt === 'string'
      && Date.parse(next.observedAt) < Date.parse(previous.observedAt)) cache = previous;
  }
  if (context.cacheSnapshot === cache) return context;
  return { ...context, cacheSnapshot: cache };
}
