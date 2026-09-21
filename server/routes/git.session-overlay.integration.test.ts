import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import test from 'node:test';

import {
  bindSessionWorkspace,
  createSessionWorkspace,
} from '@/modules/session-workspaces/index.js';

const { resolveSessionOverlayConflict, submitSessionOverlay } = await import('./git.js');

function git(repo: string, ...args: string[]): string {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
}

function fixture(): string {
  const repo = fs.mkdtempSync(path.join('/var/tmp', 'nassaj-overlay-submit-'));
  git(repo, 'init', '-b', 'main');
  git(repo, 'config', 'user.name', 'Overlay Submit Test');
  git(repo, 'config', 'user.email', 'overlay-submit@example.test');
  fs.writeFileSync(path.join(repo, 'shared.txt'), 'alpha\nmiddle\nomega\n');
  fs.writeFileSync(path.join(repo, 'delete.txt'), 'delete me\n');
  fs.writeFileSync(path.join(repo, 'old-name.txt'), 'rename me\n');
  git(repo, 'add', 'shared.txt', 'delete.txt', 'old-name.txt');
  git(repo, 'commit', '-m', 'chore: baseline');
  return repo;
}

function cleanup(repo: string): void {
  fs.rmSync(repo, { recursive: true, force: true });
}

function overlay(repo: string, launchKey: string, sessionId: string, principalId = 7) {
  const created = createSessionWorkspace({ projectPath: repo, launchKey, principalId });
  return bindSessionWorkspace({ projectPath: repo, launchKey, sessionId, principalId });
}

const noPreview = async () => ({ queued: true });

test('two production overlay submits merge different hunks of the same file', async () => {
  const repo = fixture();
  try {
    const first = overlay(repo, 'launch-a', 'session-a');
    const second = overlay(repo, 'launch-b', 'session-b');
    fs.writeFileSync(path.join(first.cwd, 'shared.txt'), 'ALPHA\nmiddle\nomega\n');
    fs.writeFileSync(path.join(second.cwd, 'shared.txt'), 'alpha\nmiddle\nOMEGA\n');

    const resultA = await submitSessionOverlay({
      repositoryRootPath: repo,
      projectPath: repo,
      repositoryRelativeFilePaths: ['shared.txt'],
      sessionId: 'session-a',
      generation: first.generation,
      principalId: 7,
      message: 'fix: submit first isolated hunk',
      dispatchPreview: noPreview,
    });
    const resultB = await submitSessionOverlay({
      repositoryRootPath: repo,
      projectPath: repo,
      repositoryRelativeFilePaths: ['shared.txt'],
      sessionId: 'session-b',
      generation: second.generation,
      principalId: 7,
      message: 'fix: submit second isolated hunk',
      dispatchPreview: noPreview,
    });

    assert.notEqual(resultA.commit, resultB.commit);
    assert.equal(git(repo, 'show', 'HEAD:shared.txt'), 'ALPHA\nmiddle\nOMEGA');
  } finally {
    cleanup(repo);
  }
});

test('one production submit atomically captures add, delete, and both rename sides', async () => {
  const repo = fixture();
  try {
    const binding = overlay(repo, 'launch-multi', 'session-multi');
    fs.writeFileSync(path.join(binding.cwd, 'added.txt'), 'added\n');
    fs.rmSync(path.join(binding.cwd, 'delete.txt'));
    fs.renameSync(path.join(binding.cwd, 'old-name.txt'), path.join(binding.cwd, 'new-name.txt'));

    const before = git(repo, 'rev-parse', 'HEAD');
    const result = await submitSessionOverlay({
      repositoryRootPath: repo,
      projectPath: repo,
      repositoryRelativeFilePaths: [
        'added.txt', 'delete.txt', 'old-name.txt', 'new-name.txt',
      ],
      renames: [{ from: 'old-name.txt', to: 'new-name.txt' }],
      sessionId: 'session-multi',
      generation: binding.generation,
      principalId: 7,
      message: 'feat: submit isolated file set atomically',
      dispatchPreview: noPreview,
    });

    assert.equal(git(repo, 'rev-parse', `${result.commit}^`), before);
    assert.equal(git(repo, 'show', `${result.commit}:added.txt`), 'added');
    assert.equal(git(repo, 'show', `${result.commit}:new-name.txt`), 'rename me');
    assert.equal(git(repo, 'ls-tree', '--name-only', result.commit, 'delete.txt'), '');
    assert.equal(git(repo, 'ls-tree', '--name-only', result.commit, 'old-name.txt'), '');
  } finally {
    cleanup(repo);
  }
});

