import { IS_PLATFORM } from "../constants/config";
import {
  getIdentityBarrierSnapshot,
  identityRequestSignal,
  lockIdentityBarrier,
  reconcileRevokedIdentity,
} from "../components/auth/accountIdentityBarrier";

import { decodeJwtExp } from "./jwt.js";

// localStorage key holding the JWT. Kept in sync with AUTH_TOKEN_STORAGE_KEY
// (src/components/auth/constants.ts) and the direct readers in
// WebSocketContext.tsx and shell/utils/socket.ts.
const AUTH_TOKEN_STORAGE_KEY = 'auth-token';
let cookieSessionKind = 'none';
const UNSAFE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export const setCookieSessionKind = (kind) => {
  cookieSessionKind = ['device', 'limited'].includes(kind) ? kind : 'none';
};

export const hasAuthenticatedSession = () =>
  Boolean(localStorage.getItem(AUTH_TOKEN_STORAGE_KEY)) || cookieSessionKind !== 'none';

const failClosedCookieIdentity = () => {
  const barrier = getIdentityBarrierSnapshot();
  if (barrier.phase === 'stable') reconcileRevokedIdentity();
  else lockIdentityBarrier(barrier.version, 'cookie_identity_rejected');
};

/** Request the server-bound CSRF material used by cookie-authenticated mutations. */
export const requestMutationCsrf = async (url, method, signal) => {
  if (cookieSessionKind === 'none') {
    return { response: new Response(null, { status: 401 }), token: null };
  }
  const target = new URL(url, window.location.origin);
  if (target.origin !== window.location.origin) throw new Error('mutation_csrf_origin_invalid');
  const pathname = target.pathname;
  if (!pathname.startsWith('/api/')) throw new Error('mutation_csrf_path_invalid');
  const query = new URLSearchParams({ method, path: pathname });
  const response = await fetch(`/api/auth/mutation-csrf?${query}`, {
    credentials: 'same-origin', cache: 'no-store', signal,
  });
  if (!response.ok) {
    if (response.status === 401) failClosedCookieIdentity();
    return { response, token: null };
  }
  const payload = await response.json().catch(() => null);
  if (signal?.aborted) return { response, token: null };
  const token = payload && typeof payload.csrfToken === 'string' && payload.csrfToken.length <= 4_096
    ? payload.csrfToken : null;
  const expiresAt = payload && typeof payload.expiresAt === 'number' ? payload.expiresAt : NaN;
  if (!token || !Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
    failClosedCookieIdentity();
    return { response: new Response(null, { status: 403 }), token: null };
  }
  return { response, token };
};

/**
 * Persist a server-rotated JWT and broadcast it to the rest of the app.
 *
 * The server refreshes the token mid-session via the `X-Refreshed-Token`
 * response header (server/middleware/auth.js) once it passes half its TTL.
 * Writing ONLY to localStorage (the old behaviour) left AuthContext's React
 * state holding the pre-rotation token, so the main WebSocket kept dialing with
 * a token that expired on day 7 — a permanent `expired` reconnect loop while
 * REST/shell (which read localStorage) survived (B-131 "random logout").
 *
 * This is the single writer for a refreshed token: it updates localStorage AND
 * fires `auth:token-refreshed` so AuthContext can adopt it into React state
 * (mirrors the existing `auth:unauthorized` channel). Shared by the fetch path
 * (api.js) and the XHR path (useFileTreeUpload).
 *
 * @param {string | null | undefined} token The rotated JWT (no-op if falsy).
 */
export const applyRefreshedToken = (token) => {
  if (!token) return;
  // Monotonic write (B-163): never regress localStorage to an older-or-equal-exp
  // token. localStorage feeds BOTH the WS URL (resolveWebSocketUrl) and the
  // Authorization header, so a regression re-arms the refresh storm.
  // Tokens minted in the same second share the same exp (seconds-resolution) and
  // are treated as "not strictly newer" — this kills the server-side burst
  // client-side before the server-side fix ships.
  const stored = localStorage.getItem(AUTH_TOKEN_STORAGE_KEY);
  if (stored === token) return; // identical string: no write, no event
  if (stored) {
    const nextExp = decodeJwtExp(token);
    const storedExp = decodeJwtExp(stored);
    if (typeof nextExp === 'number' && typeof storedExp === 'number' && nextExp <= storedExp) {
      return; // not strictly newer: ignore (fail-open when either side is undecodable)
    }
  }
  localStorage.setItem(AUTH_TOKEN_STORAGE_KEY, token);
  window.dispatchEvent(new CustomEvent('auth:token-refreshed', { detail: { token } }));
};

