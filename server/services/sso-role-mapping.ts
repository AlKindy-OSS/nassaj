/**
 * Role rules and tenant restriction (ADR-194 D4/D5, T-1962 S2).
 *
 * Rules: `[{ value, role }]`, 1–64 entries, exact case-sensitive match on the
 * normalized role-claim names, `role ∈ {admin, user}`, highest rank wins.
 * `owner` can never be chosen and is never derived.
 *
 * Tenant modes:
 *   none             — no restriction (JIT unavailable).
 *   claim            — any normalized value of `tenant_claim_path` is in
 *                      `tenant_values`; an `email` path also requires
 *                      `email_verified === true` (exact per-user allowlist).
 *   role_grant_scope — the role claim is an object of objects
 *                      `{ role: { scopeId: … } }`; a matched role counts only
 *                      when one of its nested keys is in `tenant_values`. A
 *                      grant whose scope cannot be proven grants nothing.
 *
 * Every refusal carries a fixed reason; nothing here throws on hostile claims.
 */
import {
  claimNames,
  claimPathRefusal,
  EMAIL_CLAIM,
  normalizeClaimValue,
  parseClaimPath,
  resolveClaimPath,
} from './sso-claim-path.js';

export type LocalSsoRole = 'admin' | 'user';
export type SsoTenantMode = 'none' | 'claim' | 'role_grant_scope';
export type SsoRoleRule = Readonly<{ value: string; role: LocalSsoRole }>;

export type SsoMapping = Readonly<{
  roleSegments: readonly string[];
  rules: readonly SsoRoleRule[];
  tenantMode: SsoTenantMode;
  tenantSegments: readonly string[] | null;
  tenantIsEmail: boolean;
  tenantValues: ReadonlySet<string>;
}>;

export const ROLES_CLAIM_ABSENT_REASON = 'roles_claim_absent';
export const NO_RECOGNIZED_ROLE_REASON = 'no_recognized_role';
export const TENANT_NOT_ALLOWED_REASON = 'tenant_not_allowed';
export const CLAIM_TOO_LARGE_REASON = 'claim_too_large';
export const EMAIL_UNVERIFIED_REASON = 'email_unverified';
export const MAPPING_UNAVAILABLE_REASON = 'mapping_unavailable';

/** Audit display: earlier rows recorded the tenant denial as `org_not_allowed`. */
export const DENIAL_REASON_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  org_not_allowed: TENANT_NOT_ALLOWED_REASON,
});

/** The canonical reason for an audit row's stored reason (legacy aliases resolved). */
export function canonicalDenialReason(reason: unknown): string | null {
  if (typeof reason !== 'string') return null;
  return Object.hasOwn(DENIAL_REASON_ALIASES, reason) ? DENIAL_REASON_ALIASES[reason] : reason;
}

const ROLE_RANK: Readonly<Record<LocalSsoRole, number>> = Object.freeze({ user: 1, admin: 2 });
const MAX_RULES = 64;
const MAX_VALUES = 64;
const MAX_VALUE_LENGTH = 128;

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const isRuleValue = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= MAX_VALUE_LENGTH
  && !/[\u0000-\u001f\u007f]/u.test(value);

