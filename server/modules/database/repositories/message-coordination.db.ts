import crypto from 'node:crypto';

import { getConnection } from '@/modules/database/connection.js';
import { hashMessageAuthorContent } from '@/modules/database/repositories/message-authors.db.js';

/** Structural view of the providers-module HistoryReadLease; no cross-module import (T-1632). */
type HistoryReadLease = {
  queryRows<T>(db: ReturnType<typeof getConnection>, sql: string, parameters: readonly unknown[]): T[];
};

export type StoredCoordinationLevel = 'direct' | 'delegate' | 'delegate_review';
export type MessageCoordinationRow = {
  clientMsgId: string;
  sessionId: string | null;
  userId: number;
  provider: string;
  canonicalContent: string;
  contentHash: string;
  coordinationLevel: StoredCoordinationLevel;
  createdAt: string;
};
export type CoordinationClaimResult =
  | { action: 'dispatch' }
  | { action: 'fingerprint_mismatch' }
  | { action: 'ambiguous_started' }
  | { action: 'replay_verdict'; verdict: Record<string, unknown> };

function fingerprint(input: {
  userId: number; provider: string; sessionId: string | null;
  clientMsgId: string; canonicalContent: string; coordinationLevel: StoredCoordinationLevel;
  attachmentFingerprint?: string;
}): string {
  const canonical = [
    input.userId, input.provider, input.sessionId, input.clientMsgId,
    input.canonicalContent, input.coordinationLevel,
  ];
  if (input.attachmentFingerprint) canonical.push(input.attachmentFingerprint);
  return crypto.createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

export const messageCoordinationDb = {
  /** Bounded successful Codex verdicts within the authenticated owner/session; no schema change. */
  readCodexVerdicts(userId: number, sessionId: string,
    lease?: { queryRows: (db: ReturnType<typeof getConnection>, sql: string, parameters: any[]) => unknown[] }) {
    if (!Number.isSafeInteger(userId) || userId <= 0 || !sessionId || sessionId.length > 256) return [];
    const db = getConnection(), sql = `SELECT client_msg_id AS clientMsgId,
      CASE WHEN length(verdict_json) <= 8192 THEN verdict_json ELSE NULL END AS verdictJson
      FROM message_coordination_ingress INDEXED BY idx_message_coordination_session
      WHERE session_id = ? AND user_id = ? AND provider = 'codex' AND lifecycle_status = 'terminal'
      ORDER BY id LIMIT 1001`;
    const rows = (lease ? lease.queryRows(db, sql, [sessionId, userId])
      : db.prepare(sql).all(sessionId, userId)) as Array<{ clientMsgId: string; verdictJson: string }>;
    return rows.length > 1000 ? [] : rows;
  },
  /** Reads one durable receipt only within its authenticated ownership scope. */
  readDelivery(input: { clientMsgId: string; sessionId: string; userId: number; provider: string }) {
    return getConnection().prepare(
      `SELECT client_msg_id AS clientMsgId, session_id AS sessionId, provider,
              canonical_content AS content, created_at AS createdAt,
              lifecycle_status AS lifecycleStatus, verdict_json AS verdictJson, accepted_at AS acceptedAt
       FROM message_coordination_ingress
       WHERE client_msg_id = ? AND session_id = ? AND user_id = ? AND provider = ?`,
    ).get(input.clientMsgId, input.sessionId, input.userId, input.provider) as {
      clientMsgId: string; sessionId: string; provider: string; content: string;
      createdAt: string; lifecycleStatus: string; verdictJson: string | null; acceptedAt: string | null;
    } | undefined;
  },

  /** Bind one newly allocated native identity before dispatch; no replay or replacement. */
  bindClaudeIdentity(input: { clientMsgId: string; userId: number; sessionId: string | null;
    provider: string; uuid: string; payloadSha256: string }): boolean {
    if (input.provider !== 'claude' || !Number.isSafeInteger(input.userId) || input.userId <= 0
      || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(input.clientMsgId)
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(input.uuid)
      || !/^[0-9a-f]{64}$/u.test(input.payloadSha256)
      || (input.sessionId !== null && (!input.sessionId || Buffer.byteLength(input.sessionId) > 256))) return false;
    return getConnection().prepare(`UPDATE OR IGNORE message_coordination_ingress
      SET claude_user_uuid = ?, claude_payload_sha256 = ?
      WHERE client_msg_id = ? AND user_id = ? AND provider = 'claude' AND session_id IS ?
        AND lifecycle_status = 'claimed' AND accepted_at IS NULL
        AND claude_user_uuid IS NULL AND claude_payload_sha256 IS NULL`)
      .run(input.uuid, input.payloadSha256, input.clientMsgId, input.userId, input.sessionId).changes === 1;
  },

  /** Bounded indexed owner-only projection; never scan another participant's receipts. */
  readClaudeIdentities(userId: number, sessionId: string, lease?: HistoryReadLease) {
    if (!Number.isSafeInteger(userId) || userId <= 0 || !sessionId || Buffer.byteLength(sessionId) > 256) return [];
    const db = getConnection(), sql = `SELECT client_msg_id AS clientMsgId, claude_user_uuid AS uuid,
      claude_payload_sha256 AS payloadSha256, accepted_at AS acceptedAt,
      lifecycle_status AS lifecycleStatus, verdict_json AS verdictJson
      FROM message_coordination_ingress INDEXED BY idx_coordination_claude_owner_session
      WHERE user_id = ? AND provider = 'claude'
        AND session_id = ? AND claude_user_uuid IS NOT NULL ORDER BY id LIMIT 1001`;
    const rows = (lease ? lease.queryRows(db, sql, [userId, sessionId]) : db.prepare(sql).all(userId, sessionId)) as Array<{clientMsgId: string; uuid: string; payloadSha256: string;
        acceptedAt: string | null; lifecycleStatus: string; verdictJson: string | null}>;
    return rows.length > 1000 ? [] : rows;
  },

  /** Atomic ingress claim. The first accepted payload is immutable. */
  claim(input: {
    sessionId: string | null; clientMsgId: string; userId: number; provider: string;
    canonicalContent: string; coordinationLevel: StoredCoordinationLevel;
    attachmentFingerprint?: string;
  }): CoordinationClaimResult {
    const validAttachmentFingerprint = typeof input.attachmentFingerprint === 'string'
      && /^[0-9a-f]{64}$/u.test(input.attachmentFingerprint);
    if (!input.clientMsgId || !Number.isInteger(input.userId) || !input.provider
      || (!input.canonicalContent.trim() && !validAttachmentFingerprint)
      || (input.attachmentFingerprint !== undefined && !validAttachmentFingerprint)) {
      return { action: 'fingerprint_mismatch' };
    }
    const requestFingerprint = fingerprint(input);
    const db = getConnection();
    const result = db.prepare(
      `INSERT OR IGNORE INTO message_coordination_ingress
        (session_id, client_msg_id, user_id, provider, canonical_content, content_hash,
         request_fingerprint, coordination_level, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      input.sessionId, input.clientMsgId, input.userId, input.provider,
      input.canonicalContent, hashMessageAuthorContent(input.canonicalContent),
      requestFingerprint, input.coordinationLevel, new Date().toISOString(),
    );
    if (result.changes === 1) return { action: 'dispatch' };
    const existing = db.prepare(
      `SELECT request_fingerprint AS requestFingerprint, lifecycle_status AS lifecycleStatus,
              verdict_json AS verdictJson
       FROM message_coordination_ingress WHERE client_msg_id = ?`,
    ).get(input.clientMsgId) as {
      requestFingerprint: string; lifecycleStatus: string; verdictJson: string | null;
    } | undefined;
    if (existing?.requestFingerprint !== requestFingerprint) return { action: 'fingerprint_mismatch' };
    if (existing.lifecycleStatus === 'not_started') {
      const reclaimed = db.prepare(
        `UPDATE message_coordination_ingress
         SET lifecycle_status = 'claimed', verdict_json = NULL
         WHERE client_msg_id = ? AND request_fingerprint = ? AND lifecycle_status = 'not_started'`,
      ).run(input.clientMsgId, requestFingerprint);
      return reclaimed.changes === 1 ? { action: 'dispatch' } : { action: 'ambiguous_started' };
    }
    if (existing.lifecycleStatus === 'terminal' && existing.verdictJson) {
      try {
        const verdict = JSON.parse(existing.verdictJson) as unknown;
        if (verdict && typeof verdict === 'object' && !Array.isArray(verdict)) {
          return { action: 'replay_verdict', verdict: verdict as Record<string, unknown> };
        }
      } catch {
        // Corrupt/missing verdict is ambiguous: never dispatch a second effect.
      }
    }
    return { action: 'ambiguous_started' };
  },

  /** Persist first trusted activity only for an exactly bound ingress scope. */
  markStarted(input: { clientMsgId: string; userId: number; provider: string; sessionId: string }): boolean {
    if (!input.clientMsgId || !Number.isInteger(input.userId) || !input.provider || !input.sessionId) return false;
    return getConnection().prepare(
      `UPDATE message_coordination_ingress
       SET lifecycle_status = 'started', accepted_at = COALESCE(accepted_at, ?)
       WHERE client_msg_id = ? AND user_id = ? AND provider = ? AND session_id = ?
         AND lifecycle_status IN ('claimed', 'started')`,
    ).run(new Date().toISOString(), input.clientMsgId, input.userId, input.provider, input.sessionId).changes === 1;
  },

  recordVerdict(
    scope: { clientMsgId: string; userId: number; provider: string; sessionId: string | null },
    status: 'not_started' | 'terminal',
    verdict: Record<string, unknown>,
  ): void {
    let verdictJson: string;
    try {
      verdictJson = JSON.stringify(verdict);
    } catch {
      return;
    }
    const allowedPrior = status === 'not_started' ? "lifecycle_status = 'claimed'" : "lifecycle_status IN ('claimed', 'started')";
    getConnection().prepare(
      `UPDATE message_coordination_ingress
       SET lifecycle_status = ?, verdict_json = ?
       WHERE client_msg_id = ? AND user_id = ? AND provider = ? AND session_id IS ? AND ${allowedPrior}`,
    ).run(status, verdictJson, scope.clientMsgId, scope.userId, scope.provider, scope.sessionId);
  },

  bindSession(clientMsgId: string, userId: number, sessionId: string, provider: string): boolean {
    if (!clientMsgId || !sessionId || !provider || !Number.isInteger(userId)) return false;
    const result = getConnection().prepare(
      `UPDATE message_coordination_ingress SET session_id = ?
       WHERE client_msg_id = ? AND user_id = ? AND provider = ? AND (session_id IS NULL OR session_id = ?)`,
    ).run(sessionId, clientMsgId, userId, provider, sessionId);
    return result.changes === 1;
  },

  listBySession(sessionId: string, lease?: HistoryReadLease): MessageCoordinationRow[] {
    if (!sessionId) return [];
    const sql = `SELECT client_msg_id AS clientMsgId, session_id AS sessionId, user_id AS userId,
              provider, canonical_content AS canonicalContent, content_hash AS contentHash,
              coordination_level AS coordinationLevel, created_at AS createdAt
       FROM message_coordination_ingress WHERE session_id = ? ORDER BY id ASC`;
    const db = getConnection();
    return lease ? lease.queryRows<MessageCoordinationRow>(db, sql, [sessionId])
      : db.prepare(sql).all(sessionId) as MessageCoordinationRow[];
  },
};
