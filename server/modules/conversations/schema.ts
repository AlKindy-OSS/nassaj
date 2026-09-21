import { createHash } from 'node:crypto';

import type Database from 'better-sqlite3';

/**
 * Additive, isolated schema for Universal Conversation Contract Revision 2.1.
 *
 * Nothing calls this initializer from the legacy boot path yet. Foundation
 * tests and the future gated migration invoke it explicitly.
 */
export const UNIVERSAL_CONVERSATION_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS conversations (
  conversation_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  created_by TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'archived', 'deleted')),
  next_run_seq INTEGER NOT NULL DEFAULT 1 CHECK (next_run_seq >= 1),
  writer_epoch INTEGER NOT NULL DEFAULT 0 CHECK (writer_epoch >= 0),
  schema_version INTEGER NOT NULL DEFAULT 1 CHECK (schema_version >= 1),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS conversation_participants (
  conversation_id TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner', 'participant', 'viewer')),
  state TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'revoked')),
  writer_epoch INTEGER NOT NULL DEFAULT 0 CHECK (writer_epoch >= 0),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (conversation_id, principal_id),
  FOREIGN KEY (conversation_id) REFERENCES conversations(conversation_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS conversation_writer_state (
  conversation_id TEXT PRIMARY KEY,
  owner_instance_id TEXT,
  writer_epoch INTEGER NOT NULL CHECK (writer_epoch >= 0),
  state TEXT NOT NULL CHECK (state IN ('released', 'recovering', 'active')),
  acquired_at TEXT,
  recovered_at TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (conversation_id) REFERENCES conversations(conversation_id) ON DELETE CASCADE,
  FOREIGN KEY (conversation_id, writer_epoch)
    REFERENCES conversations(conversation_id, writer_epoch) ON UPDATE CASCADE
);

CREATE TABLE IF NOT EXISTS conversation_runs (
  run_id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  run_seq INTEGER NOT NULL CHECK (run_seq >= 1),
  client_msg_id TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  input_event_id TEXT,
  requested_harness TEXT NOT NULL,
  requested_model TEXT,
  status TEXT NOT NULL CHECK (
    status IN ('accepted', 'queued', 'running', 'completed', 'failed', 'aborted', 'uncertain')
  ),
  stop_requested_at TEXT,
  terminal_outcome TEXT CHECK (
    terminal_outcome IS NULL OR
    terminal_outcome IN ('completed', 'failed', 'aborted', 'uncertain')
  ),
  writer_epoch INTEGER NOT NULL CHECK (writer_epoch >= 1),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (conversation_id, run_seq),
  UNIQUE (run_id, conversation_id),
  UNIQUE (run_id, conversation_id, run_seq),
  FOREIGN KEY (conversation_id) REFERENCES conversations(conversation_id) ON DELETE CASCADE,
  CHECK (
    (status IN ('completed', 'failed', 'aborted', 'uncertain') AND terminal_outcome = status)
    OR (status NOT IN ('completed', 'failed', 'aborted', 'uncertain') AND terminal_outcome IS NULL)
  )
);

CREATE TABLE IF NOT EXISTS conversation_segments (
  segment_id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  harness_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  credential_scope_id TEXT NOT NULL,
  credential_binding_id TEXT NOT NULL,
  compatibility_generation TEXT NOT NULL,
  credential_epoch INTEGER NOT NULL CHECK (credential_epoch >= 1),
  physical_ref TEXT,
  state TEXT NOT NULL DEFAULT 'active'
    CHECK (state IN ('active', 'sealed', 'quarantined')),
  projected_run_seq INTEGER NOT NULL DEFAULT 0 CHECK (projected_run_seq >= 0),
  projected_event_seq INTEGER NOT NULL DEFAULT 0 CHECK (projected_event_seq >= 0),
  submitted_run_seq INTEGER NOT NULL DEFAULT 0 CHECK (submitted_run_seq >= 0),
  submitted_event_seq INTEGER NOT NULL DEFAULT 0 CHECK (submitted_event_seq >= 0),
  confirmed_run_seq INTEGER NOT NULL DEFAULT 0 CHECK (confirmed_run_seq >= 0),
  confirmed_event_seq INTEGER NOT NULL DEFAULT 0 CHECK (confirmed_event_seq >= 0),
  checkpoint_evidence TEXT,
  writer_epoch INTEGER NOT NULL CHECK (writer_epoch >= 1),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (segment_id, conversation_id),
  UNIQUE (
    conversation_id, harness_id, user_id, credential_scope_id,
    compatibility_generation, credential_epoch
  ),
  FOREIGN KEY (conversation_id) REFERENCES conversations(conversation_id) ON DELETE CASCADE,
  CHECK (
    submitted_run_seq < projected_run_seq OR
    (submitted_run_seq = projected_run_seq AND submitted_event_seq <= projected_event_seq)
  ),
  CHECK (
    confirmed_run_seq < submitted_run_seq OR
    (confirmed_run_seq = submitted_run_seq AND confirmed_event_seq <= submitted_event_seq)
  )
);

CREATE TABLE IF NOT EXISTS conversation_attempts (
  attempt_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  attempt_no INTEGER NOT NULL CHECK (attempt_no >= 1),
  segment_id TEXT NOT NULL,
  harness_id TEXT NOT NULL,
  adapter_version TEXT NOT NULL,
  runtime_version TEXT NOT NULL,
  model_id TEXT NOT NULL,
  destination_endpoint TEXT NOT NULL,
  credential_scope_id TEXT NOT NULL,
  credential_binding_id TEXT NOT NULL,
  credential_epoch INTEGER NOT NULL CHECK (credential_epoch >= 1),
  state TEXT NOT NULL CHECK (state IN ('scheduled', 'starting', 'running', 'recovering', 'terminal')),
  terminal_outcome TEXT CHECK (
    terminal_outcome IS NULL OR
    terminal_outcome IN ('completed', 'failed', 'aborted', 'uncertain')
  ),
  projected_from_run_seq INTEGER NOT NULL DEFAULT 0,
  projected_from_event_seq INTEGER NOT NULL DEFAULT 0,
  projected_run_seq INTEGER NOT NULL DEFAULT 0,
  projected_event_seq INTEGER NOT NULL DEFAULT 0,
  submitted_run_seq INTEGER NOT NULL DEFAULT 0,
  submitted_event_seq INTEGER NOT NULL DEFAULT 0,
  confirmed_run_seq INTEGER NOT NULL DEFAULT 0,
  confirmed_event_seq INTEGER NOT NULL DEFAULT 0,
  projection_digest TEXT,
  checkpoint_evidence_digest TEXT,
  provider_run_ref TEXT,
  writer_epoch INTEGER NOT NULL CHECK (writer_epoch >= 1),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (run_id, attempt_no),
  UNIQUE (attempt_id, conversation_id, run_id),
  UNIQUE (attempt_id, conversation_id),
  UNIQUE (
    attempt_id, conversation_id, run_id,
    credential_binding_id, credential_epoch
  ),
  UNIQUE (
    attempt_id, conversation_id, run_id, segment_id,
    credential_binding_id, credential_epoch
  ),
  FOREIGN KEY (run_id, conversation_id)
    REFERENCES conversation_runs(run_id, conversation_id) ON DELETE CASCADE,
  FOREIGN KEY (segment_id, conversation_id)
    REFERENCES conversation_segments(segment_id, conversation_id),
  CHECK ((state = 'terminal') = (terminal_outcome IS NOT NULL)),
  CHECK (
    submitted_run_seq < projected_run_seq OR
    (submitted_run_seq = projected_run_seq AND submitted_event_seq <= projected_event_seq)
  ),
  CHECK (
    confirmed_run_seq < submitted_run_seq OR
    (confirmed_run_seq = submitted_run_seq AND confirmed_event_seq <= submitted_event_seq)
  )
);

CREATE TABLE IF NOT EXISTS canonical_events (
  event_id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  attempt_id TEXT,
  run_seq INTEGER NOT NULL CHECK (run_seq >= 1),
  event_seq INTEGER NOT NULL CHECK (event_seq >= 1),
  event_type TEXT NOT NULL,
  actor_type TEXT NOT NULL CHECK (actor_type IN ('user', 'assistant', 'tool', 'system', 'harness')),
  actor_id TEXT,
  visibility TEXT NOT NULL CHECK (visibility IN ('public', 'participant', 'restricted', 'internal')),
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  payload_digest TEXT NOT NULL,
  supersedes_event_id TEXT,
  writer_epoch INTEGER NOT NULL CHECK (writer_epoch >= 1),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (conversation_id, run_seq, event_seq),
  UNIQUE (run_id, event_seq),
  UNIQUE (event_id, conversation_id),
  FOREIGN KEY (run_id, conversation_id, run_seq)
    REFERENCES conversation_runs(run_id, conversation_id, run_seq) ON DELETE CASCADE,
  FOREIGN KEY (attempt_id, conversation_id, run_id)
    REFERENCES conversation_attempts(attempt_id, conversation_id, run_id),
  FOREIGN KEY (supersedes_event_id, conversation_id)
    REFERENCES canonical_events(event_id, conversation_id)
);

CREATE TABLE IF NOT EXISTS context_projections (
  projection_id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL,
  segment_id TEXT NOT NULL,
  requested_by TEXT NOT NULL,
  destination_harness TEXT NOT NULL,
  destination_adapter TEXT NOT NULL,
  destination_runtime TEXT NOT NULL,
  destination_account_scope TEXT NOT NULL,
  destination_model TEXT NOT NULL,
  destination_endpoint TEXT NOT NULL,
  policy_version TEXT NOT NULL,
  policy_epoch INTEGER NOT NULL CHECK (policy_epoch >= 1),
  policy_digest TEXT NOT NULL,
  decision TEXT NOT NULL CHECK (decision IN ('allowed', 'denied')),
  reason_codes_json TEXT NOT NULL CHECK (json_valid(reason_codes_json)),
  from_run_seq INTEGER NOT NULL DEFAULT 0,
  from_event_seq INTEGER NOT NULL DEFAULT 0,
  projected_run_seq INTEGER NOT NULL DEFAULT 0,
  projected_event_seq INTEGER NOT NULL DEFAULT 0,
  submitted_run_seq INTEGER,
  submitted_event_seq INTEGER,
  confirmed_run_seq INTEGER,
  confirmed_event_seq INTEGER,
  event_ids_json TEXT NOT NULL CHECK (json_valid(event_ids_json)),
  omissions_json TEXT NOT NULL CHECK (json_valid(omissions_json)),
  content_digest TEXT NOT NULL,
  credential_binding_id TEXT NOT NULL,
  credential_epoch INTEGER NOT NULL CHECK (credential_epoch >= 1),
  state TEXT NOT NULL CHECK (state IN ('prepared', 'submitted', 'confirmed', 'invalidated', 'denied')),
  writer_epoch INTEGER NOT NULL CHECK (writer_epoch >= 1),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (projection_id, segment_id, content_digest),
  UNIQUE (
    projection_id, segment_id, attempt_id, conversation_id, content_digest
  ),
  FOREIGN KEY (run_id, conversation_id)
    REFERENCES conversation_runs(run_id, conversation_id) ON DELETE CASCADE,
  FOREIGN KEY (attempt_id, conversation_id, run_id)
    REFERENCES conversation_attempts(attempt_id, conversation_id, run_id),
  FOREIGN KEY (
    attempt_id, conversation_id, run_id, credential_binding_id, credential_epoch
  ) REFERENCES conversation_attempts(
    attempt_id, conversation_id, run_id, credential_binding_id, credential_epoch
  ),
  FOREIGN KEY (segment_id, conversation_id)
    REFERENCES conversation_segments(segment_id, conversation_id),
  CHECK ((decision = 'denied') = (state = 'denied')),
  CHECK ((submitted_run_seq IS NULL) = (submitted_event_seq IS NULL)),
  CHECK ((confirmed_run_seq IS NULL) = (confirmed_event_seq IS NULL)),
  CHECK (
    submitted_run_seq IS NULL OR submitted_run_seq < projected_run_seq OR
    (submitted_run_seq = projected_run_seq AND submitted_event_seq <= projected_event_seq)
  ),
  CHECK (
    confirmed_run_seq IS NULL OR
    (submitted_run_seq IS NOT NULL AND (
      confirmed_run_seq < submitted_run_seq OR
      (confirmed_run_seq = submitted_run_seq AND confirmed_event_seq <= submitted_event_seq)
    ))
  )
);

CREATE TABLE IF NOT EXISTS context_watermark_advances (
  advance_id TEXT PRIMARY KEY,
  segment_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  projection_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL,
  mark TEXT NOT NULL CHECK (mark IN ('projected', 'submitted', 'confirmed')),
  through_run_seq INTEGER NOT NULL CHECK (through_run_seq >= 0),
  through_event_seq INTEGER NOT NULL CHECK (through_event_seq >= 0),
  projection_digest TEXT NOT NULL,
  evidence_digest TEXT NOT NULL,
  writer_epoch INTEGER NOT NULL CHECK (writer_epoch >= 1),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (segment_id, conversation_id)
    REFERENCES conversation_segments(segment_id, conversation_id),
  FOREIGN KEY (
    projection_id, segment_id, attempt_id, conversation_id, projection_digest
  ) REFERENCES context_projections(
    projection_id, segment_id, attempt_id, conversation_id, content_digest
  )
);

CREATE TABLE IF NOT EXISTS source_observations (
  observation_id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL,
  segment_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  source_generation INTEGER NOT NULL CHECK (source_generation >= 1),
  source_event_id TEXT NOT NULL,
  source_ordinal INTEGER NOT NULL CHECK (source_ordinal >= 1),
  observed_extent INTEGER NOT NULL CHECK (observed_extent >= 0),
  raw_digest TEXT NOT NULL,
  prefix_chain_digest TEXT NOT NULL,
  predecessor_id TEXT,
  classification TEXT NOT NULL CHECK (
    classification IN ('initial', 'append_only', 'duplicate', 'truncated', 'rewritten', 'reordered', 'missing')
  ),
  status TEXT NOT NULL CHECK (status IN ('accepted', 'idempotent', 'mutation')),
  adapter_version TEXT NOT NULL,
  runtime_version TEXT NOT NULL,
  writer_epoch INTEGER NOT NULL CHECK (writer_epoch >= 1),
  observed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (
    observation_id, conversation_id, segment_id, source_id, source_generation
  ),
  FOREIGN KEY (segment_id, conversation_id)
    REFERENCES conversation_segments(segment_id, conversation_id),
  FOREIGN KEY (predecessor_id) REFERENCES source_observations(observation_id)
);

CREATE TABLE IF NOT EXISTS source_event_keys (
  conversation_id TEXT NOT NULL,
  segment_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  source_generation INTEGER NOT NULL,
  source_event_id TEXT NOT NULL,
  source_ordinal INTEGER NOT NULL,
  raw_digest TEXT NOT NULL,
  accepted_observation_id TEXT NOT NULL,
  writer_epoch INTEGER NOT NULL CHECK (writer_epoch >= 1),
  PRIMARY KEY (
    conversation_id, segment_id, source_id, source_generation, source_event_id
  ),
  UNIQUE (
    conversation_id, segment_id, source_id, source_generation, source_ordinal
  ),
  FOREIGN KEY (segment_id, conversation_id)
    REFERENCES conversation_segments(segment_id, conversation_id),
  FOREIGN KEY (
    accepted_observation_id, conversation_id, segment_id, source_id, source_generation
  ) REFERENCES source_observations(
    observation_id, conversation_id, segment_id, source_id, source_generation
  )
);

CREATE TABLE IF NOT EXISTS conversation_commands (
  command_id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  run_id TEXT,
  principal_id TEXT NOT NULL,
  operation TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_digest TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('prepared', 'dispatched', 'confirmed', 'uncertain')),
  durable_outcome_json TEXT CHECK (durable_outcome_json IS NULL OR json_valid(durable_outcome_json)),
  provider_idempotency_ref TEXT,
  writer_epoch INTEGER NOT NULL CHECK (writer_epoch >= 1),
  credential_binding_id TEXT,
  credential_epoch INTEGER CHECK (credential_epoch IS NULL OR credential_epoch >= 1),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (conversation_id, principal_id, operation, idempotency_key),
  UNIQUE (command_id, conversation_id),
  UNIQUE (command_id, conversation_id, run_id),
  FOREIGN KEY (conversation_id) REFERENCES conversations(conversation_id) ON DELETE CASCADE,
  FOREIGN KEY (run_id, conversation_id)
    REFERENCES conversation_runs(run_id, conversation_id)
);

