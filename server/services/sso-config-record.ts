/**
 * SSO configuration record rules (ADR-194 D3, T-1962 S1): the canonical
 * `config_hash` and the validation a row must pass before the state model
 * treats it as usable. Validation answers a fixed reason code, never echoes a
 * value, and never throws on hostile input.
 * The role, tenant and claim-path checks are the D4/D5 rules of
 * sso-role-mapping.ts (S2).
 */
import crypto from 'node:crypto';

import type { SsoOidcConfigRow } from '@/modules/database/repositories/sso-oidc-config.js';
import { parseExactHttpsIssuer } from '@/services/oidc-verifier.service.js';
import { ssoMappingRefusal } from '@/services/sso-role-mapping.js';

/** Path every computed redirect URI ends with (D3). */
export const SSO_CALLBACK_PATH = '/api/auth/oidc/callback';
export const PINNED_ENDPOINT_KEYS = Object.freeze(['authorization_endpoint', 'token_endpoint', 'jwks_uri'] as const);

const MAX_CLIENT_ID_LENGTH = 256;
const SCOPE_TOKEN = /^[\x21\x23-\x5B\x5D-\x7E]{1,64}$/;
const ALWAYS_SENT_SCOPES = new Set(['openid', 'profile', 'email']);
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

type HashInput = Pick<SsoOidcConfigRow, 'issuer' | 'client_id' | 'client_auth' | 'extra_scopes'
  | 'redirect_uri' | 'role_claim_path' | 'role_rules_json' | 'tenant_mode' | 'tenant_claim_path'
  | 'tenant_values_json' | 'jit_enabled' | 'attestation_max_age_hours' | 'allow_private_network'
  | 'issuer_port' | 'pinned_endpoints_json' | 'discovery_flags_json' | 'secret_version'>;

/** JSON with object keys sorted at every depth, so equal content hashes equally. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.keys(value).sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

/** Parses stored JSON; an unparseable value is kept as its raw string. */
function parsedOrRaw(raw: string | null): unknown {
  if (raw === null) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

/** SHA-256 over the D3 field list; the secret itself never enters the hash. */
export function computeSsoConfigHash(row: HashInput): string {
  const material = {
    issuer: row.issuer, client_id: row.client_id, client_auth: row.client_auth,
    extra_scopes: row.extra_scopes, redirect_uri: row.redirect_uri, role_claim_path: row.role_claim_path,
    role_rules: parsedOrRaw(row.role_rules_json), tenant_mode: row.tenant_mode,
    tenant_claim_path: row.tenant_claim_path, tenant_values: parsedOrRaw(row.tenant_values_json),
    jit_enabled: row.jit_enabled, attestation_max_age_hours: row.attestation_max_age_hours,
    allow_private_network: row.allow_private_network, issuer_port: row.issuer_port,
    pinned_endpoints: parsedOrRaw(row.pinned_endpoints_json),
    discovery_flags: parsedOrRaw(row.discovery_flags_json), secret_version: row.secret_version,
  };
  return crypto.createHash('sha256').update(canonicalJson(material)).digest('hex');
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const isBoundedString = (value: unknown, max: number): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value);

/** True for an https URL (http only on loopback when allowed) without userinfo or fragment. */
function isSafeUrl(raw: unknown, allowLoopbackHttp: boolean): boolean {
  if (typeof raw !== 'string' || raw.length > 2048) return false;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return false;
  }
  if (parsed.username || parsed.password || parsed.hash) return false;
  if (parsed.protocol === 'https:') return true;
  return allowLoopbackHttp && parsed.protocol === 'http:' && LOOPBACK_HOSTS.has(parsed.hostname);
}

/** D3 `extra_scopes` grammar: ≤10 unique RFC 6749 tokens, never repeating the fixed three. */
export function extraScopesValid(raw: unknown): boolean {
  if (typeof raw !== 'string') return false;
  if (raw === '') return true;
  const tokens = raw.split(' ');
  if (tokens.length > 10 || new Set(tokens).size !== tokens.length) return false;
  return tokens.every((token) => SCOPE_TOKEN.test(token) && !ALWAYS_SENT_SCOPES.has(token));
}

