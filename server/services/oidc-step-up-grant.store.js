/**
 * One-time OIDC step-up grants (T-1939 6B).
 *
 * After an SSO-linked member re-authenticates at the IdP for a step-up, the
 * callback does NOT log anyone in. It issues a short-lived opaque grant bound
 * to the member (userId), the audience it was requested for, and the hash of
 * the browser-transaction cookie of the tab that started it. The SPA then
 * presents the grant as step-up evidence ({ method: 'oidc_grant', grant }).
 *
 * consume() is single use: the entry is removed on the first lookup, whether
 * or not the binding matches, so a wrong-user/audience/transaction attempt
 * also burns the grant. In-memory and single-process, like the PKCE store;
 * expired grants are purged on every issue() and consume().
 */

import crypto from 'node:crypto';

const DEFAULT_TTL_MS = 60_000;
const DEFAULT_MAX_ENTRIES = 1_000;
const TRANSACTION = /^[A-Za-z0-9_-]{43}$/;

function hashTransaction(transaction) {
  return typeof transaction === 'string' && TRANSACTION.test(transaction)
    ? crypto.createHash('sha256').update(transaction).digest()
    : null;
}

/**
 * Factory — exported for unit tests (short TTLs, isolated state).
 * @param {{ ttlMs?: number, maxEntries?: number, now?: () => number }} [options]
 */
export function createOidcStepUpGrantStore({ ttlMs, maxEntries, now } = {}) {
  const ttl = ttlMs ?? DEFAULT_TTL_MS;
  const maximum = maxEntries ?? DEFAULT_MAX_ENTRIES;
  const clock = now ?? Date.now;
  /** @type {Map<string, { userId: number, audience: string, transactionHash: Buffer, expiresAt: number }>} */
  const grants = new Map();

  function prune(at) {
    for (const [key, entry] of grants) {
      if (at >= entry.expiresAt) grants.delete(key);
    }
  }

  return {
    /**
     * Issues a grant, or null when the input is invalid or the store is full.
     * @param {{ userId: number, audience: string, browserTransaction: string }} binding
     * @returns {string | null}
     */
    issue({ userId, audience, browserTransaction }) {
      const transactionHash = hashTransaction(browserTransaction);
      if (!Number.isInteger(userId) || userId <= 0 || typeof audience !== 'string' || !transactionHash) {
        return null;
      }
      const at = clock();
      prune(at);
      if (grants.size >= maximum) return null;
      const grant = crypto.randomBytes(32).toString('base64url');
      grants.set(grant, { userId, audience, transactionHash, expiresAt: at + ttl });
      return grant;
    },

    /**
     * Consumes a grant for exactly this user, audience and browser
     * transaction. Returns true once; every other call returns false.
     * @param {string} grant
     * @param {{ userId: number, audience: string, browserTransaction: string | null }} expected
     * @returns {boolean}
     */
    consume(grant, { userId, audience, browserTransaction }) {
      if (typeof grant !== 'string' || grant.length === 0 || grant.length > 128) return false;
      const at = clock();
      const entry = grants.get(grant);
      prune(at);
      if (!entry) return false;
      grants.delete(grant);
      const supplied = hashTransaction(browserTransaction);
      return at < entry.expiresAt
        && entry.userId === userId
        && entry.audience === audience
        && supplied !== null
        && crypto.timingSafeEqual(entry.transactionHash, supplied);
    },

    /**
     * Revokes an unredeemed grant (ADR-194 D9: the config changed after it
     * was issued). True when a grant was removed.
     * @param {string} grant
     * @returns {boolean}
     */
    revoke(grant) {
      return typeof grant === 'string' && grants.delete(grant);
    },

    /** Outstanding (possibly expired, not yet pruned) grants. */
    get size() {
      return grants.size;
    },
  };
}

/** Process-wide singleton shared by the OIDC callback and the step-up verifier. */
export const oidcStepUpGrantStore = createOidcStepUpGrantStore();
