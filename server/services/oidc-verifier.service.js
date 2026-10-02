/**
 * OIDC verifier (ADR-046; ADR-194 D3/D7, T-1962 S3).
 *
 * Two modes:
 *   - Pinned (SSO relying party): `endpoints` carries the authorization, token
 *     and JWKS URLs pinned at test-discovery. Runtime requests go ONLY to those
 *     URLs; `checkDiscoveryDrift()` refreshes discovery (5-minute cache) for
 *     drift detection alone and reports a changed issuer or pinned URL through
 *     `onDiscoveryDrift` (the caller persists `runtime_fault`). Endpoint-origin
 *     pinning replaces the old same-origin rule, so providers whose endpoints
 *     live on other origins work once the owner has pinned them.
 *   - Discovery (legacy env back channel, certified connectors): no pins; the
 *     discovery document is trusted only for endpoints on the issuer's origin.
 *
 * Every request goes through `pinnedFetchJson` (DNS pinning, the D7 address
 * matrix for the configured policy, no redirects, size and time caps) unless a
 * caller injects `fetchImpl` (certified connectors keep their own transport).
 * Confidential clients authenticate the token request with
 * client_secret_basic or client_secret_post; the secret is read through
 * `readClientSecret()` for that one request and never stored here.
 * Errors are OidcVerificationError with a fixed code; only an RFC 6749
 * `error` token (already filtered to [A-Za-z0-9_.-]{1,64}) may ride along as
 * `oauthError`, for the owner's own test result. Nothing here logs.
 */
import crypto from 'node:crypto';

import jwt from 'jsonwebtoken';

import { pinnedFetchJson } from '../modules/net/pinned-fetch.js';

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
const PINNED_KEYS = Object.freeze(['authorization_endpoint', 'token_endpoint', 'jwks_uri']);
const CLIENT_AUTH_METHODS = new Set(['none', 'client_secret_basic', 'client_secret_post']);
const FORM_CONTENT_TYPE = 'application/x-www-form-urlencoded';

/** A typed pinnedFetchJson code (D7), e.g. fetch_port_blocked or fetch_address_blocked:cgnat. */
const FETCH_CODE = /^fetch_[a-z0-9_]{1,40}(?::[a-z0-9_]{1,32})?$/;

export class OidcVerificationError extends Error {
  /**
   * @param {string} code fixed error code
   * @param {{ oauthError?: string, fetchCode?: string }} [detail] safe OAuth error token and the typed
   *   transport code only (never a body)
   */
  constructor(code, detail = {}) {
    super(code);
    this.name = 'OidcVerificationError';
    this.code = code;
    if (typeof detail.oauthError === 'string') this.oauthError = detail.oauthError;
    if (typeof detail.fetchCode === 'string' && FETCH_CODE.test(detail.fetchCode)) this.fetchCode = detail.fetchCode;
  }
}

