/**
 * ADR-187: committed cross-project session transfers, published to higher
 * layers (the internal team-chat realtime registry) without the sessions
 * repository importing them. Kept apart from sessions.db.ts so tests that mock
 * that module with only `sessionsDb` are unaffected.
 */

/** Called after a committed cross-project transfer of an existing session. */
export type SessionProjectTransferListener = (sessionId: string) => void;

const projectTransferListeners = new Set<SessionProjectTransferListener>();

/** Registers a listener; returns an unregister callback. */
export function onSessionProjectTransfer(listener: SessionProjectTransferListener): () => void {
  projectTransferListeners.add(listener);
  return () => { projectTransferListeners.delete(listener); };
}

/** Notifies every listener; a listener failure never undoes the committed write. */
export function notifyProjectTransfer(sessionId: string): void {
  for (const listener of projectTransferListeners) {
    try {
      listener(sessionId);
    } catch {
      /* isolated: one listener cannot break the others or the caller */
    }
  }
}
