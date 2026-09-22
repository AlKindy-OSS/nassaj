import crypto from 'node:crypto';

import jwt from 'jsonwebtoken';

const ALLOWED_ALGORITHMS = Object.freeze(['RS256', 'PS256', 'ES256']);
const DISCOVERY_MAX_BYTES = 64 * 1024;
const JWKS_MAX_BYTES = 256 * 1024;
const TOKEN_RESPONSE_MAX_BYTES = 64 * 1024;
const TOKEN_MAX_BYTES = 16 * 1024;
const FETCH_TIMEOUT_MS = 5_000;
const CACHE_TTL_MS = 5 * 60_000;
// Minimum spacing between JWKS fetches triggered by an unseen kid, so key
// rotation is picked up without letting forged kids flood the IdP.
const JWKS_REFRESH_COOLDOWN_MS = 30_000;
const MAX_JWKS_KEYS = 32;
const MAX_REPLAY_ENTRIES = 10_000;
const LOGOUT_EVENT = 'http://schemas.openid.net/event/backchannel-logout';

export class OidcVerificationError extends Error {
  constructor(code) {
    super(code);
    this.name = 'OidcVerificationError';
    this.code = code;
  }
}

function fail(code) {
  throw new OidcVerificationError(code);
}

/** Parses a configured issuer without silently normalizing attacker-controlled input. */
export function parseExactHttpsIssuer(rawIssuer) {
  if (typeof rawIssuer !== 'string' || rawIssuer.length === 0 || rawIssuer !== rawIssuer.trim()) {
    fail('invalid_issuer_config');
  }
  let parsed;
  try {
    parsed = new URL(rawIssuer);
  } catch {
    fail('invalid_issuer_config');
  }
  if (
    parsed.protocol !== 'https:'
    || parsed.username
    || parsed.password
    || parsed.search
    || parsed.hash
  ) {
    fail('invalid_issuer_config');
  }
  const serialized = parsed.toString();
  const exact = serialized === rawIssuer
    || (parsed.pathname === '/' && serialized === `${rawIssuer}/`);
  if (!exact) {
    fail('invalid_issuer_config');
  }
  return rawIssuer;
}

function parseExactHttpsEndpoint(rawEndpoint, code) {
  if (typeof rawEndpoint !== 'string' || rawEndpoint.length === 0 || rawEndpoint !== rawEndpoint.trim()) {
    fail(code);
  }
  let parsed;
  try {
    parsed = new URL(rawEndpoint);
  } catch {
    fail(code);
  }
  if (
    parsed.protocol !== 'https:'
    || parsed.username
    || parsed.password
    || parsed.hash
    || parsed.toString() !== rawEndpoint
  ) {
    fail(code);
  }
  return rawEndpoint;
}

async function readBoundedJson(response, maxBytes, code) {
  const contentLength = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    fail(code);
  }

  const chunks = [];
  let total = 0;
  if (!response.body) {
    fail(code);
  }
  for await (const chunk of response.body) {
    const bytes = Buffer.from(chunk);
    total += bytes.length;
    if (total > maxBytes) {
      try {
        await response.body.cancel?.();
      } catch {
        // The size failure is authoritative; cancellation is best effort.
      }
      fail(code);
    }
    chunks.push(bytes);
  }
  try {
    return JSON.parse(Buffer.concat(chunks, total).toString('utf8'));
  } catch {
    fail(code);
  }
}

