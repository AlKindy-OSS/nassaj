/**
 * Private-project management service (B-PRIV-5).
 *
 * Owns the server-side authorization for visibility/membership mutations and the
 * platform-owner orphan-recovery operations. Authorization is decided HERE from
 * the DB (created_by / project_members / platform role) — never trusted from the
 * client. All errors are AppError so routes return controlled status codes.
 *
 * Authorization model (owner decision):
 *  - Member management (ADR-172): anyone with canAccessProject — platform
 *    owner/admin, any member, or the creator. The creator cannot be removed.
 *  - canManageProject (creator, project 'owner' member, platform owner) still
 *    gates the irreversible project force-delete in projects.routes.ts.
 *  - Orphan recovery (no created_by AND no project_members 'owner'): platform
 *    owner only — transfer ownership (set created_by + add owner member) or
 *    delete. These touch metadata only and never read project content.
 */

import {
  auditLogDb,
  canAccessProject,
  projectMembersDb,
  projectsDb,
  userCanSeeAllProjects,
  userDb,
} from '@/modules/database/index.js';
import type { ProjectMemberRole } from '@/modules/database/index.js';
import type { ProjectRepositoryRow } from '@/shared/types.js';
import { AppError } from '@/shared/utils.js';

function notFound(): AppError {
  // 404 (not 403) so a hidden project's existence is never disclosed.
  return new AppError('Project not found', { code: 'PROJECT_NOT_FOUND', statusCode: 404 });
}

function forbidden(): AppError {
  return new AppError('You do not have permission to manage this project', {
    code: 'PROJECT_MANAGE_FORBIDDEN',
    statusCode: 403,
  });
}

/**
 * True when the user may manage a project's visibility/members: its creator, a
 * project_members 'owner', or the platform owner (administrative).
 */
export function canManageProject(
  projectId: string,
  userId: number | null,
  isPlatformOwner: boolean,
): boolean {
  if (isPlatformOwner) {
    return true;
  }
  if (!Number.isInteger(userId)) {
    return false;
  }
  const project = projectsDb.getProjectById(projectId);
  if (!project) {
    return false;
  }
  if (project.created_by === userId) {
    return true;
  }
  return projectMembersDb.getRole(projectId, userId as number) === 'owner';
}

/*
 * setVisibility was REMOVED by ADR-089 along with the public/private feature.
 *
 * ADR-172: membership management is gated by canAccessProject (platform
 * owner/admin, any member, or the creator) — every member may add or remove
 * members. This gate is independent of PROJECT_MEMBERSHIP_ENFORCE so members
 * can be curated before enforcement is switched on. Refusal is 404, never 403,
 * so a project the caller cannot reach is not disclosed.
 */

/** Request context recorded on the audit row (never tokens or PII). */
export type MembershipAuditContext = {
  ipAddress?: string | null;
  userAgent?: string | null;
  /** Actor holds the platform-owner role (req.user.role === 'owner'), JWT-derived. */
  isPlatformOwner?: boolean;
};

/**
 * Owner decision 2026-09-23 (qa #1/#2): any member may add members (always as
 * 'member') and remove regular members, but granting 'owner', changing an
 * existing member's role, or removing an 'owner' member needs canManageProject
 * (creator / project 'owner' / platform owner). Platform admin does NOT get it,
 * so no member or admin can reach the permanent-delete gate this way.
 */
function assertRoleChangeAllowed(projectId: string, userId: number | null, context: MembershipAuditContext): void {
  if (!canManageProject(projectId, userId, context.isPlatformOwner === true)) {
    throw forbidden();
  }
}

/** Payload handed to removal listeners (live-subscription teardown, notice). */
export type MemberRemovedEvent = {
  projectId: string;
  projectPath: string;
  userId: number;
  removedBy: number | null;
  /** Whether the removed user can still reach the project (admin, flag off). */
  stillHasAccess: boolean;
};

type MemberRemovedListener = (event: MemberRemovedEvent) => void;
const memberRemovedListeners = new Set<MemberRemovedListener>();

/** Registers a removal listener (wired in server/index.js). Returns an unsubscribe. */
export function onMemberRemoved(listener: MemberRemovedListener): () => void {
  memberRemovedListeners.add(listener);
  return () => memberRemovedListeners.delete(listener);
}

