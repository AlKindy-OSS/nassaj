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
 * T-1939 slice 5: every entry carries a `purpose`. 'login' (the default) is the
 * ordinary sign-in; 'link' is a member's self-link started from an
 * authenticated session and additionally binds the local `userId` and the
 * instant the link was requested (`requestedAtMs`, checked against auth_time).
 * The callback branches on this field, so a login transaction can never link
 * and a link transaction can never act as a login.
 *
 * T-1939 6B: 'step_up' is an SSO-linked member re-proving themselves at the
 * IdP for a sensitive action. It binds `userId`, `requestedAtMs` and the
 * `audience` ('connector_owner'); the callback answers it with a one-time
 * step-up grant and never with a login.
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

const PURPOSES = new Set(['login', 'link', 'step_up']);
const STEP_UP_AUDIENCES = new Set(['connector_owner']);

/**
 * Normalizes the purpose-specific binding, or null when invalid. 'link' and
 * 'step_up' entries must name a positive integer user id and a finite request
 * instant; only 'step_up' carries (and requires) an audience; a 'login' entry
 * carries none of them.
 */
function purposeBinding({ purpose = 'login', userId, requestedAtMs, audience }) {
  if (!PURPOSES.has(purpose)) {
    return null;
  }
  if (purpose === 'login') {
    return userId === undefined && requestedAtMs === undefined && audience === undefined
      ? { purpose } : null;
  }
  if (!Number.isInteger(userId) || userId <= 0 || !Number.isFinite(requestedAtMs)) {
    return null;
  }
  if (purpose === 'link') {
    return audience === undefined ? { purpose, userId, requestedAtMs } : null;
  }
  return STEP_UP_AUDIENCES.has(audience) ? { purpose, userId, requestedAtMs, audience } : null;
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
  /**
   * @type {Map<string, { nonce: string, codeVerifier: string, transactionHash: Buffer,
   *   expiresAt: number, binding: { purpose: string, userId?: number, requestedAtMs?: number } }>}
   */
  const entries = new Map();

  function pruneExpired(now) {
    for (const [key, entry] of entries) {
      if (now >= entry.expiresAt) {
        entries.delete(key);
      }
    }
  }

  /**
   * Single-use consume that also reports the purpose of a state that was
   * known but can no longer be used (expired, or presented by another
   * browser), so the callback can answer on the right return page. The
   * purpose is the only thing revealed; no secret or user id leaves.
   * @param {string} state
   * @param {string} browserTransaction
   * @returns {{ entry: ({ nonce: string, codeVerifier: string, purpose: 'login' | 'link' | 'step_up',
   *   userId?: number, requestedAtMs?: number, audience?: string } | null),
   *   stalePurpose: 'login' | 'link' | 'step_up' | null }}
   */
  function consumeWithOutcome(state, browserTransaction) {
    if (typeof state !== 'string' || state.length === 0) {
      return { entry: null, stalePurpose: null };
    }
    const entry = entries.get(state);
    if (!entry) {
      return { entry: null, stalePurpose: null };
    }
    entries.delete(state);
    if (Date.now() >= entry.expiresAt || !matchesTransaction(entry.transactionHash, browserTransaction)) {
      return { entry: null, stalePurpose: entry.binding.purpose };
    }
    return {
      entry: { nonce: entry.nonce, codeVerifier: entry.codeVerifier, ...entry.binding },
      stalePurpose: null,
    };
  }

  return {
    /**
     * Registers a pending authorization request under its `state`.
     * @param {string} state base64url CSRF/state token from /login
     * @param {{ nonce: string, codeVerifier: string, browserTransaction: string,
     *   purpose?: 'login' | 'link' | 'step_up', userId?: number, requestedAtMs?: number,
     *   audience?: 'connector_owner' }} secrets
     * @returns {boolean} false when the bounded store is full or input is invalid
     */
    store(state, { nonce, codeVerifier, browserTransaction, ...binding }) {
      const now = Date.now();
      const transactionHash = hashBrowserTransaction(browserTransaction);
      const purpose = purposeBinding(binding);
      if (
        typeof state !== 'string'
        || state.length === 0
        || typeof nonce !== 'string'
        || typeof codeVerifier !== 'string'
        || transactionHash === null
        || purpose === null
      ) {
        return false;
      }
      pruneExpired(now);
      if (entries.size >= maximum) {
        return false;
      }
      entries.set(state, {
        nonce, codeVerifier, transactionHash, expiresAt: now + ttl, binding: purpose,
      });
      return true;
    },

    /**
     * Consumes a pending request (single use). Returns the secrets plus the
     * purpose binding (`purpose`, and for 'link' also `userId` and
     * `requestedAtMs`) when `state` exists and has not expired; null otherwise.
     * The entry is always removed, so a second consume of the same state fails.
     * @param {string} state
     * @param {string} browserTransaction opaque secure-cookie value for this browser
     * @returns {{ nonce: string, codeVerifier: string, purpose: 'login' | 'link' | 'step_up',
     *   userId?: number, requestedAtMs?: number, audience?: string } | null}
     */
    consume(state, browserTransaction) {
      return consumeWithOutcome(state, browserTransaction).entry;
    },

    consumeWithOutcome,

    /** Number of pending (possibly expired, not yet pruned) requests. */
    get size() {
      return entries.size;
    },
  };
}

/** Process-wide singleton used by the OIDC routes. */
export const oidcPkceStore = createOidcPkceStore();
