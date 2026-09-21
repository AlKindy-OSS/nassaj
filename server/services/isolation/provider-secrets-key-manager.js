import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const KEY_BYTES = 32;
const KEY_MODE = 0o600;
const KEY_ENV = 'NASSAJ_PROVIDER_SECRETS_KEY';
const KEY_FD_ENV = 'NASSAJ_PROVIDER_SECRETS_KEY_FD';
const CAPABILITY_FD_ENV = 'NASSAJ_SECRET_CAPABILITY_FD';

export class ProviderSecretsKeyError extends Error {
  constructor(code) {
    super(code);
    this.name = 'ProviderSecretsKeyError';
    this.code = code;
  }
}

let cached = null;

function decodeConfiguredKey(raw) {
  if (typeof raw !== 'string' || raw.length === 0 || raw !== raw.trim()) return null;
  if (/^[0-9a-fA-F]{64}$/.test(raw)) return Buffer.from(raw, 'hex');
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(raw)) return null;
  const decoded = Buffer.from(raw, 'base64');
  return decoded.length === KEY_BYTES ? decoded : null;
}

function validateKeyFileStat(stat, expectedUid) {
  if (
    !stat.isFile()
    || stat.nlink !== 1
    || stat.uid !== expectedUid
    || (stat.mode & 0o777) !== KEY_MODE
    || stat.size !== KEY_BYTES
  ) {
    throw new ProviderSecretsKeyError('provider_secrets_key_file_insecure');
  }
}

