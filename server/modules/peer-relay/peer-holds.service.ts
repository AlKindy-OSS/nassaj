/**
 * ADR-219 P2a-min (T-2074) — the hold lifecycle after intake: interactive
 * approve/reject by the recomputed target owner (CAS on state, hold_version,
 * text hash and target mode), the 72 h expiry and cancellation sweep, and the
 * delivery gate of a promoted row (approval expiry, re-hold on an owner or mode
 * change). Rejection and expiry are UI notices only: no turn ever starts.
 */

import { randomUUID } from 'node:crypto';

import { peerMessagesDb, type PeerMessageRow } from '@/modules/database/index.js';
// eslint-disable-next-line boundaries/dependencies -- ADR-219 P2: the relay's own hold table, a leaf like peer_messages.
import { peerHoldsDb, type PeerHoldRow } from '@/modules/database/repositories/peer-holds.db.js';
import { isVerifiedActorKind } from '@/shared/verified-actor-kinds.js';

import type { PeerHoldView } from './peer-events.js';
import { modeCategory, PEER_HOLD_TTL_MS } from './peer-policy.js';
import {
  auditPeer, holdView, peerRelayDeps, publishPeerHold, publishPeerMessage, readTargetRunMode,
} from './peer-relay.service.js';
import { newPeerRefToken, sha256Hex } from './peer-wire.js';

export { visibleBody } from './peer-events.js';

export type HoldCaller = { userId: number; authKind: string };

export type HoldDecisionResult = {
  status: 200 | 400 | 403 | 404 | 409;
  code?: string;
  hold?: PeerHoldView;
  messageId?: string;
};

export type ApproveInput = {
  holdId: string; caller: HoldCaller; expectedHoldVersion: unknown; expectedTextHash: unknown; expectedTargetMode: unknown;
};

export type RejectInput = { holdId: string; caller: HoldCaller; expectedHoldVersion: unknown; reason?: unknown };

const HOLD_ID = /^ph_[0-9a-f-]{36}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const REASON_MAX = 200;
const LIST_MAX = 50;

const fail = (status: HoldDecisionResult['status'], code: string, row?: PeerHoldRow): HoldDecisionResult =>
  ({ status, code, ...(row ? { hold: holdView(row) } : {}) });

const isVersion = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 1;

/** qa round 2: every re-point of a held card is audited (both paths: decision and sweep). */
function auditRepoint(holdId: string, fromOwner: number, toOwner: number, actor: number | null): void {
  auditPeer('peer_relay_hold_repointed', actor, { holdId, fromOwner, toOwner });
}

/**
 * The checks every decision shares, in order: interactive credential, a real
 * hold, the caller IS the recomputed target owner (403 before any write and
 * before any body is returned, ت-8), an owner change re-points the card (409),
 * the hold is still `held` and not past its expiry (م-3), the version matches.
 */
function loadForDecision(holdId: string, caller: HoldCaller, expectedVersion: number): PeerHoldRow | HoldDecisionResult {
  if (!isVerifiedActorKind(caller.authKind)) return fail(403, 'interactive_credential_required');
  const row = HOLD_ID.test(holdId) ? peerHoldsDb.get(holdId) : undefined;
  if (!row) return fail(404, 'hold_not_found');
  const { owner } = readTargetRunMode(row.to_session_id);
  if (owner === null || caller.userId !== owner) return fail(403, 'not_target_owner');
  if (owner !== row.to_user_id && row.state === 'held') {
    if (peerHoldsDb.repoint(row.id, row.hold_version, owner, peerRelayDeps().now())) {
      auditRepoint(row.id, row.to_user_id, owner, caller.userId);
      publishPeerHold(peerHoldsDb.get(row.id));
    }
    return fail(409, 'owner_changed', peerHoldsDb.get(row.id));
  }
  if (row.state !== 'held') return fail(409, 'hold_not_held', row);
  if (row.expires_at <= peerRelayDeps().now()) return fail(409, 'hold_expired', row);
  if (row.hold_version !== expectedVersion) return fail(409, 'stale_version', row);
  return row;
}