function parseJson(raw: unknown): unknown {
  if (typeof raw !== 'string') return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

const isRule = (rule: unknown): rule is SsoRoleRule => isPlainObject(rule)
  && Object.keys(rule).length === 2 && isRuleValue(rule.value)
  && (rule.role === 'admin' || rule.role === 'user');

/** Parses `role_rules_json`: 1–64 well-formed rules with unique values, else null. */
export function parseRoleRules(raw: unknown): SsoRoleRule[] | null {
  const rules = parseJson(raw);
  if (!Array.isArray(rules) || rules.length === 0 || rules.length > MAX_RULES || !rules.every(isRule)) return null;
  if (new Set(rules.map((rule) => rule.value)).size !== rules.length) return null;
  return rules.map((rule) => Object.freeze({ value: rule.value, role: rule.role }));
}

/** Parses `tenant_values_json`: up to 64 unique non-empty strings, else null. */
export function parseTenantValues(raw: unknown): string[] | null {
  const values = parseJson(raw);
  if (!Array.isArray(values) || values.length > MAX_VALUES || !values.every(isRuleValue)) return null;
  return new Set(values).size === values.length ? values : null;
}

/** Exact, case-sensitive mapping; highest rank wins; null when nothing matches. */
export function mapRoleNames(names: readonly string[], rules: readonly SsoRoleRule[]): LocalSsoRole | null {
  let best: LocalSsoRole | null = null;
  for (const name of names) {
    for (const rule of rules) {
      if (rule.value === name && (best === null || ROLE_RANK[rule.role] > ROLE_RANK[best])) best = rule.role;
    }
  }
  return best;
}

type MappingRow = Readonly<{
  role_claim_path: unknown; role_rules_json: unknown; tenant_mode: unknown;
  tenant_claim_path: unknown; tenant_values_json: unknown; jit_enabled?: unknown;
}>;

function tenantRefusal(row: MappingRow, values: string[]): string | null {
  if (row.tenant_mode === 'none') {
    if (values.length !== 0 || row.tenant_claim_path !== null) return 'tenant_config_invalid';
    return row.jit_enabled === 1 ? 'jit_requires_tenant_restriction' : null;
  }
  if (values.length === 0) return 'tenant_values_invalid';
  if (row.tenant_mode === 'claim') return claimPathRefusal(row.tenant_claim_path, 'tenant');
  if (row.tenant_mode === 'role_grant_scope') return row.tenant_claim_path === null ? null : 'tenant_config_invalid';
  return 'tenant_mode_invalid';
}

/** Save/apply-time refusal for the D4/D5 fields of a row, or null when valid. */
export function ssoMappingRefusal(row: MappingRow): string | null {
  const roleRefusal = claimPathRefusal(row.role_claim_path, 'role');
  if (roleRefusal) return roleRefusal;
  if (parseRoleRules(row.role_rules_json) === null) return 'role_rules_invalid';
  const values = parseTenantValues(row.tenant_values_json);
  if (values === null) return 'tenant_values_invalid';
  return tenantRefusal(row, values);
}

/** The evaluable mapping of a row, or null when its D4/D5 fields are invalid. */
export function buildSsoMapping(row: MappingRow): SsoMapping | null {
  if (ssoMappingRefusal(row) !== null) return null;
  const roleSegments = (parseClaimPath(row.role_claim_path) as { segments: string[] }).segments;
  const tenantPath = row.tenant_mode === 'claim' ? parseClaimPath(row.tenant_claim_path) : null;
  const tenantSegments = tenantPath?.ok ? tenantPath.segments : null;
  return Object.freeze({
    roleSegments: Object.freeze(roleSegments),
    rules: Object.freeze(parseRoleRules(row.role_rules_json) ?? []),
    tenantMode: row.tenant_mode as SsoTenantMode,
    tenantSegments: tenantSegments ? Object.freeze(tenantSegments) : null,
    tenantIsEmail: tenantSegments?.length === 1 && tenantSegments[0] === EMAIL_CLAIM,
    tenantValues: new Set(parseTenantValues(row.tenant_values_json) ?? []),
  });
}

export type SsoClaimsDecision = Readonly<{ role: LocalSsoRole | null; reason: string | null }>;

const refuse = (reason: string): SsoClaimsDecision => ({ role: null, reason });

/** D5 `claim` mode on its own: null when the tenant claim passes, else the refusal reason. */
function claimTenantRefusal(claims: unknown, mapping: SsoMapping): string | null {
  if (mapping.tenantSegments === null) return TENANT_NOT_ALLOWED_REASON;
  if (mapping.tenantIsEmail && (claims as { email_verified?: unknown }).email_verified !== true) {
    return EMAIL_UNVERIFIED_REASON;
  }
  const tenant = claimNames(claims, mapping.tenantSegments);
  if (tenant.status === 'too_large') return CLAIM_TOO_LARGE_REASON;
  if (tenant.status !== 'ok' || !tenant.names.some((name) => mapping.tenantValues.has(name))) {
    return TENANT_NOT_ALLOWED_REASON;
  }
  return null;
}

/**
 * D5 `role_grant_scope`: the role names whose nested grant object carries a
 * key in `tenant_values`. Any oversized level refuses the whole claim.
 */
function scopedRoleNames(value: unknown, mapping: SsoMapping): string[] | 'too_large' {
  if (!isPlainObject(value)) return [];
  const names = normalizeClaimValue(value);
  if (names.status === 'too_large') return 'too_large';
  if (names.status !== 'ok') return [];
  const granted: string[] = [];
  for (const name of names.names) {
    const grants = value[name];
    if (!isPlainObject(grants)) continue;
    const scopes = normalizeClaimValue(grants);
    if (scopes.status === 'too_large') return 'too_large';
    if (scopes.status === 'ok' && scopes.names.some((scope) => mapping.tenantValues.has(scope))) granted.push(name);
  }
  return granted;
}

function scopedDecision(claims: unknown, mapping: SsoMapping): SsoClaimsDecision {
  const lookup = resolveClaimPath(claims, mapping.roleSegments);
  const granted = scopedRoleNames(lookup.present ? lookup.value : undefined, mapping);
  if (granted === 'too_large') return refuse(CLAIM_TOO_LARGE_REASON);
  const scopedRole = mapRoleNames(granted, mapping.rules);
  return scopedRole === null ? refuse(TENANT_NOT_ALLOWED_REASON) : { role: scopedRole, reason: null };
}

/**
 * Evaluates verified id_token claims against a mapping (D4 + D5). The result
 * carries the local role, or null with the refusal reason. A null mapping
 * (SSO unavailable or invalid row) refuses with `mapping_unavailable`.
 */
export function evaluateSsoClaims(claims: unknown, mapping: SsoMapping | null): SsoClaimsDecision {
  if (mapping === null) return refuse(MAPPING_UNAVAILABLE_REASON);
  if (!isPlainObject(claims)) return refuse(ROLES_CLAIM_ABSENT_REASON);
  const lookup = resolveClaimPath(claims, mapping.roleSegments);
  if (!lookup.present) return refuse(ROLES_CLAIM_ABSENT_REASON);
  const names = claimNames(claims, mapping.roleSegments);
  if (names.status === 'too_large') return refuse(CLAIM_TOO_LARGE_REASON);
  const role = names.status === 'ok' ? mapRoleNames(names.names, mapping.rules) : null;
  if (role === null) return refuse(NO_RECOGNIZED_ROLE_REASON);
  if (mapping.tenantMode === 'role_grant_scope') return scopedDecision(claims, mapping);
  if (mapping.tenantMode === 'claim') {
    const tenantReason = claimTenantRefusal(claims, mapping);
    if (tenantReason) return refuse(tenantReason);
  }
  return { role, reason: null };
}

/** Whether the role claim has the object-of-objects shape `role_grant_scope` needs (D5 shape flag). */
export function roleClaimIsObjectOfObjects(claims: unknown, mapping: Pick<SsoMapping, 'roleSegments'>): boolean {
  const lookup = resolveClaimPath(claims, mapping.roleSegments);
  if (!lookup.present || !isPlainObject(lookup.value)) return false;
  const entries = Object.values(lookup.value);
  return entries.length > 0 && entries.every(isPlainObject);
}
