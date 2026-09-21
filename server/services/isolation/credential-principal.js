/**
 * resolveCredentialPrincipal(userId, provider) — WHOSE credential a spawn uses.
 *
 * T-1675 / ADR-152. Isolation is the base: a member's provider spawn runs on
 * that member's own tree (or injected key). A member may, from the provider's
 * own settings page, delegate their credential to specific other members. For
 * such a grantee this function answers with the OWNER's id instead of their
 * own, and resolveProviderEnv builds the spawn environment for the owner's
 * credential of THAT PROVIDER ONLY:
 *   • providers with a dedicated knob (claude → CLAUDE_CONFIG_DIR, codex →
 *     CODEX_HOME, kimi agent → KIMI_CODE_HOME, vendor keys) point straight at
 *     the owner's provider dir / key;
 *   • providers steered by HOME or XDG (gemini, agy, hermes, cursor, opencode)
 *     get a GRANT HOME (grant-home.js): the grantee's own tree with just the
 *     granted provider dirs linked to the owner's. Never the owner's root — the
 *     root holds every other credential the owner has.
 *
 * Rules, all decided HERE and nowhere else:
 *   • no delegation for an anonymous caller (null/undefined/'') — returned as is;
 *   • qwen joined the grantable set on the owner's instruction (2026-09-10);
 *     its Coding Plan key and ~/.qwen state follow the grant like any other;
 *   • only a grant whose owner is an ACTIVE account counts — read live on every
 *     call, no cache, so disabling or deleting the owner ends it on the very
 *     next spawn (an indexed query per lookup; a HOME-steered spawn makes two:
 *     the principal, then one snapshot of all units for the grant home);
 *   • a declined grant does not count (the grantee chose their own credential);
 *   • several usable grants ⇒ the oldest wins; the grantee can decline the
 *     others to pick a different one;
 *   • NO chaining: the owner's own grants are not consulted. If A shares with B
 *     and B shares with C, C runs on B's tree, never on A's.
 *
 * What a grant IS, stated plainly because the UI and ADR-152 repeat it: the
 * grantee's turns run with the owner's credential file reachable, so a copy
 * taken during a grant outlives its revocation. Revoking stops use THROUGH
 * nassaj; reclaiming a copied token means logging out / rotating at the vendor.
 */

// Namespace import on purpose: this module sits on EVERY spawn path, and a
// dozen test files mock the database barrel with a partial export set. A named
// import of `credentialGrantsDb` would turn each of those into a link-time
// SyntaxError; through the namespace a missing export is simply `undefined`,
// which the lookup below treats as "no grants" — the base state.
import * as database from '../../modules/database/index.js';

/**
 * Providers a member may delegate: every KNOWN_PROVIDER (provider-sharing.js).
 * Spelled out rather than derived so this file pulls in no policy module on the
 * spawn path; credential-grants.test.ts pins the two lists against each other.
 */
export const GRANTABLE_PROVIDERS = Object.freeze([
  'claude',
  'gemini',
  'codex',
  'agy',
  'cursor',
  'opencode',
  'hermes',
  'kimi',
  'deepseek',
  'glm',
  'qwen',
]);

/**
 * @typedef {object} CredentialPrincipal
 * @property {string|number|null} principalId whose tree/key the spawn uses
 * @property {number|null} grantedBy the owner's id when delegated, else null
 */

/**
 * gemini and agy are ONE credential on disk (`~/.gemini/antigravity-cli`, one
 * binary under two names), so they are one grant: rows are stored under the
 * unit key and both providers resolve through it. Every other provider is its
 * own unit.
 * @param {string} provider
 * @returns {string}
 */
export function credentialUnit(provider) {
  return provider === 'agy' ? 'gemini' : provider;
}

/** The distinct units a member can grant (GRANTABLE_PROVIDERS collapsed). */
export const GRANTABLE_UNITS = Object.freeze([...new Set(GRANTABLE_PROVIDERS.map(credentialUnit))]);

function isAnonymous(userId) {
  return userId === null || userId === undefined || userId === '';
}

/**
 * @param {string|number|null|undefined} userId authenticated caller
 * @param {string} provider sharing-policy key ('agy', not 'antigravity')
 * @returns {CredentialPrincipal}
 */
export function resolveCredentialPrincipal(userId, provider) {
  if (isAnonymous(userId)) {
    return { principalId: userId ?? null, grantedBy: null };
  }
  const own = { principalId: userId, grantedBy: null };
  if (!GRANTABLE_PROVIDERS.includes(provider)) {
    return own;
  }
  const credentialGrantsDb = database.credentialGrantsDb;
  if (!credentialGrantsDb) {
    return own;
  }
  try {
    const usable = credentialGrantsDb.listUsableForGrantee(userId, credentialUnit(provider));
    if (usable.length > 0) {
      return { principalId: usable[0].ownerUserId, grantedBy: usable[0].ownerUserId };
    }
  } catch (error) {
    // A failed read must never break a spawn: fall back to the caller's own
    // credential, which is the base state anyway.
    console.error('[credential-principal] grant lookup failed; using own credential', {
      userId,
      provider,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  return own;
}

/**
 * Convenience for the many read-side helpers that only need the id. A real id
 * in always yields a real id out (own or owner's); only an anonymous caller
 * gets null back.
 * @template {string|number|null|undefined} T
 * @param {T} userId
 * @param {string} provider
 * @returns {T extends null|undefined ? null : string|number}
 */
export function credentialPrincipalId(userId, provider) {
  return /** @type {any} */ (resolveCredentialPrincipal(userId, provider).principalId);
}

/**
 * Ids of every owner whose credential `granteeId` currently runs on, for any
 * unit — the grant homes worth keeping. One query.
 * @param {string|number} granteeId
 * @returns {string[]}
 */
export function listDelegatedOwners(granteeId) {
  const credentialGrantsDb = database.credentialGrantsDb;
  if (isAnonymous(granteeId) || !credentialGrantsDb) {
    return [];
  }
  try {
    const seen = new Set();
    const owners = new Set();
    for (const row of credentialGrantsDb.listUsableByGrantee(granteeId)) {
      if (seen.has(row.provider)) continue;
      seen.add(row.provider);
      owners.add(String(row.ownerUserId));
    }
    return [...owners];
  } catch {
    return [];
  }
}

/**
 * Every provider for which `granteeId` currently runs on `ownerId`'s credential
 * — the set a grant home links to the owner. Same rules as above, per provider.
 * @param {string|number} granteeId
 * @param {string|number} ownerId
 * @returns {string[]}
 */
export function listDelegatedProvidersFromOwner(granteeId, ownerId) {
  const credentialGrantsDb = database.credentialGrantsDb;
  if (isAnonymous(granteeId) || !credentialGrantsDb) {
    return [];
  }
  // One snapshot for every unit, then the same "oldest usable wins" rule per
  // unit as resolveCredentialPrincipal — so a spawn costs one query, not one
  // per provider, and every unit is judged from the same instant.
  let rows;
  try {
    rows = credentialGrantsDb.listUsableByGrantee(granteeId);
  } catch (error) {
    console.error('[credential-principal] grant snapshot failed; treating as none', {
      granteeId,
      error: error instanceof Error ? error.message : String(error),
    });
    return [];
  }
  const winnerByUnit = new Map();
  for (const row of rows) {
    if (!winnerByUnit.has(row.provider)) winnerByUnit.set(row.provider, row.ownerUserId);
  }
  return GRANTABLE_PROVIDERS.filter(
    (provider) => String(winnerByUnit.get(credentialUnit(provider))) === String(ownerId),
  );
}
