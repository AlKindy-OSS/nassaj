/**
 * B-1689 — which directory a project file request reads from or writes to.
 *
 * A chat session that runs in a session overlay writes its files into the
 * overlay working tree, not the project root. The editor pane opened from that
 * chat must read and save the same copy, or a freshly written file 404s.
 *
 * The overlay is never named by the client. The request carries only an opaque
 * `sessionId`; the root is derived here from server state:
 *   1. the session row must exist and belong to THIS project (same root);
 *   2. the requester must be allowed to read (or, for saves, write) the
 *      session — the shared ADR-089 predicate;
 *   3. the overlay comes from the session's strict overlay manifest.
 * No sessionId, or a session without an overlay, falls back to the project root.
 * An overlay is a full copy of the project, so when the session has one it wins
 * for every path, including files that also exist in the root.
 */

import path from 'node:path';

const MAX_SESSION_ID_LENGTH = 200;
const SESSION_ID_PATTERN = /^[A-Za-z0-9._:-]+$/;

/**
 * Normalize the optional `sessionId` request field.
 * @param {unknown} raw
 * @returns {{ ok: true, sessionId: string|null } | { ok: false }}
 */
export function parseSessionIdParam(raw) {
  if (raw === undefined || raw === null || raw === '') return { ok: true, sessionId: null };
  if (typeof raw !== 'string' || raw.length > MAX_SESSION_ID_LENGTH || !SESSION_ID_PATTERN.test(raw)) {
    return { ok: false };
  }
  return { ok: true, sessionId: raw };
}

/**
 * Resolve the file root for one project file request.
 *
 * @param {{
 *   projectRoot: string,
 *   sessionId: unknown,
 *   userId: number|null,
 *   mode: 'read'|'write',
 *   getSessionById: (id: string) => ({ session_id: string, project_path?: string|null }|null|undefined),
 *   isSessionAccessible: (id: string, projectPath: string, userId: number|null, mode: 'read'|'write') => boolean,
 *   findOverlay: (input: { projectPath: string, sessionId: string }) => ({ cwd: string }|null),
 * }} input
 * @returns {{ ok: true, root: string, overlay: boolean, sessionId: string|null, overlayId: string|null }
 *   | { ok: false, status: 400|404 }}
 *   404 for any session the requester may not use, so a session's existence is
 *   never disclosed (B-PRIV).
 */
export function resolveSessionFileRoot({
  projectRoot, sessionId, userId, mode, getSessionById, isSessionAccessible, findOverlay,
}) {
  const parsed = parseSessionIdParam(sessionId);
  if (!parsed.ok) return { ok: false, status: 400 };
  const rootScope = { ok: true, root: projectRoot, overlay: false, sessionId: parsed.sessionId, overlayId: null };
  if (!parsed.sessionId) return rootScope;

  const session = getSessionById(parsed.sessionId);
  if (!session || session.session_id !== parsed.sessionId || typeof session.project_path !== 'string'
      || path.resolve(session.project_path) !== path.resolve(projectRoot)) {
    return { ok: false, status: 404 };
  }
  if (!isSessionAccessible(parsed.sessionId, session.project_path, userId, mode)) {
    return { ok: false, status: 404 };
  }
  let overlay;
  try {
    overlay = findOverlay({ projectPath: projectRoot, sessionId: parsed.sessionId });
  } catch {
    // Malformed or dangling overlay state: fail closed, never read the root
    // instead (the user would see or overwrite a different copy).
    return { ok: false, status: 404 };
  }
  if (!overlay) return rootScope;
  return {
    ok: true, root: overlay.cwd, overlay: true, sessionId: parsed.sessionId, overlayId: overlay.overlayId ?? null,
  };
}

/** Audit action for a save that landed in a session overlay rather than the project root. */
export const OVERLAY_FILE_WRITE_AUDIT_ACTION = 'session_overlay_file_saved';

/**
 * Audit options for one overlay save (qa M-1): who, which project, which session
 * and overlay, and the overlay-relative path. Never the content.
 * @param {{ ip?: string, get?: (name: string) => string | undefined }} req
 * @param {{ userId: number|null, projectId: string,
 *   scope: { root: string, sessionId: string|null, overlayId: string|null }, absolutePath: string }} details
 */
export function buildOverlayFileWriteAuditEntry(req, { userId, projectId, scope, absolutePath }) {
  return {
    userId,
    ipAddress: req.ip ?? null,
    userAgent: req.get?.('user-agent') ?? null,
    metadata: {
      projectId: String(projectId),
      sessionId: scope.sessionId,
      overlayId: scope.overlayId,
      path: path.relative(scope.root, absolutePath),
    },
  };
}

/**
 * Map a client path onto the resolved file root. Relative paths and paths
 * already inside `root` are returned unchanged. An absolute path into the
 * project root is moved onto the same relative path inside the overlay, so a
 * chat link that quotes the project-root location still opens the session's
 * copy. Purely lexical: the caller's path guard still canonicalizes and refuses
 * anything (symlinks, `..`) that escapes `root`.
 * @param {string} requestedPath
 * @param {string} projectRoot
 * @param {string} root
 * @returns {string}
 */
export function rebaseRequestedPath(requestedPath, projectRoot, root) {
  if (typeof requestedPath !== 'string' || !path.isAbsolute(requestedPath) || root === projectRoot) {
    return requestedPath;
  }
  const resolved = path.resolve(requestedPath);
  const inside = (base) => resolved === base || resolved.startsWith(base + path.sep);
  if (inside(path.resolve(root)) || !inside(path.resolve(projectRoot))) return requestedPath;
  return path.join(root, path.relative(path.resolve(projectRoot), resolved));
}
