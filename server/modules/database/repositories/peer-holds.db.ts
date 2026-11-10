/**
 * peer_holds repository (ADR-219 P2a-min, T-2074). Prepared statements only.
 * Every transition is one compare-and-set (`WHERE id = ? AND state = ?
 * [AND hold_version = ?]`, `changes = 1` or nothing happened). Promotion,
 * re-hold and approved-row expiry touch both tables in ONE immediate
 * transaction (no nesting). Overflow is counted and inserted in one statement.
 */

import { getConnection } from '@/modules/database/connection.js';

export type PeerHoldState = 'held' | 'promoted' | 'rejected' | 'expired' | 'cancelled';

export type PeerHoldRow = {
  id: string; chain_id: string; from_user_id: number; from_session_id: string; from_agent_id: string | null;
  from_mode: string; to_user_id: number; to_session_id: string; project_id: string | null; body: string;
  body_sha256: string; body_bytes: number; summary: string | null; hop: number; parent_id: string | null;
  hold_causes: string; state: PeerHoldState; hold_version: number; cause: string | null;
  target_mode_shown: string | null; decided_by: number | null; decided_auth_kind: string | null;
  decided_at: number | null; reject_reason: string | null; message_id: string | null;
  expires_at: number; created_at: number; updated_at: number;
};

export type NewPeerHold = Pick<PeerHoldRow, 'id' | 'chain_id' | 'from_user_id' | 'from_session_id' | 'from_agent_id'
  | 'from_mode' | 'to_user_id' | 'to_session_id' | 'project_id' | 'body' | 'body_sha256' | 'body_bytes' | 'summary'
  | 'hop' | 'parent_id' | 'hold_causes' | 'expires_at'> & { now: number };

export type PeerHoldLimits = { perTargetUser: number; perSenderWithinTarget: number; perSessionPair: number };

export type PeerHoldDecision = { userId: number; authKind: string; nowMs: number; targetMode?: string | null };

const COLUMNS = `id, chain_id, from_user_id, from_session_id, from_agent_id, from_mode, to_user_id, to_session_id,
  project_id, body, body_sha256, body_bytes, summary, hop, parent_id, hold_causes, state, hold_version, cause,
  target_mode_shown, decided_by, decided_auth_kind, decided_at, reject_reason, message_id, expires_at, created_at,
  updated_at`;

const db = () => getConnection();

/** A CAS that lost inside a transaction: thrown to roll the whole transaction back. */
class CasLost extends Error {}

/** Runs `work` in one immediate transaction; false (everything rolled back) when a CAS inside lost. */
function atomically(work: () => void): boolean {
  try {
    db().transaction(work).immediate();
    return true;
  } catch (error) {
    if (error instanceof CasLost) return false;
    throw error;
  }
}

function mustChange(changes: number): void {
  if (changes !== 1) throw new CasLost();
}

/**
 * Moves every held row matched by `where` to a terminal state; returns their ids.
 * Reads first (ت-7): a sweep with nothing to do takes no write transaction.
 */
function settleWhere(state: PeerHoldState, cause: string, where: string, args: unknown[], nowMs: number): string[] {
  const due = db().prepare(`SELECT id FROM peer_holds WHERE state = 'held' AND ${where}`).all(...args) as Array<{ id: string }>;
  if (due.length === 0) return [];
  const update = db().prepare(`UPDATE peer_holds SET state = ?, cause = ?, hold_version = hold_version + 1,
    updated_at = ? WHERE id = ? AND state = 'held' AND ${where}`);
  return due.filter((row) => update.run(state, cause, nowMs, row.id, ...args).changes === 1).map((row) => row.id);
}

/** The single spawn owner of a session as SQL (the same rule as peerMessagesDb.strictSpawnOwner). */
const SPAWN_OWNER_SQL = `(SELECT MIN(sp.user_id) FROM session_participants sp WHERE sp.session_id = peer_holds.to_session_id
  AND sp.role = 'owner' AND sp.attribution = 'spawn' HAVING COUNT(*) = 1)`;

