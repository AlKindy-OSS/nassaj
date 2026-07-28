/**
 * Session agents cache repository.
 *
 * Persists the parsed non-human actors of a session transcript — the base model
 * ('model') and any spawned subagents ('subagent') — plus a freshness sentinel
 * keyed on the transcript file mtime so the parser can skip unchanged files.
 *
 * Tables: session_agents_cache, session_agents_meta. All access uses prepared
 * statements.
 */

import { getConnection } from '@/modules/database/connection.js';

export type AgentKind = 'model' | 'subagent';

export type SessionAgentRow = {
  agent_name: string;
  agent_kind: AgentKind;
  invocation_count: number;
  /** Resolved model string for this agent (e.g. 'claude-fable-5', 'claude-sonnet-4-6').
   * Present for the coordinator model and for subagents whose model was recoverable
   * from their sidecar JSONL transcript. Null when not available. */
  agent_model?: string | null;
};

type AgentMetaRow = {
  transcript_mtime: number;
};

export const sessionAgentsDb = {
  /** Returns the cached transcript mtime for a session, or null if never parsed. */
  getMeta(sessionId: string): number | null {
    const db = getConnection();
    const row = db
      .prepare('SELECT transcript_mtime FROM session_agents_meta WHERE session_id = ?')
      .get(sessionId) as AgentMetaRow | undefined;
    return row ? row.transcript_mtime : null;
  },

  /** Returns the cached agent rows for a session. */
  listBySession(sessionId: string): SessionAgentRow[] {
    const db = getConnection();
    return db
      .prepare(
        `SELECT agent_name, agent_kind, invocation_count, agent_model
         FROM session_agents_cache
         WHERE session_id = ?
         ORDER BY CASE agent_kind WHEN 'model' THEN 0 ELSE 1 END, agent_name ASC`
      )
      .all(sessionId) as SessionAgentRow[];
  },

  /**
   * Atomically replaces the cached agents for a session and stamps the meta row
   * with the transcript mtime used to produce them. A single transaction so a
   * concurrent reader never sees a half-written cache.
   */
  replaceForSession(
    sessionId: string,
    agents: SessionAgentRow[],
    transcriptMtime: number
  ): void {
    const db = getConnection();
    const clear = db.prepare('DELETE FROM session_agents_cache WHERE session_id = ?');
    const insert = db.prepare(
      `INSERT INTO session_agents_cache (session_id, agent_name, agent_kind, invocation_count, agent_model)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(session_id, agent_name, agent_kind) DO UPDATE SET
         invocation_count = excluded.invocation_count,
         agent_model = COALESCE(excluded.agent_model, agent_model)`
    );
    const upsertMeta = db.prepare(
      `INSERT INTO session_agents_meta (session_id, transcript_mtime, parsed_at)
       VALUES (?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(session_id) DO UPDATE SET
         transcript_mtime = excluded.transcript_mtime,
         parsed_at = CURRENT_TIMESTAMP`
    );

    const run = db.transaction((rows: SessionAgentRow[]) => {
      clear.run(sessionId);
      for (const a of rows) {
        insert.run(sessionId, a.agent_name, a.agent_kind, a.invocation_count, a.agent_model ?? null);
      }
      upsertMeta.run(sessionId, transcriptMtime);
    });
    run(agents);
  },

  /**
   * Aggregates agents across many sessions (a project view). Summed
   * invocation_count per (agent_name, agent_kind). Reads from cache only — the
   * caller is responsible for having parsed each session beforehand.
   */
  aggregateBySessionIds(sessionIds: string[]): SessionAgentRow[] {
    if (sessionIds.length === 0) {
      return [];
    }

    const db = getConnection();
    const placeholders = sessionIds.map(() => '?').join(', ');
    return db
      .prepare(
        `SELECT agent_name, agent_kind, SUM(invocation_count) AS invocation_count,
                MAX(agent_model) AS agent_model
         FROM session_agents_cache
         WHERE session_id IN (${placeholders})
         GROUP BY agent_name, agent_kind
         ORDER BY CASE agent_kind WHEN 'model' THEN 0 ELSE 1 END, agent_name ASC`
      )
      .all(...sessionIds) as SessionAgentRow[];
  },
};