async function boundedFetchJson(fetchImpl, url, options, maxBytes, code) {
  let response;
  try {
    response = await fetchImpl(url, {
      ...options,
      redirect: 'error',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch {
    fail(code);
  }
  if (!response?.ok) {
    fail(code);
  }
  return readBoundedJson(response, maxBytes, code);
}

function validateDiscovery(raw, issuer) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || raw.issuer !== issuer) {
    fail('invalid_discovery');
  }
  const issuerOrigin = new URL(issuer).origin;
  // Zitadel discovery is trusted only as metadata beneath the configured issuer
  // origin. Authorization, token and JWKS endpoints on any other origin are not
  // allowlisted, even when Zitadel's discovery document advertises them.
  const allowlistedEndpoint = (endpoint, code) => {
    const parsed = new URL(parseExactHttpsEndpoint(endpoint, code));
    if (parsed.origin !== issuerOrigin) {
      fail(code);
    }
    return parsed.toString();
  };
  return Object.freeze({
    issuer,
    authorization_endpoint: allowlistedEndpoint(
      raw.authorization_endpoint,
      'invalid_discovery_authorization_endpoint',
    ),
    token_endpoint: allowlistedEndpoint(raw.token_endpoint, 'invalid_discovery_token_endpoint'),
    jwks_uri: allowlistedEndpoint(raw.jwks_uri, 'invalid_discovery_jwks_uri'),
  });
}

function decodeProtectedHeader(token) {
  if (typeof token !== 'string' || token.length === 0 || Buffer.byteLength(token, 'utf8') > TOKEN_MAX_BYTES) {
    fail('invalid_token');
  }
  let decoded;
  try {
    decoded = jwt.decode(token, { complete: true });
  } catch {
    fail('invalid_token');
  }
  const header = decoded?.header;
  if (!header || typeof header !== 'object') {
    fail('invalid_token');
  }
  if (!ALLOWED_ALGORITHMS.includes(header.alg)) {
    fail('invalid_algorithm');
  }
  if (typeof header.kid !== 'string' || header.kid.length === 0 || header.kid.length > 128) {
    fail('invalid_kid');
  }
  return header;
}

function validateJwks(raw) {
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.keys) || raw.keys.length > MAX_JWKS_KEYS) {
    fail('invalid_jwks');
  }
  return raw.keys.filter((key) => key && typeof key === 'object');
}

function selectVerificationKey(keys, header) {
  const matches = keys.filter((key) => (
    key.kid === header.kid
    && (!key.alg || key.alg === header.alg)
    && (!key.use || key.use === 'sig')
    && (!Array.isArray(key.key_ops) || key.key_ops.includes('verify'))
  ));
  if (matches.length !== 1) {
    fail('unknown_or_ambiguous_kid');
  }
  const jwk = matches[0];
  if ((header.alg === 'ES256' && jwk.kty !== 'EC') || (header.alg !== 'ES256' && jwk.kty !== 'RSA')) {
    fail('invalid_key_type');
  }
  try {
    return crypto.createPublicKey({ key: jwk, format: 'jwk' });
  } catch {
    fail('invalid_jwk');
  }
}

function validateClaims(claims, { issuer, clientId, expectedNonce, logout }) {
  if (!claims || typeof claims !== 'object' || Array.isArray(claims)) {
    fail('invalid_claims');
  }
  const nowSeconds = Math.floor(Date.now() / 1000);
  if (
    typeof claims.exp !== 'number'
    || typeof claims.iat !== 'number'
    || claims.iat > nowSeconds + 60
    || claims.iat > claims.exp
  ) {
    fail('invalid_time_claims');
  }
  if (claims.iss !== issuer) {
    fail('invalid_issuer');
  }
  const audiences = typeof claims.aud === 'string'
    ? [claims.aud]
    : Array.isArray(claims.aud) && claims.aud.every((audience) => typeof audience === 'string')
      ? claims.aud
      : [];
  if (!audiences.includes(clientId)) {
    fail('invalid_audience');
  }
  if (
    (audiences.length > 1 && claims.azp !== clientId)
    || (claims.azp !== undefined && claims.azp !== clientId)
  ) {
    fail('invalid_authorized_party');
  }
  if (typeof claims.sub !== 'string' || claims.sub.length === 0 || claims.sub.length > 512) {
    // sid-only logout needs durable sid-to-session state and is deliberately unsupported.
    fail('subject_required');
  }
  if (logout) {
    if ('nonce' in claims) {
      fail('logout_nonce_forbidden');
    }
    const logoutEvent = claims.events?.[LOGOUT_EVENT];
    if (
      !claims.events
      || typeof claims.events !== 'object'
      || Array.isArray(claims.events)
      || !(LOGOUT_EVENT in claims.events)
      || !logoutEvent
      || typeof logoutEvent !== 'object'
      || Array.isArray(logoutEvent)
    ) {
      fail('logout_event_required');
    }
    if (typeof claims.jti !== 'string' || claims.jti.length === 0 || claims.jti.length > 128) {
      fail('logout_jti_required');
    }
  } else if (typeof expectedNonce !== 'string' || claims.nonce !== expectedNonce) {
    fail('invalid_nonce');
  }
  return claims;
}