function emitMemberRemoved(event: MemberRemovedEvent): void {
  for (const listener of memberRemovedListeners) {
    try {
      listener(event);
    } catch (error) {
      // A failing listener must not undo an already-committed removal.
      console.error('[ADR-172] member-removed listener failed', {
        projectId: event.projectId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

/** Throws 404 unless the project exists and the caller may access it. */
function requireAccess(projectId: string, userId: number | null): ProjectRepositoryRow {
  const project = projectsDb.getProjectById(projectId);
  if (!project || !canAccessProject(projectId, userId)) {
    throw notFound();
  }
  return project;
}

function assertTargetUserId(targetUserId: number): void {
  if (!Number.isInteger(targetUserId)) {
    throw new AppError('A valid userId is required', { code: 'INVALID_USER_ID', statusCode: 400 });
  }
}

/** Adds a member (role changes gated, see assertRoleChangeAllowed). Caller needs access. */
export function addMember(
  projectId: string,
  targetUserId: number,
  role: ProjectMemberRole,
  userId: number | null,
  context: MembershipAuditContext = {},
): { projectId: string; userId: number; role: ProjectMemberRole } {
  assertTargetUserId(targetUserId);
  if (role !== 'owner' && role !== 'member') {
    throw new AppError("role must be 'owner' or 'member'", { code: 'INVALID_ROLE', statusCode: 400 });
  }

  const project = requireAccess(projectId, userId);
  if (project.created_by === targetUserId) {
    throw new AppError('The project creator role cannot be changed', {
      code: 'cannot_change_creator_role',
      statusCode: 409,
    });
  }
  const existingRole = projectMembersDb.getRole(projectId, targetUserId);
  if (role === 'owner' || (existingRole !== null && existingRole !== role)) {
    assertRoleChangeAllowed(projectId, userId, context);
  }

  // getUserById returns ACTIVE users only: a disabled account cannot be added.
  if (!userDb.getUserById(targetUserId)) {
    throw new AppError('Target user not found', { code: 'USER_NOT_FOUND', statusCode: 404 });
  }

  projectMembersDb.addAndRotateProjectAccess(projectId, targetUserId, role, userId);
  auditLogDb.record('project.member.add', {
    userId,
    metadata: { projectId, targetUserId, role },
    ipAddress: context.ipAddress ?? null,
    userAgent: context.userAgent ?? null,
  });
  return { projectId, userId: targetUserId, role };
}

/**
 * Removes a member. The acting user must have access; the project creator can
 * never be removed (409 cannot_remove_creator). Listeners then tear down the
 * removed user's live subscriptions and notify them.
 */
export function removeMember(
  projectId: string,
  targetUserId: number,
  userId: number | null,
  context: MembershipAuditContext = {},
): { projectId: string; userId: number } {
  assertTargetUserId(targetUserId);

  const project = requireAccess(projectId, userId);
  if (project.created_by === targetUserId) {
    throw new AppError('The project creator cannot be removed', {
      code: 'cannot_remove_creator',
      statusCode: 409,
    });
  }
  if (projectMembersDb.getRole(projectId, targetUserId) === 'owner') {
    assertRoleChangeAllowed(projectId, userId, context);
  }

  // Audit + live revocation only when a membership actually ended.
  const removed = projectMembersDb.removeAndRotateProjectAccess(projectId, targetUserId);
  if (!removed) {
    return { projectId, userId: targetUserId };
  }
  auditLogDb.record('project.member.remove', {
    userId,
    metadata: { projectId, targetUserId },
    ipAddress: context.ipAddress ?? null,
    userAgent: context.userAgent ?? null,
  });
  emitMemberRemoved({
    projectId,
    projectPath: project.project_path,
    userId: targetUserId,
    removedBy: userId,
    stillHasAccess: projectsDb.isProjectVisibleToUser(projectId, targetUserId),
  });
  return { projectId, userId: targetUserId };
}

/** One member as returned by GET members (legacy snake_case fields kept). */
export type ProjectMemberView = {
  project_id: string;
  user_id: number;
  added_by: number | null;
  created_at: string | null;
  userId: number;
  displayName: string | null;
  avatar: string | null;
  role: ProjectMemberRole;
  isCreator: boolean;
};

/**
 * Members of a project, visible to anyone with access to it. Each entry carries
 * display identity only (username/avatar — no email, no system role); the
 * creator is always listed. `viewer.adminAccess` marks a caller who sees the
 * project only through the platform role (owner/admin), not membership.
 * Legacy fields (project_id, user_id, added_by, created_at) stay for old clients.
 */
export function listMembers(
  projectId: string,
  userId: number | null,
): {
  projectId: string;
  members: ProjectMemberView[];
  viewer: {
    isMember: boolean;
    adminAccess: boolean;
    canManageMembers: boolean;
    canManageOwnerRole: boolean;
  };
} {
  requireAccess(projectId, userId);
  const members = projectMembersDb.listByProjectWithIdentity(projectId).map((row) => ({
    project_id: row.project_id,
    user_id: row.user_id,
    added_by: row.added_by,
    created_at: row.created_at,
    userId: row.user_id,
    displayName: row.username,
    avatar: row.avatar_url,
    role: row.role,
    isCreator: row.is_creator === 1,
  }));
  const isMember = members.some((member) => member.userId === userId);
  const isPlatformOwner = Number.isInteger(userId) && userDb.getUserById(userId as number)?.role === 'owner';
  return {
    projectId,
    members,
    viewer: {
      isMember,
      adminAccess: !isMember && userCanSeeAllProjects(userId),
      canManageMembers: true,
      canManageOwnerRole: canManageProject(projectId, userId, isPlatformOwner),
    },
  };
}

export const MEMBER_CANDIDATES_MIN_QUERY = 2;
export const MEMBER_CANDIDATES_MAX_QUERY = 64;
export const MEMBER_CANDIDATES_LIMIT = 20;

/**
 * Users that may be added to the project, matched by username. Returns only
 * {id, displayName, avatar}: no email, role or status. Disabled users and
 * existing members are excluded; at most MEMBER_CANDIDATES_LIMIT rows.
 */
export function searchMemberCandidates(
  projectId: string,
  rawQuery: unknown,
  userId: number | null,
): { projectId: string; candidates: Array<{ id: number; displayName: string; avatar: string | null }> } {
  const query = typeof rawQuery === 'string' ? rawQuery.trim() : '';
  if (query.length < MEMBER_CANDIDATES_MIN_QUERY || query.length > MEMBER_CANDIDATES_MAX_QUERY) {
    throw new AppError('Query must be between 2 and 64 characters', {
      code: 'INVALID_QUERY',
      statusCode: 400,
    });
  }
  requireAccess(projectId, userId);
  const rows = userDb.searchMemberCandidates(projectId, query, MEMBER_CANDIDATES_LIMIT);
  return {
    projectId,
    candidates: rows.map((row) => ({ id: row.id, displayName: row.username, avatar: row.avatar_url })),
  };
}

/**
 * Whether a project is orphaned: no recorded creator AND no project_members
 * 'owner'. Such a project cannot be managed by anyone except the platform owner,
 * who may recover it (transfer ownership or delete) WITHOUT reading its content.
 */
export function isOrphanProject(projectId: string): boolean {
  const project = projectsDb.getProjectById(projectId);
  if (!project) {
    return false;
  }
  if (Number.isInteger(project.created_by)) {
    return false;
  }
  return !projectMembersDb.listByProject(projectId).some((member) => member.role === 'owner');
}

/**
 * Platform-owner recovery of an ORPHANED project: transfers ownership to
 * `newOwnerUserId` (sets created_by and inserts an owner membership). Metadata
 * only — no content is read. Refuses non-orphans so it cannot be used to seize a
 * project that already has a legitimate manager.
 */
export function recoverOrphanByTransfer(
  projectId: string,
  newOwnerUserId: number,
  isPlatformOwner: boolean,
): { projectId: string; createdBy: number } {
  if (!isPlatformOwner) {
    throw forbidden();
  }
  if (!Number.isInteger(newOwnerUserId)) {
    throw new AppError('A valid newOwnerUserId is required', {
      code: 'INVALID_USER_ID',
      statusCode: 400,
    });
  }
  if (!projectsDb.getProjectById(projectId)) {
    throw notFound();
  }
  if (!isOrphanProject(projectId)) {
    throw new AppError('Project is not orphaned', {
      code: 'PROJECT_NOT_ORPHANED',
      statusCode: 409,
    });
  }
  if (!userDb.getUserById(newOwnerUserId)) {
    throw new AppError('Target user not found', { code: 'USER_NOT_FOUND', statusCode: 404 });
  }

  if (!projectsDb.transferProjectCreator(projectId, newOwnerUserId)) {
    throw new AppError('Project ownership changed concurrently', {
      code: 'PROJECT_OWNERSHIP_CONFLICT', statusCode: 409,
    });
  }
  return { projectId, createdBy: newOwnerUserId };
}
