/**
 * Central private-project visibility guard (B-PRIV-4).
 *
 * Single chokepoint every route that accepts a projectId / project_path must
 * call before resolving a project's content (files, sessions, participants,
 * token usage, etc.). When the project is not visible to the caller
 * it throws a 404 AppError — NOT 403 — so the server never discloses that a
 * private project the user cannot see even exists.
 *
 * Visibility is resolved by projectsDb.isProjectVisibleToUser, which has NO
 * platform-owner bypass: privacy is absolute by owner decision. Administrative
 * operations on metadata (orphan recovery in B-PRIV-5) are authorized
 * separately and never route through this content guard.
 */

import { projectsDb } from '@/modules/database/index.js';
import { AppError } from '@/shared/utils.js';

/**
 * Throws a 404 AppError when `projectId` is not visible to `userId`. A null/NaN
 * userId is treated as unauthenticated (only public projects pass). Returns the
 * resolved absolute project path on success so callers avoid a second lookup.
 */
export function assertProjectVisible(projectId: string, userId: number | null): string {
  const visible = projectsDb.isProjectVisibleToUser(projectId, userId);
  if (!visible) {
    // 404 (not 403): never reveal that a hidden project exists.
    throw new AppError('Project not found', {
      code: 'PROJECT_NOT_FOUND',
      statusCode: 404,
    });
  }

  const projectPath = projectsDb.getProjectPathById(projectId);
  if (!projectPath) {
    throw new AppError('Project not found', {
      code: 'PROJECT_NOT_FOUND',
      statusCode: 404,
    });
  }
  return projectPath;
}

/**
 * Boolean variant for the JS layer (server/index.js) and WS paths that handle
 * their own response shaping. Never throws.
 */
export function isProjectVisible(projectId: string, userId: number | null): boolean {
  return projectsDb.isProjectVisibleToUser(projectId, userId);
}

/** Coerces a raw req.user.id / socket userId into a DB user id, or null. */
export function coerceUserId(rawUserId: unknown): number | null {
  if (typeof rawUserId === 'number') {
    return Number.isInteger(rawUserId) ? rawUserId : null;
  }
  if (typeof rawUserId === 'string' && rawUserId.trim() !== '') {
    const parsed = Number.parseInt(rawUserId, 10);
    return Number.isNaN(parsed) ? null : parsed;
  }
  return null;
}