/** The approve gate's content checks: the reviewed text and the mode the turn will run with. */
function contentMismatch(row: PeerHoldRow, expectedTextHash: string, expectedTargetMode: string): string | null {
  if (expectedTextHash !== row.body_sha256 || sha256Hex(row.body) !== row.body_sha256) return 'text_hash_mismatch';
  const { mode } = readTargetRunMode(row.to_session_id);
  if (mode === null || mode !== expectedTargetMode || modeCategory(mode) !== row.from_mode) return 'target_mode_changed';
  return null;
}

/**
 * Approve (§4): on success the hold is `promoted` (version + 1) and a new `queued`
 * row carries `hold_id` and `approved_by`; a replay or race gets 409.
 */
export function approvePeerHold(input: ApproveInput): HoldDecisionResult {
  const { expectedHoldVersion: version, expectedTextHash: hash, expectedTargetMode: mode } = input;
  if (!isVersion(version) || typeof hash !== 'string' || !SHA256.test(hash) || typeof mode !== 'string' || mode.length > 32) {
    return fail(400, 'invalid_request');
  }
  const loaded = loadForDecision(input.holdId, input.caller, version);
  if (!('id' in loaded)) return loaded;
  const mismatch = contentMismatch(loaded, hash, mode);
  if (mismatch) return fail(409, mismatch, loaded);
  const messageId = `pm_${randomUUID()}`;
  const decision = { userId: input.caller.userId, authKind: input.caller.authKind, nowMs: peerRelayDeps().now(), targetMode: mode };
  if (!peerHoldsDb.promote(loaded.id, version, decision, { id: messageId, ref_token: newPeerRefToken() })) {
    return fail(409, 'stale_version', peerHoldsDb.get(loaded.id));
  }
  auditPeer('peer_relay_hold_approved', input.caller.userId, { holdId: loaded.id, messageId, bodySha256: loaded.body_sha256,
    targetMode: mode, authKind: input.caller.authKind });
  const promoted = peerHoldsDb.get(loaded.id) as PeerHoldRow;
  publishPeerHold(promoted);
  publishPeerMessage(peerMessagesDb.get(messageId) as PeerMessageRow);
  peerRelayDeps().kickDispatcher();
  return { status: 200, hold: holdView(promoted), messageId };
}

/** Reject (§4): `rejected`, a UI notice to both sides; no row and no turn. */
export function rejectPeerHold(input: RejectInput): HoldDecisionResult {
  const reason = input.reason === undefined || input.reason === null ? null : input.reason;
  if (!isVersion(input.expectedHoldVersion)) return fail(400, 'invalid_request');
  if (reason !== null && (typeof reason !== 'string' || [...reason].length > REASON_MAX)) return fail(400, 'invalid_request');
  const loaded = loadForDecision(input.holdId, input.caller, input.expectedHoldVersion);
  if (!('id' in loaded)) return loaded;
  const decision = { userId: input.caller.userId, authKind: input.caller.authKind, nowMs: peerRelayDeps().now() };
  if (!peerHoldsDb.reject(loaded.id, input.expectedHoldVersion, decision, reason)) {
    return fail(409, 'stale_version', peerHoldsDb.get(loaded.id));
  }
  auditPeer('peer_relay_hold_rejected', input.caller.userId, { holdId: loaded.id, authKind: input.caller.authKind });
  const rejected = peerHoldsDb.get(loaded.id) as PeerHoldRow;
  publishPeerHold(rejected);
  return { status: 200, hold: holdView(rejected) };
}

/**
 * Expiry (72 h), cancellations (sender disabled, target archived) and re-pointing
 * held cards whose target owner changed (so the new owner sees them); each change
 * is published.
 */
export function sweepPeerHolds(): number {
  const now = peerRelayDeps().now();
  const moved = peerHoldsDb.repointChangedOwners(now);
  for (const move of moved) auditRepoint(move.id, move.fromOwner, move.toOwner, null);
  const ids = [...peerHoldsDb.expireDue(now), ...peerHoldsDb.cancelDisabledSenders(now),
    ...peerHoldsDb.cancelArchivedTargets(now), ...moved.map((move) => move.id)];
  for (const id of ids) publishPeerHold(peerHoldsDb.get(id));
  return ids.length;
}

