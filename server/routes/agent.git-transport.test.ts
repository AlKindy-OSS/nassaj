import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';

import {
  applyCloneRetentionPolicy,
  cleanupClonedProject,
  cloneGitHubRepo,
  cloneGitHubRepoWithReceipt,
  pushGitHubBranch,
  reportScheduledCloneCleanupFailure,
} from './agent.js';

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

// node:test children report to the runner over stdout; the v24 parser misreads
// multibyte text that lands right after a serialized frame, so clone progress
// lines are captured through the injected logger instead of reaching stdout.
function captureCloneLog(lines: unknown[][]): (...args: unknown[]) => void {
  return (...args: unknown[]) => { lines.push(args); };
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
    const logged: unknown[][] = [];
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
      log: captureCloneLog(logged),
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
    assert.ok(logged.length > 0);
    assert.ok(!JSON.stringify(logged).includes(token));
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

async function writeMinimalGitRepo(directory: string, originUrl: string): Promise<void> {
  const gitDir = path.join(directory, '.git');
  await mkdir(path.join(gitDir, 'objects'), { recursive: true });
  await mkdir(path.join(gitDir, 'refs'), { recursive: true });
  await writeFile(path.join(gitDir, 'HEAD'), 'ref: refs/heads/main\n');
  await writeFile(
    path.join(gitDir, 'config'),
    `[core]\n\trepositoryformatversion = 0\n[remote "origin"]\n\turl = ${originUrl}\n`,
  );
}

test('agent clone reuses an existing checkout of the same repository without cloning', async () => {
  const root = await mkdtemp('/var/tmp/nassaj-agent-reuse-');
  try {
    const existing = path.join(root, 'repository');
    await writeMinimalGitRepo(existing, 'https://github.com/example/repository.git');
    const logged: unknown[][] = [];
    let askpassCreated = false;
    let spawnedClone = false;
    const dependencies = {
      createAskpass: async () => {
        askpassCreated = true;
        return { env: {}, cleanup: async () => undefined };
      },
      spawnGit: () => {
        spawnedClone = true;
        return fakeGitProcess();
      },
      log: captureCloneLog(logged),
    };

    const result = await cloneGitHubRepoWithReceipt(
      'https://github.com/example/repository',
      null,
      `${root}/nested/../repository`,
      dependencies,
    );
    assert.equal(result.projectPath, path.resolve(existing));
    assert.equal(result.creationReceipt, null);
    assert.equal(
      await cloneGitHubRepo('https://github.com/example/repository.git', null, existing, dependencies),
      path.resolve(existing),
    );
    assert.equal(spawnedClone, false);
    assert.equal(askpassCreated, false);
    assert.ok(logged.length > 0);
    await access(path.join(existing, '.git', 'config'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function createCloneReceipt(target: string) {
  const processHandle = fakeGitProcess();
  const spawnWaiter = createSpawnWaiter();
  const pending = cloneGitHubRepoWithReceipt(
    'https://github.com/example/repository.git',
    null,
    target,
    {
      createAskpass: async () => ({ env: {}, cleanup: async () => undefined }),
      spawnGit: () => {
        spawnWaiter.markSpawned();
        return processHandle;
      },
      log: captureCloneLog([]),
    },
  );
  await spawnWaiter.spawned;
  await mkdir(target, { recursive: true });
  closeFakeGitProcess(processHandle, 0);
  return pending;
}

async function createLegacyClone(target: string): Promise<{ path: string; retiredFd: number | null }> {
  const processHandle = fakeGitProcess();
  const spawnWaiter = createSpawnWaiter();
  let retiredFd: number | null = null;
  const pending = cloneGitHubRepo(
    'https://github.com/example/repository.git',
    null,
    target,
    {
      createAskpass: async () => ({ env: {}, cleanup: async () => undefined }),
      spawnGit: () => {
        spawnWaiter.markSpawned();
        return processHandle;
      },
      log: captureCloneLog([]),
      onCloneReceiptRetired: (receipt: { directoryHandle: { fd: number } }) => {
        retiredFd = receipt.directoryHandle.fd;
      },
    },
  );
  await spawnWaiter.spawned;
  await mkdir(target, { recursive: true });
  closeFakeGitProcess(processHandle, 0);
  return { path: await pending, retiredFd };
}

test('clone cleanup requires the exact server creation receipt for auto and custom targets', async () => {
  const root = await mkdtemp('/var/tmp/nassaj-agent-cleanup-');
  try {
    for (const target of [
      path.join(root, '.claude', 'external-projects', 'auto'),
      path.join(root, 'custom-clone'),
    ]) {
      const result = await createCloneReceipt(target);
      assert.equal(result.projectPath, path.resolve(target));
      assert.ok(result.creationReceipt);
      assert.equal(await applyCloneRetentionPolicy(result.creationReceipt, { cleanup: true }), 'removed');
      assert.equal(result.creationReceipt.directoryHandle.fd, -1);
      await assert.rejects(access(target), { code: 'ENOENT' });
    }

    const misleading = path.join(root, 'prefix.claude', 'external-projects-looking');
    await mkdir(misleading, { recursive: true });
    await assert.rejects(cleanupClonedProject({ projectPath: misleading }), {
      code: 'CLONE_CLEANUP_REFUSED',
    });
    await access(misleading);

    const replaced = path.join(root, 'replaced-clone');
    const replacedResult = await createCloneReceipt(replaced);
    await rm(replaced, { recursive: true, force: true });
    await mkdir(replaced);
    await assert.rejects(cleanupClonedProject(replacedResult.creationReceipt), {
      code: 'CLONE_CLEANUP_REFUSED',
    });
    assert.equal(replacedResult.creationReceipt.directoryHandle.fd, -1);
    await access(replaced);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('clone cleanup honors retention and reports removal failures truthfully', async () => {
  const root = await mkdtemp('/var/tmp/nassaj-agent-retention-');
  try {
    const target = path.join(root, 'retained-clone');
    const result = await createCloneReceipt(target);
    assert.equal(await applyCloneRetentionPolicy(result.creationReceipt, { cleanup: false }), 'retained');
    assert.equal(result.creationReceipt.directoryHandle.fd, -1);
    await access(target);

    const legacyTarget = path.join(root, 'legacy-retained-clone');
    const legacy = await createLegacyClone(legacyTarget);
    assert.equal(legacy.path, path.resolve(legacyTarget));
    assert.equal(legacy.retiredFd, -1);
    await access(legacyTarget);

    const failureTarget = path.join(root, 'failed-cleanup-clone');
    const failureResult = await createCloneReceipt(failureTarget);
    let recoveryPath = '';
    let retainedCleanupError: unknown;
    await assert.rejects(
      applyCloneRetentionPolicy(failureResult.creationReceipt, { cleanup: true }, {
        removeDirectory: async () => { throw new Error('synthetic rm failure'); },
      }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal((error as Error & { code?: string }).code, 'CLONE_CLEANUP_FAILED');
        recoveryPath = String((error as Error & { recoveryPath?: string }).recoveryPath ?? '');
        retainedCleanupError = error;
        return true;
      },
    );
    assert.equal(failureResult.creationReceipt.directoryHandle.fd, -1);
    await assert.rejects(access(failureTarget), { code: 'ENOENT' });
    await access(recoveryPath);
    await assert.rejects(
      applyCloneRetentionPolicy(failureResult.creationReceipt, { cleanup: true }),
      { code: 'CLONE_CLEANUP_REFUSED' },
    );
    const retainedDiagnostics: unknown[] = [];
    await reportScheduledCloneCleanupFailure(retainedCleanupError, (...args: unknown[]) => {
      retainedDiagnostics.push(...args);
    });
    assert.equal(retainedDiagnostics[0], '[agent] scheduled clone cleanup failed');
    assert.match((retainedDiagnostics[1] as { cleanupLocator: string }).cleanupLocator,
      /^\.nassaj-clone-cleanup-[a-zA-Z0-9]{6}$/);
    assert.equal(JSON.stringify(retainedDiagnostics).includes(root), false);

    const removedThenFailedTarget = path.join(root, 'removed-then-failed-clone');
    const removedThenFailed = await createCloneReceipt(removedThenFailedTarget);
    let removedCleanupError: unknown;
    await assert.rejects(
      applyCloneRetentionPolicy(removedThenFailed.creationReceipt, { cleanup: true }, {
        removeDirectory: async (targetPath: string, options: { recursive: boolean; force: boolean }) => {
          await rm(targetPath, options);
          throw new Error('synthetic late remove failure');
        },
      }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal((error as Error & { code?: string }).code, 'CLONE_CLEANUP_FAILED');
        assert.equal((error as Error & { recoveryPath?: string }).recoveryPath, undefined);
        removedCleanupError = error;
        return true;
      },
    );
    assert.equal(removedThenFailed.creationReceipt.directoryHandle.fd, -1);
    const removedDiagnostics: unknown[] = [];
    await reportScheduledCloneCleanupFailure(removedCleanupError, (...args: unknown[]) => {
      removedDiagnostics.push(...args);
    });
    assert.deepEqual(removedDiagnostics[1], { code: 'CLONE_CLEANUP_FAILED' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('atomic clone quarantine never deletes a replacement created before removal', async () => {
  const root = await mkdtemp('/var/tmp/nassaj-agent-cleanup-race-');
  try {
    const target = path.join(root, 'clone');
    const result = await createCloneReceipt(target);
    await writeFile(path.join(target, 'original.txt'), 'original');

    assert.equal(await applyCloneRetentionPolicy(result.creationReceipt, { cleanup: true }, {
      beforeRemove: async ({ originalPath }: { originalPath: string }) => {
        await mkdir(originalPath);
        await writeFile(path.join(originalPath, 'replacement.txt'), 'replacement');
      },
    }), 'removed');

    assert.equal(await readFile(path.join(target, 'replacement.txt'), 'utf8'), 'replacement');
    await assert.rejects(access(path.join(target, 'original.txt')), { code: 'ENOENT' });
    assert.equal(result.creationReceipt.directoryHandle.fd, -1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('atomic clone quarantine refuses a replacement swapped before rename', async () => {
  const root = await mkdtemp('/var/tmp/nassaj-agent-quarantine-race-');
  try {
    const target = path.join(root, 'clone');
    const result = await createCloneReceipt(target);
    let recoveryPath = '';
    await assert.rejects(
      applyCloneRetentionPolicy(result.creationReceipt, { cleanup: true }, {
        beforeQuarantine: async ({ originalPath }: { originalPath: string }) => {
          await rm(originalPath, { recursive: true, force: true });
          await mkdir(originalPath);
          await writeFile(path.join(originalPath, 'replacement.txt'), 'replacement');
        },
      }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal((error as Error & { code?: string }).code, 'CLONE_CLEANUP_REFUSED');
        recoveryPath = String((error as Error & { recoveryPath?: string }).recoveryPath ?? '');
        return true;
      },
    );

    await assert.rejects(access(target), { code: 'ENOENT' });
    assert.equal(await readFile(path.join(recoveryPath, 'replacement.txt'), 'utf8'), 'replacement');
    assert.equal(result.creationReceipt.directoryHandle.fd, -1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
