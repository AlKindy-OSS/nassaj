import assert from 'node:assert/strict';
import test from 'node:test';

import {
  canonicalConnectorPublicOrigin,
  connectorOAuthCallbackUrl,
  RECENT_AUTH_MAX_AGE_MS,
  validateConnectorAuthBootstrapCapability,
} from './connector-auth-security.js';

test('canonical public origin normalizes IDNA, case, default port, and trailing slash', () => {
  const env = { NASSAJ_PUBLIC_ORIGIN: 'https://BÜCHER.example:443/' };
  assert.equal(canonicalConnectorPublicOrigin(env), 'https://xn--bcher-kva.example');
  assert.equal(
    connectorOAuthCallbackUrl(env),
    'https://xn--bcher-kva.example/connectors/oauth/callback',
  );
});

test('canonical public origin rejects malformed or non-origin values', () => {
  for (const value of [
    '', 'not a url', '//nassaj.example', 'https://user@nassaj.example',
    'https://nassaj.example/path', 'https://nassaj.example/?q=1',
    'https://nassaj.example/#fragment', 'http://nassaj.example',
  ]) {
    assert.throws(() => canonicalConnectorPublicOrigin({ NASSAJ_PUBLIC_ORIGIN: value }));
  }
  assert.equal(canonicalConnectorPublicOrigin({
    NASSAJ_PUBLIC_ORIGIN: 'http://localhost:3004/',
    NODE_ENV: 'development',
  }), 'http://localhost:3004');
});

test('spoofed Host and forwarding headers cannot influence the configured callback', () => {
  assert.equal(
    connectorOAuthCallbackUrl({
      NASSAJ_PUBLIC_ORIGIN: 'https://nassaj.example',
      HOST: 'attacker.example',
      X_FORWARDED_HOST: 'attacker.example',
      X_FORWARDED_PROTO: 'http',
    }),
    'https://nassaj.example/connectors/oauth/callback',
  );
});

test('bootstrap capability must carry a stable id and the exact canonical configured origin', () => {
  const env = { NASSAJ_PUBLIC_ORIGIN: 'https://nassaj.example' };
  assert.equal(validateConnectorAuthBootstrapCapability(null, env), null);
  assert.equal(validateConnectorAuthBootstrapCapability({
    installationId: 'short', canonicalOrigin: 'https://nassaj.example',
  }, env), null);
  assert.equal(validateConnectorAuthBootstrapCapability({
    installationId: 'installation-test-0001', canonicalOrigin: 'https://attacker.example',
  }, env), null);
  assert.deepEqual(validateConnectorAuthBootstrapCapability({
    installationId: 'installation-test-0001', canonicalOrigin: 'https://nassaj.example',
  }, env), {
    installationId: 'installation-test-0001', canonicalOrigin: 'https://nassaj.example',
  });
});

test('recent-auth window is the single ten-minute source of truth', () => {
  assert.equal(RECENT_AUTH_MAX_AGE_MS, 10 * 60 * 1_000);
});
