import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';

import { cloneGitHubRepo, pushGitHubBranch } from './agent.js';

function fakeGitProcess() {
  const emitter = new EventEmitter() as EventEmitter & {
    stdout: PassThrough;
    stderr: PassThrough;
  };
  emitter.stdout = new PassThrough();
  emitter.stderr = new PassThrough();
  return emitter;
}

function closeFakeGitProcess(
  processHandle: ReturnType<typeof fakeGitProcess>,
  code: number,
): void {
  processHandle.stdout.end();
  processHandle.stderr.end();
  processHandle.emit('close', code);
}

function createSpawnWaiter(): { markSpawned: () => void; spawned: Promise<void> } {
  let markSpawned!: () => void;
  const spawned = new Promise<void>((resolve) => {
    markSpawned = resolve;
  });
  return { markSpawned, spawned };
}

test('agent clone keeps credentials out of URL/argv/env and returns bounded stable errors', { timeout: 5_000 }, async () => {
  const token = 'ghp_synthetic_clone_marker';
  const directory = await mkdtemp(path.join(tmpdir(), 'nassaj-agent-clone-test-'));
  try {
    const processHandle = fakeGitProcess();
    const spawned: unknown[] = [];
    const spawnWaiter = createSpawnWaiter();

  const pending = cloneGitHubRepo(
    'https://github.com/example/repository.git',
    token,
    path.join(directory, 'repository'),
    {
      createAskpass: async (received: string) => {
        assert.equal(received, token);
        return {
          env: { GIT_ASKPASS: '/workspace/askpass', NASSAJ_GIT_ASKPASS_SECRET_FILE: '/workspace/secret' },
          cleanup: async () => undefined,
        };
      },
      spawnGit: (...args: unknown[]) => {
        spawned.push(...args);
        spawnWaiter.markSpawned();
        return processHandle;
      },
    },
  );
  await spawnWaiter.spawned;
  processHandle.stdout.write(`${token}${'x'.repeat(100_000)}`);
  processHandle.stderr.write(`${token}${'y'.repeat(100_000)}`);
  closeFakeGitProcess(processHandle, 1);

  await assert.rejects(pending, (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal((error as Error & { code?: string }).code, 'GIT_CLONE_FAILED');
    assert.equal(error.message, 'Repository clone failed');
    assert.ok(!JSON.stringify(error).includes(token));
    return true;
  });
    assert.ok(!JSON.stringify(spawned).includes(token));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('agent push uses canonical URL plus askpass and never returns raw diagnostics', { timeout: 5_000 }, async () => {
  const token = 'ghp_synthetic_push_marker';
  const processHandle = fakeGitProcess();
  const spawned: unknown[] = [];
  const spawnWaiter = createSpawnWaiter();
  let cleaned = false;
  const pending = pushGitHubBranch(
    {
      repoUrl: 'https://github.com/example/repository.git',
      token,
      branchName: 'synthetic-branch',
      cwd: '/workspace/repository',
    },
    {
      createAskpass: async () => ({
        env: { GIT_ASKPASS: '/workspace/askpass', NASSAJ_GIT_ASKPASS_SECRET_FILE: '/workspace/secret' },
        cleanup: async () => { cleaned = true; },
      }),
      spawnGit: (...args: unknown[]) => {
        spawned.push(...args);
        spawnWaiter.markSpawned();
        return processHandle;
      },
    },
  );
  await spawnWaiter.spawned;
  processHandle.stdout.write(`${token}${'x'.repeat(100_000)}`);
  processHandle.stderr.write(`${'y'.repeat(100_000)}Authentication failed: ${token}`);
  closeFakeGitProcess(processHandle, 1);

  await assert.rejects(pending, (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal((error as Error & { code?: string }).code, 'GIT_PUSH_AUTH_FAILED');
    assert.equal(error.message, 'Repository authentication failed');
    assert.ok(!JSON.stringify(error).includes(token));
    return true;
  });
  assert.ok(!JSON.stringify(spawned).includes(token));
  assert.equal(cleaned, true);
});

test('agent push rejects non-canonical transports before spawning git', async () => {
  for (const repoUrl of [
    'ext::echo github.com',
    'file:///workspace/repository',
    'ssh://git@github.com/example/repository.git',
    'https://token@github.com/example/repository.git',
    'https://github.com.evil.invalid/example/repository.git',
  ]) {
    let spawned = false;
    await assert.rejects(
      pushGitHubBranch(
        { repoUrl, token: 'synthetic', branchName: 'branch', cwd: '/workspace/repository' },
        {
          createAskpass: async () => ({ env: {}, cleanup: async () => undefined }),
          spawnGit: () => {
            spawned = true;
            return fakeGitProcess();
          },
        },
      ),
    );
    assert.equal(spawned, false, repoUrl);
  }
});
