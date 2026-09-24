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
 * @typedef {'kimi'|'deepseek'|'glm'|'qwen'} VendorProvider
 * @typedef {'vendor'|'connector'|'speech'|'local-model'} SecretNamespace
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  getProviderSecretsKey,
  resetProviderSecretsKeyCacheForTests,
} from './provider-secrets-key-manager.js';

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;
const VERSION = 'v1';
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

/** Providers whose keys this store manages. Any other id is rejected on write. */
export const VENDOR_SECRET_PROVIDERS = Object.freeze(['kimi', 'deepseek', 'glm', 'qwen']);

/**
 * The one legitimate non-user scope: the operator-wide secret set shared by runs
 * that have no authenticated user (system tasks, unauthenticated single-user
 * mode). Written out at the call site so "no identity here" is a decision on the
 * record instead of a `null` nobody notices — see {@link secretsDir}.
 *
 * T-1260 — WHY THIS IS NO LONGER CALLED `SYSTEM_SCOPE`, AND WHY THE VENDOR KEY
 * API REFUSES IT. The old name was exported to eighteen call sites, twelve of
 * which spelled `getProviderKey(userId ?? SYSTEM_SCOPE, …)`. That idiom makes
 * "run on the operator's key" a fallback nobody declared and nobody can audit:
 * whether a slot is shared then depends on which of eighteen files you are
 * reading. Sharing a credential is a decision that must live in ONE place
 * (`resolveSlotKey`, provider-slot-key.js), so:
 *
 *   • this constant now names only what it is still legitimate for — NAMESPACED
 *     secrets (connector/speech), whose operator-wide scope is a first-class,
 *     UI-selected choice (see voice-transcription.service.ts);
 *   • the VENDOR slot API ({@link getProviderKey} and friends) THROWS when handed
 *     it — the operator-wide vendor store is reachable only through the
 *     `…SharedVendorKey` accessors below;
 *   • the rename is the enforcement. Every unconverted site fails to link
 *     (Node ESM) or to compile (tsc), instead of being missed by a reviewer.
 */
export const SYSTEM_SECRET_SCOPE = '__system__';

/**
 * Same directory, different policy domain: the operator-wide VENDOR slot. Kept
 * module-private on purpose — a caller that could name this scope could re-create
 * the `?? SYSTEM_SCOPE` idiom the rename exists to abolish.
 */
const SHARED_VENDOR_SCOPE = SYSTEM_SECRET_SCOPE;

/**
 * Process-level cache of the resolved 32-byte server key. Holds only the key
 * buffer — never a plaintext provider key.
 * @type {Buffer|null}
 */
/**
 * Encrypts a plaintext key into the versioned `v1:iv:tag:ct` envelope.
 * @param {string} plaintext
 * @returns {string}
 */
function encrypt(plaintext) {
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGORITHM, getProviderSecretsKey(), iv);
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
    const decipher = crypto.createDecipheriv(ALGORITHM, getProviderSecretsKey(), iv);
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
 * Resolves the secrets directory for a scope.
 *
 * T-1122 — WHY AN IMPLICIT SCOPE IS AN ERROR NOW. This used to accept
 * null/undefined/'' and silently resolve them to the shared system store. That
 * looked harmless and cost a real outage: the vendor catalog clients read their
 * key with a hardcoded `null` written when nassaj was single-user, so after
 * multi-user landed they looked in a directory that does not exist, found no
 * key, and served a frozen fallback catalog — no error, no log, just models the
 * operator could not select (B-342). A missing identity is a bug at the CALL
 * SITE; only code that genuinely means "the operator-wide store" may say so, and
 * it must say so out loud with {@link SYSTEM_SECRET_SCOPE}.
 *
 * The guard is deterministic in every environment on purpose: `.env` carries
 * `NODE_ENV=production`, so a dev-only throw would never fire where it matters.
 *
 * @param {string|number|typeof SYSTEM_SECRET_SCOPE} scope
 * @returns {void}
 * @throws {TypeError} when the scope is implicit (null/undefined/'')
 */
