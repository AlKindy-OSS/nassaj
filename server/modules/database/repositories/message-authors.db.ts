/**
 * Message authors repository (B-MU-UX-FIX-MSG-AUTHOR).
 *
 * Sidecar attribution store for user-authored chat messages in multi-user
 * sessions. The provider CLI/SDK — not this server — writes the transcript
 * .jsonl, so the sender's identity cannot be embedded in the transcript line
 * without breaking format compatibility with the official CLIs. Instead the
 * run path records one row per sent prompt here (table: message_authors),
 * keyed by session_id + SHA-256 of the trimmed prompt text, and history loads
 * stamp `userId` back onto normalized user text messages by hash plus
 * timestamp proximity.
 *
 * Writes never throw: attribution must not break the run path, so failures
 * are logged and swallowed (same policy as participants.db.ts). All access
 * uses prepared statements.
 */

import crypto from 'node:crypto';

import { getConnection } from '@/modules/database/connection.js';

export type MessageAuthorRow = {
  userId: number;
  contentHash: string;
  createdAt: string;
};

/**
 * Canonical content hash used on BOTH the record side (raw prompt sent to the
 * provider) and the lookup side (normalized transcript text). Trimming is the
 * only normalization applied — the transcript stores the prompt verbatim, so
 * anything heavier would create false matches.
 */
export function hashMessageAuthorContent(content: string): string {
  return crypto.createHash('sha256').update(content.trim(), 'utf8').digest('hex');
}

export const messageAuthorsDb = {
  /**
   * Records the authenticated sender of one user prompt at spawn time.
   *
   * `created_at` is stored as an ISO-8601 UTC string written by JS (not SQLite
   * CURRENT_TIMESTAMP) so the history-stamping side can Date.parse it without
   * timezone ambiguity against transcript timestamps.
   */
  recordUserMessage(sessionId: string, userId: number, content: string): void {
    if (!sessionId || !Number.isInteger(userId)) {
      return;
    }
    const text = typeof content === 'string' ? content.trim() : '';
    if (!text) {
      return;
    }

    try {
      const db = getConnection();
      db.prepare(
        `INSERT INTO message_authors (session_id, user_id, content_hash, created_at)
         VALUES (?, ?, ?, ?)`
      ).run(sessionId, userId, hashMessageAuthorContent(text), new Date().toISOString());
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error('Failed to record message author', { sessionId, userId, error: message });
    }
  },

  /**
   * Lists the recorded author rows of a session, oldest first, for the
   * history-stamping pass.
   */
  listBySession(sessionId: string): MessageAuthorRow[] {
    if (!sessionId) {
      return [];
    }
    const db = getConnection();
    return db
      .prepare(
        `SELECT
           user_id      AS userId,
           content_hash AS contentHash,
           created_at   AS createdAt
         FROM message_authors
         WHERE session_id = ?
         ORDER BY id ASC`
      )
      .all(sessionId) as MessageAuthorRow[];
  },
};
