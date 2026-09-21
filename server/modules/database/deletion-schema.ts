/** ADR-120 v5 / ADR-122 additive preparation only. Not imported by initialization/migrations.
 * No backfill, triggers, marker rows, live connection or activation is performed on import.
 */
export const DELETION_PREPARATION_SQL = `
CREATE TABLE IF NOT EXISTS platform_protocol_marker (
 feature TEXT PRIMARY KEY CHECK(feature IN ('deletion','credential_scope','outcomes')),
 protocol_version INTEGER NOT NULL CHECK(protocol_version > 0),
 minimum_build TEXT NOT NULL CHECK(length(minimum_build) > 0), installed_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS project_generations (
 project_id TEXT PRIMARY KEY NOT NULL, generation TEXT NOT NULL UNIQUE,
 path_fingerprint TEXT NOT NULL, key_version INTEGER NOT NULL CHECK(key_version > 0),
 state TEXT NOT NULL CHECK(state IN ('active','suppressed')),
 operation_id TEXT NOT NULL UNIQUE, request_hash TEXT NOT NULL,
 UNIQUE(project_id, generation)
);
CREATE UNIQUE INDEX IF NOT EXISTS deletion_one_active_path ON project_generations(path_fingerprint, key_version) WHERE state='active';
CREATE TABLE IF NOT EXISTS project_lifecycle_transitions (
 operation_id TEXT PRIMARY KEY NOT NULL, project_id TEXT NOT NULL, generation TEXT NOT NULL,
 previous_generation TEXT, action TEXT NOT NULL CHECK(action IN ('create','manual_readd','delete')),
 request_hash TEXT NOT NULL, created_at TEXT NOT NULL,
 FOREIGN KEY(project_id,generation) REFERENCES project_generations(project_id,generation)
);
CREATE TABLE IF NOT EXISTS session_generation_bindings (
 session_id TEXT PRIMARY KEY NOT NULL, project_id TEXT NOT NULL, generation TEXT NOT NULL,
 source_identity TEXT NOT NULL, proof_kind TEXT NOT NULL CHECK(proof_kind IN ('nassaj_created','provider_boundary')),
 proof_digest TEXT NOT NULL,
 FOREIGN KEY(project_id,generation) REFERENCES project_generations(project_id,generation)
);
CREATE TABLE IF NOT EXISTS project_tombstones (
 project_id TEXT PRIMARY KEY NOT NULL, generation TEXT NOT NULL,
 operation_id TEXT NOT NULL, deleted_at TEXT NOT NULL,
 path_fingerprint TEXT NOT NULL, key_version INTEGER NOT NULL CHECK(key_version>0)
);
CREATE TABLE IF NOT EXISTS project_deletion_records (
 operation_id TEXT PRIMARY KEY NOT NULL, project_id TEXT NOT NULL, generation TEXT NOT NULL,
 request_hash TEXT NOT NULL, scope TEXT NOT NULL CHECK(scope IN ('nassaj_only','nassaj_and_disk')),
 database_state TEXT NOT NULL CHECK(database_state IN ('prepared','committed')),
 cleanup_state TEXT NOT NULL CHECK(cleanup_state IN ('pending','blocked','retained','succeeded')),
 created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS session_delete_intents (
 session_id TEXT PRIMARY KEY NOT NULL, operation_id TEXT NOT NULL,
 intent_type TEXT NOT NULL CHECK(intent_type IN ('permanent_session','permanent_project_member','artifact_gone','runtime_adoption','restore_reconcile_session')),
 restore_nonce TEXT NOT NULL DEFAULT '', transaction_nonce TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS project_delete_intents (
 project_id TEXT PRIMARY KEY NOT NULL, operation_id TEXT NOT NULL,
 intent_type TEXT NOT NULL CHECK(intent_type IN ('permanent_project','restore_reconcile_project')),
 restore_nonce TEXT NOT NULL DEFAULT '', transaction_nonce TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS session_delete_batch_members (
 operation_id TEXT NOT NULL, session_id TEXT NOT NULL, project_id TEXT NOT NULL, generation TEXT NOT NULL,
 PRIMARY KEY(operation_id,session_id)
);
CREATE TABLE IF NOT EXISTS deletion_source_manifests (
 operation_id TEXT NOT NULL, store_identity TEXT NOT NULL,
 project_id TEXT NOT NULL, generation TEXT NOT NULL, writer_fence TEXT NOT NULL,
 inventory_digest TEXT NOT NULL, boundary_proof TEXT NOT NULL,
 PRIMARY KEY(operation_id,store_identity)
);
CREATE TABLE IF NOT EXISTS deletion_source_manifest_members (
 operation_id TEXT NOT NULL, store_identity TEXT NOT NULL, source_identity TEXT NOT NULL,
 session_id TEXT NOT NULL, target_identity TEXT NOT NULL,
 PRIMARY KEY(operation_id,store_identity,source_identity),
 FOREIGN KEY(operation_id,store_identity) REFERENCES deletion_source_manifests(operation_id,store_identity)
);
CREATE TABLE IF NOT EXISTS session_artifact_cleanup_outbox (
 job_id TEXT PRIMARY KEY NOT NULL, operation_id TEXT NOT NULL, session_id TEXT,
 project_id TEXT NOT NULL, generation TEXT NOT NULL, store_identity TEXT NOT NULL,
 target_identity TEXT NOT NULL, target_kind TEXT NOT NULL CHECK(target_kind IN ('session_artifact','provider_session','project_directory','project_logo')),
 state TEXT NOT NULL CHECK(state IN ('pending','leased','retry','succeeded','blocked','retained')),
 attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts>=0), lease_token TEXT, lease_until INTEGER,
 UNIQUE(operation_id,store_identity,target_identity,target_kind),
 CHECK((state='leased' AND lease_token IS NOT NULL AND lease_until IS NOT NULL) OR
       (state!='leased' AND lease_token IS NULL AND lease_until IS NULL))
);
CREATE TABLE IF NOT EXISTS platform_activation_receipts (
 operation_id TEXT PRIMARY KEY NOT NULL, database_id TEXT NOT NULL, restore_epoch TEXT NOT NULL,
 file_identity TEXT NOT NULL, approved_path TEXT NOT NULL, tool_build TEXT NOT NULL,
 previous_floor_hash TEXT NOT NULL, target_floor_hash TEXT NOT NULL, guard_hash TEXT NOT NULL
);
`;

/** Additive candidate migration for the EXISTING session_tombstones table. Execute once only in an authorized migration. */
export const SESSION_TOMBSTONE_OPERATION_EXPANSION_SQL = `
ALTER TABLE session_tombstones ADD COLUMN operation_id TEXT;
`;