function fail(code, detail) {
  throw new OidcVerificationError(code, detail);
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

/**
 * The verifier's request function over `pinnedFetchJson`: no redirects, the
 * row's address policy, and under `private_allowed` the single allowed port.
 * A non-2xx OAuth error body surfaces as `oauthError` on the thrown error.
 */
function createPinnedTransport({ addressPolicy = 'public', allowedPort, fetchJson = pinnedFetchJson, dependencies }) {
  if (addressPolicy !== 'public' && addressPolicy !== 'private_allowed') fail('invalid_network_policy');
  const portOption = addressPolicy === 'private_allowed' && allowedPort !== undefined && allowedPort !== null
    ? { allowedPort } : {};
  return async ({ url, method = 'GET', headers, body, maxBytes, code }) => {
    let result;
    try {
      result = await fetchJson({
        url, method, headers, body, addressPolicy, ...portOption, maxRedirects: 0, maxBytes, timeoutMs: FETCH_TIMEOUT_MS,
      }, dependencies);
    } catch (error) {
      fail(code, { fetchCode: typeof error?.code === 'string' ? error.code : undefined });
    }
    if (result?.oauthError) fail(code, { oauthError: result.oauthError.error });
    if (!result || result.status < 200 || result.status >= 300) {
      fail(code, { fetchCode: result ? `fetch_http_${Math.floor(result.status / 100)}xx` : undefined });
    }
    return result.json;
  };
}

/** Legacy transport for callers that inject their own fetch (certified connectors). */
function createFetchTransport(fetchImpl) {
  if (typeof fetchImpl !== 'function') fail('invalid_fetch_implementation');
  return ({ url, method = 'GET', headers, body, maxBytes, code }) => boundedFetchJson(
    fetchImpl, url, { method, headers, body }, maxBytes, code,
  );
}

function discoveryUrlFor(issuer) {
  return `${issuer.replace(/\/$/, '')}/.well-known/openid-configuration`;
}

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/** Discovery mode: endpoints are trusted only on the configured issuer's origin. */
function validateSameOriginDiscovery(raw, issuer) {
  if (!isPlainObject(raw) || raw.issuer !== issuer) {
    fail('invalid_discovery');
  }
  const issuerOrigin = new URL(issuer).origin;
  const sameOrigin = (endpoint, code) => {
    const parsed = new URL(parseExactHttpsEndpoint(endpoint, code));
    if (parsed.origin !== issuerOrigin) fail(code);
    return parsed.toString();
  };
  return Object.freeze({
    issuer,
    authorization_endpoint: sameOrigin(raw.authorization_endpoint, 'invalid_discovery_authorization_endpoint'),
    token_endpoint: sameOrigin(raw.token_endpoint, 'invalid_discovery_token_endpoint'),
    jwks_uri: sameOrigin(raw.jwks_uri, 'invalid_discovery_jwks_uri'),
  });
}

/**
 * Pinned endpoints: exact https URLs. `jwks_uri` is always required; the other
 * two may be absent only for a verify-only verifier (back channel, D1 broken
 * row), whose authorization or token use then fails with `endpoint_unpinned`.
 */
function validatePinnedEndpoints(raw) {
  if (!isPlainObject(raw)) fail('invalid_pinned_endpoints');
  const pins = {};
  for (const key of PINNED_KEYS) {
    if (raw[key] === undefined && key !== 'jwks_uri') continue;
    pins[key] = parseExactHttpsEndpoint(raw[key], 'invalid_pinned_endpoints');
  }
  return Object.freeze(pins);
}

/** True when a refreshed discovery document disagrees with the pins (D3 drift). */
function discoveryDrifted(raw, issuer, pins) {
  if (!isPlainObject(raw) || raw.issuer !== issuer) return true;
  return PINNED_KEYS.some((key) => pins[key] !== undefined && raw[key] !== pins[key]);
}

const stringList = (value) => (Array.isArray(value) ? value.filter((item) => typeof item === 'string') : null);

function discoveryFlagsOf(raw) {
  return Object.freeze({
    authorization_response_iss_parameter_supported: raw.authorization_response_iss_parameter_supported === true,
    backchannel_logout_supported: raw.backchannel_logout_supported === true,
    token_endpoint_auth_methods_supported: stringList(raw.token_endpoint_auth_methods_supported),
    code_challenge_methods_supported: stringList(raw.code_challenge_methods_supported),
  });
}

function capabilityFailure(raw, flags, clientAuth) {
  if (!stringList(raw.response_types_supported)?.includes('code')) return 'discovery_code_flow_unsupported';
  const algorithms = stringList(raw.id_token_signing_alg_values_supported) ?? [];
  if (!algorithms.some((alg) => ALLOWED_ALGORITHMS.includes(alg))) return 'discovery_signing_alg_unsupported';
  // I10: a missing token_endpoint_auth_methods_supported means client_secret_basic (RFC 8414).
  const methods = flags.token_endpoint_auth_methods_supported ?? ['client_secret_basic'];
  if (!methods.includes(clientAuth)) return 'discovery_client_auth_unsupported';
  const pkce = flags.code_challenge_methods_supported;
  if (pkce !== null && !pkce.includes('S256')) return 'discovery_pkce_s256_unsupported';
  return null;
}

/**
 * Test-discovery checks (ADR-194 D8, I10) on a raw discovery document: exact
 * issuer, https endpoints, code flow, a supported signing algorithm, the
 * configured client authentication advertised (absent list = basic), and S256
 * (absent list = warning only). Never throws on hostile input.
 * @returns {{ failure: string | null, endpoints: Record<string, string> | null,
 *   flags: Record<string, unknown> | null, warnings: string[] }}
 */
export function inspectDiscoveryDocument(raw, { issuer, clientAuth }) {
  if (!isPlainObject(raw) || raw.issuer !== issuer) {
    return { failure: 'discovery_issuer_mismatch', endpoints: null, flags: null, warnings: [] };
  }
  let endpoints;
  try {
    endpoints = validatePinnedEndpoints({
      authorization_endpoint: raw.authorization_endpoint, token_endpoint: raw.token_endpoint, jwks_uri: raw.jwks_uri,
    });
    if (PINNED_KEYS.some((key) => endpoints[key] === undefined)) fail('invalid_pinned_endpoints');
  } catch {
    return { failure: 'discovery_endpoint_invalid', endpoints: null, flags: null, warnings: [] };
  }
  const flags = discoveryFlagsOf(raw);
  const failure = CLIENT_AUTH_METHODS.has(clientAuth)
    ? capabilityFailure(raw, flags, clientAuth) : 'discovery_client_auth_unsupported';
  const warnings = flags.code_challenge_methods_supported === null ? ['discovery_pkce_methods_unadvertised'] : [];
  return { failure, endpoints, flags, warnings };
}

/** RFC 6749 Appendix B form encoding of one credential component. */
function formEncode(value) {
  return new URLSearchParams([['v', value]]).toString().slice(2);
}

/**
 * Builds the token request for the configured client authentication. The
 * secret is read here, used for this one request, and dropped.
 */
function tokenRequestFor({ clientId, clientAuth, readClientSecret }, { code, redirectUri, codeVerifier }) {
  const params = new URLSearchParams({
    grant_type: 'authorization_code', code, redirect_uri: redirectUri, code_verifier: codeVerifier,
  });
  const headers = { accept: 'application/json', 'content-type': FORM_CONTENT_TYPE };
  if (clientAuth === 'none') {
    params.set('client_id', clientId);
    return { headers, body: params.toString() };
  }
  let secret;
  try {
    secret = readClientSecret();
  } catch {
    fail('client_secret_unavailable');
  }
  if (typeof secret !== 'string' || secret.length === 0) fail('client_secret_unavailable');
  if (clientAuth === 'client_secret_basic') {
    const credentials = Buffer.from(`${formEncode(clientId)}:${formEncode(secret)}`, 'utf8').toString('base64');
    headers.authorization = `Basic ${credentials}`;
  } else {
    params.set('client_id', clientId);
    params.set('client_secret', secret);
  }
  return { headers, body: params.toString() };
}

function usableJwksKeyCount(keys) {
  return keys.filter((key) => typeof key.kid === 'string' && (key.kty === 'RSA' || key.kty === 'EC')
    && (!key.use || key.use === 'sig')).length;
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
  } else {
    if (typeof expectedNonce !== 'string' || claims.nonce !== expectedNonce) {
      fail('invalid_nonce');
    }
    // auth_time is optional in an id_token, but when present it must be a real
    // past instant: the self-link flow (T-1939 slice 5) trusts it as proof of a
    // fresh IdP sign-in.
    if (
      'auth_time' in claims
      && (!Number.isInteger(claims.auth_time) || claims.auth_time <= 0 || claims.auth_time > nowSeconds + 60)
    ) {
      fail('invalid_auth_time');
    }
  }
  return claims;
}

