/**
 * ADR-194 D3/D4/D5 + I5 (T-1962 S8): the PUT /draft parser refuses every
 * malformed or hostile field with a fixed field code (never the value), and
 * draftNeedsStepUp asks for sso_config step-up exactly when private-network
 * reach turns on or the explicit issuer port changes. Pure; no database.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { draftNeedsStepUp, parseSsoDraftInput } from './sso-draft-input.js';

const VALID = Object.freeze({
  issuer: 'https://idp.example', clientId: 'nassaj-client', clientAuth: 'none', extraScopes: '',
  roleClaimPath: 'roles', roleRules: [{ value: 'member', role: 'user' }], tenantMode: 'claim',
  tenantClaimPath: 'org', tenantValues: ['org-1'], jitEnabled: false, attestationMaxAgeHours: 12,
  allowPrivateNetwork: false, issuerPort: null,
});

function refusal(body: unknown): { code: string; details: Record<string, unknown> } {
  try {
    parseSsoDraftInput(body);
  } catch (error) {
    const typed = error as { code: string; details?: Record<string, unknown>; message: string };
    return { code: typed.code, details: typed.details ?? {} };
  }
  throw new Error('expected a refusal');
}

test('a complete valid draft parses; booleans become 0/1 and defaults fill omitted fields', () => {
  const parsed = parseSsoDraftInput({ ...VALID, jitEnabled: true });
  assert.equal(parsed.jitEnabled, 1);
  assert.equal(parsed.allowPrivateNetwork, 0);
  assert.equal(parsed.clearClientSecret, false);
  const minimal = parseSsoDraftInput({ issuer: VALID.issuer, clientId: 'c', clientAuth: 'none' });
  assert.deepEqual([minimal.extraScopes, minimal.hours, minimal.issuerPort, minimal.tenantMode, minimal.roleClaimPath,
    minimal.roleRulesJson, minimal.tenantValuesJson], ['', 12, null, 'none', '', '[]', '[]'], 'an incomplete draft is accepted');
});

const FIELD_CASES: Array<[string, unknown, string]> = [
  ['body: array', [], 'body'],
  ['body: null', null, 'body'],
  ['expectedDraftVersion negative', { ...VALID, expectedDraftVersion: -1 }, 'expectedDraftVersion'],
  ['expectedDraftVersion fractional', { ...VALID, expectedDraftVersion: 1.5 }, 'expectedDraftVersion'],
  ['issuer http', { ...VALID, issuer: 'http://idp.example' }, 'issuer'],
  ['issuer not a string', { ...VALID, issuer: 42 }, 'issuer'],
  ['issuer with userinfo', { ...VALID, issuer: 'https://user:pw@idp.example' }, 'issuer'],
  ['clientId empty', { ...VALID, clientId: '' }, 'clientId'],
  ['clientId control character', { ...VALID, clientId: 'a\nb' }, 'clientId'],
  ['clientId too long', { ...VALID, clientId: 'x'.repeat(257) }, 'clientId'],
  ['clientAuth unknown', { ...VALID, clientAuth: 'private_key_jwt' }, 'clientAuth'],
  ['clientSecret with a public client', { ...VALID, clientSecret: 's3cret' }, 'clientSecret'],
  ['clientSecret too long', { ...VALID, clientAuth: 'client_secret_basic', clientSecret: 's'.repeat(1025) }, 'clientSecret'],
  ['clearClientSecret not boolean', { ...VALID, clearClientSecret: 'yes' }, 'clearClientSecret'],
  ['secret and clear together', { ...VALID, clientAuth: 'client_secret_post', clientSecret: 's', clearClientSecret: true },
    'clearClientSecret'],
  ['extraScopes repeat openid', { ...VALID, extraScopes: 'openid' }, 'extraScopes'],
  ['extraScopes quote character', { ...VALID, extraScopes: 'a"b' }, 'extraScopes'],
  ['hours 0', { ...VALID, attestationMaxAgeHours: 0 }, 'attestationMaxAgeHours'],
  ['hours 25', { ...VALID, attestationMaxAgeHours: 25 }, 'attestationMaxAgeHours'],
  ['hours string', { ...VALID, attestationMaxAgeHours: '12' }, 'attestationMaxAgeHours'],
  ['allowPrivateNetwork string', { ...VALID, allowPrivateNetwork: 'true' }, 'allowPrivateNetwork'],
  ['issuerPort without private network', { ...VALID, issuerPort: 8443 }, 'issuerPort'],
  ['issuerPort out of range', { ...VALID, allowPrivateNetwork: true, issuerPort: 70000 }, 'issuerPort'],
  ['issuerPort fractional', { ...VALID, allowPrivateNetwork: true, issuerPort: 443.5 }, 'issuerPort'],
  ['roleClaimPath not a string', { ...VALID, roleClaimPath: ['roles'] }, 'roleClaimPath'],
  ['roleClaimPath too long', { ...VALID, roleClaimPath: 'a'.repeat(257) }, 'roleClaimPath'],
  ['tenantMode unknown', { ...VALID, tenantMode: 'domain' }, 'tenantMode'],
  ['tenantClaimPath not a string', { ...VALID, tenantClaimPath: 7 }, 'tenantClaimPath'],
  ['roleRules not an array', { ...VALID, roleRules: { value: 'admin' } }, 'roleRules'],
  ['roleRules over 64', { ...VALID, roleRules: Array.from({ length: 65 }, (_, i) => ({ value: `v${i}`, role: 'user' })) },
    'roleRules'],
  ['tenantValues not an array', { ...VALID, tenantValues: 'org-1' }, 'tenantValues'],
  ['jitEnabled string', { ...VALID, jitEnabled: 'false' }, 'jitEnabled'],
];

for (const [label, body, field] of FIELD_CASES) {
  test(`refuses ${label} with field code ${field}`, () => {
    const result = refusal(body);
    assert.equal(result.code, 'sso_draft_invalid');
    assert.equal(result.details.field, field);
    assert.equal(JSON.stringify(result).includes('s3cret'), false, 'a submitted value is never echoed');
  });
}

test('mapping rules (D4/D5) run on the supplied parts: owner role, user-editable path, JIT without tenant', () => {
  assert.equal(refusal({ ...VALID, roleRules: [{ value: 'boss', role: 'owner' }] }).code, 'sso_mapping_invalid');
  assert.equal(refusal({ ...VALID, roleClaimPath: 'preferred_username' }).code, 'sso_mapping_invalid');
  assert.equal(refusal({ ...VALID, roleClaimPath: '__proto__.x' }).code, 'sso_mapping_invalid');
  assert.equal(refusal({ ...VALID, tenantMode: 'none', tenantClaimPath: null, tenantValues: [], jitEnabled: true }).code,
    'sso_mapping_invalid');
  assert.equal(refusal({ ...VALID, tenantClaimPath: 'email', tenantValues: ['a@example.test'], roleClaimPath: 'email' }).code,
    'sso_mapping_invalid', 'email is a tenant path only');
  const incomplete = parseSsoDraftInput({ ...VALID, roleClaimPath: '', roleRules: [], jitEnabled: true });
  assert.equal(incomplete.roleClaimPath, '', 'an empty role path and rule list are accepted as missing');
});

test('I5: step-up exactly when private reach turns on or the explicit port changes (also when cleared)', () => {
  const input = (allowPrivateNetwork: 0 | 1, issuerPort: number | null) => ({ allowPrivateNetwork, issuerPort });
  assert.equal(draftNeedsStepUp(null, input(0, null)), false, 'first public draft');
  assert.equal(draftNeedsStepUp(null, input(1, null)), true, 'first draft with private reach');
  assert.equal(draftNeedsStepUp({ allow_private_network: 1, issuer_port: null }, input(1, null)), false, 'unchanged');
  assert.equal(draftNeedsStepUp({ allow_private_network: 1, issuer_port: null }, input(1, 8443)), true, 'port set');
  assert.equal(draftNeedsStepUp({ allow_private_network: 1, issuer_port: 8443 }, input(1, 8443)), false, 'same port');
  assert.equal(draftNeedsStepUp({ allow_private_network: 1, issuer_port: 8443 }, input(1, null)), true, 'port cleared');
  assert.equal(draftNeedsStepUp({ allow_private_network: 1, issuer_port: null }, input(0, null)), false,
    'turning private reach off needs no step-up');
});