CREATE TABLE IF NOT EXISTS effect_ledger (
  effect_id TEXT PRIMARY KEY,
  command_id TEXT NOT NULL UNIQUE,
  conversation_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL,
  effect_kind TEXT NOT NULL,
  input_digest TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('prepared', 'dispatched', 'confirmed', 'uncertain')),
  downstream_idempotency_key TEXT NOT NULL,
  evidence_digest TEXT,
  writer_epoch INTEGER NOT NULL CHECK (writer_epoch >= 1),
  credential_binding_id TEXT NOT NULL,
  credential_epoch INTEGER NOT NULL CHECK (credential_epoch >= 1),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (command_id, conversation_id, run_id)
    REFERENCES conversation_commands(command_id, conversation_id, run_id) ON DELETE CASCADE,
  UNIQUE (
    effect_id, conversation_id, run_id, attempt_id,
    credential_binding_id, credential_epoch
  ),
  FOREIGN KEY (
    attempt_id, conversation_id, run_id, credential_binding_id, credential_epoch
  ) REFERENCES conversation_attempts(
    attempt_id, conversation_id, run_id, credential_binding_id, credential_epoch
  )
);

CREATE TABLE IF NOT EXISTS approval_requests (
  approval_id TEXT PRIMARY KEY,
  nonce_digest TEXT NOT NULL UNIQUE,
  user_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL,
  tool_id TEXT NOT NULL,
  input_digest TEXT NOT NULL,
  policy_epoch INTEGER NOT NULL CHECK (policy_epoch >= 1),
  credential_binding_id TEXT NOT NULL,
  credential_epoch INTEGER NOT NULL CHECK (credential_epoch >= 1),
  writer_epoch INTEGER NOT NULL CHECK (writer_epoch >= 1),
  state TEXT NOT NULL CHECK (state IN ('pending', 'granted', 'denied', 'expired', 'consumed')),
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  effect_id TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (run_id, conversation_id)
    REFERENCES conversation_runs(run_id, conversation_id) ON DELETE CASCADE,
  FOREIGN KEY (attempt_id, conversation_id, run_id)
    REFERENCES conversation_attempts(attempt_id, conversation_id, run_id),
  FOREIGN KEY (
    attempt_id, conversation_id, run_id, credential_binding_id, credential_epoch
  ) REFERENCES conversation_attempts(
    attempt_id, conversation_id, run_id, credential_binding_id, credential_epoch
  ),
  FOREIGN KEY (
    effect_id, conversation_id, run_id, attempt_id,
    credential_binding_id, credential_epoch
  ) REFERENCES effect_ledger(
    effect_id, conversation_id, run_id, attempt_id,
    credential_binding_id, credential_epoch
  ),
  CHECK ((state = 'consumed') = (consumed_at IS NOT NULL)),
  CHECK (state != 'consumed' OR effect_id IS NOT NULL)
);

CREATE TABLE IF NOT EXISTS harness_capability_profiles (
  profile_id TEXT PRIMARY KEY,
  harness_id TEXT NOT NULL,
  adapter_version TEXT NOT NULL,
  runtime_version TEXT NOT NULL,
  credential_scope_id TEXT NOT NULL,
  model_id TEXT NOT NULL,
  capabilities_json TEXT NOT NULL CHECK (json_valid(capabilities_json)),
  evidence_at TEXT NOT NULL,
  invalidated_at TEXT,
  UNIQUE (harness_id, adapter_version, runtime_version, credential_scope_id, model_id)
);

