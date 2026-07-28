/**
 * provider-secrets-store — encrypted per-user store for hosted-vendor API keys.
 *
 * B-VR-2A. The isolation seam (resolve-provider-env.js) only sets per-user
 * CONFIG_DIR/HOME paths so each first-party CLI reads credentials from its own
 * isolated tree. That is enough for claude/gemini/codex/agy, but the hosted
 * vendor providers (kimi/deepseek/glm) are third-party HTTP APIs that read no
 * nassaj config tree — their key must be handed to the child process as an
 * explicit env value. This store holds those keys, encrypted at rest, isolated
 * per user, so resolveProviderEnv can decrypt and inject the right key per spawn.
 *
 * Design:
 *   - AES-256-GCM (node:crypto), random 12-byte IV per record, 16-byte auth tag.
 *     The stored ciphertext is `v1:<iv_b64>:<tag_b64>:<ct_b64>` so the version,
 *     IV, and tag travel with every value and a tampered record fails to decrypt.
 *   - Server key (32 bytes) lives OUTSIDE the repo. Resolution order:
 *       1. NASSAJ_PROVIDER_SECRETS_KEY env — base64 or hex of exactly 32 bytes.
 *       2. A 0600 key file at ~/.nassaj-provider-secrets.key (raw 32 bytes),
 *          auto-generated with crypto.randomBytes on first use if absent.
 *     The key is never written to logs.
 *   - Storage: one JSON file per user under the isolated tree
 *       ~/.nassaj-users/<userId>/.provider-secrets/keys.json   (dir 0700, file 0600)
 *     When userId is null/empty (single-user / system mode) the store falls back
 *     to a shared file under the home root (~/.nassaj-provider-secrets/keys.json)
 *     so the single-operator install keeps one key set — mirroring how
 *     resolveProviderEnv returns the base env for an unauthenticated caller.
 *
 * Logging rule: this module never logs a decrypted key, an encrypted blob, or
 * the server key. Errors log only the provider/user and an error message.
 *
 * @typedef {'kimi'|'deepseek'|'glm'} VendorProvider
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ALGORITHM = 'aes-256-gcm';
const KEY_BYTES = 32;
const IV_BYTES = 12;
const VERSION = 'v1';
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

/** Env var that may carry the server key as base64 or hex of 32 bytes. */
const KEY_ENV = 'NASSAJ_PROVIDER_SECRETS_KEY';

/** Providers whose keys this store manages. Any other id is rejected on write. */
export const VENDOR_SECRET_PROVIDERS = Object.freeze(['kimi', 'deepseek', 'glm']);

/**
 * Process-level cache of the resolved 32-byte server key. Holds only the key
 * buffer — never a plaintext provider key.
 * @type {Buffer|null}
 */
let serverKeyCache = null;

/** Path of the auto-generated server key file (raw 32 bytes, 0600). */
function serverKeyFilePath() {
  return path.join(os.homedir(), '.nassaj-provider-secrets.key');
}

/**
 * Decodes a server key supplied via env. Accepts base64 or hex; returns the
 * 32-byte buffer or null when the value is absent/malformed/wrong length.
 * @param {string|undefined} raw
 * @returns {Buffer|null}
 */
function decodeEnvServerKey(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') {
    return null;
  }
  const value = raw.trim();
  // Try hex first when the string is exactly 64 hex chars, else base64.
  if (/^[0-9a-fA-F]{64}$/.test(value)) {
    const buf = Buffer.from(value, 'hex');
    return buf.length === KEY_BYTES ? buf : null;
  }
  try {
    const buf = Buffer.from(value, 'base64');
    return buf.length === KEY_BYTES ? buf : null;
  } catch {
    return null;
  }
}

/**
 * Reads (or lazily creates) the 32-byte server key file. The file is created
 * with 0600 and its parent left as the user's home. Returns the key buffer.
 * @returns {Buffer}
 */
