import fs from 'node:fs/promises';
import path from 'node:path';

import {
  canAccessProjectPath,
  isProjectMembershipEnforced,
  projectsDb,
} from '@/modules/database/index.js';
import type {
  CreateProjectPathResult,
  ProjectRepositoryRow,
  WorkspacePathValidationResult,
} from '@/shared/types.js';
import { AppError, normalizeProjectPath, validateWorkspacePath } from '@/shared/utils.js';

import { emptySessionBuckets, type SessionBuckets } from '../../../../shared/sessionBuckets.js';

type CreateProjectInput = {
  projectPath: string;
  customName?: string | null;
  // Authenticated creator id (from req.user.id). Recorded as projects.created_by
  // so the private-project authorization layer (B-PRIV) can identify the owner.
  createdBy?: number | null;
};

type CreateProjectDependencies = {
  validatePath: (projectPath: string) => Promise<WorkspacePathValidationResult>;
  ensureWorkspaceDirectory: (projectPath: string) => Promise<void>;
  persistProjectPath: (
    projectPath: string,
    customName: string | null,
    createdBy: number | null,
  ) => CreateProjectPathResult;
  getProjectByPath: (projectPath: string) => ProjectRepositoryRow | null;
  isPathAdmitted: (projectPath: string, userId: number | null) => boolean;
};

type ProjectApiView = {
  projectId: string;
  path: string;
  fullPath: string;
  displayName: string;
  customName: string | null;
  isArchived: boolean;
  isStarred: boolean;
  sessionMeta: {
    hasMore: false;
    total: 0;
  };
} & SessionBuckets<never>;

type CreateProjectServiceResult = {
  outcome: 'created' | 'reactivated_archived';
  project: ProjectApiView;
};

const defaultDependencies: CreateProjectDependencies = {
  validatePath: validateWorkspacePath,
  ensureWorkspaceDirectory: async (projectPath: string): Promise<void> => {
    await fs.mkdir(projectPath, { recursive: true });
    const directoryStats = await fs.stat(projectPath);
    if (!directoryStats.isDirectory()) {
      throw new AppError('Path exists but is not a directory', {
        code: 'PROJECT_PATH_NOT_DIRECTORY',
        statusCode: 400,
      });
    }
  },
  persistProjectPath: (
    projectPath: string,
    customName: string | null,
    createdBy: number | null,
  ): CreateProjectPathResult => projectsDb.createProjectPath(projectPath, customName, createdBy),
  getProjectByPath: (projectPath: string): ProjectRepositoryRow | null =>
    projectsDb.getProjectPath(projectPath),
  // ADR-172 (B-1423): a registered project path — or a path nested inside one —
  // is admitted only for callers who can access that project. Unregistered
  // paths stay open (creation flow). Off when membership is not enforced, where
  // every project is readable by every user and existence is not a secret.
  isPathAdmitted: (projectPath: string, userId: number | null): boolean =>
    !isProjectMembershipEnforced() || canAccessProjectPath(projectPath, userId),
};

/**
 * One response for every path a caller may not use. It carries no project
 * state, so a non-member cannot tell a registered path from any other refusal.
 */
function inadmissiblePathError(): AppError {
  return new AppError('Invalid project path', {
    code: 'INVALID_PROJECT_PATH',
    statusCode: 400,
    details: 'Path validation failed',
  });
}

function resolveDisplayName(customName: string | null | undefined, projectPath: string): string {
  const trimmedCustomName = typeof customName === 'string' ? customName.trim() : '';
  if (trimmedCustomName.length > 0) {
    return trimmedCustomName;
  }

  return path.basename(projectPath) || projectPath;
}

function mapProjectRowToApiView(projectRow: ProjectRepositoryRow): ProjectApiView {
  return {
    projectId: projectRow.project_id,
    path: projectRow.project_path,
    fullPath: projectRow.project_path,
    displayName: resolveDisplayName(projectRow.custom_project_name, projectRow.project_path),
    customName: projectRow.custom_project_name,
    isArchived: Boolean(projectRow.isArchived),
    isStarred: Boolean(projectRow.isStarred),
    // A freshly created project has no sessions yet, but it must still carry
    // EVERY bucket key: the client merges this payload with later pages, and a
    // missing key reads as "provider unknown" rather than "provider empty".
    ...emptySessionBuckets<never>(),
    sessionMeta: {
      hasMore: false,
      total: 0,
    },
  };
}

export async function createProject(
  input: CreateProjectInput,
  dependencies: CreateProjectDependencies = defaultDependencies,
): Promise<CreateProjectServiceResult> {
  const normalizedPath = normalizeProjectPath(input.projectPath || '');
  if (!normalizedPath) {
    throw new AppError('path is required', {
      code: 'PROJECT_PATH_REQUIRED',
      statusCode: 400,
    });
  }

  const pathValidation = await dependencies.validatePath(normalizedPath);
  if (!pathValidation.valid || !pathValidation.resolvedPath) {
    throw new AppError('Invalid project path', {
      code: 'INVALID_PROJECT_PATH',
      statusCode: 400,
      details: pathValidation.error ?? 'Path validation failed',
    });
  }

  const resolvedProjectPath = normalizeProjectPath(pathValidation.resolvedPath);
  const createdBy = Number.isInteger(input.createdBy) ? (input.createdBy as number) : null;
  // Authorize BEFORE any existence lookup or filesystem write (B-1423): the
  // 409 below is reachable only by callers who may already see the project.
  if (!dependencies.isPathAdmitted(resolvedProjectPath, createdBy)) {
    throw inadmissiblePathError();
  }
  await dependencies.ensureWorkspaceDirectory(resolvedProjectPath);

  const normalizedCustomName = resolveDisplayName(input.customName ?? null, resolvedProjectPath);
  const persistedProject = dependencies.persistProjectPath(
    resolvedProjectPath,
    normalizedCustomName,
    createdBy,
  );

  if (persistedProject.outcome === 'active_conflict') {
    throw new AppError('Project path already exists and is active', {
      code: 'PROJECT_ALREADY_EXISTS',
      statusCode: 409,
      details: `Project path already exists: ${resolvedProjectPath}`,
    });
  }

  const projectRow = persistedProject.project ?? dependencies.getProjectByPath(resolvedProjectPath);
  if (!projectRow) {
    throw new AppError('Failed to resolve project after creation', {
      code: 'PROJECT_CREATE_FAILED',
      statusCode: 500,
    });
  }

  // Explicit create-project on an archived path reactivates it
  // (outcome 'reactivated_archived'); this is deliberate re-adding, distinct
  // from a session launch, which preserves the archived flag (B-1096).
  return {
    outcome: persistedProject.outcome,
    project: mapProjectRowToApiView(projectRow),
  };
}

/**
 * Sets `projects.custom_project_name` for the given `projectId` (or clears it when empty).
 */
export function updateProjectDisplayName(projectId: string, newDisplayName: unknown): void {
  const trimmed = typeof newDisplayName === 'string' ? newDisplayName.trim() : '';
  projectsDb.updateCustomProjectNameById(projectId, trimmed.length > 0 ? trimmed : null);
}
