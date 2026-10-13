/**
 * Read-only session share links (ADR-196 T-1970; live links ADR-205 T-2013).
 *
 * Management (mounted outside authenticateToken; Bearer JWT, or the wallet
 * device cookie resolved by authenticateToken through the mount's bridge):
 *   POST /api/sessions/:sessionId/shares/preview     -> 410 SNAPSHOT_SHARES_RETIRED
 *   POST /api/sessions/:sessionId/shares             -> 201 live link (strict owner only)
 *   GET  /api/sessions/:sessionId/shares
 *   GET  /api/sessions/:sessionId/shares/eligibility -> { canShare, canManage }
 *   GET  /api/sessions/:sessionId/shares/status      -> { activeLiveLinks }
 *   GET  /api/session-shares/mine
 *   POST /api/session-shares/:id/revoke
 * Public legacy snapshot reader (mounted before the global CORS middleware):
 *   GET/OPTIONS /api/session-shares/:id   (X-Share-Token header; snapshot rows only)
 *
 *   curl -X POST -H "Authorization: Bearer $JWT" -H 'Content-Type: application/json' \
 *     -d '{"expiry":"7d"}' https://host/api/sessions/<sessionId>/shares
 */
import { randomBytes } from 'node:crypto';
import { gunzipSync } from 'node:zlib';

import express from 'express';

import {
  SHARE_EXPIRY_MS, SessionShareError, canManageSession, canManageShare, createViewRecorder,
  createWindowLimiter, evaluateShareEligibility, resolveLiveCreateContext, shareSessionTitle,
} from '../services/session-share-policy.js';
import {
  admittedOrThrow, assertGuestReadable, guestIpKey, releaseWhenDone, setGuestHeaders, shareUnavailable,
  verifyGuestToken,
} from '../services/share-guest-access.js';
import { createGuestGuards } from '../services/share-guest-guards.js';
import { parsePublicOrigin } from '../services/share-page.js';
import { createShareId, createShareToken, hashShareToken, isShareId } from '../services/share-capability.js';
import { ipRateKey } from '../utils/ip-rate-key.js';
import { clientIp } from '../utils/client-ip.js';

const SESSION_ID = /^[A-Za-z0-9._:-]{1,200}$/;
const MAX_JSON_BYTES = 32 * 1024 * 1024;
const READ_TIMEOUT_MS = 30_000;
/** ADR-205 D5: default expiry of a new live link. */
export const DEFAULT_LIVE_EXPIRY = '7d';