// Error codes a 401 body may carry when the nassaj JWT itself was rejected.
// The auth middleware (server/middleware/auth.js) answers with `{ error }` and
// NO code; route-level guards use one of these codes. Any OTHER code on a 401
// is a domain error that merely borrowed the status (a provider credential, an
// upstream OAuth refusal, …) and must never sign the member out (B-1043).
const SESSION_REJECTION_CODES = new Set([
  'AUTH_REQUIRED',
  'AUTHENTICATION_REQUIRED',
  'UNAUTHENTICATED',
  'UNAUTHORIZED',
  'device_session_invalid',
  'device_session_required',
  'identity_revoked',
]);

/**
 * Decide whether a 401 means "your nassaj session is invalid" (evict) or
 * "this endpoint's dependency refused you" (keep the session). Reads a CLONE
 * of the body so the caller can still consume the response. Fail-safe: an
 * unreadable body counts as a session rejection (the middleware's shape).
 *
 * @param {Response} response
 * @returns {Promise<boolean>} true when the session itself was rejected.
 */
export const isSessionRejection = async (response) => {
  let body = null;
  try {
    body = await response.clone().json();
  } catch {
    return true;
  }
  const code = body && typeof body.code === 'string' ? body.code : null;
  return code === null || SESSION_REJECTION_CODES.has(code);
};

// Single-flight guard: the in-flight refresh promise, shared by every caller
// (the proactive timer / focus-visibility-online checks in AuthContext AND the
// reactive 401-recovery path below) so concurrent triggers collapse into ONE
// POST /api/auth/refresh instead of a refresh storm.
let refreshInFlight = null;

/**
 * Proactively/reactively exchange the current JWT for a fresh one (B-131).
 *
 * Calls POST /api/auth/refresh with the CURRENT stored token via a RAW fetch —
 * deliberately NOT through authenticatedFetch, so a failed refresh can never
 * re-enter the 401 handler below (no recursion, no `auth:unauthorized` storm;
 * the refresh endpoint is the one request that must not retry itself).
 *
 * On success it persists + broadcasts the new token through the existing
 * `applyRefreshedToken` plumbing (localStorage + `auth:token-refreshed`) and
 * resolves to the token string. On ANY failure (no token, non-2xx, network,
 * missing token in body) it resolves to `null` — the caller decides whether to
 * evict. Concurrent callers share the single in-flight request.
 *
 * @returns {Promise<string | null>} the fresh token, or null on failure.
 */
export const refreshAuthToken = () => {
  if (refreshInFlight) return refreshInFlight;

  refreshInFlight = (async () => {
    if (IS_PLATFORM) return null;
    const token = localStorage.getItem(AUTH_TOKEN_STORAGE_KEY);
    if (!token) return null;
    try {
      const response = await fetch('/api/auth/refresh', {
        method: 'POST',
        signal: identityRequestSignal(),
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
      });
      if (!response.ok) return null;
      const data = await response.json().catch(() => null);
      const nextToken = data && data.token;
      if (!nextToken) return null;
      applyRefreshedToken(nextToken);
      return nextToken;
    } catch {
      return null;
    } finally {
      refreshInFlight = null;
    }
  })();

  return refreshInFlight;
};

/**
 * Utility function for authenticated API calls.
 *
 * The explicit `@returns` is load-bearing: this function is now recursive (the
 * 401-recovery replay calls itself), and without a declared return type TS
 * infers `Promise<any>` for the self-reference, which silently degrades every
 * caller's `.then((response) => …)` parameter to implicit `any`.
 *
 * @param {string} url
 * @param {(RequestInit & { __isRetry?: boolean, __identityBypass?: boolean }) | undefined} [options]
 * @returns {Promise<Response>}
 */