function loadOrCreateServerKeyFile() {
  const filePath = serverKeyFilePath();
  try {
    const existing = fs.readFileSync(filePath);
    if (existing.length === KEY_BYTES) {
      return existing;
    }
    // Wrong length (corrupt/truncated): regenerate rather than fail every spawn.
  } catch {
    // Missing file is the normal first-run case; fall through to create it.
  }

  const generated = crypto.randomBytes(KEY_BYTES);
  // wx is unnecessary here (we already tolerate overwrite of a corrupt file),
  // but the restrictive mode is mandatory: the key must never be world/group
  // readable.
  fs.writeFileSync(filePath, generated, { mode: FILE_MODE });
  try {
    fs.chmodSync(filePath, FILE_MODE);
  } catch {
    // chmod can fail on exotic filesystems; the create mode above is the primary
    // guarantee. Do not block on it.
  }
  return generated;
}

/**
 * Resolves the AES server key once per process. Env wins over the key file so an
 * operator can pin a managed key without touching the home directory.
 * @returns {Buffer}
 */
function getServerKey() {
  if (serverKeyCache) {
    return serverKeyCache;
  }
  const fromEnv = decodeEnvServerKey(process.env[KEY_ENV]);
  serverKeyCache = fromEnv ?? loadOrCreateServerKeyFile();
  return serverKeyCache;
}

/**
 * Encrypts a plaintext key into the versioned `v1:iv:tag:ct` envelope.
 * @param {string} plaintext
 * @returns {string}
 */
function encrypt(plaintext) {
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGORITHM, getServerKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${VERSION}:${iv.toString('base64')}:${tag.toString('base64')}:${ciphertext.toString('base64')}`;
}

/**
 * Decrypts a `v1:iv:tag:ct` envelope back to the plaintext key. Returns null for
 * any malformed/tampered/unsupported record instead of throwing, so a corrupt
 * store degrades to "no key" rather than crashing a spawn.
 * @param {unknown} envelope
 * @returns {string|null}
 */
function decrypt(envelope) {
  if (typeof envelope !== 'string') {
    return null;
  }
  const parts = envelope.split(':');
  if (parts.length !== 4 || parts[0] !== VERSION) {
    return null;
  }
  try {
    const iv = Buffer.from(parts[1], 'base64');
    const tag = Buffer.from(parts[2], 'base64');
    const ciphertext = Buffer.from(parts[3], 'base64');
    if (iv.length !== IV_BYTES) {
      return null;
    }
    const decipher = crypto.createDecipheriv(ALGORITHM, getServerKey(), iv);
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return plaintext.toString('utf8');
  } catch {
    // Wrong key, tampered tag, or truncated record — all map to "no usable key".
    return null;
  }
}

/** Root of all per-user isolated config trees (mirrors provision-user-dirs). */
function usersRoot() {
  return path.join(os.homedir(), '.nassaj-users');
}

/**
 * Resolves the secrets directory for a user. A null/empty userId resolves to a
 * single shared directory under the home root (single-user / system mode).
 * @param {string|number|null|undefined} userId
 * @returns {string}
 */
function secretsDir(userId) {
  if (userId === null || userId === undefined || userId === '') {
    return path.join(os.homedir(), '.nassaj-provider-secrets');
  }
  return path.join(usersRoot(), String(userId), '.provider-secrets');
}

/** Absolute path of a user's encrypted keys file. */
function keysFilePath(userId) {
  return path.join(secretsDir(userId), 'keys.json');
}

/**
 * Reads and parses a user's keys file. Returns an empty record when the file is
 * missing or unreadable so callers never have to special-case first use.
 * @param {string|number|null|undefined} userId
 * @returns {Record<string, string>}
 */
function readKeysFile(userId) {
  try {
    const raw = fs.readFileSync(keysFilePath(userId), 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed;
    }
  } catch {
    // Missing/corrupt file: treat as no stored keys.
  }
  return {};
}

/**
 * Writes a user's keys file atomically with restrictive permissions. The parent
 * directory is created at 0700 if absent.
 * @param {string|number|null|undefined} userId
 * @param {Record<string, string>} keys
 */
function writeKeysFile(userId, keys) {
  const dir = secretsDir(userId);
  fs.mkdirSync(dir, { recursive: true, mode: DIR_MODE });
  const filePath = keysFilePath(userId);
  const tmpPath = `${filePath}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  fs.writeFileSync(tmpPath, JSON.stringify(keys, null, 2), { mode: FILE_MODE });
  fs.renameSync(tmpPath, filePath);
  try {
    fs.chmodSync(filePath, FILE_MODE);
  } catch {
    // Non-fatal; the write mode above already restricts the file.
  }
}

