/**
 * Server code → plain-language message key (brief §7.3, `settings:sso.diag.*`).
 *
 * The server contract is authoritative and keeps growing (discovery failure
 * codes in particular), so an unknown code never breaks the page: it renders
 * the generic `sso.diag.unknown` sentence with the raw code shown beside it.
 */

export type SsoMessage = { key: string; params?: Record<string, unknown>; known: boolean };

/** Codes with their own `sso.diag.<code>` sentence. */
const DIRECT_CODES: ReadonlySet<string> = new Set([
  // Test sign-in diagnostics and callback refusals
  'roles_claim_absent', 'no_recognized_role', 'claim_too_large', 'email_unverified', 'tenant_not_allowed',
  'iss_mismatch', 'sso_test_config_changed', 'sso_test_discovery_required', 'sso_test_config_invalid',
  'access_denied', 'mapping_incomplete', 'mapping_unavailable', 'temporarily_unavailable',
  'sso_test_result_not_found', 'callback_rejected',
  // Discovery: content checks and warning
  'discovery_issuer_mismatch', 'discovery_endpoint_invalid', 'discovery_code_flow_unsupported',
  'discovery_signing_alg_unsupported', 'discovery_client_auth_unsupported', 'discovery_pkce_s256_unsupported',
  'discovery_pkce_methods_unadvertised', 'jwks_no_usable_key', 'invalid_jwks',
  // Discovery: fallbacks
  'discovery_unavailable', 'jwks_unavailable',
  // Discovery: network
  'fetch_dns_failed', 'fetch_address_private', 'fetch_address_blocked', 'fetch_port_blocked', 'fetch_tls_failed',
  'fetch_connect_failed', 'fetch_timeout', 'fetch_redirect_refused', 'fetch_request_invalid',
  'fetch_http_4xx', 'fetch_http_5xx',
  // Settings writes
  'sso_draft_changed', 'sso_draft_missing', 'sso_secret_key_unavailable', 'sso_apply_invalid',
  'sso_apply_proof_missing', 'sso_force_off', 'sso_keep_confirmation_required', 'sso_config_invalid',
  'sso_secret_undecryptable', 'sso_active_config_missing', 'sso_runtime_fault', 'sso_disable_invalid',
  'legacy_env_incomplete', 'sso_active_config_exists', 'installation_origin_invalid',
  'installation_origin_managed_by_connectors', 'identity_changed', 'oidc_config_changed', 'rate_limited',
  'network', 'internal_error',
  // Step-up
  'step_up_required', 'step_up_failed', 'step_up_invalid_request', 'step_up_rate_limited',
  'password_change_required', 'no_eligible_passkey', 'passkey_failed',
]);

/** Codes that share a sentence with another code. */
const ALIASES: Readonly<Record<string, string>> = {
  org_not_allowed: 'tenant_not_allowed',
  fetch_http_1xx: 'fetch_http_other',
  fetch_http_3xx: 'fetch_http_other',
  fetch_http_other: 'fetch_http_other',
  fetch_too_large: 'fetch_unexpected',
  fetch_not_json: 'fetch_unexpected',
};

/** `reason` of `sso_mapping_invalid` (server/services/sso-role-mapping.ts, sso-claim-path.ts). */
const MAPPING_REASONS: ReadonlySet<string> = new Set([
  'claim_path_user_editable', 'claim_path_invalid', 'role_rules_invalid', 'tenant_values_invalid',
  'tenant_config_invalid', 'tenant_mode_invalid', 'jit_requires_tenant_restriction',
]);

/** `field` of `sso_draft_invalid` (server/services/sso-draft-input.js). */
const DRAFT_FIELDS: ReadonlySet<string> = new Set([
  'issuer', 'clientId', 'clientAuth', 'clientSecret', 'clearClientSecret', 'extraScopes',
  'attestationMaxAgeHours', 'allowPrivateNetwork', 'issuerPort', 'roleClaimPath', 'roleRules',
  'tenantMode', 'tenantClaimPath', 'tenantValues', 'jitEnabled',
]);

/** Address categories a private-network opt-in can reach (server split, T-1962 S4). */
export const PRIVATE_ADDRESS_CATEGORIES: ReadonlySet<string> = new Set(['private', 'cgnat', 'ula']);

/**
 * The message for `code`. `details` carries the server's `field`/`reason`
 * extras (already stripped of `code` and `error`).
 */
export function ssoMessageFor(code: string, details?: Record<string, unknown>): SsoMessage {
  if (code === 'sso_mapping_invalid') {
    const reason = typeof details?.reason === 'string' ? details.reason : '';
    return MAPPING_REASONS.has(reason)
      ? { key: `sso.diag.mapping.${reason}`, known: true }
      : { key: 'sso.diag.mapping.generic', known: true };
  }
  if (code === 'sso_draft_invalid') {
    const field = typeof details?.field === 'string' ? details.field : '';
    return DRAFT_FIELDS.has(field)
      ? { key: `sso.diag.field.${field}`, known: true }
      : { key: 'sso.diag.field.generic', known: true };
  }
  if (code.startsWith('fetch_http_') && !DIRECT_CODES.has(code)) {
    return { key: 'sso.diag.fetch_http_other', known: true };
  }
  const alias = ALIASES[code];
  if (alias) return { key: `sso.diag.${alias}`, known: true };
  if (DIRECT_CODES.has(code)) return { key: `sso.diag.${code}`, known: true };
  return { key: 'sso.diag.unknown', params: { code }, known: false };
}

/** Step-up refusals the step-up dialog answers itself (the action is retried there). */
export const STEP_UP_DIALOG_CODES: ReadonlySet<string> = new Set([
  'step_up_required', 'step_up_failed', 'step_up_invalid_request', 'step_up_rate_limited',
  'password_change_required', 'no_eligible_passkey', 'passkey_failed', 'passkey_cancelled',
]);
