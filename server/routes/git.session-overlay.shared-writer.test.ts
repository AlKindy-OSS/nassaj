/**
 * ADR-173 P2 (M4, owner decision 4): the git surface of a shared conversation.
 *
 * Reads (status, diff) of the creator's overlay accept a shared writer. Submits
 * (commit, conflict resolve) stay with the creator, plus the project owner when
 * they are a shared writer of the session. Nobody else moves HEAD.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import test from 'node:test';

import { bindSessionWorkspace, createSessionWorkspace } from '@/modules/session-workspaces/index.js';

const {
  configureGitSharedWriterAccess, overlaySubmitAccess, requireGitReadWorkspace, submitSessionOverlay,
} = await import('./git.js');

const CREATOR = 7;
const WRITER = 8;
const PROJECT_OWNER = 9;
const SESSION = 'session-shared';

function git(repo: string, ...args: string[]): string {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
}

async function withCreatorOverlay(run: (repo: string, binding: { cwd: string; generation: string }) => Promise<void>) {
  const repo = fs.mkdtempSync(path.join('/var/tmp', 'nassaj-git-shared-writer-'));
  git(repo, 'init', '-b', 'main');
  git(repo, 'config', 'user.name', 'Git Shared Writer Test');
  git(repo, 'config', 'user.email', 'git-shared-writer@example.test');
  fs.writeFileSync(path.join(repo, 'shared.txt'), 'alpha\n');
  git(repo, 'add', 'shared.txt');
  git(repo, 'commit', '-m', 'chore: baseline');
  try {
    createSessionWorkspace({ projectPath: repo, launchKey: 'launch-shared', principalId: CREATOR });
    const binding = bindSessionWorkspace({
      projectPath: repo, launchKey: 'launch-shared', sessionId: SESSION, principalId: CREATOR,
    });
    fs.writeFileSync(path.join(binding.cwd, 'shared.txt'), 'ALPHA\n');
    await run(repo, binding);
  } finally {
    try {
      git(repo, 'worktree', 'prune');
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  }
}

const writers = new Set([WRITER, PROJECT_OWNER]);
const isWriter = (_sessionId: string, userId: number) => writers.has(userId);
/** Owner of the SESSION's own project (Low fix: never of a client-named project path). */
const isProjectOwner = (sessionId: string, userId: number) => sessionId === SESSION && userId === PROJECT_OWNER;

test('overlay read: a shared writer reads the creator overlay; others stay principal-bound', async () => {
  await withCreatorOverlay(async (repo, binding) => {
    const query = { sessionId: SESSION, generation: binding.generation };
    const read = requireGitReadWorkspace({ projectPath: repo, query, principalId: WRITER, isWriter });
    assert.equal(read?.cwd, binding.cwd);
    assert.throws(() => requireGitReadWorkspace({
      projectPath: repo, query, principalId: WRITER, isWriter: () => false,
    }), /principal mismatch/);
    assert.equal(requireGitReadWorkspace({ projectPath: repo, query, principalId: CREATOR, isWriter })?.cwd, binding.cwd);
  });
});

test('unconfigured ports fail closed; the composition-root ports drive the default path', async () => {
  await withCreatorOverlay(async (repo, binding) => {
    const query = { sessionId: SESSION, generation: binding.generation };
    assert.throws(() => requireGitReadWorkspace({ projectPath: repo, query, principalId: WRITER }), /principal mismatch/);
    assert.equal(overlaySubmitAccess(SESSION, PROJECT_OWNER), 'owner');
    configureGitSharedWriterAccess({ isWriter, isProjectOwner });
    try {
      assert.equal(requireGitReadWorkspace({ projectPath: repo, query, principalId: WRITER })?.cwd, binding.cwd);
      assert.equal(overlaySubmitAccess(SESSION, PROJECT_OWNER), 'session_writer');
    } finally {
      configureGitSharedWriterAccess({ isWriter: () => false, isProjectOwner: () => false });
    }
  });
});

test('overlay submit access: creator path, or project owner who is a shared writer', () => {
  const deps = { isWriter, isProjectOwner };
  assert.equal(overlaySubmitAccess(SESSION, WRITER, deps), 'owner', 'a plain writer stays principal-bound');
  assert.equal(overlaySubmitAccess(SESSION, PROJECT_OWNER, deps), 'session_writer');
  assert.equal(overlaySubmitAccess(SESSION, PROJECT_OWNER, { ...deps, isWriter: () => false }), 'owner',
    'project ownership alone does not reach another member\'s overlay');
  const asked: unknown[] = [];
  overlaySubmitAccess(SESSION, PROJECT_OWNER, { isWriter, isProjectOwner: (...args: unknown[]) => { asked.push(args); return false; } });
  assert.deepEqual(asked, [[SESSION, PROJECT_OWNER]], 'project ownership is asked for the session, not a client path');
});

test('overlay submit: a non-owner writer is refused before HEAD moves; the project owner commits', async () => {
  await withCreatorOverlay(async (repo, binding) => {
    const before = git(repo, 'rev-parse', 'HEAD');
    const submit = (principalId: number) => submitSessionOverlay({
      repositoryRootPath: repo, projectPath: repo, repositoryRelativeFilePaths: ['shared.txt'],
      sessionId: SESSION, generation: binding.generation, principalId,
      access: overlaySubmitAccess(SESSION, principalId, { isWriter, isProjectOwner }),
      message: 'fix: commit from a shared conversation', dispatchPreview: async () => ({ queued: true }),
    });
    await assert.rejects(submit(WRITER), /principal mismatch/);
    assert.equal(git(repo, 'rev-parse', 'HEAD'), before);
    const result = await submit(PROJECT_OWNER);
    assert.equal(git(repo, 'show', `${result.commit}:shared.txt`), 'ALPHA');
  });
});
