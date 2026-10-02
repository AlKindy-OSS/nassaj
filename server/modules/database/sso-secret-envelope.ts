/**
 * Client-secret envelope for the SSO configuration (ADR-194 D3, T-1962 S1).
 *
 * AES-256-GCM under the provider-secrets key (held outside the database).
 * The AAD binds the ciphertext to its slot, issuer and client id, so a draft
 * ciphertext copied into the active slot, or a secret kept across an issuer or
 * client change, fails authentication instead of being used. The AAD fields
 * are length-safe JSON rather than a `|`-joined string because an issuer or a
 * client id may itself contain `|`. Plaintext is returned to the caller only;
 * nothing here caches, logs or exports it.
 */
import crypto from 'node:crypto';

import { getProviderSecretsKey } from '@/services/isolation/provider-secrets-key-manager.js';

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;
const TAG_BYTES = 16;
export const SSO_SECRET_ENVELOPE_PREFIX = 'ssooidc:v1:';
const MAX_PLAINTEXT_BYTES = 4 * 1024;

export type SsoSecretAad = Readonly<{ slot: 'active' | 'draft'; issuer: string; clientId: string }>;

export class SsoSecretEnvelopeError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = 'SsoSecretEnvelopeError';
    this.code = code;
  }
}

function readKey(): Buffer {
  try {
    return getProviderSecretsKey();
  } catch {
    throw new SsoSecretEnvelopeError('sso_secret_key_unavailable');
  }
}

function aadBytes(aad: SsoSecretAad): Buffer {
  if ((aad.slot !== 'active' && aad.slot !== 'draft')
    || typeof aad.issuer !== 'string' || aad.issuer.length === 0
    || typeof aad.clientId !== 'string' || aad.clientId.length === 0) {
    throw new SsoSecretEnvelopeError('sso_secret_aad_invalid');
  }
  return Buffer.from(`nassaj:sso_oidc_config:v1:${JSON.stringify([aad.slot, aad.issuer, aad.clientId])}`, 'utf8');
}

/** Encrypts a client secret for one slot/issuer/client binding. */
export function encryptSsoClientSecret(plaintext: string, aad: SsoSecretAad): string {
  if (typeof plaintext !== 'string' || plaintext.length === 0) {
    throw new SsoSecretEnvelopeError('sso_secret_plaintext_invalid');
  }
  if (Buffer.byteLength(plaintext, 'utf8') > MAX_PLAINTEXT_BYTES) {
    throw new SsoSecretEnvelopeError('sso_secret_plaintext_too_large');
  }
  const aadBuffer = aadBytes(aad);
  const iv = crypto.randomBytes(IV_BYTES);
  const key = readKey();
  let cipher: crypto.CipherGCM;
  try {
    cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  } finally {
    key.fill(0);
  }
  cipher.setAAD(aadBuffer);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${SSO_SECRET_ENVELOPE_PREFIX}${iv.toString('base64')}:${tag.toString('base64')}:${ciphertext.toString('base64')}`;
}

/** Decrypts an authenticated envelope; any malformed, tampered or rebound value throws. */
export function decryptSsoClientSecret(envelope: string, aad: SsoSecretAad): string {
  if (typeof envelope !== 'string' || !envelope.startsWith(SSO_SECRET_ENVELOPE_PREFIX)) {
    throw new SsoSecretEnvelopeError('sso_secret_envelope_invalid');
  }
  const parts = envelope.slice(SSO_SECRET_ENVELOPE_PREFIX.length).split(':');
  if (parts.length !== 3) throw new SsoSecretEnvelopeError('sso_secret_envelope_invalid');
  const aadBuffer = aadBytes(aad);
  const key = readKey();
  try {
    const [iv, tag, ciphertext] = parts.map((part) => Buffer.from(part, 'base64'));
    if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES || ciphertext.length === 0) {
      throw new SsoSecretEnvelopeError('sso_secret_envelope_invalid');
    }
    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
    decipher.setAAD(aadBuffer);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  } catch (error) {
    if (error instanceof SsoSecretEnvelopeError) throw error;
    throw new SsoSecretEnvelopeError('sso_secret_authentication_failed');
  } finally {
    key.fill(0);
  }
}
