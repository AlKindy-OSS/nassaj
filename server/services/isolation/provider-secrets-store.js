/**
 * provider-secrets-store — encrypted per-user store for hosted-vendor API keys.
 *
 * B-VR-2A. The isolation seam (resolve-provider-env.js) only sets per-user
 * CONFIG_DIR/HOME paths so each first-party CLI reads credentials from its own
 * isolated tree. That is enough for claude/codex/agy, but the hosted
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

import { isClaudeSubscriptionToken } from '../../../shared/claudeSubscriptionToken.js';
import {
  CANONICAL_VENDOR_IDS,
  CANONICAL_VENDOR_SECRET_PREFIX,
  VENDOR_KEY_CATALOGUE,
} from '../../../shared/vendors.js';

import {
  PROVIDER_SECRETS_STORE_REPAIR_MESSAGE,
  PROVIDER_SECRETS_STORE_UNREADABLE,
} from './provider-secrets-store.codes.js';
import {
  getProviderSecretsKey,
  providerSecretsKeyGeneratedAt,
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
 * entry reads as "no key" on display and secret-lookup paths. The link-mode
 * run gate does not rely on this: it reports a null here as `unreadable`
 * (B-1547), and writers refuse a corrupt keys file (see mutateKeysFile).
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

/** Every keys.json on disk: the operator-wide store and each member's. */
function listKeysFiles() {
  const files = [path.join(secretsDir(SYSTEM_SECRET_SCOPE), 'keys.json')];
  let members = [];
  try {
    members = fs.readdirSync(usersRoot());
  } catch {
    members = [];
  }
  for (const member of members) files.push(path.join(usersRoot(), member, '.provider-secrets', 'keys.json'));
  return files.filter((file) => fs.existsSync(file));
}

/**
 * B-1575: true when this process generated the server key while keys.json files
 * written before that exist — they were sealed under another key, so nothing
 * may be adopted or backed up now. Loads the key (it may throw).
 * @returns {boolean}
 */
export function isServerKeyFreshOverExistingStore() {
  getProviderSecretsKey();
  const generatedAt = providerSecretsKeyGeneratedAt();
  if (generatedAt === null) return false;
  return listKeysFiles().some((file) => {
    try {
      return fs.statSync(file).mtimeMs < generatedAt;
    } catch {
      return false;
    }
  });
}

/** Absolute path of a user's encrypted keys file. */
function keysFilePath(userId) {
  return path.join(secretsDir(userId), 'keys.json');
}

/**
 * Reads and parses a user's keys file for READ paths only. Returns an empty
 * record when the file is missing or unreadable, so a lookup degrades to "no
 * key". Never feed its result back into writeKeysFile: every writer goes
 * through {@link mutateKeysFile} (B-1547).
 * @param {string|number|null|undefined} userId
 * @returns {Record<string, string>}
 */
function readKeysFile(userId) {
  return readKeysFileState(userId).keys;
}

/**
 * Reads a user's keys file and says whether it was absent, parsed, or present
 * but unreadable (I/O error, invalid JSON, non-object). B-1547: the link-mode
 * run gate must not treat a corrupt file as "no record".
 * @param {string|number|null|undefined} userId
 * @returns {{ state: 'absent'|'ok'|'unreadable', keys: Record<string, string> }}
 */
function readKeysFileState(userId) {
  let raw;
  try {
    raw = fs.readFileSync(keysFilePath(userId), 'utf8');
  } catch (error) {
    return { state: error?.code === 'ENOENT' ? 'absent' : 'unreadable', keys: {} };
  }
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return { state: 'ok', keys: parsed };
    }
  } catch {
    // Corrupt file: reported as unreadable, never as "no keys".
  }
  return { state: 'unreadable', keys: {} };
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

export { PROVIDER_SECRETS_STORE_REPAIR_MESSAGE, PROVIDER_SECRETS_STORE_UNREADABLE };

/**
 * Thrown by every keys-file writer when the file exists but cannot be read.
 * Plain Error (this module also loads outside the server, e.g. scripts/); the
 * HTTP layer maps it to a 409 AppError via provider-secrets-store.errors.ts.
 */
