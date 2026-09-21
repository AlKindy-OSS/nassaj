import crypto from 'node:crypto';

import { getProviderSecretsKey } from '@/services/isolation/provider-secrets-key-manager.js';

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;
const TAG_BYTES = 16;
const ENVELOPE_PREFIX = 'dbcred:v1:';
const MAX_PLAINTEXT_BYTES = 16 * 1024;

export type CredentialAad = {
  id: number;
  userId: number;
  credentialType: string;
};

export class CredentialCipherError extends Error {
  constructor(code: string) {
    super(code);
    this.name = 'CredentialCipherError';
  }
}

function readExternalKey(): Buffer {
  try {
    return getProviderSecretsKey();
  } catch {
    throw new CredentialCipherError('database_credential_key_unavailable');
  }
}

function aadBytes(aad: CredentialAad): Buffer {
  if (!Number.isSafeInteger(aad.id) || aad.id <= 0) {
    throw new CredentialCipherError('database_credential_aad_invalid');
  }
  if (!Number.isSafeInteger(aad.userId) || aad.userId <= 0) {
    throw new CredentialCipherError('database_credential_aad_invalid');
  }
  if (typeof aad.credentialType !== 'string' || aad.credentialType.length === 0) {
    throw new CredentialCipherError('database_credential_aad_invalid');
  }
  return Buffer.from(
    `nassaj:user_credentials:v1:${aad.id}:${aad.userId}:${aad.credentialType}`,
    'utf8'
  );
}

export function isEncryptedCredentialValue(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith(ENVELOPE_PREFIX);
}

/** Encrypts a credential using row/user/type-bound authenticated encryption. */
export function encryptCredentialValue(plaintext: string, aad: CredentialAad): string {
  if (typeof plaintext !== 'string' || plaintext.length === 0) {
    throw new CredentialCipherError('database_credential_plaintext_invalid');
  }
  if (Buffer.byteLength(plaintext, 'utf8') > MAX_PLAINTEXT_BYTES) {
    throw new CredentialCipherError('database_credential_plaintext_too_large');
  }
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGORITHM, readExternalKey(), iv);
  cipher.setAAD(aadBytes(aad));
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${ENVELOPE_PREFIX}${iv.toString('base64')}:${tag.toString('base64')}:${ciphertext.toString('base64')}`;
}

/** Decrypts only a valid, authenticated v1 envelope; malformed/tampered data throws. */
export function decryptCredentialValue(envelope: string, aad: CredentialAad): string {
  if (!isEncryptedCredentialValue(envelope)) {
    throw new CredentialCipherError('database_credential_envelope_invalid');
  }
  const parts = envelope.split(':');
  if (parts.length !== 5 || parts[0] !== 'dbcred' || parts[1] !== 'v1') {
    throw new CredentialCipherError('database_credential_envelope_invalid');
  }
  try {
    const iv = Buffer.from(parts[2], 'base64');
    const tag = Buffer.from(parts[3], 'base64');
    const ciphertext = Buffer.from(parts[4], 'base64');
    if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES || ciphertext.length === 0) {
      throw new CredentialCipherError('database_credential_envelope_invalid');
    }
    const decipher = crypto.createDecipheriv(ALGORITHM, readExternalKey(), iv);
    decipher.setAAD(aadBytes(aad));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  } catch (error) {
    if (error instanceof CredentialCipherError) throw error;
    throw new CredentialCipherError('database_credential_authentication_failed');
  }
}
