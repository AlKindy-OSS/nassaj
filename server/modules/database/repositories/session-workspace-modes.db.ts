import { getConnection } from '@/modules/database/connection.js';

export type SessionWorkspaceMode = 'legacy_shared' | 'overlay';
export type SessionWorkspaceModeRow = {
  sessionId: string;
  mode: SessionWorkspaceMode;
  projectPath: string;
  provider: string;
  classifiedAt: string;
};

type StoredRow = {
  session_id: string;
  mode: SessionWorkspaceMode;
  project_path: string;
  provider: string;
  classified_at: string;
};

export const sessionWorkspaceModesDb = {
  listLegacySnapshot(): SessionWorkspaceModeRow[] {
    return (getConnection().prepare(`
      SELECT session_id, mode, project_path, provider, classified_at
      FROM session_workspace_modes WHERE mode = 'legacy_shared'
    `).all() as StoredRow[]).map((row) => ({
      sessionId: row.session_id,
      mode: row.mode,
      projectPath: row.project_path,
      provider: row.provider,
      classifiedAt: row.classified_at,
    }));
  },

  /** Strict eligibility read: the caller must match both migration snapshots. */
  readLegacyEligibility(
    sessionId: string,
    projectPath: string,
    provider: string,
  ): SessionWorkspaceModeRow | null {
    if (!sessionId || !projectPath || !provider) return null;
    const row = getConnection().prepare(`
      SELECT session_id, mode, project_path, provider, classified_at
      FROM session_workspace_modes
      WHERE session_id = ? AND mode = 'legacy_shared'
        AND project_path = ? AND provider = ?
    `).get(sessionId, projectPath, provider) as StoredRow | undefined;
    return row ? {
      sessionId: row.session_id,
      mode: row.mode,
      projectPath: row.project_path,
      provider: row.provider,
      classifiedAt: row.classified_at,
    } : null;
  },

  /**
   * Persist a newly-created shared workspace without ever weakening an
   * existing overlay classification. Replays are accepted only when every
   * immutable binding field is identical.
   */
  markShared(sessionId: string, projectPath: string, provider: string): void {
    if (!sessionId || !projectPath || !provider) throw new Error('invalid workspace ledger binding');
    getConnection().prepare(`
      INSERT INTO session_workspace_modes
        (session_id, mode, project_path, provider, classified_at)
      VALUES (?, 'legacy_shared', ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(session_id) DO NOTHING
    `).run(sessionId, projectPath, provider);
    const row = getConnection().prepare(`
      SELECT mode, project_path, provider
      FROM session_workspace_modes WHERE session_id = ?
    `).get(sessionId) as Pick<StoredRow, 'mode' | 'project_path' | 'provider'> | undefined;
    if (row?.mode !== 'legacy_shared'
        || row.project_path !== projectPath
        || row.provider !== provider) {
      throw new Error('workspace ledger binding conflicts with an existing classification');
    }
  },

  /**
   * Declared session handover (agy spawn key -> brain UUID): moves the ledger
   * row from `fromSessionId` to `toSessionId` in ONE transaction that first
   * proves every precondition against the committed state, so a concurrent
   * writer cannot slip between check and rekey:
   *   - `from` has the exact expected binding (mode, project, provider);
   *   - `to` has no ledger row;
   *   - no principal other than `principalUserId` participates in `to`;
   *   - `to` has a sessions row of the same provider and project;
   *   - `verifyTarget(row)` accepts that row (caller-owned evidence checks).
   * Throws, leaving nothing changed, when any check fails.
   */
  rekeyForHandover(input: {
    fromSessionId: string;
    toSessionId: string;
    mode: SessionWorkspaceMode;
    projectPath: string;
    provider: string;
    principalUserId: number | null;
    verifyTarget: (row: { provider: string; project_path: string; jsonl_path: string | null }) => void;
  }): void {
    const { fromSessionId, toSessionId, mode, projectPath, provider, principalUserId } = input;
    if (!fromSessionId || !toSessionId || fromSessionId === toSessionId || !projectPath || !provider) {
      throw new Error('invalid workspace handover');
    }
    const db = getConnection();
    db.transaction(() => {
      const source = db.prepare(`
        SELECT mode, project_path, provider FROM session_workspace_modes WHERE session_id = ?
      `).get(fromSessionId) as Pick<StoredRow, 'mode' | 'project_path' | 'provider'> | undefined;
      if (!source || source.mode !== mode || source.project_path !== projectPath
          || source.provider !== provider) {
        throw new Error('handover source binding does not match this launch');
      }
      if (db.prepare('SELECT 1 FROM session_workspace_modes WHERE session_id = ?').get(toSessionId)) {
        throw new Error('handover target already has a workspace binding');
      }
      const foreignParticipant = db.prepare(`
        SELECT 1 FROM session_participants
        WHERE session_id = ? AND (? IS NULL OR user_id <> ?) LIMIT 1
      `).get(toSessionId, principalUserId, principalUserId);
      if (foreignParticipant) throw new Error('handover target has another participant');
      const target = db.prepare(`
        SELECT provider, project_path, jsonl_path FROM sessions WHERE session_id = ?
      `).get(toSessionId) as { provider: string; project_path: string; jsonl_path: string | null } | undefined;
      if (!target || target.provider !== provider || target.project_path !== projectPath) {
        throw new Error('handover target session does not match this launch');
      }
      input.verifyTarget(target);
      const moved = db.prepare(
        'UPDATE session_workspace_modes SET session_id = ? WHERE session_id = ?',
      ).run(toSessionId, fromSessionId);
      if (moved.changes !== 1) throw new Error('handover ledger rekey did not apply');
    })();
  },

  /** Ratchets legacy_shared to overlay and never permits an overlay downgrade. */
  markOverlay(sessionId: string, projectPath: string, provider: string): void {
    if (!sessionId || !projectPath || !provider) throw new Error('invalid workspace ledger binding');
    getConnection().prepare(`
      INSERT INTO session_workspace_modes
        (session_id, mode, project_path, provider, classified_at)
      VALUES (?, 'overlay', ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(session_id) DO UPDATE SET
        mode = 'overlay',
        project_path = excluded.project_path,
        provider = excluded.provider,
        classified_at = CASE
          WHEN session_workspace_modes.mode = 'overlay'
          THEN session_workspace_modes.classified_at
          ELSE CURRENT_TIMESTAMP
        END
    `).run(sessionId, projectPath, provider);
  },
};
