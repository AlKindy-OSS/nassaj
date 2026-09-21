import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
} from 'node:crypto';
import {
  closeSync,
  constants,
  fchmodSync,
  fsyncSync,
  openSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';

const AES_KEY_BYTES = 32;
const GCM_NONCE_BYTES = 12;
const GCM_TAG_BYTES = 16;
const CURRENT_AAD_VERSION = 1;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const ID_PATTERN = /^[a-z0-9][a-z0-9._:-]{0,127}$/u;
const KEYRING_FORMAT = 'nassaj-connector-auth-keyring-v1';

export class ConnectorVaultCryptoError extends Error {
  constructor(code: string) {
    super(code);
    this.name = 'ConnectorVaultCryptoError';
  }
}

export interface ConnectorKekKeyring {
  activeKekVersion(): number;
  readKek(version: number): Buffer;
}

export interface ProviderSubjectHmacKeyring {
  activeHmacKeyVersion(): number;
  readHmacKey(version: number): Buffer;
}

export type ConnectorVaultAad = Readonly<{
  vaultSecretId: string;
  installationId: string;
  providerId: string;
  subjectType: 'installation' | 'profile' | 'grant' | 'oauth_transaction';
  subjectId: string;
  profileId: string | null;
  userId: number | null;
  fieldPurpose: string;
  secretRevision: number;
  kekVersion: number;
  aadVersion: number;
}>;

export type ConnectorVaultEnvelope = Readonly<{
  ciphertext: Buffer;
  nonce: Buffer;
  authTag: Buffer;
  wrappedDek: Buffer;
  wrappedDekNonce: Buffer;
  wrappedDekTag: Buffer;
  kekVersion: number;
  aadVersion: number;
  secretRevision: number;
}>;

type KeyringDocument = Readonly<{
  format: typeof KEYRING_FORMAT;
  activeKekVersion: number;
  keks: Readonly<Record<string, string>>;
  activeHmacKeyVersion: number;
  hmacKeys: Readonly<Record<string, string>>;
}>;

const assertPositiveVersion = (value: number): void => {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new ConnectorVaultCryptoError('connector_vault_version_invalid');
  }
};

const assertAad = (aad: ConnectorVaultAad): void => {
  for (const value of [aad.vaultSecretId, aad.installationId, aad.subjectId]) {
    if (!UUID_PATTERN.test(value)) throw new ConnectorVaultCryptoError('connector_vault_aad_invalid');
  }
  if (!ID_PATTERN.test(aad.providerId) || !ID_PATTERN.test(aad.fieldPurpose)) {
    throw new ConnectorVaultCryptoError('connector_vault_aad_invalid');
  }
  if (aad.profileId !== null && !UUID_PATTERN.test(aad.profileId)) {
    throw new ConnectorVaultCryptoError('connector_vault_aad_invalid');
  }
  if (aad.userId !== null && (!Number.isSafeInteger(aad.userId) || aad.userId <= 0)) {
    throw new ConnectorVaultCryptoError('connector_vault_aad_invalid');
  }
  if (!['installation', 'profile', 'grant', 'oauth_transaction'].includes(aad.subjectType)) {
    throw new ConnectorVaultCryptoError('connector_vault_aad_invalid');
  }
  assertPositiveVersion(aad.secretRevision);
  assertPositiveVersion(aad.kekVersion);
  assertPositiveVersion(aad.aadVersion);
};

const encodeField = (name: string, value: string | number | null): Buffer => {
  const nameBytes = Buffer.from(name, 'utf8');
  const valueBytes = value === null ? Buffer.alloc(0) : Buffer.from(String(value), 'utf8');
  const header = Buffer.alloc(7);
  header.writeUInt16BE(nameBytes.length, 0);
  header.writeUInt8(value === null ? 0 : typeof value === 'number' ? 2 : 1, 2);
  header.writeUInt32BE(valueBytes.length, 3);
  return Buffer.concat([header, nameBytes, valueBytes]);
};

const encodeBinaryFieldHeader = (name: string, byteLength: number): Buffer => {
  const nameBytes = Buffer.from(name, 'utf8');
  const header = Buffer.alloc(7);
  header.writeUInt16BE(nameBytes.length, 0);
  header.writeUInt8(3, 2);
  header.writeUInt32BE(byteLength, 3);
  return Buffer.concat([header, nameBytes]);
};

