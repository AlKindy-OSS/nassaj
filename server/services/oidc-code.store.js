/**
 * In-memory OIDC one-time code store (P-IDP-3, ADR-046).
 *
 * Bridges the server-side OIDC callback to the browser without ever putting the
 * minted JWT in a redirect URL (where it would land in history, logs, and the
 * Referer header). The callback stores the freshly issued token under a random
 * one-time `code` (base64url, 32 random bytes), redirects the browser to a
 * front-channel return page carrying only that code, and the SPA immediately
 * trades the code for the token via POST /api/auth/oidc/exchange bound to the
 * same secure browser transaction cookie.
 *
 * Single-process only (Map, no shared store) — adequate for the single PM2 fork
 * this app runs as, mirroring the OIDC PKCE store and the WebAuthn challenge
 * store. Codes are single-use: consume() removes the entry before returning it,
 * so an intercepted code can never be redeemed twice. The TTL is deliberately
 * tiny (the SPA redeems within one page load); stale entries are pruned lazily
 * on store().
 *
 * Pattern intentionally identical to services/oidc-pkce.store.js.
 */

import crypto from 'node:crypto';

// The browser redeems the code on the very next request after the redirect, so
// a 1-minute window is generous; keeping it short bounds the replay surface of
// a leaked code.
const DEFAULT_TTL_MS = 60_000; // 1 minute
const DEFAULT_MAX_ENTRIES = 1_000;

function hashBrowserTransaction(transaction) {
  if (typeof transaction !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(transaction)) {
    return null;
  }
  return crypto.createHash('sha256').update(transaction).digest();
}

function matchesTransaction(expectedHash, transaction) {
  const suppliedHash = hashBrowserTransaction(transaction);
  return suppliedHash !== null
    && expectedHash.length === suppliedHash.length
    && crypto.timingSafeEqual(expectedHash, suppliedHash);
}

/**
 * Factory — exported for unit tests (short TTLs, isolated state).
 * @param {{ ttlMs?: number, maxEntries?: number }} [options]
 */
export function createOidcCodeStore({ ttlMs, maxEntries } = {}) {
  const ttl = ttlMs ?? DEFAULT_TTL_MS;
  const maximum = maxEntries ?? DEFAULT_MAX_ENTRIES;
  if (!Number.isInteger(ttl) || ttl <= 0 || !Number.isInteger(maximum) || maximum <= 0) {
    throw new TypeError('OIDC code store options must be positive integers');
  }
  /** @type {Map<string, { token: string, userId: number, transactionHash: Buffer, expiresAt: number }>} */
  const codes = new Map();

  function pruneExpired(now) {
    for (const [key, entry] of codes) {
      if (now >= entry.expiresAt) {
        codes.delete(key);
      }
    }
  }

  return {
    /**
     * Stores a minted token under a one-time code.
     * @param {string} code base64url one-time code
     * @param {{ token: string, userId: number, browserTransaction: string }} payload
     * @returns {boolean} false when the bounded store is full or input is invalid
     */
    store(code, { token, userId, browserTransaction }) {
      const now = Date.now();
      const transactionHash = hashBrowserTransaction(browserTransaction);
      if (
        typeof code !== 'string'
        || code.length === 0
        || typeof token !== 'string'
        || !Number.isInteger(userId)
        || transactionHash === null
      ) {
        return false;
      }
      pruneExpired(now);
      if (codes.size >= maximum) {
        return false;
      }
      codes.set(code, { token, userId, transactionHash, expiresAt: now + ttl });
      return true;
    },

    /**
     * Consumes a code (single use). Returns `{ token, userId }` when `code`
     * exists and has not expired; null otherwise. The entry is always removed,
     * so a second consume of the same code fails.
     * @param {string} code
     * @param {string} browserTransaction opaque secure-cookie value for this browser
     * @returns {{ token: string, userId: number } | null}
     */
    consume(code, browserTransaction) {
      if (typeof code !== 'string' || code.length === 0) {
        return null;
      }
      const entry = codes.get(code);
      if (!entry) {
        return null;
      }
      codes.delete(code);
      if (Date.now() >= entry.expiresAt || !matchesTransaction(entry.transactionHash, browserTransaction)) {
        return null;
      }
      return { token: entry.token, userId: entry.userId };
    },

    /** Number of outstanding (possibly expired, not yet pruned) codes. */
    get size() {
      return codes.size;
    },
  };
}

/** Process-wide singleton used by the OIDC routes. */
export const oidcCodeStore = createOidcCodeStore();
