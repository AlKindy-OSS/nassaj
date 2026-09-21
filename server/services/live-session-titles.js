/**
 * Live-session title enrichment for the deferred-restart panel (B-270).
 *
 * `scripts/safe-restart.sh` refuses a restart while provider child processes are
 * alive, and reports each blocker from /proc alone: pid, provider, age, and the
 * session id it parses out of the child's argv. It deliberately holds no
 * database handle — the gate must run standalone and least-privileged.
 *
 * That left the panel listing five identical `claude · 14m` rows: enough to know
 * the restart was refused, not enough to know WHICH conversation to close. This
 * module closes that gap on the server side, resolving each session id to the
 * same `custom_name` the sidebar shows (written by the session synchronizer).
 *
 * B-PRIV: the endpoint already requires admin/owner, but an admin is not
 * automatically a member of every private project. A title is attached only when
 * the session's project is visible to the requester; otherwise the row keeps its
 * provider/age/pid — the owner still sees THAT something is blocking and can act
 * on it — and `titleRedacted` tells the client to say so rather than silently
 * render nothing.
 */

import { projectsDb as defaultProjectsDb, sessionsDb as defaultSessionsDb } from '../modules/database/index.js';

/**
 * Attaches a human title to each blocking live session.
 *
 * Never throws: this runs on the path of a SAFE deferral, so a database hiccup
 * must degrade to the previous title-less rows rather than turn a refused
 * restart into a 500.
 *
 * @param {Array<object>} liveSessions - Rows from the gate's --json output.
 * @param {number|null} requesterId - Authenticated user id, for visibility.
 * @param {{projectsDb?: object, sessionsDb?: object}} [deps] - Repository
 *   overrides; the defaults are the real repositories.
 * @returns {Array<object>} The same rows, each possibly carrying `title` or
 *   `titleRedacted`. Non-array input is returned unchanged.
 */
export function attachSessionTitles(liveSessions, requesterId, deps = {}) {
    if (!Array.isArray(liveSessions) || liveSessions.length === 0) return liveSessions;

    const projects = deps.projectsDb ?? defaultProjectsDb;
    const sessions = deps.sessionsDb ?? defaultSessionsDb;

    let visiblePaths;
    try {
        visiblePaths = new Set(projects.getVisibleProjectPaths(requesterId));
    } catch {
        return liveSessions;
    }

    return liveSessions.map((entry) => {
        const sessionId = entry && typeof entry.sessionId === 'string' ? entry.sessionId : '';
        if (!sessionId) return entry;

        let row = null;
        try {
            row = sessions.getSessionById(sessionId);
        } catch {
            return entry;
        }
        if (!row) return entry;

        const projectPath = row.project_path;
        if (projectPath && !visiblePaths.has(projectPath)) {
            return { ...entry, titleRedacted: true };
        }
        const title = typeof row.custom_name === 'string' ? row.custom_name.trim() : '';
        return title ? { ...entry, title } : entry;
    });
}
