/**
 * T-1962 S7 — pure view model of the SSO tab: header states, banners, step
 * locking, step-up need, and the D4/D5 client-side checks.
 *
 * Run: NODE_ENV=test npx vitest run src/components/settings/view/tabs/sso-settings/ssoModel.test.ts
 */
import { describe, expect, it } from 'vitest';

import arSettings from '../../../../../i18n/locales/ar/settings.json';
import enSettings from '../../../../../i18n/locales/en/settings.json';

import { activeStatus, configView, readyToApply, statusFixture } from './__fixtures__/ssoStatus';
import { draftBody } from './ssoApi';
import { ssoMessageFor } from './ssoMessages';
import {
  bannersOf,
  canDisable,
  claimPathUserEditable,
  defaultOpenStep,
  draftNeedsStepUp,
  EMPTY_FORM,
  extraScopesValid,
  formFrom,
  headerStateOf,
  invalidEmailLines,
  isEmailTenantPath,
  roleCollisionRisk,
  stepsOf,
  unavailableFaultOf,
} from './ssoModel';

describe('headerStateOf (brief §4.1)', () => {
  it.each([
    ['fresh install', statusFixture(), 'off'],
    ['owner disabled', statusFixture({ disabledRecord: true, active: configView({ slot: 'active' }) }), 'offByOwner'],
    ['active', activeStatus(), 'active'],
    ['unavailable', statusFixture({ ssoState: 'unavailable' }), 'unavailable'],
    ['paused', statusFixture({ ssoState: 'paused', legacyEnvPresent: true }), 'paused'],
    ['host force-off wins', activeStatus({ hostDisabled: true, ssoState: 'off' }), 'hostDisabled'],
    ['applied, not enabled', statusFixture({ active: configView({ slot: 'active', enabled: false }) }), 'readyNotOn'],
  ] as const)('%s → %s', (_label, status, expected) => {
    expect(headerStateOf(status)).toBe(expected);
  });

  it('hides "Disable SSO" only where there is nothing to disable', () => {
    expect(canDisable('off')).toBe(false);
    expect(canDisable('offByOwner')).toBe(false);
    expect(canDisable('hostDisabled')).toBe(false);
    expect(canDisable('active')).toBe(true);
    expect(canDisable('unavailable')).toBe(true);
    expect(canDisable('paused')).toBe(true);
  });
});

describe('bannersOf (brief §4.2)', () => {
  it('shows the endpoint-changed danger banner for that runtime fault', () => {
    const status = activeStatus({ ssoState: 'unavailable', active: configView({ slot: 'active', runtimeFault: 'discovery_endpoint_changed' }) });
    expect(unavailableFaultOf(status)).toBe('endpointChanged');
    expect(bannersOf(status)).toEqual(['endpointChanged']);
  });

  it('reports linked members with no saved settings', () => {
    const status = statusFixture({ ssoState: 'unavailable', identityCountsByIssuer: [{ issuer: 'https://old/', linkedUsers: 2 }] });
    expect(bannersOf(status)).toEqual(['linksNoConfig']);
  });

  it('orders host force-off first and adds origin mismatch and paused import', () => {
    expect(bannersOf(statusFixture({ hostDisabled: true }))).toEqual(['hostDisabled']);
    expect(bannersOf(statusFixture({ ssoState: 'paused' }))).toEqual(['paused']);
    expect(bannersOf(activeStatus({ redirectOriginStatus: 'redirect_origin_mismatch' }))).toEqual(['originMismatch']);
  });

  it('warns while active when the provider has no back-channel logout', () => {
    const status = activeStatus({ active: configView({ slot: 'active', enabled: true, discoveryFlags: { backchannel_logout_supported: false } }) });
    expect(bannersOf(status)).toContain('noBackchannel');
  });
});

