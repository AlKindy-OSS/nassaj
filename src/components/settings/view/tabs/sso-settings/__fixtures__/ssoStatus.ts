/**
 * Test fixtures for the SSO tab, shaped like server/services/sso-settings-status.js
 * output. Test-only module (imported from *.test.ts(x) files).
 */
import type { SsoConfigView, SsoStatus } from '../ssoTypes';

export function configView(overrides: Partial<SsoConfigView> = {}): SsoConfigView {
  return {
    slot: 'draft', enabled: false, issuer: 'https://idp.example.com/', clientId: 'nassaj-app',
    clientAuth: 'none', hasClientSecret: false, extraScopes: '', redirectUri: 'https://nassaj.example.com/api/auth/oidc/callback',
    roleClaimPath: 'roles', roleRules: [{ value: 'nassaj-admin', role: 'admin' }], tenantMode: 'none',
    tenantClaimPath: null, tenantValues: [], jitEnabled: false, attestationMaxAgeHours: 12,
    allowPrivateNetwork: false, issuerPort: null, pinnedEndpoints: null, discoveryFlags: null, runtimeFault: null,
    configHash: 'a'.repeat(64), draftVersion: 3, version: 0, updatedAt: 1_759_400_000_000, missing: [],
    ...overrides,
  };
}

export function statusFixture(overrides: Partial<SsoStatus> = {}): SsoStatus {
  return {
    ssoState: 'off', hostDisabled: false, disabledRecord: false, legacyEnvPresent: false,
    active: null, draft: null, redirectOriginStatus: null,
    ourValues: {
      origin: 'https://nassaj.example.com', originConfirmed: true,
      redirectUri: 'https://nassaj.example.com/api/auth/oidc/callback',
      backchannelLogoutUri: 'https://nassaj.example.com/api/auth/oidc/backchannel-logout',
      scopes: 'openid profile email',
    },
    lastProofs: { discovery: null, signIn: null },
    ignoredEnv: [], identityCountsByIssuer: [], applyImpact: null,
    ...overrides,
  };
}

const passed = { passed: true, current: true, shapeFlags: null, createdAt: Date.now() };

/** A draft with both apply proofs passing for its current version. */
export function readyToApply(overrides: Partial<SsoStatus> = {}): SsoStatus {
  return statusFixture({
    draft: configView(),
    lastProofs: { discovery: passed, signIn: { ...passed, shapeFlags: { authTimePresent: true, authTimeFresh: true } } },
    applyImpact: {
      issuerChanged: false, mappingChanged: true, reattestRequired: 0, orphaned: 0, jitForcedOff: false, policyEnforcedNow: false,
    },
    ...overrides,
  });
}

/** Live and enabled. */
export function activeStatus(overrides: Partial<SsoStatus> = {}): SsoStatus {
  const active = configView({ slot: 'active', enabled: true, version: 2, discoveryFlags: { backchannel_logout_supported: true } });
  return statusFixture({
    ssoState: 'active', active, draft: configView(), redirectOriginStatus: 'ok',
    identityCountsByIssuer: [{ issuer: 'https://idp.example.com/', linkedUsers: 4 }],
    ...overrides,
  });
}
