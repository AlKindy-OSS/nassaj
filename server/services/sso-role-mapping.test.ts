import assert from 'node:assert/strict';
import test from 'node:test';

import {
  FIXTURE_RULES,
  fixtureRowFields,
  FOREIGN_ROLES_CLAIM,
  NESTED_ROLES_CLAIM,
  PROVIDER_FIXTURES,
} from './__tests__/sso-provider-claims.js';
import {
  buildSsoMapping,
  canonicalDenialReason,
  evaluateSsoClaims,
  mapRoleNames,
  parseRoleRules,
  parseTenantValues,
  roleClaimIsObjectOfObjects,
  ssoMappingRefusal,
  type SsoMapping,
} from './sso-role-mapping.js';

const mappingFor = (fields: Record<string, unknown>): SsoMapping => {
  const mapping = buildSsoMapping({
    role_claim_path: 'roles', role_rules_json: JSON.stringify(FIXTURE_RULES), tenant_mode: 'none',
    tenant_claim_path: null, tenant_values_json: '[]', jit_enabled: 0, ...fields,
  });
  assert.ok(mapping, JSON.stringify(fields));
  return mapping;
};

test('multi-provider fixtures map to the expected local role', () => {
  for (const [name, fixture] of Object.entries(PROVIDER_FIXTURES)) {
    const mapping = buildSsoMapping(fixtureRowFields(fixture));
    assert.ok(mapping, name);
    const decision = evaluateSsoClaims(fixture.claims, mapping);
    assert.equal(decision.role, fixture.expectedRole, name);
    if (fixture.expectedRole === null) assert.equal(decision.reason, 'roles_claim_absent', name);
  }
});

test('rules: exact and case-sensitive, highest rank wins, owner is never derived', () => {
  const rules = parseRoleRules(JSON.stringify(FIXTURE_RULES))!;
  assert.equal(mapRoleNames(['member', 'admin'], rules), 'admin');
  assert.equal(mapRoleNames(['admin', 'member'], rules), 'admin');
  assert.equal(mapRoleNames(['ADMIN', 'Admin', ' admin'], rules), null);
  assert.equal(mapRoleNames(['owner'], rules), null);
  assert.equal(mapRoleNames([], rules), null);
  for (const raw of [
    '[{"value":"owner","role":"owner"}]', '[]', 'nope', '{}', '[{"value":"","role":"user"}]',
    '[{"value":"a","role":"user"},{"value":"a","role":"admin"}]', '[{"value":"a","role":"user","x":1}]',
    `[{"value":"${'x'.repeat(129)}","role":"user"}]`, '[{"value":"a\\u0000","role":"user"}]',
    JSON.stringify(Array.from({ length: 65 }, (_, i) => ({ value: `v${i}`, role: 'user' }))),
  ]) {
    assert.equal(parseRoleRules(raw), null, raw);
  }
  assert.equal(parseRoleRules(42), null);
});

test('tenant values: up to 64 unique non-empty strings', () => {
  assert.deepEqual(parseTenantValues('["a","b"]'), ['a', 'b']);
  for (const raw of ['["a","a"]', '[""]', '[1]', '{}', 'x', JSON.stringify(Array.from({ length: 65 }, (_, i) => `t${i}`))]) {
    assert.equal(parseTenantValues(raw), null, raw);
  }
});

test('refusal reasons: absent, unrecognized, too large, tenant', () => {
  const mapping = mappingFor({});
  assert.deepEqual(evaluateSsoClaims({}, mapping), { role: null, reason: 'roles_claim_absent' });
  assert.deepEqual(evaluateSsoClaims({ roles: ['viewer-x'] }, mapping), { role: null, reason: 'no_recognized_role' });
  assert.deepEqual(evaluateSsoClaims({ roles: 7 }, mapping), { role: null, reason: 'no_recognized_role' });
  assert.deepEqual(evaluateSsoClaims({ roles: [] }, mapping), { role: null, reason: 'no_recognized_role' });
  const many = Array.from({ length: 65 }, (_, i) => `r${i}`).concat('admin');
  assert.deepEqual(evaluateSsoClaims({ roles: many }, mapping), { role: null, reason: 'claim_too_large' });
  assert.deepEqual(evaluateSsoClaims({ roles: ['admin', 'x'.repeat(129)] }, mapping),
    { role: null, reason: 'claim_too_large' });
  assert.deepEqual(evaluateSsoClaims(null, mapping), { role: null, reason: 'roles_claim_absent' });
  assert.deepEqual(evaluateSsoClaims({ roles: ['admin'] }, null), { role: null, reason: 'mapping_unavailable' });
  assert.deepEqual(evaluateSsoClaims({ roles: 'admin' }, mapping), { role: 'admin', reason: null });
});

