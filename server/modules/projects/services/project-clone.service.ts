import { spawn } from 'node:child_process';
import { access, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';

import { githubTokensDb } from '@/modules/database/index.js';
import { createProject } from '@/modules/projects/services/project-management.service.js';
import type { WorkspacePathValidationResult } from '@/shared/types.js';
import { AppError, validateWorkspacePath } from '@/shared/utils.js';
import {
  appendBoundedDiagnostic,
  classifyGitCloneFailure,
  createGitAskpassLease,
  parseCanonicalGitHubUrl,
  type GitAskpassLease,
} from '@/modules/projects/services/git-transport-security.service.js';

export type CloneProjectInput = {
  workspacePath: string;
  githubUrl: string;
  githubTokenId?: number | null;
  newGithubToken?: string | null;
  userId: number | string;
};

type CloneCompletePayload = {
  project: Record<string, unknown>;
  message: string;
};

type CloneProjectEventHandlers = {
  onProgress: (message: string) => void;
  onComplete: (payload: CloneCompletePayload) => void;
};

type GitCloneProcess = {
  stdout: NodeJS.ReadableStream | null;
  stderr: NodeJS.ReadableStream | null;
  on(event: 'close', listener: (code: number | null) => void): void;
  on(event: 'error', listener: (error: NodeJS.ErrnoException) => void): void;
  kill(): void;
};

type CloneProjectDependencies = {
  validatePath: (requestedPath: string) => Promise<WorkspacePathValidationResult>;
  ensureDirectory: (directoryPath: string) => Promise<void>;
  pathExists: (targetPath: string) => Promise<boolean>;
  removePath: (targetPath: string) => Promise<void>;
  getGithubTokenById: (
    tokenId: number,
    userId: number,
  ) => Promise<{ github_token: string } | null>;
  createAskpass: (token: string | null) => Promise<GitAskpassLease>;
  spawnGitClone: (cloneUrl: string, clonePath: string, env: NodeJS.ProcessEnv) => GitCloneProcess;
  registerProject: (
    projectPath: string,
    customName: string,
    createdBy: number | null,
  ) => Promise<{ project: Record<string, unknown> }>;
  logError: (message: string, error: unknown) => void;
};

export type CloneProjectOperation = {
  waitForCompletion: Promise<void>;
  cancel: () => void;
};

async function defaultPathExists(targetPath: string): Promise<boolean> {
  try {
    await access(targetPath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return false;
    }

    throw error;
  }
}

function resolveErrorMessage(error: unknown): string {
  if (error instanceof AppError) {
    return error.message;
  }

  if (error instanceof Error && error.message) {
    return error.message;
  }

  return 'Unexpected error';
}

const defaultDependencies: CloneProjectDependencies = {
  validatePath: validateWorkspacePath,
  ensureDirectory: async (directoryPath: string): Promise<void> => {
    await mkdir(directoryPath, { recursive: true });
  },
  pathExists: defaultPathExists,
  removePath: async (targetPath: string): Promise<void> => {
    await rm(targetPath, { recursive: true, force: true });
  },
  getGithubTokenById: async (
    tokenId: number,
    userId: number,
  ): Promise<{ github_token: string } | null> => {
    const tokenRow = githubTokensDb.getGithubTokenById(userId, tokenId) as
      | { github_token: string }
      | null;
    return tokenRow;
  },
  createAskpass: createGitAskpassLease,
  spawnGitClone: (cloneUrl: string, clonePath: string, env: NodeJS.ProcessEnv): GitCloneProcess =>
    spawn('git', ['clone', '--progress', '--', cloneUrl, clonePath], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env,
    }) as unknown as GitCloneProcess,
  registerProject: async (
    projectPath: string,
    customName: string,
    createdBy: number | null,
  ): Promise<{ project: Record<string, unknown> }> =>
    createProject({
      projectPath,
      customName,
      createdBy,
    }) as Promise<{ project: Record<string, unknown> }>,
  logError: (message: string, error: unknown): void => {
    console.error(message, error);
  },
};

