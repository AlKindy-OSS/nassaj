/** ADR-194 D3 client-secret envelope: round trip, AAD binding, tampering and key loss. */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { afterEach, beforeEach, test } from 'node:test';

import { resetProviderSecretsKeyCacheForTests } from '@/services/isolation/provider-secrets-key-manager.js';

import {
  decryptSsoClientSecret, encryptSsoClientSecret, SSO_SECRET_ENVELOPE_PREFIX, SsoSecretEnvelopeError,
} from './sso-secret-envelope.js';

const savedKey = process.env.NASSAJ_PROVIDER_SECRETS_KEY;
const ACTIVE = { slot: 'active', issuer: 'https://idp.example', clientId: 'client-1' } as const;

beforeEach(() => {
  process.env.NASSAJ_PROVIDER_SECRETS_KEY = crypto.randomBytes(32).toString('base64');
  resetProviderSecretsKeyCacheForTests();
});
afterEach(() => {
  if (savedKey === undefined) delete process.env.NASSAJ_PROVIDER_SECRETS_KEY;
  else process.env.NASSAJ_PROVIDER_SECRETS_KEY = savedKey;
  resetProviderSecretsKeyCacheForTests();
});

const rejectsWith = (run: () => unknown, code: string) => assert.throws(run, (error: unknown) => {
  assert.ok(error instanceof SsoSecretEnvelopeError);
  assert.equal(error.code, code);
  return true;
});

test('round trip under the same binding; the ciphertext never contains the plaintext', () => {
  const envelope = encryptSsoClientSecret('top-secret-value', ACTIVE);
  assert.ok(envelope.startsWith(SSO_SECRET_ENVELOPE_PREFIX));
  assert.ok(!envelope.includes('top-secret-value'));
  assert.notEqual(envelope, encryptSsoClientSecret('top-secret-value', ACTIVE), 'fresh IV per write');
  assert.equal(decryptSsoClientSecret(envelope, ACTIVE), 'top-secret-value');
});

test('AAD mismatch: another slot, issuer or client id fails authentication', () => {
  const draft = encryptSsoClientSecret('s', { ...ACTIVE, slot: 'draft' });
  rejectsWith(() => decryptSsoClientSecret(draft, ACTIVE), 'sso_secret_authentication_failed');
  const envelope = encryptSsoClientSecret('s', ACTIVE);
  rejectsWith(() => decryptSsoClientSecret(envelope, { ...ACTIVE, issuer: 'https://evil.example' }),
    'sso_secret_authentication_failed');
  rejectsWith(() => decryptSsoClientSecret(envelope, { ...ACTIVE, clientId: 'client-2' }),
    'sso_secret_authentication_failed');
  // `|` inside a field cannot shift the boundary between fields.
  const piped = encryptSsoClientSecret('s', { slot: 'active', issuer: 'https://a|b', clientId: 'c' });
  rejectsWith(() => decryptSsoClientSecret(piped, { slot: 'active', issuer: 'https://a', clientId: 'b|c' }),
    'sso_secret_authentication_failed');
});

test('tampering and malformed envelopes are refused', () => {
  const envelope = encryptSsoClientSecret('s', ACTIVE);
  const [iv, tag, body] = envelope.slice(SSO_SECRET_ENVELOPE_PREFIX.length).split(':');
  const flipped = Buffer.from(body, 'base64');
  flipped[0] ^= 1;
  rejectsWith(() => decryptSsoClientSecret(`${SSO_SECRET_ENVELOPE_PREFIX}${iv}:${tag}:${flipped.toString('base64')}`, ACTIVE),
    'sso_secret_authentication_failed');
  for (const bad of ['', 'dbcred:v1:a:b:c', `${SSO_SECRET_ENVELOPE_PREFIX}a:b`, `${SSO_SECRET_ENVELOPE_PREFIX}::`]) {
    assert.throws(() => decryptSsoClientSecret(bad, ACTIVE), SsoSecretEnvelopeError);
  }
});

test('a different or unavailable key never decrypts', () => {
  const envelope = encryptSsoClientSecret('s', ACTIVE);
  process.env.NASSAJ_PROVIDER_SECRETS_KEY = crypto.randomBytes(32).toString('base64');
  resetProviderSecretsKeyCacheForTests();
  rejectsWith(() => decryptSsoClientSecret(envelope, ACTIVE), 'sso_secret_authentication_failed');
  process.env.NASSAJ_PROVIDER_SECRETS_KEY = 'not-a-key';
  resetProviderSecretsKeyCacheForTests();
  rejectsWith(() => decryptSsoClientSecret(envelope, ACTIVE), 'sso_secret_key_unavailable');
  rejectsWith(() => encryptSsoClientSecret('s', ACTIVE), 'sso_secret_key_unavailable');
});

test('input validation', () => {
  rejectsWith(() => encryptSsoClientSecret('', ACTIVE), 'sso_secret_plaintext_invalid');
  rejectsWith(() => encryptSsoClientSecret('x'.repeat(4097), ACTIVE), 'sso_secret_plaintext_too_large');
  rejectsWith(() => encryptSsoClientSecret('s', { ...ACTIVE, issuer: '' }), 'sso_secret_aad_invalid');
  rejectsWith(() => encryptSsoClientSecret('s', { ...ACTIVE, slot: 'other' as 'active' }), 'sso_secret_aad_invalid');
});
