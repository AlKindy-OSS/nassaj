/**
 * provider-sharing — admin-configurable per-provider isolation policy.
 *
 * Each provider (claude/codex/agy/cursor/…) can be either:
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
 * stored config behaves exactly as before: claude/codex isolated, agy and
 * cursor shared (ADR-016).
 */

import { appConfigDb } from '../modules/database/index.js';

/** Config key in app_config holding the JSON-encoded sharing policy. */
const CONFIG_KEY = 'provider_sharing';

/** Providers the policy recognizes. Any other key is rejected on write. */
export const KNOWN_PROVIDERS = Object.freeze([
  'claude',
  'codex',
  'agy',
  'cursor',
  'opencode',
  // hermes was absent from this list, which was not a neutral omission: the
  // policy gate answers `policy[provider] === 'isolated'`, false for a key it
  // never heard of, so hermes returned the operator's environment before any
  // isolation case could run — invisible to the admin panel and to the resolver
  // alike. Being listed is what makes a provider governable at all (ADR-105).
  'hermes',
  'kimi',
  'deepseek',
  'glm',
  // ADR-101: Qwen Coding Plan is personal BYOK only. Keeping this provider in
  // the isolation policy is mandatory even while its body is globally disabled:
  // an omitted provider would inherit the operator environment on first wiring.
  'qwen',
]);

/** Allowed sharing modes. */
export const SHARING_MODES = Object.freeze(['shared', 'isolated']);

/**
 * Default policy.
 *
 * This used to be "exactly the behavior shipped before this feature, so an
 * install with no stored config is unchanged" — which quietly made SHARED the
 * default for every provider whose isolation landed after its integration did.
 * Backward compatibility is the wrong tie-breaker for this particular default:
 * nassaj is open source, so a fresh install is somebody else's team, and the
 * safe starting point there is that nobody spends anybody else's credentials.
 * A single-operator install loses nothing either way — the operator is the only
 * user, so their tree is the only tree (ADR-105).
 *
 * A provider defaults to 'shared' now only when isolating it would BREAK it,
 * and each such case says why on its own line.
 */
const DEFAULT_CONFIG = Object.freeze({
  claude: 'isolated',
  codex: 'isolated',
  agy: 'isolated',
  // cursor-agent derives every path from $HOME (login + chat state in ~/.cursor,
  // its own install under ~/.local/share/cursor-agent), so the HOME override in
  // resolveIsolatedProviderEnv isolates all of it. Verified on the installed CLI
  // (2026.07.23-e383d2b), not inferred.
  cursor: 'isolated',
  // opencode: isolated like the rest. It used to default to 'shared' to keep an
  // upgrading install byte-identical, which is the backward-compatibility
  // tie-breaker ADR-105 rejects — the cost of that default is that every
  // member's opencode turn spends whatever key sits in the operator's auth.json.
  opencode: 'isolated',
  // hermes keeps ALL its state under ~/.hermes — auth.json beside config.yaml,
  // sessions, state.db — so the HOME override isolates the credential. The
  // operator's config.yaml and bin/ are symlinked back in (provision-user-dirs):
  // they are configuration and tooling, not credentials, and forking them per
  // user would mean every member re-declaring the model endpoints by hand.
  hermes: 'isolated',
  // Hosted vendor providers default to 'isolated': each user's API key is held
  // in the encrypted per-user secrets store and injected per spawn, so they must
  // never fall back to a shared operator key (B-VR-2B).
  kimi: 'isolated',
  deepseek: 'isolated',
  glm: 'isolated',
  qwen: 'isolated',
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
  // ADR-101: Coding Plan is a personal subscription. Persisted legacy/manual
  // JSON must not be able to turn Qwen into an operator-wide account.
  result.qwen = 'isolated';
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
    if (provider === 'qwen' && mode !== 'isolated') {
      return { ok: false, error: 'Qwen Coding Plan credentials must remain isolated per member' };
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