function readKeyFromPinnedDescriptor(filePath, expectedUid) {
  let before;
  try {
    before = fs.lstatSync(filePath);
  } catch {
    throw new ProviderSecretsKeyError('provider_secrets_key_file_unavailable');
  }
  if (before.isSymbolicLink()) {
    throw new ProviderSecretsKeyError('provider_secrets_key_file_insecure');
  }
  validateKeyFileStat(before, expectedUid);

  let descriptor;
  try {
    descriptor = fs.openSync(filePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  } catch {
    throw new ProviderSecretsKeyError('provider_secrets_key_file_unavailable');
  }
  try {
    const opened = fs.fstatSync(descriptor);
    validateKeyFileStat(opened, expectedUid);
    if (opened.dev !== before.dev || opened.ino !== before.ino) {
      throw new ProviderSecretsKeyError('provider_secrets_key_file_changed');
    }
    const key = Buffer.alloc(KEY_BYTES);
    const bytesRead = fs.readSync(descriptor, key, 0, KEY_BYTES, 0);
    const after = fs.fstatSync(descriptor);
    validateKeyFileStat(after, expectedUid);
    if (bytesRead !== KEY_BYTES || after.dev !== opened.dev || after.ino !== opened.ino) {
      throw new ProviderSecretsKeyError('provider_secrets_key_file_changed');
    }
    return key;
  } finally {
    fs.closeSync(descriptor);
  }
}

function readKeyFromInheritedDescriptor(descriptor, expectedUid) {
  if (!Number.isInteger(descriptor) || descriptor < 3) {
    throw new ProviderSecretsKeyError('provider_secrets_key_fd_invalid');
  }
  let stat;
  try { stat = fs.fstatSync(descriptor); } catch { throw new ProviderSecretsKeyError('provider_secrets_key_fd_unavailable'); }
  validateKeyFileStat(stat, expectedUid);
  const key = Buffer.alloc(KEY_BYTES);
  const bytesRead = fs.readSync(descriptor, key, 0, KEY_BYTES, 0);
  const after = fs.fstatSync(descriptor);
  validateKeyFileStat(after, expectedUid);
  if (bytesRead !== KEY_BYTES || after.dev !== stat.dev || after.ino !== stat.ino) {
    throw new ProviderSecretsKeyError('provider_secrets_key_fd_changed');
  }
  return key;
}

function readMigrationCapability(descriptor, expectedUid) {
  if (!Number.isInteger(descriptor) || descriptor < 3) {
    throw new ProviderSecretsKeyError('provider_secrets_capability_fd_invalid');
  }
  let stat;
  try { stat = fs.fstatSync(descriptor); } catch { throw new ProviderSecretsKeyError('provider_secrets_capability_fd_unavailable'); }
  if (!stat.isFile() || stat.uid !== expectedUid || (stat.mode & 0o077) !== 0 || stat.size <= 0 || stat.size > 4096) {
    throw new ProviderSecretsKeyError('provider_secrets_capability_fd_insecure');
  }
  const bytes = Buffer.alloc(stat.size); const count = fs.readSync(descriptor, bytes, 0, bytes.length, 0);
  let capability;
  try { capability = JSON.parse(bytes.subarray(0, count).toString('utf8')); } finally { bytes.fill(0); }
  const baseKeys = ['databaseSha256', 'expiresAt', 'migrationEntrySha256', 'nonce', 'providerSecretsKeyFd',
    'purpose', 'releaseIdentitySha256', 'schema'];
  const boundKeys = [...baseKeys, 'databaseContractSha256', 'migrationClosureSha256'];
  const keys = Object.keys(capability || {}).sort().join(',');
  const boundCapability = keys === boundKeys.sort().join(',');
  if (capability?.schema !== 'nassaj-migration-secret-capability/v1'
      || (keys !== baseKeys.sort().join(',') && !boundCapability)
      || capability.providerSecretsKeyFd !== 4 || capability.purpose !== 'release-database-migration'
      || !/^[a-f0-9]{64}$/.test(capability.releaseIdentitySha256 || '')
      || !/^[a-f0-9]{64}$/.test(capability.migrationEntrySha256 || '')
      || (boundCapability && (!/^[a-f0-9]{64}$/.test(capability.databaseContractSha256 || '')
        || !/^[a-f0-9]{64}$/.test(capability.migrationClosureSha256 || '')))
      || !/^[a-f0-9]{64}$/.test(capability.databaseSha256 || '')
      || !/^[A-Za-z0-9_-]{8,128}$/.test(capability.nonce || '')
      || !Number.isSafeInteger(capability.expiresAt) || capability.expiresAt <= Date.now()
      || capability.releaseIdentitySha256 !== process.env.NASSAJ_MIGRATION_RELEASE_IDENTITY_SHA256
      || capability.migrationEntrySha256 !== process.env.NASSAJ_MIGRATION_ENTRY_SHA256
      || (boundCapability && (capability.databaseContractSha256 !== process.env.NASSAJ_MIGRATION_DATABASE_CONTRACT_SHA256
        || capability.migrationClosureSha256 !== process.env.NASSAJ_MIGRATION_CLOSURE_SHA256))
      || capability.databaseSha256 !== process.env.NASSAJ_MIGRATION_DATABASE_SHA256) {
    throw new ProviderSecretsKeyError('provider_secrets_capability_invalid');
  }
  return capability;
}

function createKeyFile(filePath, expectedUid) {
  const generated = crypto.randomBytes(KEY_BYTES);
  let descriptor;
  try {
    descriptor = fs.openSync(
      filePath,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
      KEY_MODE,
    );
  } catch (error) {
    if (error?.code === 'EEXIST') return readKeyFromPinnedDescriptor(filePath, expectedUid);
    throw new ProviderSecretsKeyError('provider_secrets_key_create_failed');
  }
  try {
    fs.fchmodSync(descriptor, KEY_MODE);
    let offset = 0;
    while (offset < generated.length) {
      offset += fs.writeSync(descriptor, generated, offset, generated.length - offset, offset);
    }
    fs.fsyncSync(descriptor);
    validateKeyFileStat(fs.fstatSync(descriptor), expectedUid);
  } catch (error) {
    throw error instanceof ProviderSecretsKeyError
      ? error
      : new ProviderSecretsKeyError('provider_secrets_key_create_failed');
  } finally {
    fs.closeSync(descriptor);
  }
  return readKeyFromPinnedDescriptor(filePath, expectedUid);
}

/** Loads one FD-bound server key; an existing insecure/corrupt file is never replaced. */
export function loadProviderSecretsKeyFile({
  filePath,
  expectedUid = process.geteuid?.() ?? process.getuid?.(),
  createIfMissing = true,
} = {}) {
  if (typeof filePath !== 'string' || !path.isAbsolute(filePath) || !Number.isInteger(expectedUid)) {
    throw new ProviderSecretsKeyError('provider_secrets_key_config_invalid');
  }
  try {
    return readKeyFromPinnedDescriptor(filePath, expectedUid);
  } catch (error) {
    if (
      error instanceof ProviderSecretsKeyError
      && error.code === 'provider_secrets_key_file_unavailable'
      && createIfMissing
      && !fs.existsSync(filePath)
    ) {
      return createKeyFile(filePath, expectedUid);
    }
    throw error;
  }
}

/** Shared cached key source for provider files and database credential envelopes. */
export function getProviderSecretsKey() {
  const capabilityFd = process.env[CAPABILITY_FD_ENV];
  const inheritedFd = process.env[KEY_FD_ENV];
  const configured = process.env[KEY_ENV];
  const source = capabilityFd !== undefined ? `capability-fd:${capabilityFd}`
    : inheritedFd !== undefined ? `fd:${inheritedFd}` : configured === undefined
    ? `file:${path.join(os.homedir(), '.nassaj-provider-secrets.key')}`
    : `env:${configured}`;
  if (cached?.source === source) return Buffer.from(cached.key);

  let key;
  if (capabilityFd !== undefined) {
    if (!/^\d+$/.test(capabilityFd)) throw new ProviderSecretsKeyError('provider_secrets_capability_fd_invalid');
    const capability = readMigrationCapability(Number(capabilityFd), process.geteuid?.() ?? process.getuid?.());
    key = readKeyFromInheritedDescriptor(capability.providerSecretsKeyFd, process.geteuid?.() ?? process.getuid?.());
  } else if (process.env.NASSAJ_MIGRATION_ONLY === '1') {
    throw new ProviderSecretsKeyError('provider_secrets_migration_capability_required');
  } else if (inheritedFd !== undefined) {
    if (!/^\d+$/.test(inheritedFd)) throw new ProviderSecretsKeyError('provider_secrets_key_fd_invalid');
    key = readKeyFromInheritedDescriptor(Number(inheritedFd), process.geteuid?.() ?? process.getuid?.());
  } else if (configured !== undefined) {
    key = decodeConfiguredKey(configured);
    if (!key) throw new ProviderSecretsKeyError('provider_secrets_key_env_invalid');
  } else {
    key = loadProviderSecretsKeyFile({
      filePath: path.join(os.homedir(), '.nassaj-provider-secrets.key'),
    });
  }
  cached = { source, key: Buffer.from(key) };
  return Buffer.from(key);
}

export function resetProviderSecretsKeyCacheForTests() {
  cached?.key?.fill(0);
  cached = null;
}
