/**
 * session-steer.contract — WIRE CONTRACT for mid-turn steering (T-1903 / ADR-190).
 *
 * A session member may inject a short message into a running turn. Another
 * member needs the admin policy AND the starter's consent, and his note taints
 * the turn (gated tools need the starter's approval). The starter himself may
 * steer his own turn under the admin policy alone; that never taints and never
 * asks for any approval. Both sides compile against these declarations.
 *
 * REST (all behind authenticateToken):
 *   GET  /api/session-steer/policy   → SteerPolicy                (any authenticated user)
 *   PUT  /api/session-steer/policy   ← SteerPolicy → SteerPolicy   (owner/admin; audited)
 *   GET  /api/session-steer/consent  → SteerConsent               (self)
 *   PUT  /api/session-steer/consent  ← SteerConsent → SteerConsent (self; audited)
 *
 * WebSocket (chat socket):
 *   client → server  `session-steer`        SessionSteerRequest
 *   server → sender  `session-steer-result` SessionSteerResult   (unicast, every request)
 *   server → session `steer-turn-state`     SteerTurnState       (starter + mirrors, on run start)
 *   server → viewer  `steer-turn-state`     SteerTurnState       (unicast on check-session-status)
 *   server → session `steer-queued`         SteerEvent           (starter + mirrors)
 *   server → session `steer-delivered`      SteerEvent           (starter + mirrors)
 *   server → session `steer-rejected`       SteerEvent           (starter + mirrors; after queueing)
 *
 * History messages (GET session messages) gain, on a user text row that is a
 * VERIFIED injection (ingress uuid + payload hash match, never text parsing):
 *   injected: true, userId: <sender>, deliveryStatus: 'delivered',
 *   steerClientMsgId: <sender's clientMsgId>, content: the sender's text (wrapper stripped).
 */

export type SteerPolicyMode = 'off' | 'per_user';

export interface SteerPolicy {
  mode: SteerPolicyMode;
}

export interface SteerConsent {
  /** Starter consent: may other members steer MY running turns. Default false. Self-steer ignores it. */
  allowSteerOnMyRuns: boolean;
}

export interface SessionSteerRequest {
  type: 'session-steer';
  sessionId: string;
  /** The `turnId` announced by `steer-turn-state` for the running turn. */
  turnId: string;
  /** Sender-generated idempotency id, /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/. */
  clientMsgId: string;
  text: string;
}

export type SteerRejectCode =
  | 'invalid_request'
  | 'not_writable'
  | 'steer_unsupported'
  | 'turn_not_active'
  | 'starter_unknown'
  | 'plan_mode'
  | 'steer_unavailable'
  | 'steer_disabled'
  | 'steer_not_consented'
  | 'steer_rate_limited'
  | 'steer_turn_limit'
  | 'steer_queue_full'
  | 'text_empty'
  | 'text_too_long'
  | 'duplicate'
  | 'turn_aborted'
  | 'internal_error';

export type SteerDeliveryStatus = 'queued' | 'delivered' | 'unconfirmed' | 'rejected';

export interface SessionSteerResult {
  type: 'session-steer-result';
  sessionId: string;
  turnId: string;
  clientMsgId: string;
  ok: boolean;
  /** HTTP-equivalent: 202 queued, 400/403/409/413/429/500 refusal. */
  status: number;
  code?: SteerRejectCode;
  deliveryStatus?: SteerDeliveryStatus;
}

/**
 * Who started the live run, and may the receiving viewer steer it.
 *
 * Two emissions:
 *  - BROADCAST at run start (starter + mirrors) for a steer-armed Claude run:
 *    `forViewerUserId: null`; `steerable` means "a member OTHER than the
 *    starter may steer" (taint hook armed at start + policy + starter consent,
 *    read at announce time); `starterSteerable` means "the starter may steer
 *    his own turn" (injection armed + policy, not plan mode). The starter
 *    reads `starterSteerable`, everyone else `steerable`.
 *  - UNICAST to one socket whenever it sends `check-session-status` for a
 *    session with a live run of ANY provider (late joiners included):
 *    `forViewerUserId` = that viewer; `steerable` is computed for THAT viewer
 *    (policy, provider capability, write access, not in plan mode; for the
 *    starter an armed injection path, for anyone else the starter's consent
 *    and the run's taint hook).
 *    Prefer this frame.
 * Admission (`session-steer`) re-checks everything and is the authority.
 * `starter_unknown` (409): the run's starter could not be established, so no
 * one may steer it (fail-closed).
 *
 * `starterUserId` is the run's launcher (null only when unknown); a viewer whose
 * id differs from it is NOT the starter and must not be offered Stop/Esc-abort
 * as the owner. `turnId` is null when the run cannot be steered at all.
 */
export interface SteerTurnState {
  type: 'steer-turn-state';
  sessionId: string;
  turnId: string | null;
  starterUserId: number | null;
  steerable: boolean;
  /**
   * The starter may steer his own turn (policy on, run armed, not plan mode).
   * Always sent by this server; optional only so older frames still parse (absent → false).
   */
  starterSteerable?: boolean;
  forViewerUserId: number | null;
  /** Server-registered capability of the session's provider. */
  capability: { midTurnInjection: boolean };
}

export interface SteerEvent {
  type: 'steer-queued' | 'steer-delivered' | 'steer-rejected';
  sessionId: string;
  turnId: string;
  clientMsgId: string;
  sender: { userId: number; displayName: string };
  starterUserId: number | null;
  deliveryStatus: SteerDeliveryStatus;
  /** Present on steer-queued so the starter sees what was injected. */
  text?: string;
  reason?: SteerRejectCode;
}

/**
 * Taint gate (default-deny): once a turn is steered, only these tools run
 * without the STARTER's approval; Agent/Task/Workflow are refused outright and
 * every other tool asks the starter. The approval prompt is bound to the
 * starter's socket at run start — after a reconnect it cannot be answered and
 * ends in a (safe) deny.
 */
export const STEER_TAINT_FREE_TOOLS: readonly string[] = Object.freeze(['Read', 'Grep', 'Glob', 'TodoWrite', 'TaskOutput']);
