import assert from 'node:assert/strict';
import test from 'node:test';

import {
  PROVIDER_AUTH_SPECS,
  providerAuthSpecFor,
  type ApiKeySpec,
} from '../../../shared/connector-auth-registry.js';

import {
  connectorAuthServiceCapability,
  credentialContractMatchesAuthSpec,
  projectApiKeyServiceCapability,
} from './connector-auth-public-capabilities.js';
import {
  connectorCredentialContractFor,
  type ConnectorCredentialContract,
} from './connector-credential-contracts.js';

const apiEnv = (serviceId: string, profileId = serviceId) => ({
  NASSAJ_CONNECTOR_AUTH_REGISTRY_V1: '1',
  NASSAJ_CONNECTOR_GRANTS_V2: '1',
  [`NASSAJ_CONNECTOR_AUTH_CERT_${profileId.toUpperCase().replace(/-/gu, '_')}`]: '1',
  [`NASSAJ_CONNECTOR_GRANT_CERT_${serviceId.toUpperCase().replace(/-/gu, '_')}`]: '1',
});

test('every OSS provider service projects one registry-owned secret-free capability', () => {
  const serviceIds = PROVIDER_AUTH_SPECS.flatMap(spec => spec.services);
  assert.equal(new Set(serviceIds).size, serviceIds.length);
  for (const serviceId of serviceIds) {
    const capability = connectorAuthServiceCapability(serviceId, {});
    assert.ok(capability, serviceId);
    assert.equal(capability.serviceId, serviceId);
    assert.equal(capability.canSubmitCredential, false);
    assert.equal(capability.canStartOAuth, false);
    assert.equal(capability.canStoreUnverified, false);
    const rendered = JSON.stringify(capability);
    for (const forbidden of ['NASSAJ_', 'https://', 'credentialHeader', 'secretRef', 'value']) {
      assert.equal(rendered.includes(forbidden), false, `${serviceId}:${forbidden}`);
    }
  }
  assert.equal(connectorAuthServiceCapability('user-invented-provider', {}), null);
});

test('certified single API key uses scalar payload and verify-before-activation semantics', () => {
  const github = connectorAuthServiceCapability('github', apiEnv('github'))!;
  assert.equal(github.canSubmitCredential, true);
  assert.equal(github.canStoreUnverified, false);
  assert.deepEqual(github.credentialInputSchema, {
    schemaVersion: 1,
    shape: 'single_api_key',
    fields: [{ id: 'api_key', label: 'API key', inputType: 'password', required: true }],
  });
  assert.deepEqual(github.submitSemantics, {
    operation: 'put_personal_api_key',
    credentialPayload: 'apiKey',
    activation: 'after_verification',
    requiresExplicitUnverifiedConsent: false,
    unverifiedConsentPayload: 'none',
  });
});

test('API capability fails closed when each required flag is independently absent', () => {
  const env = apiEnv('github');
  for (const flag of [
    'NASSAJ_CONNECTOR_AUTH_REGISTRY_V1',
    'NASSAJ_CONNECTOR_AUTH_CERT_GITHUB',
    'NASSAJ_CONNECTOR_GRANTS_V2',
    'NASSAJ_CONNECTOR_GRANT_CERT_GITHUB',
  ]) {
    const withoutFlag = { ...env };
    delete withoutFlag[flag as keyof typeof withoutFlag];
    const capability = connectorAuthServiceCapability('github', withoutFlag)!;
    assert.equal(capability.canSubmitCredential, false, flag);
    assert.equal(capability.submitSemantics.operation, 'none', flag);
  }
});

test('credential projection guard rejects probe status and identity semantics drift', () => {
  const github = connectorCredentialContractFor('github')!;
  const githubSpec = providerAuthSpecFor('github') as ApiKeySpec;
  const statusDrift = {
    ...github,
    verification: { ...github.verification, status: 'pending' },
  } as ConnectorCredentialContract;
  assert.equal(credentialContractMatchesAuthSpec(statusDrift, githubSpec), false);
  const statusCapability = projectApiKeyServiceCapability(
    'github', githubSpec, statusDrift, true, apiEnv('github'),
  );
  assert.equal(statusCapability.canSubmitCredential, false);
  assert.equal(statusCapability.credentialInputSchema, null);

  const salla = connectorCredentialContractFor('salla')!;
  const sallaSpec = providerAuthSpecFor('salla') as ApiKeySpec;
  const semanticsDrift = {
    ...salla,
    verification: { ...salla.verification, identityKinds: ['account'] },
  } as ConnectorCredentialContract;
  assert.equal(credentialContractMatchesAuthSpec(semanticsDrift, sallaSpec), false);
  const semanticsCapability = projectApiKeyServiceCapability(
    'salla', sallaSpec, semanticsDrift, true, apiEnv('salla'),
  );
  assert.equal(semanticsCapability.canSubmitCredential, false);
  assert.equal(semanticsCapability.credentialInputSchema, null);
  assert.equal(credentialContractMatchesAuthSpec(salla, sallaSpec), true);
});

