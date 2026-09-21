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