/** Canonical, type-tagged, length-prefixed AAD; null and every field boundary are explicit. */
export const encodeConnectorVaultAad = (aad: ConnectorVaultAad): Buffer => {
  assertAad(aad);
  return Buffer.concat([
    Buffer.from('nassaj:connector-vault:aad:v1\0', 'utf8'),
    encodeField('vaultSecretId', aad.vaultSecretId),
    encodeField('installationId', aad.installationId),
    encodeField('providerId', aad.providerId),
    encodeField('subjectType', aad.subjectType),
    encodeField('subjectId', aad.subjectId),
    encodeField('profileId', aad.profileId),
    encodeField('userId', aad.userId),
    encodeField('fieldPurpose', aad.fieldPurpose),
    encodeField('secretRevision', aad.secretRevision),
    encodeField('kekVersion', aad.kekVersion),
    encodeField('aadVersion', aad.aadVersion),
  ]);
};

const domainAad = (aad: ConnectorVaultAad, domain: 'payload' | 'wrapped-dek'): Buffer =>
  Buffer.concat([encodeConnectorVaultAad(aad), encodeField('cryptoDomain', domain)]);

const assertKey = (key: Buffer, code: string): Buffer => {
  if (!Buffer.isBuffer(key) || key.length !== AES_KEY_BYTES) {
    key?.fill?.(0);
    throw new ConnectorVaultCryptoError(code);
  }
  return key;
};