/** Pinned endpoints: exactly the three D3 URLs, all https. */
export function pinnedEndpointsValid(raw: string | null): boolean {
  const parsed = parsedOrRaw(raw);
  if (!isPlainObject(parsed)) return false;
  const keys = Object.keys(parsed);
  return keys.length === PINNED_ENDPOINT_KEYS.length
    && PINNED_ENDPOINT_KEYS.every((key) => Object.hasOwn(parsed, key) && isSafeUrl(parsed[key], false));
}

/** Redirect URI: the computed `<origin>/api/auth/oidc/callback`, without query or fragment. */
export function redirectUriValid(raw: string | null): boolean {
  if (!isSafeUrl(raw, true)) return false;
  const parsed = new URL(raw as string);
  return parsed.pathname === SSO_CALLBACK_PATH && parsed.search === '';
}

function clientReason(row: SsoOidcConfigRow): string | null {
  try {
    parseExactHttpsIssuer(row.issuer);
  } catch {
    return 'issuer_invalid';
  }
  if (!isBoundedString(row.client_id, MAX_CLIENT_ID_LENGTH)) return 'client_id_invalid';
  if (row.client_auth === 'none') return row.client_secret_enc === null ? null : 'client_secret_unexpected';
  if (row.client_auth !== 'client_secret_basic' && row.client_auth !== 'client_secret_post') {
    return 'client_auth_invalid';
  }
  return typeof row.client_secret_enc === 'string' && row.client_secret_enc.length > 0
    ? null : 'client_secret_missing';
}

function networkReason(row: SsoOidcConfigRow): string | null {
  if (!extraScopesValid(row.extra_scopes)) return 'extra_scopes_invalid';
  const hours = row.attestation_max_age_hours;
  if (!Number.isInteger(hours) || hours < 1 || hours > 24) return 'attestation_hours_invalid';
  if (row.allow_private_network !== 0 && row.allow_private_network !== 1) return 'private_network_invalid';
  if (row.issuer_port !== null && (row.allow_private_network !== 1 || !Number.isInteger(row.issuer_port)
    || row.issuer_port < 1 || row.issuer_port > 65535)) return 'issuer_port_invalid';
  if (!Number.isSafeInteger(row.secret_version) || row.secret_version < 0) return 'secret_version_invalid';
  return null;
}

function bindingReason(row: SsoOidcConfigRow): string | null {
  if (!redirectUriValid(row.redirect_uri)) return 'redirect_uri_missing';
  if (!pinnedEndpointsValid(row.pinned_endpoints_json)) return 'pinned_endpoints_missing';
  if (row.discovery_flags_json !== null && !isPlainObject(parsedOrRaw(row.discovery_flags_json))) {
    return 'discovery_flags_invalid';
  }
  return computeSsoConfigHash(row) === row.config_hash ? null : 'config_hash_mismatch';
}

/**
 * Full validation of a row the state model may use. Returns null when usable,
 * otherwise the first failing reason code. Never throws.
 */
export function ssoConfigInvalidReason(row: SsoOidcConfigRow | null | undefined): string | null {
  if (!isPlainObject(row)) return 'row_missing';
  try {
    return clientReason(row) ?? networkReason(row) ?? ssoMappingRefusal(row) ?? bindingReason(row);
  } catch {
    return 'row_unreadable';
  }
}

/** A row safe to return through the API: the ciphertext is replaced by a boolean (D3). */
export function redactSsoConfigRow(row: SsoOidcConfigRow): Omit<SsoOidcConfigRow, 'client_secret_enc'>
  & { hasClientSecret: boolean } {
  const { client_secret_enc: secret, ...rest } = row;
  return { ...rest, hasClientSecret: typeof secret === 'string' && secret.length > 0 };
}
