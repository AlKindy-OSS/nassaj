/**
 * local-engine-pin-writer — the strict writer of a LOCAL-engine pin (ADR-227,
 * ADR-088 single writer `sessionsDb.setSessionEnginePin`). Shared by the Claude,
 * Codex (T-2107) and DSH (T-2108) bodies so each settles a local chat's pin, and
 * decides whether a launch takes the local path, the same way.
 */

import { sessionsDb } from '../../modules/database/index.js';

import { takesLocalEnginePath } from './apply-claude-local-engine-env.js';
import { PIN_SOURCE } from './engine-pin.js';

/**
 * Does this launch take the local path? Null for a cloud launch; otherwise the
 * session's stored engine (a local pin, or null for a NEW chat on a local model).
 * A cloud chat asking for a local model is refused, never moved.
 * @param {{ sessionId?: string|null, requestedModel?: string|null }} input
 * @returns {{ storedEngine: string|null }|null}
 * @throws {Error} ENGINE_PROVIDER_UNAVAILABLE (pin_conflict)
 */
export function localEnginePathOrThrow({ sessionId = null, requestedModel = null }) {
  const storedEngine = sessionId ? sessionsDb.getSessionEnginePin(sessionId)?.engine ?? null : null;
  return takesLocalEnginePath({ sessionId, storedEngine, requestedModel }) ? { storedEngine } : null;
}

/**
 * Records a LOCAL-engine pin strictly. Unlike the best-effort vendor pin write it
 * never swallows a failure: a local chat whose pin did not settle could resume
 * on another engine, so the caller aborts the run instead. A lineage child must
 * carry its parent's exact pin.
 * @param {{newSessionId:string, parentSessionId:string|null, pin:string}} input
 * @throws {Error} code ENGINE_PIN_WRITE_FAILED
 */
export function recordLocalEnginePinOrThrow({ newSessionId, parentSessionId, pin }) {
  let settled = null;
  try {
    const parentPin = parentSessionId && parentSessionId !== newSessionId
      ? sessionsDb.getSessionEnginePin(parentSessionId)?.engine ?? null
      : null;
    if (parentPin === null || parentPin === pin) {
      settled = sessionsDb.setSessionEnginePin(newSessionId, pin, PIN_SOURCE.SERVER_VERDICT);
    }
  } catch (error) {
    console.warn(`[engine-pin] local pin write failed for ${newSessionId}: ${error?.message ?? error}`);
  }
  if (!settled || settled.outcome === 'missing_row' || settled.engine !== pin) {
    throw Object.assign(
      new Error('The local model server pin of this chat could not be recorded; the run was stopped.'),
      { code: 'ENGINE_PIN_WRITE_FAILED' },
    );
  }
}
