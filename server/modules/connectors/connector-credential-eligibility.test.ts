import assert from 'node:assert/strict';
import test from 'node:test';

import {
  evaluateConnectorCredentialEligibility,
  type ConnectorCredentialEligibilitySnapshot,
} from './connector-credential-eligibility.js';

const eligible = (): ConnectorCredentialEligibilitySnapshot => ({
  materialGeneration: 'm2',
  installationId: 'install', userId: 7, providerId: 'github', serviceId: 'github',
  grantId: 'grant', grantStatus: 'active', bundleId: 'bundle', bundleRevision: 1,
  secretRevision: 1, shapeRevision: 1, contractRevision: 1,
  expectedShapeRevision: 1, expectedContractRevision: 1,
  catalogRevision: 'catalog-1', expectedCatalogRevision: 'catalog-1',
  profileStatus: 'ready', profileVersion: 3, boundProfileVersion: 3,
  providerSubjectHmacMatches: true, revoked: false,
  verificationState: 'verified', operationalState: 'eligible',
  verificationExpiresAt: '2030-01-01 00:00:00', credentialExpiresAt: null,
  now: '2026-08-26 00:00:00', identityBound: true, bundleComplete: true,
  ownership: 'personal', registryEnabled: true, grantsEnabled: true, runtimeEnabled: true,
  providerCertified: true, providerEnabled: true, serviceEnabled: true,
});

test('central eligibility accepts only the complete verified active personal state', () => {
  assert.deepEqual(evaluateConnectorCredentialEligibility(eligible()), { eligible: true });
});

test('every negative state fails closed', () => {
  const cases: readonly [string, Partial<ConnectorCredentialEligibilitySnapshot>, string][] = [
    ['pending grant', { grantStatus: 'pending' }, 'grant_inactive'],
    ['team ownership', { ownership: 'team' }, 'ownership_invalid'],
    ['global flag', { registryEnabled: false }, 'policy_disabled'],
    ['grant flag', { grantsEnabled: false }, 'policy_disabled'],
    ['runtime flag', { runtimeEnabled: false }, 'policy_disabled'],
    ['provider flag', { providerEnabled: false }, 'policy_disabled'],
    ['service flag', { serviceEnabled: false }, 'policy_disabled'],
    ['certification', { providerCertified: false }, 'provider_uncertified'],
    ['profile disabled', { profileStatus: 'disabled' }, 'profile_inactive'],
    ['catalog drift', { catalogRevision: 'old' }, 'revision_mismatch'],
    ['shape drift', { shapeRevision: 2 }, 'revision_mismatch'],
    ['contract drift', { contractRevision: 2 }, 'revision_mismatch'],
    ['profile drift', { boundProfileVersion: 2 }, 'revision_mismatch'],
    ['subject drift', { providerSubjectHmacMatches: false }, 'subject_identity_mismatch'],
    ['revoked', { revoked: true }, 'revoked'],
    ['missing bundle', { bundleId: null }, 'bundle_absent'],
    ['identity', { identityBound: false }, 'identity_mismatch'],
    ['partial bundle', { bundleComplete: false }, 'bundle_incomplete'],
    ['mixed revision', { secretRevision: null }, 'revision_invalid'],
    ['unverified', { verificationState: 'stored_unverified' }, 'not_verified'],
    ['stale', { verificationState: 'stale' }, 'not_verified'],
    ['rejected', { verificationState: 'rejected' }, 'not_verified'],
    ['corrupt', { verificationState: 'corrupt' }, 'not_verified'],
    ['expired evidence', { verificationExpiresAt: '2026-08-25 00:00:00' }, 'verification_expired'],
    ['expired credential', { credentialExpiresAt: '2026-08-25 00:00:00' }, 'credential_expired'],
    ['disabled', { operationalState: 'disabled' }, 'operationally_inactive'],
    ['revoking', { operationalState: 'revoking' }, 'operationally_inactive'],
  ];
  for (const [label, mutation, reason] of cases) {
    assert.deepEqual(
      evaluateConnectorCredentialEligibility({ ...eligible(), ...mutation }),
      { eligible: false, reason }, label,
    );
  }
});
