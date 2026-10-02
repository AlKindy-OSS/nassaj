/**
 * Multi-provider id_token claim fixtures (ADR-194 test plan, T-1962 S2).
 * Each is DATA shaped like a real identity provider's claims, under neutral
 * names; none of these strings belongs in production code. `mapping` holds the
 * row fields an owner would configure for that provider.
 */
export type ProviderFixture = Readonly<{
  claims: Record<string, unknown>;
  mapping: Readonly<{
    role_claim_path: string;
    tenant_mode: 'none' | 'claim' | 'role_grant_scope';
    tenant_claim_path: string | null;
    tenant_values: readonly string[];
  }>;
  /** The local role the default rules should produce. */
  expectedRole: 'admin' | 'user' | null;
}>;

/** Rules an owner would write for the fixtures below (D4). */
export const FIXTURE_RULES = Object.freeze([
  { value: 'admin', role: 'admin' },
  { value: 'member', role: 'user' },
  { value: 'viewer', role: 'user' },
  { value: 'nassaj-admins', role: 'admin' },
  { value: 'nassaj-users', role: 'user' },
  { value: 'Nassaj.Admin', role: 'admin' },
  { value: 'Nassaj.User', role: 'user' },
] as const);

/** Project-scoped roles claim in the nested `{ role: { scopeId: domain } }` shape. */
export const NESTED_ROLES_CLAIM = 'urn:example:iam:org:project:p-42:roles';
/** A second project's roles claim that must never be read. */
export const FOREIGN_ROLES_CLAIM = 'urn:example:iam:org:project:p-99:roles';

export const PROVIDER_FIXTURES: Readonly<Record<string, ProviderFixture>> = Object.freeze({
  realmRoles: {
    claims: {
      iss: 'https://kc.example/realms/main', sub: 'kc-1', organization: ['acme'],
      realm_access: { roles: ['offline_access', 'member'] },
      resource_access: { nassaj: { roles: ['admin'] }, other: { roles: ['admin'] } },
    },
    mapping: {
      role_claim_path: 'resource_access["nassaj"].roles', tenant_mode: 'claim',
      tenant_claim_path: 'organization', tenant_values: ['acme'],
    },
    expectedRole: 'admin',
  },
  appRoles: {
    claims: {
      iss: 'https://login.example/tenant-1/v2.0', sub: 'aad-1', tid: 'tenant-1', roles: ['Nassaj.User'],
    },
    mapping: { role_claim_path: 'roles', tenant_mode: 'claim', tenant_claim_path: 'tid', tenant_values: ['tenant-1'] },
    expectedRole: 'user',
  },
  groups: {
    claims: { iss: 'https://org.okta.example', sub: 'okta-1', groups: ['Everyone', 'nassaj-admins'], org_id: 'o-1' },
    mapping: { role_claim_path: 'groups', tenant_mode: 'claim', tenant_claim_path: 'org_id', tenant_values: ['o-1'] },
    expectedRole: 'admin',
  },
  hostedDomainNoRoles: {
    claims: { iss: 'https://accounts.example', sub: 'g-1', hd: 'acme.example', email: 'a@acme.example' },
    mapping: { role_claim_path: 'groups', tenant_mode: 'claim', tenant_claim_path: 'hd', tenant_values: ['acme.example'] },
    expectedRole: null,
  },
  nestedGrants: {
    claims: {
      iss: 'https://id.example', sub: 'n-1',
      [NESTED_ROLES_CLAIM]: { member: { 'org-a': 'a.example' }, admin: { 'org-b': 'b.example' } },
      [FOREIGN_ROLES_CLAIM]: { admin: { 'org-a': 'a.example' } },
    },
    mapping: {
      role_claim_path: `["${NESTED_ROLES_CLAIM}"]`, tenant_mode: 'role_grant_scope',
      tenant_claim_path: null, tenant_values: ['org-a'],
    },
    expectedRole: 'user',
  },
});

/** Row fields for a fixture (D3 column names), with the shared rules. */
export function fixtureRowFields(fixture: ProviderFixture, overrides: Record<string, unknown> = {}) {
  return {
    role_claim_path: fixture.mapping.role_claim_path,
    role_rules_json: JSON.stringify(FIXTURE_RULES),
    tenant_mode: fixture.mapping.tenant_mode,
    tenant_claim_path: fixture.mapping.tenant_claim_path,
    tenant_values_json: JSON.stringify(fixture.mapping.tenant_values),
    jit_enabled: 0,
    ...overrides,
  };
}
