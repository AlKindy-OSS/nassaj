import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import test from 'node:test';

import { acquireLease, captureRequest, commitRequest } from '../../../scripts/session-commit-arbiter.mjs';

import {
  bindSessionWorkspace,
  createSessionWorkspace,
  logicalProjectPathForWorkspace,
  probeSessionWorkspaceAlias,
  reapSessionWorkspaces,
  readSessionFileBlob,
  resolveSessionWorkspace,
  resolveSessionWorkspaceForLaunch,
} from './session-workspace-overlay.js';

function git(repo, ...args) {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
}

function fixture() {
  const repo = fs.mkdtempSync(path.join('/var/tmp', 'nassaj-session-overlay-'));
  git(repo, 'init', '-b', 'main');
  git(repo, 'config', 'user.name', 'Overlay Test');
  git(repo, 'config', 'user.email', 'overlay@example.test');
  fs.writeFileSync(path.join(repo, 'shared.txt'), 'alpha\nmiddle\nomega\n');
  git(repo, 'add', 'shared.txt');
  git(repo, 'commit', '-m', 'chore: baseline');
  return repo;
}

function cleanup(repo) {
  try {
    git(repo, 'worktree', 'prune');
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
}

test('two new sessions do not observe each other writes to the same file', () => {
  const repo = fixture();
  try {
    const first = createSessionWorkspace({ projectPath: repo, launchKey: 'launch-a' });
    const second = createSessionWorkspace({ projectPath: repo, launchKey: 'launch-b' });
    fs.writeFileSync(path.join(first.cwd, 'shared.txt'), 'ALPHA\nmiddle\nomega\n');

    assert.equal(fs.readFileSync(path.join(second.cwd, 'shared.txt'), 'utf8'), 'alpha\nmiddle\nomega\n');
    assert.equal(fs.readFileSync(path.join(repo, 'shared.txt'), 'utf8'), 'alpha\nmiddle\nomega\n');
    assert.ok(first.cwd.startsWith(path.join(repo, '.git', 'nassaj-session-overlays')));
    assert.equal(logicalProjectPathForWorkspace(first.cwd), fs.realpathSync(repo));
  } finally {
    cleanup(repo);
  }
});

test('different hunks from isolated sessions merge through the arbiter', () => {
  const repo = fixture();
  try {
    const first = createSessionWorkspace({ projectPath: repo, launchKey: 'launch-a' });
    const second = createSessionWorkspace({ projectPath: repo, launchKey: 'launch-b' });
    fs.writeFileSync(path.join(first.cwd, 'shared.txt'), 'ALPHA\nmiddle\nomega\n');
    fs.writeFileSync(path.join(second.cwd, 'shared.txt'), 'alpha\nmiddle\nOMEGA\n');

    const leaseA = acquireLease({ repo, session: 'session-a', paths: ['shared.txt'] });
    const leaseB = acquireLease({ repo, session: 'session-b', paths: ['shared.txt'] });
    const requestA = captureRequest({
      repo,
      session: 'session-a',
      generation: leaseA.generation,
      submittedBlobs: [readSessionFileBlob(first, 'shared.txt')],
    });
    const requestB = captureRequest({
      repo,
      session: 'session-b',
      generation: leaseB.generation,
      submittedBlobs: [readSessionFileBlob(second, 'shared.txt')],
    });
    commitRequest({ repo, requestId: requestA.requestId, message: 'fix: merge first overlay hunk' });
    commitRequest({ repo, requestId: requestB.requestId, message: 'fix: merge second overlay hunk' });

    assert.equal(git(repo, 'show', 'HEAD:shared.txt'), 'ALPHA\nmiddle\nOMEGA');
  } finally {
    cleanup(repo);
  }
});

test('new sessions bind durably while unknown legacy sessions stay quarantined', () => {
  const repo = fixture();
  try {
    const created = resolveSessionWorkspace({ projectPath: repo, launchKey: 'launch-new' });
    const bound = bindSessionWorkspace({
      projectPath: repo,
      launchKey: 'launch-new',
      sessionId: 'provider-session-id',
    });
    const resumed = resolveSessionWorkspace({ projectPath: repo, sessionId: 'provider-session-id' });

    assert.equal(bound.cwd, created.cwd);
    assert.equal(resumed.cwd, created.cwd);
    assert.equal(resumed.logicalProjectPath, fs.realpathSync(repo));
    assert.throws(
      () => resolveSessionWorkspace({ projectPath: repo, sessionId: 'old-shared-session' }),
      /legacy session has no isolated workspace/,
    );
  } finally {
    cleanup(repo);
  }
});

test('launch resolver admits only migration-eligible sessions with a genuinely missing alias', () => {
  const repo = fixture();
  try {
    assert.throws(
      () => resolveSessionWorkspaceForLaunch({
        projectPath: repo, sessionId: 'post-cutover', legacyEligible: false,
      }),
      /no isolated workspace/,
    );
    const legacy = resolveSessionWorkspaceForLaunch({
      projectPath: repo, sessionId: 'pre-cutover', legacyEligible: true,
    });
    assert.equal(legacy.isolation, 'legacy_shared');
    assert.equal(legacy.cwd, fs.realpathSync(repo));
  } finally {
    cleanup(repo);
  }
});

test('migration-eligible non-repository sessions resume on their trusted legacy directory', () => {
  const project = fs.mkdtempSync(path.join('/var/tmp', 'nassaj-legacy-project-'));
  try {
    assert.equal(probeSessionWorkspaceAlias({
      projectPath: project,
      sessionId: 'legacy-non-repository',
    }), 'absent');
    assert.throws(() => resolveSessionWorkspaceForLaunch({
      projectPath: project,
      sessionId: 'post-cutover',
      legacyEligible: false,
    }), /no isolated workspace/);

    const resumed = resolveSessionWorkspaceForLaunch({
      projectPath: project,
      sessionId: 'legacy-non-repository',
      legacyEligible: true,
    });
    assert.equal(resumed.isolation, 'legacy_shared');
    assert.equal(resumed.logicalProjectPath, fs.realpathSync(project));
    assert.equal(resumed.cwd, fs.realpathSync(project));
  } finally {
    fs.rmSync(project, { recursive: true, force: true });
  }
});

test('new non-repository sessions use an explicit canonical shared binding', () => {
  const project = fs.mkdtempSync(path.join('/var/tmp', 'nassaj-new-shared-project-'));
  try {
    const launched = resolveSessionWorkspaceForLaunch({ projectPath: project });
    assert.equal(launched.isolation, 'legacy_shared');
    assert.equal(launched.logicalProjectPath, fs.realpathSync(project));
    assert.equal(launched.cwd, fs.realpathSync(project));
    assert.equal(launched.sessionId, null);
  } finally {
    fs.rmSync(project, { recursive: true, force: true });
  }
});

test('non-repository legacy fallback rejects final and parent symlink paths', () => {
  const root = fs.mkdtempSync(path.join('/var/tmp', 'nassaj-legacy-symlink-'));
  const physicalParent = path.join(root, 'physical-parent');
  const physicalProject = path.join(physicalParent, 'project');
  const finalAlias = path.join(root, 'project-alias');
  const parentAlias = path.join(root, 'parent-alias');
  fs.mkdirSync(physicalProject, { recursive: true });
  fs.symlinkSync(physicalProject, finalAlias, 'dir');
  fs.symlinkSync(physicalParent, parentAlias, 'dir');
  try {
    for (const [sessionId, projectPath] of [
      ['legacy-final-symlink', finalAlias],
      ['legacy-parent-symlink', path.join(parentAlias, 'project')],
    ]) {
      assert.equal(probeSessionWorkspaceAlias({ projectPath, sessionId }), 'present_invalid');
      assert.throws(() => resolveSessionWorkspaceForLaunch({
        projectPath,
        sessionId,
        legacyEligible: true,
      }), /canonical physical path/);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('an exact repository root keeps accepting an existing path alias', () => {
  const repo = fixture();
  const alias = `${repo}-alias`;
  fs.symlinkSync(repo, alias, 'dir');
  try {
    const resumed = resolveSessionWorkspaceForLaunch({
      projectPath: alias,
      sessionId: 'legacy-repository-alias',
      legacyEligible: true,
    });
    assert.equal(resumed.isolation, 'legacy_shared');
    assert.equal(resumed.cwd, fs.realpathSync(repo));
  } finally {
    fs.rmSync(alias, { force: true });
    cleanup(repo);
  }
});

test('a repository subdirectory launches and resumes only as an explicit shared workspace', () => {
  const repo = fixture();
  const subdirectory = path.join(repo, 'nested');
  fs.mkdirSync(subdirectory);
  try {
    assert.equal(probeSessionWorkspaceAlias({
      projectPath: subdirectory,
      sessionId: 'legacy-subdirectory',
    }), 'absent');
    const launched = resolveSessionWorkspaceForLaunch({ projectPath: subdirectory });
    assert.equal(launched.isolation, 'legacy_shared');
    assert.equal(launched.cwd, fs.realpathSync(subdirectory));
    const resumed = resolveSessionWorkspaceForLaunch({
      projectPath: subdirectory,
      sessionId: 'legacy-subdirectory',
      legacyEligible: true,
    });
    assert.equal(resumed.isolation, 'legacy_shared');
    assert.equal(resumed.cwd, fs.realpathSync(subdirectory));
  } finally {
    cleanup(repo);
  }
});

test('new shared launch rejects a symlink alias and a missing path', () => {
  const project = fs.mkdtempSync(path.join('/var/tmp', 'nassaj-new-shared-security-'));
  const alias = `${project}-alias`;
  fs.symlinkSync(project, alias, 'dir');
  try {
    assert.throws(
      () => resolveSessionWorkspaceForLaunch({ projectPath: alias }),
      /canonical physical path/,
    );
    assert.throws(
      () => resolveSessionWorkspaceForLaunch({ projectPath: path.join(project, 'missing') }),
      (error) => error?.code === 'ENOENT',
    );
  } finally {
    fs.rmSync(alias, { force: true });
    fs.rmSync(project, { recursive: true, force: true });
  }
});

test('unexpected Git probe errors are surfaced instead of becoming a legacy fallback', () => {
  const project = fs.mkdtempSync(path.join('/var/tmp', 'nassaj-invalid-git-project-'));
  fs.writeFileSync(path.join(project, '.git'), 'not-a-gitfile\n');
  try {
    assert.throws(() => probeSessionWorkspaceAlias({
      projectPath: project,
      sessionId: 'legacy-invalid-git',
    }), /git rev-parse --show-toplevel failed: fatal: invalid gitfile format/);
    assert.throws(() => resolveSessionWorkspaceForLaunch({
      projectPath: project,
      sessionId: 'legacy-invalid-git',
      legacyEligible: true,
    }), /git rev-parse --show-toplevel failed: fatal: invalid gitfile format/);
  } finally {
    fs.rmSync(project, { recursive: true, force: true });
  }
});

test('valid overlay takes precedence over legacy eligibility and malformed aliases fail closed', () => {
  const repo = fixture();
  try {
    const created = createSessionWorkspace({ projectPath: repo, launchKey: 'precedence' });
    bindSessionWorkspace({ projectPath: repo, launchKey: 'precedence', sessionId: 'bound' });
    const resumed = resolveSessionWorkspaceForLaunch({
      projectPath: repo, sessionId: 'bound', legacyEligible: true,
    });
    assert.equal(resumed.isolation, 'overlay');
    assert.equal(resumed.cwd, created.cwd);

    const aliasDir = path.join(repo, '.git', 'nassaj-session-overlays', 'aliases', 'session');
    const aliasesBefore = new Set(fs.readdirSync(aliasDir));
    // Resolve the digest filename without exporting implementation internals.
    assert.throws(() => resolveSessionWorkspaceForLaunch({
      projectPath: repo, sessionId: 'malformed', legacyEligible: false,
    }), /no isolated workspace/);
    const malformedName = `${crypto.createHash('sha256').update('malformed').digest('hex')}.json`;
    fs.writeFileSync(path.join(aliasDir, malformedName), '{"schema":1}');
    assert.equal(aliasesBefore.has(malformedName), false);
    assert.throws(() => resolveSessionWorkspaceForLaunch({
      projectPath: repo, sessionId: 'malformed', legacyEligible: true,
    }), /alias is malformed/);
  } finally {
    cleanup(repo);
  }
});

test('a dangling session alias symlink is corruption, never a legacy fallback', () => {
  const repo = fixture();
  try {
    // Create the trusted alias directory without creating this session alias.
    createSessionWorkspace({ projectPath: repo, launchKey: 'alias-directory' });
    const aliasDir = path.join(repo, '.git', 'nassaj-session-overlays', 'aliases', 'session');
    fs.mkdirSync(aliasDir, { recursive: true });
    const aliasName = `${crypto.createHash('sha256').update('dangling').digest('hex')}.json`;
    fs.symlinkSync(path.join(repo, 'does-not-exist.json'), path.join(aliasDir, aliasName));

    assert.throws(() => resolveSessionWorkspaceForLaunch({
      projectPath: repo,
      sessionId: 'dangling',
      legacyEligible: true,
    }), /alias is malformed/);
  } finally {
    cleanup(repo);
  }
});

test('a noncanonical traversal overlay id is rejected before path resolution', () => {
  const repo = fixture();
  try {
    createSessionWorkspace({ projectPath: repo, launchKey: 'traversal-directory' });
    const aliasDir = path.join(repo, '.git', 'nassaj-session-overlays', 'aliases', 'session');
    fs.mkdirSync(aliasDir, { recursive: true });
    const aliasName = `${crypto.createHash('sha256').update('traversal').digest('hex')}.json`;
    fs.writeFileSync(path.join(aliasDir, aliasName), JSON.stringify({
      schema: 1,
      overlayId: '../../../../outside',
    }));

    assert.throws(() => resolveSessionWorkspaceForLaunch({
      projectPath: repo,
      sessionId: 'traversal',
      legacyEligible: true,
    }), /alias is malformed/);
  } finally {
    cleanup(repo);
  }
});

test('an instance-directory symlink cannot redirect manifest resolution outside the state root', () => {
  const repo = fixture();
  const outside = fs.mkdtempSync(path.join('/var/tmp', 'nassaj-overlay-instance-outside-'));
  try {
    createSessionWorkspace({ projectPath: repo, launchKey: 'instance-symlink-directory' });
    const stateRoot = path.join(repo, '.git', 'nassaj-session-overlays');
    const aliasDir = path.join(stateRoot, 'aliases', 'session');
    const instancesDir = path.join(stateRoot, 'instances');
    fs.mkdirSync(aliasDir, { recursive: true });
    const overlayId = '11111111-1111-4111-8111-111111111111';
    const outsideWorkspace = path.join(outside, 'workspace');
    fs.mkdirSync(outsideWorkspace);
    fs.writeFileSync(path.join(outside, 'manifest.json'), JSON.stringify({
      schema: 1,
      overlayId,
      logicalProjectPath: fs.realpathSync(repo),
      repositoryRoot: fs.realpathSync(repo),
      cwd: outsideWorkspace,
      sessionId: 'instance-symlink',
      state: 'active',
      ownerPrincipalId: null,
    }));
    fs.symlinkSync(outside, path.join(instancesDir, overlayId));
    const aliasName = `${crypto.createHash('sha256').update('instance-symlink').digest('hex')}.json`;
    fs.writeFileSync(path.join(aliasDir, aliasName), JSON.stringify({ schema: 1, overlayId }));

    assert.throws(() => resolveSessionWorkspaceForLaunch({
      projectPath: repo,
      sessionId: 'instance-symlink',
      legacyEligible: true,
    }), /instance is malformed/);
  } finally {
    fs.rmSync(outside, { recursive: true, force: true });
    cleanup(repo);
  }
});

test('boot probe deny-fences corrupt aliases so deletion cannot revive legacy fallback', () => {
  const repo = fixture();
  try {
    createSessionWorkspace({ projectPath: repo, launchKey: 'corrupt-fence-directory' });
    const aliasDir = path.join(repo, '.git', 'nassaj-session-overlays', 'aliases', 'session');
    fs.mkdirSync(aliasDir, { recursive: true });
    const aliasName = `${crypto.createHash('sha256').update('corrupt-fence').digest('hex')}.json`;
    const aliasPath = path.join(aliasDir, aliasName);
    fs.writeFileSync(aliasPath, '{broken');

    assert.equal(probeSessionWorkspaceAlias({
      projectPath: repo, sessionId: 'corrupt-fence',
    }), 'present_invalid');
    // Boot reconciliation ratchets every present_* state to overlay.
    const ledgerMode = 'overlay';
    fs.rmSync(aliasPath);
    assert.equal(probeSessionWorkspaceAlias({
      projectPath: repo, sessionId: 'corrupt-fence',
    }), 'absent');
    assert.throws(() => resolveSessionWorkspaceForLaunch({
      projectPath: repo,
      sessionId: 'corrupt-fence',
      legacyEligible: ledgerMode === 'legacy_shared',
    }), /no isolated workspace/);
  } finally {
    cleanup(repo);
  }
});

test('reaper preserves bound sessions regardless of age', () => {
  const repo = fixture();
  try {
    const created = createSessionWorkspace({ projectPath: repo, launchKey: 'stale-launch' });
    const bound = bindSessionWorkspace({
      projectPath: repo,
      launchKey: 'stale-launch',
      sessionId: 'stale-session',
    });
    const requestRef = `refs/nassaj/requests/overlay-${created.overlayId}/1/request`;
    git(repo, 'update-ref', requestRef, 'HEAD');
    const reaped = reapSessionWorkspaces({
      projectPath: repo,
      maxAgeMs: 0,
      now: Date.now() + 1_000,
    });

    assert.deepEqual(reaped, []);
    assert.equal(fs.existsSync(bound.cwd), true);
    assert.equal(git(repo, 'for-each-ref', '--format=%(refname)', requestRef), requestRef);
    assert.equal(
      resolveSessionWorkspace({ projectPath: repo, sessionId: 'stale-session' }).cwd,
      bound.cwd,
    );
  } finally {
    cleanup(repo);
  }
});

test('project-auth path mapping ignores an untrusted lookalike manifest', () => {
  const repo = fixture();
  try {
    const fakeWorkspace = path.join(repo, 'ordinary', 'workspace');
    fs.mkdirSync(fakeWorkspace, { recursive: true });
    fs.writeFileSync(path.join(repo, 'ordinary', 'manifest.json'), JSON.stringify({
      schema: 1,
      overlayId: 'ordinary',
      cwd: fakeWorkspace,
      logicalProjectPath: '/untrusted/project',
    }));

    assert.equal(logicalProjectPathForWorkspace(fakeWorkspace), fakeWorkspace);
  } finally {
    cleanup(repo);
  }
});

test('patch capture rejects a new path beneath a symlinked overlay parent', () => {
  const repo = fixture();
  const outside = fs.mkdtempSync(path.join('/var/tmp', 'nassaj-overlay-outside-'));
  try {
    const binding = createSessionWorkspace({ projectPath: repo, launchKey: 'symlink-parent' });
    fs.writeFileSync(path.join(outside, 'new.txt'), 'escaped\n');
    fs.symlinkSync(outside, path.join(binding.cwd, 'escape'));

    assert.throws(
      () => readSessionFileBlob(binding, 'escape/new.txt'),
      /ELOOP|ENOTDIR/,
    );
  } finally {
    fs.rmSync(outside, { recursive: true, force: true });
    cleanup(repo);
  }
});

test('descriptor-anchored capture cannot be redirected by an adversarial parent symlink swap', () => {
  const repo = fixture();
  const outside = fs.mkdtempSync(path.join('/var/tmp', 'nassaj-overlay-swap-outside-'));
  try {
    const binding = createSessionWorkspace({ projectPath: repo, launchKey: 'symlink-swap' });
    const parent = path.join(binding.cwd, 'parent');
    fs.mkdirSync(parent);
    fs.writeFileSync(path.join(parent, 'value.txt'), 'inside overlay\n');
    fs.writeFileSync(path.join(outside, 'value.txt'), 'outside secret\n');

    const captured = readSessionFileBlob(binding, 'parent/value.txt', {
      beforeTargetOpen() {
        fs.renameSync(parent, `${parent}-held`);
        fs.symlinkSync(outside, parent);
      },
    });

    assert.equal(captured.body.toString('utf8'), 'inside overlay\n');
    assert.equal(captured.body.includes(Buffer.from('outside secret')), false);
  } finally {
    fs.rmSync(outside, { recursive: true, force: true });
    cleanup(repo);
  }
});