export class ProviderSecretsStoreUnreadableError extends Error {
  constructor() {
    super(PROVIDER_SECRETS_STORE_REPAIR_MESSAGE);
    this.name = 'ProviderSecretsStoreUnreadableError';
    this.code = PROVIDER_SECRETS_STORE_UNREADABLE;
  }
}

/**
 * The only way to change a keys file. Reads it with its state and refuses when
 * it is present but unreadable: rewriting from an empty record would silently
 * drop every other secret in it and turn an unreadable link-mode record into
 * an absent one (B-1547, D6). `mutate` edits the record in place and returns
 * whether anything changed; the file is rewritten only then.
 * @template T
 * @param {string|number|null|undefined} scope
 * @param {(keys: Record<string, string>) => { changed: boolean, result: T }} mutate
 * @returns {T}
 */
function mutateKeysFile(scope, mutate) {
  const file = readKeysFileState(scope);
  if (file.state === 'unreadable') throw new ProviderSecretsStoreUnreadableError();
  const { changed, result } = mutate(file.keys);
  if (changed) writeKeysFile(scope, file.keys);
  return result;
}

/** mutateKeysFile body that sets one entry. */
function putEntry(storageKey, envelope) {
  return (keys) => {
    keys[storageKey] = envelope;
    return { changed: true, result: undefined };
  };
}

