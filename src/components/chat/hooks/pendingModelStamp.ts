/**
 * pendingModelStamp.ts — B-1483 one-shot handoff, mirroring
 * engineProviderSession.ts's PENDING slot (T-915) for the same class of bug.
 *
 * ## The problem it solves
 * Picking a Claude model BEFORE any session exists (the composer's model
 * picker with no `sessionId` yet) only ever writes the client-local
 * provider-wide default (`setStoredProviderModel` → `claudeModel` React state
 * + `localStorage['claude-model']`). Nothing is persisted server-side for the
 * SESSION that is about to be created — there is no session id yet to POST
 * `/api/providers/claude/sessions/:id/active-model` against.
 *
 * When `session_created` later fires, `useSessionActiveModel`'s Effect-1
 * (useSessionActiveModel.ts) sees the sessionId go from null → real and
 * re-fetches `GET .../active-model` for display. The server has no override
 * on record for a session that is milliseconds old, so it answers with its
 * own provider-current default — NOT the model the user just picked — and the
 * picker display flips from "haiku" to "default" a moment after creation
 * (B-1483). The frame actually SENT to start the turn is unaffected (it reads
 * `claudeModel` directly, untouched by this race); this is a display-only bug.
 *
 * ## The fix
 * Record the exact model being sent in a one-shot sessionStorage slot right
 * before dispatch (mirroring writePendingEngineStamp). `useSessionActiveModel`
 * consumes it the first time it sees a brand-new session id (previous id was
 * empty) and, if present, seeds the display directly from the stamp —
 * skipping the network fetch for that one transition entirely, so there is no
 * race for the GET response to lose. Opening an EXISTING session never writes
 * this stamp, so the consumer naturally falls through to the normal fetch.
 */

const PENDING_MODEL_STAMP_KEY = '__nassaj_pending_model_stamp';

/**
 * Records the model about to be sent in a brand-new claude-command
 * (resume=false). Must be called just before dispatch, exactly like
 * writePendingEngineStamp, so useSessionActiveModel can consume it instead of
 * racing the server's GET for a session that was just minted.
 */
export function writePendingModelStamp(model: string | null | undefined): void {
  const trimmed = typeof model === 'string' ? model.trim() : '';
  if (trimmed) {
    sessionStorage.setItem(PENDING_MODEL_STAMP_KEY, trimmed);
  } else {
    sessionStorage.removeItem(PENDING_MODEL_STAMP_KEY);
  }
}

/**
 * Reads and immediately clears the pending model stamp (one-shot, like
 * consumePendingEngineStamp). Returns null when nothing was written — the
 * normal case when opening an existing session rather than starting a new one.
 */
export function consumePendingModelStamp(): string | null {
  const val = sessionStorage.getItem(PENDING_MODEL_STAMP_KEY);
  sessionStorage.removeItem(PENDING_MODEL_STAMP_KEY);
  return val && val.trim() ? val.trim() : null;
}
