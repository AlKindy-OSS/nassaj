/**
 * Business rules for read-only session share links (ADR-196, T-1970 stage 4):
 * who may create, list and revoke, when a share is still alive, expiry keys,
 * bounded rate limiting and the session-owner notification. Pure functions over
 * injected dependencies so the router, the public reader and the sweeper share
 * one definition of every rule.
 */

/** Allowed expiry keys; the server computes the date, clients never send one. */
export const SHARE_EXPIRY_MS = Object.freeze({
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000,
  '90d': 90 * 24 * 60 * 60 * 1000,
});

/** Liveness failures that are only definitive after two consecutive sweeps (reviewer S3). */
export const TWO_STRIKE_REASONS = Object.freeze(new Set(['session_missing', 'owner_unresolved']));

/** Error carrying an HTTP status and a stable public code; never a detail. */
export class SessionShareError extends Error {
  /**
   * @param {string} code stable machine code
   * @param {number} status HTTP status
   * @param {object} [extra] additional safe response fields
   */
  constructor(code, status, extra = undefined) {
    super(code);
    this.code = code;
    this.status = status;
    this.extra = extra;
  }
}

/**
 * Platform owner or admin.
 * @param {{ role?: string } | null | undefined} user
 */
export function isPrivileged(user) {
  return Boolean(user) && (user.role === 'owner' || user.role === 'admin');
}

/** Project for a session path, or null when unregistered/ambiguous. */
function lookupProject(deps, projectPath) {
  try {
    return deps.findProject(projectPath ?? '');
  } catch {
    return null;
  }
}

/**
 * Resolves and authorizes a share creation. Creator must be the strict session
 * owner, the platform owner, or an admin (owner decision 2026-10-04). The read
 * gate is deliberately NOT the authority here.
 * @returns {{ session: object, ownerUserId: number, project: { project_id: string } }}
 * @throws SessionShareError 404 / 403 / 409 / 422
 */
export function resolveCreateContext(user, sessionId, deps) {
  const session = deps.getSession(sessionId);
  if (!session) throw new SessionShareError('SESSION_NOT_FOUND', 404);
  const ownerUserId = deps.resolveOwner(sessionId);
  if (ownerUserId !== user.id && !isPrivileged(user)) throw new SessionShareError('ACCESS_DENIED', 403);
  if (ownerUserId === null) throw new SessionShareError('OWNER_UNRESOLVED', 409);
  const project = lookupProject(deps, session.project_path);
  if (!project) throw new SessionShareError('SESSION_PROJECT_UNREGISTERED', 422);
  if (project.isArchived) throw new SessionShareError('SESSION_PROJECT_ARCHIVED', 422);
  return { session, ownerUserId, project };
}

/**
 * Whether the user may see every share of a session and revoke any of them:
 * the strict session owner, the platform owner or an admin (owner decision
 * 2026-10-04). Session write access does NOT grant this.
 */
export function canManageSession(user, sessionId, deps) {
  return isPrivileged(user) || deps.resolveOwner(sessionId) === user.id;
}

/** Creator of the share, or anyone who manages its session. */
export function canManageShare(user, row, deps) {
  return row.created_by === user.id || row.owner_user_id === user.id || canManageSession(user, row.session_id, deps);
}

/**
 * What the Share UI may offer for a session, using the exact create and manage
 * rules. Unknown or inaccessible sessions answer false/false, so the endpoint is
 * no existence oracle. Never builds a snapshot.
 * @returns {{ canShare: boolean, canManage: boolean }}
 */
export function evaluateShareEligibility(user, sessionId, deps) {
  if (!deps.getSession(sessionId)) return { canShare: false, canManage: false };
  let canShare = true;
  try {
    resolveCreateContext(user, sessionId, deps);
  } catch (error) {
    if (!(error instanceof SessionShareError)) throw error;
    canShare = false;
  }
  return { canShare, canManage: canManageSession(user, sessionId, deps) };
}

/**
 * Session display title for a share list item: only for a viewer entitled to
 * manage the share who can still see the session in the app; otherwise null.
 * Never part of the public snapshot.
 */
export function shareSessionTitle(user, row, deps) {
  const session = deps.getSession(row.session_id);
  if (!session || !canManageShare(user, row, deps)) return null;
  const visible = canManageSession(user, row.session_id, deps)
    || deps.isSessionReadable(row.session_id, session.project_path, user.id);
  const title = typeof session.custom_name === 'string' ? session.custom_name.trim() : '';
  return visible && title ? title : null;
}

function expiredOrRevoked(row, nowMs) {
  if (row.revoked_at) return 'revoked';
  const expiresAt = Date.parse(row.expires_at);
  return !Number.isFinite(expiresAt) || expiresAt <= nowMs ? 'expired' : null;
}

function creatorEntitlement(creator, row, ownerUserId, session, deps) {
  if (isPrivileged(creator)) return null;
  if (creator.id !== ownerUserId) return 'creator_unentitled';
  return deps.isSessionReadable(row.session_id, session.project_path, creator.id) ? null : 'creator_unentitled';
}