/** Creates an isolated verifier so tests and multiple configured RPs do not share cache state. */
export function createOidcVerifier({
  issuer,
  clientId,
  fetchImpl = globalThis.fetch,
  cacheTtlMs = CACHE_TTL_MS,
  jwksRefreshCooldownMs = JWKS_REFRESH_COOLDOWN_MS,
} = {}) {
  const trustedIssuer = parseExactHttpsIssuer(issuer);
  if (typeof clientId !== 'string' || clientId.length === 0 || clientId.length > 512) {
    fail('invalid_client_id');
  }
  if (typeof fetchImpl !== 'function') {
    fail('invalid_fetch_implementation');
  }

  let discoveryCache = null;
  let jwksCache = null;
  let lastForcedJwksRefreshAt = 0;
  const replay = new Map();

  async function getDiscovery() {
    const now = Date.now();
    if (discoveryCache && discoveryCache.expiresAt > now) {
      return discoveryCache.value;
    }
    const discoveryUrl = `${trustedIssuer.replace(/\/$/, '')}/.well-known/openid-configuration`;
    const raw = await boundedFetchJson(
      fetchImpl,
      discoveryUrl,
      { headers: { accept: 'application/json' } },
      DISCOVERY_MAX_BYTES,
      'discovery_unavailable',
    );
    const value = validateDiscovery(raw, trustedIssuer);
    discoveryCache = { value, expiresAt: now + cacheTtlMs };
    return value;
  }

  async function getJwks(discovery, { force = false } = {}) {
    const now = Date.now();
    if (!force && jwksCache && jwksCache.uri === discovery.jwks_uri && jwksCache.expiresAt > now) {
      return jwksCache.keys;
    }
    const raw = await boundedFetchJson(
      fetchImpl,
      discovery.jwks_uri,
      { headers: { accept: 'application/json' } },
      JWKS_MAX_BYTES,
      'jwks_unavailable',
    );
    const keys = validateJwks(raw);
    jwksCache = { uri: discovery.jwks_uri, keys, fetchedAt: now, expiresAt: now + cacheTtlMs };
    return keys;
  }

  /** Cached keys, refreshed once per cooldown when the kid is unseen (key rotation). */
  async function keysForKid(discovery, kid) {
    const keys = await getJwks(discovery);
    if (keys.some((key) => key.kid === kid)) {
      return keys;
    }
    const now = Date.now();
    // Stamped before the await so concurrent and failing refreshes share one slot.
    if (Math.max(jwksCache.fetchedAt, lastForcedJwksRefreshAt) + jwksRefreshCooldownMs > now) {
      return keys;
    }
    lastForcedJwksRefreshAt = now;
    return getJwks(discovery, { force: true });
  }

  async function verify(token, options) {
    const discovery = await getDiscovery();
    const header = decodeProtectedHeader(token);
    const keys = await keysForKid(discovery, header.kid);
    const key = selectVerificationKey(keys, header);
    let claims;
    try {
      claims = jwt.verify(token, key, {
        algorithms: ALLOWED_ALGORITHMS,
        issuer: trustedIssuer,
        audience: clientId,
        clockTolerance: 5,
      });
    } catch {
      fail('signature_or_registered_claim_invalid');
    }
    return validateClaims(claims, {
      issuer: trustedIssuer,
      clientId,
      ...options,
    });
  }

  function recordLogoutReplay(claims) {
    const now = Date.now();
    for (const [key, expiresAt] of replay) {
      if (expiresAt <= now) replay.delete(key);
    }
    const replayKey = `${trustedIssuer}\0${claims.jti}`;
    if (replay.has(replayKey)) {
      fail('logout_replay');
    }
    if (replay.size >= MAX_REPLAY_ENTRIES) {
      fail('logout_replay_store_full');
    }
    replay.set(replayKey, Math.min(claims.exp * 1000, now + 24 * 60 * 60_000));
  }

  return Object.freeze({
    getDiscovery,

    async exchangeAuthorizationCode(body) {
      const discovery = await getDiscovery();
      return boundedFetchJson(
        fetchImpl,
        discovery.token_endpoint,
        {
          method: 'POST',
          headers: {
            accept: 'application/json',
            'content-type': 'application/x-www-form-urlencoded',
          },
          body,
        },
        TOKEN_RESPONSE_MAX_BYTES,
        'token_exchange_failed',
      );
    },

    verifyIdToken(token, expectedNonce) {
      return verify(token, { expectedNonce, logout: false });
    },

    async verifyLogoutToken(token) {
      const claims = await verify(token, { logout: true });
      recordLogoutReplay(claims);
      return claims;
    },
  });
}

export const OIDC_LIMITS = Object.freeze({
  discoveryBytes: DISCOVERY_MAX_BYTES,
  jwksBytes: JWKS_MAX_BYTES,
  tokenBytes: TOKEN_MAX_BYTES,
  timeoutMs: FETCH_TIMEOUT_MS,
});