export const authenticatedFetch = async (url, options = {}) => {
  // `__isRetry` is an internal marker (never forwarded to fetch) flagging the
  // single silent replay that follows a 401-triggered refresh, so a replay that
  // still 401s cannot loop.
  const { __isRetry, __identityBypass, ...fetchOptions } = options;
  const token = localStorage.getItem(AUTH_TOKEN_STORAGE_KEY);
  const method = String(fetchOptions.method ?? 'GET').toUpperCase();
  const requestSignal = __identityBypass ? fetchOptions.signal : identityRequestSignal(fetchOptions.signal);

  const defaultHeaders = {};

  // Only set Content-Type for non-FormData requests
  if (!(fetchOptions.body instanceof FormData)) {
    defaultHeaders['Content-Type'] = 'application/json';
  }

  if (!IS_PLATFORM && token) {
    defaultHeaders['Authorization'] = `Bearer ${token}`;
  }

  if (!token && cookieSessionKind !== 'none' && UNSAFE_METHODS.has(method)) {
    const csrf = await requestMutationCsrf(url, method, requestSignal);
    if (!csrf.token) return csrf.response;
    defaultHeaders['X-CSRF-Token'] = csrf.token;
  }

  const response = await fetch(url, {
    ...fetchOptions,
    credentials: fetchOptions.credentials ?? 'same-origin',
    signal: requestSignal,
    headers: {
      ...defaultHeaders,
      ...fetchOptions.headers,
    },
  });

  // 401 handling. Only treat a 401 as a session issue when a token was actually
  // sent — a 401 with no token is the expected response for an unauthenticated
  // visitor (e.g. the login screen eagerly probing /api/branding),
  // and evicting there would trigger a redirect loop on every mount.
  if (response.status === 401 && !token && cookieSessionKind !== 'none') {
    const rejectedSession = await isSessionRejection(response);
    if (!requestSignal?.aborted && rejectedSession) {
      // The mutation may already have reached the server. Fence the UI and
      // reconcile the authoritative wallet; never replay or fall back to Bearer.
      failClosedCookieIdentity();
    }
    return response;
  }
  if (response.status === 401 && token && await isSessionRejection(response)) {
    // B-131 gap (د) — 401 recovery. On a long-lived tab a 401 is usually a
    // silently-expired token (sleeping device / throttled PWA timers) rather
    // than a real sign-out. Try ONE silent refresh + replay the original
    // request with the fresh token before giving up. refreshAuthToken uses a
    // raw fetch (never re-enters here) and `__isRetry` blocks a second refresh,
    // so there is no loop.
    if (!IS_PLATFORM && !__isRetry && ['GET', 'HEAD'].includes(method)) {
      const nextToken = await refreshAuthToken();
      if (nextToken) {
        return authenticatedFetch(url, { ...fetchOptions, __isRetry: true });
      }
    }
    // Refresh failed / disabled, or the replay still 401'd → definitive
    // rejection. Carry the EXACT rejected token so AuthContext can
    // compare-and-clear (never wipe a newer token a parallel tab just wrote).
    window.dispatchEvent(new CustomEvent('auth:unauthorized', { detail: { token } }));
    return response;
  }

  const refreshedToken = response.headers.get('X-Refreshed-Token');
  if (refreshedToken) {
    applyRefreshedToken(refreshedToken);
  }
  return response;
};