/**
 * The verified id_token's auth_time (when the user last actively signed in at
 * the IdP) in epoch ms, or null when the IdP did not send it. Only meaningful
 * on claims returned by verifyIdToken, which already validated its shape.
 * @param {Record<string, unknown>} claims
 * @returns {number | null}
 */
export function idTokenAuthTimeMs(claims) {
  const authTime = claims?.auth_time;
  return Number.isInteger(authTime) && authTime > 0 ? authTime * 1000 : null;
}

/** Validates the factory input once; throws OidcVerificationError on bad configuration. */
function verifierConfig({
  issuer, clientId, clientAuth = 'none', readClientSecret, endpoints, fetchImpl, network, onDiscoveryDrift,
}) {
  const trustedIssuer = parseExactHttpsIssuer(issuer);
  if (typeof clientId !== 'string' || clientId.length === 0 || clientId.length > 512) {
    fail('invalid_client_id');
  }
  if (!CLIENT_AUTH_METHODS.has(clientAuth)) fail('invalid_client_auth');
  if (clientAuth !== 'none' && typeof readClientSecret !== 'function') fail('invalid_client_auth');
  return Object.freeze({
    issuer: trustedIssuer,
    clientId,
    clientAuth,
    readClientSecret,
    pins: endpoints === undefined || endpoints === null ? null : validatePinnedEndpoints(endpoints),
    request: fetchImpl === undefined ? createPinnedTransport(network ?? {}) : createFetchTransport(fetchImpl),
    onDiscoveryDrift: typeof onDiscoveryDrift === 'function' ? onDiscoveryDrift : null,
  });
}