function assertScope(scope) {
  if (scope === SYSTEM_SECRET_SCOPE) {
    return;
  }
  if (scope === null || scope === undefined || scope === '') {
    throw new TypeError(
      'provider-secrets-store: a userId is required. Pass SYSTEM_SECRET_SCOPE explicitly for the operator-wide store.',
    );
  }
}

/**
 * The vendor-slot variant of {@link assertScope}: a member id and nothing else.
 *
 * T-1260. The operator-wide vendor slot is not addressable from a call site any
 * more, because "whose key is this turn spending?" is exactly the question
 * `resolveSlotKey` was created to own. A caller that still names the system
 * scope here is not making a shared-key decision — it is reproducing the
 * undeclared fallback, so it fails loudly rather than quietly resolving.
 *
 * @param {string|number} scope
 * @returns {void}
 * @throws {TypeError} on an implicit scope, or on the operator-wide scope
 */
function assertMemberScope(scope) {
  if (scope === SHARED_VENDOR_SCOPE) {
    throw new TypeError(
      'provider-secrets-store: vendor slot keys are member-scoped. The operator-wide slot is '
        + 'reachable only through resolveSlotKey (services/isolation/provider-slot-key.js).',
    );
  }
  assertScope(scope);
}

/** Local-model credentials belong to an authenticated member, never shared scope. */
function assertLocalModelScope(scope) {
  if (scope === SYSTEM_SECRET_SCOPE) {
    throw new TypeError('provider-secrets-store: local-model secrets are member-scoped.');
  }
  assertScope(scope);
}