// API endpoints
export const api = {
  // Auth endpoints (no token required)
  auth: {
    status: (options = {}) => fetch('/api/auth/status', options),
    login: (username, password) => fetch('/api/auth/login', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    }),
    register: (username, password) => fetch('/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    }),
    user: (options = {}) => authenticatedFetch('/api/auth/user', options),
    userForIdentityReconciliation: () => authenticatedFetch('/api/auth/user', { __identityBypass: true }),
    // Current identity incl. role + status (Phase-MU).
    me: () => authenticatedFetch('/api/auth/me'),
    logout: () => authenticatedFetch('/api/auth/logout', { method: 'POST' }),

    // Proactively mint a fresh JWT before the current one expires (B-131 gap أ).
    // Single-flight + raw fetch (see refreshAuthToken) so it never recurses
    // through the 401 handler. Resolves to the new token string, or null.
    refresh: () => refreshAuthToken(),

    // Self-service profile (Phase-MU F-1 / F-2).
    // Change own password — returns a fresh token so the current device stays signed in.
    changePassword: (currentPassword, newPassword, options = {}) =>
      authenticatedFetch('/api/auth/me/password', {
        ...options,
        method: 'PATCH',
        credentials: 'same-origin',
        body: JSON.stringify({ currentPassword, newPassword }),
      }),
    // Change own username.
    changeUsername: (username) =>
      authenticatedFetch('/api/auth/me/username', {
        method: 'PATCH',
        body: JSON.stringify({ username }),
      }),
    // Upload own profile picture (multipart). The Content-Type header is left
    // unset so the browser adds the multipart boundary automatically.
    updateAvatar: (file) => {
      const formData = new FormData();
      formData.append('avatar', file);
      return authenticatedFetch('/api/auth/me/avatar', {
        method: 'PATCH',
        body: formData,
      });
    },
    // Pick a generated gallery avatar or a palette colour (no file upload).
    // Pass exactly one of { color } or { avatar } (an svg+xml data URI).
    updateAvatarChoice: (choice) =>
      authenticatedFetch('/api/auth/me/avatar-choice', {
        method: 'PATCH',
        body: JSON.stringify(choice),
      }),

    // WebAuthn passkeys (B-PK / C-PK). The two login endpoints are public
    // (no token yet); registration and credential management require auth.
    // Options endpoints return raw @simplewebauthn option JSON — pass them
    // straight to startRegistration/startAuthentication({ optionsJSON }).
    webauthn: {
      registerOptions: () =>
        authenticatedFetch('/api/auth/webauthn/register/options', { method: 'POST' }),
      // `response` is the RegistrationResponseJSON produced by startRegistration.
      registerVerify: (response, name) =>
        authenticatedFetch('/api/auth/webauthn/register/verify', {
          method: 'POST',
          body: JSON.stringify(name ? { response, name } : { response }),
        }),
      listCredentials: () => authenticatedFetch('/api/auth/webauthn/credentials'),
      renameCredential: (id, name) =>
        authenticatedFetch(`/api/auth/webauthn/credentials/${encodeURIComponent(id)}`, {
          method: 'PATCH',
          body: JSON.stringify({ name }),
        }),
      deleteCredential: (id) =>
        authenticatedFetch(`/api/auth/webauthn/credentials/${encodeURIComponent(id)}`, {
          method: 'DELETE',
        }),
      // Public login pair — same contract as POST /api/auth/login on verify.
      loginOptions: () => fetch('/api/auth/webauthn/login/options', { method: 'POST' }),
      // `response` is the AuthenticationResponseJSON produced by startAuthentication.
      loginVerify: (response) => fetch('/api/auth/webauthn/login/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ response }),
      }),
    },

    // OIDC single sign-on (B-728, server/routes/oidc.js). The browser leg
    // (`/login` → IdP → `/callback`) is a full-page navigation, never fetch.
    oidc: {
      // Public: trade the one-time code from /auth/oidc/return for a JWT. POST
      // only (GET is 404); the same-origin fetch carries the HttpOnly
      // `__Host-oidc-txn` cookie that binds the code to this browser.
      exchange: (code) => fetch('/api/auth/oidc/exchange', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code }),
      }),
      // Public, side-effect free: an empty exchange answers 400 when OIDC is
      // enabled and 501 when it is off. No code, so nothing is consumed and the
      // transaction cookie is left alone.
      probe: () => fetch('/api/auth/oidc/exchange', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      }),
      // Owner/admin: link an existing account to an IdP subject (`sub`).
      link: (targetUserId, subject) =>
        authenticatedFetch('/api/auth/oidc/link', {
          method: 'POST',
          body: JSON.stringify({ targetUserId, subject }),
        }),
      // Owner/admin: remove every IdP link of a user and revoke their sessions.
      unlink: (userId) =>
        authenticatedFetch(`/api/auth/oidc/link/${encodeURIComponent(userId)}`, {
          method: 'DELETE',
        }),
    },

    // Invite acceptance (public): creates a `user` account from an invite token.
    acceptInvite: (token, username, password) => fetch('/api/auth/invite/accept', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, username, password }),
    }),

    // Invite management (owner/admin).
    listInvites: () => authenticatedFetch('/api/auth/invites'),
    createInvite: ({ role, email, ttlHours } = {}) =>
      authenticatedFetch('/api/auth/invites', {
        method: 'POST',
        body: JSON.stringify({ role, email, ttlHours }),
      }),
    revokeInvite: (id) =>
      authenticatedFetch(`/api/auth/invites/${encodeURIComponent(id)}`, {
        method: 'DELETE',
      }),

    // User management (owner/admin list; owner-only mutations).
    listUsers: () => authenticatedFetch('/api/auth/users'),
    updateUserRole: (id, role) =>
      authenticatedFetch(`/api/auth/users/${encodeURIComponent(id)}/role`, {
        method: 'PATCH',
        body: JSON.stringify({ role }),
      }),
    updateUserStatus: (id, status) =>
      authenticatedFetch(`/api/auth/users/${encodeURIComponent(id)}/status`, {
        method: 'PATCH',
        body: JSON.stringify({ status }),
      }),
    // Reset another user's password to a generated temporary one (owner/admin).
    // The temp password is returned ONCE in plaintext.
    resetUserPassword: (id) =>
      authenticatedFetch(`/api/auth/users/${encodeURIComponent(id)}/reset-password`, {
        method: 'POST',
      }),
    // Permanently delete a user account (owner-only). Cannot delete self or last owner.
    deleteUser: (id) =>
      authenticatedFetch(`/api/auth/users/${encodeURIComponent(id)}`, {
        method: 'DELETE',
      }),
  },

  // App-wide branding (custom logo + title). Read is available to any
  // authenticated user (needed to render the header); writes are owner-only,
  // enforced on the server.
  branding: {
    get: () => authenticatedFetch('/api/settings/branding'),
    updateTitle: (title) =>
      authenticatedFetch('/api/settings/branding', {
        method: 'PUT',
        body: JSON.stringify({ title }),
      }),
    updateLogoOnly: (logoOnly) =>
      authenticatedFetch('/api/settings/branding', {
        method: 'PUT',
        body: JSON.stringify({ logoOnly }),
      }),
    updateSplashHideTitle: (splashHideTitle) =>
      authenticatedFetch('/api/settings/branding', {
        method: 'PUT',
        body: JSON.stringify({ splashHideTitle }),
      }),
    uploadLogo: (file, variant = 'light') => {
      const formData = new FormData();
      formData.append('logo', file);
      return authenticatedFetch(`/api/settings/branding/logo?variant=${encodeURIComponent(variant)}`, {
        method: 'POST',
        body: formData,
      });
    },
    deleteLogo: (variant = 'light') =>
      authenticatedFetch(`/api/settings/branding/logo?variant=${encodeURIComponent(variant)}`, {
        method: 'DELETE',
      }),
    // Node icon: a small server-identity badge stored as a base64 data-URI in
    // app_config. `nodeIconDataUri` may be a data-URI string (to set/replace) or
    // null (to clear). `nodeIconPosition` persists independently so position is
    // remembered when the icon is re-uploaded after being cleared. `nodeIconHref`
    // is an optional absolute http(s) link opened when the icon is clicked
    // (empty string clears it).
    updateNodeIcon: (nodeIconDataUri, nodeIconPosition, nodeIconHref) =>
      authenticatedFetch('/api/settings/branding', {
        method: 'PUT',
        body: JSON.stringify({ nodeIconDataUri, nodeIconPosition, nodeIconHref }),
      }),
    clearNodeIcon: () =>
      authenticatedFetch('/api/settings/branding', {
        method: 'PUT',
        body: JSON.stringify({ nodeIconDataUri: null }),
      }),
  },

  // User-to-user credential grants (T-1675). Self-scoped: every call acts on
  // the caller's own credential (as owner) or on grants offered to them.
  credentialGrants: {
    overview: () => authenticatedFetch('/api/credential-grants'),
    setGrantees: (provider, userIds) =>
      authenticatedFetch(`/api/credential-grants/${encodeURIComponent(provider)}/grantees`, {
        method: 'PUT',
        body: JSON.stringify({ userIds }),
      }),
    use: (provider, ownerUserId) =>
      authenticatedFetch(`/api/credential-grants/${encodeURIComponent(provider)}/use`, {
        method: 'PUT',
        body: JSON.stringify({ ownerUserId }),
      }),
  },

  // Protected endpoints
  // config endpoint removed - no longer needed (frontend uses window.location)
  // After the projectName → projectId migration the path/query identifier is
  // the DB-assigned `projectId`; parameter names reflect that for clarity.
  projects: () => authenticatedFetch('/api/projects'),
  archivedProjects: () => authenticatedFetch('/api/projects/archived'),
  projectSessions: (projectId, { limit = 20, offset = 0 } = {}) => {
    const params = new URLSearchParams();
    params.set('limit', String(limit));
    params.set('offset', String(offset));
    return authenticatedFetch(`/api/projects/${encodeURIComponent(projectId)}/sessions?${params.toString()}`);
  },
  sessionContext: (sessionId, options = {}) =>
    authenticatedFetch(`/api/projects/session-context/${encodeURIComponent(sessionId)}`, options),
  // Project Board — live projection of docs/project-state.json + ARCHITECTURE files.
  projectBoard: (projectId) =>
    authenticatedFetch(`/api/project-board/${encodeURIComponent(projectId)}`),
  // Multi-user participation (Phase-MU): humans + agents seen in a session/project.
  // Lazy endpoints — fetched on demand (hover/open), never in the initial load.
  sessionParticipants: (sessionId) =>
    authenticatedFetch(`/api/sessions/${encodeURIComponent(sessionId)}/participants`),
  sessionAgents: (sessionId) =>
    authenticatedFetch(`/api/sessions/${encodeURIComponent(sessionId)}/agents`),
  projectParticipants: (projectId) =>
    authenticatedFetch(`/api/projects/${encodeURIComponent(projectId)}/participants`),
  // Unified endpoint for persisted session messages.
  // Provider/project metadata are resolved by the backend from sessionId.
  unifiedSessionMessages: (sessionId, _provider = 'claude', { limit = null, offset = 0 } = {}) => {
    const params = new URLSearchParams();
    if (limit !== null) {
      params.append('limit', String(limit));
      params.append('offset', String(offset));
    }
    const queryString = params.toString();
    return authenticatedFetch(`/api/providers/sessions/${encodeURIComponent(sessionId)}/messages${queryString ? `?${queryString}` : ''}`);
  },
  renameProject: (projectId, displayName) =>
    authenticatedFetch(`/api/projects/${projectId}/rename`, {
      method: 'PUT',
      body: JSON.stringify({ displayName }),
    }),
  restoreProject: (projectId) =>
    authenticatedFetch(`/api/projects/${encodeURIComponent(projectId)}/restore`, {
      method: 'POST',
    }),
  // Batch mutations take opaque database IDs only; the server authorizes each
  // item independently and returns the IDs it actually changed.
  bulkProjects: (ids, action) =>
    authenticatedFetch('/api/projects/bulk', {
      method: 'POST',
      body: JSON.stringify({ ids, action }),
    }),
  // Project membership management (manager-only). Optional in this UI wave.
  getProjectMembers: (projectId, options = {}) =>
    authenticatedFetch(`/api/projects/${encodeURIComponent(projectId)}/members`, options),
  searchProjectMemberCandidates: (projectId, query, options = {}) =>
    authenticatedFetch(
      `/api/projects/${encodeURIComponent(projectId)}/member-candidates?q=${encodeURIComponent(query)}`,
      options,
    ),
  addProjectMember: (projectId, userId, role = 'member', options = {}) =>
    authenticatedFetch(`/api/projects/${encodeURIComponent(projectId)}/members`, {
      ...options,
      method: 'POST',
      body: JSON.stringify({ userId, role }),
    }),
  removeProjectMember: (projectId, userId, options = {}) =>
    authenticatedFetch(
      `/api/projects/${encodeURIComponent(projectId)}/members/${encodeURIComponent(userId)}`,
      { ...options, method: 'DELETE' },
    ),
  // Session deletion now mirrors project deletion:
  // - default: archive only (`isArchived = 1`)
  // - hardDelete: remove the row and, by default, its persisted transcript file
  deleteSession: (sessionId, hardDelete = false) => {
    const params = new URLSearchParams();
    if (hardDelete) {
      params.set('force', 'true');
    }
    const qs = params.toString();
    return authenticatedFetch(`/api/providers/sessions/${sessionId}${qs ? `?${qs}` : ''}`, {
      method: 'DELETE',
    });
  },
  getArchivedSessions: () =>
    authenticatedFetch('/api/providers/sessions/archived'),
  restoreSession: (sessionId) =>
    authenticatedFetch(`/api/providers/sessions/${sessionId}/restore`, {
      method: 'POST',
    }),
  bulkSessions: (ids, action) =>
    authenticatedFetch('/api/providers/sessions/bulk', {
      method: 'POST',
      body: JSON.stringify({ ids, action }),
    }),
  renameSession: (sessionId, summary) =>
    authenticatedFetch(`/api/providers/sessions/${sessionId}`, {
      method: 'PUT',
      body: JSON.stringify({ summary }),
    }),
  // `hardDelete` => server `?force=true` (remove DB row + Claude *.jsonl + sessions rows for path).
  deleteProject: (projectId, hardDelete = false) => {
    const params = new URLSearchParams();
    if (hardDelete) params.set('force', 'true');
    const qs = params.toString();
    return authenticatedFetch(`/api/projects/${projectId}${qs ? `?${qs}` : ''}`, {
      method: 'DELETE',
    });
  },
  searchConversationsUrl: (query, limit = 50) => {
    const token = localStorage.getItem(AUTH_TOKEN_STORAGE_KEY);
    const params = new URLSearchParams({ q: query, limit: String(limit) });
    if (token) params.set('token', token);
    return `/api/providers/search/sessions?${params.toString()}`;
  },
  createProject: (projectData) =>
    authenticatedFetch('/api/projects/create-project', {
      method: 'POST',
      body: JSON.stringify(projectData),
    }),
  migrateLegacyProjectStars: (projectIds) =>
    authenticatedFetch('/api/projects/migrate-legacy-stars', {
      method: 'POST',
      body: JSON.stringify({ projectIds }),
    }),
  toggleProjectStar: (projectId, starred) =>
    authenticatedFetch(`/api/projects/${encodeURIComponent(projectId)}/toggle-star`, {
      method: 'POST',
      body: JSON.stringify({ starred }),
    }),
  // Project logo (T-1403), multipart. The Content-Type header is left unset so
  // the browser adds the multipart boundary itself. Shared state: the logo the
  // uploader picks is the logo everyone on the team sees.
  uploadProjectLogo: (projectId, file) => {
    const formData = new FormData();
    formData.append('logo', file);
    return authenticatedFetch(`/api/projects/${encodeURIComponent(projectId)}/logo`, {
      method: 'POST',
      body: formData,
    });
  },
  deleteProjectLogo: (projectId) =>
    authenticatedFetch(`/api/projects/${encodeURIComponent(projectId)}/logo`, {
      method: 'DELETE',
    }),
  // Per-user session star/favorite. Idempotent — `starred` is the desired
  // absolute state, not a toggle. The user is taken from the auth token server-side.
  // Returns { success, data: { sessionId, projectName, starred } }.
  starSession: (sessionId, projectName, starred) =>
    authenticatedFetch('/api/sessions/star', {
      method: 'POST',
      body: JSON.stringify({ sessionId, projectName, starred }),
    }),
  readFile: (projectId, filePath) =>
    authenticatedFetch(`/api/projects/${projectId}/file?filePath=${encodeURIComponent(filePath)}`),
  readFileBlob: (projectId, filePath) =>
    authenticatedFetch(`/api/projects/${projectId}/files/content?path=${encodeURIComponent(filePath)}`),
  saveFile: (projectId, filePath, content) =>
    authenticatedFetch(`/api/projects/${projectId}/file`, {
      method: 'PUT',
      body: JSON.stringify({ filePath, content }),
    }),
  getFiles: (projectId, options = {}) =>
    authenticatedFetch(`/api/projects/${projectId}/files`, options),

  // File operations
  createFile: (projectId, { path, type, name }) =>
    authenticatedFetch(`/api/projects/${projectId}/files/create`, {
      method: 'POST',
      body: JSON.stringify({ path, type, name }),
    }),

  renameFile: (projectId, { oldPath, newName }) =>
    authenticatedFetch(`/api/projects/${projectId}/files/rename`, {
      method: 'PUT',
      body: JSON.stringify({ oldPath, newName }),
    }),

  deleteFile: (projectId, { path, type }) =>
    authenticatedFetch(`/api/projects/${projectId}/files`, {
      method: 'DELETE',
      body: JSON.stringify({ path, type }),
    }),

  uploadFiles: (projectId, formData) =>
    authenticatedFetch(`/api/projects/${projectId}/files/upload`, {
      method: 'POST',
      body: formData,
      headers: {}, // Let browser set Content-Type for FormData
    }),

  // Browse filesystem for project suggestions
  browseFilesystem: (dirPath = null) => {
    const params = new URLSearchParams();
    if (dirPath) params.append('path', dirPath);

    return authenticatedFetch(`/api/browse-filesystem?${params}`);
  },

  createFolder: (folderPath) =>
    authenticatedFetch('/api/create-folder', {
      method: 'POST',
      body: JSON.stringify({ path: folderPath }),
    }),

  // User endpoints
  user: {
    gitConfig: () => authenticatedFetch('/api/user/git-config'),
    updateGitConfig: (gitName, gitEmail) =>
      authenticatedFetch('/api/user/git-config', {
        method: 'POST',
        body: JSON.stringify({ gitName, gitEmail }),
      }),
    onboardingStatus: () => authenticatedFetch('/api/user/onboarding-status'),
    completeOnboarding: () =>
      authenticatedFetch('/api/user/complete-onboarding', {
        method: 'POST',
      }),
    // Per-user Claude subscription link status (Phase-MU, B-MU-ONBOARD).
    // Returns { connected: boolean, provider: 'claude' }. With per-user
    // isolation each user links their own Claude credential via the terminal
    // (`claude setup-token`); the owner is symbolically linked automatically.
    claudeConnection: () => authenticatedFetch('/api/user/claude-connection'),
    // Per-user Antigravity (agy) subscription link status. Mirrors
    // claudeConnection: returns { connected: boolean, provider: 'agy' }. Each
    // user links their own agy credential by running `agy` interactively in the
    // terminal (which launches OAuth when no valid token exists); the owner is
    // symbolically linked automatically and always reports connected: true.
    agyConnection: () => authenticatedFetch('/api/user/agy-connection'),
  },

  // Provider account/usage endpoints.
  providers: {
    // Claude account usage (plan limits, session/weekly windows, extra usage).
    // Backend caches for 180s; the client should not poll more frequently.
    claudeUsage: () => authenticatedFetch('/api/providers/claude/usage'),
    // Quota windows as the PROVIDER itself reports them (codex: ChatGPT backend;
    // glm: z.ai monitor). 404 = no official source for that provider — an
    // explicit answer the caller must distinguish from a failure. The token/key
    // stays server-side; only percentages and reset instants come back.
    providerQuota: (provider, options = {}) =>
      authenticatedFetch(
        `/api/providers/${encodeURIComponent(provider)}/quota` +
          (options.model ? `?model=${encodeURIComponent(options.model)}` : ''),
        { signal: options.signal },
      ),
    // Billing cycle per provider — the CHEAP half of the subscription surface:
    // anchor + window only, no amounts (measured 742ms cold / 0ms warm, against
    // ~14s for /costs/subscriptions, which scans every transcript in the cycle
    // and therefore may not back an always-visible component). `options`
    // forwards an AbortSignal so a switch mid-flight cancels instead of landing.
    providerCycles: (options = {}) =>
      authenticatedFetch('/api/providers/costs/cycle', { signal: options.signal }),
    // Antigravity (agy) read-only active model. The model is chosen inside agy's
    // own settings; agy ignores any UI selection, so we only display it.
    antigravityActiveModel: () => authenticatedFetch('/api/providers/antigravity/active-model'),
    // Active background workflows (B-103, ADR-053). Read-only: the caller's
    // still-running / orphaned workflows across the sessions they own. The
    // envelope carries the declared scan cap so "no workflow" is distinguishable
    // from "not scanned". `options` forwards an AbortSignal for unmount cleanup.
    activeWorkflows: (options = {}) => authenticatedFetch('/api/providers/workflows/active', options),
  },

  // Generic GET method for any endpoint
  get: (endpoint) => authenticatedFetch(`/api${endpoint}`),

  // Generic POST method for any endpoint
  post: (endpoint, body) => authenticatedFetch(`/api${endpoint}`, {
    method: 'POST',
    ...(body instanceof FormData ? { body } : { body: JSON.stringify(body) }),
  }),

  // Generic PUT method for any endpoint
  put: (endpoint, body) => authenticatedFetch(`/api${endpoint}`, {
    method: 'PUT',
    body: JSON.stringify(body),
  }),

  // Generic DELETE method for any endpoint
  delete: (endpoint, options = {}) => authenticatedFetch(`/api${endpoint}`, {
    method: 'DELETE',
    ...options,
  }),
};
