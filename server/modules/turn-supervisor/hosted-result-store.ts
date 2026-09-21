
import type { Database } from 'better-sqlite3';

// eslint-disable-next-line boundaries/no-unknown -- root-verified process context is a builtins-only leaf outside feature barrels.
import { requireStartupAdmission } from '../../bootstrap-startup-context.js';

export const HOSTED_RESULT_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS turn_supervisor_hosted_context (
  turn_id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  session_id TEXT NOT NULL,
  is_new_session INTEGER NOT NULL CHECK (is_new_session IN (0, 1)),
  project_path TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (turn_id) REFERENCES turn_supervisor_turns(turn_id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS turn_supervisor_hosted_results (
  turn_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  session_id TEXT NOT NULL,
  is_new_session INTEGER NOT NULL CHECK (is_new_session IN (0, 1)),
  text TEXT NOT NULL,
  project_path TEXT,
  transcript_state TEXT NOT NULL DEFAULT 'pending'
    CHECK (transcript_state IN ('pending', 'writing', 'written')),
  writer_owner_id TEXT,
  writer_owner_pid INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (turn_id) REFERENCES turn_supervisor_turns(turn_id) ON DELETE CASCADE,
  FOREIGN KEY (run_id) REFERENCES turn_supervisor_runs(run_id) ON DELETE CASCADE
);
`;

export type DurableHostedResult = {
  turnId: string; runId: string; provider: 'kimi' | 'deepseek' | 'glm' | 'codex' | 'claude' | 'qwen' | 'opencode' | 'hermes'; model: string;
  sessionId: string; isNewSession: boolean; projectPath?: string; text: string;
  transcriptState: 'pending' | 'writing' | 'written';
};

function row(value: Record<string, unknown>): DurableHostedResult {
  return {
    turnId: String(value.turn_id), runId: String(value.run_id),
    provider: String(value.provider) as DurableHostedResult['provider'], model: String(value.model),
    sessionId: String(value.session_id), isNewSession: Number(value.is_new_session) === 1,
    ...(typeof value.project_path === 'string' ? { projectPath: value.project_path } : {}),
    text: String(value.text), transcriptState: String(value.transcript_state) as DurableHostedResult['transcriptState'],
  };
}

export class HostedResultStore {
  constructor(
    private readonly db: Database,
    private readonly owner = { id: `result-writer:${process.pid}`, pid: process.pid },
    private readonly now = () => new Date().toISOString(),
  ) {
    const columns = new Set((db.prepare(
      'PRAGMA table_info(turn_supervisor_hosted_results)',
    ).all() as { name: string }[]).map(({ name }) => name));
    if (requireStartupAdmission()) {
      const context = db.prepare('PRAGMA table_info(turn_supervisor_hosted_context)').all() as { name: string }[];
      if (!['writer_owner_id', 'writer_owner_pid', 'project_path'].every(name => columns.has(name))
        || !context.some(column => column.name === 'project_path')) throw new Error('existing_security_result_schema_missing');
      return;
    }
    if (!columns.has('writer_owner_id')) db.exec('ALTER TABLE turn_supervisor_hosted_results ADD COLUMN writer_owner_id TEXT');
    if (!columns.has('writer_owner_pid')) db.exec('ALTER TABLE turn_supervisor_hosted_results ADD COLUMN writer_owner_pid INTEGER');
    if (!columns.has('project_path')) db.exec('ALTER TABLE turn_supervisor_hosted_results ADD COLUMN project_path TEXT');
    const contextColumns = new Set((db.prepare(
      'PRAGMA table_info(turn_supervisor_hosted_context)',
    ).all() as { name: string }[]).map(({ name }) => name));
    if (!contextColumns.has('project_path')) db.exec('ALTER TABLE turn_supervisor_hosted_context ADD COLUMN project_path TEXT');
  }

  get(turnId: string): DurableHostedResult | null {
    const found = this.db.prepare(
      'SELECT * FROM turn_supervisor_hosted_results WHERE turn_id = ?',
    ).get(turnId) as Record<string, unknown> | undefined;
    return found ? row(found) : null;
  }

  listPending(providers?: readonly DurableHostedResult['provider'][]): readonly DurableHostedResult[] {
    const where = providers?.length
      ? ` AND provider IN (${providers.map(() => '?').join(', ')})`
      : '';
    return (this.db.prepare(
      `SELECT * FROM turn_supervisor_hosted_results WHERE transcript_state = 'pending'${where} ORDER BY created_at`,
    ).all(...(providers ?? [])) as Record<string, unknown>[]).map(row);
  }

  getOrCreateContext(input: {
    turnId: string; provider: DurableHostedResult['provider']; model: string;
    sessionId: string; isNewSession: boolean;
    projectPath?: string;
  }): Omit<DurableHostedResult, 'runId' | 'text' | 'transcriptState'> {
    return this.db.transaction(() => {
      this.db.prepare(
        `INSERT OR IGNORE INTO turn_supervisor_hosted_context
          (turn_id, provider, model, session_id, is_new_session, project_path, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        input.turnId, input.provider, input.model, input.sessionId,
        input.isNewSession ? 1 : 0, input.projectPath ?? null, this.now(),
      );
      const value = this.db.prepare(
        'SELECT * FROM turn_supervisor_hosted_context WHERE turn_id = ?',
      ).get(input.turnId) as Record<string, unknown>;
      if (String(value.provider) !== input.provider || String(value.model) !== input.model) {
        throw new Error('hosted turn context mismatch');
      }
      return {
        turnId: input.turnId,
        provider: String(value.provider) as DurableHostedResult['provider'],
        model: String(value.model),
        sessionId: String(value.session_id),
        isNewSession: Number(value.is_new_session) === 1,
        ...(typeof value.project_path === 'string' ? { projectPath: value.project_path } : {}),
      };
    }).immediate();
  }

  claimTranscript(turnId: string): DurableHostedResult | null {
    return this.db.transaction(() => {
      const changed = this.db.prepare(
        `UPDATE turn_supervisor_hosted_results SET transcript_state = 'writing',
           writer_owner_id = ?, writer_owner_pid = ?, updated_at = ?
         WHERE turn_id = ? AND transcript_state = 'pending'`,
      ).run(this.owner.id, this.owner.pid, this.now(), turnId).changes;
      if (changed !== 1) return null;
      return this.get(turnId);
    }).immediate();
  }

  markTranscriptWritten(turnId: string): boolean {
    return this.db.prepare(
      `UPDATE turn_supervisor_hosted_results SET transcript_state = 'written',
         writer_owner_id = NULL, writer_owner_pid = NULL, updated_at = ?
       WHERE turn_id = ? AND transcript_state = 'writing' AND writer_owner_id = ?`,
    ).run(this.now(), turnId, this.owner.id).changes === 1;
  }

  recoverInterruptedTranscriptWrites(isDead: (pid: number) => boolean): number {
    const rows = this.db.prepare(
      "SELECT turn_id, writer_owner_pid FROM turn_supervisor_hosted_results WHERE transcript_state = 'writing'",
    ).all() as { turn_id: string; writer_owner_pid: number | null }[];
    let recovered = 0;
    for (const row of rows) {
      if (row.writer_owner_pid != null && !isDead(row.writer_owner_pid)) continue;
      recovered += this.db.prepare(
        `UPDATE turn_supervisor_hosted_results SET transcript_state = 'pending',
           writer_owner_id = NULL, writer_owner_pid = NULL, updated_at = ?
         WHERE turn_id = ? AND transcript_state = 'writing'
           AND (writer_owner_pid = ? OR (? IS NULL AND writer_owner_pid IS NULL))`,
      ).run(this.now(), row.turn_id, row.writer_owner_pid, row.writer_owner_pid).changes;
    }
    return recovered;
  }

  returnTranscriptPending(turnId: string): boolean {
    return this.db.prepare(
      `UPDATE turn_supervisor_hosted_results SET transcript_state = 'pending',
         writer_owner_id = NULL, writer_owner_pid = NULL, updated_at = ?
       WHERE turn_id = ? AND transcript_state = 'writing' AND writer_owner_id = ?`,
    ).run(this.now(), turnId, this.owner.id).changes === 1;
  }
}