const encryptGcm = (plaintext: Buffer, key: Buffer, aad: Buffer) => {
  const nonce = randomBytes(GCM_NONCE_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return { ciphertext, nonce, authTag: cipher.getAuthTag() };
};

const decryptGcm = (
  ciphertext: Buffer,
  nonce: Buffer,
  authTag: Buffer,
  key: Buffer,
  aad: Buffer,
): Buffer => {
  if (ciphertext.length === 0 || nonce.length !== GCM_NONCE_BYTES || authTag.length !== GCM_TAG_BYTES) {
    throw new ConnectorVaultCryptoError('connector_vault_envelope_invalid');
  }
  const decipher = createDecipheriv('aes-256-gcm', key, nonce);
  decipher.setAAD(aad);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
};

/** Encrypts one secret with a random DEK, then independently wraps that DEK with the active KEK. */
export const encryptConnectorVaultSecret = (
  plaintext: Buffer,
  aadBase: Omit<ConnectorVaultAad, 'kekVersion' | 'aadVersion'>,
  keyring: ConnectorKekKeyring,
): ConnectorVaultEnvelope => {
  if (!Buffer.isBuffer(plaintext) || plaintext.length === 0) {
    throw new ConnectorVaultCryptoError('connector_vault_plaintext_invalid');
  }
  const kekVersion = keyring.activeKekVersion();
  assertPositiveVersion(kekVersion);
  const aad = { ...aadBase, kekVersion, aadVersion: CURRENT_AAD_VERSION };
  const kek = assertKey(keyring.readKek(kekVersion), 'connector_vault_kek_invalid');
  const dek = randomBytes(AES_KEY_BYTES);
  const plaintextCopy = Buffer.from(plaintext);
  try {
    const payload = encryptGcm(plaintextCopy, dek, domainAad(aad, 'payload'));
    const wrapped = encryptGcm(dek, kek, domainAad(aad, 'wrapped-dek'));
    return {
      ciphertext: payload.ciphertext,
      nonce: payload.nonce,
      authTag: payload.authTag,
      wrappedDek: wrapped.ciphertext,
      wrappedDekNonce: wrapped.nonce,
      wrappedDekTag: wrapped.authTag,
      kekVersion,
      aadVersion: CURRENT_AAD_VERSION,
      secretRevision: aad.secretRevision,
    };
  } finally {
    plaintextCopy.fill(0);
    dek.fill(0);
    kek.fill(0);
  }
};

/** Reads historical KEK versions fail-closed and authenticates both wrapping and payload layers. */
export const decryptConnectorVaultSecret = (
  envelope: ConnectorVaultEnvelope,
  aadBase: Omit<ConnectorVaultAad, 'kekVersion' | 'aadVersion' | 'secretRevision'>,
  keyring: ConnectorKekKeyring,
): Buffer => {
  const aad: ConnectorVaultAad = {
    ...aadBase,
    secretRevision: envelope.secretRevision,
    kekVersion: envelope.kekVersion,
    aadVersion: envelope.aadVersion,
  };
  assertAad(aad);
  const kek = assertKey(keyring.readKek(envelope.kekVersion), 'connector_vault_kek_invalid');
  let dek: Buffer | null = null;
  try {
    dek = decryptGcm(
      envelope.wrappedDek, envelope.wrappedDekNonce, envelope.wrappedDekTag,
      kek, domainAad(aad, 'wrapped-dek'),
    );
    assertKey(dek, 'connector_vault_wrapped_dek_invalid');
    return decryptGcm(
      envelope.ciphertext, envelope.nonce, envelope.authTag,
      dek, domainAad(aad, 'payload'),
    );
  } catch (error) {
    if (error instanceof ConnectorVaultCryptoError) throw error;
    throw new ConnectorVaultCryptoError('connector_vault_authentication_failed');
  } finally {
    dek?.fill(0);
    kek.fill(0);
  }
};

export type VaultRotationRepository = Readonly<{
  finalizeVaultSecret(input: Readonly<{
    secretRef: string;
    expectedVersion: number;
    expectedSecretRevision: number;
    targetSecretRevision: number;
    ciphertext: Buffer;
    nonce: Buffer;
    authTag: Buffer;
    wrappedDek: Buffer;
    wrappedDekNonce: Buffer;
    wrappedDekTag: Buffer;
    kekVersion: number;
    aadVersion: number;
    fence: ConnectorVaultFence;
  }>): boolean;
}>;

export type ConnectorVaultFence = Readonly<{
  leaseKey: string;
  ownerToken: string;
  fencingToken: number;
  expiresAt: string;
}>;

/** Decrypt-old/encrypt-active, then one fenced CAS; a crash cannot publish a partial envelope. */
export const rotateConnectorVaultSecret = (input: Readonly<{
  envelope: ConnectorVaultEnvelope;
  aad: Omit<ConnectorVaultAad, 'kekVersion' | 'aadVersion' | 'secretRevision'>;
  secretRef: string;
  expectedVersion: number;
  fence: ConnectorVaultFence;
  keyring: ConnectorKekKeyring;
  repository: VaultRotationRepository;
}>): boolean => {
  if (input.secretRef !== input.aad.vaultSecretId
    || input.fence.leaseKey !== `vault:${input.secretRef}`) {
    throw new ConnectorVaultCryptoError('connector_vault_rotation_binding_invalid');
  }
  const plaintext = decryptConnectorVaultSecret(input.envelope, input.aad, input.keyring);
  try {
    const targetSecretRevision = input.envelope.secretRevision + 1;
    const rotated = encryptConnectorVaultSecret(
      plaintext,
      { ...input.aad, secretRevision: targetSecretRevision },
      input.keyring,
    );
    return input.repository.finalizeVaultSecret({
      secretRef: input.secretRef,
      expectedVersion: input.expectedVersion,
      expectedSecretRevision: input.envelope.secretRevision,
      targetSecretRevision,
      ...rotated,
      fence: input.fence,
    });
  } finally {
    plaintext.fill(0);
  }
};

export type ProviderSubjectHmacContext = Readonly<{
  installationId: string;
  providerId: string;
  profileId: string;
}>;

/** Returns only the keyed digest and version; the raw provider subject never leaves this call. */
export const indexProviderSubjectAtVersion = (
  rawSubject: Buffer,
  context: ProviderSubjectHmacContext,
  keyring: ProviderSubjectHmacKeyring,
  hmacKeyVersion: number,
): Readonly<{ providerSubjectHmac: string; hmacKeyVersion: number }> => {
  if (!Buffer.isBuffer(rawSubject) || rawSubject.length === 0
    || !UUID_PATTERN.test(context.installationId) || !UUID_PATTERN.test(context.profileId)
    || !ID_PATTERN.test(context.providerId)) {
    throw new ConnectorVaultCryptoError('connector_subject_hmac_input_invalid');
  }
  assertPositiveVersion(hmacKeyVersion);
  const key = assertKey(keyring.readHmacKey(hmacKeyVersion), 'connector_subject_hmac_key_invalid');
  const subjectCopy = Buffer.from(rawSubject);
  let contextBytes: Buffer | null = null;
  let subjectHeader: Buffer | null = null;
  try {
    contextBytes = Buffer.concat([
      Buffer.from('nassaj:connector-subject-hmac:v1\0', 'utf8'),
      encodeField('installationId', context.installationId),
      encodeField('providerId', context.providerId),
      encodeField('profileId', context.profileId),
      encodeField('hmacKeyVersion', hmacKeyVersion),
    ]);
    subjectHeader = encodeBinaryFieldHeader('rawSubject', subjectCopy.length);
    return {
      providerSubjectHmac: createHmac('sha256', key)
        .update(contextBytes)
        .update(subjectHeader)
        .update(subjectCopy)
        .digest('hex'),
      hmacKeyVersion,
    };
  } finally {
    contextBytes?.fill(0);
    subjectHeader?.fill(0);
    subjectCopy.fill(0);
    key.fill(0);
  }
};

/** New writes always use the active HMAC key; historical reads call the versioned helper first. */
export const indexProviderSubject = (
  rawSubject: Buffer,
  context: ProviderSubjectHmacContext,
  keyring: ProviderSubjectHmacKeyring,
): Readonly<{ providerSubjectHmac: string; hmacKeyVersion: number }> =>
  indexProviderSubjectAtVersion(rawSubject, context, keyring, keyring.activeHmacKeyVersion());

/** Signals that the caller must transiently re-read and reindex the raw subject under the active key. */
export const providerSubjectNeedsReindex = (
  storedKeyVersion: number,
  keyring: ProviderSubjectHmacKeyring,
): boolean => {
  assertPositiveVersion(storedKeyVersion);
  const activeVersion = keyring.activeHmacKeyVersion();
  assertPositiveVersion(activeVersion);
  return storedKeyVersion !== activeVersion;
};

const decodeKey = (encoded: unknown, code: string): Buffer => {
  if (typeof encoded !== 'string' || !/^[A-Za-z0-9+/]{43}=$/u.test(encoded)) {
    throw new ConnectorVaultCryptoError(code);
  }
  return assertKey(Buffer.from(encoded, 'base64'), code);
};

const parseKeyring = (filePath: string): KeyringDocument => {
  let raw: string;
  try {
    const stat = statSync(filePath);
    if (!stat.isFile() || (stat.mode & 0o077) !== 0) {
      throw new ConnectorVaultCryptoError('connector_auth_keyring_permissions_invalid');
    }
    raw = readFileSync(filePath, 'utf8');
  } catch (error) {
    if (error instanceof ConnectorVaultCryptoError) throw error;
    throw new ConnectorVaultCryptoError('connector_auth_keyring_unavailable');
  }
  try {
    const parsed = JSON.parse(raw) as KeyringDocument;
    if (parsed.format !== KEYRING_FORMAT || typeof parsed.keks !== 'object'
      || parsed.keks === null || typeof parsed.hmacKeys !== 'object' || parsed.hmacKeys === null) {
      throw new Error('shape');
    }
    assertPositiveVersion(parsed.activeKekVersion);
    assertPositiveVersion(parsed.activeHmacKeyVersion);
    decodeKey(parsed.keks[String(parsed.activeKekVersion)], 'connector_auth_keyring_invalid').fill(0);
    decodeKey(parsed.hmacKeys[String(parsed.activeHmacKeyVersion)], 'connector_auth_keyring_invalid').fill(0);
    return parsed;
  } catch (error) {
    if (error instanceof ConnectorVaultCryptoError) throw error;
    throw new ConnectorVaultCryptoError('connector_auth_keyring_invalid');
  }
};

export class FileConnectorAuthKeyring implements ConnectorKekKeyring, ProviderSubjectHmacKeyring {
  constructor(private readonly filePath: string) {}

  activeKekVersion(): number {
    return parseKeyring(this.filePath).activeKekVersion;
  }

  readKek(version: number): Buffer {
    assertPositiveVersion(version);
    const encoded = parseKeyring(this.filePath).keks[String(version)];
    if (!encoded) throw new ConnectorVaultCryptoError('connector_vault_kek_unavailable');
    return decodeKey(encoded, 'connector_vault_kek_invalid');
  }

  activeHmacKeyVersion(): number {
    return parseKeyring(this.filePath).activeHmacKeyVersion;
  }

  readHmacKey(version: number): Buffer {
    assertPositiveVersion(version);
    const encoded = parseKeyring(this.filePath).hmacKeys[String(version)];
    if (!encoded) throw new ConnectorVaultCryptoError('connector_subject_hmac_key_unavailable');
    return decodeKey(encoded, 'connector_subject_hmac_key_invalid');
  }
}

/** Creates a new keyring atomically and exclusively; existing files are never overwritten. */
export const createConnectorAuthKeyringFile = (filePath: string): FileConnectorAuthKeyring => {
  const document: KeyringDocument = {
    format: KEYRING_FORMAT,
    activeKekVersion: 1,
    keks: { '1': randomBytes(AES_KEY_BYTES).toString('base64') },
    activeHmacKeyVersion: 1,
    hmacKeys: { '1': randomBytes(AES_KEY_BYTES).toString('base64') },
  };
  let descriptor: number | null = null;
  try {
    descriptor = openSync(filePath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    writeFileSync(descriptor, `${JSON.stringify(document)}\n`, 'utf8');
    fchmodSync(descriptor, 0o600);
    fsyncSync(descriptor);
  } catch {
    throw new ConnectorVaultCryptoError('connector_auth_keyring_create_failed');
  } finally {
    if (descriptor !== null) closeSync(descriptor);
  }
  return new FileConnectorAuthKeyring(filePath);
};