test('claim tenant mode: any value in the list passes; absent or unlisted refuses', () => {
  const mapping = mappingFor({ tenant_mode: 'claim', tenant_claim_path: 'org', tenant_values_json: '["o-1","o-2"]' });
  assert.equal(evaluateSsoClaims({ roles: ['member'], org: ['x', 'o-2'] }, mapping).role, 'user');
  assert.equal(evaluateSsoClaims({ roles: ['member'], org: 'o-1' }, mapping).role, 'user');
  assert.deepEqual(evaluateSsoClaims({ roles: ['member'], org: 'O-1' }, mapping),
    { role: null, reason: 'tenant_not_allowed' });
  assert.deepEqual(evaluateSsoClaims({ roles: ['member'] }, mapping), { role: null, reason: 'tenant_not_allowed' });
  assert.deepEqual(evaluateSsoClaims({ roles: ['member'], org: Array(65).fill('o-1') }, mapping),
    { role: null, reason: 'claim_too_large' });
  assert.deepEqual(evaluateSsoClaims({ roles: ['nope'], org: 'o-1' }, mapping),
    { role: null, reason: 'no_recognized_role' });
});

test('email tenant path: exact per-user allowlist, and email_verified must be boolean true', () => {
  const mapping = mappingFor({ tenant_mode: 'claim', tenant_claim_path: 'email', tenant_values_json: '["a@x.example"]' });
  assert.equal(evaluateSsoClaims({ roles: ['admin'], email: 'a@x.example', email_verified: true }, mapping).role, 'admin');
  for (const verified of [undefined, false, 'true', 1, null]) {
    assert.deepEqual(evaluateSsoClaims({ roles: ['admin'], email: 'a@x.example', email_verified: verified }, mapping),
      { role: null, reason: 'email_unverified' }, String(verified));
  }
  assert.deepEqual(evaluateSsoClaims({ roles: ['admin'], email: 'b@x.example', email_verified: true }, mapping),
    { role: null, reason: 'tenant_not_allowed' });
  assert.deepEqual(evaluateSsoClaims({ roles: ['admin'], email: 'A@x.example', email_verified: true }, mapping),
    { role: null, reason: 'tenant_not_allowed' }, 'no case folding, no wildcard');
});

test('role_grant_scope: a role counts only when granted by an allowed scope', () => {
  const fixture = PROVIDER_FIXTURES.nestedGrants;
  const mapping = buildSsoMapping(fixtureRowFields(fixture))!;
  assert.equal(evaluateSsoClaims(fixture.claims, mapping).role, 'user', 'admin from org-b does not count');
  const both = buildSsoMapping(fixtureRowFields(fixture, { tenant_values_json: '["org-a","org-b"]' }))!;
  assert.equal(evaluateSsoClaims(fixture.claims, both).role, 'admin');
  const none = buildSsoMapping(fixtureRowFields(fixture, { tenant_values_json: '["org-z"]' }))!;
  assert.deepEqual(evaluateSsoClaims(fixture.claims, none), { role: null, reason: 'tenant_not_allowed' });
  const cases: Array<[unknown, string]> = [
    [['admin'], 'tenant_not_allowed'],
    [{ admin: ['org-a'] }, 'tenant_not_allowed'],
    [{ admin: 'org-a' }, 'tenant_not_allowed'],
    [{ admin: Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`o${i}`, 'd'])) }, 'claim_too_large'],
  ];
  for (const [value, reason] of cases) {
    assert.deepEqual(evaluateSsoClaims({ [NESTED_ROLES_CLAIM]: value }, mapping), { role: null, reason },
      JSON.stringify(value).slice(0, 60));
  }
  assert.deepEqual(evaluateSsoClaims({ [FOREIGN_ROLES_CLAIM]: { admin: { 'org-a': 'd' } } }, mapping),
    { role: null, reason: 'roles_claim_absent' }, 'a foreign project claim is never read');
  const inherited = Object.create({ 'org-a': 'd' });
  assert.deepEqual(evaluateSsoClaims({ [NESTED_ROLES_CLAIM]: { member: inherited } }, mapping),
    { role: null, reason: 'tenant_not_allowed' }, 'inherited scope keys never count');
});

