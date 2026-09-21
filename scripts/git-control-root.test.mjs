#!/usr/bin/env node
/** Integration coverage for worktree-safe OID control paths. */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import { commonGitDir, gitControlPath } from './git-control-root.mjs';

function run(cwd, args) {
    const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr || result.stdout);
}

function fixture(t) {
    const root = mkdtempSync(path.join(process.env.TMPDIR || '/var/tmp', 'git-control-root-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    run(root, ['init']);
    run(root, ['config', 'user.email', 'control@example.test']);
    run(root, ['config', 'user.name', 'Control Test']);
    writeFileSync(path.join(root, 'README.md'), 'fixture\n');
    run(root, ['add', 'README.md']);
    run(root, ['commit', '-m', 'fixture']);
    return root;
}

test('uses git-common-dir for a real linked worktree whose .git is a file', (t) => {
    const root = fixture(t);
    const worktree = path.join(path.dirname(root), `${path.basename(root)}-linked`);
    t.after(() => rmSync(worktree, { recursive: true, force: true }));
    run(root, ['worktree', 'add', '--detach', worktree]);
    const expected = spawnSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
        cwd: root, encoding: 'utf8',
    }).stdout.trim();
    assert.equal(commonGitDir(worktree), expected);
    assert.equal(gitControlPath(worktree, 'nassaj-preview-oid-control-request-v1.json'),
        path.join(expected, 'nassaj-preview-oid-control-request-v1.json'));
});

test('fails closed for a symlinked .git entry instead of following it', (t) => {
    const root = fixture(t);
    const forged = path.join(path.dirname(root), `${path.basename(root)}-forged`);
    t.after(() => rmSync(forged, { recursive: true, force: true }));
    run(path.dirname(root), ['init', forged]);
    rmSync(path.join(forged, '.git'), { recursive: true, force: true });
    symlinkSync(path.join(root, '.git'), path.join(forged, '.git'));
    assert.throws(() => commonGitDir(forged), /git_control_entry_unsafe/);
});

test('fails closed for unsafe control names', (t) => {
    const root = fixture(t);
    assert.throws(() => gitControlPath(root, '../outside'), /git_control_filename_unsafe/);
    assert.throws(() => gitControlPath(root, 'nassaj-../outside'), /git_control_filename_unsafe/);
});
