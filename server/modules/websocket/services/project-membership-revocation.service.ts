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
 *  - the user's own in-flight turn writers (websocket-writer.service): the
 *    project's sessions stop streaming and the provider abort bridge is called.
 *  - /shell PTYs (shell-websocket.service) inside the project: socket closed,
 *    PTY killed, lease released.
 *  - standalone terminals: an owner/admin-only surface (ADR-063 amend), and those
 *    roles keep access under canSeeAllProjects — nothing can be revoked there.
 *
 * The removed user always receives a `project_membership_revoked` event (the
 * member-removal notice; there is no generic in-app notification store).
 */

import { sessionsDb } from '@/modules/database/index.js';
import { listRunningSessionIdsForUser, presenceRefresh } from '@/modules/websocket/services/presence.service.js';
import { connectedClients, WS_OPEN_STATE } from '@/modules/websocket/services/websocket-state.service.js';
import { terminateShellSessionsForUserInProject } from '@/modules/websocket/services/shell-websocket.service.js';
import {
  detachWritersForUser,
  removeSessionMirrorsForUser,
} from '@/modules/websocket/services/websocket-writer.service.js';
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
};

type ProjectRevocableClient = RealtimeClientConnection & {
  abortProjectMembershipRuns?: (sessionIds: Iterable<string>) => number;
};

function defaultListSessionIds(projectPath: string): string[] {
  return sessionsDb.getSessionsByProjectPathIncludingArchived(projectPath).map((row) => row.session_id);
}

/**
 * Tears down the removed user's live subscriptions on the project (unless they
 * still have access, e.g. admin or enforcement off) and notifies their sockets.
 * Returns counts of mirrors removed, writers detached, shells ended and sockets notified.
 */
export function revokeProjectLiveAccess(
  revocation: ProjectMembershipRevocation,
  dependencies: RevocationDependencies = {},
): {
  mirrorsRemoved: number;
  writersDetached: number;
  shellsEnded: number;
  turnsStopped: number;
  socketsNotified: number;
  socketsClosed: number;
} {
  const listSessionIds = dependencies.listSessionIds ?? defaultListSessionIds;
  const clients = [...(dependencies.clients ?? connectedClients)] as ProjectRevocableClient[];
  const refreshPresence = dependencies.refreshPresence ?? presenceRefresh;
  const terminateShells = dependencies.terminateShells ?? terminateShellSessionsForUserInProject;

  let mirrorsRemoved = 0;
  let writersDetached = 0;
  let shellsEnded = 0;
  let turnsStopped = 0;
  let projectSessionIds: string[] = [];
  const writerSockets = new Set<ProjectRevocableClient>();
  if (!revocation.stillHasAccess) {
    projectSessionIds = listSessionIds(revocation.projectPath);
    // Fence and abort the actual writer before detaching mirrors or beginning
    // any close handshake. A peer that never acknowledges close (then reports
    // 1006) therefore cannot publish or persist one more provider payload.
    for (const client of clients) {
      if (String(client.userId ?? '') !== String(revocation.userId)) continue;
      try {
        if ((client.abortProjectMembershipRuns?.(projectSessionIds) ?? 0) > 0) {
          writerSockets.add(client);
        }
      } catch {
        // detachWritersForUser below is the synchronous content fence fallback;
        // close this writer transport after that fence even if its abort bridge failed.
        writerSockets.add(client);
      }
    }
    mirrorsRemoved = removeSessionMirrorsForUser(revocation.userId, projectSessionIds);
    writersDetached = detachWritersForUser(revocation.userId, projectSessionIds);
    shellsEnded = terminateShells(revocation.userId, revocation.projectPath, revocation.projectId);
    turnsStopped = stopLaunchedTurns(revocation.userId, projectSessionIds, dependencies);
    refreshPresence();
  }

  const payload = JSON.stringify({
    type: PROJECT_MEMBERSHIP_REVOKED_MESSAGE_TYPE,
    projectId: revocation.projectId,
    accessRevoked: !revocation.stillHasAccess,
  });
  let socketsNotified = 0;
  let socketsClosed = 0;
  for (const client of clients) {
    if (client.readyState !== WS_OPEN_STATE || String(client.userId ?? '') !== String(revocation.userId)) {
      continue;
    }
    try {
      client.send(payload);
      socketsNotified += 1;
      if (!revocation.stillHasAccess && writerSockets.has(client)
          && typeof client.close === 'function') {
        client.close(4404, 'project_access_revoked');
        socketsClosed += 1;
      }
    } catch {
      /* a dead socket is cleaned up by its own close handler */
    }
  }
  return { mirrorsRemoved, writersDetached, shellsEnded, turnsStopped, socketsNotified, socketsClosed };
}

/**
 * Owner decision 2026-09-23 (م1): stop the in-flight turns the removed user
 * LAUNCHED in this project's sessions. Other members' turns are untouched —
 * presence records each run under its launcher. Abort failures are logged and
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