test('production submit rejects a spoofed principal or generation before HEAD moves', async () => {
  const repo = fixture();
  try {
    const binding = overlay(repo, 'launch-owner', 'session-owner');
    fs.writeFileSync(path.join(binding.cwd, 'shared.txt'), 'OWNER\nmiddle\nomega\n');
    const before = git(repo, 'rev-parse', 'HEAD');
    const submit = (principalId: number, generation: string) => submitSessionOverlay({
      repositoryRootPath: repo,
      projectPath: repo,
      repositoryRelativeFilePaths: ['shared.txt'],
      sessionId: 'session-owner',
      generation,
      principalId,
      message: 'fix: reject spoofed overlay submit',
      dispatchPreview: noPreview,
    });

    await assert.rejects(submit(8, binding.generation), /principal mismatch/);
    await assert.rejects(submit(7, 'wrong-generation'), /stale overlay generation/);
    assert.equal(git(repo, 'rev-parse', 'HEAD'), before);
  } finally {
    cleanup(repo);
  }
});

test('conflict metadata resolves only by re-capturing the same fenced overlay', async () => {
  const repo = fixture();
  try {
    const first = overlay(repo, 'launch-conflict-a', 'session-conflict-a');
    const second = overlay(repo, 'launch-conflict-b', 'session-conflict-b');
    fs.writeFileSync(path.join(first.cwd, 'shared.txt'), 'FIRST\nmiddle\nomega\n');
    fs.writeFileSync(path.join(second.cwd, 'shared.txt'), 'SECOND\nmiddle\nomega\n');
    await submitSessionOverlay({
      repositoryRootPath: repo, projectPath: repo,
      repositoryRelativeFilePaths: ['shared.txt'],
      sessionId: 'session-conflict-a', generation: first.generation, principalId: 7,
      message: 'fix: create overlay conflict base', dispatchPreview: noPreview,
    });

    let conflict: Record<string, unknown> | null = null;
    try {
      await submitSessionOverlay({
        repositoryRootPath: repo, projectPath: repo,
        repositoryRelativeFilePaths: ['shared.txt'],
        sessionId: 'session-conflict-b', generation: second.generation, principalId: 7,
        message: 'fix: create competing overlay conflict', dispatchPreview: noPreview,
      });
      assert.fail('expected owned-path conflict');
    } catch (error) {
      conflict = (error as { commitConflict?: Record<string, unknown> }).commitConflict ?? null;
    }
    assert.equal(conflict?.sessionId, 'session-conflict-b');
    assert.equal(conflict?.generation, second.generation);

    fs.writeFileSync(path.join(second.cwd, 'shared.txt'), 'FIRST\nmiddle\nRESOLVED\n');
    await assert.rejects(
      resolveSessionOverlayConflict({
        repositoryRootPath: repo, projectPath: repo,
        requestId: String(conflict?.requestId),
        sessionId: 'session-conflict-a', generation: first.generation, principalId: 7,
        message: 'fix: reject mismatched conflict overlay', dispatchPreview: noPreview,
      }),
      /session overlay conflict mismatch/,
    );
    const resolved = await resolveSessionOverlayConflict({
      repositoryRootPath: repo, projectPath: repo,
      requestId: String(conflict?.requestId),
      sessionId: 'session-conflict-b', generation: second.generation, principalId: 7,
      message: 'fix: resolve from same isolated overlay', dispatchPreview: noPreview,
    });
    assert.equal(git(repo, 'show', `${resolved.commit}:shared.txt`), 'FIRST\nmiddle\nRESOLVED');
  } finally {
    cleanup(repo);
  }
});