/**
 * ت-9: a promoted row the dispatcher ended for a reason unrelated to the approval
 * (unverified_cli, mode_unknown, no_transcript, a failed delivery) returns its hold
 * to `held` with that cause, so no hold stays promoted with a dead message.
 */
export function releaseHoldForEndedRow(row: PeerMessageRow, cause: string): void {
  if (!row.hold_id) return;
  if (peerHoldsDb.releaseDeadPromotion(row.hold_id, row.id, cause, peerRelayDeps().now(), PEER_HOLD_TTL_MS)) {
    auditPeer('peer_relay_hold_reheld', null, { holdId: row.hold_id, messageId: row.id, cause });
    publishPeerHold(peerHoldsDb.get(row.hold_id));
  }
}

function publishBoth(holdId: string, messageId: string): void {
  publishPeerHold(peerHoldsDb.get(holdId));
  const message = peerMessagesDb.get(messageId);
  if (message) publishPeerMessage(message);
}

/**
 * Delivery gate of a promoted row (§4), with the mode the dispatcher read once.
 * True ⇒ the row was stopped here: approval older than 72 h ⇒ failed
 * approval_expired + hold expired; owner or last-run mode changed since approval
 * ⇒ message refused rehold + hold held again (approval cleared, version + 1).
 */
export function checkHoldAtGate(row: PeerMessageRow, mode: string): boolean {
  if (!row.hold_id) return false;
  const hold = peerHoldsDb.get(row.hold_id);
  const now = peerRelayDeps().now();
  if (!hold || hold.state !== 'promoted' || hold.message_id !== row.id) {
    peerMessagesDb.transition(row.id, row.state, 'refused', { cause: 'hold_state', nowMs: now });
    return true;
  }
  if ((hold.decided_at ?? 0) + PEER_HOLD_TTL_MS <= now) {
    if (peerHoldsDb.expireApproved(hold.id, row.id, now)) publishBoth(hold.id, row.id);
    return true;
  }
  const owner = peerMessagesDb.strictSpawnOwner(row.to_session_id);
  const changed = owner !== row.to_user_id || mode !== row.approval_target_mode || modeCategory(mode) !== row.from_mode;
  if (!changed) return false;
  if (peerHoldsDb.rehold(hold.id, row.id, owner ?? hold.to_user_id, now, PEER_HOLD_TTL_MS)) {
    auditPeer('peer_relay_hold_reheld', null, { holdId: hold.id, messageId: row.id, ownerChanged: owner !== row.to_user_id });
    publishBoth(hold.id, row.id);
  }
  return true;
}

function boundedLimit(limit: unknown): number {
  const n = typeof limit === 'number' ? limit : Number.parseInt(String(limit ?? ''), 10);
  return Number.isInteger(n) && n > 0 ? Math.min(n, LIST_MAX) : 20;
}

function cursorOf(before: unknown): number | null {
  const n = Number.parseInt(String(before ?? ''), 10);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

type Page = { holds: PeerHoldView[]; nextCursor: number | null };

function page(rows: PeerHoldRow[], limit: number): Page {
  const shown = rows.slice(0, limit);
  return { holds: shown.map(holdView), nextCursor: rows.length > limit ? shown[shown.length - 1]!.created_at : null };
}

/** The caller's inbox: held rows addressed to them, newest first, paginated; `count` is the total held. */
export function listPeerHoldInbox(userId: number, before: unknown, limit: unknown): Page & { count: number } {
  const n = boundedLimit(limit);
  return { ...page(peerHoldsDb.listHeldForUser(userId, cursorOf(before), n + 1), n), count: peerHoldsDb.countHeldForUser(userId) };
}

/** Every hold a session sent or received (any state), newest first, paginated (caller passed the read gate). */
export function listSessionPeerHolds(sessionId: string, before: unknown, limit: unknown): Page {
  const n = boundedLimit(limit);
  return page(peerHoldsDb.listForSession(sessionId, cursorOf(before), n + 1), n);
}
