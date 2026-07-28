/**
 * provider-sharing — admin-configurable per-provider isolation policy.
 *
 * Each provider (claude/gemini/codex/agy/cursor) can be either:
 *   - 'isolated': credentials are isolated per user (resolveProviderEnv applies
 *                 the per-user CONFIG_DIR / HOME override for that provider), or
 *   - 'shared':   all users share the operator's credentials (env unchanged).
 *
 * The policy is persisted as a single JSON value under the app_config key
 * `provider_sharing` and cached in-process so the hot path (every provider
 * spawn calls isProviderIsolated) never hits SQLite. The cache is loaded lazily
 * on first read and refreshed synchronously on every write, so a config change
 * via the admin API takes effect immediately for all subsequent spawns —
 * including across the same process. (Other processes pick it up on their next
 * lazy load / restart; this install runs a single server process.)
 *
 * The defaults below MUST mirror the pre-feature behavior so an install with no
 * stored config behaves exactly as before: claude/gemini/codex isolated, agy and
 * cursor shared (ADR-016).
 */

import { appConfigDb } from '../modules/database/index.js';

/** Config key in app_config holding the JSON-encoded sharing policy. */
const CONFIG_KEY = 'provider_sharing';

/** Providers the policy recognizes. Any other key is rejected on write. */
export const KNOWN_PROVIDERS = Object.freeze([
  'claude',
  'gemini',
  'codex',
  'agy',
  'cursor',
  'opencode',
  'kimi',
  'deepseek',
  'glm',
]);

/** Allowed sharing modes. */
export const SHARING_MODES = Object.freeze(['shared', 'isolated']);

/**
 * Default policy — exactly the behavior shipped before this feature, so an
 * install with no stored config is unchanged.
 */
const DEFAULT_CONFIG = Object.freeze({
  claude: 'isolated',
  gemini: 'isolated',
  codex: 'isolated',
  agy: 'shared',
  cursor: 'shared',
  // opencode defaults to 'shared' (OC-07): it inherits the operator's XDG data/
  // config tree exactly as before this seam existed, so an install with no stored
  // config is byte-for-byte unchanged. An admin opts a user into isolation to get
  // per-user XDG_* redirection into ~/.nassaj-users/<id>/.
  opencode: 'shared',
  // Hosted vendor providers default to 'isolated': each user's API key is held
  // in the encrypted per-user secrets store and injected per spawn, so they must
  // never fall back to a shared operator key (B-VR-2B).
  kimi: 'isolated',
  deepseek: 'isolated',
  glm: 'isolated',
});

/**
 * In-process singleton cache. `null` until the first lazy load from the DB.
 * Holds a plain object { provider: 'shared'|'isolated' } covering every known
 * provider (missing/invalid entries are filled from DEFAULT_CONFIG).
 * @type {Record<string,'shared'|'isolated'>|null}
 */
let cache = null;

/**
 * Normalizes an arbitrary parsed object into a complete, valid policy: every
 * known provider present with a valid mode, unknown keys dropped, missing or
 * invalid entries filled from the default. Pure — never touches the cache.
 *
 * @param {unknown} raw parsed JSON (or anything) to normalize
 * @returns {Record<string,'shared'|'isolated'>}
 */
function normalizeConfig(raw) {
  const result = { ...DEFAULT_CONFIG };
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    for (const provider of KNOWN_PROVIDERS) {
      const value = /** @type {Record<string,unknown>} */ (raw)[provider];
      if (typeof value === 'string' && SHARING_MODES.includes(value)) {
        result[provider] = value;
      }
    }
  }
  return result;
}

/** Lazily loads the policy from app_config into the cache on first use. */
function loadCache() {
  if (cache !== null) {
    return cache;
  }
  let parsed = null;
  try {
    const stored = appConfigDb.get(CONFIG_KEY);
    if (stored) {
      parsed = JSON.parse(stored);
    }
  } catch (err) {
    // A corrupt/unreadable value must not break spawns: fall back to defaults.
    console.error('[provider-sharing] failed to load config, using defaults', {
      error: err?.message || String(err),
    });
    parsed = null;
  }
  cache = normalizeConfig(parsed);
  return cache;
}

/**
 * Returns the current sharing policy as a fresh object (safe to serialize/return
 * to clients). Loads from the DB on first call.
 *
 * @returns {Record<string,'shared'|'isolated'>}
 */
export function getProviderSharingConfig() {
  return { ...loadCache() };
}

/**
 * Validates a partial or full config patch from an untrusted caller.
 * Rejects unknown provider keys and invalid modes. Returns the merged, fully
 * normalized policy that WOULD be stored (does not persist).
 *
 * @param {unknown} input candidate config object
 * @returns {{ ok: true, config: Record<string,'shared'|'isolated'> } | { ok: false, error: string }}
 */
export function validateProviderSharingConfig(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, error: 'Config must be an object' };
  }
  const entries = Object.entries(input);
  if (entries.length === 0) {
    return { ok: false, error: 'Config must contain at least one provider' };
  }
  for (const [provider, mode] of entries) {
    if (!KNOWN_PROVIDERS.includes(provider)) {
      return { ok: false, error: `Unknown provider: ${provider}` };
    }
    if (typeof mode !== 'string' || !SHARING_MODES.includes(mode)) {
      return { ok: false, error: `Invalid mode for ${provider}: must be 'shared' or 'isolated'` };
    }
  }
  // Merge the patch over the current policy so a partial update keeps the rest.
  const merged = { ...loadCache(), ...input };
  return { ok: true, config: normalizeConfig(merged) };
}

/**
 * Persists a validated policy and refreshes the in-process cache synchronously
 * so the change takes effect on the very next spawn in this process.
 *
 * @param {Record<string,'shared'|'isolated'>} config a normalized, validated policy
 * @returns {Record<string,'shared'|'isolated'>} the stored policy
 */
export function setProviderSharingConfig(config) {
  const normalized = normalizeConfig(config);
  appConfigDb.set(CONFIG_KEY, JSON.stringify(normalized));
  cache = normalized;
  return { ...normalized };
}

/**
 * Hot-path check used by resolveProviderEnv: is `provider` isolated per user?
 * An unknown provider is treated as NOT isolated (shared) so a future provider
 * never accidentally inherits another's isolation.
 *
 * @param {string} provider provider identifier
 * @returns {boolean}
 */
export function isProviderIsolated(provider) {
  const policy = loadCache();
  return policy[provider] === 'isolated';
}

/**
 * Test/diagnostic hook: drop the in-process cache so the next read reloads from
 * the DB. Not used on the request path.
 */
export function _resetProviderSharingCache() {
  cache = null;
}
