import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import Database from 'better-sqlite3';

// eslint-disable-next-line boundaries/dependencies -- integration test exercises the real M1.2 persistence contract.
import { migrateConnectorAuthSchema } from '../database/connector-auth.migration.js';
// eslint-disable-next-line boundaries/dependencies -- integration test exercises the real M1.2 persistence contract.
import { createConnectorAuthDb } from '../database/repositories/connector-auth.db.js';

import {
  createConnectorAuthKeyringFile,
  decryptConnectorVaultSecret,
  encodeConnectorVaultAad,
  encryptConnectorVaultSecret,
  FileConnectorAuthKeyring,
  indexProviderSubject,
  providerSubjectNeedsReindex,
  rotateConnectorVaultSecret,
  type ConnectorKekKeyring,
  type ProviderSubjectHmacKeyring,
} from './connector-auth-vault.crypto.js';

class MemoryKeyring implements ConnectorKekKeyring, ProviderSubjectHmacKeyring {
  constructor(
    private readonly activeKek: number,
    private readonly keks: ReadonlyMap<number, Buffer>,
    private readonly activeHmac: number = 1,
    private readonly hmacKeys: ReadonlyMap<number, Buffer> = new Map([[1, Buffer.alloc(32, 7)]]),
  ) {}

  activeKekVersion(): number { return this.activeKek; }
  activeHmacKeyVersion(): number { return this.activeHmac; }
  readKek(version: number): Buffer {
    const key = this.keks.get(version);
    if (!key) throw new Error('missing_test_kek');
    return Buffer.from(key);
  }
  readHmacKey(version: number): Buffer {
    const key = this.hmacKeys.get(version);
    if (!key) throw new Error('missing_test_hmac_key');
    return Buffer.from(key);
  }
}

const installationId = randomUUID();
const profileId = randomUUID();
const vaultSecretId = randomUUID();
const baseAad = () => ({
  vaultSecretId,
  installationId,
  providerId: 'notion',
  subjectType: 'profile' as const,
  subjectId: profileId,
  profileId,
  userId: null,
  fieldPurpose: 'client_secret',
  secretRevision: 1,
});
const kek1 = Buffer.alloc(32, 1);
const kek2 = Buffer.alloc(32, 2);
const v1Keyring = () => new MemoryKeyring(1, new Map([[1, kek1]]));

test('envelope AES-256-GCM round-trips without storing plaintext or the DEK in clear', () => {
  const plaintext = Buffer.from('provider-secret-value');
  const envelope = encryptConnectorVaultSecret(plaintext, baseAad(), v1Keyring());
  assert.equal(envelope.nonce.length, 12);
  assert.equal(envelope.authTag.length, 16);
  assert.equal(envelope.wrappedDek.length, 32);
  assert.equal(envelope.wrappedDekNonce.length, 12);
  assert.equal(envelope.wrappedDekTag.length, 16);
  assert.equal(envelope.ciphertext.includes(plaintext), false);
  assert.equal(envelope.wrappedDek.equals(kek1), false);
  assert.equal(decryptConnectorVaultSecret(envelope, baseAad(), v1Keyring()).toString(), plaintext.toString());
});

test('tampering either authenticated layer fails closed', () => {
  const envelope = encryptConnectorVaultSecret(Buffer.from('secret'), baseAad(), v1Keyring());
  for (const field of ['ciphertext', 'authTag', 'wrappedDek', 'wrappedDekTag'] as const) {
    const changed = Buffer.from(envelope[field]);
    changed[0] ^= 1;
    assert.throws(() => decryptConnectorVaultSecret(
      { ...envelope, [field]: changed }, baseAad(), v1Keyring(),
    ), /authentication_failed/);
  }
});

test('cross-row swaps and changes to any AAD-bound identity fail authentication', () => {
  const envelope = encryptConnectorVaultSecret(Buffer.from('row-one'), baseAad(), v1Keyring());
  assert.throws(() => decryptConnectorVaultSecret(
    envelope, { ...baseAad(), vaultSecretId: randomUUID() }, v1Keyring(),
  ), /authentication_failed/);
  assert.throws(() => decryptConnectorVaultSecret(
    envelope, { ...baseAad(), fieldPurpose: 'refresh_token' }, v1Keyring(),
  ), /authentication_failed/);
});

test('missing and unknown KEK versions fail closed', () => {
  const envelope = encryptConnectorVaultSecret(Buffer.from('secret'), baseAad(), v1Keyring());
  const unavailable = new MemoryKeyring(2, new Map([[2, kek2]]));
  assert.throws(() => decryptConnectorVaultSecret(envelope, baseAad(), unavailable), /missing_test_kek/);
  const missingPath = path.join(os.tmpdir(), `missing-keyring-${randomUUID()}`);
  assert.throws(() => new FileConnectorAuthKeyring(missingPath).activeKekVersion(), /keyring_unavailable/);
});