/** Discovery cache, endpoint resolution and drift detection for one verifier. */
function createDiscoveryState(config, cacheTtlMs) {
  let discoveryCache = null;
  let driftCheckedUntil = 0;

  const fetchRawDiscovery = () => config.request({
    url: discoveryUrlFor(config.issuer), maxBytes: DISCOVERY_MAX_BYTES, code: 'discovery_unavailable',
  });

  async function getDiscovery() {
    const now = Date.now();
    if (discoveryCache && discoveryCache.expiresAt > now) return discoveryCache.value;
    const value = validateSameOriginDiscovery(await fetchRawDiscovery(), config.issuer);
    discoveryCache = { value, expiresAt: now + cacheTtlMs };
    return value;
  }

  /** The endpoint to use: the pin in pinned mode, otherwise same-origin discovery. */
  async function endpoint(key) {
    if (config.pins === null) return (await getDiscovery())[key];
    const pinned = config.pins[key];
    if (pinned === undefined) fail('endpoint_unpinned');
    return pinned;
  }

  /**
   * Pinned mode only: refreshes discovery at most once per cache TTL and
   * compares it with the pins. Drift reports through onDiscoveryDrift and
   * throws discovery_endpoint_changed. An unreachable discovery is not drift
   * (runtime never depends on it) and answers 'unverified'.
   */
  async function checkDiscoveryDrift() {
    if (config.pins === null) fail('endpoint_unpinned');
    const now = Date.now();
    if (driftCheckedUntil > now) return 'ok';
    let raw;
    try {
      raw = await fetchRawDiscovery();
    } catch {
      return 'unverified';
    }
    if (discoveryDrifted(raw, config.issuer, config.pins)) {
      config.onDiscoveryDrift?.('discovery_endpoint_changed');
      fail('discovery_endpoint_changed');
    }
    driftCheckedUntil = now + cacheTtlMs;
    return 'ok';
  }

  return { getDiscovery, endpoint, checkDiscoveryDrift, fetchRawDiscovery };
}

/** JWKS cache with a rate-capped refresh for unseen kids (key rotation). */
function createJwksState(config, discovery, { cacheTtlMs, jwksRefreshCooldownMs }) {
  let jwksCache = null;
  let lastForcedJwksRefreshAt = 0;

  async function getJwks({ force = false } = {}) {
    const uri = await discovery.endpoint('jwks_uri');
    const now = Date.now();
    if (!force && jwksCache && jwksCache.uri === uri && jwksCache.expiresAt > now) return jwksCache.keys;
    const keys = validateJwks(await config.request({ url: uri, maxBytes: JWKS_MAX_BYTES, code: 'jwks_unavailable' }));
    jwksCache = { uri, keys, fetchedAt: now, expiresAt: now + cacheTtlMs };
    return keys;
  }

  async function keysForKid(kid) {
    const keys = await getJwks();
    if (keys.some((key) => key.kid === kid)) return keys;
    const now = Date.now();
    // Stamped before the await so concurrent and failing refreshes share one slot.
    if (Math.max(jwksCache.fetchedAt, lastForcedJwksRefreshAt) + jwksRefreshCooldownMs > now) return keys;
    lastForcedJwksRefreshAt = now;
    return getJwks({ force: true });
  }

  return { getJwks, keysForKid };
}