-- Phase-0 bridge only. A legacy session id is a protected physical reference;
-- it maps to, but is never reused as, the Nassaj-owned logical identity.
CREATE TABLE IF NOT EXISTS conversation_reference_keys (
  reference_key_version INTEGER PRIMARY KEY CHECK (reference_key_version BETWEEN 1 AND 4294967295),
  key_fingerprint TEXT NOT NULL UNIQUE,
  registered_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS conversation_legacy_links (
  legacy_provider TEXT NOT NULL,
  reference_key_version INTEGER NOT NULL CHECK (reference_key_version BETWEEN 1 AND 4294967295),
  legacy_ref_digest TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  link_kind TEXT NOT NULL CHECK (link_kind = 'resume_verified'),
  first_principal_id TEXT NOT NULL,
  writer_epoch INTEGER NOT NULL CHECK (writer_epoch >= 1),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (legacy_provider, reference_key_version, legacy_ref_digest),
  FOREIGN KEY (conversation_id) REFERENCES conversations(conversation_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS conversation_shadow_ingress (
  principal_id TEXT NOT NULL,
  client_msg_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  request_digest TEXT NOT NULL,
  writer_epoch INTEGER NOT NULL CHECK (writer_epoch >= 1),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (principal_id, client_msg_id),
  FOREIGN KEY (conversation_id) REFERENCES conversations(conversation_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS conversation_shadow_authorizations (
  authorization_id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  authorization_kind TEXT NOT NULL CHECK (authorization_kind IN ('fresh', 'resume')),
  provenance_digest TEXT NOT NULL,
  writer_epoch INTEGER NOT NULL CHECK (writer_epoch >= 1),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (conversation_id, principal_id, authorization_id),
  FOREIGN KEY (conversation_id) REFERENCES conversations(conversation_id) ON DELETE CASCADE
);

-- Durable comparison row for one shadow-accepted legacy turn. It deliberately
-- stores digests and identities only: prompts and provider output never enter
-- the parity ledger.
CREATE TABLE IF NOT EXISTS conversation_shadow_parity (
  run_id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  client_msg_id TEXT NOT NULL,
  request_digest TEXT NOT NULL,
  requested_provider TEXT NOT NULL,
  reference_key_version INTEGER NOT NULL CHECK (reference_key_version BETWEEN 1 AND 4294967295),
  expected_legacy_ref_digest TEXT,
  observed_legacy_ref_digest TEXT,
  identity_state TEXT NOT NULL DEFAULT 'pending'
    CHECK (identity_state IN ('pending', 'match', 'diverged', 'unknown')),
  authorship_state TEXT NOT NULL DEFAULT 'pending'
    CHECK (authorship_state IN ('pending', 'match', 'diverged', 'unknown')),
  order_state TEXT NOT NULL DEFAULT 'pending'
    CHECK (order_state IN ('pending', 'match', 'diverged', 'unknown')),
  shadow_accept_outcome TEXT NOT NULL DEFAULT 'accepted'
    CHECK (shadow_accept_outcome IN ('accepted', 'failed')),
  legacy_accept_outcome TEXT NOT NULL DEFAULT 'pending'
    CHECK (legacy_accept_outcome IN ('pending', 'accepted', 'rejected', 'unknown')),
  legacy_terminal_outcome TEXT NOT NULL DEFAULT 'pending'
    CHECK (legacy_terminal_outcome IN ('pending', 'success', 'error', 'not_started', 'unknown')),
  content_integrity_state TEXT NOT NULL DEFAULT 'pending'
    CHECK (content_integrity_state IN ('pending', 'verified', 'unknown', 'diverged')),
  content_comparison_state TEXT NOT NULL DEFAULT 'pending'
    CHECK (content_comparison_state IN ('pending', 'match', 'unknown', 'diverged')),
  last_observation_seq INTEGER NOT NULL DEFAULT 0 CHECK (last_observation_seq >= 0),
  terminal_observed INTEGER NOT NULL DEFAULT 0 CHECK (terminal_observed IN (0, 1)),
  legacy_dispatch_count INTEGER NOT NULL DEFAULT 0 CHECK (legacy_dispatch_count >= 0),
  duplicate_count INTEGER NOT NULL DEFAULT 0 CHECK (duplicate_count >= 0),
  divergence_codes_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(divergence_codes_json)),
  writer_epoch INTEGER NOT NULL CHECK (writer_epoch >= 1),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (conversation_id, principal_id, client_msg_id),
  FOREIGN KEY (run_id, conversation_id)
    REFERENCES conversation_runs(run_id, conversation_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS conversation_shadow_observations (
  observation_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  observation_seq INTEGER NOT NULL CHECK (observation_seq >= 1),
  legacy_kind TEXT NOT NULL,
  reference_key_version INTEGER NOT NULL CHECK (reference_key_version BETWEEN 1 AND 4294967295),
  legacy_ref_digest TEXT,
  verification_state TEXT NOT NULL DEFAULT 'unavailable'
    CHECK (verification_state IN ('pending', 'verified', 'rejected', 'unavailable')),
  envelope_digest TEXT NOT NULL,
  dispatch_generation INTEGER NOT NULL DEFAULT 0 CHECK (dispatch_generation >= 0),
  terminal INTEGER NOT NULL DEFAULT 0 CHECK (terminal IN (0, 1)),
  writer_epoch INTEGER NOT NULL CHECK (writer_epoch >= 1),
  observed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (run_id, observation_seq),
  FOREIGN KEY (run_id, conversation_id)
    REFERENCES conversation_runs(run_id, conversation_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS conversation_shadow_content_summaries (
  run_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  dispatch_generation INTEGER NOT NULL CHECK (dispatch_generation >= 1),
  reference_key_version INTEGER NOT NULL CHECK (reference_key_version BETWEEN 1 AND 4294967295),
  integrity_state TEXT NOT NULL CHECK (integrity_state IN ('verified', 'unknown', 'diverged')),
  content_digest TEXT NOT NULL CHECK (
    length(content_digest) = 64 AND content_digest NOT GLOB '*[^0-9a-f]*'
  ),
  summary_digest TEXT NOT NULL CHECK (
    length(summary_digest) = 64 AND summary_digest NOT GLOB '*[^0-9a-f]*'
  ),
  segment_count INTEGER NOT NULL CHECK (segment_count BETWEEN 0 AND 100001),
  source_chunk_count INTEGER NOT NULL CHECK (source_chunk_count BETWEEN 0 AND 100001),
  canonical_bytes INTEGER NOT NULL CHECK (canonical_bytes BETWEEN 0 AND 67108864),
  duplicate_event_count INTEGER NOT NULL CHECK (duplicate_event_count BETWEEN 0 AND 100001),
  overflow INTEGER NOT NULL CHECK (overflow IN (0, 1)),
  schema_gap INTEGER NOT NULL CHECK (schema_gap IN (0, 1)),
  reentrant INTEGER NOT NULL CHECK (reentrant IN (0, 1)),
  substitution_count INTEGER NOT NULL CHECK (substitution_count BETWEEN 0 AND 100001),
  sequence_gap_count INTEGER NOT NULL CHECK (sequence_gap_count BETWEEN 0 AND 100001),
  sequence_reorder_count INTEGER NOT NULL CHECK (sequence_reorder_count BETWEEN 0 AND 100001),
  terminal_outcome TEXT NOT NULL
    CHECK (terminal_outcome IN ('success', 'error', 'not_started', 'unknown')),
  writer_epoch INTEGER NOT NULL CHECK (writer_epoch >= 1),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (run_id, dispatch_generation),
  FOREIGN KEY (reference_key_version)
    REFERENCES conversation_reference_keys(reference_key_version),
  FOREIGN KEY (run_id, conversation_id)
    REFERENCES conversation_runs(run_id, conversation_id) ON DELETE CASCADE
);

-- Recovery is evidence gathering only in Phase 0. Rows prove that every
-- prepared/dispatched/uncertain record was classified before writer activation;
-- the service never dispatches, retries, or calls a harness.
CREATE TABLE IF NOT EXISTS conversation_shadow_recovery (
  recovery_id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  writer_epoch INTEGER NOT NULL CHECK (writer_epoch >= 1),
  record_type TEXT NOT NULL CHECK (
    record_type IN ('command', 'effect', 'attempt', 'parity', 'link_candidate')
  ),
  record_id TEXT NOT NULL,
  prior_state TEXT NOT NULL,
  disposition TEXT NOT NULL CHECK (
    disposition IN ('safe_unstarted', 'requires_reconciliation', 'operator_review')
  ),
  recovered_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (conversation_id, writer_epoch, record_type, record_id),
  FOREIGN KEY (conversation_id) REFERENCES conversations(conversation_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS conversation_shadow_divergences (
  divergence_id TEXT PRIMARY KEY,
  conversation_id TEXT,
  run_id TEXT,
  principal_id TEXT,
  code TEXT NOT NULL,
  phase TEXT NOT NULL,
  writer_epoch INTEGER,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (conversation_id) REFERENCES conversations(conversation_id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_conversations_epoch
  ON conversations(conversation_id, writer_epoch);
CREATE INDEX IF NOT EXISTS idx_runs_replay
  ON conversation_runs(conversation_id, run_seq);
CREATE INDEX IF NOT EXISTS idx_events_replay
  ON canonical_events(conversation_id, run_seq, event_seq);
CREATE INDEX IF NOT EXISTS idx_attempts_recovery
  ON conversation_attempts(state, updated_at);
CREATE INDEX IF NOT EXISTS idx_segments_lookup
  ON conversation_segments(conversation_id, harness_id, user_id, state);
CREATE INDEX IF NOT EXISTS idx_projections_destination
  ON context_projections(segment_id, state, created_at);
CREATE INDEX IF NOT EXISTS idx_source_observations_chain
  ON source_observations(source_id, source_generation, source_ordinal);
CREATE INDEX IF NOT EXISTS idx_commands_recovery
  ON conversation_commands(state, updated_at);
CREATE INDEX IF NOT EXISTS idx_effects_recovery
  ON effect_ledger(state, updated_at);
CREATE INDEX IF NOT EXISTS idx_approvals_expiry
  ON approval_requests(state, expires_at);
CREATE INDEX IF NOT EXISTS idx_conversation_legacy_links_conversation
  ON conversation_legacy_links(conversation_id);
CREATE INDEX IF NOT EXISTS idx_shadow_ingress_conversation
  ON conversation_shadow_ingress(conversation_id);
CREATE INDEX IF NOT EXISTS idx_shadow_parity_states
  ON conversation_shadow_parity(identity_state, authorship_state, order_state, legacy_accept_outcome);
CREATE INDEX IF NOT EXISTS idx_shadow_content_summary_state
  ON conversation_shadow_content_summaries(integrity_state, created_at);
CREATE INDEX IF NOT EXISTS idx_shadow_recovery_epoch
  ON conversation_shadow_recovery(conversation_id, writer_epoch);
CREATE INDEX IF NOT EXISTS idx_shadow_divergences_created
  ON conversation_shadow_divergences(created_at);

CREATE TRIGGER IF NOT EXISTS trg_conversations_identity_update
BEFORE UPDATE ON conversations BEGIN
  SELECT CASE WHEN NEW.conversation_id IS NOT OLD.conversation_id
    OR NEW.project_id IS NOT OLD.project_id
    OR NEW.created_by IS NOT OLD.created_by
    OR NEW.schema_version IS NOT OLD.schema_version
    OR NEW.created_at IS NOT OLD.created_at
  THEN RAISE(ABORT, 'CONVERSATION_IDENTITY_IMMUTABLE') END;
END;
CREATE TRIGGER IF NOT EXISTS trg_conversations_append_only_delete
BEFORE DELETE ON conversations BEGIN
  SELECT RAISE(ABORT, 'CONVERSATION_APPEND_ONLY');
END;
CREATE TRIGGER IF NOT EXISTS trg_writer_state_identity_update
BEFORE UPDATE ON conversation_writer_state BEGIN
  SELECT CASE WHEN NEW.conversation_id IS NOT OLD.conversation_id
    THEN RAISE(ABORT, 'WRITER_STATE_IDENTITY_IMMUTABLE') END;
END;
CREATE TRIGGER IF NOT EXISTS trg_writer_state_append_only_delete
BEFORE DELETE ON conversation_writer_state BEGIN
  SELECT RAISE(ABORT, 'WRITER_STATE_APPEND_ONLY');
END;

CREATE TRIGGER IF NOT EXISTS trg_runs_writer_insert
BEFORE INSERT ON conversation_runs BEGIN
  SELECT CASE WHEN NEW.writer_epoch != (
    SELECT writer_epoch FROM conversations WHERE conversation_id = NEW.conversation_id
  ) THEN RAISE(ABORT, 'STALE_WRITER_EPOCH') END;
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM conversations c JOIN conversation_writer_state w USING (conversation_id)
     WHERE c.conversation_id = NEW.conversation_id AND c.writer_epoch = NEW.writer_epoch
       AND w.writer_epoch = NEW.writer_epoch AND w.state = 'active'
  ) THEN RAISE(ABORT, 'NOT_ACTIVE_WRITER') END;
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM conversation_participants p
     WHERE p.conversation_id = NEW.conversation_id AND p.principal_id = NEW.principal_id
       AND p.state = 'active' AND p.role IN ('owner', 'participant')
  ) THEN RAISE(ABORT, 'PRINCIPAL_NOT_AUTHORIZED') END;
END;

CREATE TRIGGER IF NOT EXISTS trg_runs_writer_update
BEFORE UPDATE ON conversation_runs BEGIN
  SELECT CASE WHEN NEW.writer_epoch != (
    SELECT writer_epoch FROM conversations WHERE conversation_id = NEW.conversation_id
  ) THEN RAISE(ABORT, 'STALE_WRITER_EPOCH') END;
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM conversations c JOIN conversation_writer_state w USING (conversation_id)
     WHERE c.conversation_id = NEW.conversation_id AND c.writer_epoch = NEW.writer_epoch
       AND w.writer_epoch = NEW.writer_epoch AND w.state = 'active'
  ) THEN RAISE(ABORT, 'NOT_ACTIVE_WRITER') END;
  SELECT CASE WHEN NEW.run_id IS NOT OLD.run_id
    OR NEW.conversation_id IS NOT OLD.conversation_id
    OR NEW.run_seq IS NOT OLD.run_seq
    OR NEW.client_msg_id IS NOT OLD.client_msg_id
    OR NEW.principal_id IS NOT OLD.principal_id
    OR NEW.input_event_id IS NOT OLD.input_event_id
    OR NEW.requested_harness IS NOT OLD.requested_harness
    OR NEW.requested_model IS NOT OLD.requested_model
  THEN RAISE(ABORT, 'RUN_IDENTITY_IMMUTABLE') END;
END;
CREATE TRIGGER IF NOT EXISTS trg_runs_append_only_delete
BEFORE DELETE ON conversation_runs BEGIN
  SELECT RAISE(ABORT, 'RUN_APPEND_ONLY');
END;

CREATE TRIGGER IF NOT EXISTS trg_participants_writer_insert
BEFORE INSERT ON conversation_participants BEGIN
  SELECT CASE WHEN NOT (
    (NEW.writer_epoch = 0 AND EXISTS (
      SELECT 1 FROM conversations c WHERE c.conversation_id = NEW.conversation_id
        AND c.writer_epoch = 0 AND c.created_by = NEW.principal_id
    )) OR EXISTS (
      SELECT 1 FROM conversations c JOIN conversation_writer_state w USING (conversation_id)
       WHERE c.conversation_id = NEW.conversation_id AND c.writer_epoch = NEW.writer_epoch
         AND w.writer_epoch = NEW.writer_epoch AND w.state = 'active'
    )
  ) THEN RAISE(ABORT, 'NOT_ACTIVE_WRITER') END;
END;
CREATE TRIGGER IF NOT EXISTS trg_participants_writer_update
BEFORE UPDATE ON conversation_participants BEGIN
  SELECT CASE WHEN NEW.conversation_id IS NOT OLD.conversation_id
    OR NEW.principal_id IS NOT OLD.principal_id
  THEN RAISE(ABORT, 'PARTICIPANT_IDENTITY_IMMUTABLE') END;
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM conversations c JOIN conversation_writer_state w USING (conversation_id)
     WHERE c.conversation_id = NEW.conversation_id AND c.writer_epoch = NEW.writer_epoch
       AND w.writer_epoch = NEW.writer_epoch AND w.state = 'active'
  ) THEN RAISE(ABORT, 'NOT_ACTIVE_WRITER') END;
END;
CREATE TRIGGER IF NOT EXISTS trg_participants_append_only_delete
BEFORE DELETE ON conversation_participants BEGIN
  SELECT RAISE(ABORT, 'PARTICIPANT_APPEND_ONLY');
END;

CREATE TRIGGER IF NOT EXISTS trg_segments_writer_insert
BEFORE INSERT ON conversation_segments BEGIN
  SELECT CASE WHEN NEW.writer_epoch != (SELECT writer_epoch FROM conversations WHERE conversation_id = NEW.conversation_id)
    THEN RAISE(ABORT, 'STALE_WRITER_EPOCH') END;
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM conversations c JOIN conversation_writer_state w USING (conversation_id)
     WHERE c.conversation_id = NEW.conversation_id AND c.writer_epoch = NEW.writer_epoch
       AND w.writer_epoch = NEW.writer_epoch AND w.state = 'active'
  ) THEN RAISE(ABORT, 'NOT_ACTIVE_WRITER') END;
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM conversation_participants p
     WHERE p.conversation_id = NEW.conversation_id AND p.principal_id = NEW.user_id
       AND p.state = 'active' AND p.role IN ('owner', 'participant')
  ) THEN RAISE(ABORT, 'PRINCIPAL_NOT_AUTHORIZED') END;
END;

CREATE TRIGGER IF NOT EXISTS trg_segments_writer_update
BEFORE UPDATE ON conversation_segments BEGIN
  SELECT CASE WHEN NEW.writer_epoch != (SELECT writer_epoch FROM conversations WHERE conversation_id = NEW.conversation_id)
    THEN RAISE(ABORT, 'STALE_WRITER_EPOCH') END;
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM conversations c JOIN conversation_writer_state w USING (conversation_id)
     WHERE c.conversation_id = NEW.conversation_id AND c.writer_epoch = NEW.writer_epoch
       AND w.writer_epoch = NEW.writer_epoch AND w.state = 'active'
  ) THEN RAISE(ABORT, 'NOT_ACTIVE_WRITER') END;
  SELECT CASE WHEN NEW.segment_id IS NOT OLD.segment_id
    OR NEW.conversation_id IS NOT OLD.conversation_id
    OR NEW.harness_id IS NOT OLD.harness_id OR NEW.user_id IS NOT OLD.user_id
    OR NEW.credential_scope_id IS NOT OLD.credential_scope_id
    OR NEW.credential_binding_id IS NOT OLD.credential_binding_id
    OR NEW.compatibility_generation IS NOT OLD.compatibility_generation
    OR NEW.credential_epoch IS NOT OLD.credential_epoch
  THEN RAISE(ABORT, 'SEGMENT_IDENTITY_IMMUTABLE') END;
END;
CREATE TRIGGER IF NOT EXISTS trg_segments_append_only_delete
BEFORE DELETE ON conversation_segments BEGIN
  SELECT RAISE(ABORT, 'SEGMENT_APPEND_ONLY');
END;

CREATE TRIGGER IF NOT EXISTS trg_attempts_writer_insert
BEFORE INSERT ON conversation_attempts BEGIN
  SELECT CASE WHEN NEW.writer_epoch != (SELECT writer_epoch FROM conversations WHERE conversation_id = NEW.conversation_id)
    THEN RAISE(ABORT, 'STALE_WRITER_EPOCH') END;
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM conversations c JOIN conversation_writer_state w USING (conversation_id)
     WHERE c.conversation_id = NEW.conversation_id AND c.writer_epoch = NEW.writer_epoch
       AND w.writer_epoch = NEW.writer_epoch AND w.state = 'active'
  ) THEN RAISE(ABORT, 'NOT_ACTIVE_WRITER') END;
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM conversation_segments s JOIN conversation_runs r
      ON r.conversation_id = s.conversation_id
     WHERE s.segment_id = NEW.segment_id AND s.conversation_id = NEW.conversation_id
       AND r.run_id = NEW.run_id AND s.state = 'active'
       AND s.user_id = r.principal_id AND s.harness_id = NEW.harness_id
       AND s.credential_scope_id = NEW.credential_scope_id
       AND s.credential_binding_id = NEW.credential_binding_id
       AND s.credential_epoch = NEW.credential_epoch
  ) THEN RAISE(ABORT, 'ATTEMPT_SCOPE_MISMATCH') END;
END;

CREATE TRIGGER IF NOT EXISTS trg_attempts_writer_update
BEFORE UPDATE ON conversation_attempts BEGIN
  SELECT CASE WHEN NEW.writer_epoch != (SELECT writer_epoch FROM conversations WHERE conversation_id = NEW.conversation_id)
    THEN RAISE(ABORT, 'STALE_WRITER_EPOCH') END;
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM conversations c JOIN conversation_writer_state w USING (conversation_id)
     WHERE c.conversation_id = NEW.conversation_id AND c.writer_epoch = NEW.writer_epoch
       AND w.writer_epoch = NEW.writer_epoch AND w.state = 'active'
  ) THEN RAISE(ABORT, 'NOT_ACTIVE_WRITER') END;
  SELECT CASE WHEN NEW.attempt_id IS NOT OLD.attempt_id OR NEW.run_id IS NOT OLD.run_id
    OR NEW.conversation_id IS NOT OLD.conversation_id OR NEW.attempt_no IS NOT OLD.attempt_no
    OR NEW.segment_id IS NOT OLD.segment_id OR NEW.harness_id IS NOT OLD.harness_id
    OR NEW.adapter_version IS NOT OLD.adapter_version
    OR NEW.runtime_version IS NOT OLD.runtime_version OR NEW.model_id IS NOT OLD.model_id
    OR NEW.destination_endpoint IS NOT OLD.destination_endpoint
    OR NEW.credential_scope_id IS NOT OLD.credential_scope_id
    OR NEW.credential_binding_id IS NOT OLD.credential_binding_id
    OR NEW.credential_epoch IS NOT OLD.credential_epoch
  THEN RAISE(ABORT, 'ATTEMPT_IDENTITY_IMMUTABLE') END;
END;
CREATE TRIGGER IF NOT EXISTS trg_attempts_append_only_delete
BEFORE DELETE ON conversation_attempts BEGIN
  SELECT RAISE(ABORT, 'ATTEMPT_APPEND_ONLY');
END;

CREATE TRIGGER IF NOT EXISTS trg_events_writer_insert
BEFORE INSERT ON canonical_events BEGIN
  SELECT CASE WHEN NEW.writer_epoch != (SELECT writer_epoch FROM conversations WHERE conversation_id = NEW.conversation_id)
    THEN RAISE(ABORT, 'STALE_WRITER_EPOCH') END;
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM conversations c JOIN conversation_writer_state w USING (conversation_id)
     WHERE c.conversation_id = NEW.conversation_id AND c.writer_epoch = NEW.writer_epoch
       AND w.writer_epoch = NEW.writer_epoch AND w.state = 'active'
  ) THEN RAISE(ABORT, 'NOT_ACTIVE_WRITER') END;
END;
CREATE TRIGGER IF NOT EXISTS trg_events_immutable_update
BEFORE UPDATE ON canonical_events BEGIN
  SELECT RAISE(ABORT, 'CANONICAL_EVENT_IMMUTABLE');
END;
CREATE TRIGGER IF NOT EXISTS trg_events_immutable_delete
BEFORE DELETE ON canonical_events BEGIN
  SELECT RAISE(ABORT, 'CANONICAL_EVENT_IMMUTABLE');
END;

CREATE TRIGGER IF NOT EXISTS trg_projections_writer_insert
BEFORE INSERT ON context_projections BEGIN
  SELECT CASE WHEN NEW.writer_epoch != (SELECT writer_epoch FROM conversations WHERE conversation_id = NEW.conversation_id)
    THEN RAISE(ABORT, 'STALE_WRITER_EPOCH') END;
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM conversations c JOIN conversation_writer_state w USING (conversation_id)
     WHERE c.conversation_id = NEW.conversation_id AND c.writer_epoch = NEW.writer_epoch
       AND w.writer_epoch = NEW.writer_epoch AND w.state = 'active'
  ) THEN RAISE(ABORT, 'NOT_ACTIVE_WRITER') END;
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM conversation_attempts a JOIN conversation_segments s
      ON s.segment_id = a.segment_id AND s.conversation_id = a.conversation_id
      JOIN conversation_runs r ON r.run_id = a.run_id AND r.conversation_id = a.conversation_id
     WHERE a.attempt_id = NEW.attempt_id AND a.run_id = NEW.run_id
       AND a.conversation_id = NEW.conversation_id AND a.segment_id = NEW.segment_id
       AND r.principal_id = NEW.requested_by
       AND s.state = 'active' AND s.harness_id = NEW.destination_harness
       AND a.adapter_version = NEW.destination_adapter
       AND a.runtime_version = NEW.destination_runtime
       AND a.model_id = NEW.destination_model
       AND a.destination_endpoint = NEW.destination_endpoint
       AND s.credential_scope_id = NEW.destination_account_scope
       AND s.credential_binding_id = NEW.credential_binding_id
       AND s.credential_epoch = NEW.credential_epoch
  ) THEN RAISE(ABORT, 'PROJECTION_DESTINATION_MISMATCH') END;
