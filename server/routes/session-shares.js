/**
 * Read-only session share links (ADR-196, T-1970 stage 4).
 *
 * Management (mounted outside authenticateToken; Bearer JWT, or the wallet
 * device cookie resolved by authenticateToken through the mount's bridge):
 *   POST /api/sessions/:sessionId/shares/preview
 *   POST /api/sessions/:sessionId/shares
 *   GET  /api/sessions/:sessionId/shares
 *   GET  /api/sessions/:sessionId/shares/eligibility   -> { canShare, canManage }
 *   GET  /api/session-shares/mine
 *   POST /api/session-shares/:id/revoke
 * Public (mounted before the global CORS middleware):
 *   GET/OPTIONS /api/session-shares/:id   (X-Share-Token header)
 *
 *   curl -X POST -H "Authorization: Bearer $JWT" -H 'Content-Type: application/json' \
 *     -d '{"expiry":"30d","upToMessageId":"m9","previewSha256":"<hex>","reviewedRedactions":true}' \
 *     https://host/api/sessions/<sessionId>/shares
 */
import { gunzipSync } from 'node:zlib';

import express from 'express';

import {
  SHARE_EXPIRY_MS, SessionShareError, canManageSession, canManageShare, createViewRecorder,
  createWindowLimiter, evaluateLiveness, evaluateShareEligibility, resolveCreateContext, shareSessionTitle,
} from '../services/session-share-policy.js';
import { parsePublicOrigin } from '../services/share-page.js';
import {
  createShareId, createShareToken, hashShareToken, isShareId, isShareToken, verifyShareToken,
} from '../services/share-capability.js';
import { clientIp } from '../utils/client-ip.js';

const SESSION_ID = /^[A-Za-z0-9._:-]{1,200}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const MESSAGE_ID = /^[\x21-\x7e]{1,256}$/;
const DUMMY_HASH = 'f'.repeat(64);
const MAX_JSON_BYTES = 32 * 1024 * 1024;
const MAX_READERS = 8;
const READ_TIMEOUT_MS = 30_000;
const unavailable = () => new SessionShareError('SHARE_UNAVAILABLE', 404);

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
  res.status(status).json({ error: { code, ...(known && error.extra ? error.extra : {}) } });
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