export const peerHoldsDb = {
  /**
   * Inserts a `held` row only while the target user has < perTargetUser held, the
   * sender < perSenderWithinTarget held for that user and the session pair <
   * perSessionPair held — counted and inserted in ONE statement (م-7). True when inserted.
   */
  insertHeldWithinLimits(row: NewPeerHold, limits: PeerHoldLimits): boolean {
    return db().prepare(`INSERT INTO peer_holds (id, chain_id, from_user_id, from_session_id, from_agent_id,
      from_mode, to_user_id, to_session_id, project_id, body, body_sha256, body_bytes, summary, hop, parent_id,
      hold_causes, state, expires_at, created_at, updated_at)
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'held', ?, ?, ?
      WHERE (SELECT COUNT(*) FROM peer_holds WHERE to_user_id = ? AND state = 'held') < ?
        AND (SELECT COUNT(*) FROM peer_holds WHERE to_user_id = ? AND from_user_id = ? AND state = 'held') < ?
        AND (SELECT COUNT(*) FROM peer_holds WHERE from_session_id = ? AND to_session_id = ? AND state = 'held') < ?`).run(
      row.id, row.chain_id, row.from_user_id, row.from_session_id, row.from_agent_id, row.from_mode, row.to_user_id,
      row.to_session_id, row.project_id, row.body, row.body_sha256, row.body_bytes, row.summary, row.hop, row.parent_id,
      row.hold_causes, row.expires_at, row.now, row.now,
      row.to_user_id, limits.perTargetUser, row.to_user_id, row.from_user_id, limits.perSenderWithinTarget,
      row.from_session_id, row.to_session_id, limits.perSessionPair,
    ).changes === 1;
  },

  get(id: string): PeerHoldRow | undefined {
    return db().prepare(`SELECT ${COLUMNS} FROM peer_holds WHERE id = ?`).get(id) as PeerHoldRow | undefined;
  },

  /** The user's held rows, newest first, keyset-paginated by `created_at` (exclusive). */
  listHeldForUser(userId: number, beforeCreatedAt: number | null, limit: number): PeerHoldRow[] {
    return db().prepare(`SELECT ${COLUMNS} FROM peer_holds WHERE to_user_id = ? AND state = 'held'
      AND created_at < ? ORDER BY created_at DESC, id DESC LIMIT ?`)
      .all(userId, beforeCreatedAt ?? Number.MAX_SAFE_INTEGER, limit) as PeerHoldRow[];
  },

  countHeldForUser(userId: number): number {
    return (db().prepare("SELECT COUNT(*) AS n FROM peer_holds WHERE to_user_id = ? AND state = 'held'")
      .get(userId) as { n: number }).n;
  },

  /** Holds a session sent or received, newest first, keyset-paginated. */
  listForSession(sessionId: string, beforeCreatedAt: number | null, limit: number): PeerHoldRow[] {
    return db().prepare(`SELECT ${COLUMNS} FROM peer_holds WHERE (from_session_id = ? OR to_session_id = ?)
      AND created_at < ? ORDER BY created_at DESC, id DESC LIMIT ?`)
      .all(sessionId, sessionId, beforeCreatedAt ?? Number.MAX_SAFE_INTEGER, limit) as PeerHoldRow[];
  },

  /** Holds a sender session or user produced since `sinceMs` (they count toward the S1 throttles). */
  countFromSince(column: 'from_session_id' | 'from_user_id', value: string | number, sinceMs: number): number {
    const sql = column === 'from_session_id'
      ? 'SELECT COUNT(*) AS n FROM peer_holds WHERE from_session_id = ? AND created_at >= ?'
      : 'SELECT COUNT(*) AS n FROM peer_holds WHERE from_user_id = ? AND created_at >= ?';
    return (db().prepare(sql).get(value, sinceMs) as { n: number }).n;
  },

  /**
   * held → promoted (version + 1) and a new `queued` peer_messages row copied from
   * the hold, in one immediate transaction; false (nothing written) when the CAS lost.
   */
  promote(id: string, expectedVersion: number, decision: PeerHoldDecision, message: { id: string; ref_token: string }): boolean {
    return atomically(() => {
      mustChange(db().prepare(`UPDATE peer_holds SET state = 'promoted', hold_version = hold_version + 1,
        decided_by = ?, decided_auth_kind = ?, decided_at = ?, target_mode_shown = ?, message_id = ?, updated_at = ?
        WHERE id = ? AND state = 'held' AND hold_version = ? AND expires_at > ?`).run(decision.userId, decision.authKind,
        decision.nowMs, decision.targetMode ?? null, message.id, decision.nowMs, id, expectedVersion, decision.nowMs).changes);
      db().prepare(`INSERT INTO peer_messages (id, ref_token, chain_id, from_user_id, from_session_id, from_agent_id,
        from_mode, to_user_id, to_session_id, project_id, body, body_sha256, body_bytes, summary, hop, parent_id,
        notify_when_idle, state, created_at, updated_at, hold_id, approved_by, approval_text_hash, approval_target_mode)
        SELECT ?, ?, chain_id, from_user_id, from_session_id, from_agent_id, from_mode, to_user_id, to_session_id,
          project_id, body, body_sha256, body_bytes, summary, hop, parent_id, 0, 'queued', ?, ?, id, ?, body_sha256, ?
        FROM peer_holds WHERE id = ?`).run(message.id, message.ref_token, decision.nowMs, decision.nowMs,
        decision.userId, decision.targetMode ?? null, id);
    });
  },

  /** held → rejected (version + 1); false when the CAS lost. */
  reject(id: string, expectedVersion: number, decision: PeerHoldDecision, reason: string | null): boolean {
    return db().prepare(`UPDATE peer_holds SET state = 'rejected', hold_version = hold_version + 1, cause = 'rejected',
      decided_by = ?, decided_auth_kind = ?, decided_at = ?, reject_reason = ?, updated_at = ?
      WHERE id = ? AND state = 'held' AND hold_version = ? AND expires_at > ?`).run(decision.userId, decision.authKind,
      decision.nowMs, reason, decision.nowMs, id, expectedVersion, decision.nowMs).changes === 1;
  },

  /** A held row whose target owner changed: re-pointed to `newOwner`, version + 1 (a new card). */
  repoint(id: string, expectedVersion: number, newOwner: number, nowMs: number): boolean {
    return db().prepare(`UPDATE peer_holds SET to_user_id = ?, hold_version = hold_version + 1, updated_at = ?
      WHERE id = ? AND state = 'held' AND hold_version = ?`).run(newOwner, nowMs, id, expectedVersion).changes === 1;
  },

  /** held past `expires_at` → expired; returns the ids. */
  expireDue(nowMs: number): string[] {
    return settleWhere('expired', 'expired', 'expires_at <= ?', [nowMs], nowMs);
  },

  /** held rows of a sender who is no longer an active member → cancelled sender_disabled. */
  cancelDisabledSenders(nowMs: number): string[] {
    return settleWhere('cancelled', 'sender_disabled', `NOT EXISTS (SELECT 1 FROM users u
      WHERE u.id = peer_holds.from_user_id AND u.is_active = 1 AND u.status = 'active')`, [], nowMs);
  },

  /** held rows whose target session is archived (or gone) → cancelled target_archived. */
  cancelArchivedTargets(nowMs: number): string[] {
    return settleWhere('cancelled', 'target_archived', `NOT EXISTS (SELECT 1 FROM sessions s
      WHERE s.session_id = peer_holds.to_session_id AND COALESCE(s.isArchived, 0) = 0)`, [], nowMs);
  },

  /**
   * Re-hold (م-5): the approved, undelivered message → refused rehold; the hold →
   * held with its approval cleared, version + 1, owner `newOwner`, a fresh expiry.
   */
  rehold(holdId: string, messageId: string, newOwner: number, nowMs: number, ttlMs: number): boolean {
    return atomically(() => {
      mustChange(db().prepare(`UPDATE peer_messages SET state = 'refused', cause = 'rehold', updated_at = ?
        WHERE id = ? AND hold_id = ? AND state IN ('queued', 'deferred_quota')`).run(nowMs, messageId, holdId).changes);
      mustChange(db().prepare(`UPDATE peer_holds SET state = 'held', hold_version = hold_version + 1, to_user_id = ?,
        decided_by = NULL, decided_auth_kind = NULL, decided_at = NULL, target_mode_shown = NULL, message_id = NULL,
        cause = 'rehold', expires_at = ?, updated_at = ? WHERE id = ? AND state = 'promoted' AND message_id = ?`)
        .run(newOwner, nowMs + ttlMs, nowMs, holdId, messageId).changes);
    });
  },

  /**
   * ت-9: the promoted message ended for a reason unrelated to the approval
   * (unverified CLI, unknown mode, no transcript, delivery failed): the hold goes
   * back to `held` with that cause, approval cleared, version + 1, a fresh expiry.
   */
  releaseDeadPromotion(holdId: string, messageId: string, cause: string, nowMs: number, ttlMs: number): boolean {
    return db().prepare(`UPDATE peer_holds SET state = 'held', hold_version = hold_version + 1, cause = ?,
      decided_by = NULL, decided_auth_kind = NULL, decided_at = NULL, target_mode_shown = NULL, message_id = NULL,
      expires_at = ?, updated_at = ? WHERE id = ? AND state = 'promoted' AND message_id = ?`)
      .run(cause, nowMs + ttlMs, nowMs, holdId, messageId).changes === 1;
  },

  /** Held rows whose target's single spawn owner changed → re-pointed (version + 1); returns each move. */
  repointChangedOwners(nowMs: number): Array<{ id: string; fromOwner: number; toOwner: number }> {
    const changed = db().prepare(`SELECT id, hold_version AS version, to_user_id AS fromOwner, ${SPAWN_OWNER_SQL} AS owner
      FROM peer_holds WHERE state = 'held'`).all() as Array<{ id: string; version: number; fromOwner: number; owner: number | null }>;
    return changed.filter((row) => row.owner !== null && row.owner !== row.fromOwner)
      .filter((row) => peerHoldsDb.repoint(row.id, row.version, row.owner as number, nowMs))
      .map((row) => ({ id: row.id, fromOwner: row.fromOwner, toOwner: row.owner as number }));
  },

  /** Approved-row expiry: the message → failed approval_expired; the hold → expired. */
  expireApproved(holdId: string, messageId: string, nowMs: number): boolean {
    return atomically(() => {
      mustChange(db().prepare(`UPDATE peer_messages SET state = 'failed', cause = 'approval_expired', updated_at = ?
        WHERE id = ? AND hold_id = ? AND state IN ('queued', 'deferred_quota')`).run(nowMs, messageId, holdId).changes);
      mustChange(db().prepare(`UPDATE peer_holds SET state = 'expired', cause = 'approval_expired',
        hold_version = hold_version + 1, updated_at = ? WHERE id = ? AND state = 'promoted' AND message_id = ?`)
        .run(nowMs, holdId, messageId).changes);
    });
  },

  /** A member's username for display (any status), or null. */
  memberName(userId: number): string | null {
    const row = db().prepare('SELECT username FROM users WHERE id = ?').get(userId) as { username: string } | undefined;
    return row ? row.username : null;
  },
};
