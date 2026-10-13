/**
 * Guest routes of live read-only session links (ADR-205 D1, D2, D4).
 *
 *   GET|OPTIONS /api/share-view/:id/meta
 *   GET|OPTIONS /api/share-view/:id/messages[?before=<cursor> | ?after=<cursor>]
 *   GET|OPTIONS /api/share-view/:id/attachments/:ref
 *
 * Mounted on the app after admission/maintenance and BEFORE cors(), the
 * device-cookie bridge and authenticateToken. The only credential is the
 * `X-Share-Token` header; no cookie, no query token, no req.user. Requests
 * whose path or query does not match the exact shapes below are not claimed
 * and fall through to the normal stack (where a guest has no JWT → 401).
 * Every claimed request finishes within a 10 s deadline and never answers 500.
 *
 *   curl -H "X-Share-Token: $TOKEN" https://host/api/share-view/<id>/messages
 */
import os from 'node:os';

import { SessionShareError, createViewRecorder } from '../services/session-share-policy.js';
import { LiveProjectionError } from '../services/session-share-live-errors.js';
import { providerLabelFor, sanitizeTitle } from '../services/session-share-snapshot.js';
import {
  admittedOrThrow, assertGuestReadable, guestIpKey, releaseWhenDone, setGuestHeaders, shareUnavailable,
  verifyGuestToken,
} from '../services/share-guest-access.js';
import { createGuestGuards } from '../services/share-guest-guards.js';
import { parsePublicOrigin } from '../services/share-page.js';