END;
CREATE TRIGGER IF NOT EXISTS trg_projections_writer_update
BEFORE UPDATE ON context_projections BEGIN
  SELECT CASE WHEN NEW.writer_epoch != (SELECT writer_epoch FROM conversations WHERE conversation_id = NEW.conversation_id)
    THEN RAISE(ABORT, 'STALE_WRITER_EPOCH') END;
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM conversations c JOIN conversation_writer_state w USING (conversation_id)
     WHERE c.conversation_id = NEW.conversation_id AND c.writer_epoch = NEW.writer_epoch
       AND w.writer_epoch = NEW.writer_epoch AND w.state = 'active'
  ) THEN RAISE(ABORT, 'NOT_ACTIVE_WRITER') END;
  SELECT CASE WHEN NEW.projection_id IS NOT OLD.projection_id
    OR NEW.conversation_id IS NOT OLD.conversation_id OR NEW.run_id IS NOT OLD.run_id
    OR NEW.attempt_id IS NOT OLD.attempt_id OR NEW.segment_id IS NOT OLD.segment_id
    OR NEW.requested_by IS NOT OLD.requested_by
    OR NEW.destination_harness IS NOT OLD.destination_harness
    OR NEW.destination_adapter IS NOT OLD.destination_adapter
    OR NEW.destination_runtime IS NOT OLD.destination_runtime
    OR NEW.destination_account_scope IS NOT OLD.destination_account_scope
    OR NEW.destination_model IS NOT OLD.destination_model
    OR NEW.destination_endpoint IS NOT OLD.destination_endpoint
    OR NEW.policy_version IS NOT OLD.policy_version OR NEW.policy_epoch IS NOT OLD.policy_epoch
    OR NEW.policy_digest IS NOT OLD.policy_digest OR NEW.decision IS NOT OLD.decision
    OR NEW.content_digest IS NOT OLD.content_digest
    OR NEW.credential_binding_id IS NOT OLD.credential_binding_id
    OR NEW.credential_epoch IS NOT OLD.credential_epoch
  THEN RAISE(ABORT, 'PROJECTION_IDENTITY_IMMUTABLE') END;
