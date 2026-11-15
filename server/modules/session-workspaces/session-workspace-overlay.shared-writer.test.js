/**
 * ADR-173 P2: the overlay resolvers accept access 'session_writer', which skips
 * ONLY the owner-principal equality. Creation, binding and rebinding stay
 * creator-only, and a writer is never admitted to an overlay whose creator
 * cannot be determined (qa-critic condition 4).
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import test from 'node:test';

import {
  bindSessionWorkspace,
  createSessionWorkspace,
  requireBoundSessionWorkspace,
  resolveSessionWorkspace,
  resolveSessionWorkspaceForLaunch,
} from './session-workspace-overlay.js';

const CREATOR = 1;
const WRITER = 2;

function git(repo, ...args) {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
}

function fixture() {
  const repo = fs.mkdtempSync(path.join('/var/tmp', 'nassaj-overlay-shared-writer-'));
  git(repo, 'init', '-b', 'main');
  git(repo, 'config', 'user.name', 'Overlay Shared Writer Test');
  git(repo, 'config', 'user.email', 'overlay-shared-writer@example.test');
  fs.writeFileSync(path.join(repo, 'shared.txt'), 'alpha\n');
  git(repo, 'add', 'shared.txt');
  git(repo, 'commit', '-m', 'chore: baseline');
  return repo;
}

function withRepo(run) {
  const repo = fixture();
  try {
    run(repo);
  } finally {
    try {
      git(repo, 'worktree', 'prune');
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  }
}

function bound(repo, sessionId, principalId = CREATOR) {
  createSessionWorkspace({ projectPath: repo, launchKey: `launch-${sessionId}`, principalId });
  return bindSessionWorkspace({ projectPath: repo, launchKey: `launch-${sessionId}`, sessionId, principalId });
}

test('launch resolver: owner access still refuses another principal', () => {
  withRepo((repo) => {
    bound(repo, 'sess-owner');
    assert.throws(() => resolveSessionWorkspaceForLaunch({
      projectPath: repo, sessionId: 'sess-owner', principalId: WRITER,
    }), /principal mismatch/);
  });
});

test('launch resolver: session_writer access resumes the creator overlay and flags the writer', () => {
  withRepo((repo) => {
    const creatorBinding = bound(repo, 'sess-writer');
    const writer = resolveSessionWorkspaceForLaunch({
      projectPath: repo, sessionId: 'sess-writer', principalId: WRITER, access: 'session_writer',
    });
    assert.equal(writer.cwd, creatorBinding.cwd);
    assert.equal(writer.overlayId, creatorBinding.overlayId);
    assert.equal(writer.sharedWriter, true);
    const creator = resolveSessionWorkspaceForLaunch({
      projectPath: repo, sessionId: 'sess-writer', principalId: CREATOR, access: 'session_writer',
    });
    assert.equal(creator.sharedWriter, false, 'the creator is never a shared writer of its own overlay');
  });
});

test('owner access keeps the public binding shape unchanged', () => {
  withRepo((repo) => {
    bound(repo, 'sess-shape');
    const binding = resolveSessionWorkspaceForLaunch({
      projectPath: repo, sessionId: 'sess-shape', principalId: CREATOR,
    });
    assert.equal('sharedWriter' in binding, false);
  });
});

test('session_writer refuses an overlay whose creator cannot be determined (condition 4)', () => {
  withRepo((repo) => {
    bound(repo, 'sess-ownerless', null);
    assert.throws(() => resolveSessionWorkspaceForLaunch({
      projectPath: repo, sessionId: 'sess-ownerless', principalId: WRITER, access: 'session_writer',
    }), /creator is undeterminable/);
    assert.throws(() => resolveSessionWorkspace({
      projectPath: repo, sessionId: 'sess-ownerless', principalId: WRITER, access: 'session_writer',
    }), /creator is undeterminable/);
  });
});

test('session_writer requires an identified writer', () => {
  withRepo((repo) => {
    bound(repo, 'sess-anon');
    assert.throws(() => resolveSessionWorkspaceForLaunch({
      projectPath: repo, sessionId: 'sess-anon', principalId: null, access: 'session_writer',
    }), /shared writer must be identified/);
  });
});

test('an unknown access value is refused', () => {
  withRepo((repo) => {
    bound(repo, 'sess-access');
    assert.throws(() => resolveSessionWorkspaceForLaunch({
      projectPath: repo, sessionId: 'sess-access', principalId: CREATOR, access: 'admin',
    }), /invalid overlay access/);
  });
});

test('generation-bound resolver accepts a session writer; owner access stays strict', () => {
  withRepo((repo) => {
    const creatorBinding = bound(repo, 'sess-bound');
    const input = { projectPath: repo, sessionId: 'sess-bound', generation: creatorBinding.generation };
    assert.throws(() => requireBoundSessionWorkspace({ ...input, principalId: WRITER }), /principal mismatch/);
    const writer = requireBoundSessionWorkspace({ ...input, principalId: WRITER, access: 'session_writer' });
    assert.equal(writer.cwd, creatorBinding.cwd);
    assert.equal(writer.sharedWriter, true);
  });
});

test('a new launch never takes the session_writer path; create and bind stay creator-only', () => {
  withRepo((repo) => {
    createSessionWorkspace({ projectPath: repo, launchKey: 'launch-strict', principalId: CREATOR });
    assert.throws(() => createSessionWorkspace({
      projectPath: repo, launchKey: 'launch-strict', principalId: WRITER,
    }), /another principal/);
    assert.throws(() => bindSessionWorkspace({
      projectPath: repo, launchKey: 'launch-strict', sessionId: 'sess-strict', principalId: WRITER,
    }), /principal mismatch/);
    const fresh = resolveSessionWorkspaceForLaunch({
      projectPath: repo, launchKey: 'launch-fresh', principalId: WRITER, access: 'session_writer',
    });
    assert.equal('sharedWriter' in fresh, false, 'no resumed session, no shared writer');
  });
});
