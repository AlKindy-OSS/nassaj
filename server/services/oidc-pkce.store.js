/**
 * In-memory OIDC PKCE / state store (P-IDP-3, ADR-046).
 *
 * Holds the per-authorization-request secrets between GET /api/auth/oidc/login
 * and the GET /api/auth/oidc/callback that the IdP redirects back to. Keyed by
 * the `state` value (base64url, 32 random bytes — unguessable and also the CSRF
 * token echoed by the IdP), mapping to the matching `nonce` (replay defence on
 * the id_token), the PKCE `code_verifier`, a browser-transaction hash, and an
 * expiry instant.
 *
 * Single-process only (Map, no shared store) — adequate for the single PM2 fork
 * this app runs as, mirroring the WebAuthn challenge store and the in-memory
 * rate limiter. Entries are single-use: consume() removes the entry before
 * returning it, so a replayed callback can never complete twice. Stale entries
 * are pruned lazily on store().
 *
 * Pattern intentionally identical to services/webauthn-challenge.store.js.
 */

import crypto from 'node:crypto';

// Authorization-code flows complete in seconds, but the user may pause at the
// IdP consent screen; 10 minutes is the conventional ceiling for a pending
// authorization request (matches the IdP's own auth-request TTL guidance).
const DEFAULT_TTL_MS = 10 * 60_000; // 10 minutes
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
export function createOidcPkceStore({ ttlMs, maxEntries } = {}) {
  const ttl = ttlMs ?? DEFAULT_TTL_MS;
  const maximum = maxEntries ?? DEFAULT_MAX_ENTRIES;
  if (!Number.isInteger(ttl) || ttl <= 0 || !Number.isInteger(maximum) || maximum <= 0) {
    throw new TypeError('OIDC PKCE store options must be positive integers');
  }
  /** @type {Map<string, { nonce: string, codeVerifier: string, transactionHash: Buffer, expiresAt: number }>} */
  const entries = new Map();

  function pruneExpired(now) {
    for (const [key, entry] of entries) {
      if (now >= entry.expiresAt) {
        entries.delete(key);
      }
    }
  }

  return {
    /**
     * Registers a pending authorization request under its `state`.
     * @param {string} state base64url CSRF/state token from /login
     * @param {{ nonce: string, codeVerifier: string, browserTransaction: string }} secrets
     * @returns {boolean} false when the bounded store is full or input is invalid
     */
    store(state, { nonce, codeVerifier, browserTransaction }) {
      const now = Date.now();
      const transactionHash = hashBrowserTransaction(browserTransaction);
      if (
        typeof state !== 'string'
        || state.length === 0
        || typeof nonce !== 'string'
        || typeof codeVerifier !== 'string'
        || transactionHash === null
      ) {
        return false;
      }
      pruneExpired(now);
      if (entries.size >= maximum) {
        return false;
      }
      entries.set(state, { nonce, codeVerifier, transactionHash, expiresAt: now + ttl });
      return true;
    },

    /**
     * Consumes a pending request (single use). Returns `{ nonce, codeVerifier }`
     * when `state` exists and has not expired; null otherwise. The entry is
     * always removed, so a second consume of the same state fails.
     * @param {string} state
     * @param {string} browserTransaction opaque secure-cookie value for this browser
     * @returns {{ nonce: string, codeVerifier: string } | null}
     */
    consume(state, browserTransaction) {
      if (typeof state !== 'string' || state.length === 0) {
        return null;
      }
      const entry = entries.get(state);
      if (!entry) {
        return null;
      }
      entries.delete(state);
      if (Date.now() >= entry.expiresAt || !matchesTransaction(entry.transactionHash, browserTransaction)) {
        return null;
      }
      return { nonce: entry.nonce, codeVerifier: entry.codeVerifier };
    },

    /** Number of pending (possibly expired, not yet pruned) requests. */
    get size() {
      return entries.size;
    },
  };
}

/** Process-wide singleton used by the OIDC routes. */
export const oidcPkceStore = createOidcPkceStore();
