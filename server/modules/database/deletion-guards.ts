import { randomUUID, createHash } from 'node:crypto';

import type Database from 'better-sqlite3';

export const SESSION_DELETE_INTENTS = ['permanent_session', 'permanent_project_member', 'artifact_gone', 'runtime_adoption', 'restore_reconcile_session'] as const;
export const PROJECT_DELETE_INTENTS = ['permanent_project', 'restore_reconcile_project'] as const;
type IntentType = typeof SESSION_DELETE_INTENTS[number] | typeof PROJECT_DELETE_INTENTS[number];
export type DeletionIntentContext = Readonly<{ operationId: string; intentType: IntentType; restoreNonce?: string }>;
const contexts = new WeakMap<Database.Database, { value: DeletionIntentContext; nonce: string; fresh: Set<string> }>();
const registered = new WeakSet<Database.Database>();
export const DELETION_UDFS = Object.freeze([
  { name: 'nassaj_deletion_operation', arity: 0 }, { name: 'nassaj_deletion_intent', arity: 0 },
  { name: 'nassaj_deletion_restore', arity: 0 }, { name: 'nassaj_deletion_transaction', arity: 0 },
  { name: 'nassaj_deletion_path_matches', arity: 3 },
  { name: 'nassaj_deletion_fresh', arity: 2 }, { name: 'nassaj_deletion_mark_fresh', arity: 2 },
].map(entry => Object.freeze({ ...entry, owner: 'deletion', contract: 1 })));

/** Register private transaction-scoped intents on an already platform-registered connection. */
export function registerDeletionIntents(db: Database.Database, verifyPathFingerprint?: (path: string, fingerprint: string, keyVersion: number) => boolean): void {
  if (registered.has(db)) throw new Error('DELETION_REGISTRY_DUPLICATE');
  db.function('nassaj_deletion_path_matches', (path: unknown, fingerprint: unknown, keyVersion: unknown) =>
    typeof path === 'string' && typeof fingerprint === 'string' && typeof keyVersion === 'number' && verifyPathFingerprint?.(path, fingerprint, keyVersion) === true ? 1 : 0);
  db.function('nassaj_deletion_operation', () => contexts.get(db)?.value.operationId ?? '');
  db.function('nassaj_deletion_intent', () => contexts.get(db)?.value.intentType ?? '');
  db.function('nassaj_deletion_restore', () => contexts.get(db)?.value.restoreNonce ?? '');
  db.function('nassaj_deletion_transaction', () => contexts.get(db)?.nonce ?? '');
  db.function('nassaj_deletion_fresh', (kind: unknown, id: unknown) => contexts.get(db)?.fresh.has(JSON.stringify([kind,id])) ? 1 : 0);
  db.function('nassaj_deletion_mark_fresh', (kind: unknown, id: unknown) => {
    const context = contexts.get(db);
    if (!context || !db.inTransaction) throw new Error('DELETION_CONTEXT_REQUIRED');
    context.fresh.add(JSON.stringify([kind,id]));
    return 1;
  });
  registered.add(db);
}

/** Internal synchronous transaction boundary. Restore authority is supplied by the offline reconciler only. */
export function withDeletionTransaction<T>(db: Database.Database, input: DeletionIntentContext, work: () => T): T {
  if (!registered.has(db) || db.inTransaction || contexts.has(db) || !input.operationId ||
      ![...SESSION_DELETE_INTENTS, ...PROJECT_DELETE_INTENTS].includes(input.intentType)) throw new Error('DELETION_CONTEXT_INVALID');
  const restore = input.intentType.startsWith('restore_');
  if (restore !== Boolean(input.restoreNonce)) throw new Error('DELETION_RESTORE_CONTEXT_INVALID');
  const value = Object.freeze({ ...input });
  try {
    return db.transaction(() => {
      contexts.set(db, { value, nonce: randomUUID(), fresh: new Set() });
      const result = work();
      if (result && typeof (result as { then?: unknown }).then === 'function') throw new Error('DELETION_ASYNC_TRANSACTION');
      const pending = db.prepare('SELECT (SELECT count(*) FROM session_delete_intents) + (SELECT count(*) FROM project_delete_intents) AS n').get() as { n: number };
      if (pending.n) throw new Error('DELETION_INTENT_LEFTOVER');
      return result;
    }).immediate();
  } finally {
    contexts.delete(db);
  }
}

/** Require connection invariants before preparing guarded business writes. */
export function assertDeletionConnection(db: Database.Database): void {
  if (db.pragma('foreign_keys', { simple: true }) !== 1 || db.pragma('recursive_triggers', { simple: true }) !== 1 ||
      db.pragma('synchronous', { simple: true }) !== 2) throw new Error('DELETION_PRAGMA_MISMATCH');
  if (!registered.has(db)) throw new Error('DELETION_REGISTRY_REQUIRED');
}

/** Hash exact persisted guards; callers compare against a separately sealed candidate digest. */
export function deletionGuardDigest(db: Database.Database): string {
  const rows = db.prepare("SELECT name, sql FROM sqlite_master WHERE type='trigger' AND name LIKE 'nassaj_deletion_%' ORDER BY name").all();
  return createHash('sha256').update(JSON.stringify(rows)).digest('hex');
}