/** Per-verifier replay guard for logout tokens (per process, D-threat 13). */
function createReplayGuard(issuer) {
  const replay = new Map();
  return (claims) => {
    const now = Date.now();
    for (const [key, expiresAt] of replay) {
      if (expiresAt <= now) replay.delete(key);
    }
    const replayKey = `${issuer}\0${claims.jti}`;
    if (replay.has(replayKey)) fail('logout_replay');
    if (replay.size >= MAX_REPLAY_ENTRIES) fail('logout_replay_store_full');
    replay.set(replayKey, Math.min(claims.exp * 1000, now + 24 * 60 * 60_000));
  };
}

/** Test-discovery fetch (S4 consumer): discovery + JWKS checked per D8/I10. */
async function fetchDiscoveryForPinning(config, discovery) {
  const inspection = inspectDiscoveryDocument(await discovery.fetchRawDiscovery(), {
    issuer: config.issuer, clientAuth: config.clientAuth,
  });
  if (inspection.failure !== null) return { ...inspection, jwksKeyCount: 0 };
  const jwks = await config.request({
    url: inspection.endpoints.jwks_uri, maxBytes: JWKS_MAX_BYTES, code: 'jwks_unavailable',
  });
  const keyCount = usableJwksKeyCount(validateJwks(jwks));
  return { ...inspection, failure: keyCount > 0 ? null : 'jwks_no_usable_key', jwksKeyCount: keyCount };
}

/**
 * Creates an isolated verifier so tests and each configuration version do not
 * share cache state.
 * @param {{ issuer: string, clientId: string, clientAuth?: 'none' | 'client_secret_basic'
 *   | 'client_secret_post', readClientSecret?: () => string,
 *   endpoints?: { authorization_endpoint?: string, token_endpoint?: string, jwks_uri: string } | null,
 *   network?: { addressPolicy?: 'public' | 'private_allowed', allowedPort?: number | null,
 *     fetchJson?: typeof pinnedFetchJson, dependencies?: object },
 *   onDiscoveryDrift?: (code: string) => void, fetchImpl?: typeof fetch,
 *   cacheTtlMs?: number, jwksRefreshCooldownMs?: number }} options
 */
export function createOidcVerifier({
  cacheTtlMs = CACHE_TTL_MS, jwksRefreshCooldownMs = JWKS_REFRESH_COOLDOWN_MS, ...options
} = {}) {
  const config = verifierConfig(options);
  const discovery = createDiscoveryState(config, cacheTtlMs);
  const jwks = createJwksState(config, discovery, { cacheTtlMs, jwksRefreshCooldownMs });
  const recordLogoutReplay = createReplayGuard(config.issuer);

  async function verify(token, verifyOptions) {
    const header = decodeProtectedHeader(token);
    const key = selectVerificationKey(await jwks.keysForKid(header.kid), header);
    let claims;
    try {
      claims = jwt.verify(token, key, {
        algorithms: ALLOWED_ALGORITHMS, issuer: config.issuer, audience: config.clientId, clockTolerance: 5,
      });
    } catch {
      fail('signature_or_registered_claim_invalid');
    }
    return validateClaims(claims, { issuer: config.issuer, clientId: config.clientId, ...verifyOptions });
  }

  return Object.freeze({
    issuer: config.issuer,
    clientId: config.clientId,
    pinned: config.pins !== null,
    getDiscovery: discovery.getDiscovery,
    authorizationEndpoint: () => discovery.endpoint('authorization_endpoint'),
    checkDiscoveryDrift: discovery.checkDiscoveryDrift,
    fetchDiscoveryForPinning: () => fetchDiscoveryForPinning(config, discovery),

    /** Code exchange at the token endpoint with the configured client authentication. */
    async exchangeAuthorizationCode({ code, redirectUri, codeVerifier }) {
      const { headers, body } = tokenRequestFor(config, { code, redirectUri, codeVerifier });
      return config.request({
        url: await discovery.endpoint('token_endpoint'), method: 'POST', headers, body,
        maxBytes: TOKEN_RESPONSE_MAX_BYTES, code: 'token_exchange_failed',
      });
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
