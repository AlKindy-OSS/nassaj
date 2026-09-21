import type { Database } from 'better-sqlite3';

const UUID_CHECK = (column: string): string => `
  length(${column}) = 36
  AND substr(${column}, 9, 1) = '-'
  AND substr(${column}, 14, 1) = '-'
  AND substr(${column}, 19, 1) = '-'
  AND substr(${column}, 24, 1) = '-'
  AND lower(${column}) = ${column}
  AND ${column} NOT GLOB '*[^0-9a-f-]*'
  AND length(replace(${column}, '-', '')) = 32
  AND substr(${column}, 15, 1) GLOB '[1-8]'
  AND substr(${column}, 20, 1) GLOB '[89ab]'`;

/** Additive ADR-132 schema. It deliberately leaves every legacy connector table untouched. */
export const CONNECTOR_AUTH_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS connector_installations (
  installation_id TEXT PRIMARY KEY CHECK (${UUID_CHECK('installation_id')}),
  singleton INTEGER NOT NULL DEFAULT 1 UNIQUE CHECK (singleton = 1),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS connector_auth_profiles (
  profile_id TEXT PRIMARY KEY CHECK (${UUID_CHECK('profile_id')}),
  installation_id TEXT NOT NULL,
  provider_id TEXT NOT NULL CHECK (length(provider_id) BETWEEN 1 AND 128 AND provider_id NOT GLOB '*[^a-z0-9._-]*'),
  canonical_origin TEXT NOT NULL CHECK (
    canonical_origin LIKE 'https://%'
    AND canonical_origin = lower(canonical_origin)
    AND length(canonical_origin) BETWEEN 10 AND 512
    AND instr(substr(canonical_origin, 9), '/') = 0
    AND instr(canonical_origin, '?') = 0
    AND instr(canonical_origin, '#') = 0
    AND instr(canonical_origin, '@') = 0
    AND instr(canonical_origin, ' ') = 0
    AND instr(canonical_origin, char(9)) = 0
    AND instr(canonical_origin, char(10)) = 0
    AND instr(canonical_origin, char(13)) = 0
    AND instr(canonical_origin, '\\') = 0
  ),
  status TEXT NOT NULL CHECK (status IN ('pending', 'ready', 'disabled', 'error')),
  catalog_revision TEXT NOT NULL CHECK (length(catalog_revision) BETWEEN 1 AND 128),
  secret_ref TEXT,
  secret_revision INTEGER,
  secret_subject_type TEXT NOT NULL DEFAULT 'profile' CHECK (secret_subject_type = 'profile'),
  secret_subject_id TEXT NOT NULL CHECK (secret_subject_id = profile_id),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (installation_id, provider_id, canonical_origin),
  UNIQUE (profile_id, installation_id, provider_id),
  CHECK ((secret_ref IS NULL AND secret_revision IS NULL)
      OR (secret_ref IS NOT NULL AND secret_revision > 0)),
  FOREIGN KEY (installation_id) REFERENCES connector_installations(installation_id) ON DELETE CASCADE,
  FOREIGN KEY (
    secret_ref, installation_id, provider_id, secret_subject_type,
    secret_subject_id, profile_id, secret_revision
  ) REFERENCES connector_vault_secrets(
    secret_ref, installation_id, provider_id, subject_type,
    subject_id, profile_id, secret_revision
  ) DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE IF NOT EXISTS connector_user_grants (
  grant_id TEXT PRIMARY KEY CHECK (${UUID_CHECK('grant_id')}),
  profile_id TEXT NOT NULL,
  installation_id TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  service_id TEXT NOT NULL DEFAULT '' CHECK (length(service_id) <= 128 AND service_id NOT GLOB '*[^a-z0-9._-]*'),
  user_id INTEGER NOT NULL CHECK (user_id > 0),
  provider_subject_hmac TEXT NOT NULL CHECK (
    length(provider_subject_hmac) = 64
    AND lower(provider_subject_hmac) = provider_subject_hmac
    AND provider_subject_hmac NOT GLOB '*[^0-9a-f]*'
  ),
  provider_subject_ciphertext BLOB NOT NULL CHECK (length(provider_subject_ciphertext) > 0),
  provider_subject_nonce BLOB NOT NULL CHECK (length(provider_subject_nonce) = 12),
  provider_subject_tag BLOB NOT NULL CHECK (length(provider_subject_tag) = 16),
  provider_subject_kek_version INTEGER NOT NULL DEFAULT 1 CHECK (provider_subject_kek_version > 0),
  hmac_key_version INTEGER NOT NULL CHECK (hmac_key_version > 0),
  account_label TEXT NOT NULL DEFAULT '' CHECK (length(account_label) <= 128 AND instr(account_label, char(0)) = 0),
  account_label_key TEXT NOT NULL DEFAULT '' CHECK (length(account_label_key) <= 128 AND instr(account_label_key, char(0)) = 0),
  is_default INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0, 1)),
  legacy_provenance TEXT CHECK (legacy_provenance IS NULL OR length(legacy_provenance) <= 256),
  secret_ref TEXT,
  secret_revision INTEGER,
  secret_subject_type TEXT NOT NULL DEFAULT 'grant' CHECK (secret_subject_type = 'grant'),
  secret_subject_id TEXT NOT NULL CHECK (secret_subject_id = grant_id),
  status TEXT NOT NULL CHECK (status IN ('pending', 'active', 'revoked', 'error')),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (profile_id, user_id, provider_subject_hmac),
  UNIQUE (grant_id, installation_id, provider_id, profile_id, user_id),
  CHECK ((secret_ref IS NULL AND secret_revision IS NULL)
      OR (secret_ref IS NOT NULL AND secret_revision > 0)),
  FOREIGN KEY (profile_id, installation_id, provider_id)
    REFERENCES connector_auth_profiles(profile_id, installation_id, provider_id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (
    secret_ref, installation_id, provider_id, secret_subject_type,
    secret_subject_id, profile_id, user_id, secret_revision
  ) REFERENCES connector_vault_secrets(
    secret_ref, installation_id, provider_id, subject_type,
    subject_id, profile_id, user_id, secret_revision
  ) DEFERRABLE INITIALLY DEFERRED
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_connector_user_grant_identity
  ON connector_user_grants(grant_id, installation_id, user_id);

CREATE TABLE IF NOT EXISTS connector_oauth_transactions (
  transaction_id TEXT PRIMARY KEY CHECK (${UUID_CHECK('transaction_id')}),
  profile_id TEXT NOT NULL,
  installation_id TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  user_id INTEGER NOT NULL CHECK (user_id > 0),
  state_hash TEXT NOT NULL UNIQUE CHECK (
    length(state_hash) = 64
    AND lower(state_hash) = state_hash
    AND state_hash NOT GLOB '*[^0-9a-f]*'
  ),
  secret_ref TEXT,
  secret_revision INTEGER,
  secret_subject_type TEXT NOT NULL DEFAULT 'oauth_transaction' CHECK (secret_subject_type = 'oauth_transaction'),
  secret_subject_id TEXT NOT NULL CHECK (secret_subject_id = transaction_id),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (transaction_id, installation_id, provider_id, profile_id, user_id),
  CHECK ((secret_ref IS NULL AND secret_revision IS NULL)
      OR (secret_ref IS NOT NULL AND secret_revision > 0)),
  FOREIGN KEY (profile_id, installation_id, provider_id)
    REFERENCES connector_auth_profiles(profile_id, installation_id, provider_id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (
    secret_ref, installation_id, provider_id, secret_subject_type,
    secret_subject_id, profile_id, user_id, secret_revision
  ) REFERENCES connector_vault_secrets(
    secret_ref, installation_id, provider_id, subject_type,
    subject_id, profile_id, user_id, secret_revision
  ) DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE IF NOT EXISTS connector_oauth_grant_services (
  grant_id TEXT NOT NULL,
  installation_id TEXT NOT NULL,
  user_id INTEGER NOT NULL CHECK (user_id > 0),
  service_id TEXT NOT NULL CHECK (length(service_id) BETWEEN 1 AND 128 AND service_id NOT GLOB '*[^a-z0-9._-]*'),
  scopes_json TEXT NOT NULL CHECK (json_valid(scopes_json) AND json_type(scopes_json) = 'array'),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (grant_id, service_id),
  FOREIGN KEY (grant_id) REFERENCES connector_user_grants(grant_id) ON DELETE CASCADE,
  FOREIGN KEY (grant_id, installation_id, user_id)
    REFERENCES connector_user_grants(grant_id, installation_id, user_id) ON DELETE CASCADE,
  FOREIGN KEY (installation_id) REFERENCES connector_installations(installation_id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS connector_oauth_connector_bindings (
  connector_id TEXT PRIMARY KEY CHECK (length(connector_id) BETWEEN 1 AND 128),
  installation_id TEXT NOT NULL,
  user_id INTEGER NOT NULL CHECK (user_id > 0),
  service_id TEXT NOT NULL,
  grant_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (connector_id, installation_id, user_id, service_id, grant_id),
  FOREIGN KEY (grant_id, installation_id, user_id)
    REFERENCES connector_user_grants(grant_id, installation_id, user_id) ON DELETE CASCADE,
  FOREIGN KEY (grant_id, service_id)
    REFERENCES connector_oauth_grant_services(grant_id, service_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS connector_api_key_connector_bindings (
  connector_id TEXT PRIMARY KEY CHECK (length(connector_id) BETWEEN 1 AND 128),
  installation_id TEXT NOT NULL,
  user_id INTEGER NOT NULL CHECK (user_id > 0),
  service_id TEXT NOT NULL,
  grant_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (connector_id, installation_id, user_id, service_id, grant_id),
  FOREIGN KEY (grant_id, installation_id, user_id)
    REFERENCES connector_user_grants(grant_id, installation_id, user_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS connector_vault_secrets (
  secret_ref TEXT PRIMARY KEY CHECK (${UUID_CHECK('secret_ref')}),
  installation_id TEXT NOT NULL,
  provider_id TEXT NOT NULL CHECK (length(provider_id) BETWEEN 1 AND 128 AND provider_id NOT GLOB '*[^a-z0-9._-]*'),
  subject_type TEXT NOT NULL CHECK (subject_type IN ('installation', 'profile', 'grant', 'oauth_transaction')),
  subject_id TEXT NOT NULL CHECK (${UUID_CHECK('subject_id')}),
  profile_id TEXT,
  user_id INTEGER,
  field_purpose TEXT NOT NULL CHECK (length(field_purpose) BETWEEN 1 AND 128 AND field_purpose NOT GLOB '*[^a-z0-9._:-]*'),
  secret_kind TEXT NOT NULL CHECK (length(secret_kind) BETWEEN 1 AND 128 AND secret_kind NOT GLOB '*[^a-z0-9._:-]*'),
  ciphertext BLOB NOT NULL CHECK (length(ciphertext) > 0),
  nonce BLOB NOT NULL CHECK (length(nonce) = 12),
  auth_tag BLOB NOT NULL CHECK (length(auth_tag) = 16),
  wrapped_dek BLOB NOT NULL CHECK (length(wrapped_dek) = 32),
  wrapped_dek_nonce BLOB NOT NULL CHECK (length(wrapped_dek_nonce) = 12),
  wrapped_dek_tag BLOB NOT NULL CHECK (length(wrapped_dek_tag) = 16),
  kek_version INTEGER NOT NULL CHECK (kek_version > 0),
  aad_version INTEGER NOT NULL CHECK (aad_version > 0),
  secret_revision INTEGER NOT NULL CHECK (secret_revision > 0),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (secret_ref, installation_id, provider_id, subject_type, subject_id, profile_id, secret_revision),
  UNIQUE (secret_ref, installation_id, provider_id, subject_type, subject_id, profile_id, field_purpose, secret_revision),
  UNIQUE (secret_ref, installation_id, provider_id, subject_type, subject_id, profile_id, user_id, secret_revision),
  CHECK (
    (subject_type = 'installation' AND subject_id = installation_id AND profile_id IS NULL AND user_id IS NULL)
    OR (subject_type = 'profile' AND subject_id = profile_id AND profile_id IS NOT NULL AND user_id IS NULL)
    OR (subject_type IN ('grant', 'oauth_transaction') AND profile_id IS NOT NULL AND user_id > 0)
  ),
  FOREIGN KEY (installation_id) REFERENCES connector_installations(installation_id) ON DELETE CASCADE,
  FOREIGN KEY (profile_id, installation_id, provider_id)
    REFERENCES connector_auth_profiles(profile_id, installation_id, provider_id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS connector_auth_leases (
  lease_key TEXT PRIMARY KEY CHECK (length(lease_key) BETWEEN 1 AND 128 AND lease_key NOT GLOB '*[^a-zA-Z0-9._:-]*'),
  owner_token TEXT NOT NULL CHECK (${UUID_CHECK('owner_token')}),
  fencing_token INTEGER NOT NULL DEFAULT 1 CHECK (fencing_token > 0),
  expires_at TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS connector_auth_profile_secret_bindings (
  profile_id TEXT NOT NULL,
  installation_id TEXT NOT NULL,
  provider_id TEXT NOT NULL CHECK (length(provider_id) BETWEEN 1 AND 128 AND provider_id NOT GLOB '*[^a-z0-9._-]*'),
  field_purpose TEXT NOT NULL CHECK (length(field_purpose) BETWEEN 1 AND 128 AND field_purpose NOT GLOB '*[^a-z0-9._:-]*'),
  secret_ref TEXT NOT NULL,
  secret_revision INTEGER NOT NULL CHECK (secret_revision > 0),
  status TEXT NOT NULL CHECK (status IN ('candidate', 'active', 'inactive')),
  secret_subject_type TEXT NOT NULL DEFAULT 'profile' CHECK (secret_subject_type = 'profile'),
  secret_subject_id TEXT NOT NULL CHECK (secret_subject_id = profile_id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (profile_id, field_purpose, secret_ref),
  UNIQUE (secret_ref),
  FOREIGN KEY (profile_id, installation_id, provider_id)
    REFERENCES connector_auth_profiles(profile_id, installation_id, provider_id) ON DELETE CASCADE,
  FOREIGN KEY (
    secret_ref, installation_id, provider_id, secret_subject_type,
    secret_subject_id, profile_id, field_purpose, secret_revision
  ) REFERENCES connector_vault_secrets(
    secret_ref, installation_id, provider_id, subject_type,
    subject_id, profile_id, field_purpose, secret_revision
  ) DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE IF NOT EXISTS connector_owner_auth_sessions (
  session_id TEXT PRIMARY KEY CHECK (${UUID_CHECK('session_id')}),
  installation_id TEXT NOT NULL,
  session_token_hash TEXT NOT NULL UNIQUE CHECK (
    length(session_token_hash) = 64 AND lower(session_token_hash) = session_token_hash
    AND session_token_hash NOT GLOB '*[^0-9a-f]*'
  ),
  csrf_token_hash TEXT NOT NULL CHECK (
    length(csrf_token_hash) = 64 AND lower(csrf_token_hash) = csrf_token_hash
    AND csrf_token_hash NOT GLOB '*[^0-9a-f]*'
  ),
  user_id INTEGER NOT NULL CHECK (user_id > 0),
  auth_method TEXT NOT NULL CHECK (auth_method IN ('password', 'webauthn')),
  auth_time_ms INTEGER NOT NULL CHECK (auth_time_ms > 0),
  expires_at_ms INTEGER NOT NULL CHECK (expires_at_ms > auth_time_ms),
  revoked_at_ms INTEGER,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (installation_id) REFERENCES connector_installations(installation_id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS connector_owner_operation_nonces (
  nonce_hash TEXT PRIMARY KEY CHECK (
    length(nonce_hash) = 64 AND lower(nonce_hash) = nonce_hash
    AND nonce_hash NOT GLOB '*[^0-9a-f]*'
  ),
  request_id TEXT NOT NULL CHECK (${UUID_CHECK('request_id')}),
  session_id TEXT NOT NULL,
  installation_id TEXT NOT NULL,
  user_id INTEGER NOT NULL CHECK (user_id > 0),
  operation TEXT NOT NULL CHECK (operation IN (
    'upsert_byo', 'register_dcr', 'upsert_shared_api_key', 'disable',
    'upsert_personal_api_key', 'revoke_personal_grant',
    'oauth_start', 'oauth_refresh', 'oauth_revoke'
  )),
  expires_at_ms INTEGER NOT NULL CHECK (expires_at_ms > 0),
  consumed_at_ms INTEGER,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (session_id) REFERENCES connector_owner_auth_sessions(session_id) ON DELETE CASCADE,
  FOREIGN KEY (installation_id) REFERENCES connector_installations(installation_id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- ADR-132 keeps bundle, verification, and operational truth independent.
CREATE TABLE IF NOT EXISTS connector_credential_bundle_revisions (
  bundle_id TEXT NOT NULL CHECK (${UUID_CHECK('bundle_id')}),
  bundle_revision INTEGER NOT NULL CHECK (bundle_revision > 0),
  installation_id TEXT NOT NULL,
  user_id INTEGER NOT NULL CHECK (user_id > 0),
  provider_id TEXT NOT NULL CHECK (length(provider_id) BETWEEN 1 AND 128 AND provider_id NOT GLOB '*[^a-z0-9._-]*'),
  service_id TEXT NOT NULL CHECK (length(service_id) BETWEEN 1 AND 128 AND service_id NOT GLOB '*[^a-z0-9._-]*'),
  grant_id TEXT NOT NULL,
  profile_id TEXT NOT NULL,
  profile_version INTEGER NOT NULL CHECK (profile_version > 0),
  catalog_revision TEXT NOT NULL CHECK (length(catalog_revision) BETWEEN 1 AND 128),
  provider_subject_hmac TEXT NOT NULL CHECK (
    length(provider_subject_hmac) = 64 AND lower(provider_subject_hmac) = provider_subject_hmac
    AND provider_subject_hmac NOT GLOB '*[^0-9a-f]*'
  ),
  credential_shape TEXT NOT NULL CHECK (credential_shape IN ('single_api_key', 'geidea_basic')),
  shape_revision INTEGER NOT NULL CHECK (shape_revision > 0),
  secret_revision INTEGER NOT NULL CHECK (secret_revision > 0),
  bundle_state TEXT NOT NULL CHECK (bundle_state IN ('candidate', 'stored', 'superseded', 'deleted')),
  expected_field_count INTEGER NOT NULL CHECK (expected_field_count IN (1, 2)),
  expires_at TEXT NOT NULL CHECK (julianday(expires_at) IS NOT NULL),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (bundle_id, bundle_revision),
  UNIQUE (bundle_id, bundle_revision, installation_id, user_id, provider_id, service_id, grant_id,
          profile_id, profile_version, catalog_revision, provider_subject_hmac, secret_revision),
  CHECK ((credential_shape = 'single_api_key' AND expected_field_count = 1)
      OR (credential_shape = 'geidea_basic' AND expected_field_count = 2)),
  FOREIGN KEY (grant_id, installation_id, provider_id, profile_id, user_id)
    REFERENCES connector_user_grants(grant_id, installation_id, provider_id, profile_id, user_id)
    DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (installation_id) REFERENCES connector_installations(installation_id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS connector_credential_bundle_fields (
  bundle_id TEXT NOT NULL,
  bundle_revision INTEGER NOT NULL CHECK (bundle_revision > 0),
  installation_id TEXT NOT NULL,
  user_id INTEGER NOT NULL CHECK (user_id > 0),
  provider_id TEXT NOT NULL,
  service_id TEXT NOT NULL,
  grant_id TEXT NOT NULL,
  profile_id TEXT NOT NULL,
  profile_version INTEGER NOT NULL CHECK (profile_version > 0),
  catalog_revision TEXT NOT NULL,
  provider_subject_hmac TEXT NOT NULL,
  subject_type TEXT NOT NULL DEFAULT 'grant' CHECK (subject_type = 'grant'),
  secret_revision INTEGER NOT NULL CHECK (secret_revision > 0),
  field_id TEXT NOT NULL CHECK (field_id IN ('api_key', 'merchant_public_key', 'api_password')),
  sensitivity TEXT NOT NULL CHECK (sensitivity IN ('secret', 'confidential_identifier')),
  secret_ref TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (bundle_id, bundle_revision, field_id),
  UNIQUE (secret_ref),
  FOREIGN KEY (
    bundle_id, bundle_revision, installation_id, user_id, provider_id,
    service_id, grant_id, profile_id, profile_version, catalog_revision,
    provider_subject_hmac, secret_revision
  ) REFERENCES connector_credential_bundle_revisions(
    bundle_id, bundle_revision, installation_id, user_id, provider_id,
    service_id, grant_id, profile_id, profile_version, catalog_revision,
    provider_subject_hmac, secret_revision
  ) ON DELETE CASCADE,
  FOREIGN KEY (secret_ref, installation_id, provider_id, subject_type, grant_id, profile_id, user_id, secret_revision)
    REFERENCES connector_vault_secrets(
      secret_ref, installation_id, provider_id, subject_type, subject_id, profile_id, user_id, secret_revision
    ) DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE IF NOT EXISTS connector_credential_verifications (
  bundle_id TEXT NOT NULL,
  bundle_revision INTEGER NOT NULL CHECK (bundle_revision > 0),
  installation_id TEXT NOT NULL,
  user_id INTEGER NOT NULL CHECK (user_id > 0),
  provider_id TEXT NOT NULL,
  service_id TEXT NOT NULL,
  grant_id TEXT NOT NULL,
  profile_id TEXT NOT NULL,
  profile_version INTEGER NOT NULL CHECK (profile_version > 0),
  catalog_revision TEXT NOT NULL,
  provider_subject_hmac TEXT NOT NULL,
  secret_revision INTEGER NOT NULL CHECK (secret_revision > 0),
  shape_revision INTEGER NOT NULL CHECK (shape_revision > 0),
  contract_revision INTEGER NOT NULL CHECK (contract_revision > 0),
  verification_state TEXT NOT NULL CHECK (verification_state IN (
    'stored_unverified', 'verified', 'stale', 'rejected', 'unavailable', 'corrupt'
  )),
  reason_code TEXT NOT NULL CHECK (
    length(reason_code) BETWEEN 1 AND 128 AND reason_code NOT GLOB '*[^a-z0-9._:-]*'
  ),
  identity_kind TEXT CHECK (identity_kind IS NULL OR identity_kind IN ('user', 'store', 'merchant', 'account')),
  identity_hmac TEXT CHECK (identity_hmac IS NULL OR (
    length(identity_hmac) = 64 AND lower(identity_hmac) = identity_hmac
    AND identity_hmac NOT GLOB '*[^0-9a-f]*'
  )),
  evidence_hmac TEXT NOT NULL CHECK (
    length(evidence_hmac) = 64 AND lower(evidence_hmac) = evidence_hmac
    AND evidence_hmac NOT GLOB '*[^0-9a-f]*'
  ),
  verified_at TEXT,
  expires_at TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (bundle_id, bundle_revision),
  FOREIGN KEY (
    bundle_id, bundle_revision, installation_id, user_id, provider_id, service_id, grant_id,
    profile_id, profile_version, catalog_revision, provider_subject_hmac, secret_revision
  ) REFERENCES connector_credential_bundle_revisions(
    bundle_id, bundle_revision, installation_id, user_id, provider_id, service_id, grant_id,
    profile_id, profile_version, catalog_revision, provider_subject_hmac, secret_revision
  ) ON DELETE CASCADE,
  CHECK ((verification_state = 'verified' AND verified_at IS NOT NULL
          AND identity_kind IS NOT NULL AND identity_hmac IS NOT NULL)
      OR verification_state != 'verified')
);

CREATE TABLE IF NOT EXISTS connector_credential_operational_states (
  bundle_id TEXT NOT NULL,
  bundle_revision INTEGER NOT NULL CHECK (bundle_revision > 0),
  installation_id TEXT NOT NULL,
  user_id INTEGER NOT NULL CHECK (user_id > 0),
  provider_id TEXT NOT NULL,
  service_id TEXT NOT NULL,
  grant_id TEXT NOT NULL,
  profile_id TEXT NOT NULL,
  profile_version INTEGER NOT NULL CHECK (profile_version > 0),
  catalog_revision TEXT NOT NULL,
  provider_subject_hmac TEXT NOT NULL,
  secret_revision INTEGER NOT NULL CHECK (secret_revision > 0),
  operational_state TEXT NOT NULL CHECK (operational_state IN (
    'ineligible', 'eligible', 'disabled', 'revoking', 'deleted'
  )),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (bundle_id, bundle_revision),
  FOREIGN KEY (
    bundle_id, bundle_revision, installation_id, user_id, provider_id, service_id, grant_id,
    profile_id, profile_version, catalog_revision, provider_subject_hmac, secret_revision
  ) REFERENCES connector_credential_bundle_revisions(
    bundle_id, bundle_revision, installation_id, user_id, provider_id, service_id, grant_id,
    profile_id, profile_version, catalog_revision, provider_subject_hmac, secret_revision
  ) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_connector_auth_profiles_installation
  ON connector_auth_profiles(installation_id, status);
CREATE INDEX IF NOT EXISTS idx_connector_user_grants_user
  ON connector_user_grants(user_id, status);
CREATE INDEX IF NOT EXISTS idx_connector_oauth_transactions_expiry
  ON connector_oauth_transactions(consumed_at, expires_at);
CREATE INDEX IF NOT EXISTS idx_connector_oauth_grant_services_user
  ON connector_oauth_grant_services(installation_id, user_id, service_id);
CREATE INDEX IF NOT EXISTS idx_connector_auth_leases_expiry
  ON connector_auth_leases(expires_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_connector_profile_secret_active
  ON connector_auth_profile_secret_bindings(profile_id, field_purpose)
  WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_connector_owner_sessions_expiry
  ON connector_owner_auth_sessions(installation_id, user_id, revoked_at_ms, expires_at_ms);
CREATE INDEX IF NOT EXISTS idx_connector_owner_operation_expiry
  ON connector_owner_operation_nonces(consumed_at_ms, expires_at_ms);
CREATE UNIQUE INDEX IF NOT EXISTS idx_connector_credential_active_bundle
  ON connector_credential_operational_states(installation_id, user_id, service_id, grant_id)
  WHERE operational_state = 'eligible';
CREATE INDEX IF NOT EXISTS idx_connector_credential_candidate_expiry
  ON connector_credential_bundle_revisions(bundle_state, expires_at);
CREATE INDEX IF NOT EXISTS idx_connector_credential_verification_expiry
  ON connector_credential_verifications(verification_state, expires_at);

CREATE TRIGGER IF NOT EXISTS connector_credential_bundle_shape_immutable
BEFORE UPDATE OF bundle_id, bundle_revision, installation_id, user_id, provider_id,
  service_id, grant_id, profile_id, profile_version, catalog_revision, provider_subject_hmac,
  credential_shape, shape_revision, secret_revision
ON connector_credential_bundle_revisions
BEGIN
  SELECT RAISE(ABORT, 'connector_credential_bundle_identity_immutable');
END;

CREATE TRIGGER IF NOT EXISTS connector_credential_field_revision_immutable
BEFORE UPDATE ON connector_credential_bundle_fields
BEGIN
  SELECT RAISE(ABORT, 'connector_credential_field_immutable');
END;

CREATE TRIGGER IF NOT EXISTS connector_credential_verification_identity_immutable
BEFORE UPDATE OF bundle_id, bundle_revision, installation_id, user_id, provider_id,
  service_id, grant_id, profile_id, profile_version, catalog_revision,
  provider_subject_hmac, secret_revision, shape_revision
ON connector_credential_verifications
BEGIN
  SELECT RAISE(ABORT, 'connector_credential_verification_identity_immutable');
END;

CREATE TRIGGER IF NOT EXISTS connector_credential_verified_evidence_immutable
BEFORE UPDATE OF identity_kind, identity_hmac, evidence_hmac, verified_at
ON connector_credential_verifications
WHEN OLD.verification_state = 'verified'
BEGIN
  SELECT RAISE(ABORT, 'connector_credential_verified_evidence_immutable');
END;

CREATE TRIGGER IF NOT EXISTS connector_credential_operational_identity_immutable
BEFORE UPDATE OF bundle_id, bundle_revision, installation_id, user_id, provider_id,
  service_id, grant_id, profile_id, profile_version, catalog_revision,
  provider_subject_hmac, secret_revision
ON connector_credential_operational_states
BEGIN
  SELECT RAISE(ABORT, 'connector_credential_operational_identity_immutable');
END;

CREATE TRIGGER IF NOT EXISTS connector_credential_eligible_requires_complete_verified
BEFORE INSERT ON connector_credential_operational_states
WHEN NEW.operational_state = 'eligible'
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM connector_credential_bundle_revisions b
    JOIN connector_credential_verifications v
      ON v.bundle_id = b.bundle_id AND v.bundle_revision = b.bundle_revision
    WHERE b.bundle_id = NEW.bundle_id AND b.bundle_revision = NEW.bundle_revision
      AND b.installation_id = NEW.installation_id AND b.user_id = NEW.user_id
      AND b.provider_id = NEW.provider_id AND b.service_id = NEW.service_id
      AND b.grant_id = NEW.grant_id AND b.bundle_state = 'stored'
      AND v.verification_state = 'verified' AND v.expires_at > CURRENT_TIMESTAMP
      AND v.installation_id = b.installation_id AND v.user_id = b.user_id
      AND v.provider_id = b.provider_id AND v.service_id = b.service_id
      AND v.grant_id = b.grant_id AND v.secret_revision = b.secret_revision
      AND v.shape_revision = b.shape_revision
      AND (SELECT count(*) FROM connector_credential_bundle_fields f
           WHERE f.bundle_id = b.bundle_id AND f.bundle_revision = b.bundle_revision
             AND f.secret_revision = b.secret_revision) = b.expected_field_count
      AND ((b.credential_shape = 'single_api_key' AND EXISTS (
             SELECT 1 FROM connector_credential_bundle_fields f
             WHERE f.bundle_id = b.bundle_id AND f.bundle_revision = b.bundle_revision
               AND f.field_id = 'api_key'
           )) OR (b.credential_shape = 'geidea_basic' AND EXISTS (
             SELECT 1 FROM connector_credential_bundle_fields f
             WHERE f.bundle_id = b.bundle_id AND f.bundle_revision = b.bundle_revision
               AND f.field_id = 'merchant_public_key'
           ) AND EXISTS (
             SELECT 1 FROM connector_credential_bundle_fields f
             WHERE f.bundle_id = b.bundle_id AND f.bundle_revision = b.bundle_revision
               AND f.field_id = 'api_password'
           )))
  ) THEN RAISE(ABORT, 'connector_credential_not_eligible') END;
END;

CREATE TRIGGER IF NOT EXISTS connector_credential_eligible_update_requires_complete_verified
BEFORE UPDATE OF operational_state ON connector_credential_operational_states
WHEN NEW.operational_state = 'eligible'
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM connector_credential_bundle_revisions b
    JOIN connector_credential_verifications v
      ON v.bundle_id = b.bundle_id AND v.bundle_revision = b.bundle_revision
    WHERE b.bundle_id = NEW.bundle_id AND b.bundle_revision = NEW.bundle_revision
      AND b.installation_id = NEW.installation_id AND b.user_id = NEW.user_id
      AND b.provider_id = NEW.provider_id AND b.service_id = NEW.service_id
      AND b.grant_id = NEW.grant_id AND b.bundle_state = 'stored'
      AND v.verification_state = 'verified' AND v.expires_at > CURRENT_TIMESTAMP
      AND v.installation_id = b.installation_id AND v.user_id = b.user_id
      AND v.provider_id = b.provider_id AND v.service_id = b.service_id
      AND v.grant_id = b.grant_id AND v.secret_revision = b.secret_revision
      AND v.shape_revision = b.shape_revision
      AND (SELECT count(*) FROM connector_credential_bundle_fields f
           WHERE f.bundle_id = b.bundle_id AND f.bundle_revision = b.bundle_revision
             AND f.secret_revision = b.secret_revision) = b.expected_field_count
      AND ((b.credential_shape = 'single_api_key' AND EXISTS (
             SELECT 1 FROM connector_credential_bundle_fields f
             WHERE f.bundle_id = b.bundle_id AND f.bundle_revision = b.bundle_revision
               AND f.field_id = 'api_key'
           )) OR (b.credential_shape = 'geidea_basic' AND EXISTS (
             SELECT 1 FROM connector_credential_bundle_fields f
             WHERE f.bundle_id = b.bundle_id AND f.bundle_revision = b.bundle_revision
               AND f.field_id = 'merchant_public_key'
           ) AND EXISTS (
             SELECT 1 FROM connector_credential_bundle_fields f
             WHERE f.bundle_id = b.bundle_id AND f.bundle_revision = b.bundle_revision
               AND f.field_id = 'api_password'
           )))
  ) THEN RAISE(ABORT, 'connector_credential_not_eligible') END;
END;

CREATE TRIGGER IF NOT EXISTS connector_vault_grant_subject_insert
BEFORE INSERT ON connector_vault_secrets
WHEN NEW.subject_type = 'grant' AND NOT EXISTS (
  SELECT 1 FROM connector_user_grants g
  WHERE g.grant_id = NEW.subject_id
    AND g.installation_id = NEW.installation_id
    AND g.provider_id = NEW.provider_id
    AND g.profile_id = NEW.profile_id
    AND g.user_id = NEW.user_id
)
BEGIN
  SELECT RAISE(ABORT, 'connector_auth_vault_subject_mismatch');
END;

CREATE TRIGGER IF NOT EXISTS connector_vault_oauth_subject_insert
BEFORE INSERT ON connector_vault_secrets
WHEN NEW.subject_type = 'oauth_transaction' AND NOT EXISTS (
  SELECT 1 FROM connector_oauth_transactions t
  WHERE t.transaction_id = NEW.subject_id
    AND t.installation_id = NEW.installation_id
    AND t.provider_id = NEW.provider_id
    AND t.profile_id = NEW.profile_id
    AND t.user_id = NEW.user_id
)
BEGIN
  SELECT RAISE(ABORT, 'connector_auth_vault_subject_mismatch');
END;

CREATE TRIGGER IF NOT EXISTS connector_vault_aad_identity_immutable
BEFORE UPDATE OF secret_ref, installation_id, provider_id, subject_type, subject_id,
  profile_id, user_id, field_purpose, secret_kind ON connector_vault_secrets
BEGIN
  SELECT RAISE(ABORT, 'connector_auth_vault_aad_identity_immutable');
END;

CREATE TRIGGER IF NOT EXISTS connector_grant_aad_identity_immutable
BEFORE UPDATE OF grant_id, profile_id, installation_id, provider_id, user_id
ON connector_user_grants
BEGIN
  SELECT RAISE(ABORT, 'connector_auth_grant_aad_identity_immutable');
END;
`;

const OWNER_OPERATION_NONCES_V2_SQL = `
CREATE TABLE connector_owner_operation_nonces (
  nonce_hash TEXT PRIMARY KEY CHECK (
    length(nonce_hash) = 64 AND lower(nonce_hash) = nonce_hash
    AND nonce_hash NOT GLOB '*[^0-9a-f]*'
  ),
  request_id TEXT NOT NULL CHECK (${UUID_CHECK('request_id')}),
  session_id TEXT NOT NULL,
  installation_id TEXT NOT NULL,
  user_id INTEGER NOT NULL CHECK (user_id > 0),
  operation TEXT NOT NULL CHECK (operation IN (
    'upsert_byo', 'register_dcr', 'upsert_shared_api_key', 'disable',
    'upsert_personal_api_key', 'revoke_personal_grant',
    'oauth_start', 'oauth_refresh', 'oauth_revoke'
  )),
  expires_at_ms INTEGER NOT NULL CHECK (expires_at_ms > 0),
  consumed_at_ms INTEGER,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (session_id) REFERENCES connector_owner_auth_sessions(session_id) ON DELETE CASCADE,
  FOREIGN KEY (installation_id) REFERENCES connector_installations(installation_id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);`;

const upgradeOwnerOperationNonces = (database: Database): void => {
  const row = database.prepare(
    "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'connector_owner_operation_nonces'",
  ).get() as { sql: string } | undefined;
  if (!row || row.sql.includes("'oauth_start'")) return;

  database.transaction(() => {
    database.exec(`
      ALTER TABLE connector_owner_operation_nonces
        RENAME TO connector_owner_operation_nonces_m13;
      ${OWNER_OPERATION_NONCES_V2_SQL}
      INSERT INTO connector_owner_operation_nonces (
        nonce_hash, request_id, session_id, installation_id, user_id, operation,
        expires_at_ms, consumed_at_ms, created_at
      )
      SELECT nonce_hash, request_id, session_id, installation_id, user_id, operation,
             expires_at_ms, consumed_at_ms, created_at
      FROM connector_owner_operation_nonces_m13;
    `);
    const oldCount = database.prepare(
      'SELECT count(*) AS count FROM connector_owner_operation_nonces_m13',
    ).get() as { count: number };
    const newCount = database.prepare(
      'SELECT count(*) AS count FROM connector_owner_operation_nonces',
    ).get() as { count: number };
    if (oldCount.count !== newCount.count) throw new Error('connector_owner_nonce_upgrade_copy_failed');
    const violations = database.prepare(
      'PRAGMA foreign_key_check(connector_owner_operation_nonces)',
    ).all();
    if (violations.length > 0) throw new Error('connector_owner_nonce_upgrade_fk_failed');
    database.exec(`
      DROP TABLE connector_owner_operation_nonces_m13;
      CREATE INDEX idx_connector_owner_operation_expiry
        ON connector_owner_operation_nonces(consumed_at_ms, expires_at_ms);
    `);
    const index = database.prepare(
      "SELECT tbl_name FROM sqlite_master WHERE type = 'index' AND name = 'idx_connector_owner_operation_expiry'",
    ).get() as { tbl_name: string } | undefined;
    if (index?.tbl_name !== 'connector_owner_operation_nonces') {
      throw new Error('connector_owner_nonce_upgrade_index_failed');
    }
  }).immediate();
};

const OAUTH_GRANT_SERVICES_V2_SQL = `
CREATE TABLE connector_oauth_grant_services (
  grant_id TEXT NOT NULL,
  installation_id TEXT NOT NULL,
  user_id INTEGER NOT NULL CHECK (user_id > 0),
  service_id TEXT NOT NULL CHECK (length(service_id) BETWEEN 1 AND 128 AND service_id NOT GLOB '*[^a-z0-9._-]*'),
  scopes_json TEXT NOT NULL CHECK (json_valid(scopes_json) AND json_type(scopes_json) = 'array'),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (grant_id, service_id),
  FOREIGN KEY (grant_id) REFERENCES connector_user_grants(grant_id) ON DELETE CASCADE,
  FOREIGN KEY (grant_id, installation_id, user_id)
    REFERENCES connector_user_grants(grant_id, installation_id, user_id) ON DELETE CASCADE,
  FOREIGN KEY (installation_id) REFERENCES connector_installations(installation_id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);`;

const upgradeOAuthGrantServices = (database: Database): void => {
  const row = database.prepare(
    "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'connector_oauth_grant_services'",
  ).get() as { sql: string } | undefined;
  if (!row || (/FOREIGN KEY\s*\(grant_id,\s*installation_id,\s*user_id\)/u.test(row.sql)
    && !/UNIQUE\s*\(installation_id,\s*user_id,\s*service_id\)/u.test(row.sql))) return;
  database.transaction(() => {
    database.exec(`
      DROP TABLE IF EXISTS connector_oauth_connector_bindings;
      ALTER TABLE connector_oauth_grant_services RENAME TO connector_oauth_grant_services_m14a;
      ${OAUTH_GRANT_SERVICES_V2_SQL}
      INSERT INTO connector_oauth_grant_services (
        grant_id, installation_id, user_id, service_id, scopes_json, created_at, updated_at
      )
      SELECT grant_id, installation_id, user_id, service_id, scopes_json, created_at, updated_at
      FROM connector_oauth_grant_services_m14a;
      DROP TABLE connector_oauth_grant_services_m14a;
      CREATE INDEX idx_connector_oauth_grant_services_user
        ON connector_oauth_grant_services(installation_id, user_id, service_id);
      CREATE TABLE connector_oauth_connector_bindings (
        connector_id TEXT PRIMARY KEY CHECK (length(connector_id) BETWEEN 1 AND 128),
        installation_id TEXT NOT NULL,
        user_id INTEGER NOT NULL CHECK (user_id > 0),
        service_id TEXT NOT NULL,
        grant_id TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE (connector_id, installation_id, user_id, service_id, grant_id),
        FOREIGN KEY (grant_id, installation_id, user_id)
          REFERENCES connector_user_grants(grant_id, installation_id, user_id) ON DELETE CASCADE,
        FOREIGN KEY (grant_id, service_id)
          REFERENCES connector_oauth_grant_services(grant_id, service_id) ON DELETE CASCADE
      );
    `);
    if (database.prepare('PRAGMA foreign_key_check(connector_oauth_grant_services)').all().length > 0) {
      throw new Error('connector_oauth_grant_services_upgrade_fk_failed');
    }
  }).immediate();
};

/** Idempotent standalone migration for M1.2; boot wiring is intentionally deferred. */
export const migrateConnectorAuthSchema = (database: Database): void => {
  database.exec(CONNECTOR_AUTH_SCHEMA_SQL);
  upgradeOwnerOperationNonces(database);
  upgradeOAuthGrantServices(database);
  const columns = new Set((database.prepare('PRAGMA table_info(connector_user_grants)').all() as Array<{
    name: string;
  }>).map(column => column.name));
  const additions = [
    ['service_id', "TEXT NOT NULL DEFAULT ''"],
    ['provider_subject_kek_version', 'INTEGER NOT NULL DEFAULT 1'],
    ['account_label_key', "TEXT NOT NULL DEFAULT ''"],
    ['is_default', 'INTEGER NOT NULL DEFAULT 0'],
    ['legacy_provenance', 'TEXT'],
  ] as const;
  for (const [name, definition] of additions) {
    if (!columns.has(name)) database.exec(`ALTER TABLE connector_user_grants ADD COLUMN ${name} ${definition}`);
  }
  database.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_connector_grant_label
      ON connector_user_grants(installation_id, user_id, service_id, account_label_key)
      WHERE status != 'revoked' AND service_id != '' AND account_label_key != '';
    CREATE UNIQUE INDEX IF NOT EXISTS idx_connector_grant_default
      ON connector_user_grants(installation_id, user_id, service_id)
      WHERE status = 'active' AND is_default = 1 AND service_id != '';
  `);
};
