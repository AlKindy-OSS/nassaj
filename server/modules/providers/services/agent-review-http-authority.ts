import type { Database } from 'better-sqlite3';
import type { Request } from 'express';

import { AgentReviewError, captureWorkspaceTopologyFence, getConnection, isProjectMembershipEnforced,
  isWorkspaceTopologyFenceCurrent, type WorkspaceTopologyFence } from '../../database/index.js';
import { createAuthenticatedLaunchActor, isAuthenticatedLaunchActorCurrent, type AuthenticatedLaunchActor } from '../../execution-permissions/index.js';

import { assertSessionAccessible } from './sessions.service.js';

type Mode = 'read' | 'write';
type FencedRequest = Request & { user?: Parameters<typeof createAuthenticatedLaunchActor>[0]; authenticatedPrincipal?: Record<string, unknown>;
  assertCurrentIdentity?: () => boolean };
export type ReviewAccessSeams = {
  connection: () => Database;
  actorCurrent: (actor: AuthenticatedLaunchActor) => boolean;
  session: (sessionId: string, actor: number, mode: Mode) => { provider: string; project_path: string | null };
  capture: (sessionId: string, projectPath: string, actor: number, mode: Mode) => WorkspaceTopologyFence | null;
  current: (fence: WorkspaceTopologyFence) => boolean;
};
const production: ReviewAccessSeams = {
  connection: getConnection, actorCurrent: isAuthenticatedLaunchActorCurrent, session: assertSessionAccessible,
  capture: (sessionId, projectPath, actor, mode) => {
    if (!isProjectMembershipEnforced()) return null;
    const fence = captureWorkspaceTopologyFence(projectPath, actor, { sessionId, consent: mode === 'read' ? 'read' : 'control' });
    if (!fence) throw new AgentReviewError('session_not_found');
    return fence;
  },
  current: isWorkspaceTopologyFenceCurrent,
};

function matchesPrincipal(principal: Record<string, unknown> | undefined, actor: AuthenticatedLaunchActor): boolean {
  if (!principal || principal.userId !== actor.userId || principal.authorizationGeneration !== actor.authorizationGeneration) return false;
  if (actor.authenticationKind === 'ck') return principal.authenticationKind === 'ck'
    && principal.authenticationCredentialId === actor.authenticationCredentialId && principal.principalId === actor.principalId;
  if (actor.authenticationKind !== 'session') return false;
  if (actor.deviceSessionId) return principal.kind === 'device_session' && principal.deviceSessionId === actor.deviceSessionId
    && principal.slotId === actor.slotId && principal.deviceGeneration === actor.deviceGeneration;
  return principal.kind === 'jwt';
}

/** Current C3 identity plus exact session/project authority, backed by the repository's same connection. */
export class AgentReviewHttpAuthority {
  constructor(private readonly db: Database, private readonly seams: ReviewAccessSeams = production) {}

  /** Capture server-installed JWT/device/CK identity; no body/header identity or role bypass is accepted. */
  capture(request: Request, sessionId: string, mode: Mode): { actorUserId: number; assertCurrent: (access?: Mode) => true } {
    const req = request as FencedRequest;
    let actor: AuthenticatedLaunchActor;
    try { actor = createAuthenticatedLaunchActor(req.user); }
    catch { throw new AgentReviewError('identity_changed'); }
    const principal = req.authenticatedPrincipal;
    const current = (): void => {
      if (this.seams.connection() !== this.db || req.authenticatedPrincipal !== principal
        || !matchesPrincipal(principal, actor) || req.assertCurrentIdentity?.() !== true || !this.seams.actorCurrent(actor)) {
        throw new AgentReviewError('identity_changed');
      }
    };
    current();
    const session = this.seams.session(sessionId, actor.userId, mode);
    if (session.provider !== 'claude') throw new AgentReviewError('session_not_found');
    const projectPath = session.project_path ?? '';
    const fence = this.seams.capture(sessionId, projectPath, actor.userId, mode);
    return { actorUserId: actor.userId, assertCurrent: (access = mode) => {
      current();
      const latest = this.seams.session(sessionId, actor.userId, access);
      if (latest.provider !== 'claude' || (latest.project_path ?? '') !== projectPath || (fence && !this.seams.current(fence))) {
        throw new AgentReviewError('project_access_changed');
      }
      if (access !== mode) {
        const writeFence = this.seams.capture(sessionId, projectPath, actor.userId, access);
        if (writeFence && !this.seams.current(writeFence)) throw new AgentReviewError('project_access_changed');
      }
      return true;
    } };
  }
}
