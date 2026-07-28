/**
 * session-activity.service.ts — ج1: a READ-ONLY carrier for a state that already
 * exists. NOT a new source of truth.
 *
 * WHY IT EXISTS
 * -------------
 * "Is this conversation currently running?" had NO rest source at all. Its only
 * carrier was the websocket `session-status` frame, which a client can miss (a
 * browser refresh races the socket handshake, or the frame lands in a channel the
 * new tab is not on yet) — so after a refresh the running-operations card stayed
 * hidden until the user pressed refresh by hand.
 *
 * WHAT IT IS NOT (qa-critic veto, honoured literally)
 * ---------------------------------------------------
 * There is NO new store, NO cache, NO memoization and NO derived bookkeeping in
 * this file. The answer is computed on every call by asking the SAME predicate
 * the websocket frame asks — the provider's `isXSessionActive` function, injected
 * at the composition root. If the two ever disagreed we would have created the
 * second source of truth the veto forbids; by construction they cannot.
 *
 * DEFINITION OF "ACTIVE" (coordinator decision, 2026-07-26)
 * ---------------------------------------------------------
 * For claude: `status === 'active'` and nothing else — exactly what
 * `isClaudeSDKSessionActive` returns. A DETACHED session (a ghost that lost its
 * listeners but keeps writing its jsonl) HAS `status === 'active'` and is
 * therefore reported as processing here, identically to the websocket frame. The
 * drain's narrower predicate (`getDrainBlockingClaudeSessions`, which subtracts
 * detached ghosts) is deliberately NOT used: claude-sdk.js documents that split
 * as "a detached session is still active for display (UI / get-active-sessions /
 * WS-DIAG); it is just no longer drain-blocking". This endpoint is a display
 * path. Importing the drain's definition here would make the REST answer
 * contradict the websocket frame for the same session — the card would appear
 * over the socket and then vanish on refresh, which is the very bug this carrier
 * exists to fix. (Flagged to the coordinator; a one-line change if reversed.)
 *
 * NO SIDE EFFECTS
 * ---------------
 * No attach, no replay, no mirror registration, no writer swap, no write of any
 * kind. Two map reads (the sessions row for the provider, the provider's active
 * map for the status) and nothing else.
 *
 * NO EXISTENCE DISCLOSURE — AND WHAT THAT CLAIM COVERS
 * -----------------------------------------------------
 * A session the caller may not see answers BYTE-IDENTICALLY to a session that
 * does not exist: HTTP 200, `{ isProcessing: false }`, no 403, no 404, no echo of
 * the id. That is the whole guarantee, and it is a guarantee about the RESPONSE,
 * not about the work performed. The gate is the shared `isSessionVisibleToUser`
 * (B-137), reused verbatim; no visibility logic is written here.
 *
 * The two refused cases do NOT take the same path, and it is worth being precise
 * because the naive reading is backwards:
 *   - UNKNOWN id: the gate returns TRUE (it fail-opens on a session that resolves
 *     to no project_path — chat-websocket.service.ts), so execution continues,
 *     resolves the provider from the sessions table and DOES call the liveness
 *     probe, which misses its map and answers false.
 *   - INVISIBLE session (known private project, non-member): the gate returns
 *     false and we return immediately — the provider lookup and the probe are
 *     never reached.
 * So the invisible branch does strictly LESS work after the gate, and no
 * constant-time property is claimed or engineered here. Any timing signal is
 * between two in-process lookups (sqlite by primary key, then a Map miss) and is
 * not distinguishable from load noise over a network — but it is not zero, and
 * asserting otherwise would be describing a defence that does not exist. What is
 * actually enforced is that no VALUE derived from the hidden session ever reaches
 * the response: an invisible session that is genuinely RUNNING still answers
 * false, which is the property the tests pin.
 */

import { sessionsDb } from '@/modules/database/index.js';
import { isSessionVisibleToUser } from '@/modules/websocket/index.js';

/** Answers "is a run alive for this session id?" for ONE provider. */
export type SessionLivenessProbe = (sessionId: string) => boolean;

/** Provider key (as persisted in `sessions.provider`) → its liveness probe. */
export type SessionLivenessProbes = Readonly<Record<string, SessionLivenessProbe>>;

/** The single field this endpoint answers. Nothing else is ever added. */
export interface SessionActivity {
  isProcessing: boolean;
}

/**
 * Provider fallback for a session whose row is missing or carries no provider —
 * the same default the websocket dispatcher uses (its `else` branch is claude).
 */
const DEFAULT_PROVIDER = 'claude';

/**
 * Injected at the composition root (server/index.js), exactly as the runner
 * control guard is. Empty until then, which is the FAIL-CLOSED default: an
 * un-wired route reports "not processing" rather than throwing or guessing.
 */
let livenessProbes: SessionLivenessProbes = {};

/**
 * Wires the provider liveness probes from the app entry. The values MUST be the
 * very same `isXSessionActive` functions the websocket dependency object gets —
 * passing anything else would fork the truth this carrier is required to mirror.
 */
export function setSessionLivenessProbes(probes: SessionLivenessProbes | null | undefined): void {
  livenessProbes = probes ?? {};
}

/** Test seam: drops any injected probes back to the fail-closed default. */
export function resetSessionLivenessProbes(): void {
  livenessProbes = {};
}

/**
 * Resolves the provider a session belongs to. A database hiccup or an unknown id
 * degrades to the claude default; it never throws on this read-only path.
 */
function resolveProvider(sessionId: string): string {
  try {
    const provider = sessionsDb.getSessionById(sessionId)?.provider;
    return typeof provider === 'string' && provider.trim() !== ''
      ? provider.trim().toLowerCase()
      : DEFAULT_PROVIDER;
  } catch {
    return DEFAULT_PROVIDER;
  }
}

/**
 * The whole contract: `{ isProcessing: <boolean> }`, always 200 at the route.
 *
 * @param sessionId Caller-supplied session id (already syntax-validated by the route).
 * @param userId    Authenticated caller (from the JWT); null when unresolved.
 */
export function readSessionActivity(
  sessionId: string,
  userId: string | number | null
): SessionActivity {
  const id = typeof sessionId === 'string' ? sessionId.trim() : '';
  if (!id) {
    return { isProcessing: false };
  }

  // Visibility FIRST: a refused caller returns here, before the provider lookup
  // and before the probe, so no state of the hidden session is ever read. The
  // response is identical to the unknown-session response; the path taken to it
  // is shorter, not identical (see the header note — no constant-time claim).
  if (!isSessionVisibleToUser(id, userId)) {
    return { isProcessing: false };
  }

  const probe = livenessProbes[resolveProvider(id)] ?? livenessProbes[DEFAULT_PROVIDER];
  if (typeof probe !== 'function') {
    return { isProcessing: false };
  }

  // Boolean() for the same reason the websocket frame coerces: a probe that
  // returns a non-boolean falsy value (claude-sdk did, until ج1) must never let
  // JSON.stringify drop the field and turn "idle" into "field absent".
  return { isProcessing: Boolean(probe(id)) };
}
