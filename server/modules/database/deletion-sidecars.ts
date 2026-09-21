import type Database from 'better-sqlite3';

import { assertDeletionDependencies } from './deletion-dependency-manifest.js';

// Fixed SQL identifiers, never interpolated. The batch is persisted in the same transaction.
const SESSION_SIDECARS = [
 ['closed_sessions','DELETE FROM closed_sessions WHERE session_id IN (SELECT session_id FROM session_delete_batch_members WHERE operation_id=?)'],
 ['starred_sessions','DELETE FROM starred_sessions WHERE session_id IN (SELECT session_id FROM session_delete_batch_members WHERE operation_id=?)'],
 ['message_authors','DELETE FROM message_authors WHERE session_id IN (SELECT session_id FROM session_delete_batch_members WHERE operation_id=?)'],
 ['message_coordination_ingress','DELETE FROM message_coordination_ingress WHERE session_id IN (SELECT session_id FROM session_delete_batch_members WHERE operation_id=?)'],
 ['pending_server_actions','DELETE FROM pending_server_actions WHERE session_id IN (SELECT session_id FROM session_delete_batch_members WHERE operation_id=?)'],
 ['provider_run_failures','DELETE FROM provider_run_failures WHERE session_id IN (SELECT session_id FROM session_delete_batch_members WHERE operation_id=?)'],
 ['response_turn_metrics','DELETE FROM response_turn_metrics WHERE session_id IN (SELECT session_id FROM session_delete_batch_members WHERE operation_id=?)'],
 ['response_turn_metrics_v2','DELETE FROM response_turn_metrics_v2 WHERE session_id IN (SELECT session_id FROM session_delete_batch_members WHERE operation_id=?)'],
 ['scheduled_messages','DELETE FROM scheduled_messages WHERE session_id IN (SELECT session_id FROM session_delete_batch_members WHERE operation_id=?)'],
 ['session_outcome_reads','DELETE FROM session_outcome_reads WHERE session_id IN (SELECT session_id FROM session_delete_batch_members WHERE operation_id=?)'],
 ['session_run_outcomes','DELETE FROM session_run_outcomes WHERE session_id IN (SELECT session_id FROM session_delete_batch_members WHERE operation_id=?)'],
 ['session_workspace_modes','DELETE FROM session_workspace_modes WHERE session_id IN (SELECT session_id FROM session_delete_batch_members WHERE operation_id=?)'],
 ['turn_supervisor_hosted_context','DELETE FROM turn_supervisor_hosted_context WHERE session_id IN (SELECT session_id FROM session_delete_batch_members WHERE operation_id=?)'],
 ['turn_supervisor_hosted_results','DELETE FROM turn_supervisor_hosted_results WHERE session_id IN (SELECT session_id FROM session_delete_batch_members WHERE operation_id=?)'],
 ['turn_supervisor_turns','DELETE FROM turn_supervisor_turns WHERE session_id IN (SELECT session_id FROM session_delete_batch_members WHERE operation_id=?)'],
] as const;

/** Set-based deletion has a fixed parameter count even for a 2000-session project. Unknown optional dependencies reject. */
export function deleteSessionSidecars(db: Database.Database, operationId: string): void {
  assertDeletionDependencies(db);
  const exists=db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?");
  for (const [table,sql] of SESSION_SIDECARS) if (exists.get(table)) db.prepare(sql).run(operationId);
}

/** Project-only reconciliation bookkeeping is removed before the project; history/Universal evidence is retained. */
export function deleteProjectSidecars(db: Database.Database, projectId: string): void {
  if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='reconcile_archived_projects'").get()) {
    db.prepare('DELETE FROM reconcile_archived_projects WHERE project_id=?').run(projectId);
  }
}
