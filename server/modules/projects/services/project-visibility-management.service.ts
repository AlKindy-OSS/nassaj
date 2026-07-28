/**
 * Private-project management service (B-PRIV-5).
 *
 * Owns the server-side authorization for visibility/membership mutations and the
 * platform-owner orphan-recovery operations. Authorization is decided HERE from
 * the DB (created_by / project_members / platform role) — never trusted from the
 * client. All errors are AppError so routes return controlled status codes.
 *
 * Authorization model (owner decision):
 *  - Visibility toggle + member management: the project creator (created_by), a
 *    project_members 'owner', OR the platform owner (administrative capability).
 *  - When a project is switched to private its creator is inserted as a
 *    project_members 'owner' so it always has at least one manager.
 *  - Orphan recovery (no created_by AND no project_members 'owner'): platform
 *    owner only — transfer ownership (set created_by + add owner member) or
 *    delete. These touch metadata only and never read project content.
 */

import { projectMembersDb, projectsDb, userDb } from '@/modules/database/index.js';
import type { ProjectMemberRole } from '@/modules/database/index.js';
import type { ProjectVisibility } from '@/shared/types.js';
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

/**
 * Authorization gate shared by the management routes. The platform owner may act
 * even on a project they cannot see (administrative), so this does NOT call the
 * content-visibility guard. Throws 404 for unknown ids, 403 when unauthorized.
 */
function requireManage(projectId: string, userId: number | null, isPlatformOwner: boolean): void {
  const project = projectsDb.getProjectById(projectId);
  if (!project) {
    throw notFound();
  }
  if (!canManageProject(projectId, userId, isPlatformOwner)) {
    throw forbidden();
  }
}

/**
 * Sets a project's visibility. On switch to 'private' the creator (or the acting
 * user, when there is no recorded creator) is ensured as a project_members
 * 'owner' so the project always has a manager.
 */
export function setVisibility(
  projectId: string,
  visibility: ProjectVisibility,
  userId: number | null,
  isPlatformOwner: boolean,
): { projectId: string; visibility: ProjectVisibility } {
  if (visibility !== 'public' && visibility !== 'private') {
    throw new AppError("visibility must be 'public' or 'private'", {
      code: 'INVALID_VISIBILITY',
      statusCode: 400,
    });
  }

  requireManage(projectId, userId, isPlatformOwner);

  projectsDb.setProjectVisibility(projectId, visibility);

  if (visibility === 'private') {
    const project = projectsDb.getProjectById(projectId);
    const ownerCandidate = project?.created_by ?? (Number.isInteger(userId) ? userId : null);
    if (Number.isInteger(ownerCandidate)) {
      projectMembersDb.add(projectId, ownerCandidate as number, 'owner', userId);
    }
  }

  return { projectId, visibility };
}

/** Adds (or updates the role of) a member. The acting user must be a manager. */
export function addMember(
  projectId: string,
  targetUserId: number,
  role: ProjectMemberRole,
  userId: number | null,
  isPlatformOwner: boolean,
): { projectId: string; userId: number; role: ProjectMemberRole } {
  if (!Number.isInteger(targetUserId)) {
    throw new AppError('A valid userId is required', { code: 'INVALID_USER_ID', statusCode: 400 });
  }
  if (role !== 'owner' && role !== 'member') {
    throw new AppError("role must be 'owner' or 'member'", { code: 'INVALID_ROLE', statusCode: 400 });
  }

  requireManage(projectId, userId, isPlatformOwner);

  if (!userDb.getUserById(targetUserId)) {
    throw new AppError('Target user not found', { code: 'USER_NOT_FOUND', statusCode: 404 });
  }

  projectMembersDb.add(projectId, targetUserId, role, userId);
  return { projectId, userId: targetUserId, role };
}

/** Removes a member. The acting user must be a manager. */
export function removeMember(
  projectId: string,
  targetUserId: number,
  userId: number | null,
  isPlatformOwner: boolean,
): { projectId: string; userId: number } {
  if (!Number.isInteger(targetUserId)) {
    throw new AppError('A valid userId is required', { code: 'INVALID_USER_ID', statusCode: 400 });
  }

  requireManage(projectId, userId, isPlatformOwner);

  projectMembersDb.remove(projectId, targetUserId);
  return { projectId, userId: targetUserId };
}

/** Members of a project (manager-only view of the membership list). */
export function listMembers(
  projectId: string,
  userId: number | null,
  isPlatformOwner: boolean,
): { projectId: string; members: ReturnType<typeof projectMembersDb.listByProject> } {
  requireManage(projectId, userId, isPlatformOwner);
  return { projectId, members: projectMembersDb.listByProject(projectId) };
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

  projectsDb.setProjectCreatedBy(projectId, newOwnerUserId);
  projectMembersDb.add(projectId, newOwnerUserId, 'owner', null);
  return { projectId, createdBy: newOwnerUserId };
}
