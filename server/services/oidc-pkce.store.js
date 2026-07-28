/**
 * In-memory OIDC PKCE / state store (P-IDP-3, ADR-046).
 *
 * Holds the per-authorization-request secrets between GET /api/auth/oidc/login
 * and the GET /api/auth/oidc/callback that the IdP redirects back to. Keyed by
 * the `state` value (base64url, 32 random bytes — unguessable and also the CSRF
 * token echoed by the IdP), mapping to the matching `nonce` (replay defence on
 * the id_token), the PKCE `code_verifier`, and an expiry instant.
 *
 * Single-process only (Map, no shared store) — adequate for the single PM2 fork
 * this app runs as, mirroring the WebAuthn challenge store and the in-memory
 * rate limiter. Entries are single-use: consume() removes the entry before
 * returning it, so a replayed callback can never complete twice. Stale entries
 * are pruned lazily on store().
 *
 * Pattern intentionally identical to services/webauthn-challenge.store.js.
 */

// Authorization-code flows complete in seconds, but the user may pause at the
// IdP consent screen; 10 minutes is the conventional ceiling for a pending
// authorization request (matches the IdP's own auth-request TTL guidance).
const DEFAULT_TTL_MS = 10 * 60_000; // 10 minutes
const PRUNE_THRESHOLD = 1000;

/**
 * Factory — exported for unit tests (short TTLs, isolated state).
 * @param {{ ttlMs?: number }} [options]
 */
export function createOidcPkceStore({ ttlMs } = {}) {
  const ttl = ttlMs ?? DEFAULT_TTL_MS;
  /** @type {Map<string, { nonce: string, codeVerifier: string, expiresAt: number }>} */
  const entries = new Map();

  function pruneIfLarge(now) {
    if (entries.size < PRUNE_THRESHOLD) {
      return;
    }
    for (const [key, entry] of entries) {
      if (now > entry.expiresAt) {
        entries.delete(key);
      }
    }
  }

  return {
    /**
     * Registers a pending authorization request under its `state`.
     * @param {string} state base64url CSRF/state token from /login
     * @param {{ nonce: string, codeVerifier: string }} secrets
     */
    store(state, { nonce, codeVerifier }) {
      const now = Date.now();
      pruneIfLarge(now);
      entries.set(state, { nonce, codeVerifier, expiresAt: now + ttl });
    },

    /**
     * Consumes a pending request (single use). Returns `{ nonce, codeVerifier }`
     * when `state` exists and has not expired; null otherwise. The entry is
     * always removed, so a second consume of the same state fails.
     * @param {string} state
     * @returns {{ nonce: string, codeVerifier: string } | null}
     */
    consume(state) {
      if (typeof state !== 'string' || state.length === 0) {
        return null;
      }
      const entry = entries.get(state);
      if (!entry) {
        return null;
      }
      entries.delete(state);
      if (Date.now() > entry.expiresAt) {
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
