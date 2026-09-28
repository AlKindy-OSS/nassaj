/**
 * T-1904 e2e (bug 2) — pure matcher, extracted out of ChatInterface for unit
 * testability. A raw live `type:'user'` transcript frame is a duplicate of an
 * already locally-inserted SteerBubble when either its id matches a tracked
 * steer clientMsgId, or (id absent — the field name on the wire is unproven)
 * its content exactly matches a recently-tracked steer text in the same
 * session, within a bounded recency window.
 */

export interface TrackedSteerInjection {
  text: string;
  sessionId: string;
  at: number;
}

export interface LiveTextFrameCandidate {
  sessionId?: string;
  content?: string;
  clientMsgId?: string;
  steerClientMsgId?: string;
}

export const STEER_DUPLICATE_MATCH_WINDOW_MS = 30_000;

export function isDuplicateSteerInjectionMatch(
  tracked: ReadonlyMap<string, TrackedSteerInjection>,
  msg: LiveTextFrameCandidate,
  now: number = Date.now(),
): boolean {
  const byId =
    (msg.steerClientMsgId != null && tracked.has(msg.steerClientMsgId)) ||
    (msg.clientMsgId != null && tracked.has(msg.clientMsgId));
  if (byId) return true;

  if (!msg.sessionId || !msg.content) return false;
  for (const entry of tracked.values()) {
    if (
      entry.sessionId === msg.sessionId &&
      entry.text === msg.content &&
      now - entry.at < STEER_DUPLICATE_MATCH_WINDOW_MS
    ) {
      return true;
    }
  }
  return false;
}