export async function startCloneProject(
  input: CloneProjectInput,
  handlers: CloneProjectEventHandlers,
  dependencies: CloneProjectDependencies = defaultDependencies,
): Promise<CloneProjectOperation> {
  const normalizedWorkspacePath = input.workspacePath.trim();
  const normalizedGithubUrl = input.githubUrl.trim();

  // Authenticated creator id — recorded as projects.created_by so cloned
  // projects are attributed to their creator (B-PRIV ownership/"My projects").
  const parsedCreatorUserId =
    typeof input.userId === 'number' ? input.userId : Number.parseInt(String(input.userId), 10);
  const creatorUserId = Number.isInteger(parsedCreatorUserId) ? parsedCreatorUserId : null;

  if (!normalizedWorkspacePath) {
    throw new AppError('workspacePath and githubUrl are required', {
      code: 'WORKSPACE_PATH_REQUIRED',
      statusCode: 400,
    });
  }

  if (!normalizedGithubUrl) {
    throw new AppError('workspacePath and githubUrl are required', {
      code: 'GITHUB_URL_REQUIRED',
      statusCode: 400,
    });
  }

  let repository;
  try {
    repository = parseCanonicalGitHubUrl(normalizedGithubUrl);
  } catch {
    throw new AppError('Invalid githubUrl', {
      code: 'INVALID_GITHUB_URL',
      statusCode: 400,
    });
  }

  const pathValidation = await dependencies.validatePath(normalizedWorkspacePath);
    if (!pathValidation.valid || !pathValidation.resolvedPath) {
      throw new AppError(pathValidation.error || 'Invalid workspace path', {
        code: 'INVALID_PROJECT_PATH',
        statusCode: 400,
      });
    }

    const absolutePath = pathValidation.resolvedPath;
    await dependencies.ensureDirectory(absolutePath);

    let githubToken: string | null = null;
    if (typeof input.githubTokenId === 'number') {
      const numericUserId =
        typeof input.userId === 'number' ? input.userId : Number.parseInt(String(input.userId), 10);
      if (Number.isNaN(numericUserId)) {
        throw new AppError('Authenticated user is required', {
          code: 'AUTHENTICATION_REQUIRED',
          statusCode: 401,
        });
      }

      const token = await dependencies.getGithubTokenById(input.githubTokenId, numericUserId);
      if (!token) {
        throw new AppError('GitHub token not found', {
          code: 'GITHUB_TOKEN_NOT_FOUND',
          statusCode: 404,
        });
      }

      githubToken = token.github_token;
    } else if (input.newGithubToken && input.newGithubToken.trim().length > 0) {
      githubToken = input.newGithubToken.trim();
    }

    const repoName = repository.repo;
    const clonePath = path.join(absolutePath, repoName);

    if (await dependencies.pathExists(clonePath)) {
      throw new AppError(
        `Directory "${repoName}" already exists. Please choose a different location or remove the existing directory.`,
        {
          code: 'CLONE_TARGET_ALREADY_EXISTS',
          statusCode: 409,
        },
      );
    }

    handlers.onProgress(`Cloning into '${repoName}'...`);
    const askpass = await dependencies.createAskpass(githubToken);
    let gitProcess: GitCloneProcess;
    try {
      gitProcess = dependencies.spawnGitClone(repository.cloneUrl, clonePath, askpass.env);
    } catch (error) {
      await askpass.cleanup();
      throw error;
    }
    let diagnostic = '';

    gitProcess.stdout?.on('data', (data: Buffer | string) => {
      diagnostic = appendBoundedDiagnostic(diagnostic, data);
    });

    gitProcess.stderr?.on('data', (data: Buffer | string) => {
      diagnostic = appendBoundedDiagnostic(diagnostic, data);
    });

  const waitForCompletion = new Promise<void>((resolve, reject) => {
      gitProcess.on('close', async (code) => {
        await askpass.cleanup();
        if (code === 0) {
          try {
            const createdProject = await dependencies.registerProject(clonePath, repoName, creatorUserId);
            handlers.onComplete({
              project: createdProject.project,
              message: 'Repository cloned successfully',
            });
            resolve();
          } catch (error) {
            reject(
              new AppError(`Clone succeeded but failed to add project: ${resolveErrorMessage(error)}`, {
                code: 'CLONE_PROJECT_REGISTRATION_FAILED',
                statusCode: 500,
              }),
            );
          }
          return;
        }

        const failure = classifyGitCloneFailure(diagnostic);

        try {
          await dependencies.removePath(clonePath);
        } catch (cleanupError) {
          dependencies.logError('Failed to clean up after clone failure:', cleanupError);
        }

        reject(
          new AppError(failure.message, {
            code: failure.code,
            statusCode: 500,
          }),
        );
      });

      gitProcess.on('error', async (error) => {
        await askpass.cleanup();
        if (error.code === 'ENOENT') {
          reject(
            new AppError('Git is not installed or not in PATH', {
              code: 'GIT_NOT_FOUND',
              statusCode: 500,
            }),
          );
          return;
        }

        reject(
          new AppError('Git could not be started', {
            code: 'GIT_EXECUTION_FAILED',
            statusCode: 500,
          }),
        );
      });
  });

  return {
    waitForCompletion,
    cancel: () => {
      gitProcess.kill();
    },
  };
}