END;
CREATE TRIGGER IF NOT EXISTS trg_projections_append_only_delete
BEFORE DELETE ON context_projections BEGIN
  SELECT RAISE(ABORT, 'PROJECTION_APPEND_ONLY');
END;

CREATE TRIGGER IF NOT EXISTS trg_watermarks_writer_insert
BEFORE INSERT ON context_watermark_advances BEGIN
  SELECT CASE WHEN NEW.writer_epoch != (SELECT writer_epoch FROM conversations WHERE conversation_id = NEW.conversation_id)
    THEN RAISE(ABORT, 'STALE_WRITER_EPOCH') END;
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM conversations c JOIN conversation_writer_state w USING (conversation_id)
     WHERE c.conversation_id = NEW.conversation_id AND c.writer_epoch = NEW.writer_epoch
       AND w.writer_epoch = NEW.writer_epoch AND w.state = 'active'
  ) THEN RAISE(ABORT, 'NOT_ACTIVE_WRITER') END;
END;
CREATE TRIGGER IF NOT EXISTS trg_watermarks_immutable_update
BEFORE UPDATE ON context_watermark_advances BEGIN SELECT RAISE(ABORT, 'WATERMARK_EVIDENCE_IMMUTABLE'); END;
CREATE TRIGGER IF NOT EXISTS trg_watermarks_immutable_delete
BEFORE DELETE ON context_watermark_advances BEGIN SELECT RAISE(ABORT, 'WATERMARK_EVIDENCE_IMMUTABLE'); END;

CREATE TRIGGER IF NOT EXISTS trg_source_observations_writer_insert
BEFORE INSERT ON source_observations BEGIN
  SELECT CASE WHEN NEW.writer_epoch != (SELECT writer_epoch FROM conversations WHERE conversation_id = NEW.conversation_id)
    THEN RAISE(ABORT, 'STALE_WRITER_EPOCH') END;
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM conversations c JOIN conversation_writer_state w USING (conversation_id)
     WHERE c.conversation_id = NEW.conversation_id AND c.writer_epoch = NEW.writer_epoch
       AND w.writer_epoch = NEW.writer_epoch AND w.state = 'active'
  ) THEN RAISE(ABORT, 'NOT_ACTIVE_WRITER') END;
  SELECT CASE WHEN NEW.predecessor_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM source_observations p
     WHERE p.observation_id = NEW.predecessor_id AND p.conversation_id = NEW.conversation_id
       AND p.segment_id = NEW.segment_id AND p.source_id = NEW.source_id
       AND p.source_generation = NEW.source_generation
  ) THEN RAISE(ABORT, 'SOURCE_SCOPE_MISMATCH') END;
END;
CREATE TRIGGER IF NOT EXISTS trg_source_observations_immutable_update
BEFORE UPDATE ON source_observations BEGIN SELECT RAISE(ABORT, 'SOURCE_OBSERVATION_IMMUTABLE'); END;
CREATE TRIGGER IF NOT EXISTS trg_source_observations_immutable_delete
BEFORE DELETE ON source_observations BEGIN SELECT RAISE(ABORT, 'SOURCE_OBSERVATION_IMMUTABLE'); END;