test('historical keys remain readable while every new write uses the active KEK', () => {
  const oldEnvelope = encryptConnectorVaultSecret(Buffer.from('old-secret'), baseAad(), v1Keyring());
  const rotatedKeyring = new MemoryKeyring(2, new Map([[1, kek1], [2, kek2]]));
  assert.equal(decryptConnectorVaultSecret(oldEnvelope, baseAad(), rotatedKeyring).toString(), 'old-secret');
  const newEnvelope = encryptConnectorVaultSecret(
    Buffer.from('new-secret'), { ...baseAad(), secretRevision: 2 }, rotatedKeyring,
  );
  assert.equal(newEnvelope.kekVersion, 2);
  assert.equal(newEnvelope.secretRevision, 2);
});

test('canonical AAD is type-tagged, length-prefixed, and rejects ambiguous concatenations', () => {
  const first = encodeConnectorVaultAad({
    ...baseAad(), fieldPurpose: 'token:a', kekVersion: 1, aadVersion: 1,
  });
  const second = encodeConnectorVaultAad({
    ...baseAad(), fieldPurpose: 'token', kekVersion: 1, aadVersion: 1,
  });
  const absentUser = encodeConnectorVaultAad({
    ...baseAad(), userId: null, kekVersion: 1, aadVersion: 1,
  });
  const presentUser = encodeConnectorVaultAad({
    ...baseAad(), userId: 7, kekVersion: 1, aadVersion: 1,
  });
  assert.equal(first.equals(second), false);
  assert.equal(absentUser.equals(presentUser), false);
  assert.equal(encodeConnectorVaultAad({
    ...baseAad(), fieldPurpose: 'token:a', kekVersion: 1, aadVersion: 1,
  }).equals(first), true, 'the same semantic tuple always has exactly one encoding');
});

test('fenced rotation decrypts old, encrypts active, and submits one revision-bound CAS', () => {
  const oldEnvelope = encryptConnectorVaultSecret(Buffer.from('rotate-me'), baseAad(), v1Keyring());
  const active = new MemoryKeyring(2, new Map([[1, kek1], [2, kek2]]));
  let write: Record<string, unknown> | null = null;
  const fence = {
    leaseKey: `vault:${vaultSecretId}`,
    ownerToken: randomUUID(),
    fencingToken: 4,
    expiresAt: '2099-01-01 00:00:00',
  };
  const won = rotateConnectorVaultSecret({
    envelope: oldEnvelope,
    aad: baseAad(),
    secretRef: vaultSecretId,
    expectedVersion: 9,
    fence,
    keyring: active,
    repository: {
      finalizeVaultSecret(input) {
        write = input;
        return true;
      },
    },
  });
  assert.equal(won, true);
  assert.equal(write?.expectedVersion, 9);
  assert.equal(write?.expectedSecretRevision, 1);
  assert.equal(write?.targetSecretRevision, 2);
  assert.equal(write?.kekVersion, 2);
  const captured = write as unknown as {
    ciphertext: Buffer; nonce: Buffer; authTag: Buffer; wrappedDek: Buffer;
    wrappedDekNonce: Buffer; wrappedDekTag: Buffer; kekVersion: number;
    aadVersion: number; targetSecretRevision: number;
  };
  assert.equal(decryptConnectorVaultSecret({
    ciphertext: captured.ciphertext,
    nonce: captured.nonce,
    authTag: captured.authTag,
    wrappedDek: captured.wrappedDek,
    wrappedDekNonce: captured.wrappedDekNonce,
    wrappedDekTag: captured.wrappedDekTag,
    kekVersion: captured.kekVersion,
    aadVersion: captured.aadVersion,
    secretRevision: captured.targetSecretRevision,
  }, baseAad(), active).toString(), 'rotate-me');
});

