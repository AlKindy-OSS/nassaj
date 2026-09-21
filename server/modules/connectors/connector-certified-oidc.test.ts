import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';

import jwt from 'jsonwebtoken';

import { providerAuthSpecFor, type ByoAppSpec } from '../../../shared/connector-auth-registry.js';

import { createCertifiedConnectorOidcVerifier } from './connector-certified-oidc.js';

const google = providerAuthSpecFor('google-drive') as ByoAppSpec & {
  identity: { method: 'oidc'; discoveryEndpoint: string; jwksUri: string };
};

test('Google production contract accepts only its exact certified cross-origin OIDC tuple', async () => {
  const pair = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = {
    ...(pair.publicKey.export({ format: 'jwk' }) as JsonWebKey),
    kid: 'google-key', alg: 'RS256', use: 'sig',
  };
  const calls: string[] = [];
  let driftJwks = false;
  const fetchImpl = (async (target: string | URL | Request) => {
    const url = String(target);
    calls.push(url);
    if (url === google.identity.discoveryEndpoint) return new Response(JSON.stringify({
      issuer: google.expectedIssuer,
      authorization_endpoint: google.endpoints.authorization,
      token_endpoint: google.endpoints.token,
      jwks_uri: driftJwks ? `${google.identity.jwksUri}/other` : google.identity.jwksUri,
    }), { status: 200, headers: { 'content-type': 'application/json' } });
    if (url === google.identity.jwksUri) return new Response(JSON.stringify({ keys: [jwk] }), {
      status: 200, headers: { 'content-type': 'application/json' },
    });
    throw new Error(`uncertified endpoint: ${url}`);
  }) as typeof fetch;
  const now = Math.floor(Date.now() / 1000);
  const token = jwt.sign({
    iss: google.expectedIssuer, aud: 'client-id', sub: 'google-subject',
    iat: now, exp: now + 300, nonce: 'nonce',
  }, pair.privateKey, { algorithm: 'RS256', keyid: 'google-key' });
  const verifier = createCertifiedConnectorOidcVerifier({ spec: google, clientId: 'client-id', fetchImpl });
  assert.equal((await verifier.verifyIdToken(token, 'nonce')).sub, 'google-subject');
  assert.deepEqual(calls, [google.identity.discoveryEndpoint, google.identity.jwksUri]);

  driftJwks = true;
  await assert.rejects(
    createCertifiedConnectorOidcVerifier({ spec: google, clientId: 'client-id', fetchImpl })
      .verifyIdToken(token, 'nonce'),
    /discovery_unavailable/u,
  );
  assert.equal(calls.at(-1), google.identity.discoveryEndpoint);
});
