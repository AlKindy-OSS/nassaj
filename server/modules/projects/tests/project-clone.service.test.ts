import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';

import { startCloneProject } from '@/modules/projects/services/project-clone.service.js';
import { AppError } from '@/shared/utils.js';

type TestDependencies = Parameters<typeof startCloneProject>[2];

function buildDependencies(overrides: Partial<NonNullable<TestDependencies>> = {}): NonNullable<TestDependencies> {
  return {
    validatePath: async () => ({ valid: true, resolvedPath: '/workspace/root' }),
    ensureDirectory: async () => undefined,
    pathExists: async () => false,
    removePath: async () => undefined,
    getGithubTokenById: async () => ({ github_token: 'token-value' }),
    createAskpass: async () => ({
      env: { GIT_ASKPASS: '/workspace/synthetic-askpass' },
      cleanup: async () => undefined,
    }),
    spawnGitClone: () => {
      throw new Error('spawnGitClone should be overridden in this test');
    },
    registerProject: async () => ({ project: { projectId: 'project-1' } }),
    logError: () => undefined,
    ...overrides,
  };
}

function createMockGitProcess() {
  const emitter = new EventEmitter() as EventEmitter & {
    stdout: PassThrough;
    stderr: PassThrough;
    kill: () => void;
  };

  emitter.stdout = new PassThrough();
  emitter.stderr = new PassThrough();
  emitter.kill = () => {
    emitter.emit('close', null);
  };

  return emitter;
}

test('startCloneProject rejects when workspace path is missing', async () => {
  await assert.rejects(
    async () =>
      startCloneProject(
        {
          workspacePath: '',
          githubUrl: 'https://github.com/example/repo',
          userId: 1,
        },
        {
          onProgress: () => undefined,
          onComplete: () => undefined,
        },
        buildDependencies(),
      ),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.code, 'WORKSPACE_PATH_REQUIRED');
      return true;
    },
  );
});

test('startCloneProject rejects when github URL is missing', async () => {
  await assert.rejects(
    async () =>
      startCloneProject(
        {
          workspacePath: '/workspace/root',
          githubUrl: '',
          userId: 1,
        },
        {
          onProgress: () => undefined,
          onComplete: () => undefined,
        },
        buildDependencies(),
      ),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.code, 'GITHUB_URL_REQUIRED');
      return true;
    },
  );
});

test('startCloneProject rejects github URL values that begin with option prefixes', async () => {
  await assert.rejects(
    async () =>
      startCloneProject(
        {
          workspacePath: '/workspace/root',
          githubUrl: '--upload-pack=malicious',
          userId: 1,
        },
        {
          onProgress: () => undefined,
          onComplete: () => undefined,
        },
        buildDependencies(),
      ),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.code, 'INVALID_GITHUB_URL');
      return true;
    },
  );
});

test('startCloneProject rejects every non-canonical transport before path validation or spawn', async () => {
  const rejected = [
    'ext::sh -c echo github.com',
    'file:///workspace/repository',
    'ssh://git@github.com/example/repo.git',
    'git@github.com:example/repo.git',
    'https://token@github.com/example/repo.git',
    'https://github.com:443/example/repo.git',
    'https://github.com.evil.invalid/example/repo.git',
    'https://github.com/example/repo.git#fragment',
  ];
  for (const githubUrl of rejected) {
    let spawned = false;
    await assert.rejects(
      startCloneProject(
        { workspacePath: '/workspace/root', githubUrl, userId: 1 },
        { onProgress: () => undefined, onComplete: () => undefined },
        buildDependencies({
          spawnGitClone: () => {
            spawned = true;
            return createMockGitProcess() as any;
          },
        }),
      ),
      (error: unknown) => error instanceof AppError && error.code === 'INVALID_GITHUB_URL',
      githubUrl,
    );
    assert.equal(spawned, false, githubUrl);
  }
});