describe('stepsOf (brief §2 step table)', () => {
  it('locks steps 1–7 behind step 0 until the origin is confirmed', () => {
    const steps = stepsOf(statusFixture({ ourValues: { ...statusFixture().ourValues, origin: null, originConfirmed: false } }), false);
    expect(steps[0].lockedBy).toBeNull();
    expect(steps.slice(1).every((step) => step.lockedBy === 0)).toBe(true);
    expect(defaultOpenStep(steps)).toBe(0);
  });

  it('keeps the mapping steps behind step 2 until a draft is saved', () => {
    const steps = stepsOf(statusFixture(), false);
    expect(steps[2].lockedBy).toBeNull();
    expect(steps[3].lockedBy).toBe(2);
    expect(steps[6].lockedBy).toBe(2);
    expect(defaultOpenStep(steps)).toBe(1);
  });

  it('unlocks steps 3–7 once a draft with roles exists, and marks stale proofs for re-checking', () => {
    const stale = { passed: true, current: false, shapeFlags: null, createdAt: Date.now() };
    const steps = stepsOf(statusFixture({ draft: configView(), lastProofs: { discovery: stale, signIn: stale } }), false);
    expect(steps.slice(3).every((step) => step.lockedBy === null)).toBe(true);
    expect(steps[2]).toMatchObject({ done: false, recheck: true });
    expect(steps[6]).toMatchObject({ done: false, recheck: true });
  });

  it('marks steps 6 and 7 ready when both proofs are current', () => {
    const steps = stepsOf(readyToApply(), false);
    expect(steps[2].done).toBe(true);
    expect(steps[6].done).toBe(true);
    expect(steps[7].done).toBe(false);
    expect(defaultOpenStep(steps)).toBe(7);
  });

  it('locks every step but 0 with the import reason while paused before import', () => {
    const steps = stepsOf(statusFixture({ ssoState: 'paused' }), false);
    expect(steps.slice(1).every((step) => step.lockedReason === 'import')).toBe(true);
  });
});

describe('form ↔ API', () => {
  it('needs step-up for turning private network on or changing the port (I5)', () => {
    const saved = configView();
    expect(draftNeedsStepUp(saved, formFrom(saved))).toBe(false);
    expect(draftNeedsStepUp(saved, { ...formFrom(saved), allowPrivateNetwork: true })).toBe(true);
    const privateSaved = configView({ allowPrivateNetwork: true, issuerPort: 8443 });
    expect(draftNeedsStepUp(privateSaved, formFrom(privateSaved))).toBe(false);
    expect(draftNeedsStepUp(privateSaved, { ...formFrom(privateSaved), issuerPort: '' })).toBe(true);
  });

  it('sends the secret only when typed and drops tenant values without a restriction', () => {
    const body = draftBody({ ...EMPTY_FORM, issuer: ' https://idp/ ', clientId: 'c', clientAuth: 'client_secret_basic', tenantValuesText: 'a\nb' });
    expect(body).toMatchObject({ issuer: 'https://idp/', tenantValues: [], jitEnabled: false, issuerPort: null });
    expect(body).not.toHaveProperty('clientSecret');
    expect(draftBody({ ...EMPTY_FORM, clientAuth: 'client_secret_post', clientSecret: 's3' })).toHaveProperty('clientSecret', 's3');
    expect(draftBody({ ...EMPTY_FORM, clientAuth: 'none', clientSecret: 's3' })).not.toHaveProperty('clientSecret');
  });
});

describe('D4/D5 client checks', () => {
  it('refuses user-editable claims as role paths, and email except as a lone tenant path (I9)', () => {
    expect(claimPathUserEditable('preferred_username', 'role')).toBe(true);
    expect(claimPathUserEditable('name.first', 'tenant')).toBe(true);
    expect(claimPathUserEditable('["nickname"]', 'role')).toBe(true);
    expect(claimPathUserEditable('email', 'role')).toBe(true);
    expect(claimPathUserEditable('email', 'tenant')).toBe(false);
    expect(claimPathUserEditable('email.domain', 'tenant')).toBe(true);
    expect(claimPathUserEditable('realm_access.roles', 'role')).toBe(false);
  });

  it('treats an email tenant path as an exact per-person list (N6)', () => {
    const form = { ...EMPTY_FORM, tenantMode: 'claim' as const, tenantClaimPath: 'email' };
    expect(isEmailTenantPath(form)).toBe(true);
    expect(invalidEmailLines('a@example.com\nexample.com\n@example.com\n*@example.com')).toEqual([
      'example.com', '@example.com', '*@example.com',
    ]);
  });

  it('warns on generic role words on a broad claim', () => {
    expect(roleCollisionRisk({ ...EMPTY_FORM, roleClaimPath: 'groups', roleRules: [{ value: 'Admin', role: 'admin' }] })).toBe(true);
    expect(roleCollisionRisk({ ...EMPTY_FORM, roleClaimPath: 'groups', roleRules: [{ value: 'nassaj-admin', role: 'admin' }] })).toBe(false);
  });

  it('follows the server extra-scope grammar', () => {
    expect(extraScopesValid('')).toBe(true);
    expect(extraScopesValid('groups offline_access')).toBe(true);
    expect(extraScopesValid('openid')).toBe(false);
    expect(extraScopesValid('a a')).toBe(false);
  });
});