function secretsDir(scope) {
  if (scope === SYSTEM_SECRET_SCOPE) {
    return path.join(os.homedir(), '.nassaj-provider-secrets');
  }
  if (scope === null || scope === undefined || scope === '') {
    throw new TypeError(
      'provider-secrets-store: a userId is required. Pass SYSTEM_SECRET_SCOPE explicitly for the operator-wide store.',
    );
  }
  return path.join(usersRoot(), String(scope), '.provider-secrets');
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
 * The namespaces this store partitions secrets into (T-1225, ADR-098).
 *
 * WHY A NAMESPACE AND NOT A SECOND STORE. External connectors (Canva, Google,
 * Wafeq…) need exactly what the vendor keys already have: AES-256-GCM at rest, a
 * 0600 file inside the member's own isolated tree, and a server key that lives
 * outside the repo. Standing up a parallel store would duplicate all three and
 * give the duplicate its own bugs. What actually blocked reuse was one line —
 * `VENDOR_SECRET_PROVIDERS` is a closed whitelist that rejects any id outside
 * kimi/deepseek/glm on write. So the fix is to widen the KEY, not the crypto.
 *
 * WHY VENDOR KEYS STAY UNPREFIXED. `keys.json` on disk today is keyed by the bare
 * provider id (`{"kimi": "v1:…"}`). Prefixing them to `vendor:kimi` would be a
 * migration over live encrypted material in every member tree, for zero gain: the
 * legacy shape is already unambiguous because a connector key is always prefixed.
 * `storageKeyFor` therefore maps 'vendor' to the bare id — every existing file
 * keeps working with no migration step and no first-run rewrite.
 *
 * 'speech' (ADR-103 / T-1246) is the same argument one step further: the Whisper
 * key needs identical crypto, identical 0600 isolation, and — unlike a connector
 * — NO registry row at all, because there is nothing to register: one id
 * ('whisper'), two possible scopes (the operator-wide store, or one member's own
 * tree). Reusing 'vendor' was not an option either: that list is a closed
 * whitelist of CLI vendors, and widening it would let a speech key be handed to
 * a spawn as a vendor credential.
 */
export const SECRET_NAMESPACES = Object.freeze(['vendor', 'connector', 'speech', 'local-model']);

/**
 * Secret ids become a path-free segment of a JSON key, never a filename — but
 * they are still attacker-adjacent input (an owner types them), and a ':' inside
 * one would let `connector:a:b` collide with a different (namespace, id) pair.
 * Restricting to a conservative slug charset removes that whole question.
 */
const SECRET_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;

/**
 * Builds the on-disk key for one (namespace, id) pair.
 *
 * @param {SecretNamespace} namespace
 * @param {string} id
 * @returns {string}
 * @throws {Error} on an unknown namespace or a malformed id
 */
function storageKeyFor(namespace, id) {
  if (!SECRET_NAMESPACES.includes(namespace)) {
    throw new Error(`Unsupported secret namespace: ${namespace}`);
  }
  if (namespace === 'vendor') {
    if (!isVendorSecretProvider(id)) {
      throw new Error(`Unsupported secret provider: ${id}`);
    }
    // Legacy shape, deliberately unprefixed — see SECRET_NAMESPACES.
    return id;
  }
  if (typeof id !== 'string' || !SECRET_ID_PATTERN.test(id)) {
    throw new Error('Secret id must match [a-zA-Z0-9][a-zA-Z0-9._-]{0,63}');
  }
  return `${namespace}:${id}`;
}

/**
 * Stores (or replaces) one secret under an explicit namespace. Same envelope and
 * same file as the vendor keys; only the record key differs.
 *
 * Returns existence only — the plaintext is never echoed back, logged, or kept.
 *
 * @param {string|number|typeof SYSTEM_SECRET_SCOPE} scope
 * @param {SecretNamespace} namespace
 * @param {string} id
 * @param {string} secret non-empty raw secret
 * @returns {{ namespace: string, id: string, stored: boolean }}
 */
export function setNamespacedSecret(scope, namespace, id, secret) {
  assertScope(scope);
  const storageKey = storageKeyFor(namespace, id);
  if (typeof secret !== 'string' || secret.trim() === '') {
    throw new Error('Secret must be a non-empty string');
  }
  const keys = readKeysFile(scope);
  keys[storageKey] = encrypt(secret.trim());
  writeKeysFile(scope, keys);
  return { namespace, id, stored: true };
}

/**
 * Returns the decrypted secret for one (scope, namespace, id), or null when none
 * is stored or the record is corrupt. Never throws on absence — a missing secret
 * must degrade to "not configured", not to a failed spawn.
 *
 * A malformed id/namespace DOES throw, because that is a call-site bug rather
 * than a state of the store, and swallowing it would recreate B-342 (a hardcoded
 * wrong scope that read an empty directory and reported "no key" forever).
 *
 * @param {string|number|typeof SYSTEM_SECRET_SCOPE} scope
 * @param {SecretNamespace} namespace
 * @param {string} id
 * @returns {string|null}
 */
export function getNamespacedSecret(scope, namespace, id) {
  assertScope(scope);
  const storageKey = storageKeyFor(namespace, id);
  return decrypt(readKeysFile(scope)[storageKey]);
}

/**
 * Existence check that never surfaces the secret. This is what routes and status
 * endpoints report.
 *
 * @param {string|number|typeof SYSTEM_SECRET_SCOPE} scope
 * @param {SecretNamespace} namespace
 * @param {string} id
 * @returns {boolean}
 */
export function hasNamespacedSecret(scope, namespace, id) {
  return getNamespacedSecret(scope, namespace, id) !== null;
}

/**
 * Deletes one namespaced secret. Idempotent.
 *
 * @param {string|number|typeof SYSTEM_SECRET_SCOPE} scope
 * @param {SecretNamespace} namespace
 * @param {string} id
 * @returns {{ namespace: string, id: string, removed: boolean }}
 */
export function deleteNamespacedSecret(scope, namespace, id) {
  assertScope(scope);
  const storageKey = storageKeyFor(namespace, id);
  const keys = readKeysFile(scope);
  const removed = Object.prototype.hasOwnProperty.call(keys, storageKey);
  if (removed) {
    delete keys[storageKey];
    writeKeysFile(scope, keys);
  }
  return { namespace, id, removed };
}

/**
 * Member-scoped capability for local-model credentials. The namespace is fixed
 * here so a local-model caller cannot select the connector credential domain.
 *
 * @param {string|number} userId
 * @param {string} serverId
 * @param {string} secret
 * @returns {{ namespace: string, id: string, stored: boolean }}
 */
export function setLocalModelSecret(userId, serverId, secret) {
  assertLocalModelScope(userId);
  return setNamespacedSecret(userId, 'local-model', serverId, secret);
}

/**
 * Reads one member's local-model credential without exposing another namespace.
 * @param {string|number} userId
 * @param {string} serverId
 * @returns {string|null}
 */
export function getLocalModelSecret(userId, serverId) {
  assertLocalModelScope(userId);
  return getNamespacedSecret(userId, 'local-model', serverId);
}

/**
 * Reports whether one member has a usable local-model credential.
 * @param {string|number} userId
 * @param {string} serverId
 * @returns {boolean}
 */
export function hasLocalModelSecret(userId, serverId) {
  return getLocalModelSecret(userId, serverId) !== null;
}

/**
 * Deletes one member's local-model credential without accepting a namespace.
 * @param {string|number} userId
 * @param {string} serverId
 * @returns {{ namespace: string, id: string, removed: boolean }}
 */
export function deleteLocalModelSecret(userId, serverId) {
  assertLocalModelScope(userId);
  return deleteNamespacedSecret(userId, 'local-model', serverId);
}

/**
 * Lists the connector ids that currently hold a usable secret for a scope.
 * Returns ids only, never secret material — safe to hand to a client.
 *
 * Records that fail to decrypt are omitted rather than reported as present: a
 * connector whose material is undecryptable is not configured in any sense the
 * caller can act on.
 *
 * @param {string|number|typeof SYSTEM_SECRET_SCOPE} scope
 * @returns {string[]}
 */
export function listConnectorSecrets(scope) {
  assertScope(scope);
  const keys = readKeysFile(scope);
  return Object.keys(keys)
    .filter((key) => key.startsWith('connector:'))
    .map((key) => key.slice('connector:'.length))
    .filter((id) => SECRET_ID_PATTERN.test(id) && decrypt(keys[`connector:${id}`]) !== null);
}

/**
 * Scope-agnostic vendor primitives. Every exported vendor function below is one
 * of these three plus a scope policy — which keeps the crypto/IO in one place and
 * makes the member-vs-shared distinction purely a matter of which scope is used.
 */
function writeVendorKey(scope, provider, apiKey) {
  if (!isVendorSecretProvider(provider)) {
    throw new Error(`Unsupported secret provider: ${provider}`);
  }
  if (typeof apiKey !== 'string' || apiKey.trim() === '') {
    throw new Error('API key must be a non-empty string');
  }
  const keys = readKeysFile(scope);
  keys[provider] = encrypt(apiKey.trim());
  writeKeysFile(scope, keys);
  return { provider, stored: true };
}

function readVendorKey(scope, provider) {
  if (!isVendorSecretProvider(provider)) {
    return null;
  }
  return decrypt(readKeysFile(scope)[provider]);
}

function removeVendorKey(scope, provider) {
  if (!isVendorSecretProvider(provider)) {
    return { provider, removed: false };
  }
  const keys = readKeysFile(scope);
  const removed = Object.prototype.hasOwnProperty.call(keys, provider);
  if (removed) {
    delete keys[provider];
    writeKeysFile(scope, keys);
  }
  return { provider, removed };
}

/**
 * Stores (or replaces) the API key for one (member, provider). The value is
 * encrypted at rest; the plaintext is never persisted or logged.
 *
 * @param {string|number} userId a MEMBER id — see {@link assertMemberScope}
 * @param {VendorProvider} provider
 * @param {string} apiKey non-empty raw key
 * @returns {{ provider: string, stored: boolean }}
 */
export function setProviderKey(userId, provider, apiKey) {
  assertMemberScope(userId);
  return writeVendorKey(userId, provider, apiKey);
}

/**
 * Returns the decrypted API key for one (member, provider), or null when none is
 * stored (or the record is corrupt/undecryptable). Never throws on absence.
 *
 * Reads the MEMBER's own slot and nothing else. Callers that mean "this member's
 * key, or the operator's if they have none" must say so through `resolveSlotKey`
 * — that precedence is a sharing decision, not a storage detail.
 *
 * @param {string|number} userId
 * @param {VendorProvider} provider
 * @returns {string|null}
 */
export function getProviderKey(userId, provider) {
  // Asserted BEFORE the provider check and outside readKeysFile: that helper
  // swallows every filesystem error to mean "no keys yet", so a guard left
  // inside it would be caught and turned back into the silence it exists to end.
  assertMemberScope(userId);
  return readVendorKey(userId, provider);
}

/**
 * Reports whether a usable (decryptable) key is stored for one (member,
 * provider) without returning the secret. Used by the auth facet to report
 * status.
 *
 * @param {string|number} userId
 * @param {VendorProvider} provider
 * @returns {boolean}
 */
export function hasProviderKey(userId, provider) {
  return getProviderKey(userId, provider) !== null;
}

/**
 * Deletes the stored key for one (member, provider). Returns whether a record was
 * removed. Idempotent.
 *
 * @param {string|number} userId
 * @param {VendorProvider} provider
 * @returns {{ provider: string, removed: boolean }}
 */
export function deleteProviderKey(userId, provider) {
  assertMemberScope(userId);
  return removeVendorKey(userId, provider);
}

/**
 * Lists the vendor providers that currently have a usable key for a member.
 * Returns only ids, never secret material — safe to return to a client.
 *
 * @param {string|number} userId
 * @returns {string[]}
 */
export function listProviderKeys(userId) {
  return VENDOR_SECRET_PROVIDERS.filter((provider) => hasProviderKey(userId, provider));
}

// ---------------------------------------------------------------------------
// Operator-wide (shared) vendor slot — @internal
//
// The ONLY door to the operator-wide vendor store. Import restrictions (see
// eslint.config.js) confine the READ accessors to provider-slot-key.js, which is
// the single decision function for member-vs-shared precedence, and the WRITE
// accessors to provider-secrets.service.ts, the one place a key is stored.
//
// These are deliberately not parameterised by scope: a function that takes a
// scope invites `?? SHARED` at the call site, which is the exact idiom T-1260
// removes.
// ---------------------------------------------------------------------------

/**
 * @internal Only services/isolation/provider-slot-key.js may call this.
 * @param {VendorProvider} provider
 * @returns {string|null}
 */
export function getSharedVendorKey(provider) {
  if (provider === 'qwen') {
    throw new Error('Qwen Coding Plan has no shared credential slot');
  }
  return readVendorKey(SHARED_VENDOR_SCOPE, provider);
}

/**
 * @internal Only modules/providers/services/provider-secrets.service.ts.
 * @param {VendorProvider} provider
 * @param {string} apiKey
 * @returns {{ provider: string, stored: boolean }}
 */
export function setSharedVendorKey(provider, apiKey) {
  if (provider === 'qwen') {
    throw new Error('Qwen Coding Plan has no shared credential slot');
  }
  return writeVendorKey(SHARED_VENDOR_SCOPE, provider, apiKey);
}

/**
 * @internal Only modules/providers/services/provider-secrets.service.ts.
 * @param {VendorProvider} provider
 * @returns {{ provider: string, removed: boolean }}
 */
export function deleteSharedVendorKey(provider) {
  if (provider === 'qwen') {
    throw new Error('Qwen Coding Plan has no shared credential slot');
  }
  return removeVendorKey(SHARED_VENDOR_SCOPE, provider);
}

/**
 * Test/diagnostic hook: drop the in-process server-key cache so the next call
 * re-resolves it (e.g. after a test sets/changes NASSAJ_PROVIDER_SECRETS_KEY).
 * Not used on the request path.
 */
export function _resetProviderSecretsServerKeyCache() {
  resetProviderSecretsKeyCacheForTests();
}