CREATE TRIGGER IF NOT EXISTS trg_source_keys_writer_insert
BEFORE INSERT ON source_event_keys BEGIN
  SELECT CASE WHEN NEW.writer_epoch != (SELECT writer_epoch FROM conversations WHERE conversation_id = NEW.conversation_id)
    THEN RAISE(ABORT, 'STALE_WRITER_EPOCH') END;
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM conversations c JOIN conversation_writer_state w USING (conversation_id)
     WHERE c.conversation_id = NEW.conversation_id AND c.writer_epoch = NEW.writer_epoch
       AND w.writer_epoch = NEW.writer_epoch AND w.state = 'active'
  ) THEN RAISE(ABORT, 'NOT_ACTIVE_WRITER') END;
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM source_observations o
     WHERE o.observation_id = NEW.accepted_observation_id
       AND o.conversation_id = NEW.conversation_id AND o.segment_id = NEW.segment_id
       AND o.source_id = NEW.source_id AND o.source_generation = NEW.source_generation
  ) THEN RAISE(ABORT, 'SOURCE_SCOPE_MISMATCH') END;
END;
CREATE TRIGGER IF NOT EXISTS trg_source_keys_immutable_update
BEFORE UPDATE ON source_event_keys BEGIN SELECT RAISE(ABORT, 'SOURCE_KEY_IMMUTABLE'); END;
CREATE TRIGGER IF NOT EXISTS trg_source_keys_immutable_delete
BEFORE DELETE ON source_event_keys BEGIN SELECT RAISE(ABORT, 'SOURCE_KEY_IMMUTABLE'); END;

CREATE TRIGGER IF NOT EXISTS trg_commands_writer_insert
BEFORE INSERT ON conversation_commands BEGIN
  SELECT CASE WHEN NEW.writer_epoch != (SELECT writer_epoch FROM conversations WHERE conversation_id = NEW.conversation_id)
    THEN RAISE(ABORT, 'STALE_WRITER_EPOCH') END;
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM conversations c JOIN conversation_writer_state w USING (conversation_id)
     WHERE c.conversation_id = NEW.conversation_id AND c.writer_epoch = NEW.writer_epoch
       AND w.writer_epoch = NEW.writer_epoch AND w.state = 'active'
  ) THEN RAISE(ABORT, 'NOT_ACTIVE_WRITER') END;
END;
CREATE TRIGGER IF NOT EXISTS trg_commands_writer_update
BEFORE UPDATE ON conversation_commands BEGIN
  SELECT CASE WHEN NEW.writer_epoch != (SELECT writer_epoch FROM conversations WHERE conversation_id = NEW.conversation_id)
    THEN RAISE(ABORT, 'STALE_WRITER_EPOCH') END;
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM conversations c JOIN conversation_writer_state w USING (conversation_id)
     WHERE c.conversation_id = NEW.conversation_id AND c.writer_epoch = NEW.writer_epoch
       AND w.writer_epoch = NEW.writer_epoch AND w.state = 'active'
  ) THEN RAISE(ABORT, 'NOT_ACTIVE_WRITER') END;
  SELECT CASE WHEN NEW.command_id IS NOT OLD.command_id
    OR NEW.conversation_id IS NOT OLD.conversation_id OR NEW.run_id IS NOT OLD.run_id
    OR NEW.principal_id IS NOT OLD.principal_id OR NEW.operation IS NOT OLD.operation
    OR NEW.idempotency_key IS NOT OLD.idempotency_key
    OR NEW.request_digest IS NOT OLD.request_digest
    OR NEW.credential_binding_id IS NOT OLD.credential_binding_id
    OR NEW.credential_epoch IS NOT OLD.credential_epoch
  THEN RAISE(ABORT, 'COMMAND_IDENTITY_IMMUTABLE') END;
END;
CREATE TRIGGER IF NOT EXISTS trg_commands_append_only_delete
BEFORE DELETE ON conversation_commands BEGIN
  SELECT RAISE(ABORT, 'COMMAND_APPEND_ONLY');
END;

CREATE TRIGGER IF NOT EXISTS trg_effects_writer_insert
BEFORE INSERT ON effect_ledger BEGIN
  SELECT CASE WHEN NEW.writer_epoch != (SELECT writer_epoch FROM conversations WHERE conversation_id = NEW.conversation_id)
    THEN RAISE(ABORT, 'STALE_WRITER_EPOCH') END;
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM conversations c JOIN conversation_writer_state w USING (conversation_id)
     WHERE c.conversation_id = NEW.conversation_id AND c.writer_epoch = NEW.writer_epoch
       AND w.writer_epoch = NEW.writer_epoch AND w.state = 'active'
  ) THEN RAISE(ABORT, 'NOT_ACTIVE_WRITER') END;
END;
CREATE TRIGGER IF NOT EXISTS trg_effects_writer_update
BEFORE UPDATE ON effect_ledger BEGIN
  SELECT CASE WHEN NEW.writer_epoch != (SELECT writer_epoch FROM conversations WHERE conversation_id = NEW.conversation_id)
    THEN RAISE(ABORT, 'STALE_WRITER_EPOCH') END;
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM conversations c JOIN conversation_writer_state w USING (conversation_id)
     WHERE c.conversation_id = NEW.conversation_id AND c.writer_epoch = NEW.writer_epoch
       AND w.writer_epoch = NEW.writer_epoch AND w.state = 'active'
  ) THEN RAISE(ABORT, 'NOT_ACTIVE_WRITER') END;
  SELECT CASE WHEN NEW.effect_id IS NOT OLD.effect_id OR NEW.command_id IS NOT OLD.command_id
    OR NEW.conversation_id IS NOT OLD.conversation_id OR NEW.run_id IS NOT OLD.run_id
    OR NEW.attempt_id IS NOT OLD.attempt_id OR NEW.effect_kind IS NOT OLD.effect_kind
    OR NEW.input_digest IS NOT OLD.input_digest
    OR NEW.downstream_idempotency_key IS NOT OLD.downstream_idempotency_key
    OR NEW.credential_binding_id IS NOT OLD.credential_binding_id
    OR NEW.credential_epoch IS NOT OLD.credential_epoch
  THEN RAISE(ABORT, 'EFFECT_IDENTITY_IMMUTABLE') END;
END;
CREATE TRIGGER IF NOT EXISTS trg_effects_append_only_delete
BEFORE DELETE ON effect_ledger BEGIN
  SELECT RAISE(ABORT, 'EFFECT_APPEND_ONLY');
END;

CREATE TRIGGER IF NOT EXISTS trg_approvals_writer_insert
BEFORE INSERT ON approval_requests BEGIN
  SELECT CASE WHEN NEW.writer_epoch != (SELECT writer_epoch FROM conversations WHERE conversation_id = NEW.conversation_id)
    THEN RAISE(ABORT, 'STALE_WRITER_EPOCH') END;
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM conversations c JOIN conversation_writer_state w USING (conversation_id)
     WHERE c.conversation_id = NEW.conversation_id AND c.writer_epoch = NEW.writer_epoch
       AND w.writer_epoch = NEW.writer_epoch AND w.state = 'active'
  ) THEN RAISE(ABORT, 'NOT_ACTIVE_WRITER') END;
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM conversation_attempts a JOIN conversation_runs r
      ON r.run_id = a.run_id AND r.conversation_id = a.conversation_id
     WHERE a.attempt_id = NEW.attempt_id AND a.conversation_id = NEW.conversation_id
       AND a.run_id = NEW.run_id AND r.principal_id = NEW.user_id
       AND a.credential_binding_id = NEW.credential_binding_id
       AND a.credential_epoch = NEW.credential_epoch
  ) THEN RAISE(ABORT, 'APPROVAL_SCOPE_MISMATCH') END;
END;
CREATE TRIGGER IF NOT EXISTS trg_approvals_writer_update
BEFORE UPDATE ON approval_requests BEGIN
  SELECT CASE WHEN NEW.writer_epoch != (SELECT writer_epoch FROM conversations WHERE conversation_id = NEW.conversation_id)
    THEN RAISE(ABORT, 'STALE_WRITER_EPOCH') END;
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM conversations c JOIN conversation_writer_state w USING (conversation_id)
     WHERE c.conversation_id = NEW.conversation_id AND c.writer_epoch = NEW.writer_epoch
       AND w.writer_epoch = NEW.writer_epoch AND w.state = 'active'
  ) THEN RAISE(ABORT, 'NOT_ACTIVE_WRITER') END;
  SELECT CASE WHEN NEW.approval_id IS NOT OLD.approval_id
    OR NEW.nonce_digest IS NOT OLD.nonce_digest OR NEW.user_id IS NOT OLD.user_id
    OR NEW.conversation_id IS NOT OLD.conversation_id OR NEW.run_id IS NOT OLD.run_id
    OR NEW.attempt_id IS NOT OLD.attempt_id OR NEW.tool_id IS NOT OLD.tool_id
    OR NEW.input_digest IS NOT OLD.input_digest OR NEW.policy_epoch IS NOT OLD.policy_epoch
    OR NEW.credential_binding_id IS NOT OLD.credential_binding_id
    OR NEW.credential_epoch IS NOT OLD.credential_epoch
  THEN RAISE(ABORT, 'APPROVAL_BINDING_IMMUTABLE') END;
END;
CREATE TRIGGER IF NOT EXISTS trg_approvals_append_only_delete
BEFORE DELETE ON approval_requests BEGIN
  SELECT RAISE(ABORT, 'APPROVAL_APPEND_ONLY');
END;

CREATE TRIGGER IF NOT EXISTS trg_capability_profiles_append_only_update
BEFORE UPDATE ON harness_capability_profiles BEGIN
  SELECT CASE WHEN NEW.profile_id IS NOT OLD.profile_id
    OR NEW.harness_id IS NOT OLD.harness_id
    OR NEW.adapter_version IS NOT OLD.adapter_version
    OR NEW.runtime_version IS NOT OLD.runtime_version
    OR NEW.credential_scope_id IS NOT OLD.credential_scope_id
    OR NEW.model_id IS NOT OLD.model_id
    OR NEW.capabilities_json IS NOT OLD.capabilities_json
    OR NEW.evidence_at IS NOT OLD.evidence_at
    OR OLD.invalidated_at IS NOT NULL
    OR NEW.invalidated_at IS NULL
    OR julianday(NEW.invalidated_at) IS NULL
  THEN RAISE(ABORT, 'CAPABILITY_PROFILE_APPEND_ONLY') END;
