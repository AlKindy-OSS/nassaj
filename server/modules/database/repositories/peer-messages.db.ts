/**
 * peer_messages repository (ADR-219 S1, T-2072): the relay rows, the per-session
 * cost baseline and the agents' origin hops. Prepared statements only; every
 * state change is a compare-and-set on the current state, so two dispatchers
 * (or a dispatcher and a boot repair) can never both claim one row.
 */

import { getConnection } from '@/modules/database/connection.js';

export type PeerMessageState = 'queued' | 'delivering' | 'delivered' | 'refused' | 'deferred_quota' | 'failed';

export type PeerMessageRow = {
  id: string;
  ref_token: string;
  chain_id: string;
  from_user_id: number;
  from_session_id: string;
  from_agent_id: string | null;
  from_mode: string;
  to_user_id: number | null;
  to_session_id: string;
  project_id: string | null;
  body: string;
  body_sha256: string;
  body_bytes: number;
  summary: string | null;
  hop: number;
  parent_id: string | null;
  notify_when_idle: number;
  state: PeerMessageState;
  cause: string | null;
  delivery_path: string | null;
  attempts: number;
  next_attempt_at: number | null;
  proof_scan_offset: number | null;
  cost_usd_charged: number | null;
  created_at: number;
  updated_at: number;
  delivered_at: number | null;
};

export type NewPeerMessage = Pick<PeerMessageRow,
  'id' | 'ref_token' | 'chain_id' | 'from_user_id' | 'from_session_id' | 'from_agent_id' | 'from_mode'
  | 'to_user_id' | 'to_session_id' | 'project_id' | 'body' | 'body_sha256' | 'body_bytes' | 'summary'
  | 'hop' | 'parent_id' | 'notify_when_idle' | 'state' | 'cause'> & { now: number };

export type OwnedSessionRow = { sessionId: string; title: string | null; projectPath: string | null };

const COLUMNS = `id, ref_token, chain_id, from_user_id, from_session_id, from_agent_id, from_mode, to_user_id,
  to_session_id, project_id, body, body_sha256, body_bytes, summary, hop, parent_id, notify_when_idle, state,
  cause, delivery_path, attempts, next_attempt_at, proof_scan_offset, cost_usd_charged, created_at, updated_at, delivered_at`;

