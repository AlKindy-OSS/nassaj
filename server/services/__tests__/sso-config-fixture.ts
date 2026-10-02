/**
 * Real-database fixture for the SSO configuration table (ADR-194 D3): writes a
 * fully valid row (hash recomputed) that tests then break one field at a time.
 */
import type { Database } from 'better-sqlite3';

import type { SsoOidcConfigRow, SsoSlot } from '@/modules/database/repositories/sso-oidc-config.js';
import { computeSsoConfigHash } from '@/services/sso-config-record.js';

export const FIXTURE_ISSUER = 'https://idp.example';
export const FIXTURE_CLIENT_ID = 'nassaj-client';

/** Every column of a valid, enabled, public-client row. */
export function validSsoRow(overrides: Partial<SsoOidcConfigRow> = {}): SsoOidcConfigRow {
  const row: SsoOidcConfigRow = {
    slot: 'active', enabled: 1, issuer: FIXTURE_ISSUER, client_id: FIXTURE_CLIENT_ID, client_auth: 'none',
    client_secret_enc: null, secret_version: 0, extra_scopes: '',
    redirect_uri: 'https://nassaj.example/api/auth/oidc/callback', role_claim_path: 'roles',
    role_rules_json: JSON.stringify([{ value: 'admin', role: 'admin' }, { value: 'member', role: 'user' }]),
    tenant_mode: 'claim', tenant_claim_path: 'org', tenant_values_json: JSON.stringify(['org-1']),
    jit_enabled: 0, attestation_max_age_hours: 12, allow_private_network: 0, issuer_port: null,
    pinned_endpoints_json: JSON.stringify({
      authorization_endpoint: `${FIXTURE_ISSUER}/authorize`,
      token_endpoint: `${FIXTURE_ISSUER}/token`,
      jwks_uri: `${FIXTURE_ISSUER}/jwks`,
    }),
    discovery_flags_json: JSON.stringify({ authorization_response_iss_parameter_supported: false }),
    runtime_fault: null, config_hash: '', draft_version: 0, version: 1, updated_at: null, updated_by: null,
    ...overrides,
  };
  return { ...row, config_hash: overrides.config_hash ?? computeSsoConfigHash(row) };
}

let versionCounter = 100;

/**
 * Inserts or replaces one slot's row and returns it. Each write gets a fresh
 * `version` (like every real write to the active slot), so the per-call
 * version read reloads the snapshot.
 */
export function writeSsoRow(db: Database, overrides: Partial<SsoOidcConfigRow> = {}, slot: SsoSlot = 'active') {
  versionCounter += 1;
  const row = validSsoRow({ slot, version: versionCounter, ...overrides });
  const columns = Object.keys(row);
  db.prepare(`INSERT OR REPLACE INTO sso_oidc_config (${columns.join(', ')})
    VALUES (${columns.map((column) => `@${column}`).join(', ')})`).run(row);
  return row;
}

/** Removes both slots and the disabled record. */
export function clearSsoConfig(db: Database): void {
  db.exec("DELETE FROM sso_oidc_config; DELETE FROM app_config WHERE key = 'sso.disabled';");
}
