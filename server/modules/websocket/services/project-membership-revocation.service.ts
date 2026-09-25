/**
 * ADR-172 (P1-2): live-subscription teardown when a member is removed.
 *
 * Registries touched and why:
 *  - chat session mirrors (websocket-writer.service): long-lived per-socket
 *    subscriptions — removed here for every session of the project.
 *  - presence (presence.service): filtered per recipient at broadcast time via
 *    getVisibleProjectPaths — a refresh is scheduled so the filter re-runs now.
 *  - live session titles (services/live-session-titles.js): computed per request
 *    from getVisibleProjectPaths — nothing persistent to close.
 *  - in-flight chat runs: NOT here (T-1854). Each run carries its own fence
 *    (fenced-run registry in project-access), revoked and aborted by the
 *    post-commit sweep inside retireProjectSubjectAccess BEFORE this listener
 *    runs. The socket is no longer closed (no 4404): it carries other projects.
 *  - runs launched outside a chat socket (POST /api/agent SSE, qa H2): still
 *    stopped by stopLaunchedTurns below, as secondary coverage.
 *  - /shell PTYs (shell-websocket.service) inside the project: socket closed,
 *    PTY killed, lease released.
 *  - internal team-chat rooms (ADR-187): their own registry — the user's room
 *    subscriptions in the project's sessions are dropped with a personal
 *    `internal-chat.membership_revoked` frame; delivery also re-checks access.
 *  - standalone terminals: an owner/admin-only surface (ADR-063 amend), and those
 *    roles keep access under canSeeAllProjects — nothing can be revoked there.
 *
 * The removed user always receives a `project_membership_revoked` event (the
 * member-removal notice; there is no generic in-app notification store).
 */

import { sessionsDb } from '@/modules/database/index.js';
import { internalChatRealtime } from '@/modules/internal-session-chat/index.js';
import { listRunningSessionIdsForUser, presenceRefresh } from '@/modules/websocket/services/presence.service.js';
import { connectedClients, WS_OPEN_STATE } from '@/modules/websocket/services/websocket-state.service.js';
import { terminateShellSessionsForUserInProject } from '@/modules/websocket/services/shell-websocket.service.js';
import { removeSessionMirrorsForUser } from '@/modules/websocket/services/websocket-writer.service.js';
import type { RealtimeClientConnection } from '@/shared/types.js';

export const PROJECT_MEMBERSHIP_REVOKED_MESSAGE_TYPE = 'project_membership_revoked';

export type ProjectMembershipRevocation = {
  projectId: string;
  projectPath: string;
  userId: number;
  stillHasAccess: boolean;
};

type RevocationDependencies = {
  listSessionIds?: (projectPath: string) => string[];
  clients?: Iterable<RealtimeClientConnection>;
  refreshPresence?: () => void;
  terminateShells?: (userId: number, projectPath: string, projectId: string) => number;
  /** Sessions with an in-flight turn launched by the user (default: presence). */
  listRunningSessionIds?: (userId: number) => string[];
  /** Stops one in-flight turn; wired in server/index.js to abortSessionTurn. */
  abortTurn?: (sessionId: string, userId: number) => Promise<unknown> | unknown;
  /** Drops the user's internal team-chat subscriptions (default: ADR-187 registry). */
  revokeInternalChat?: (userId: number, sessionIds: string[]) => number;
};

function defaultListSessionIds(projectPath: string): string[] {
  return sessionsDb.getSessionsByProjectPathIncludingArchived(projectPath).map((row) => row.session_id);
}

/**
 * Tears down the removed user's live subscriptions on the project (unless they
 * still have access, e.g. admin or enforcement off) and notifies their sockets.
 * Returns counts of mirrors removed, shells ended, turns stopped and sockets notified.
 */
export function revokeProjectLiveAccess(
  revocation: ProjectMembershipRevocation,
  dependencies: RevocationDependencies = {},
): {
  mirrorsRemoved: number;
  shellsEnded: number;
  turnsStopped: number;
  socketsNotified: number;
} {
  const listSessionIds = dependencies.listSessionIds ?? defaultListSessionIds;
  const clients = [...(dependencies.clients ?? connectedClients)];
  const refreshPresence = dependencies.refreshPresence ?? presenceRefresh;
  const terminateShells = dependencies.terminateShells ?? terminateShellSessionsForUserInProject;

  let mirrorsRemoved = 0;
  let shellsEnded = 0;
  let turnsStopped = 0;
  if (!revocation.stillHasAccess) {
    const projectSessionIds = listSessionIds(revocation.projectPath);
    mirrorsRemoved = removeSessionMirrorsForUser(revocation.userId, projectSessionIds);
    shellsEnded = terminateShells(revocation.userId, revocation.projectPath, revocation.projectId);
    turnsStopped = stopLaunchedTurns(revocation.userId, projectSessionIds, dependencies);
    (dependencies.revokeInternalChat ?? internalChatRealtime.revokeUserSessions)(revocation.userId, projectSessionIds);
    refreshPresence();
  }

  const payload = JSON.stringify({
    type: PROJECT_MEMBERSHIP_REVOKED_MESSAGE_TYPE,
    projectId: revocation.projectId,
    accessRevoked: !revocation.stillHasAccess,
  });
  let socketsNotified = 0;
  for (const client of clients) {
    if (client.readyState !== WS_OPEN_STATE || String(client.userId ?? '') !== String(revocation.userId)) {
      continue;
    }
    try {
      client.send(payload);
      socketsNotified += 1;
    } catch {
      /* a dead socket is cleaned up by its own close handler */
    }
  }
  return { mirrorsRemoved, shellsEnded, turnsStopped, socketsNotified };
}

/**
 * Owner decision 2026-09-23 (م1): stop the in-flight turns the removed user
 * LAUNCHED in this project's sessions. Kept after T-1854 (qa H2) as secondary
 * coverage for runs that never crossed a chat socket's run fence (POST
 * /api/agent SSE); for chat runs the fence has already aborted them. Other
 * members' turns are untouched — presence records each run under its launcher. Abort failures are logged and
 * never undo the removal. Returns the number of abort requests issued.
 */
function stopLaunchedTurns(userId: number, projectSessionIds: string[], dependencies: RevocationDependencies): number {
  if (!dependencies.abortTurn) {
    return 0;
  }
  const inProject = new Set(projectSessionIds);
  const running = (dependencies.listRunningSessionIds ?? listRunningSessionIdsForUser)(userId)
    .filter((sessionId) => inProject.has(sessionId));
  for (const sessionId of running) {
    Promise.resolve()
      .then(() => dependencies.abortTurn?.(sessionId, userId))
      .catch((error: unknown) => console.error('[ADR-172] stopping removed member turn failed', {
        sessionId, error: error instanceof Error ? error.message : String(error),
      }));
  }
  return running.length;
}