END;
CREATE TRIGGER IF NOT EXISTS trg_capability_profiles_append_only_delete
BEFORE DELETE ON harness_capability_profiles BEGIN
  SELECT RAISE(ABORT, 'CAPABILITY_PROFILE_APPEND_ONLY');
END;

CREATE TRIGGER IF NOT EXISTS trg_shadow_links_writer_insert
BEFORE INSERT ON conversation_legacy_links BEGIN
  SELECT CASE WHEN NEW.writer_epoch != (SELECT writer_epoch FROM conversations WHERE conversation_id = NEW.conversation_id)
    THEN RAISE(ABORT, 'STALE_WRITER_EPOCH') END;
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM conversation_writer_state w WHERE w.conversation_id = NEW.conversation_id
      AND w.writer_epoch = NEW.writer_epoch AND w.state = 'active'
  ) THEN RAISE(ABORT, 'NOT_ACTIVE_WRITER') END;
END;
CREATE TRIGGER IF NOT EXISTS trg_reference_keys_append_only_update
BEFORE UPDATE ON conversation_reference_keys BEGIN
  SELECT RAISE(ABORT, 'REFERENCE_KEY_REGISTRY_APPEND_ONLY');
END;
CREATE TRIGGER IF NOT EXISTS trg_reference_keys_append_only_delete
BEFORE DELETE ON conversation_reference_keys BEGIN
  SELECT RAISE(ABORT, 'REFERENCE_KEY_REGISTRY_APPEND_ONLY');
END;
CREATE TRIGGER IF NOT EXISTS trg_shadow_links_writer_update
BEFORE UPDATE ON conversation_legacy_links BEGIN
  SELECT CASE WHEN NEW.legacy_provider IS NOT OLD.legacy_provider
    OR NEW.reference_key_version IS NOT OLD.reference_key_version
    OR NEW.legacy_ref_digest IS NOT OLD.legacy_ref_digest
    OR NEW.conversation_id IS NOT OLD.conversation_id
    OR NEW.link_kind IS NOT OLD.link_kind
    OR NEW.first_principal_id IS NOT OLD.first_principal_id
  THEN RAISE(ABORT, 'SHADOW_LINK_IDENTITY_IMMUTABLE') END;
  SELECT CASE WHEN NEW.writer_epoch != (SELECT writer_epoch FROM conversations WHERE conversation_id = NEW.conversation_id)
    THEN RAISE(ABORT, 'STALE_WRITER_EPOCH') END;
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM conversation_writer_state w WHERE w.conversation_id = NEW.conversation_id
      AND w.writer_epoch = NEW.writer_epoch AND w.state = 'active'
  ) THEN RAISE(ABORT, 'NOT_ACTIVE_WRITER') END;
END;
CREATE TRIGGER IF NOT EXISTS trg_shadow_links_append_only_delete
BEFORE DELETE ON conversation_legacy_links BEGIN
  SELECT RAISE(ABORT, 'SHADOW_LINK_APPEND_ONLY');
END;

CREATE TRIGGER IF NOT EXISTS trg_shadow_ingress_writer_insert
BEFORE INSERT ON conversation_shadow_ingress BEGIN
  SELECT CASE WHEN NEW.writer_epoch != (SELECT writer_epoch FROM conversations WHERE conversation_id = NEW.conversation_id)
    THEN RAISE(ABORT, 'STALE_WRITER_EPOCH') END;
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM conversation_writer_state w WHERE w.conversation_id = NEW.conversation_id
      AND w.writer_epoch = NEW.writer_epoch AND w.state = 'active'
  ) THEN RAISE(ABORT, 'NOT_ACTIVE_WRITER') END;
END;
CREATE TRIGGER IF NOT EXISTS trg_shadow_ingress_identity_update
BEFORE UPDATE ON conversation_shadow_ingress BEGIN
  SELECT CASE WHEN NEW.principal_id IS NOT OLD.principal_id
    OR NEW.client_msg_id IS NOT OLD.client_msg_id
    OR NEW.conversation_id IS NOT OLD.conversation_id
    OR NEW.request_digest IS NOT OLD.request_digest
  THEN RAISE(ABORT, 'SHADOW_INGRESS_IDENTITY_IMMUTABLE') END;
  SELECT CASE WHEN NEW.writer_epoch != (SELECT writer_epoch FROM conversations WHERE conversation_id = NEW.conversation_id)
    THEN RAISE(ABORT, 'STALE_WRITER_EPOCH') END;
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM conversation_writer_state w WHERE w.conversation_id = NEW.conversation_id
      AND w.writer_epoch = NEW.writer_epoch AND w.state = 'active'
  ) THEN RAISE(ABORT, 'NOT_ACTIVE_WRITER') END;
END;
CREATE TRIGGER IF NOT EXISTS trg_shadow_ingress_append_only_delete
BEFORE DELETE ON conversation_shadow_ingress BEGIN
  SELECT RAISE(ABORT, 'SHADOW_INGRESS_APPEND_ONLY');
END;
CREATE TRIGGER IF NOT EXISTS trg_shadow_authorizations_writer_insert
BEFORE INSERT ON conversation_shadow_authorizations BEGIN
  SELECT CASE WHEN NEW.writer_epoch != (SELECT writer_epoch FROM conversations WHERE conversation_id = NEW.conversation_id)
    THEN RAISE(ABORT, 'STALE_WRITER_EPOCH') END;
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM conversation_writer_state w WHERE w.conversation_id = NEW.conversation_id
      AND w.writer_epoch = NEW.writer_epoch AND w.state = 'active'
  ) THEN RAISE(ABORT, 'NOT_ACTIVE_WRITER') END;
END;
CREATE TRIGGER IF NOT EXISTS trg_shadow_authorizations_append_only_update
BEFORE UPDATE ON conversation_shadow_authorizations BEGIN
  SELECT RAISE(ABORT, 'SHADOW_AUTHORIZATION_APPEND_ONLY');
END;
CREATE TRIGGER IF NOT EXISTS trg_shadow_authorizations_append_only_delete
BEFORE DELETE ON conversation_shadow_authorizations BEGIN
  SELECT RAISE(ABORT, 'SHADOW_AUTHORIZATION_APPEND_ONLY');
END;

CREATE TRIGGER IF NOT EXISTS trg_shadow_parity_writer_insert
BEFORE INSERT ON conversation_shadow_parity BEGIN
  SELECT CASE WHEN NEW.writer_epoch != (SELECT writer_epoch FROM conversations WHERE conversation_id = NEW.conversation_id)
    THEN RAISE(ABORT, 'STALE_WRITER_EPOCH') END;
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM conversation_writer_state w WHERE w.conversation_id = NEW.conversation_id
      AND w.writer_epoch = NEW.writer_epoch AND w.state = 'active'
  ) THEN RAISE(ABORT, 'NOT_ACTIVE_WRITER') END;
END;
CREATE TRIGGER IF NOT EXISTS trg_shadow_parity_writer_update
BEFORE UPDATE ON conversation_shadow_parity BEGIN
  SELECT CASE WHEN NEW.run_id IS NOT OLD.run_id
    OR NEW.conversation_id IS NOT OLD.conversation_id
    OR NEW.principal_id IS NOT OLD.principal_id
    OR NEW.client_msg_id IS NOT OLD.client_msg_id
    OR NEW.request_digest IS NOT OLD.request_digest
    OR NEW.requested_provider IS NOT OLD.requested_provider
    OR NEW.reference_key_version IS NOT OLD.reference_key_version
    OR NEW.expected_legacy_ref_digest IS NOT OLD.expected_legacy_ref_digest
    OR NEW.shadow_accept_outcome IS NOT OLD.shadow_accept_outcome
  THEN RAISE(ABORT, 'SHADOW_PARITY_IDENTITY_IMMUTABLE') END;
  SELECT CASE WHEN NEW.writer_epoch != (SELECT writer_epoch FROM conversations WHERE conversation_id = NEW.conversation_id)
    THEN RAISE(ABORT, 'STALE_WRITER_EPOCH') END;
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM conversation_writer_state w WHERE w.conversation_id = NEW.conversation_id
      AND w.writer_epoch = NEW.writer_epoch AND w.state = 'active'
  ) THEN RAISE(ABORT, 'NOT_ACTIVE_WRITER') END;
END;
CREATE TRIGGER IF NOT EXISTS trg_shadow_parity_append_only_delete
BEFORE DELETE ON conversation_shadow_parity BEGIN
  SELECT RAISE(ABORT, 'SHADOW_PARITY_APPEND_ONLY');
END;

CREATE TRIGGER IF NOT EXISTS trg_shadow_observations_writer_insert
BEFORE INSERT ON conversation_shadow_observations BEGIN
  SELECT CASE WHEN NEW.writer_epoch != (SELECT writer_epoch FROM conversations WHERE conversation_id = NEW.conversation_id)
    THEN RAISE(ABORT, 'STALE_WRITER_EPOCH') END;
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM conversation_writer_state w WHERE w.conversation_id = NEW.conversation_id
      AND w.writer_epoch = NEW.writer_epoch AND w.state = 'active'
  ) THEN RAISE(ABORT, 'NOT_ACTIVE_WRITER') END;
END;
CREATE TRIGGER IF NOT EXISTS trg_shadow_observations_append_only_update
BEFORE UPDATE ON conversation_shadow_observations BEGIN
  SELECT RAISE(ABORT, 'SHADOW_OBSERVATION_APPEND_ONLY');
END;
CREATE TRIGGER IF NOT EXISTS trg_shadow_observations_append_only_delete
BEFORE DELETE ON conversation_shadow_observations BEGIN
  SELECT RAISE(ABORT, 'SHADOW_OBSERVATION_APPEND_ONLY');
END;