export const peerMessagesDb = {
  /** Inserts one row; the id and ref token are unique (a collision throws). */
  insert(row: NewPeerMessage): void {
    getConnection().prepare(`INSERT INTO peer_messages (id, ref_token, chain_id, from_user_id, from_session_id,
      from_agent_id, from_mode, to_user_id, to_session_id, project_id, body, body_sha256, body_bytes, summary, hop,
      parent_id, notify_when_idle, state, cause, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      row.id, row.ref_token, row.chain_id, row.from_user_id, row.from_session_id, row.from_agent_id, row.from_mode,
      row.to_user_id, row.to_session_id, row.project_id, row.body, row.body_sha256, row.body_bytes, row.summary,
      row.hop, row.parent_id, row.notify_when_idle, row.state, row.cause, row.now, row.now,
    );
  },

  get(id: string): PeerMessageRow | undefined {
    return getConnection().prepare(`SELECT ${COLUMNS} FROM peer_messages WHERE id = ?`).get(id) as PeerMessageRow | undefined;
  },

  /** Rows a sender session wrote since `sinceMs` (the 20/h throttle). */
  countFromSessionSince(sessionId: string, sinceMs: number): number {
    const row = getConnection().prepare(`SELECT COUNT(*) AS n FROM peer_messages
      WHERE from_session_id = ? AND created_at >= ? AND state != 'refused'`).get(sessionId, sinceMs) as { n: number };
    return row.n;
  },

  /** Refused rows a sender session produced since `sinceMs` (qa م-4: refusals are capped too). */
  countRefusedFromSessionSince(sessionId: string, sinceMs: number): number {
    const row = getConnection().prepare(`SELECT COUNT(*) AS n FROM peer_messages
      WHERE from_session_id = ? AND created_at >= ? AND state = 'refused'`).get(sessionId, sinceMs) as { n: number };
    return row.n;
  },

  /** Rows a sender user wrote since `sinceMs` (the 60/h throttle). */
  countFromUserSince(userId: number, sinceMs: number): number {
    const row = getConnection().prepare(`SELECT COUNT(*) AS n FROM peer_messages
      WHERE from_user_id = ? AND created_at >= ? AND state != 'refused'`).get(userId, sinceMs) as { n: number };
    return row.n;
  },

  /** Deliverable rows, oldest first, exactly one per target session (ties broken by id). */
  listDeliverable(nowMs: number, limit: number): PeerMessageRow[] {
    return getConnection().prepare(`SELECT ${COLUMNS} FROM peer_messages p
      WHERE (p.state = 'queued' OR (p.state = 'deferred_quota' AND COALESCE(p.next_attempt_at, 0) <= ?))
        AND COALESCE(p.next_attempt_at, 0) <= ?
        AND NOT EXISTS (SELECT 1 FROM peer_messages d WHERE d.to_session_id = p.to_session_id AND d.state = 'delivering')
        AND p.id = (SELECT q.id FROM peer_messages q WHERE q.to_session_id = p.to_session_id
          AND q.state IN ('queued', 'deferred_quota') ORDER BY q.created_at ASC, q.id ASC LIMIT 1)
      ORDER BY p.created_at ASC LIMIT ?`).all(nowMs, nowMs, limit) as PeerMessageRow[];
  },

  /** Rows left `delivering` (a crash or restart mid-delivery): the boot repair input. */
  listDelivering(): PeerMessageRow[] {
    return getConnection().prepare(`SELECT ${COLUMNS} FROM peer_messages WHERE state = 'delivering'
      ORDER BY created_at ASC`).all() as PeerMessageRow[];
  },

  /**
   * Claims a deliverable row, recording the target transcript's size (the proof
   * scan reads only what follows); true only for the one caller whose CAS won.
   */
  claim(id: string, nowMs: number, proofScanOffset: number | null): boolean {
    return getConnection().prepare(`UPDATE peer_messages SET state = 'delivering', attempts = attempts + 1,
      updated_at = ?, delivery_path = 'resume', proof_scan_offset = ?
      WHERE id = ? AND state IN ('queued', 'deferred_quota')`).run(nowMs, proofScanOffset, id).changes === 1;
  },

  /** Moves a row from `from` to `to`; false when its state already changed. */
  transition(id: string, from: PeerMessageState, to: PeerMessageState, change: {
    cause?: string | null; nextAttemptAt?: number | null; costUsd?: number | null; nowMs: number;
    /** The claim did not count as an attempt (a human held the session). */
    refundAttempt?: boolean;
  }): boolean {
    return getConnection().prepare(`UPDATE peer_messages SET state = ?, cause = ?, next_attempt_at = ?,
      cost_usd_charged = COALESCE(?, cost_usd_charged), updated_at = ?,
      attempts = CASE WHEN ? = 1 AND attempts > 0 THEN attempts - 1 ELSE attempts END,
      delivered_at = CASE WHEN ? = 'delivered' THEN ? ELSE delivered_at END
      WHERE id = ? AND state = ?`).run(
      to, change.cause ?? null, change.nextAttemptAt ?? null, change.costUsd ?? null, change.nowMs,
      change.refundAttempt ? 1 : 0, to, change.nowMs, id, from,
    ).changes === 1;
  },

  /** Delivered rows of a target session whose ref is in `refs` (history markers). */
  deliveredIdsByRef(sessionId: string, refs: readonly string[]): Map<string, string> {
    const out = new Map<string, string>();
    if (refs.length === 0) return out;
    const marks = refs.map(() => '?').join(', ');
    const rows = getConnection().prepare(`SELECT id, ref_token FROM peer_messages WHERE to_session_id = ?
      AND state = 'delivered' AND ref_token IN (${marks})`).all(sessionId, ...refs) as Array<{ id: string; ref_token: string }>;
    for (const row of rows) out.set(row.ref_token, row.id);
    return out;
  },

  /** Rows of a session (sent or received), newest first — the UI bubble source. */
  listForSession(sessionId: string, limit: number): PeerMessageRow[] {
    return getConnection().prepare(`SELECT ${COLUMNS} FROM peer_messages
      WHERE from_session_id = ? OR to_session_id = ? ORDER BY created_at DESC LIMIT ?`)
      .all(sessionId, sessionId, limit) as PeerMessageRow[];
  },

  /**
   * The single spawn owner of a session, or null when there is none or more than
   * one (same rule as participants' resolveStrictSpawnOwnerUserId).
   */
  strictSpawnOwner(sessionId: string): number | null {
    const row = getConnection().prepare(`SELECT MIN(user_id) AS user_id FROM session_participants
      WHERE session_id = ? AND role = 'owner' AND attribution = 'spawn' HAVING COUNT(*) = 1`)
      .get(sessionId) as { user_id: number } | undefined;
    return row && Number.isInteger(row.user_id) && row.user_id > 0 ? row.user_id : null;
  },

  /** Claude sessions whose single spawn owner is `userId`, most recently active first. */
  listOwnedClaudeSessions(userId: number, limit: number): OwnedSessionRow[] {
    return getConnection().prepare(`SELECT s.session_id AS sessionId, s.custom_name AS title,
        s.project_path AS projectPath
      FROM sessions s
      WHERE s.provider = 'claude' AND COALESCE(s.isArchived, 0) = 0
        AND (SELECT COUNT(*) FROM session_participants sp WHERE sp.session_id = s.session_id
          AND sp.role = 'owner' AND sp.attribution = 'spawn') = 1
        AND EXISTS (SELECT 1 FROM session_participants sp WHERE sp.session_id = s.session_id
          AND sp.role = 'owner' AND sp.attribution = 'spawn' AND sp.user_id = ?)
      ORDER BY COALESCE(s.updated_at, s.created_at) DESC, s.session_id ASC LIMIT ?`)
      .all(userId, limit) as OwnedSessionRow[];
  },

  /** The session's last reported `total_cost_usd`, or null when never seen. */
  getCostTotal(sessionId: string): number | null {
    const row = getConnection().prepare('SELECT total_cost_usd FROM peer_session_cost_totals WHERE session_id = ?')
      .get(sessionId) as { total_cost_usd: number } | undefined;
    return row ? row.total_cost_usd : null;
  },

  /** Records the session's latest `total_cost_usd` (the next peer turn's baseline). */
  setCostTotal(sessionId: string, totalUsd: number, nowMs: number): void {
    getConnection().prepare(`INSERT INTO peer_session_cost_totals (session_id, total_cost_usd, updated_at)
      VALUES (?, ?, ?) ON CONFLICT(session_id) DO UPDATE SET total_cost_usd = excluded.total_cost_usd,
      updated_at = excluded.updated_at`).run(sessionId, totalUsd, nowMs);
  },

  /** The effective permission mode the member's last spawn of the session ran with, or null. */
  getSessionMode(sessionId: string, ownerUserId: number): string | null {
    const row = getConnection().prepare(`SELECT permission_mode FROM session_permission_modes
      WHERE session_id = ? AND owner_user_id = ?`).get(sessionId, ownerUserId) as { permission_mode: string } | undefined;
    return row ? row.permission_mode : null;
  },

  /** Records the mode a spawn actually handed the CLI (the newest spawn wins). */
  setSessionMode(sessionId: string, ownerUserId: number, permissionMode: string, nowMs: number): void {
    getConnection().prepare(`INSERT INTO session_permission_modes (session_id, owner_user_id, permission_mode, updated_at)
      VALUES (?, ?, ?, ?) ON CONFLICT(session_id, owner_user_id) DO UPDATE SET
      permission_mode = excluded.permission_mode, updated_at = excluded.updated_at`).run(sessionId, ownerUserId, permissionMode, nowMs);
  },

  /** The hop of the run an agent was born in; 0 when unknown (born in a human run). */
  getAgentOriginHop(sessionId: string, agentId: string): number {
    const row = getConnection().prepare(`SELECT origin_hop FROM peer_agent_origin_hops
      WHERE session_id = ? AND agent_id = ?`).get(sessionId, agentId) as { origin_hop: number } | undefined;
    return row ? row.origin_hop : 0;
  },

  /** Records an agent's origin hop once; a later (lower) value never overwrites it. */
  recordAgentOriginHop(sessionId: string, agentId: string, originHop: number, nowMs: number): void {
    getConnection().prepare(`INSERT INTO peer_agent_origin_hops (session_id, agent_id, origin_hop, created_at)
      VALUES (?, ?, ?, ?) ON CONFLICT(session_id, agent_id) DO UPDATE SET
      origin_hop = MAX(origin_hop, excluded.origin_hop)`).run(sessionId, agentId, originHop, nowMs);
  },
};