/** Public-safe projection of a row; never the token hash or the blob. */
function publicShare(row, nowMs) {
  let redactionCounts = null;
  try { redactionCounts = JSON.parse(row.redaction_counts); } catch { redactionCounts = null; }
  return {
    id: row.id, sessionId: row.session_id, createdBy: row.created_by, ownerUserId: row.owner_user_id,
    createdAt: row.created_at, expiresAt: row.expires_at, revokedAt: row.revoked_at ?? null,
    revokeReason: row.revoke_reason ?? null, upToMessageId: row.up_to_message_id,
    messageCount: row.message_count, redactionCounts, viewCount: row.view_count ?? 0,
    lastViewedAt: row.last_viewed_at ?? null,
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

/** Per-user snapshot builds per minute; separate buckets so previews never starve creates. */
export const SNAPSHOT_RATE_LIMITS = Object.freeze({ preview: 4, create: 10 });

/**
 * Snapshot build guards: a per-user window per action (preview, create) and
 * one server-wide cap of two concurrent builds shared by both.
 * @returns {{ preview: Function, create: Function }} each `(user, build) => Promise`
 */
function snapshotLimits(now) {
  let building = 0;
  const guard = (limit) => {
    const perUser = createWindowLimiter({ limit, windowMs: 60_000, now });
    return async (user, build) => {
      if (!perUser(String(user.id)) || building >= 2) throw new SessionShareError('RATE_LIMITED', 429);
      building += 1;
      try { return await build(); } finally { building -= 1; }
    };
  };
  return { preview: guard(SNAPSHOT_RATE_LIMITS.preview), create: guard(SNAPSHOT_RATE_LIMITS.create) };
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

function parseCreateBody(body) {
  const input = validBody(body, ['expiry', 'upToMessageId', 'previewSha256', 'reviewedRedactions',
    'confirmPossibleSecrets', 'confirmUnattributed']);
  if (!Object.hasOwn(SHARE_EXPIRY_MS, input.expiry) || typeof input.upToMessageId !== 'string'
      || !MESSAGE_ID.test(input.upToMessageId) || typeof input.previewSha256 !== 'string'
      || !SHA256.test(input.previewSha256)
      || (input.confirmPossibleSecrets !== undefined && input.confirmPossibleSecrets !== true)
      || (input.confirmUnattributed !== undefined && typeof input.confirmUnattributed !== 'boolean')) {
    throw new SessionShareError('INVALID_INPUT', 400);
  }
  if (input.reviewedRedactions !== true) throw new SessionShareError('REVIEW_CONFIRMATION_REQUIRED', 400);
  return input;
}

function assertSnapshotAccepted(result, input) {
  if (result.blockers.length > 0) {
    throw new SessionShareError('SHARE_BLOCKED', 409, { blockers: result.blockers.map((item) => item.code) });
  }
  if (result.sha256 !== input.previewSha256 || result.upToMessageId !== input.upToMessageId) {
    throw new SessionShareError('SNAPSHOT_CHANGED', 409);
  }
  if (result.counts.secret > 0 && input.confirmPossibleSecrets !== true) {
    throw new SessionShareError('SECRET_CONFIRMATION_REQUIRED', 400);
  }
}

function registerPreview(router, ctx) {
  router.post('/sessions/:sessionId/shares/preview', ctx.handle(async (req, res, user) => {
    requireJson(req);
    const input = validBody(req.body, ['confirmUnattributed']);
    if (input.confirmUnattributed !== undefined && typeof input.confirmUnattributed !== 'boolean') {
      throw new SessionShareError('INVALID_INPUT', 400);
    }
    requireOrigin(ctx.publicOrigin);
    const sessionId = sessionParam(req);
    const { session } = resolveCreateContext(user, sessionId, ctx.policy);
    const result = await ctx.limitSnapshot.preview(user, () => ctx.buildSnapshot({ sessionId, readerUserId: user.id,
      confirmUnattributed: input.confirmUnattributed === true, title: session.custom_name ?? undefined }));
    res.json({ snapshot: result.snapshot, upToMessageId: result.upToMessageId, previewSha256: result.sha256,
      counts: result.counts, blockers: result.blockers, possibleSecretsNote: true });
  }));
}

function shareRow({ id, token, sessionId, project, ownerUserId, user, input, result, nowMs }) {
  return {
    id, session_id: sessionId, project_id: project.project_id, owner_user_id: ownerUserId,
    token_hash: hashShareToken(token), created_by: user.id, created_at: new Date(nowMs).toISOString(),
    expires_at: new Date(nowMs + SHARE_EXPIRY_MS[input.expiry]).toISOString(), snapshot: result.blob,
    snapshot_sha256: result.sha256, up_to_message_id: result.upToMessageId,
    message_count: result.snapshot.messages.length, redaction_counts: JSON.stringify(result.counts),
  };
}

function registerCreate(router, ctx) {
  router.post('/sessions/:sessionId/shares', ctx.writer, ctx.handle(async (req, res, user) => {
    requireJson(req);
    const input = parseCreateBody(req.body);
    const origin = requireOrigin(ctx.publicOrigin);
    const sessionId = sessionParam(req);
    const { session } = resolveCreateContext(user, sessionId, ctx.policy);
    const result = await ctx.limitSnapshot.create(user, () => ctx.buildSnapshot({ sessionId, readerUserId: user.id,
      upToMessageId: input.upToMessageId, confirmUnattributed: input.confirmUnattributed === true,
      title: session.custom_name ?? undefined }));
    assertSnapshotAccepted(result, input);
    // Recheck identity and authority after the asynchronous build, before the write.
    const current = ctx.authenticate(req);
    const { ownerUserId, project } = resolveCreateContext(current, sessionId, ctx.policy);
    const id = createShareId();
    const token = createShareToken();
    const nowMs = ctx.now();
    const row = shareRow({ id, token, sessionId, project, ownerUserId, user: current, input, result, nowMs });
    if (!ctx.getStore().insertWithinCaps(row, new Date(nowMs).toISOString())) {
      throw new SessionShareError('SHARE_LIMIT_REACHED', 429);
    }
    ctx.audit('session_share_created', current.id, { shareId: id, sessionId, expiry: input.expiry });
    if (ownerUserId !== current.id) {
      ctx.notify({ ownerUserId, creator: current, sessionId, title: result.snapshot.title, shareId: id });
    }
    res.status(201).json({ share: publicShare(row, nowMs), shareUrl: `${origin}/s/${id}#token=${token}` });
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

function registerListsAndRevoke(router, ctx) {
  router.get('/sessions/:sessionId/shares/eligibility', ctx.handle(async (req, res, user) => {
    const sessionId = SESSION_ID.test(req.params.sessionId) ? req.params.sessionId : null;
    res.json(sessionId ? evaluateShareEligibility(user, sessionId, ctx.policy) : { canShare: false, canManage: false });
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
  router.post('/session-shares/:id/revoke', ctx.writer, ctx.handle(async (req, res, user) => {
    requireJson(req);
    validBody(req.body, []);
    if (!isShareId(req.params.id)) throw unavailable();
    const store = ctx.getStore();
    const row = store.get(req.params.id);
    if (!row || !canManageShare(user, row, ctx.policy)) throw unavailable();
    store.revoke(row.id, 'manual', new Date(ctx.now()).toISOString());
    ctx.audit('session_share_revoked', user.id, { shareId: row.id, sessionId: row.session_id });
    res.status(204).end();
  }));
}

/**
 * Management router. Mount under `/api` outside authenticateToken; it
 * authenticates every request itself with the share JWT verifier, or accepts
 * the device session the mount's bridge resolved.
 * @param {object} deps getStore, verifyUser, policy, buildSnapshot, audit, notify,
 *   writer, publicOrigin, now, deviceCookieName, deviceCookiesEnabled
 */
export function createSessionShareManagementRouter(deps) {
  const now = deps.now ?? Date.now;
  const authenticate = createAuthenticator({ verifyUser: deps.verifyUser, deviceCookieName: deps.deviceCookieName,
    deviceCookiesEnabled: deps.deviceCookiesEnabled ?? (() => false) });
  const managementLimit = createWindowLimiter({ limit: 120, windowMs: 60_000, now });
  const ctx = {
    ...deps, now, authenticate, limitSnapshot: snapshotLimits(now),
    writer: deps.writer ?? ((_req, _res, next) => next()),
    audit: deps.audit ?? (() => {}),
    notify: (event) => { Promise.resolve(deps.notify?.(event)).catch(() => {}); },
    handle: (handler) => async (req, res) => {
      securityHeaders(res);
      try {
        if (!managementLimit(clientIp(req) ?? 'unknown')) throw new SessionShareError('RATE_LIMITED', 429);
        await handler(req, res, authenticate(req));
      } catch (error) { respondError(res, error); }
    },
  };
  const router = express.Router();
  router.use(express.json({ limit: '8kb', strict: true }));
  registerPreview(router, ctx);
  registerCreate(router, ctx);
  registerListsAndRevoke(router, ctx);
  return router;
}

const MANAGEMENT_PATH = /^\/(?:sessions\/[^/]+\/shares(?:\/(?:preview|eligibility))?|session-shares\/(?:mine|[^/]+\/revoke))$/;

/**
 * True for every management route path relative to `/api` (preview, create,
 * list, eligibility, mine, revoke). The single source for the app mount.
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

function publicCors(res) {
  res.set({ 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET',
    'Access-Control-Allow-Headers': 'X-Share-Token', 'Access-Control-Max-Age': '600' });
}

function createReadGuards(now) {
  const global = createWindowLimiter({ limit: 600, windowMs: 60_000, now });
  const perIp = createWindowLimiter({ limit: 60, windowMs: 60_000, now });
  const perShare = createWindowLimiter({ limit: 120, windowMs: 60_000, now });
  return (req, id) => global('global') && perIp(clientIp(req) ?? 'unknown')
    && (!isShareId(id) || perShare(id));
}

/** Authorizes one public read; every failure is the same 404. */
function authorizePublicRead(req, id, deps, nowMs) {
  const token = req.get('X-Share-Token');
  if (!parsePublicOrigin(deps.publicOrigin) || !isShareId(id) || !isShareToken(token)) throw unavailable();
  const row = deps.getStore().get(id);
  const tokenOk = verifyShareToken(token, row ? row.token_hash : DUMMY_HASH);
  if (!row || !tokenOk || !row.snapshot) throw unavailable();
  if (evaluateLiveness(row, deps.policy, nowMs) !== null) throw unavailable();
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
 * Keeps one reader slot until the response is flushed, the socket closes or
 * errors, or the absolute deadline passes; a slow reader is then destroyed so
 * it cannot pin a slot. `release` runs exactly once.
 */
function holdReaderSlot(res, timeoutMs, release) {
  let released = false;
  const deadline = setTimeout(() => { done(); res.destroy(); }, timeoutMs);
  deadline.unref?.();
  function done() {
    if (released) return;
    released = true;
    clearTimeout(deadline);
    release();
  }
  res.once('close', done);
  res.once('finish', done);
  res.once('error', done);
}

/**
 * Public read middleware. Mount on the app BEFORE the global cors() so the
 * opaque-origin viewer's preflight gets an explicit wildcard answer.
 * @param {object} deps getStore, policy, publicOrigin, now, recordView, readTimeoutMs
 */
export function createSessionSharePublicHandler(deps) {
  const now = deps.now ?? Date.now;
  const readTimeoutMs = deps.readTimeoutMs ?? READ_TIMEOUT_MS;
  const admit = createReadGuards(now);
  const recordView = deps.recordView ? createViewRecorder({ flush: deps.recordView, now }) : () => {};
  let readers = 0;
  const handler = (req, res, next) => {
    if (!isPublicSessionSharePath(req.path)) return next();
    if (req.method !== 'GET' && req.method !== 'OPTIONS') return next();
    securityHeaders(res);
    publicCors(res);
    if (req.method === 'OPTIONS') return res.status(204).end();
    const id = req.path.slice('/api/session-shares/'.length);
    if (!admit(req, id) || readers >= MAX_READERS) {
      res.set('Retry-After', '60');
      return respondError(res, new SessionShareError('RATE_LIMITED', 429));
    }
    readers += 1;
    holdReaderSlot(res, readTimeoutMs, () => { readers -= 1; });
    try {
      const row = authorizePublicRead(req, id, deps, now());
      sendSnapshot(req, res, row.snapshot);
      recordView(row.id);
    } catch (error) {
      respondError(res, error instanceof SessionShareError ? error : unavailable());
    }
    return undefined;
  };
  /** Open reader slots, for tests and diagnostics. */
  handler.activeReaders = () => readers;
  return handler;
}