// Fixture/candidate DDL only: a future locked activation transaction installs it with its marker/receipt.
// There is deliberately no installer, drop operation, boot import or live connection here.
export const DELETION_GUARDS_SQL = `
CREATE TRIGGER nassaj_deletion_sessions_insert_floor BEFORE INSERT ON sessions BEGIN
 SELECT CASE WHEN nassaj_platform_business_writes_allowed()!=1 OR NOT EXISTS(SELECT 1 FROM platform_protocol_marker WHERE feature='deletion' AND protocol_version=1) OR EXISTS(SELECT 1 FROM platform_protocol_marker WHERE nassaj_platform_supports(feature,protocol_version)!=1) OR nassaj_platform_supports('deletion',1)!=1 THEN RAISE(ABORT, 'DELETION_GUARD_REJECTED') END;
END;
CREATE TRIGGER nassaj_deletion_sessions_update_floor BEFORE UPDATE ON sessions BEGIN
 SELECT CASE WHEN nassaj_platform_business_writes_allowed()!=1 OR NOT EXISTS(SELECT 1 FROM platform_protocol_marker WHERE feature='deletion' AND protocol_version=1) OR EXISTS(SELECT 1 FROM platform_protocol_marker WHERE nassaj_platform_supports(feature,protocol_version)!=1) OR nassaj_platform_supports('deletion',1)!=1 THEN RAISE(ABORT, 'DELETION_GUARD_REJECTED') END;
END;
CREATE TRIGGER nassaj_deletion_sessions_delete_floor BEFORE DELETE ON sessions BEGIN
 SELECT CASE WHEN nassaj_platform_business_writes_allowed()!=1 OR NOT EXISTS(SELECT 1 FROM platform_protocol_marker WHERE feature='deletion' AND protocol_version=1) OR EXISTS(SELECT 1 FROM platform_protocol_marker WHERE nassaj_platform_supports(feature,protocol_version)!=1) OR nassaj_platform_supports('deletion',1)!=1 THEN RAISE(ABORT, 'DELETION_GUARD_REJECTED') END;
END;
CREATE TRIGGER nassaj_deletion_projects_insert_floor BEFORE INSERT ON projects BEGIN
 SELECT CASE WHEN nassaj_platform_business_writes_allowed()!=1 OR NOT EXISTS(SELECT 1 FROM platform_protocol_marker WHERE feature='deletion' AND protocol_version=1) OR EXISTS(SELECT 1 FROM platform_protocol_marker WHERE nassaj_platform_supports(feature,protocol_version)!=1) OR nassaj_platform_supports('deletion',1)!=1 THEN RAISE(ABORT, 'DELETION_GUARD_REJECTED') END;
END;
CREATE TRIGGER nassaj_deletion_projects_update_floor BEFORE UPDATE ON projects BEGIN
 SELECT CASE WHEN nassaj_platform_business_writes_allowed()!=1 OR NOT EXISTS(SELECT 1 FROM platform_protocol_marker WHERE feature='deletion' AND protocol_version=1) OR EXISTS(SELECT 1 FROM platform_protocol_marker WHERE nassaj_platform_supports(feature,protocol_version)!=1) OR nassaj_platform_supports('deletion',1)!=1 THEN RAISE(ABORT, 'DELETION_GUARD_REJECTED') END;
END;
CREATE TRIGGER nassaj_deletion_projects_delete_floor BEFORE DELETE ON projects BEGIN
 SELECT CASE WHEN nassaj_platform_business_writes_allowed()!=1 OR NOT EXISTS(SELECT 1 FROM platform_protocol_marker WHERE feature='deletion' AND protocol_version=1) OR EXISTS(SELECT 1 FROM platform_protocol_marker WHERE nassaj_platform_supports(feature,protocol_version)!=1) OR nassaj_platform_supports('deletion',1)!=1 THEN RAISE(ABORT, 'DELETION_GUARD_REJECTED') END;
END;
CREATE TRIGGER nassaj_deletion_session_tombstones_insert_floor BEFORE INSERT ON session_tombstones BEGIN
 SELECT CASE WHEN nassaj_platform_business_writes_allowed()!=1 OR NOT EXISTS(SELECT 1 FROM platform_protocol_marker WHERE feature='deletion' AND protocol_version=1) OR EXISTS(SELECT 1 FROM platform_protocol_marker WHERE nassaj_platform_supports(feature,protocol_version)!=1) OR nassaj_platform_supports('deletion',1)!=1 THEN RAISE(ABORT, 'DELETION_GUARD_REJECTED') END;
END;
CREATE TRIGGER nassaj_deletion_session_tombstones_update_floor BEFORE UPDATE ON session_tombstones BEGIN
 SELECT CASE WHEN nassaj_platform_business_writes_allowed()!=1 OR NOT EXISTS(SELECT 1 FROM platform_protocol_marker WHERE feature='deletion' AND protocol_version=1) OR EXISTS(SELECT 1 FROM platform_protocol_marker WHERE nassaj_platform_supports(feature,protocol_version)!=1) OR nassaj_platform_supports('deletion',1)!=1 THEN RAISE(ABORT, 'DELETION_GUARD_REJECTED') END;
END;
CREATE TRIGGER nassaj_deletion_session_tombstones_delete_floor BEFORE DELETE ON session_tombstones BEGIN
 SELECT CASE WHEN nassaj_platform_business_writes_allowed()!=1 OR NOT EXISTS(SELECT 1 FROM platform_protocol_marker WHERE feature='deletion' AND protocol_version=1) OR EXISTS(SELECT 1 FROM platform_protocol_marker WHERE nassaj_platform_supports(feature,protocol_version)!=1) OR nassaj_platform_supports('deletion',1)!=1 THEN RAISE(ABORT, 'DELETION_GUARD_REJECTED') END;
END;
CREATE TRIGGER nassaj_deletion_project_tombstones_insert_floor BEFORE INSERT ON project_tombstones BEGIN
 SELECT CASE WHEN nassaj_platform_business_writes_allowed()!=1 OR NOT EXISTS(SELECT 1 FROM platform_protocol_marker WHERE feature='deletion' AND protocol_version=1) OR EXISTS(SELECT 1 FROM platform_protocol_marker WHERE nassaj_platform_supports(feature,protocol_version)!=1) OR nassaj_platform_supports('deletion',1)!=1 THEN RAISE(ABORT, 'DELETION_GUARD_REJECTED') END;
END;
CREATE TRIGGER nassaj_deletion_project_tombstones_update_floor BEFORE UPDATE ON project_tombstones BEGIN
 SELECT CASE WHEN nassaj_platform_business_writes_allowed()!=1 OR NOT EXISTS(SELECT 1 FROM platform_protocol_marker WHERE feature='deletion' AND protocol_version=1) OR EXISTS(SELECT 1 FROM platform_protocol_marker WHERE nassaj_platform_supports(feature,protocol_version)!=1) OR nassaj_platform_supports('deletion',1)!=1 THEN RAISE(ABORT, 'DELETION_GUARD_REJECTED') END;
END;
CREATE TRIGGER nassaj_deletion_project_tombstones_delete_floor BEFORE DELETE ON project_tombstones BEGIN
 SELECT CASE WHEN nassaj_platform_business_writes_allowed()!=1 OR NOT EXISTS(SELECT 1 FROM platform_protocol_marker WHERE feature='deletion' AND protocol_version=1) OR EXISTS(SELECT 1 FROM platform_protocol_marker WHERE nassaj_platform_supports(feature,protocol_version)!=1) OR nassaj_platform_supports('deletion',1)!=1 THEN RAISE(ABORT, 'DELETION_GUARD_REJECTED') END;
END;
CREATE TRIGGER nassaj_deletion_session_delete_intents_insert_floor BEFORE INSERT ON session_delete_intents BEGIN
 SELECT CASE WHEN nassaj_platform_business_writes_allowed()!=1 OR NOT EXISTS(SELECT 1 FROM platform_protocol_marker WHERE feature='deletion' AND protocol_version=1) OR EXISTS(SELECT 1 FROM platform_protocol_marker WHERE nassaj_platform_supports(feature,protocol_version)!=1) OR nassaj_platform_supports('deletion',1)!=1 THEN RAISE(ABORT, 'DELETION_GUARD_REJECTED') END;
END;
CREATE TRIGGER nassaj_deletion_session_delete_intents_update_floor BEFORE UPDATE ON session_delete_intents BEGIN
 SELECT CASE WHEN nassaj_platform_business_writes_allowed()!=1 OR NOT EXISTS(SELECT 1 FROM platform_protocol_marker WHERE feature='deletion' AND protocol_version=1) OR EXISTS(SELECT 1 FROM platform_protocol_marker WHERE nassaj_platform_supports(feature,protocol_version)!=1) OR nassaj_platform_supports('deletion',1)!=1 THEN RAISE(ABORT, 'DELETION_GUARD_REJECTED') END;
END;
CREATE TRIGGER nassaj_deletion_session_delete_intents_delete_floor BEFORE DELETE ON session_delete_intents BEGIN
 SELECT CASE WHEN nassaj_platform_business_writes_allowed()!=1 OR NOT EXISTS(SELECT 1 FROM platform_protocol_marker WHERE feature='deletion' AND protocol_version=1) OR EXISTS(SELECT 1 FROM platform_protocol_marker WHERE nassaj_platform_supports(feature,protocol_version)!=1) OR nassaj_platform_supports('deletion',1)!=1 THEN RAISE(ABORT, 'DELETION_GUARD_REJECTED') END;
END;
CREATE TRIGGER nassaj_deletion_project_delete_intents_insert_floor BEFORE INSERT ON project_delete_intents BEGIN
 SELECT CASE WHEN nassaj_platform_business_writes_allowed()!=1 OR NOT EXISTS(SELECT 1 FROM platform_protocol_marker WHERE feature='deletion' AND protocol_version=1) OR EXISTS(SELECT 1 FROM platform_protocol_marker WHERE nassaj_platform_supports(feature,protocol_version)!=1) OR nassaj_platform_supports('deletion',1)!=1 THEN RAISE(ABORT, 'DELETION_GUARD_REJECTED') END;
END;
CREATE TRIGGER nassaj_deletion_project_delete_intents_update_floor BEFORE UPDATE ON project_delete_intents BEGIN
 SELECT CASE WHEN nassaj_platform_business_writes_allowed()!=1 OR NOT EXISTS(SELECT 1 FROM platform_protocol_marker WHERE feature='deletion' AND protocol_version=1) OR EXISTS(SELECT 1 FROM platform_protocol_marker WHERE nassaj_platform_supports(feature,protocol_version)!=1) OR nassaj_platform_supports('deletion',1)!=1 THEN RAISE(ABORT, 'DELETION_GUARD_REJECTED') END;
END;
CREATE TRIGGER nassaj_deletion_project_delete_intents_delete_floor BEFORE DELETE ON project_delete_intents BEGIN
 SELECT CASE WHEN nassaj_platform_business_writes_allowed()!=1 OR NOT EXISTS(SELECT 1 FROM platform_protocol_marker WHERE feature='deletion' AND protocol_version=1) OR EXISTS(SELECT 1 FROM platform_protocol_marker WHERE nassaj_platform_supports(feature,protocol_version)!=1) OR nassaj_platform_supports('deletion',1)!=1 THEN RAISE(ABORT, 'DELETION_GUARD_REJECTED') END;
END;
CREATE TRIGGER nassaj_deletion_project_generations_insert_floor BEFORE INSERT ON project_generations BEGIN
 SELECT CASE WHEN nassaj_platform_business_writes_allowed()!=1 OR NOT EXISTS(SELECT 1 FROM platform_protocol_marker WHERE feature='deletion' AND protocol_version=1) OR EXISTS(SELECT 1 FROM platform_protocol_marker WHERE nassaj_platform_supports(feature,protocol_version)!=1) OR nassaj_platform_supports('deletion',1)!=1 THEN RAISE(ABORT, 'DELETION_GUARD_REJECTED') END;
END;
CREATE TRIGGER nassaj_deletion_project_generations_update_floor BEFORE UPDATE ON project_generations BEGIN
 SELECT CASE WHEN nassaj_platform_business_writes_allowed()!=1 OR NOT EXISTS(SELECT 1 FROM platform_protocol_marker WHERE feature='deletion' AND protocol_version=1) OR EXISTS(SELECT 1 FROM platform_protocol_marker WHERE nassaj_platform_supports(feature,protocol_version)!=1) OR nassaj_platform_supports('deletion',1)!=1 THEN RAISE(ABORT, 'DELETION_GUARD_REJECTED') END;
END;
CREATE TRIGGER nassaj_deletion_project_generations_delete_floor BEFORE DELETE ON project_generations BEGIN
 SELECT CASE WHEN nassaj_platform_business_writes_allowed()!=1 OR NOT EXISTS(SELECT 1 FROM platform_protocol_marker WHERE feature='deletion' AND protocol_version=1) OR EXISTS(SELECT 1 FROM platform_protocol_marker WHERE nassaj_platform_supports(feature,protocol_version)!=1) OR nassaj_platform_supports('deletion',1)!=1 THEN RAISE(ABORT, 'DELETION_GUARD_REJECTED') END;
END;
CREATE TRIGGER nassaj_deletion_project_lifecycle_transitions_insert_floor BEFORE INSERT ON project_lifecycle_transitions BEGIN
 SELECT CASE WHEN nassaj_platform_business_writes_allowed()!=1 OR NOT EXISTS(SELECT 1 FROM platform_protocol_marker WHERE feature='deletion' AND protocol_version=1) OR EXISTS(SELECT 1 FROM platform_protocol_marker WHERE nassaj_platform_supports(feature,protocol_version)!=1) OR nassaj_platform_supports('deletion',1)!=1 THEN RAISE(ABORT, 'DELETION_GUARD_REJECTED') END;
END;
CREATE TRIGGER nassaj_deletion_project_lifecycle_transitions_update_floor BEFORE UPDATE ON project_lifecycle_transitions BEGIN
 SELECT CASE WHEN nassaj_platform_business_writes_allowed()!=1 OR NOT EXISTS(SELECT 1 FROM platform_protocol_marker WHERE feature='deletion' AND protocol_version=1) OR EXISTS(SELECT 1 FROM platform_protocol_marker WHERE nassaj_platform_supports(feature,protocol_version)!=1) OR nassaj_platform_supports('deletion',1)!=1 THEN RAISE(ABORT, 'DELETION_GUARD_REJECTED') END;
END;
CREATE TRIGGER nassaj_deletion_project_lifecycle_transitions_delete_floor BEFORE DELETE ON project_lifecycle_transitions BEGIN
 SELECT CASE WHEN nassaj_platform_business_writes_allowed()!=1 OR NOT EXISTS(SELECT 1 FROM platform_protocol_marker WHERE feature='deletion' AND protocol_version=1) OR EXISTS(SELECT 1 FROM platform_protocol_marker WHERE nassaj_platform_supports(feature,protocol_version)!=1) OR nassaj_platform_supports('deletion',1)!=1 THEN RAISE(ABORT, 'DELETION_GUARD_REJECTED') END;
END;
CREATE TRIGGER nassaj_deletion_session_generation_bindings_insert_floor BEFORE INSERT ON session_generation_bindings BEGIN
 SELECT CASE WHEN nassaj_platform_business_writes_allowed()!=1 OR NOT EXISTS(SELECT 1 FROM platform_protocol_marker WHERE feature='deletion' AND protocol_version=1) OR EXISTS(SELECT 1 FROM platform_protocol_marker WHERE nassaj_platform_supports(feature,protocol_version)!=1) OR nassaj_platform_supports('deletion',1)!=1 THEN RAISE(ABORT, 'DELETION_GUARD_REJECTED') END;
END;
CREATE TRIGGER nassaj_deletion_session_generation_bindings_update_floor BEFORE UPDATE ON session_generation_bindings BEGIN
 SELECT CASE WHEN nassaj_platform_business_writes_allowed()!=1 OR NOT EXISTS(SELECT 1 FROM platform_protocol_marker WHERE feature='deletion' AND protocol_version=1) OR EXISTS(SELECT 1 FROM platform_protocol_marker WHERE nassaj_platform_supports(feature,protocol_version)!=1) OR nassaj_platform_supports('deletion',1)!=1 THEN RAISE(ABORT, 'DELETION_GUARD_REJECTED') END;
END;
CREATE TRIGGER nassaj_deletion_session_generation_bindings_delete_floor BEFORE DELETE ON session_generation_bindings BEGIN
 SELECT CASE WHEN nassaj_platform_business_writes_allowed()!=1 OR NOT EXISTS(SELECT 1 FROM platform_protocol_marker WHERE feature='deletion' AND protocol_version=1) OR EXISTS(SELECT 1 FROM platform_protocol_marker WHERE nassaj_platform_supports(feature,protocol_version)!=1) OR nassaj_platform_supports('deletion',1)!=1 THEN RAISE(ABORT, 'DELETION_GUARD_REJECTED') END;
END;
CREATE TRIGGER nassaj_deletion_project_deletion_records_insert_floor BEFORE INSERT ON project_deletion_records BEGIN
 SELECT CASE WHEN nassaj_platform_business_writes_allowed()!=1 OR NOT EXISTS(SELECT 1 FROM platform_protocol_marker WHERE feature='deletion' AND protocol_version=1) OR EXISTS(SELECT 1 FROM platform_protocol_marker WHERE nassaj_platform_supports(feature,protocol_version)!=1) OR nassaj_platform_supports('deletion',1)!=1 THEN RAISE(ABORT, 'DELETION_GUARD_REJECTED') END;
END;
CREATE TRIGGER nassaj_deletion_project_deletion_records_update_floor BEFORE UPDATE ON project_deletion_records BEGIN
 SELECT CASE WHEN nassaj_platform_business_writes_allowed()!=1 OR NOT EXISTS(SELECT 1 FROM platform_protocol_marker WHERE feature='deletion' AND protocol_version=1) OR EXISTS(SELECT 1 FROM platform_protocol_marker WHERE nassaj_platform_supports(feature,protocol_version)!=1) OR nassaj_platform_supports('deletion',1)!=1 THEN RAISE(ABORT, 'DELETION_GUARD_REJECTED') END;
END;
CREATE TRIGGER nassaj_deletion_project_deletion_records_delete_floor BEFORE DELETE ON project_deletion_records BEGIN
 SELECT CASE WHEN nassaj_platform_business_writes_allowed()!=1 OR NOT EXISTS(SELECT 1 FROM platform_protocol_marker WHERE feature='deletion' AND protocol_version=1) OR EXISTS(SELECT 1 FROM platform_protocol_marker WHERE nassaj_platform_supports(feature,protocol_version)!=1) OR nassaj_platform_supports('deletion',1)!=1 THEN RAISE(ABORT, 'DELETION_GUARD_REJECTED') END;
END;
CREATE TRIGGER nassaj_deletion_session_delete_batch_members_insert_floor BEFORE INSERT ON session_delete_batch_members BEGIN
 SELECT CASE WHEN nassaj_platform_business_writes_allowed()!=1 OR NOT EXISTS(SELECT 1 FROM platform_protocol_marker WHERE feature='deletion' AND protocol_version=1) OR EXISTS(SELECT 1 FROM platform_protocol_marker WHERE nassaj_platform_supports(feature,protocol_version)!=1) OR nassaj_platform_supports('deletion',1)!=1 THEN RAISE(ABORT, 'DELETION_GUARD_REJECTED') END;
END;
CREATE TRIGGER nassaj_deletion_session_delete_batch_members_update_floor BEFORE UPDATE ON session_delete_batch_members BEGIN
 SELECT CASE WHEN nassaj_platform_business_writes_allowed()!=1 OR NOT EXISTS(SELECT 1 FROM platform_protocol_marker WHERE feature='deletion' AND protocol_version=1) OR EXISTS(SELECT 1 FROM platform_protocol_marker WHERE nassaj_platform_supports(feature,protocol_version)!=1) OR nassaj_platform_supports('deletion',1)!=1 THEN RAISE(ABORT, 'DELETION_GUARD_REJECTED') END;
END;
CREATE TRIGGER nassaj_deletion_session_delete_batch_members_delete_floor BEFORE DELETE ON session_delete_batch_members BEGIN
 SELECT CASE WHEN nassaj_platform_business_writes_allowed()!=1 OR NOT EXISTS(SELECT 1 FROM platform_protocol_marker WHERE feature='deletion' AND protocol_version=1) OR EXISTS(SELECT 1 FROM platform_protocol_marker WHERE nassaj_platform_supports(feature,protocol_version)!=1) OR nassaj_platform_supports('deletion',1)!=1 THEN RAISE(ABORT, 'DELETION_GUARD_REJECTED') END;
END;
CREATE TRIGGER nassaj_deletion_deletion_source_manifests_insert_floor BEFORE INSERT ON deletion_source_manifests BEGIN
 SELECT CASE WHEN nassaj_platform_business_writes_allowed()!=1 OR NOT EXISTS(SELECT 1 FROM platform_protocol_marker WHERE feature='deletion' AND protocol_version=1) OR EXISTS(SELECT 1 FROM platform_protocol_marker WHERE nassaj_platform_supports(feature,protocol_version)!=1) OR nassaj_platform_supports('deletion',1)!=1 THEN RAISE(ABORT, 'DELETION_GUARD_REJECTED') END;
END;
CREATE TRIGGER nassaj_deletion_deletion_source_manifests_update_floor BEFORE UPDATE ON deletion_source_manifests BEGIN
 SELECT CASE WHEN nassaj_platform_business_writes_allowed()!=1 OR NOT EXISTS(SELECT 1 FROM platform_protocol_marker WHERE feature='deletion' AND protocol_version=1) OR EXISTS(SELECT 1 FROM platform_protocol_marker WHERE nassaj_platform_supports(feature,protocol_version)!=1) OR nassaj_platform_supports('deletion',1)!=1 THEN RAISE(ABORT, 'DELETION_GUARD_REJECTED') END;
END;
CREATE TRIGGER nassaj_deletion_deletion_source_manifests_delete_floor BEFORE DELETE ON deletion_source_manifests BEGIN
 SELECT CASE WHEN nassaj_platform_business_writes_allowed()!=1 OR NOT EXISTS(SELECT 1 FROM platform_protocol_marker WHERE feature='deletion' AND protocol_version=1) OR EXISTS(SELECT 1 FROM platform_protocol_marker WHERE nassaj_platform_supports(feature,protocol_version)!=1) OR nassaj_platform_supports('deletion',1)!=1 THEN RAISE(ABORT, 'DELETION_GUARD_REJECTED') END;
END;
CREATE TRIGGER nassaj_deletion_deletion_source_manifest_members_insert_floor BEFORE INSERT ON deletion_source_manifest_members BEGIN
 SELECT CASE WHEN nassaj_platform_business_writes_allowed()!=1 OR NOT EXISTS(SELECT 1 FROM platform_protocol_marker WHERE feature='deletion' AND protocol_version=1) OR EXISTS(SELECT 1 FROM platform_protocol_marker WHERE nassaj_platform_supports(feature,protocol_version)!=1) OR nassaj_platform_supports('deletion',1)!=1 THEN RAISE(ABORT, 'DELETION_GUARD_REJECTED') END;
END;
CREATE TRIGGER nassaj_deletion_deletion_source_manifest_members_update_floor BEFORE UPDATE ON deletion_source_manifest_members BEGIN
 SELECT CASE WHEN nassaj_platform_business_writes_allowed()!=1 OR NOT EXISTS(SELECT 1 FROM platform_protocol_marker WHERE feature='deletion' AND protocol_version=1) OR EXISTS(SELECT 1 FROM platform_protocol_marker WHERE nassaj_platform_supports(feature,protocol_version)!=1) OR nassaj_platform_supports('deletion',1)!=1 THEN RAISE(ABORT, 'DELETION_GUARD_REJECTED') END;
END;
CREATE TRIGGER nassaj_deletion_deletion_source_manifest_members_delete_floor BEFORE DELETE ON deletion_source_manifest_members BEGIN
 SELECT CASE WHEN nassaj_platform_business_writes_allowed()!=1 OR NOT EXISTS(SELECT 1 FROM platform_protocol_marker WHERE feature='deletion' AND protocol_version=1) OR EXISTS(SELECT 1 FROM platform_protocol_marker WHERE nassaj_platform_supports(feature,protocol_version)!=1) OR nassaj_platform_supports('deletion',1)!=1 THEN RAISE(ABORT, 'DELETION_GUARD_REJECTED') END;
END;
CREATE TRIGGER nassaj_deletion_session_artifact_cleanup_outbox_insert_floor BEFORE INSERT ON session_artifact_cleanup_outbox BEGIN
 SELECT CASE WHEN nassaj_platform_business_writes_allowed()!=1 OR NOT EXISTS(SELECT 1 FROM platform_protocol_marker WHERE feature='deletion' AND protocol_version=1) OR EXISTS(SELECT 1 FROM platform_protocol_marker WHERE nassaj_platform_supports(feature,protocol_version)!=1) OR nassaj_platform_supports('deletion',1)!=1 THEN RAISE(ABORT, 'DELETION_GUARD_REJECTED') END;
END;
CREATE TRIGGER nassaj_deletion_session_artifact_cleanup_outbox_update_floor BEFORE UPDATE ON session_artifact_cleanup_outbox BEGIN
 SELECT CASE WHEN nassaj_platform_business_writes_allowed()!=1 OR NOT EXISTS(SELECT 1 FROM platform_protocol_marker WHERE feature='deletion' AND protocol_version=1) OR EXISTS(SELECT 1 FROM platform_protocol_marker WHERE nassaj_platform_supports(feature,protocol_version)!=1) OR nassaj_platform_supports('deletion',1)!=1 THEN RAISE(ABORT, 'DELETION_GUARD_REJECTED') END;
END;
CREATE TRIGGER nassaj_deletion_session_artifact_cleanup_outbox_delete_floor BEFORE DELETE ON session_artifact_cleanup_outbox BEGIN
 SELECT CASE WHEN nassaj_platform_business_writes_allowed()!=1 OR NOT EXISTS(SELECT 1 FROM platform_protocol_marker WHERE feature='deletion' AND protocol_version=1) OR EXISTS(SELECT 1 FROM platform_protocol_marker WHERE nassaj_platform_supports(feature,protocol_version)!=1) OR nassaj_platform_supports('deletion',1)!=1 THEN RAISE(ABORT, 'DELETION_GUARD_REJECTED') END;
END;
CREATE TRIGGER nassaj_deletion_session_delete BEFORE DELETE ON sessions BEGIN
 SELECT CASE WHEN nassaj_deletion_transaction()='' OR NOT (EXISTS(SELECT 1 FROM session_delete_intents i WHERE i.session_id=OLD.session_id AND i.operation_id=nassaj_deletion_operation() AND i.intent_type=nassaj_deletion_intent() AND i.transaction_nonce=nassaj_deletion_transaction() AND i.restore_nonce=nassaj_deletion_restore())) THEN RAISE(ABORT, 'DELETION_GUARD_REJECTED') END;
 SELECT CASE WHEN nassaj_deletion_intent() IN ('permanent_session','permanent_project_member') AND (NOT EXISTS(SELECT 1 FROM session_tombstones t WHERE t.session_id=OLD.session_id AND t.operation_id=nassaj_deletion_operation()) OR nassaj_deletion_fresh('session',OLD.session_id)!=1) THEN RAISE(ABORT, 'DELETION_GUARD_REJECTED') END;
 SELECT CASE WHEN nassaj_deletion_intent()='restore_reconcile_session' AND (nassaj_deletion_restore()='' OR NOT EXISTS(SELECT 1 FROM session_tombstones t WHERE t.session_id=OLD.session_id AND t.operation_id IS NOT NULL AND length(t.operation_id)>0) OR nassaj_deletion_fresh('session',OLD.session_id)=1) THEN RAISE(ABORT, 'DELETION_GUARD_REJECTED') END;
 SELECT CASE WHEN nassaj_deletion_intent() IN ('artifact_gone','runtime_adoption') AND EXISTS(SELECT 1 FROM session_tombstones WHERE session_id=OLD.session_id) THEN RAISE(ABORT, 'DELETION_GUARD_REJECTED') END;
END;
CREATE TRIGGER nassaj_deletion_session_consume AFTER DELETE ON sessions BEGIN
 DELETE FROM session_delete_intents WHERE session_id=OLD.session_id;
END;
CREATE TRIGGER nassaj_deletion_session_insert BEFORE INSERT ON sessions BEGIN
 SELECT CASE WHEN EXISTS(SELECT 1 FROM session_tombstones WHERE session_id=NEW.session_id) OR EXISTS(SELECT 1 FROM sessions WHERE session_id=NEW.session_id) THEN RAISE(ABORT, 'DELETION_GUARD_REJECTED') END;
END;
CREATE TRIGGER nassaj_deletion_session_identity BEFORE UPDATE ON sessions BEGIN
 SELECT CASE WHEN NEW.session_id IS NOT OLD.session_id OR NEW.project_path IS NOT OLD.project_path OR NEW.provider IS NOT OLD.provider THEN RAISE(ABORT, 'DELETION_GUARD_REJECTED') END;
END;
CREATE TRIGGER nassaj_deletion_session_intent_insert BEFORE INSERT ON session_delete_intents BEGIN
 SELECT CASE WHEN nassaj_deletion_transaction()='' OR NEW.transaction_nonce!=nassaj_deletion_transaction() OR NEW.operation_id!=nassaj_deletion_operation() OR NEW.intent_type!=nassaj_deletion_intent() OR NEW.restore_nonce!=nassaj_deletion_restore() OR EXISTS(SELECT 1 FROM session_delete_intents WHERE session_id=NEW.session_id) THEN RAISE(ABORT, 'DELETION_GUARD_REJECTED') END;
END;
CREATE TRIGGER nassaj_deletion_session_intent_update BEFORE UPDATE ON session_delete_intents BEGIN
 SELECT CASE WHEN 1 THEN RAISE(ABORT, 'DELETION_GUARD_REJECTED') END;
END;
CREATE TRIGGER nassaj_deletion_session_tombstone_insert BEFORE INSERT ON session_tombstones BEGIN
 SELECT CASE WHEN nassaj_deletion_transaction()='' OR nassaj_deletion_intent() NOT IN ('permanent_session','permanent_project_member') OR EXISTS(SELECT 1 FROM session_tombstones WHERE session_id=NEW.session_id) THEN RAISE(ABORT, 'DELETION_GUARD_REJECTED') END;
END;
CREATE TRIGGER nassaj_deletion_session_tombstone_fresh AFTER INSERT ON session_tombstones BEGIN
 SELECT nassaj_deletion_mark_fresh('session',NEW.session_id);
END;
CREATE TRIGGER nassaj_deletion_session_tombstone_update BEFORE UPDATE ON session_tombstones BEGIN
 SELECT CASE WHEN 1 THEN RAISE(ABORT, 'DELETION_GUARD_REJECTED') END;
END;
CREATE TRIGGER nassaj_deletion_session_tombstone_delete BEFORE DELETE ON session_tombstones BEGIN
 SELECT CASE WHEN 1 THEN RAISE(ABORT, 'DELETION_GUARD_REJECTED') END;
END;
CREATE TRIGGER nassaj_deletion_project_delete BEFORE DELETE ON projects BEGIN
 SELECT CASE WHEN EXISTS(SELECT 1 FROM sessions WHERE project_path=OLD.project_path) OR EXISTS(SELECT 1 FROM sessions s JOIN session_generation_bindings b ON b.session_id=s.session_id WHERE b.project_id=OLD.project_id) THEN RAISE(ABORT, 'DELETION_PROJECT_HAS_SESSIONS') END;
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM project_tombstones t JOIN project_generations g ON g.project_id=t.project_id AND g.generation=t.generation AND g.path_fingerprint=t.path_fingerprint AND g.key_version=t.key_version WHERE t.project_id=OLD.project_id AND nassaj_deletion_path_matches(OLD.project_path,t.path_fingerprint,t.key_version)=1 AND (nassaj_deletion_intent()='restore_reconcile_project' OR t.operation_id=nassaj_deletion_operation())) THEN RAISE(ABORT, 'DELETION_PROJECT_WITNESS_MISMATCH') END;
 SELECT CASE WHEN nassaj_deletion_transaction()='' OR NOT (EXISTS(SELECT 1 FROM project_delete_intents i WHERE i.project_id=OLD.project_id AND i.operation_id=nassaj_deletion_operation() AND i.intent_type=nassaj_deletion_intent() AND i.transaction_nonce=nassaj_deletion_transaction() AND i.restore_nonce=nassaj_deletion_restore())) THEN RAISE(ABORT, 'DELETION_GUARD_REJECTED') END;
 SELECT CASE WHEN nassaj_deletion_intent() IN ('permanent_project') AND (NOT EXISTS(SELECT 1 FROM project_tombstones t WHERE t.project_id=OLD.project_id) OR nassaj_deletion_fresh('project',OLD.project_id)!=1) THEN RAISE(ABORT, 'DELETION_GUARD_REJECTED') END;
 SELECT CASE WHEN nassaj_deletion_intent()='restore_reconcile_project' AND (nassaj_deletion_restore()='' OR NOT EXISTS(SELECT 1 FROM project_tombstones t WHERE t.project_id=OLD.project_id) OR nassaj_deletion_fresh('project',OLD.project_id)=1) THEN RAISE(ABORT, 'DELETION_GUARD_REJECTED') END;
END;
CREATE TRIGGER nassaj_deletion_project_consume AFTER DELETE ON projects BEGIN
 DELETE FROM project_delete_intents WHERE project_id=OLD.project_id;
END;
CREATE TRIGGER nassaj_deletion_project_insert BEFORE INSERT ON projects BEGIN
 SELECT CASE WHEN EXISTS(SELECT 1 FROM project_tombstones WHERE project_id=NEW.project_id) OR EXISTS(SELECT 1 FROM projects WHERE project_id=NEW.project_id) THEN RAISE(ABORT, 'DELETION_GUARD_REJECTED') END;
END;
CREATE TRIGGER nassaj_deletion_project_identity BEFORE UPDATE ON projects BEGIN
 SELECT CASE WHEN NEW.project_id IS NOT OLD.project_id OR NEW.project_path IS NOT OLD.project_path THEN RAISE(ABORT, 'DELETION_GUARD_REJECTED') END;
END;
CREATE TRIGGER nassaj_deletion_project_intent_insert BEFORE INSERT ON project_delete_intents BEGIN
 SELECT CASE WHEN nassaj_deletion_transaction()='' OR NEW.transaction_nonce!=nassaj_deletion_transaction() OR NEW.operation_id!=nassaj_deletion_operation() OR NEW.intent_type!=nassaj_deletion_intent() OR NEW.restore_nonce!=nassaj_deletion_restore() OR EXISTS(SELECT 1 FROM project_delete_intents WHERE project_id=NEW.project_id) THEN RAISE(ABORT, 'DELETION_GUARD_REJECTED') END;
END;
CREATE TRIGGER nassaj_deletion_project_intent_update BEFORE UPDATE ON project_delete_intents BEGIN
 SELECT CASE WHEN 1 THEN RAISE(ABORT, 'DELETION_GUARD_REJECTED') END;
END;
CREATE TRIGGER nassaj_deletion_project_tombstone_insert BEFORE INSERT ON project_tombstones BEGIN
 SELECT CASE WHEN nassaj_deletion_transaction()='' OR nassaj_deletion_intent() NOT IN ('permanent_project') OR EXISTS(SELECT 1 FROM project_tombstones WHERE project_id=NEW.project_id) THEN RAISE(ABORT, 'DELETION_GUARD_REJECTED') END;
END;
CREATE TRIGGER nassaj_deletion_project_tombstone_fresh AFTER INSERT ON project_tombstones BEGIN
 SELECT nassaj_deletion_mark_fresh('project',NEW.project_id);
END;
CREATE TRIGGER nassaj_deletion_project_tombstone_update BEFORE UPDATE ON project_tombstones BEGIN
 SELECT CASE WHEN 1 THEN RAISE(ABORT, 'DELETION_GUARD_REJECTED') END;
END;
CREATE TRIGGER nassaj_deletion_project_tombstone_delete BEFORE DELETE ON project_tombstones BEGIN
 SELECT CASE WHEN 1 THEN RAISE(ABORT, 'DELETION_GUARD_REJECTED') END;
END;
CREATE TRIGGER nassaj_deletion_session_null_paths BEFORE INSERT ON session_tombstones BEGIN
 SELECT CASE WHEN NEW.project_path IS NOT NULL OR NEW.source_path IS NOT NULL OR NEW.deleted_by IS NOT NULL OR NEW.operation_id IS NULL OR length(NEW.operation_id)=0 OR NEW.operation_id!=nassaj_deletion_operation() THEN RAISE(ABORT, 'DELETION_GUARD_REJECTED') END;
END;
CREATE TRIGGER nassaj_deletion_project_tombstone_operation BEFORE INSERT ON project_tombstones BEGIN
 SELECT CASE WHEN NEW.operation_id!=nassaj_deletion_operation() THEN RAISE(ABORT, 'DELETION_GUARD_REJECTED') END;
END;
CREATE TRIGGER nassaj_deletion_session_generation_bindings_update BEFORE UPDATE ON session_generation_bindings BEGIN
 SELECT CASE WHEN 1 THEN RAISE(ABORT, 'DELETION_GUARD_REJECTED') END;
END;
CREATE TRIGGER nassaj_deletion_session_generation_bindings_delete BEFORE DELETE ON session_generation_bindings BEGIN
 SELECT CASE WHEN 1 THEN RAISE(ABORT, 'DELETION_GUARD_REJECTED') END;
END;
CREATE TRIGGER nassaj_deletion_session_generation_bindings_replace BEFORE INSERT ON session_generation_bindings BEGIN
 SELECT CASE WHEN EXISTS(SELECT 1 FROM session_generation_bindings WHERE session_id=NEW.session_id) THEN RAISE(ABORT, 'DELETION_GUARD_REJECTED') END;
END;
CREATE TRIGGER nassaj_deletion_project_lifecycle_transitions_update BEFORE UPDATE ON project_lifecycle_transitions BEGIN
 SELECT CASE WHEN 1 THEN RAISE(ABORT, 'DELETION_GUARD_REJECTED') END;
END;
CREATE TRIGGER nassaj_deletion_project_lifecycle_transitions_delete BEFORE DELETE ON project_lifecycle_transitions BEGIN
 SELECT CASE WHEN 1 THEN RAISE(ABORT, 'DELETION_GUARD_REJECTED') END;
END;
CREATE TRIGGER nassaj_deletion_project_lifecycle_transitions_replace BEFORE INSERT ON project_lifecycle_transitions BEGIN
 SELECT CASE WHEN EXISTS(SELECT 1 FROM project_lifecycle_transitions WHERE operation_id=NEW.operation_id) THEN RAISE(ABORT, 'DELETION_GUARD_REJECTED') END;
END;
CREATE TRIGGER nassaj_deletion_session_intent_consume_only BEFORE DELETE ON session_delete_intents BEGIN
 SELECT CASE WHEN EXISTS(SELECT 1 FROM sessions WHERE session_id=OLD.session_id) OR OLD.transaction_nonce!=nassaj_deletion_transaction() OR OLD.operation_id!=nassaj_deletion_operation() THEN RAISE(ABORT, 'DELETION_GUARD_REJECTED') END;
END;
CREATE TRIGGER nassaj_deletion_project_intent_consume_only BEFORE DELETE ON project_delete_intents BEGIN
 SELECT CASE WHEN EXISTS(SELECT 1 FROM projects WHERE project_id=OLD.project_id) OR OLD.transaction_nonce!=nassaj_deletion_transaction() OR OLD.operation_id!=nassaj_deletion_operation() THEN RAISE(ABORT, 'DELETION_GUARD_REJECTED') END;
END;
CREATE TRIGGER nassaj_deletion_project_generation_identity BEFORE UPDATE ON project_generations BEGIN
 SELECT CASE WHEN NEW.project_id IS NOT OLD.project_id OR NEW.generation IS NOT OLD.generation OR NEW.path_fingerprint IS NOT OLD.path_fingerprint OR NEW.key_version IS NOT OLD.key_version OR NEW.operation_id IS NOT OLD.operation_id OR NEW.request_hash IS NOT OLD.request_hash OR (OLD.state='suppressed' AND NEW.state!='suppressed') THEN RAISE(ABORT, 'DELETION_GUARD_REJECTED') END;
END;
CREATE TRIGGER nassaj_deletion_project_generation_delete BEFORE DELETE ON project_generations BEGIN
 SELECT RAISE(ABORT, 'DELETION_GUARD_REJECTED');
END;
CREATE TRIGGER nassaj_deletion_project_generation_replace BEFORE INSERT ON project_generations BEGIN
 SELECT CASE WHEN EXISTS(SELECT 1 FROM project_generations WHERE project_id=NEW.project_id OR generation=NEW.generation OR operation_id=NEW.operation_id) THEN RAISE(ABORT, 'DELETION_GUARD_REJECTED') END;
END;

CREATE TRIGGER nassaj_deletion_project_generation_admission BEFORE INSERT ON projects BEGIN
 SELECT CASE WHEN EXISTS(SELECT 1 FROM projects WHERE project_path=NEW.project_path) OR NOT EXISTS(SELECT 1 FROM project_generations g WHERE g.project_id=NEW.project_id AND g.state='active' AND nassaj_deletion_path_matches(NEW.project_path,g.path_fingerprint,g.key_version)=1) THEN RAISE(ABORT, 'DELETION_GUARD_REJECTED') END;
END;
CREATE TRIGGER nassaj_deletion_session_generation_admission BEFORE INSERT ON sessions BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM session_generation_bindings b JOIN project_generations g ON g.project_id=b.project_id AND g.generation=b.generation JOIN projects p ON p.project_id=g.project_id WHERE b.session_id=NEW.session_id AND g.state='active' AND p.project_path=NEW.project_path AND length(b.source_identity)>0 AND length(b.proof_digest)>0) THEN RAISE(ABORT, 'DELETION_GUARD_REJECTED') END;
END;

`;

/** Project batch uses member intents within the SAME transaction and operation, never nested BEGIN. */
export function withProjectMemberIntent<T>(db: Database.Database, work: () => T): T {
  const context = contexts.get(db);
  if (!db.inTransaction || context?.value.intentType !== 'permanent_project') throw new Error('DELETION_PROJECT_CONTEXT_REQUIRED');
  contexts.set(db, { ...context, value: Object.freeze({ ...context.value, intentType: 'permanent_project_member' }) });
  try {
    const result = work();
    if (result && typeof (result as { then?: unknown }).then === 'function') throw new Error('DELETION_ASYNC_TRANSACTION');
    if (db.prepare('SELECT 1 FROM session_delete_intents LIMIT 1').get()) throw new Error('DELETION_INTENT_LEFTOVER');
    return result;
  } finally {
    contexts.set(db, context);
  }
}
