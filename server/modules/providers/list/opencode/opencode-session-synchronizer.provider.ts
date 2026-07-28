import fsSync from 'node:fs';
import path from 'node:path';

import Database from 'better-sqlite3';

import { participantsDb, sessionsDb } from '@/modules/database/index.js';
import type { IProviderSessionSynchronizer } from '@/shared/interfaces.js';
import {
  normalizeProviderTimestamp,
  normalizeSessionName,
  readJsonRecord,
  readOptionalString,
} from '@/shared/utils.js';

import {
  openCodeDataHomeForSessionFile,
  resolveOpenCodeDataHomeOwner,
  resolveOpenCodeDataHomes,
} from './opencode-home.js';

type OpenCodeSessionRow = {
  id: string;
  parent_id: string | null;
  directory: string | null;
  title: string | null;
  time_created: number | null;
  time_updated: number | null;
  worktree: string | null;
};

type SynchronizeRowsResult = {
  processed: number;
  firstSessionId: string | null;
};

/**
 * Session indexer for OpenCode's SQLite-backed session store.
 *
 * Provider-agnostic within opencode: a GLM carrier turn (GL-8) writes to the SAME
 * per-user opencode.db as any other opencode session, so the OC-07 per-user scan
 * (resolveOpenCodeDataHomes) already indexes carrier sessions under the right owner
 * with no carrier-specific branch — the only GL-9 addition here is B-172 child-thread
 * dedup (see upsertSession).
 */
export class OpenCodeSessionSynchronizer implements IProviderSessionSynchronizer {
  private readonly provider = 'opencode' as const;

  /**
   * Scans every opencode.db (operator + each isolated user's, OC-07) and upserts
   * active sessions into DB. In shared mode resolveOpenCodeDataHomes collapses to
   * the single operator dir, so this is byte-for-byte the pre-OC-07 scan.
   */
  async synchronize(since?: Date): Promise<number> {
    let processed = 0;
    for (const dataHome of resolveOpenCodeDataHomes()) {
      const dbPath = path.join(dataHome, 'opencode.db');
      // Each data dir's owner (operator dir → platform owner, an isolated dir →
      // its user) is the attribution target for the externally-created sessions
      // it holds (T-857, part ب).
      const ownerUserId = resolveOpenCodeDataHomeOwner(dataHome);
      processed += this.synchronizeRows(dbPath, ownerUserId, since).processed;
    }
    return processed;
  }

  /**
   * Handles watcher changes for a specific opencode.db (its owning data dir is
   * the file's parent, so an isolated user's DB syncs from its own tree).
   */
  async synchronizeFile(filePath: string): Promise<string | null> {
    if (path.basename(filePath) !== 'opencode.db') {
      return null;
    }

    const dataHome = openCodeDataHomeForSessionFile(filePath);
    const dbPath = path.join(dataHome, 'opencode.db');
    const ownerUserId = resolveOpenCodeDataHomeOwner(dataHome);
    const result = this.synchronizeRows(dbPath, ownerUserId, undefined, 1);
    return result.firstSessionId;
  }

  private synchronizeRows(
    dbPath: string,
    ownerUserId: number | null,
    since?: Date,
    limit?: number,
  ): SynchronizeRowsResult {
    if (!fsSync.existsSync(dbPath)) {
      return { processed: 0, firstSessionId: null };
    }

    const db = new Database(dbPath, { readonly: true, fileMustExist: true });
    try {
      const sinceMillis = since?.getTime() ?? null;
      const limitClause = limit ? 'LIMIT ?' : '';
      const params = limit ? [sinceMillis, sinceMillis, limit] : [sinceMillis, sinceMillis];
      const rows = db.prepare(`
        SELECT
          s.id AS id,
          s.parent_id AS parent_id,
          s.directory AS directory,
          s.title AS title,
          s.time_created AS time_created,
          s.time_updated AS time_updated,
          p.worktree AS worktree
        FROM session s
        LEFT JOIN project p ON p.id = s.project_id
        WHERE s.time_archived IS NULL
          AND (? IS NULL OR COALESCE(s.time_updated, s.time_created, 0) >= ?)
        ORDER BY COALESCE(s.time_updated, s.time_created, 0) DESC, s.id DESC
        ${limitClause}
      `).all(...params) as OpenCodeSessionRow[];

      // B-172 dedup: opencode stamps a non-null `parent_id` on every CHILD session — a
      // subagent thread the carrier (or any opencode agent) spawns under a top-level
      // conversation. Each child carries the same directory + a near-identical
      // auto-title, so indexing each one as its own row reproduced the "one conversation
      // repeated dozens of times" sidebar bug (B-172, the codex-parity fix). Parents are
      // upserted FIRST, then children are folded — never registered as their own row,
      // only bumping the parent's freshness. The two-pass order guarantees the parent
      // row exists before its (newer, so scanned-first) children try to bump it, since
      // the query returns newest-first; bumpSessionUpdatedAt stays a safe no-op for any
      // orphan child whose parent is absent.
      const parentRows: OpenCodeSessionRow[] = [];
      const childRows: OpenCodeSessionRow[] = [];
      for (const row of rows) {
        if (readOptionalString(row.parent_id)) {
          childRows.push(row);
        } else {
          parentRows.push(row);
        }
      }

      let processed = 0;
      let firstSessionId: string | null = null;
      for (const row of parentRows) {
        const indexedSessionId = this.upsertSession(db, row, ownerUserId);
        if (!indexedSessionId) {
          continue;
        }

        if (!firstSessionId) {
          firstSessionId = indexedSessionId;
        }
        processed += 1;
      }

      for (const row of childRows) {
        this.foldChildSession(row);
      }

      return { processed, firstSessionId };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn('[OpenCodeProvider] Failed to synchronize sessions:', message);
      return { processed: 0, firstSessionId: null };
    } finally {
      db.close();
    }
  }