/**
 * Evaluates a share's liveness in the ADR order. Null means alive; otherwise a
 * reason. `session_missing` and `owner_unresolved` are two-strike reasons for the
 * sweeper; every other reason is definitive. Readers treat all reasons alike.
 * @param {object} row session_shares row
 * @param {object} deps lookups
 * @param {number} nowMs
 * @returns {string | null}
 */
export function evaluateLiveness(row, deps, nowMs) {
  const lifecycle = expiredOrRevoked(row, nowMs);
  if (lifecycle) return lifecycle;
  const session = deps.getSession(row.session_id);
  if (!session) return 'session_missing';
  if (session.isArchived) return 'session_archived';
  const creator = deps.getActiveUser(row.created_by);
  if (!creator) return 'creator_inactive';
  const ownerUserId = deps.resolveOwner(row.session_id);
  if (ownerUserId === null) return 'owner_unresolved';
  if (ownerUserId !== row.owner_user_id) return 'owner_changed';
  const entitlement = creatorEntitlement(creator, row, ownerUserId, session, deps);
  if (entitlement) return entitlement;
  const project = lookupProject(deps, session.project_path);
  if (!project || project.project_id !== row.project_id) return 'project_gone';
  return project.isArchived ? 'project_archived' : null;
}

/**
 * Fixed-window counter keyed by string with a bounded key map. When the map is
 * full, new keys share one overflow bucket instead of growing memory.
 * @param {{ limit: number, windowMs: number, maxKeys?: number, now?: () => number }} options
 * @returns {(key: string) => boolean} true when the call is admitted
 */
export function createWindowLimiter({ limit, windowMs, maxKeys = 4096, now = Date.now }) {
  const buckets = new Map();
  return (key) => {
    const at = now();
    let bucketKey = key;
    if (!buckets.has(bucketKey) && buckets.size >= maxKeys) {
      for (const [candidate, bucket] of buckets) if (bucket.until <= at) buckets.delete(candidate);
      if (buckets.size >= maxKeys) bucketKey = '\u0000overflow';
    }
    let bucket = buckets.get(bucketKey);
    if (!bucket || bucket.until <= at) {
      bucket = { until: at + windowMs, count: 0 };
      buckets.set(bucketKey, bucket);
    }
    bucket.count += 1;
    return bucket.count <= limit;
  };
}

/**
 * Batches view counting so each share is written at most once a minute and a
 * failed write never affects the read.
 * @param {{ flush: (id: string, count: number, at: string) => unknown, now?: () => number, maxKeys?: number }} options
 * @returns {(id: string) => void}
 */
export function createViewRecorder({ flush, now = Date.now, maxKeys = 4096 }) {
  const pending = new Map();
  return (id) => {
    const at = now();
    let entry = pending.get(id);
    if (!entry) {
      if (pending.size >= maxKeys) {
        for (const [key, value] of pending) if (value.count === 0 && at - value.flushedAt >= 60_000) pending.delete(key);
        if (pending.size >= maxKeys) return;
      }
      entry = { count: 0, flushedAt: 0 };
      pending.set(id, entry);
    }
    entry.count += 1;
    if (at - entry.flushedAt < 60_000) return;
    const count = entry.count;
    entry.count = 0;
    entry.flushedAt = at;
    try {
      Promise.resolve(flush(id, count, new Date(at).toISOString())).catch(() => {});
    } catch {
      // Counting is best effort by contract.
    }
  };
}

const MAX_TITLE = 80;

/** Bilingual owner alert text; the push channel carries plain strings, not i18n keys. */
export function shareOwnerNotice(creatorName, title) {
  const name = String(creatorName || 'Nassaj').replace(/\s+/g, ' ').trim().slice(0, 64);
  const raw = String(title || '').replace(/\s+/g, ' ').trim();
  const safeTitle = raw.length > MAX_TITLE ? `${raw.slice(0, MAX_TITLE - 1)}…` : raw;
  return `${name} أنشأ رابطًا عامًا للقراءة فقط لجلستك «${safeTitle}»؛ يمكنك إلغاؤه. / `
    + `${name} created a public read-only link to your session '${safeTitle}'; you can revoke it.`;
}

/**
 * Notifies a session owner that someone else shared their session, through the
 * existing web-push orchestrator, and always leaves an audit row. Never throws.
 * @param {{ loadOrchestrator: () => Promise<object>, audit: Function }} deps
 */
export function createShareOwnerNotifier({ loadOrchestrator, audit }) {
  return async ({ ownerUserId, creator, sessionId, title, shareId }) => {
    try {
      audit('session_share_owner_notified', creator.id, { shareId, sessionId, ownerUserId });
    } catch {
      // Audit failure must not undo a committed share.
    }
    try {
      const { createNotificationEvent, notifyUserIfEnabled } = await loadOrchestrator();
      notifyUserIfEnabled({
        userId: ownerUserId,
        event: createNotificationEvent({
          provider: 'system',
          sessionId,
          code: 'agent.notification',
          severity: 'warning',
          meta: { message: shareOwnerNotice(creator.username, title), sessionName: title || null },
          dedupeKey: `session-share:${shareId}`,
        }),
      });
    } catch {
      process.stderr.write(`${JSON.stringify({ level: 'warn', scope: 'session-share', code: 'owner_notify_failed' })}\n`);
    }
  };
}