/** mutateKeysFile body that removes one entry; result = whether it existed. */
function dropEntry(storageKey) {
  return (keys) => {
    const removed = Object.prototype.hasOwnProperty.call(keys, storageKey);
    if (removed) delete keys[storageKey];
    return { changed: removed, result: removed };
  };
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
  mutateKeysFile(scope, putEntry(storageKey, encrypt(secret.trim())));
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
  const removed = mutateKeysFile(scope, dropEntry(storageKey));
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

// ---------------------------------------------------------------------------
// ADR-200 S1 — canonical vendor records (`vendor:anthropic|openai|openrouter`).
//
// A separate on-disk key space on purpose: the legacy vendor slots are BARE ids
// (`kimi`) and every slot reader (`resolveProviderEnv`, `resolveSlotKey`,
// `delegate_to_vendor`) goes through `isVendorSecretProvider`, which rejects
// these ids — and no namespace reaches the `vendor:` prefix, because 'vendor'
// maps to the bare form. These accessors are the only door, member-scoped only.
//
// In-flag: a write is refused while NASSAJ_UNIFIED_VENDOR_KEYS is off, so this
// stage changes no behaviour. Read and delete stay open: the legacy delete path
// must be able to clear a record a flag-on period left behind (ADR-200 §3).
// ---------------------------------------------------------------------------

/** The fleet flag of the unified vendor-key model (default ON since ADR-200 S10; `0` is the kill switch). */
export const UNIFIED_VENDOR_KEYS_FLAG = 'NASSAJ_UNIFIED_VENDOR_KEYS';

/**
 * ADR-200 S10: ON when unset or blank. An explicit `1/true/yes/on` is ON; an
 * explicit `0/false/no/off` is the kill switch, and so is any other value (a
 * mistyped kill switch must not leave the model armed).
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {boolean} whether the unified vendor-key flag is armed
 */
export function isUnifiedVendorKeysEnabled(env = process.env) {
  const raw = env?.[UNIFIED_VENDOR_KEYS_FLAG];
  if (typeof raw !== 'string' || raw.trim() === '') return true;
  const normalized = raw.trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
}

/**
 * True for a canonical vendor id in either spelling (`anthropic` or
 * `vendor:anthropic`). Slot readers use it to refuse such an id loudly.
 * @param {unknown} id
 * @returns {boolean}
 */
export function isCanonicalVendorSecretId(id) {
  if (typeof id !== 'string') return false;
  const bare = id.startsWith(CANONICAL_VENDOR_SECRET_PREFIX)
    ? id.slice(CANONICAL_VENDOR_SECRET_PREFIX.length)
    : id;
  return CANONICAL_VENDOR_IDS.includes(bare);
}

/**
 * @param {string} vendorId bare canonical vendor id, e.g. 'anthropic'
 * @returns {string} the on-disk record key
 * @throws {Error} for any id outside the canonical set
 */
function canonicalStorageKey(vendorId) {
  if (!CANONICAL_VENDOR_IDS.includes(vendorId)) {
    throw new Error(`Unsupported canonical vendor: ${vendorId}`);
  }
  return `${CANONICAL_VENDOR_SECRET_PREFIX}${vendorId}`;
}

/**
 * Stores (or replaces) one member's canonical key for a vendor. Refuses while
 * the flag is off, and refuses a Claude subscription token for every vendor:
 * the canonical record feeds non-Claude writers too (B-1252, ADR-200 L2).
 *
 * @param {string|number} userId a MEMBER id
 * @param {string} vendorId bare canonical vendor id
 * @param {string} apiKey non-empty raw key
 * @returns {{ vendorId: string, stored: boolean }}
 */
export function setCanonicalVendorKey(userId, vendorId, apiKey) {
  assertMemberScope(userId);
  const storageKey = canonicalStorageKey(vendorId);
  if (!isUnifiedVendorKeysEnabled()) {
    throw new Error(`${UNIFIED_VENDOR_KEYS_FLAG} is off; canonical vendor keys are not writable`);
  }
  if (typeof apiKey !== 'string' || apiKey.trim() === '') {
    throw new Error('API key must be a non-empty string');
  }
  if (isClaudeSubscriptionToken(apiKey)) {
    throw new Error('A Claude subscription token is not a vendor API key');
  }
  mutateKeysFile(userId, putEntry(storageKey, encrypt(apiKey.trim())));
  return { vendorId, stored: true };
}

/**
 * Returns one member's decrypted canonical key, or null when none is usable.
 * @param {string|number} userId
 * @param {string} vendorId
 * @returns {string|null}
 */
export function getCanonicalVendorKey(userId, vendorId) {
  assertMemberScope(userId);
  return decrypt(readKeysFile(userId)[canonicalStorageKey(vendorId)]);
}

/**
 * Deletes one member's canonical key. Idempotent; open with the flag off.
 * @param {string|number} userId
 * @param {string} vendorId
 * @returns {{ vendorId: string, removed: boolean }}
 */
export function deleteCanonicalVendorKey(userId, vendorId) {
  assertMemberScope(userId);
  const storageKey = canonicalStorageKey(vendorId);
  const removed = mutateKeysFile(userId, dropEntry(storageKey));
  return { vendorId, removed };
}

/**
 * ADR-200 G2 (B-1570): one member's vendor key with its read state, for callers
 * that must not treat an undecryptable record as "no key" (the retry sweep and
 * the migration). `secretId` is a `vendor:*` id or a legacy slot id (kimi, glm,
 * qwen, deepseek). `unreadable` = a corrupt keys file (`store: true`) or an
 * entry that does not decrypt; the finer cause is never returned.
 * @param {string|number} userId a MEMBER id
 * @param {string} secretId
 * @returns {{ state: 'absent' } | { state: 'unreadable', store?: true } | { state: 'ok', value: string }}
 */
export function readVendorKeyState(userId, secretId) {
  assertMemberScope(userId);
  const canonical = typeof secretId === 'string' && secretId.startsWith(CANONICAL_VENDOR_SECRET_PREFIX);
  if (!canonical && !isVendorSecretProvider(secretId)) {
    throw new Error(`Unsupported vendor secret id: ${secretId}`);
  }
  const storageKey = canonical
    ? canonicalStorageKey(secretId.slice(CANONICAL_VENDOR_SECRET_PREFIX.length))
    : secretId;
  const file = readKeysFileState(userId);
  if (file.state === 'unreadable') return { state: 'unreadable', store: true };
  if (file.state === 'absent' || !Object.prototype.hasOwnProperty.call(file.keys, storageKey)) {
    return { state: 'absent' };
  }
  const value = decrypt(file.keys[storageKey]);
  return value === null ? { state: 'unreadable' } : { state: 'ok', value };
}

/** True for a non-null, non-array object. */
function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** Refuses an in-flag write while NASSAJ_UNIFIED_VENDOR_KEYS is off. */
function assertUnifiedFlagOn(what) {
  if (!isUnifiedVendorKeysEnabled()) {
    throw new Error(`${UNIFIED_VENDOR_KEYS_FLAG} is off; ${what} are not writable`);
  }
}

/**
 * B-1547 read of one AES-sealed JSON record. `absent` = no file or no entry;
 * `unreadable` = a corrupt file (`store: true`), an entry that does not decrypt,
 * or a payload that is not a JSON object. The finer cause is never returned.
 * @param {string|number} scope
 * @param {string} storageKey
 * @returns {{ state: 'absent' } | { state: 'unreadable', store?: true } | { state: 'ok', record: Record<string, unknown> }}
 */
function readSealedRecordState(scope, storageKey) {
  const file = readKeysFileState(scope);
  if (file.state === 'unreadable') return { state: 'unreadable', store: true };
  if (file.state === 'absent' || !Object.prototype.hasOwnProperty.call(file.keys, storageKey)) {
    return { state: 'absent' };
  }
  const plaintext = decrypt(file.keys[storageKey]);
  if (plaintext === null) return { state: 'unreadable' };
  try {
    const parsed = JSON.parse(plaintext);
    if (isPlainObject(parsed)) return { state: 'ok', record: parsed };
  } catch {
    // Invalid payload: unreadable below.
  }
  return { state: 'unreadable' };
}

// ---------------------------------------------------------------------------
// ADR-200 S4 — per-(user, harness) link mode for Claude and Codex.
//
// One encrypted JSON record per harness (`linkmode:claude`, `linkmode:codex`)
// in the same per-user keys file. It is not a secret, but it carries the
// projection fingerprint, and keeping it inside the AES envelope means a
// tampered record fails to decrypt and reads as "unreadable" (B-1547: the run
// gate refuses it) instead of a forged mode. A null member id (single-operator
// install) uses the operator scope, matching where the Claude and Codex
// writers put that caller's files.
// Writes are in-flag; reads stay open so a flag-off period can still inspect.
// ---------------------------------------------------------------------------

/** The harnesses that offer a choice between subscription and API key (D1). */
export const LINK_MODE_HARNESSES = Object.freeze(['claude', 'codex']);

/** Current HKDF label version for projection fingerprints (ADR-200 §2). */
export const PROJECTION_FINGERPRINT_KEY_VERSION = 1;

function linkModeScope(userId) {
  return userId === null || userId === undefined || userId === '' ? SYSTEM_SECRET_SCOPE : userId;
}

function linkModeStorageKey(harness) {
  if (!LINK_MODE_HARNESSES.includes(harness)) {
    throw new Error(`Unsupported link-mode harness: ${harness}`);
  }
  return `linkmode:${harness}`;
}

/**
 * B-1547: one caller's link-mode record with its read state. `absent` = no
 * keys file or no entry; `unreadable` = the file is corrupt (`store: true`:
 * every write to it is refused, only an operator can repair it), or the entry
 * does not decrypt (tampered, wrong server key) or is not a JSON object. The
 * finer cause is deliberately not returned: it may hint at key material.
 * @param {string|number|null|undefined} userId
 * @param {'claude'|'codex'} harness
 * @returns {{ state: 'absent' } | { state: 'unreadable', store?: true } | { state: 'ok', record: Record<string, unknown> }}
 */
export function readLinkModeRecordState(userId, harness) {
  const scope = linkModeScope(userId);
  assertScope(scope);
  return readSealedRecordState(scope, linkModeStorageKey(harness));
}

/**
 * Reads one caller's link-mode record, or null when absent or unreadable
 * (display paths only; the run gate uses {@link readLinkModeRecordState}).
 * @param {string|number|null|undefined} userId
 * @param {'claude'|'codex'} harness
 * @returns {Record<string, unknown>|null}
 */
export function getLinkModeRecord(userId, harness) {
  const result = readLinkModeRecordState(userId, harness);
  return result.state === 'ok' ? result.record : null;
}

/**
 * Stores one caller's link-mode record. Refused while the flag is off.
 * @param {string|number|null|undefined} userId
 * @param {'claude'|'codex'} harness
 * @param {Record<string, unknown>} record
 * @returns {void}
 */
export function setLinkModeRecord(userId, harness, record) {
  const scope = linkModeScope(userId);
  assertScope(scope);
  const storageKey = linkModeStorageKey(harness);
  assertUnifiedFlagOn('link modes');
  if (!isPlainObject(record)) {
    throw new Error('Link-mode record must be an object');
  }
  mutateKeysFile(scope, putEntry(storageKey, encrypt(JSON.stringify(record))));
}

/**
 * HMAC-SHA-256 fingerprint of a projected credential, under a key derived by
 * HKDF from the server key with label `projection-fp/v<keyVersion>`. It lets
 * nassaj recognise a value it wrote without storing the value a second time.
 * @param {string} value
 * @param {number} [keyVersion]
 * @returns {string} lowercase hex
 */
export function projectionFingerprint(value, keyVersion = PROJECTION_FINGERPRINT_KEY_VERSION) {
  if (typeof value !== 'string' || value === '') {
    throw new Error('Fingerprint input must be a non-empty string');
  }
  const derived = Buffer.from(crypto.hkdfSync(
    'sha256', getProviderSecretsKey(), Buffer.alloc(0), `projection-fp/v${keyVersion}`, 32,
  ));
  return crypto.createHmac('sha256', derived).update(value, 'utf8').digest('hex');
}

// ---------------------------------------------------------------------------
// ADR-200 S5 — provenance ledger, harness-file backups, migration state.
//
// Same file, same AES envelope, separate key spaces:
//   - `ledger:<vendor>`  per member and vendor: which harness files hold a
//     projection nassaj owns, matched by fingerprint (never the value itself).
//     It outlives the vendor key until its tombstones are drained (§2, §6).
//   - `backup:<harness>` per member: the exact bytes of one harness credential
//     file, taken before nassaj first writes it; purged 30 days after a
//     verified migration (D8). OAuth material inside a backed-up file is only
//     ever copied into the encrypted backup, never modified.
//   - `migration:vendor-keys` per member: migration bookkeeping.
// All are member-scoped. Writes are in-flag; reads and deletes stay open, so a
// flag-off period can still inspect and drain them.
// ---------------------------------------------------------------------------

/** The harnesses whose credential files nassaj may project a vendor key into. */
export const PROJECTION_HARNESSES = Object.freeze(['claude', 'codex', 'opencode']);
/** ADR-200 §2 ledger entry states. */
export const LEDGER_STATES = Object.freeze(['synced', 'stale', 'failed', 'tombstone']);
/** ADR-200 §2 ledger entry origins. */
export const LEDGER_ORIGINS = Object.freeze(['fanout', 'adopted']);

const LEDGER_VENDOR_IDS = Object.freeze(VENDOR_KEY_CATALOGUE.map((row) => row.id));
const FINGERPRINT_PATTERN = /^[0-9a-f]{64}$/;
const MIGRATION_STORAGE_KEY = 'migration:vendor-keys';

function ledgerStorageKey(vendorId) {
  if (!LEDGER_VENDOR_IDS.includes(vendorId)) {
    throw new Error(`Unsupported ledger vendor: ${vendorId}`);
  }
  return `ledger:${vendorId}`;
}

function backupStorageKey(harness) {
  if (!PROJECTION_HARNESSES.includes(harness)) {
    throw new Error(`Unsupported backup harness: ${harness}`);
  }
  return `backup:${harness}`;
}

/** One validated ledger entry, or null when any field is malformed. */
function normalizeLedgerEntry(raw) {
  if (!isPlainObject(raw)) return null;
  const target = raw.target === null || raw.target === undefined ? null : raw.target;
  const valid = PROJECTION_HARNESSES.includes(raw.harness)
    && (target === null || (typeof target === 'string' && SECRET_ID_PATTERN.test(target)))
    && typeof raw.fingerprint === 'string' && FINGERPRINT_PATTERN.test(raw.fingerprint)
    && Number.isInteger(raw.keyVersion) && raw.keyVersion > 0
    && LEDGER_STATES.includes(raw.state)
    && LEDGER_ORIGINS.includes(raw.origin)
    && typeof raw.updatedAt === 'string';
  if (!valid) return null;
  return {
    harness: raw.harness, target, fingerprint: raw.fingerprint, keyVersion: raw.keyVersion,
    state: raw.state, origin: raw.origin, updatedAt: raw.updatedAt,
  };
}

/**
 * Validates a ledger `{ v: 1, entries: [...] }`; entries are keyed by
 * (harness, target), so a duplicate pair is malformed. Null when malformed.
 * @param {unknown} raw
 * @returns {{ v: 1, entries: Array<Record<string, unknown>> } | null}
 */
export function normalizeVendorLedger(raw) {
  if (!isPlainObject(raw) || !Array.isArray(raw.entries)) return null;
  const entries = raw.entries.map(normalizeLedgerEntry);
  if (entries.some((entry) => entry === null)) return null;
  const pairs = new Set(entries.map((entry) => `${entry.harness}\u0000${entry.target ?? ''}`));
  return pairs.size === entries.length ? { v: 1, entries } : null;
}

/**
 * One member's ledger for a vendor with its read state; a decrypted payload
 * that is not a valid ledger is `unreadable`, never `absent`.
 * @param {string|number} userId
 * @param {string} vendorId a VENDOR_KEY_CATALOGUE row id
 * @returns {{ state: 'absent' } | { state: 'unreadable', store?: true } | { state: 'ok', ledger: { v: 1, entries: Array<Record<string, unknown>> } }}
 */
export function readVendorLedgerState(userId, vendorId) {
  assertMemberScope(userId);
  const read = readSealedRecordState(userId, ledgerStorageKey(vendorId));
  if (read.state !== 'ok') return read;
  const ledger = normalizeVendorLedger(read.record);
  return ledger ? { state: 'ok', ledger } : { state: 'unreadable' };
}

/**
 * Stores one member's ledger for a vendor; an empty ledger removes the record.
 * Refused while the flag is off.
 * @param {string|number} userId
 * @param {string} vendorId
 * @param {{ v: 1, entries: Array<Record<string, unknown>> }} ledger
 * @returns {void}
 */
export function setVendorLedger(userId, vendorId, ledger) {
  assertMemberScope(userId);
  const storageKey = ledgerStorageKey(vendorId);
  assertUnifiedFlagOn('ledgers');
  const normalized = normalizeVendorLedger(ledger);
  if (!normalized) throw new Error('Malformed vendor ledger');
  const body = normalized.entries.length === 0
    ? dropEntry(storageKey)
    : putEntry(storageKey, encrypt(JSON.stringify(normalized)));
  mutateKeysFile(userId, body);
}

/**
 * Removes every entry of one harness from a member's vendor ledger (a backup
 * restore makes them meaningless). A deletion, so open with the flag off like
 * the other deletes; an unreadable ledger is left as it is and reported.
 * @param {string|number} userId
 * @param {string} vendorId
 * @param {'claude'|'codex'|'opencode'} harness
 * @returns {'dropped'|'none'|'unreadable'}
 */
export function dropVendorLedgerHarness(userId, vendorId, harness) {
  assertMemberScope(userId);
  const storageKey = ledgerStorageKey(vendorId);
  const read = readVendorLedgerState(userId, vendorId);
  if (read.state === 'unreadable') return 'unreadable';
  if (read.state === 'absent') return 'none';
  const kept = read.ledger.entries.filter((entry) => entry.harness !== harness);
  if (kept.length === read.ledger.entries.length) return 'none';
  const body = kept.length === 0
    ? dropEntry(storageKey)
    : putEntry(storageKey, encrypt(JSON.stringify({ v: 1, entries: kept })));
  mutateKeysFile(userId, body);
  return 'dropped';
}

/**
 * Stores the exact bytes of one harness credential file unless a backup for
 * that harness already exists (the first backup is the one to keep, even when
 * it no longer decrypts). `bytes === null` records that the file was absent.
 * @param {string|number} userId
 * @param {'claude'|'codex'|'opencode'} harness
 * @param {Buffer|null} bytes
 * @param {string} takenAt ISO timestamp
 * @returns {boolean} whether a new backup was written
 */
export function putHarnessBackupIfAbsent(userId, harness, bytes, takenAt) {
  assertMemberScope(userId);
  const storageKey = backupStorageKey(harness);
  assertUnifiedFlagOn('backups');
  if (bytes !== null && !Buffer.isBuffer(bytes)) throw new Error('Backup bytes must be a Buffer or null');
  const payload = {
    v: 1,
    existed: bytes !== null,
    bytes: bytes === null ? '' : bytes.toString('base64'),
    sha256: bytes === null ? '' : crypto.createHash('sha256').update(bytes).digest('hex'),
    takenAt,
  };
  return mutateKeysFile(userId, (keys) => {
    if (Object.prototype.hasOwnProperty.call(keys, storageKey)) return { changed: false, result: false };
    keys[storageKey] = encrypt(JSON.stringify(payload));
    return { changed: true, result: true };
  });
}

/**
 * Reads one harness backup. `intact` is false when the stored digest does not
 * match the decrypted bytes. Null when absent or unreadable.
 * @param {string|number} userId
 * @param {'claude'|'codex'|'opencode'} harness
 * @returns {{ existed: boolean, bytes: Buffer, takenAt: string, intact: boolean } | null}
 */
export function readHarnessBackup(userId, harness) {
  assertMemberScope(userId);
  const read = readSealedRecordState(userId, backupStorageKey(harness));
  if (read.state !== 'ok') return null;
  const { existed, bytes, sha256, takenAt } = read.record;
  if (typeof existed !== 'boolean' || typeof bytes !== 'string' || typeof sha256 !== 'string') return null;
  const buffer = Buffer.from(bytes, 'base64');
  const digest = existed ? crypto.createHash('sha256').update(buffer).digest('hex') : '';
  return {
    existed,
    bytes: buffer,
    takenAt: typeof takenAt === 'string' ? takenAt : '',
    intact: digest === sha256,
  };
}

/**
 * The harnesses that currently hold a backup entry, readable or not.
 * @param {string|number} userId
 * @returns {string[]}
 */
export function listHarnessBackups(userId) {
  assertMemberScope(userId);
  const keys = readKeysFile(userId);
  return PROJECTION_HARNESSES.filter((harness) => Object.prototype.hasOwnProperty.call(keys, `backup:${harness}`));
}

/**
 * Deletes one harness backup. Idempotent; open with the flag off.
 * @param {string|number} userId
 * @param {'claude'|'codex'|'opencode'} harness
 * @returns {boolean} whether a backup was removed
 */
export function deleteHarnessBackup(userId, harness) {
  assertMemberScope(userId);
  return mutateKeysFile(userId, dropEntry(backupStorageKey(harness)));
}

/**
 * One member's migration bookkeeping with its read state.
 * @param {string|number} userId
 */
export function readVendorMigrationState(userId) {
  assertMemberScope(userId);
  return readSealedRecordState(userId, MIGRATION_STORAGE_KEY);
}

/**
 * Stores one member's migration bookkeeping. Refused while the flag is off.
 * @param {string|number} userId
 * @param {Record<string, unknown>} state
 * @returns {void}
 */
export function setVendorMigrationState(userId, state) {
  assertMemberScope(userId);
  assertUnifiedFlagOn('migration records');
  if (!isPlainObject(state)) throw new Error('Migration state must be an object');
  mutateKeysFile(userId, putEntry(MIGRATION_STORAGE_KEY, encrypt(JSON.stringify(state))));
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
  mutateKeysFile(scope, putEntry(provider, encrypt(apiKey.trim())));
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
  const removed = mutateKeysFile(scope, dropEntry(provider));
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