  private upsertSession(
    db: Database.Database,
    row: OpenCodeSessionRow,
    ownerUserId: number | null,
  ): string | null {
    const sessionId = readOptionalString(row.id);
    const projectPath = readOptionalString(row.directory) ?? readOptionalString(row.worktree);
    if (!sessionId || !projectPath) {
      return null;
    }

    const fallbackTitle = 'Untitled OpenCode Session';
    const existingSession = sessionsDb.getSessionById(sessionId);
    const existingName = existingSession?.custom_name;
    const nextName = existingName && existingName !== fallbackTitle
      ? existingName
      : readOptionalString(row.title) ?? this.readFirstUserText(db, sessionId);

    // OpenCode stores every session in one shared sqlite database, so jsonl_path
    // must stay null to avoid deleting opencode.db when one app session is removed.
    sessionsDb.createSession(
      sessionId,
      this.provider,
      projectPath,
      normalizeSessionName(nextName, fallbackTitle),
      normalizeProviderTimestamp(row.time_created),
      normalizeProviderTimestamp(row.time_updated ?? row.time_created),
      null,
    );

    // Data-provenance attribution (T-857, part ب): an opencode session created
    // outside this server (a TUI run, or any spawn that did not flow through the
    // web recordSpawn path) has no participant row, so it fails the "native
    // session" predicate and never appears in the conversations list. Attribute
    // it to the owner of the data dir it came from — WITHOUT touching the
    // predicate. Idempotent: skipped once the session already has an owner, so a
    // web-spawned session (already recorded) is never re-attributed and a repeat
    // rescan never inflates message_count. This also backfills the sessions that
    // were indexed before this fix shipped, on the first synchronize after
    // deploy. recordSpawn self-heals the parent row and never throws.
    if (ownerUserId !== null && !participantsDb.hasParticipant(sessionId)) {
      participantsDb.recordSpawn(sessionId, ownerUserId, {
        provider: this.provider,
        projectPath,
      });
    }

    return sessionId;
  }

  /**
   * B-172: folds a CHILD session (non-null parent_id) under its parent instead of
   * indexing it as a standalone row. Best-effort bump of the parent's updated_at keeps
   * the conversation surfacing recent activity. bumpSessionUpdatedAt is a strict no-op
   * when the parent row is missing or the bump would rewind it, so a folded child can
   * NEVER create, resurrect or rewind a session row.
   */
  private foldChildSession(row: OpenCodeSessionRow): void {
    const parentId = readOptionalString(row.parent_id);
    if (!parentId) {
      return;
    }
    sessionsDb.bumpSessionUpdatedAt(
      parentId,
      normalizeProviderTimestamp(row.time_updated ?? row.time_created),
    );
  }

  private readFirstUserText(db: Database.Database, sessionId: string): string | undefined {
    try {
      const row = db.prepare(`
        SELECT p.data AS data
        FROM message m
        INNER JOIN part p
          ON p.session_id = m.session_id
         AND p.message_id = m.id
        WHERE m.session_id = ?
          AND json_extract(m.data, '$.role') = 'user'
          AND json_extract(p.data, '$.type') = 'text'
        ORDER BY COALESCE(m.time_created, 0), COALESCE(p.time_created, 0)
        LIMIT 1
      `).get(sessionId) as { data: string | null } | undefined;

      const data = readJsonRecord(row?.data);
      return readOptionalString(data?.text);
    } catch {
      return undefined;
    }
  }
}