test('real repository rotation rejects cross-target or wrong-lease binding without mutating the target', () => {
  const database = new Database(':memory:');
  try {
    database.pragma('foreign_keys = ON');
    database.exec('CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT NOT NULL)');
    migrateConnectorAuthSchema(database);
    const repository = createConnectorAuthDb(database);
    const actualInstallationId = repository.getOrCreateInstallation();
    const keyring = v1Keyring();
    const stage = (secretId: string, plaintext: string) => {
      const aad = {
        vaultSecretId: secretId,
        installationId: actualInstallationId,
        providerId: 'notion',
        subjectType: 'installation' as const,
        subjectId: actualInstallationId,
        profileId: null,
        userId: null,
        fieldPurpose: 'oauth_client',
        secretRevision: 1,
      };
      const envelope = encryptConnectorVaultSecret(Buffer.from(plaintext), aad, keyring);
      repository.createVaultSecret({
        secretRef: secretId,
        installationId: actualInstallationId,
        providerId: 'notion',
        subjectType: 'installation',
        subjectId: actualInstallationId,
        profileId: null,
        userId: null,
        fieldPurpose: 'oauth_client',
        secretKind: 'oauth_client',
        ...envelope,
      });
      return { aad, envelope };
    };
    const firstId = randomUUID();
    const secondId = randomUUID();
    const first = stage(firstId, 'first-secret');
    const second = stage(secondId, 'second-secret');
    const firstFence = repository.acquireLease(`vault:${firstId}`, randomUUID(), 60);
    const secondFence = repository.acquireLease(`vault:${secondId}`, randomUUID(), 60);
    assert.ok(firstFence);
    assert.ok(secondFence);

    assert.throws(() => rotateConnectorVaultSecret({
      envelope: first.envelope,
      aad: first.aad,
      secretRef: secondId,
      expectedVersion: 1,
      fence: secondFence,
      keyring,
      repository,
    }), /rotation_binding_invalid/);
    assert.throws(() => rotateConnectorVaultSecret({
      envelope: second.envelope,
      aad: second.aad,
      secretRef: secondId,
      expectedVersion: 1,
      fence: firstFence,
      keyring,
      repository,
    }), /rotation_binding_invalid/);

    const stored = database.prepare(
      `SELECT ciphertext, nonce, auth_tag, wrapped_dek, wrapped_dek_nonce,
              wrapped_dek_tag, kek_version, aad_version, secret_revision, version
       FROM connector_vault_secrets WHERE secret_ref = ?`,
    ).get(secondId) as {
      ciphertext: Buffer; nonce: Buffer; auth_tag: Buffer; wrapped_dek: Buffer;
      wrapped_dek_nonce: Buffer; wrapped_dek_tag: Buffer; kek_version: number;
      aad_version: number; secret_revision: number; version: number;
    };
    assert.equal(stored.version, 1);
    assert.equal(stored.secret_revision, 1);
    assert.equal(decryptConnectorVaultSecret({
      ciphertext: stored.ciphertext,
      nonce: stored.nonce,
      authTag: stored.auth_tag,
      wrappedDek: stored.wrapped_dek,
      wrappedDekNonce: stored.wrapped_dek_nonce,
      wrappedDekTag: stored.wrapped_dek_tag,
      kekVersion: stored.kek_version,
      aadVersion: stored.aad_version,
      secretRevision: stored.secret_revision,
    }, second.aad, keyring).toString(), 'second-secret');
  } finally {
    database.close();
  }
});

test('provider subject HMAC is deterministic, context-separated, versioned, and returns no raw subject', () => {
  const keyring = new MemoryKeyring(
    1, new Map([[1, kek1]]), 1, new Map([[1, Buffer.alloc(32, 8)], [2, Buffer.alloc(32, 9)]]),
  );
  const raw = Buffer.from('provider-account-123');
  const context = { installationId, providerId: 'notion', profileId };
  const first = indexProviderSubject(raw, context, keyring);
  const second = indexProviderSubject(raw, context, keyring);
  const separated = indexProviderSubject(raw, { ...context, providerId: 'linear' }, keyring);
  assert.deepEqual(first, second);
  assert.notEqual(first.providerSubjectHmac, separated.providerSubjectHmac);
  assert.match(first.providerSubjectHmac, /^[0-9a-f]{64}$/u);
  assert.equal(JSON.stringify(first).includes(raw.toString()), false);
  assert.equal(providerSubjectNeedsReindex(1, keyring), false);
  const v2 = new MemoryKeyring(
    1, new Map([[1, kek1]]), 2, new Map([[1, Buffer.alloc(32, 8)], [2, Buffer.alloc(32, 9)]]),
  );
  assert.equal(providerSubjectNeedsReindex(1, v2), true);
  assert.notEqual(indexProviderSubject(raw, context, v2).providerSubjectHmac, first.providerSubjectHmac);
});

test('file keyring is created 0600 and rejects permissive or malformed key files', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'nassaj-connector-keyring-'));
  try {
    const filePath = path.join(directory, 'keyring.json');
    const keyring = createConnectorAuthKeyringFile(filePath);
    assert.equal(statSync(filePath).mode & 0o777, 0o600);
    assert.equal(keyring.readKek(1).length, 32);
    assert.equal(keyring.readHmacKey(1).length, 32);
    assert.throws(() => keyring.readKek(99), /kek_unavailable/);
    chmodSync(filePath, 0o644);
    assert.throws(() => keyring.activeKekVersion(), /permissions_invalid/);
    chmodSync(filePath, 0o600);
    writeFileSync(filePath, JSON.stringify({ format: 'wrong' }), { mode: 0o600 });
    assert.throws(() => keyring.activeKekVersion(), /keyring_invalid/);
    assert.equal(readFileSync(filePath, 'utf8').includes('provider-account-123'), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('each secret receives a fresh random DEK and nonce', () => {
  const plaintext = randomBytes(32);
  const first = encryptConnectorVaultSecret(plaintext, baseAad(), v1Keyring());
  const second = encryptConnectorVaultSecret(plaintext, baseAad(), v1Keyring());
  assert.equal(first.nonce.equals(second.nonce), false);
  assert.equal(first.wrappedDek.equals(second.wrappedDek), false);
});
