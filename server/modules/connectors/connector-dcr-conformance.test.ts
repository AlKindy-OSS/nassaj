import assert from 'node:assert/strict';
import test from 'node:test';

import {
  PROVIDER_AUTH_SPECS,
  validateDcrMetadataForActivation,
  type DcrPkceSpec,
} from '../../../shared/connector-auth-registry.js';

import { connectorDcrRegistrationRequest } from './connector-auth-profile-management.js';
import { connectorOAuthScopePlan } from './connector-oauth-engine.js';

const DCR = PROVIDER_AUTH_SPECS.filter(
  (spec): spec is DcrPkceSpec => spec.method === 'dcr_pkce',
);

const EXPECTED_SCOPES: Readonly<Record<string, readonly string[]>> = Object.freeze({
  notion: ['default'],
  sentry: ['org:read'],
  linear: ['read'],
  atlassian: ['read:jira-work'],
});

test('all DCR providers match exact metadata and least-privilege scope contracts', () => {
  assert.deepEqual(DCR.map(spec => spec.profileId).sort(), Object.keys(EXPECTED_SCOPES).sort());
  for (const spec of DCR) {
    const resource = {
      resource: spec.metadataExpectations.resource,
      authorization_servers: [spec.metadataExpectations.authorizationServer],
    };
    const authorization = {
      issuer: spec.metadataExpectations.issuer,
      authorization_endpoint: spec.metadataExpectations.authorizationEndpoint,
      token_endpoint: spec.metadataExpectations.tokenEndpoint,
      registration_endpoint: spec.metadataExpectations.registrationEndpoint,
      revocation_endpoint: spec.metadataExpectations.revocationEndpoint,
      scopes_supported: spec.minimumScopes,
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
    };
    assert.equal(validateDcrMetadataForActivation(spec, resource, authorization), true, spec.profileId);
    assert.equal(validateDcrMetadataForActivation(spec, resource, {
      ...authorization,
      registration_endpoint: `${authorization.registration_endpoint}/changed`,
    }), false, `${spec.profileId} registration endpoint drift`);
    assert.equal(validateDcrMetadataForActivation(spec, resource, {
      ...authorization,
      revocation_endpoint: `${authorization.revocation_endpoint}/changed`,
    }), false, `${spec.profileId} revocation endpoint drift`);
    assert.equal(validateDcrMetadataForActivation(spec, resource, {
      ...authorization,
      scopes_supported: ['unexpected'],
    }), false, `${spec.profileId} scope drift`);
    assert.deepEqual(spec.minimumScopes, EXPECTED_SCOPES[spec.profileId], spec.profileId);
    assert.deepEqual(connectorOAuthScopePlan(spec.services[0]), EXPECTED_SCOPES[spec.profileId], spec.profileId);
    assert.equal(spec.certification.status, 'pending', spec.profileId);
    assert.equal(spec.certification.reason, 'dcr_live_registration_contract_unverified', spec.profileId);
  }
});

test('Notion OAuth consent can request only the documented default scope', () => {
  assert.deepEqual(connectorOAuthScopePlan('notion'), ['default']);
  assert.deepEqual(connectorOAuthScopePlan('notion', ['default']), ['default']);
  assert.deepEqual(connectorOAuthScopePlan('notion', ['openid', 'unexpected']), ['default']);
});

test('production DCR registration request is exact and cannot ask for broader grants', () => {
  const callbackUrl = 'https://nassaj.example/connectors/oauth/callback';
  assert.deepEqual(connectorDcrRegistrationRequest(callbackUrl), {
    client_name: 'Nassaj',
    redirect_uris: [callbackUrl],
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
  });
});
