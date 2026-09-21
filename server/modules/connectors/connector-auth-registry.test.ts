import assert from 'node:assert/strict';
import test from 'node:test';

import { CONNECTOR_CATALOG } from '../../../shared/connector-catalog.js';
import {
  CONNECTOR_AUTH_REGISTRY_FLAG,
  CONNECTOR_AUTH_CATALOG_REVISION,
  isProviderAuthRegistryEnabled,
  isProviderAuthSpecCertified,
  PROVIDER_AUTH_SPECS,
  providerAuthReadiness,
  providerAuthSpecFor,
  validateDcrMetadataForActivation,
} from '../../../shared/connector-auth-registry.js';

import { CERTIFIED_PROBES } from './connector-api-key-probe.js';
import { publicCatalogEntry } from './connectors.routes.js';
import { connectorOAuthScopePlan } from './connector-oauth-engine.js';

test('auth registry covers every catalog service exactly once with a closed method', () => {
  const catalogServices = CONNECTOR_CATALOG.map(({ service }) => service).sort();
  const registryServices = PROVIDER_AUTH_SPECS.flatMap(({ services }) => services).sort();
  assert.equal(CONNECTOR_CATALOG.length, 20, 'catalog cardinality is an intentional contract');
  assert.equal(registryServices.length, 20, 'every catalog entry has one auth mapping');
  assert.equal(PROVIDER_AUTH_SPECS.length, 18, 'Google services share one of 18 profiles');
  assert.deepEqual(registryServices, catalogServices);
  assert.equal(new Set(registryServices).size, registryServices.length);
  assert.equal(catalogServices.filter((service) => providerAuthSpecFor(service) !== null).length, 20);

  const methods = new Set(['dcr_pkce', 'byo_app', 'api_key']);
  for (const spec of PROVIDER_AUTH_SPECS) {
    assert.equal(methods.has(spec.method), true, spec.profileId);
    assert.match(spec.source.officialUrl, /^https:\/\//);
    assert.match(spec.source.verifiedAt, /^\d{4}-\d{2}-\d{2}$/);
    assert.equal(spec.source.catalogRevision, CONNECTOR_AUTH_CATALOG_REVISION);
    assert.ok(spec.allowedOrigins.includes(new URL(spec.expectedIssuer).origin), spec.profileId);
    for (const endpoint of Object.values(spec.endpoints)) {
      assert.ok(spec.allowedOrigins.includes(new URL(endpoint).origin), `${spec.profileId}: ${endpoint}`);
    }
  }
});

test('all exported provider contracts are deeply immutable at runtime', () => {
  const assertDeepFrozen = (value: unknown): void => {
    if (value === null || typeof value !== 'object') return;
    assert.equal(Object.isFrozen(value), true);
    for (const nested of Object.values(value as Record<string, unknown>)) assertDeepFrozen(nested);
  };
  assertDeepFrozen(PROVIDER_AUTH_SPECS);
});

test('pending DCR profiles declare and enforce exact discovery endpoints', () => {
  for (const spec of PROVIDER_AUTH_SPECS) {
    if (spec.method !== 'dcr_pkce') continue;
    assert.equal(spec.certification.status, 'pending');
    assert.ok(spec.minimumScopes.length > 0);
    assert.ok(spec.minimumScopes.every(scope => typeof scope === 'string' && scope.length > 0));
    assert.match(spec.metadataExpectations.revocationEndpoint, /^https:\/\//u);
    assert.deepEqual(connectorOAuthScopePlan(spec.services[0]), [...spec.minimumScopes].sort());
    const expected = spec.metadataExpectations;
    const protectedResource = {
      resource: expected.resource,
      authorization_servers: [expected.authorizationServer],
    };
    const authorizationServer = {
      issuer: expected.issuer,
      authorization_endpoint: expected.authorizationEndpoint,
      token_endpoint: expected.tokenEndpoint,
      registration_endpoint: expected.registrationEndpoint,
      revocation_endpoint: expected.revocationEndpoint,
      scopes_supported: spec.minimumScopes,
      code_challenge_methods_supported: [expected.codeChallengeMethod],
      token_endpoint_auth_methods_supported: [expected.tokenEndpointAuthMethod],
    };
    assert.equal(validateDcrMetadataForActivation(spec, protectedResource, authorizationServer), true);
    assert.equal(validateDcrMetadataForActivation(spec, protectedResource, {
      ...authorizationServer,
      token_endpoint: 'https://attacker.example/token',
    }), false, `${spec.profileId} rejects changed token endpoints`);
    assert.equal(validateDcrMetadataForActivation(spec, {
      ...protectedResource,
      authorization_servers: ['https://attacker.example'],
    }, authorizationServer), false, `${spec.profileId} rejects changed authorization servers`);
  }
});

test('Canva stays suspended until a stable provider identity contract is certified', () => {
  const canva = providerAuthSpecFor('canva');
  assert.ok(canva && canva.method === 'byo_app');
  assert.equal(canva.certification.status, 'suspended');
  assert.deepEqual(canva.identity, {
    method: 'unavailable', reason: 'provider_identity_contract_not_certified',
  });
  assert.equal(isProviderAuthSpecCertified(canva, {
    [canva.certification.featureFlag]: '1',
  }), false, 'an operator flag cannot override the suspended identity contract');
});

test('unknown service is rejected rather than producing URLs from user input', () => {
  assert.equal(providerAuthSpecFor(''), null);
  assert.equal(providerAuthSpecFor('unknown'), null);
  assert.equal(providerAuthSpecFor('https://attacker.example/oauth'), null);
  assert.equal(providerAuthSpecFor('../notion'), null);
});

test('global registry and every provider certification are off by default', () => {
  const emptyEnv = {};
  assert.equal(isProviderAuthRegistryEnabled(emptyEnv), false);
  for (const spec of PROVIDER_AUTH_SPECS) {
    assert.equal(isProviderAuthSpecCertified(spec, emptyEnv), false, spec.profileId);
    assert.equal(providerAuthReadiness(spec, emptyEnv), 'unsupported', spec.profileId);
  }

  const github = providerAuthSpecFor('github');
  assert.ok(github);
  const enabled = {
    [CONNECTOR_AUTH_REGISTRY_FLAG]: '1',
    [github.certification.featureFlag]: '1',
  };
  assert.equal(providerAuthReadiness(github, enabled), 'ready');

  const notion = providerAuthSpecFor('notion');
  assert.ok(notion);
  assert.equal(notion.certification.status, 'pending');
  assert.equal(providerAuthReadiness(notion, {
    [CONNECTOR_AUTH_REGISTRY_FLAG]: '1',
    [notion.certification.featureFlag]: '1',
  }), 'unsupported', 'a flag cannot bypass a pending provider certificate');

  const certifiedDcr = { ...notion, certification: { ...notion.certification, status: 'certified' as const } };
  const dcrEnv = {
    [CONNECTOR_AUTH_REGISTRY_FLAG]: '1',
    [notion.certification.featureFlag]: '1',
  };
  assert.equal(providerAuthReadiness(certifiedDcr, dcrEnv), 'owner_setup_required');
  assert.equal(providerAuthReadiness(certifiedDcr, dcrEnv, true), 'ready');
});

test('API-key readiness certification exactly matches implemented probes', () => {
  const apiSpecs = PROVIDER_AUTH_SPECS.filter(spec => spec.method === 'api_key');
  const registryCertified = apiSpecs
    .filter(spec => spec.serviceProbe.status === 'certified')
    .map(spec => spec.profileId)
    .sort();
  assert.deepEqual(registryCertified, Object.keys(CERTIFIED_PROBES).sort());
  assert.deepEqual(registryCertified, ['figma', 'github', 'slack', 'stripe', 'wafeq']);
  const pending = apiSpecs.filter(spec => spec.serviceProbe.status === 'pending');
  assert.deepEqual(pending.map(spec => spec.profileId).sort(), [
    'geidea', 'getyourguide', 'infomaniak-contacts', 'infomaniak-mail',
    'salla', 'tamara', 'viator',
  ]);
  for (const spec of pending) {
    assert.ok(spec.serviceProbe.reason, spec.profileId);
    assert.equal(spec.serviceProbe.endpoint, undefined, spec.profileId);
    assert.equal(spec.serviceProbe.credentialHeader, undefined, spec.profileId);
  }
  const salla = pending.find(spec => spec.profileId === 'salla');
  assert.deepEqual(salla?.serviceProbe.verificationContract, {
    endpoint: 'https://api.salla.dev/admin/v2/oauth2/user/info',
    method: 'GET',
    credentialHeader: 'authorization',
    credentialPrefix: 'Bearer ',
    identitySemantics: ['user', 'store'],
  });
  assert.equal(salla?.serviceProbe.status, 'pending');
  assert.deepEqual(
    pending.filter(spec => spec.profileId !== 'salla')
      .map(spec => spec.serviceProbe.verificationContract),
    Array.from({ length: pending.length - 1 }, () => undefined),
  );
});

test('Google services share one BYO app profile and expose grouping metadata only', () => {
  const calendar = providerAuthSpecFor('google-calendar');
  const drive = providerAuthSpecFor('google-drive');
  const gmail = providerAuthSpecFor('gmail');
  assert.ok(calendar);
  assert.equal(calendar, drive);
  assert.equal(calendar, gmail);
  assert.equal(calendar.method, 'byo_app');
  assert.equal(calendar.services.length, 3, 'three Google services map to one profile');
  assert.deepEqual(calendar.services, ['google-calendar', 'google-drive', 'gmail']);
  assert.deepEqual(calendar.accountBundle, {
    id: 'google-workspace',
    label: 'Google Workspace',
    sharedApplicationIdentity: true,
    sharedAccountIdentity: true,
    scopeGrantPolicy: 'per_service_incremental',
  });
});

test('public auth metadata is allowlisted and leaks no trusted endpoint or operator flag', () => {
  const forbiddenKeys = new Set([
    'endpoints', 'expectedIssuer', 'allowedOrigins', 'source', 'certification', 'featureFlag',
  ]);
  for (const trusted of CONNECTOR_CATALOG) {
    const dto = publicCatalogEntry(trusted);
    const auth = dto.authMetadata as unknown as Record<string, unknown>;
    assert.deepEqual(
      Object.keys(auth).sort(),
      trusted.service.startsWith('google-') || trusted.service === 'gmail'
        ? ['accountBundle', 'canStartOAuth', 'canStoreUnverified', 'canSubmitCredential',
          'credentialInputSchema', 'method', 'profileId', 'readiness', 'submitSemantics']
        : ['canStartOAuth', 'canStoreUnverified', 'canSubmitCredential',
          'credentialInputSchema', 'method', 'profileId', 'readiness', 'submitSemantics'],
    );
    for (const key of Object.keys(auth)) assert.equal(forbiddenKeys.has(key), false);
    const rendered = JSON.stringify(auth);
    assert.equal(rendered.includes('https://'), false);
    assert.equal(rendered.includes('NASSAJ_'), false);
  }
});