test('clone keeps token out of URL/env and never emits raw or oversized git diagnostics', async () => {
  const token = 'ghp_synthetic_marker_that_must_never_escape';
  const gitProcess = createMockGitProcess();
  const progress: string[] = [];
  let spawnedUrl = '';
  let spawnedEnv: NodeJS.ProcessEnv = {};
  let cleaned = false;
  const operation = await startCloneProject(
    {
      workspacePath: '/workspace/root',
      githubUrl: 'https://github.com/example/repo',
      newGithubToken: token,
      userId: 1,
    },
    { onProgress: (message) => progress.push(message), onComplete: () => undefined },
    buildDependencies({
      createAskpass: async (received) => {
        assert.equal(received, token);
        return {
          env: {
            GIT_ASKPASS: '/workspace/synthetic-askpass',
            NASSAJ_GIT_ASKPASS_SECRET_FILE: '/workspace/synthetic-secret-file',
          },
          cleanup: async () => { cleaned = true; },
        };
      },
      spawnGitClone: (url, _clonePath, env) => {
        spawnedUrl = url;
        spawnedEnv = env;
        return gitProcess as any;
      },
    }),
  );
  gitProcess.stdout.write(`${token}${'x'.repeat(100_000)}`);
  gitProcess.stderr.write(`${token}${'y'.repeat(100_000)}`);
  gitProcess.emit('close', 1);
  await assert.rejects(
    operation.waitForCompletion,
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.code, 'GIT_CLONE_FAILED');
      assert.ok(!error.message.includes(token));
      return true;
    },
  );
  assert.equal(spawnedUrl, 'https://github.com/example/repo.git');
  assert.ok(!spawnedUrl.includes(token));
  assert.ok(!JSON.stringify(spawnedEnv).includes(token));
  assert.ok(!JSON.stringify(progress).includes(token));
  assert.ok(progress.join('').length < 1_000);
  assert.equal(cleaned, true);
});

test('startCloneProject rejects when selected github token does not exist', async () => {
  await assert.rejects(
    async () =>
      startCloneProject(
        {
          workspacePath: '/workspace/root',
          githubUrl: 'https://github.com/example/repo',
          githubTokenId: 12,
          userId: 1,
        },
        {
          onProgress: () => undefined,
          onComplete: () => undefined,
        },
        buildDependencies({
          getGithubTokenById: async () => null,
        }),
      ),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.code, 'GITHUB_TOKEN_NOT_FOUND');
      return true;
    },
  );
});

test('startCloneProject completes and emits complete payload when git exits successfully', async () => {
  const gitProcess = createMockGitProcess();
  const progressMessages: string[] = [];
  let completePayload: { project: Record<string, unknown>; message: string } | null = null;
  let capturedProjectPath = '';
  let capturedCustomName = '';
  let capturedCreatedBy: number | null | undefined;

  const operation = await startCloneProject(
    {
      workspacePath: '/workspace/root',
      githubUrl: 'https://github.com/example/repo.git',
      userId: 1,
    },
    {
      onProgress: (message) => {
        progressMessages.push(message);
      },
      onComplete: (payload: { project: Record<string, unknown>; message: string }) => {
        completePayload = payload;
      },
    },
    buildDependencies({
      spawnGitClone: () => gitProcess as any,
      registerProject: async (projectPath, customName, createdBy) => {
        capturedProjectPath = projectPath;
        capturedCustomName = customName;
        capturedCreatedBy = createdBy;
        return { project: { projectId: 'project-1', path: projectPath } };
      },
    }),
  );

  gitProcess.emit('close', 0);
  await operation.waitForCompletion;

  assert.ok(progressMessages.some((message) => message.includes("Cloning into 'repo'")));
  assert.equal(capturedCustomName, 'repo');
  assert.equal(path.basename(capturedProjectPath), 'repo');
  assert.equal(capturedCreatedBy, 1);
  assert.notEqual(completePayload, null);
  const resolvedCompletePayload = completePayload as unknown as {
    project: Record<string, unknown>;
    message: string;
  };
  assert.equal(resolvedCompletePayload.message, 'Repository cloned successfully');
  assert.equal((resolvedCompletePayload.project.projectId as string) || '', 'project-1');
});