describe('error-code mapping (brief §7.3)', () => {
  const lookup = (tree: unknown, key: string) => key.split('.').reduce<unknown>(
    (node, part) => (node && typeof node === 'object' ? (node as Record<string, unknown>)[part] : undefined), tree);

  it.each([
    'fetch_dns_failed', 'fetch_address_private', 'fetch_address_blocked', 'fetch_http_4xx', 'fetch_http_3xx',
    'fetch_http_1xx', 'fetch_http_other', 'fetch_not_json', 'fetch_too_large', 'fetch_connect_failed',
    'fetch_request_invalid', 'discovery_unavailable', 'jwks_unavailable', 'invalid_jwks',
    'discovery_issuer_mismatch', 'discovery_endpoint_invalid', 'discovery_code_flow_unsupported',
    'discovery_signing_alg_unsupported', 'discovery_client_auth_unsupported', 'discovery_pkce_s256_unsupported',
    'jwks_no_usable_key', 'discovery_pkce_methods_unadvertised', 'roles_claim_absent', 'no_recognized_role',
    'org_not_allowed', 'sso_apply_proof_missing', 'sso_keep_confirmation_required', 'step_up_failed',
  ])('%s has its own sentence in en and ar', (code) => {
    const message = ssoMessageFor(code);
    expect(message.known).toBe(true);
    expect(typeof lookup(enSettings, message.key)).toBe('string');
    expect(typeof lookup(arSettings, message.key)).toBe('string');
  });

  it('maps mapping reasons and draft fields through their details', () => {
    expect(ssoMessageFor('sso_mapping_invalid', { reason: 'claim_path_user_editable' }).key).toBe('sso.diag.mapping.claim_path_user_editable');
    expect(ssoMessageFor('sso_mapping_invalid', { reason: 'brand_new' }).key).toBe('sso.diag.mapping.generic');
    expect(ssoMessageFor('sso_draft_invalid', { field: 'issuer' }).key).toBe('sso.diag.field.issuer');
  });

  it('falls back to a generic sentence carrying the raw code for unknown codes', () => {
    expect(ssoMessageFor('fetch_brand_new_failure')).toEqual({
      key: 'sso.diag.unknown', params: { code: 'fetch_brand_new_failure' }, known: false,
    });
    expect(lookup(enSettings, 'sso.diag.unknown')).toContain('{{code}}');
    expect(lookup(arSettings, 'sso.diag.unknown')).toContain('{{code}}');
  });

  it('every sso.* key exists in both languages', () => {
    const keys = (tree: Record<string, unknown>, prefix = ''): string[] => Object.entries(tree).flatMap(([key, value]) =>
      value && typeof value === 'object' ? keys(value as Record<string, unknown>, `${prefix}${key}.`)
        : [`${prefix}${key}`.replace(/_(one|other)$/, '')]);
    const en = new Set(keys(enSettings.sso as Record<string, unknown>));
    const ar = new Set(keys(arSettings.sso as Record<string, unknown>));
    expect([...en].filter((key) => !ar.has(key))).toEqual([]);
    expect([...ar].filter((key) => !en.has(key))).toEqual([]);
  });

  it('never names a specific identity provider in the copy', () => {
    const copy = JSON.stringify([enSettings.sso, arSettings.sso]);
    expect(copy).not.toMatch(/keycloak|okta|auth0|azure ad|google workspace/i);
  });
});