/** ADR-205 D1 point 6: no guest request holds a slot or writer lease longer than this. */
export const GUEST_DEADLINE_MS = 10_000;
const DEFAULT_RETRY_MS = 3_000;
const ROUTE = /^\/api\/share-view\/([^/]+)\/(meta|messages|attachments\/([^/]+))$/;
const SHARE_ID = /^[a-f0-9]{32}$/;
const REF = /^[A-Za-z0-9_-]{22}\.[0-9]{1,2}\.[A-Za-z0-9_-]{32}$/;
const CURSOR = /^[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{22}$/;
const QUERY_SHAPES = Object.freeze({ before: CURSOR, after: CURSOR });

/** Validated query of a messages request, or null when anything is off-shape. */
function parseMessagesQuery(query) {
  const out = {};
  for (const [key, value] of Object.entries(query ?? {})) {
    if (!Object.hasOwn(QUERY_SHAPES, key) || typeof value !== 'string' || !QUERY_SHAPES[key].test(value)) return null;
    out[key] = value;
  }
  if (out.before && out.after) return null;
  return out;
}

/**
 * The claimed request, or null to fall through: exact path, 128-bit hex id,
 * the opaque ref shape, and only the documented query keys.
 */
export function parseShareViewRequest(path, query) {
  const match = ROUTE.exec(path);
  if (!match || !SHARE_ID.test(match[1])) return null;
  const endpoint = match[2].startsWith('attachments/') ? 'attachments' : match[2];
  if (endpoint === 'attachments' && !REF.test(match[3])) return null;
  if (endpoint !== 'messages') return Object.keys(query ?? {}).length === 0 ? { id: match[1], endpoint, ref: match[3] } : null;
  const parsed = parseMessagesQuery(query);
  return parsed ? { id: match[1], endpoint, query: parsed } : null;
}

/** Structured internal log line; never a token, path or message text. */
function logWarning(code, error) {
  process.stderr.write(`${JSON.stringify({ level: 'warn', scope: 'share-view', code,
    error: error?.code ?? error?.name ?? 'unknown' })}\n`);
}

/** 503 HISTORY_UNAVAILABLE with a retry hint, in body and Retry-After. */
function sendUnavailable(res, retryAfterMs) {
  if (res.headersSent || res.destroyed) return;
  res.set('Retry-After', String(Math.max(1, Math.ceil(retryAfterMs / 1000))));
  res.status(503).json({ error: { code: 'HISTORY_UNAVAILABLE', retryAfterMs } });
}

/** Maps every failure to a guest answer; nothing becomes a 500. */
function respondGuestError(res, error) {
  if (res.headersSent || res.destroyed) return;
  if (error instanceof SessionShareError) {
    const { retryAfterSec, ...extra } = error.extra ?? {};
    if (retryAfterSec) res.set('Retry-After', String(retryAfterSec));
    res.status(error.status).json({ error: { code: error.code, ...extra } });
  } else if (error instanceof LiveProjectionError && error.statusCode === 409) {
    res.status(409).json({ error: { code: error.code } });
  } else if (error instanceof LiveProjectionError) {
    sendUnavailable(res, error.retryAfterMs ?? DEFAULT_RETRY_MS);
  } else if (error?.statusCode === 404) {
    respondGuestError(res, shareUnavailable());
  } else {
    logWarning('unexpected_failure', error);
    sendUnavailable(res, DEFAULT_RETRY_MS);
  }
}

/** D1 steps 1-4: token, failure buckets, liveness (+ owner_unreadable), live mode for data endpoints. */
function authorize(req, parsed, ctx) {
  if (!parsePublicOrigin(ctx.publicOrigin)) throw shareUnavailable();
  const row = verifyGuestToken(req, parsed.id, ctx);
  assertGuestReadable(row, ctx.policy, ctx.now());
  if (parsed.endpoint !== 'meta' && (row.mode !== 'live' || !row.ref_key)) throw shareUnavailable();
  return row;
}

/** meta: the viewer's header; a legacy row only reports its mode so the viewer can fall back (D6). */
function serveMeta(_req, res, row, _parsed, ctx) {
  ctx.recordView(row.id);
  if (row.mode !== 'live') return res.json({ v: 2, mode: 'snapshot' });
  const session = ctx.policy.getSession(row.session_id);
  const title = sanitizeTitle(session?.custom_name ?? undefined, { projectRoot: session?.project_path, home: ctx.home() });
  return res.json({ v: 2, mode: 'live', title, providerLabel: providerLabelFor(session?.provider ?? ''),
    expiresAt: row.expires_at });
}

/** The per-share key context; the ref key never leaves the server. */
const shareKeys = (row) => ({ shareId: row.id, refKey: Buffer.from(row.ref_key) });

async function serveMessages(_req, res, row, parsed, ctx) {
  const response = await ctx.projection.readMessages({ sessionId: row.session_id, ownerUserId: row.owner_user_id,
    share: shareKeys(row), before: parsed.query.before, after: parsed.query.after, signal: ctx.signal });
  if (!res.headersSent && !res.destroyed) res.json(response);
}

/** RFC 5987 value for `filename*`. */
function encodeFilename(name) {
  return encodeURIComponent(name).replace(/['()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}

function sendAttachment(res, payload) {
  if (res.headersSent || res.destroyed) return;
  res.set({ 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; sandbox" });
  if (payload.kind === 'image') res.set('Content-Type', payload.contentType);
  else res.set({ 'Content-Type': 'application/octet-stream',
    'Content-Disposition': `attachment; filename*=UTF-8''${encodeFilename(payload.name)}` });
  res.status(200).end(payload.bytes);
}

async function serveAttachment(_req, res, row, parsed, ctx) {
  const resolved = await ctx.projection.resolveAttachment({ sessionId: row.session_id, ownerUserId: row.owner_user_id,
    share: shareKeys(row), ref: parsed.ref, signal: ctx.signal });
  const payload = resolved ? await ctx.loadAttachment(resolved.locator,
    { sessionId: row.session_id, projectRoot: resolved.projectRoot, home: resolved.home }) : null;
  if (payload?.ok) return sendAttachment(res, payload);
  if (payload?.reason === 'too_large') throw new SessionShareError('ATTACHMENT_TOO_LARGE', 413);
  throw new SessionShareError('ATTACHMENT_GONE', 404);
}

const ENDPOINTS = Object.freeze({ meta: serveMeta, messages: serveMessages, attachments: serveAttachment });

/** Admission after liveness: attachments use their own pool (D7). */
function admit(req, row, parsed, guards) {
  return admittedOrThrow(parsed.endpoint === 'attachments'
    ? guards.admitAttachment(row.id) : guards.admitReader(row.id, guestIpKey(req)));
}

/** One claimed GET under the hard deadline; a closed request aborts the read. */
async function serve(req, res, parsed, ctx) {
  const controller = new AbortController();
  const timer = setTimeout(() => { controller.abort(); sendUnavailable(res, DEFAULT_RETRY_MS); }, ctx.deadlineMs);
  timer.unref?.();
  res.once('close', () => controller.abort());
  try {
    const row = authorize(req, parsed, ctx);
    releaseWhenDone(res, admit(req, row, parsed, ctx.guards), ctx.deadlineMs + 1_000);
    await ENDPOINTS[parsed.endpoint](req, res, row, parsed, { ...ctx, signal: controller.signal });
  } catch (error) {
    if (!controller.signal.aborted) respondGuestError(res, error);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * App-level middleware for the guest routes.
 * @param {object} deps getStore, policy, publicOrigin, projection ({ readMessages, resolveAttachment }),
 *   loadAttachment(locator, ctx), recordView(id, count, at), now, home, guards, deadlineMs
 */
export function createShareViewHandler(deps) {
  const now = deps.now ?? Date.now;
  const ctx = {
    ...deps, now, home: deps.home ?? (() => os.homedir()),
    guards: deps.guards ?? createGuestGuards({ now }),
    deadlineMs: deps.deadlineMs ?? GUEST_DEADLINE_MS,
    recordView: deps.recordView ? createViewRecorder({ flush: deps.recordView, now }) : () => {},
  };
  return (req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'OPTIONS') return next();
    const parsed = parseShareViewRequest(req.path, req.query);
    if (!parsed) return next();
    setGuestHeaders(res);
    if (req.method === 'OPTIONS') return res.status(204).end();
    void serve(req, res, parsed, ctx);
    return undefined;
  };
}