test('shape flag: object of objects only', () => {
  const mapping = { roleSegments: ['r'] };
  assert.equal(roleClaimIsObjectOfObjects({ r: { admin: { s: 'x' } } }, mapping), true);
  assert.equal(roleClaimIsObjectOfObjects({ r: { admin: ['s'] } }, mapping), false);
  assert.equal(roleClaimIsObjectOfObjects({ r: {} }, mapping), false);
  assert.equal(roleClaimIsObjectOfObjects({ r: ['admin'] }, mapping), false);
  assert.equal(roleClaimIsObjectOfObjects({}, mapping), false);
});

test('row validation: D4/D5 refusal codes', () => {
  const base = fixtureRowFields(PROVIDER_FIXTURES.groups);
  assert.equal(ssoMappingRefusal(base), null);
  const cases: Array<[Record<string, unknown>, string]> = [
    [{ role_claim_path: '' }, 'role_claim_path_invalid'],
    [{ role_claim_path: 'preferred_username' }, 'claim_path_user_editable'],
    [{ role_claim_path: 'email' }, 'claim_path_user_editable'],
    [{ role_claim_path: 'a.__proto__' }, 'role_claim_path_invalid'],
    [{ role_rules_json: '[]' }, 'role_rules_invalid'],
    [{ tenant_values_json: '[1]' }, 'tenant_values_invalid'],
    [{ tenant_values_json: '[]' }, 'tenant_values_invalid'],
    [{ tenant_claim_path: 'name' }, 'claim_path_user_editable'],
    [{ tenant_claim_path: null }, 'tenant_claim_path_invalid'],
    [{ tenant_mode: 'role_grant_scope' }, 'tenant_config_invalid'],
    [{ tenant_mode: 'none' }, 'tenant_config_invalid'],
    [{ tenant_mode: 'none', tenant_claim_path: null, tenant_values_json: '[]', jit_enabled: 1 },
      'jit_requires_tenant_restriction'],
    [{ tenant_mode: 'bogus' }, 'tenant_mode_invalid'],
  ];
  for (const [change, reason] of cases) {
    assert.equal(ssoMappingRefusal({ ...base, ...change }), reason, JSON.stringify(change));
    assert.equal(buildSsoMapping({ ...base, ...change }), null);
  }
  assert.equal(ssoMappingRefusal({ ...base, tenant_mode: 'none', tenant_claim_path: null, tenant_values_json: '[]' }),
    null);
});

test('audit alias: org_not_allowed reads as tenant_not_allowed', () => {
  assert.equal(canonicalDenialReason('org_not_allowed'), 'tenant_not_allowed');
  assert.equal(canonicalDenialReason('no_recognized_role'), 'no_recognized_role');
  assert.equal(canonicalDenialReason('toString'), 'toString');
  assert.equal(canonicalDenialReason(7), null);
});

function rng(seed: number) {
  let state = seed >>> 0 || 1;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x1_0000_0000;
  };
}

test('fuzz: evaluation never throws, never yields owner, and matches a rule oracle', () => {
  const next = rng(0xa11ce);
  const mapping = mappingFor({});
  const pool = ['admin', 'member', 'viewer', 'owner', 'Admin', 'nassaj-admins', 'x', '', 7, null, { a: 1 }];
  for (let i = 0; i < 10_000; i += 1) {
    const length = Math.floor(next() * 6);
    const values = Array.from({ length }, () => pool[Math.floor(next() * pool.length)]);
    const shape = next();
    const roles = shape < 0.4 ? values : shape < 0.7 ? Object.fromEntries(values.map((v) => [String(v), {}]))
      : values[0];
    const decision = evaluateSsoClaims({ roles }, mapping);
    assert.notEqual(decision.role, 'owner');
    const names = typeof roles === 'string' ? [roles]
      : Array.isArray(roles) ? roles.filter((v) => typeof v === 'string')
        : roles && typeof roles === 'object' ? Object.keys(roles) : [];
    const ranks = names.map((n) => FIXTURE_RULES.find((r) => r.value === n)?.role ?? null);
    const expected = ranks.includes('admin') ? 'admin' : ranks.includes('user') ? 'user' : null;
    assert.equal(decision.role, expected, JSON.stringify(roles));
  }
});