test('pending API and Geidea compound contracts expose store-only semantics from the allowlist', () => {
  const salla = connectorAuthServiceCapability('salla', apiEnv('salla'))!;
  assert.equal(salla.canSubmitCredential, true);
  assert.equal(salla.canStoreUnverified, true);
  assert.equal(salla.submitSemantics.activation, 'stored_inert');

  const geidea = connectorAuthServiceCapability('geidea', apiEnv('geidea'))!;
  assert.equal(geidea.canStoreUnverified, true);
  assert.deepEqual(geidea.credentialInputSchema, {
    schemaVersion: 1,
    shape: 'geidea_basic',
    fields: [
      { id: 'merchant_public_key', label: 'Merchant public key', inputType: 'text', required: true },
      { id: 'api_password', label: 'API password', inputType: 'password', required: true },
    ],
  });
  assert.equal(geidea.submitSemantics.credentialPayload, 'credentialFields');
  assert.equal(geidea.submitSemantics.requiresExplicitUnverifiedConsent, true);
  assert.equal(geidea.submitSemantics.unverifiedConsentPayload, 'acceptStoredUnverified');
});

test('OAuth and unsupported providers fail closed under their exact flags', () => {
  const googleEnv = {
    NASSAJ_CONNECTOR_AUTH_REGISTRY_V1: '1',
    NASSAJ_CONNECTOR_AUTH_CERT_GOOGLE_WORKSPACE: '1',
    NASSAJ_CONNECTOR_GRANTS_V2: '1',
    NASSAJ_CONNECTOR_CREDENTIAL_RUNTIME_V2: '1',
    NASSAJ_CONNECTOR_CREDENTIAL_SERVICE_GOOGLE_DRIVE: '1',
    NASSAJ_CONNECTOR_OAUTH_V2: '1',
    NASSAJ_CONNECTOR_OAUTH_CERT_GOOGLE_WORKSPACE: '1',
  };
  const google = connectorAuthServiceCapability('google-drive', googleEnv)!;
  assert.equal(google.canStartOAuth, true);
  assert.equal(google.credentialInputSchema, null);
  assert.deepEqual(google.submitSemantics, {
    operation: 'start_oauth', credentialPayload: 'none',
    activation: 'after_callback_verification', requiresExplicitUnverifiedConsent: false,
    unverifiedConsentPayload: 'none',
  });
  for (const flag of [
    'NASSAJ_CONNECTOR_AUTH_REGISTRY_V1',
    'NASSAJ_CONNECTOR_AUTH_CERT_GOOGLE_WORKSPACE',
    'NASSAJ_CONNECTOR_GRANTS_V2',
    'NASSAJ_CONNECTOR_CREDENTIAL_RUNTIME_V2',
    'NASSAJ_CONNECTOR_CREDENTIAL_SERVICE_GOOGLE_DRIVE',
    'NASSAJ_CONNECTOR_OAUTH_V2',
    'NASSAJ_CONNECTOR_OAUTH_CERT_GOOGLE_WORKSPACE',
  ]) {
    const withoutFlag = { ...googleEnv };
    delete withoutFlag[flag as keyof typeof withoutFlag];
    const capability = connectorAuthServiceCapability('google-drive', withoutFlag)!;
    assert.equal(capability.canStartOAuth, false, flag);
    assert.equal(capability.submitSemantics.operation, 'none', flag);
  }
  assert.equal(connectorAuthServiceCapability('notion', {
    ...googleEnv, NASSAJ_CONNECTOR_AUTH_CERT_NOTION: '1',
    NASSAJ_CONNECTOR_OAUTH_CERT_NOTION: '1',
    NASSAJ_CONNECTOR_CREDENTIAL_SERVICE_NOTION: '1',
  })!.canStartOAuth, false, 'pending certification cannot be overridden by environment drift');
});