CREATE TRIGGER IF NOT EXISTS trg_shadow_content_summaries_writer_insert
BEFORE INSERT ON conversation_shadow_content_summaries BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM conversation_reference_keys k
     WHERE k.reference_key_version = NEW.reference_key_version
  ) THEN RAISE(ABORT, 'SHADOW_CONTENT_REFERENCE_KEY_VERSION_MISSING') END;
  SELECT CASE WHEN NEW.writer_epoch != (SELECT writer_epoch FROM conversations WHERE conversation_id = NEW.conversation_id)
    THEN RAISE(ABORT, 'STALE_WRITER_EPOCH') END;
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM conversation_writer_state w WHERE w.conversation_id = NEW.conversation_id
      AND w.writer_epoch = NEW.writer_epoch AND w.state = 'active'
  ) THEN RAISE(ABORT, 'NOT_ACTIVE_WRITER') END;
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM conversation_shadow_parity p
     WHERE p.run_id = NEW.run_id AND p.conversation_id = NEW.conversation_id
       AND p.reference_key_version = NEW.reference_key_version
       AND p.legacy_dispatch_count >= NEW.dispatch_generation
  ) THEN RAISE(ABORT, 'SHADOW_CONTENT_SUMMARY_SCOPE_MISMATCH') END;
END;
CREATE TRIGGER IF NOT EXISTS trg_shadow_content_summaries_append_only_update
BEFORE UPDATE ON conversation_shadow_content_summaries BEGIN
  SELECT RAISE(ABORT, 'SHADOW_CONTENT_SUMMARY_APPEND_ONLY');
END;
CREATE TRIGGER IF NOT EXISTS trg_shadow_content_summaries_append_only_delete
BEFORE DELETE ON conversation_shadow_content_summaries BEGIN
  SELECT RAISE(ABORT, 'SHADOW_CONTENT_SUMMARY_APPEND_ONLY');
END;

CREATE TRIGGER IF NOT EXISTS trg_shadow_recovery_writer_insert
BEFORE INSERT ON conversation_shadow_recovery BEGIN
  SELECT CASE WHEN NEW.writer_epoch != (SELECT writer_epoch FROM conversations WHERE conversation_id = NEW.conversation_id)
    THEN RAISE(ABORT, 'STALE_WRITER_EPOCH') END;
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM conversation_writer_state w WHERE w.conversation_id = NEW.conversation_id
      AND w.writer_epoch = NEW.writer_epoch AND w.state IN ('recovering', 'active')
  ) THEN RAISE(ABORT, 'NOT_FENCED_RECOVERY_WRITER') END;
END;
CREATE TRIGGER IF NOT EXISTS trg_shadow_recovery_append_only_update
BEFORE UPDATE ON conversation_shadow_recovery BEGIN
  SELECT RAISE(ABORT, 'SHADOW_RECOVERY_APPEND_ONLY');
END;
CREATE TRIGGER IF NOT EXISTS trg_shadow_recovery_append_only_delete
BEFORE DELETE ON conversation_shadow_recovery BEGIN
  SELECT RAISE(ABORT, 'SHADOW_RECOVERY_APPEND_ONLY');
END;

CREATE TRIGGER IF NOT EXISTS trg_shadow_divergences_writer_insert
BEFORE INSERT ON conversation_shadow_divergences
WHEN NEW.conversation_id IS NOT NULL BEGIN
  SELECT CASE WHEN NEW.writer_epoch IS NULL OR NEW.writer_epoch != (
    SELECT writer_epoch FROM conversations WHERE conversation_id = NEW.conversation_id
  ) THEN RAISE(ABORT, 'STALE_WRITER_EPOCH') END;
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM conversation_writer_state w WHERE w.conversation_id = NEW.conversation_id
      AND w.writer_epoch = NEW.writer_epoch AND w.state = 'active'
  ) THEN RAISE(ABORT, 'NOT_ACTIVE_WRITER') END;
END;
CREATE TRIGGER IF NOT EXISTS trg_shadow_divergences_append_only_update
BEFORE UPDATE ON conversation_shadow_divergences BEGIN
  SELECT RAISE(ABORT, 'SHADOW_DIVERGENCE_APPEND_ONLY');
END;
CREATE TRIGGER IF NOT EXISTS trg_shadow_divergences_append_only_delete
BEFORE DELETE ON conversation_shadow_divergences BEGIN
  SELECT RAISE(ABORT, 'SHADOW_DIVERGENCE_APPEND_ONLY');
END;
`;

export interface ConversationDatabaseInitialization {
  journalMode: 'wal' | 'memory';
  durableWal: boolean;
}

export const UNIVERSAL_CONVERSATION_SCHEMA_VERSION = 1;
export const UNIVERSAL_CONVERSATION_SCHEMA_CHECKSUM = createHash('sha256')
  .update(UNIVERSAL_CONVERSATION_SCHEMA_SQL)
  .digest('hex');

const SCHEMA_MANIFEST_SQL = `
CREATE TABLE IF NOT EXISTS conversation_schema_metadata (
  component TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL,
  schema_checksum TEXT NOT NULL,
  applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TRIGGER IF NOT EXISTS trg_conversation_schema_metadata_immutable_update
BEFORE UPDATE ON conversation_schema_metadata
WHEN OLD.component = 'universal-conversations' BEGIN
  SELECT RAISE(ABORT, 'UNIVERSAL_CONVERSATION_SCHEMA_MANIFEST_IMMUTABLE');
END;
CREATE TRIGGER IF NOT EXISTS trg_conversation_schema_metadata_immutable_delete
BEFORE DELETE ON conversation_schema_metadata
WHEN OLD.component = 'universal-conversations' BEGIN
  SELECT RAISE(ABORT, 'UNIVERSAL_CONVERSATION_SCHEMA_MANIFEST_IMMUTABLE');
END;`;

function verifyConversationSchemaShape(db: Database.Database): void {
  const required: Readonly<Record<string, readonly string[]>> = {
    conversations: ['conversation_id', 'writer_epoch'],
    conversation_runs: ['run_id', 'conversation_id', 'client_msg_id'],
    conversation_reference_keys: ['reference_key_version', 'key_fingerprint'],
    conversation_legacy_links: [
      'legacy_provider',
      'reference_key_version',
      'legacy_ref_digest',
      'conversation_id',
    ],
    conversation_shadow_ingress: ['principal_id', 'client_msg_id', 'conversation_id'],
    conversation_shadow_authorizations: [
      'authorization_id',
      'conversation_id',
      'principal_id',
      'provenance_digest',
    ],
    conversation_shadow_parity: [
      'run_id',
      'expected_legacy_ref_digest',
      'observed_legacy_ref_digest',
      'legacy_terminal_outcome',
      'content_integrity_state',
      'content_comparison_state',
      'legacy_dispatch_count',
      'duplicate_count',
      'reference_key_version',
    ],
    conversation_shadow_observations: [
      'run_id',
      'reference_key_version',
      'legacy_ref_digest',
      'verification_state',
      'envelope_digest',
      'dispatch_generation',
    ],
    conversation_shadow_content_summaries: [
      'run_id',
      'dispatch_generation',
      'integrity_state',
      'content_digest',
      'summary_digest',
      'source_chunk_count',
      'canonical_bytes',
    ],
    conversation_shadow_recovery: ['record_type', 'record_id', 'writer_epoch'],
  };
  for (const [table, columns] of Object.entries(required)) {
    const actual = new Set(
      (db.pragma(`table_info(${table})`) as Array<{ name: string }>).map((column) => column.name),
    );
    if (columns.some((column) => !actual.has(column))) {
      throw new Error(`UNIVERSAL_CONVERSATION_SCHEMA_INCOMPATIBLE:${table}`);
    }
  }
}

/** Applies the Foundation schema and verifies the actual journal mode. */
export function initializeConversationFoundationSchema(
  db: Database.Database,
): ConversationDatabaseInitialization {
  db.pragma('foreign_keys = ON');
  const rawMode = String(db.pragma('journal_mode = WAL', { simple: true })).toLowerCase();
  const isMemory = db.name === ':memory:' || db.name.includes(':memory:');
  if (!isMemory && rawMode !== 'wal') throw new Error(`WAL_REQUIRED:${rawMode}`);
  if (isMemory && rawMode !== 'memory') throw new Error(`UNEXPECTED_MEMORY_JOURNAL_MODE:${rawMode}`);
  db.pragma('synchronous = FULL');
  db.transaction(() => {
    const manifestExists = Boolean(db
      .prepare(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'conversation_schema_metadata'",
      )
      .get());
    const foundationExists = Boolean(db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'conversations'")
      .get());
    if (!manifestExists && foundationExists) {
      throw new Error('UNIVERSAL_CONVERSATION_SCHEMA_MANIFEST_MISSING');
    }
    db.exec(SCHEMA_MANIFEST_SQL);
    const manifest = db
      .prepare(
        `SELECT schema_version, schema_checksum FROM conversation_schema_metadata
          WHERE component = 'universal-conversations'`,
      )
      .get() as { schema_version: number; schema_checksum: string } | undefined;
    if (foundationExists && !manifest) {
      throw new Error('UNIVERSAL_CONVERSATION_SCHEMA_MANIFEST_MISSING');
    }
    if (
      manifest
      && (
        manifest.schema_version !== UNIVERSAL_CONVERSATION_SCHEMA_VERSION
        || manifest.schema_checksum !== UNIVERSAL_CONVERSATION_SCHEMA_CHECKSUM
      )
    ) {
      throw new Error('UNIVERSAL_CONVERSATION_SCHEMA_VERSION_MISMATCH');
    }
    db.exec(UNIVERSAL_CONVERSATION_SCHEMA_SQL);
    verifyConversationSchemaShape(db);
    db.prepare(
      `INSERT INTO conversation_schema_metadata (component, schema_version, schema_checksum)
       VALUES ('universal-conversations', ?, ?)
       ON CONFLICT(component) DO NOTHING`,
    ).run(UNIVERSAL_CONVERSATION_SCHEMA_VERSION, UNIVERSAL_CONVERSATION_SCHEMA_CHECKSUM);
  })();
  return {
    journalMode: isMemory ? 'memory' : 'wal',
    durableWal: !isMemory,
  };
}

/** Turns a separate standby/read-model connection into a verified read-only connection. */
export function configureConversationReadOnlyConnection(db: Database.Database): void {
  db.pragma('query_only = ON');
  const result = db.pragma('query_only', { simple: true });
  if (result !== 1) throw new Error('QUERY_ONLY_CONFIGURATION_FAILED');
}