/**
 * Validates a provider id against the supported vendor set.
 * @param {string} provider
 * @returns {boolean}
 */
export function isVendorSecretProvider(provider) {
  return VENDOR_SECRET_PROVIDERS.includes(provider);
}

/**
 * Stores (or replaces) the API key for one (userId, provider). The value is
 * encrypted at rest; the plaintext is never persisted or logged.
 *
 * @param {string|number|null|undefined} userId
 * @param {VendorProvider} provider
 * @param {string} apiKey non-empty raw key
 * @returns {{ provider: string, stored: boolean }}
 */
export function setProviderKey(userId, provider, apiKey) {
  if (!isVendorSecretProvider(provider)) {
    throw new Error(`Unsupported secret provider: ${provider}`);
  }
  if (typeof apiKey !== 'string' || apiKey.trim() === '') {
    throw new Error('API key must be a non-empty string');
  }
  const keys = readKeysFile(userId);
  keys[provider] = encrypt(apiKey.trim());
  writeKeysFile(userId, keys);
  return { provider, stored: true };
}

/**
 * Returns the decrypted API key for one (userId, provider), or null when none is
 * stored (or the record is corrupt/undecryptable). Never throws on absence.
 *
 * @param {string|number|null|undefined} userId
 * @param {VendorProvider} provider
 * @returns {string|null}
 */
export function getProviderKey(userId, provider) {
  if (!isVendorSecretProvider(provider)) {
    return null;
  }
  const keys = readKeysFile(userId);
  return decrypt(keys[provider]);
}

/**
 * Reports whether a usable (decryptable) key is stored for one (userId, provider)
 * without returning the secret. Used by the auth facet to report status.
 *
 * @param {string|number|null|undefined} userId
 * @param {VendorProvider} provider
 * @returns {boolean}
 */
export function hasProviderKey(userId, provider) {
  return getProviderKey(userId, provider) !== null;
}

/**
 * Deletes the stored key for one (userId, provider). Returns whether a record was
 * removed. Idempotent.
 *
 * @param {string|number|null|undefined} userId
 * @param {VendorProvider} provider
 * @returns {{ provider: string, removed: boolean }}
 */
export function deleteProviderKey(userId, provider) {
  if (!isVendorSecretProvider(provider)) {
    return { provider, removed: false };
  }
  const keys = readKeysFile(userId);
  const removed = Object.prototype.hasOwnProperty.call(keys, provider);
  if (removed) {
    delete keys[provider];
    writeKeysFile(userId, keys);
  }
  return { provider, removed };
}

/**
 * Lists the vendor providers that currently have a usable key for a user. Returns
 * only ids, never secret material — safe to return to a client.
 *
 * @param {string|number|null|undefined} userId
 * @returns {string[]}
 */
export function listProviderKeys(userId) {
  return VENDOR_SECRET_PROVIDERS.filter((provider) => hasProviderKey(userId, provider));
}

/**
 * Test/diagnostic hook: drop the in-process server-key cache so the next call
 * re-resolves it (e.g. after a test sets/changes NASSAJ_PROVIDER_SECRETS_KEY).
 * Not used on the request path.
 */
export function _resetProviderSecretsServerKeyCache() {
  serverKeyCache = null;
}