function securityHeaders(res) {
  res.set({ 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer', 'X-Robots-Tag': 'noindex, nofollow, noarchive' });
}

function respondError(res, error) {
  if (res.headersSent || res.destroyed) return;
  const known = error instanceof SessionShareError;
  const appStatus = Number.isInteger(error?.statusCode) && [404, 409, 413, 429].includes(error.statusCode);
  const status = known ? error.status : appStatus ? error.statusCode : 503;
  const code = known || appStatus ? error.code : 'TEMPORARILY_UNAVAILABLE';
  const { retryAfterSec, ...extra } = known && error.extra ? error.extra : {};
  if (retryAfterSec) res.set('Retry-After', String(retryAfterSec));
  res.status(status).json({ error: { code, ...extra } });
}

function validBody(body, allowed) {
  if (body === undefined) return {};
  if (!body || typeof body !== 'object' || Array.isArray(body)
      || Object.keys(body).some((key) => !allowed.includes(key))) throw new SessionShareError('INVALID_INPUT', 400);
  return body;
}

function requireJson(req) {
  if (Number(req.get('content-length') || 0) > 0 && !req.is('application/json')) {
    throw new SessionShareError('UNSUPPORTED_MEDIA_TYPE', 415);
  }
}

/**
 * Public-safe projection of a row; never the token hash, the blob or the ref key.
 * Live rows hold placeholders in the snapshot columns, mapped to null here.
 */
function publicShare(row, nowMs) {
  const live = row.mode === 'live';
  let redactionCounts = null;
  try { redactionCounts = live ? null : JSON.parse(row.redaction_counts); } catch { redactionCounts = null; }
  return {
    id: row.id, sessionId: row.session_id, mode: live ? 'live' : 'snapshot', createdBy: row.created_by,
    ownerUserId: row.owner_user_id, createdAt: row.created_at, expiresAt: row.expires_at,
    revokedAt: row.revoked_at ?? null, revokeReason: row.revoke_reason ?? null,
    upToMessageId: live ? null : row.up_to_message_id, messageCount: live ? null : row.message_count,
    redactionCounts, viewCount: row.view_count ?? 0, lastViewedAt: row.last_viewed_at ?? null,
    active: !row.revoked_at && Date.parse(row.expires_at) > nowMs,
  };
}

/**
 * A device-cookie identity that authenticateToken already resolved through
 * the mount's bridge (origin and CSRF checked there for mutations). It is
 * rechecked on every call, so the post-build recheck sees a revoked or
 * switched device; a forced password rotation is refused as the Bearer
 * verifier refuses it.
 */
function deviceSessionUser(req) {
  if (req.user?.authenticationKind !== 'device_session' || !req.devicePrincipal) return null;
  if (req.assertCurrentIdentity?.() !== true || req.user.must_change_password === 1) {
    throw new SessionShareError('AUTH_REQUIRED', 401);
  }
  return req.user;
}

/**
 * Identity independent of platform mode: a Bearer JWT through the share
 * verifier, or a device session resolved by the single authenticateToken
 * (ADR-163 amendment 1, M4). A device cookie beside a Bearer is refused
 * exactly as authenticateToken refuses it.
 */
function createAuthenticator({ verifyUser, deviceCookieName, deviceCookiesEnabled }) {
  return (req) => {
    const deviceUser = deviceSessionUser(req);
    if (deviceUser) return deviceUser;
    const cookie = String(req.headers.cookie || '');
    const hasDeviceCookie = deviceCookiesEnabled() && deviceCookieName
      && new RegExp(`(?:^|;\\s*)${deviceCookieName.replace(/[^A-Za-z0-9_-]/g, '\\$&')}=`).test(cookie);
    if (hasDeviceCookie && req.get('Authorization')) throw new SessionShareError('AMBIGUOUS_AUTHENTICATION', 400);
    const user = verifyUser(req.get('Authorization'));
    if (!user || user.authenticationKind === 'platform_unverified') throw new SessionShareError('AUTH_REQUIRED', 401);
    return user;
  };
}

function sessionParam(req) {
  if (!SESSION_ID.test(req.params.sessionId)) throw new SessionShareError('SESSION_NOT_FOUND', 404);
  return req.params.sessionId;
}

function requireOrigin(publicOrigin) {
  const origin = parsePublicOrigin(publicOrigin);
  if (!origin) throw new SessionShareError('SHARING_NOT_CONFIGURED', 503);
  return origin;
}

/** ADR-205 D6 retirement: no new snapshot links; the preview step is gone. */
function registerPreview(router, ctx) {
  router.post('/sessions/:sessionId/shares/preview', ctx.handle(async () => {
    throw new SessionShareError('SNAPSHOT_SHARES_RETIRED', 410);
  }));
}

/** `{ expiry? }` → expiry key; the default is seven days. */
function parseLiveCreateBody(body) {
  const input = validBody(body, ['expiry']);
  const expiry = input.expiry ?? DEFAULT_LIVE_EXPIRY;
  if (typeof expiry !== 'string' || !Object.hasOwn(SHARE_EXPIRY_MS, expiry)) throw new SessionShareError('INVALID_INPUT', 400);
  return expiry;
}

function liveShareRow({ sessionId, project, ownerUserId, user, expiry, token, nowMs }) {
  return {
    id: createShareId(), session_id: sessionId, project_id: project.project_id, owner_user_id: ownerUserId,
    token_hash: hashShareToken(token), created_by: user.id, created_at: new Date(nowMs).toISOString(),
    expires_at: new Date(nowMs + SHARE_EXPIRY_MS[expiry]).toISOString(), ref_key: randomBytes(32),
  };
}

/** ADR-205: creates a live read link; only the strict session owner (M9). */
function registerCreate(router, ctx) {
  router.post('/sessions/:sessionId/shares', ctx.writer, ctx.handle(async (req, res, user) => {
    requireJson(req);
    const expiry = parseLiveCreateBody(req.body);
    const origin = requireOrigin(ctx.publicOrigin);
    const sessionId = sessionParam(req);
    const { ownerUserId, project } = resolveLiveCreateContext(user, sessionId, ctx.policy);
    const token = createShareToken();
    const nowMs = ctx.now();
    const row = liveShareRow({ sessionId, project, ownerUserId, user, expiry, token, nowMs });
    if (!ctx.getStore().insertLiveWithinCaps(row, new Date(nowMs).toISOString())) {
      throw new SessionShareError('SHARE_LIMIT_REACHED', 429);
    }
    ctx.audit('session_share_created', user.id, { shareId: row.id, sessionId, expiry, mode: 'live' });
    res.status(201).json({ share: publicShare({ ...row, mode: 'live' }, nowMs), shareUrl: `${origin}/s/${row.id}#token=${token}` });
  }));
}

/** Per-request memo of the lookups a list touches, so 200 rows cost one query per distinct key. */
function memoizedPolicy(policy) {
  const memo = (fn) => {
    const cache = new Map();
    return (key) => {
      if (!cache.has(key)) cache.set(key, fn(key));
      return cache.get(key);
    };
  };
  return { ...policy, getSession: memo(policy.getSession), resolveOwner: memo(policy.resolveOwner),
    getUserName: memo((id) => policy.getUserName?.(id) ?? null) };
}

/** List item for an authenticated manager: public fields plus viewer-scoped labels. */
function listedShare(row, user, policy, nowMs) {
  return { ...publicShare(row, nowMs), sessionTitle: shareSessionTitle(user, row, policy),
    createdByName: policy.getUserName(row.created_by), createdBySelf: row.created_by === user.id };
}

/**
 * ADR-205 D5: number of active live links of a session, for the in-session
 * notice. Zero for unknown sessions and sessions the caller cannot read, so
 * the route is no existence oracle.
 */
function activeLiveLinks(user, sessionId, ctx) {
  const session = sessionId ? ctx.policy.getSession(sessionId) : null;
  if (!session || !ctx.policy.isSessionReadable(sessionId, session.project_path, user.id)) return 0;
  return ctx.getStore().countActiveLive(sessionId, new Date(ctx.now()).toISOString());
}

function registerLists(router, ctx) {
  router.get('/sessions/:sessionId/shares/eligibility', ctx.handle(async (req, res, user) => {
    const sessionId = SESSION_ID.test(req.params.sessionId) ? req.params.sessionId : null;
    res.json(sessionId ? evaluateShareEligibility(user, sessionId, ctx.policy) : { canShare: false, canManage: false });
  }));
  router.get('/sessions/:sessionId/shares/status', ctx.handle(async (req, res, user) => {
    const sessionId = SESSION_ID.test(req.params.sessionId) ? req.params.sessionId : null;
    res.json({ activeLiveLinks: activeLiveLinks(user, sessionId, ctx) });
  }));
  router.get('/sessions/:sessionId/shares', ctx.handle(async (req, res, user) => {
    const sessionId = sessionParam(req);
    const policy = memoizedPolicy(ctx.policy);
    const rows = ctx.getStore().listBySession(sessionId);
    const visible = canManageSession(user, sessionId, policy) ? rows : rows.filter((row) => row.created_by === user.id);
    const nowMs = ctx.now();
    res.json({ shares: visible.map((row) => listedShare(row, user, policy, nowMs)) });
  }));
  router.get('/session-shares/mine', ctx.handle(async (_req, res, user) => {
    const policy = memoizedPolicy(ctx.policy);
    const nowMs = ctx.now();
    res.json({ shares: ctx.getStore().listForUser(user.id).map((row) => listedShare(row, user, policy, nowMs)) });
  }));
}

/** Revoke stays open to creator, owner and privileged users; the last live link drops the projection. */
function registerRevoke(router, ctx) {
  router.post('/session-shares/:id/revoke', ctx.writer, ctx.handle(async (req, res, user) => {
    requireJson(req);
    validBody(req.body, []);
    if (!isShareId(req.params.id)) throw shareUnavailable();
    const store = ctx.getStore();
    const row = store.get(req.params.id);
    if (!row || !canManageShare(user, row, ctx.policy)) throw shareUnavailable();
    const at = new Date(ctx.now()).toISOString();
    store.revoke(row.id, 'manual', at);
    if (row.mode === 'live' && store.countActiveLive(row.session_id, at) === 0) ctx.dropProjection(row.session_id);
    ctx.audit('session_share_revoked', user.id, { shareId: row.id, sessionId: row.session_id });
    res.status(204).end();
  }));
}

/**
 * Management router. Mount under `/api` outside authenticateToken; it
 * authenticates every request itself with the share JWT verifier, or accepts
 * the device session the mount's bridge resolved.
 * @param {object} deps getStore, verifyUser, policy, audit, writer, publicOrigin, now,
 *   deviceCookieName, deviceCookiesEnabled, dropProjection(sessionId)
 */
export function createSessionShareManagementRouter(deps) {
  const now = deps.now ?? Date.now;
  const authenticate = createAuthenticator({ verifyUser: deps.verifyUser, deviceCookieName: deps.deviceCookieName,
    deviceCookiesEnabled: deps.deviceCookiesEnabled ?? (() => false) });
  const managementLimit = createWindowLimiter({ limit: 120, windowMs: 60_000, now });
  const ctx = {
    ...deps, now, authenticate,
    writer: deps.writer ?? ((_req, _res, next) => next()),
    audit: deps.audit ?? (() => {}),
    dropProjection: deps.dropProjection ?? (() => {}),
    handle: (handler) => async (req, res) => {
      securityHeaders(res);
      try {
        if (!managementLimit(ipRateKey(clientIp(req)))) throw new SessionShareError('RATE_LIMITED', 429);
        await handler(req, res, authenticate(req));
      } catch (error) { respondError(res, error); }
    },
  };
  const router = express.Router();
  router.use(express.json({ limit: '8kb', strict: true }));
  registerPreview(router, ctx);
  registerCreate(router, ctx);
  registerLists(router, ctx);
  registerRevoke(router, ctx);
  return router;
}

const MANAGEMENT_PATH = /^\/(?:sessions\/[^/]+\/shares(?:\/(?:preview|eligibility|status))?|session-shares\/(?:mine|[^/]+\/revoke))$/;

/**
 * True for every management route path relative to `/api` (preview, create,
 * list, eligibility, status, mine, revoke). The single source for the app mount.
 */
export function isSessionShareManagementPath(path) {
  return typeof path === 'string' && MANAGEMENT_PATH.test(path);
}

/**
 * `/api` middleware that hands management paths to `dispatch(req, res, next)`
 * (the management router) and passes everything else on. `deviceIdentity`
 * runs first on management paths only: the device-cookie bridge
 * (authenticateDeviceCookieIfPresent) in production, a pass-through otherwise.
 */
export function createSessionShareManagementMount(dispatch, deviceIdentity = (_req, _res, next) => next()) {
  return (req, res, next) => (isSessionShareManagementPath(req.path)
    ? deviceIdentity(req, res, () => dispatch(req, res, next))
    : next());
}

/** True for the public read path; `mine` and sub-paths belong to management. */
export function isPublicSessionSharePath(pathname) {
  const match = /^\/api\/session-shares\/([^/]+)$/.exec(pathname);
  return Boolean(match) && match[1] !== 'mine';
}

/**
 * D1 steps 1-4 for the legacy reader: shape, token, failure buckets, liveness,
 * and snapshot mode (live rows are read through /api/share-view only).
 */
function authorizeLegacyRead(req, id, deps, nowMs) {
  if (!parsePublicOrigin(deps.publicOrigin) || !isShareId(id)) throw shareUnavailable();
  const row = verifyGuestToken(req, id, deps);
  if (row.mode === 'live' || !row.snapshot) throw shareUnavailable();
  assertGuestReadable(row, deps.policy, nowMs);
  return row;
}

function sendSnapshot(req, res, blob) {
  res.set('Vary', 'Accept-Encoding');
  res.type('application/json');
  if (req.acceptsEncodings('gzip') === 'gzip') {
    res.set('Content-Encoding', 'gzip');
    return res.end(blob);
  }
  return res.end(gunzipSync(blob, { maxOutputLength: MAX_JSON_BYTES }));
}

/**
 * Legacy snapshot reader (ADR-196), on the ADR-205 D1 authorization order:
 * token verification runs before any shared throttle, failures are charged
 * per IP bucket only, and reader slots are taken after liveness. Mount on the
 * app BEFORE the global cors() so the opaque-origin viewer's preflight gets an
 * explicit wildcard answer.
 * @param {object} deps getStore, policy, publicOrigin, now, recordView, readTimeoutMs, guards
 */
export function createSessionSharePublicHandler(deps) {
  const now = deps.now ?? Date.now;
  const readTimeoutMs = deps.readTimeoutMs ?? READ_TIMEOUT_MS;
  const guards = deps.guards ?? createGuestGuards({ now });
  const recordView = deps.recordView ? createViewRecorder({ flush: deps.recordView, now }) : () => {};
  const handler = (req, res, next) => {
    if (!isPublicSessionSharePath(req.path)) return next();
    if (req.method !== 'GET' && req.method !== 'OPTIONS') return next();
    setGuestHeaders(res);
    if (req.method === 'OPTIONS') return res.status(204).end();
    const id = req.path.slice('/api/session-shares/'.length);
    try {
      const row = authorizeLegacyRead(req, id, { ...deps, guards }, now());
      releaseWhenDone(res, admittedOrThrow(guards.admitReader(row.id, guestIpKey(req))), readTimeoutMs);
      sendSnapshot(req, res, row.snapshot);
      recordView(row.id);
    } catch (error) {
      respondError(res, error instanceof SessionShareError ? error : shareUnavailable());
    }
    return undefined;
  };
  /** Open global reader slots, for tests and diagnostics. */
  handler.activeReaders = () => guards.stats().globalReaders;
  return handler;
}
