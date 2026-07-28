/**
 * In-memory OIDC one-time code store (P-IDP-3, ADR-046).
 *
 * Bridges the server-side OIDC callback to the browser without ever putting the
 * minted JWT in a redirect URL (where it would land in history, logs, and the
 * Referer header). The callback stores the freshly issued token under a random
 * one-time `code` (base64url, 32 random bytes), redirects the browser to a
 * front-channel return page carrying only that code, and the SPA immediately
 * trades the code for the token via GET /api/auth/oidc/exchange.
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

// The browser redeems the code on the very next request after the redirect, so
// a 1-minute window is generous; keeping it short bounds the replay surface of
// a leaked code.
const DEFAULT_TTL_MS = 60_000; // 1 minute
const PRUNE_THRESHOLD = 1000;

/**
 * Factory — exported for unit tests (short TTLs, isolated state).
 * @param {{ ttlMs?: number }} [options]
 */
export function createOidcCodeStore({ ttlMs } = {}) {
  const ttl = ttlMs ?? DEFAULT_TTL_MS;
  /** @type {Map<string, { token: string, userId: number, expiresAt: number }>} */
  const codes = new Map();

  function pruneIfLarge(now) {
    if (codes.size < PRUNE_THRESHOLD) {
      return;
    }
    for (const [key, entry] of codes) {
      if (now > entry.expiresAt) {
        codes.delete(key);
      }
    }
  }

  return {
    /**
     * Stores a minted token under a one-time code.
     * @param {string} code base64url one-time code
     * @param {{ token: string, userId: number }} payload
     */
    store(code, { token, userId }) {
      const now = Date.now();
      pruneIfLarge(now);
      codes.set(code, { token, userId, expiresAt: now + ttl });
    },

    /**
     * Consumes a code (single use). Returns `{ token, userId }` when `code`
     * exists and has not expired; null otherwise. The entry is always removed,
     * so a second consume of the same code fails.
     * @param {string} code
     * @returns {{ token: string, userId: number } | null}
     */
    consume(code) {
      if (typeof code !== 'string' || code.length === 0) {
        return null;
      }
      const entry = codes.get(code);
      if (!entry) {
        return null;
      }
      codes.delete(code);
      if (Date.now() > entry.expiresAt) {
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
