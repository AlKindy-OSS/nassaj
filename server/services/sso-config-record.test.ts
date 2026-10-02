/** ADR-194 D3 record rules: canonical hash, extra_scopes grammar and fail-closed validation. */
import assert from 'node:assert/strict';
import test from 'node:test';

import { validSsoRow } from './__tests__/sso-config-fixture.js';
import {
  canonicalJson, computeSsoConfigHash, extraScopesValid, redactSsoConfigRow, ssoConfigInvalidReason,
} from './sso-config-record.js';

test('canonical JSON sorts keys at every depth', () => {
  assert.equal(canonicalJson({ b: 1, a: { d: [2, { z: 1, y: 2 }], c: null } }),
    '{"a":{"c":null,"d":[2,{"y":2,"z":1}]},"b":1}');
});

test('hash: formatting does not matter, every D3 field and secret_version do; the secret never enters', () => {
  const row = validSsoRow();
  assert.equal(computeSsoConfigHash(row), computeSsoConfigHash({
    ...row, role_rules_json: JSON.stringify(JSON.parse(row.role_rules_json), null, 2),
  }));
  for (const change of [
    { issuer: 'https://other.example' }, { client_id: 'x' }, { extra_scopes: 'groups' }, { redirect_uri: null },
    { role_claim_path: 'groups' }, { tenant_values_json: '["org-2"]' }, { jit_enabled: 1 },
    { attestation_max_age_hours: 3 }, { allow_private_network: 1 }, { issuer_port: 8443 },
    { pinned_endpoints_json: null }, { discovery_flags_json: '{}' }, { secret_version: 1 },
  ]) {
    assert.notEqual(computeSsoConfigHash({ ...row, ...change }), row.config_hash, JSON.stringify(change));
  }
  assert.equal(computeSsoConfigHash({ ...row, client_secret_enc: 'ssooidc:v1:a:b:c' } as never), row.config_hash);
});

test('extra_scopes grammar (D3)', () => {
  for (const ok of ['', 'groups', 'groups offline_access', 'a[]!#~']) {
    assert.equal(extraScopesValid(ok), true, ok);
  }
  for (const bad of [' groups', 'groups ', 'a  b', 'openid', 'groups email', 'a a', 'a"b', 'a\\b',
    Array.from({ length: 11 }, (_, i) => `s${i}`).join(' '), 'x'.repeat(65), 7]) {
    assert.equal(extraScopesValid(bad), false, String(bad));
  }
});

test('a valid row passes; each broken field yields its reason code', () => {
  assert.equal(ssoConfigInvalidReason(validSsoRow()), null);
  const cases: Array<[Record<string, unknown>, string]> = [
    [{ issuer: 'http://idp.example' }, 'issuer_invalid'],
    [{ issuer: 'https://idp.example/?q=1' }, 'issuer_invalid'],
    [{ client_id: '' }, 'client_id_invalid'],
    [{ client_auth: 'client_secret_basic' }, 'client_secret_missing'],
    [{ client_secret_enc: 'ssooidc:v1:a:b:c' }, 'client_secret_unexpected'],
    [{ client_auth: 'private_key_jwt' }, 'client_auth_invalid'],
    [{ extra_scopes: 'openid' }, 'extra_scopes_invalid'],
    [{ attestation_max_age_hours: 25 }, 'attestation_hours_invalid'],
    [{ issuer_port: 8443 }, 'issuer_port_invalid'],
    [{ secret_version: -1 }, 'secret_version_invalid'],
    [{ role_claim_path: '' }, 'role_claim_path_invalid'],
    [{ role_rules_json: '[]' }, 'role_rules_invalid'],
    [{ role_rules_json: '[{"value":"x","role":"owner"}]' }, 'role_rules_invalid'],
    [{ role_rules_json: '[{"value":"x","role":"user","extra":1}]' }, 'role_rules_invalid'],
    [{ role_rules_json: 'nope' }, 'role_rules_invalid'],
    [{ tenant_values_json: '[]' }, 'tenant_values_invalid'],
    [{ tenant_claim_path: null }, 'tenant_claim_path_invalid'],
    [{ tenant_mode: 'none' }, 'tenant_config_invalid'],
    [{ tenant_mode: 'none', tenant_claim_path: null, tenant_values_json: '[]', jit_enabled: 1 },
      'jit_requires_tenant_restriction'],
    [{ tenant_mode: 'role_grant_scope' }, 'tenant_config_invalid'],
    [{ redirect_uri: 'https://nassaj.example/other' }, 'redirect_uri_missing'],
    [{ redirect_uri: 'http://nassaj.example/api/auth/oidc/callback' }, 'redirect_uri_missing'],
    [{ pinned_endpoints_json: '{"authorization_endpoint":"https://a/x"}' }, 'pinned_endpoints_missing'],
    [{ pinned_endpoints_json: JSON.stringify({ authorization_endpoint: 'https://a/x', token_endpoint: 'http://a/t',
      jwks_uri: 'https://a/j' }) }, 'pinned_endpoints_missing'],
    [{ discovery_flags_json: '[]' }, 'discovery_flags_invalid'],
  ];
  for (const [change, reason] of cases) {
    assert.equal(ssoConfigInvalidReason(validSsoRow(change as never)), reason, JSON.stringify(change));
  }
  assert.equal(ssoConfigInvalidReason({ ...validSsoRow(), config_hash: 'x' }), 'config_hash_mismatch');
  assert.equal(ssoConfigInvalidReason(null), 'row_missing');
});

test('loopback http redirect is accepted (development origin), private network needs the port flag', () => {
  assert.equal(ssoConfigInvalidReason(validSsoRow({ redirect_uri: 'http://localhost:3001/api/auth/oidc/callback' })), null);
  assert.equal(ssoConfigInvalidReason(validSsoRow({ allow_private_network: 1, issuer_port: 8443 })), null);
});

test('redaction replaces the ciphertext with a boolean', () => {
  const redacted = redactSsoConfigRow(validSsoRow({ client_secret_enc: 'ssooidc:v1:a:b:c' }));
  assert.equal(redacted.hasClientSecret, true);
  assert.ok(!('client_secret_enc' in redacted));
  assert.equal(redactSsoConfigRow(validSsoRow()).hasClientSecret, false);
});
