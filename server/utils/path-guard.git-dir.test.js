/**
 * B-1691 — the project file API never reads or writes inside a `.git` directory.
 *
 * REAL guards on a REAL temp filesystem: resolveReadPathInProject (GET /file,
 * GET /files/content) and the REAL validatePathInProject extracted from
 * index.js (PUT /file, create, rename, delete, upload, upload-attachments).
 * Pinned contract:
 *   - a path with a segment `.git` below the effective root is refused, case-
 *     insensitively and with trailing dots/spaces folded, lexically and after
 *     following symlinks, with the out-of-root message and before any existence
 *     check;
 *   - `.gitignore`, `.gitattributes`, `.github/`, `.gitmodules`, `.gitkeep` and
 *     normal files are untouched;
 *   - a session overlay (kept under `<root>/.git/...`) is reachable only with the
 *     overlay itself as root, never through the project root;
 *   - without `refuseGitDir` the mutate guard keeps its old behaviour;
 *   - an escape outside the root is not logged as a git path (qa F6).
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { after, before } from 'node:test';

import { isGitDirSegment, isResolvedPathInsideRootReal, resolveReadPathInProject } from './path-guard.js';

const INDEX_SOURCE = fs.readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'index.js'),
  'utf8',
);

/** The REAL validatePathInProject from index.js, bound to the real guard. */
function extractValidatePathInProject() {
  const signature = 'function validatePathInProject(projectRoot, targetPath, { trustedOverlayRoot = false } = {}) ';
  const at = INDEX_SOURCE.indexOf(signature);
  assert.notEqual(at, -1, 'validatePathInProject not found in index.js');
  const start = INDEX_SOURCE.indexOf('{', at + signature.length);
  let depth = 0;
  let end = start;
  for (; end < INDEX_SOURCE.length; end++) {
    if (INDEX_SOURCE[end] === '{') depth++;
    else if (INDEX_SOURCE[end] === '}' && --depth === 0) break;
  }
  const source = `${signature}${INDEX_SOURCE.slice(start, end + 1)}`;
  return new Function('path', 'isResolvedPathInsideRootReal', `return ${source};`)(
    path, isResolvedPathInsideRootReal,
  );
}

const validatePathInProject = extractValidatePathInProject();
const REFUSAL = 'Path must be under project root';
const OVERLAY_ID = '11111111-2222-4333-8444-555555555555';
let sandbox = '';
let root = '';
let overlay = '';
let warnings = [];
const originalWarn = console.warn;

before(() => {
  sandbox = fs.realpathSync(fs.mkdtempSync(path.join('/var/tmp', 'pg-git-dir-')));
  root = path.join(sandbox, 'app');
  overlay = path.join(root, '.git', 'nassaj-session-overlays', 'instances', OVERLAY_ID, 'workspace');
  const files = {
    '.git/config': '[core]\n',
    '.git/hooks/pre-commit': '#!/bin/sh\n',
    'sub/.git/config': '[core]\n',
    '.GIT/config': '[core]\n',
    '.gitignore': 'node_modules\n',
    '.gitattributes': '* text=auto\n',
    '.github/workflows/x.yml': 'on: push\n',
    'src/app.js': 'inside\n',
  };
  for (const [relative, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
    fs.writeFileSync(path.join(root, relative), content);
  }
  fs.mkdirSync(overlay, { recursive: true });
  fs.writeFileSync(path.join(overlay, 'README.md'), 'overlay readme');
  fs.writeFileSync(path.join(overlay, '.git'), 'gitdir: /elsewhere\n');
  fs.symlinkSync(path.join(root, '.git'), path.join(root, 'gitlink'));
  fs.symlinkSync(path.join(root, '.git', 'hooks', 'pre-commit'), path.join(root, 'hooklink'));
  console.warn = (...args) => { warnings.push(args); };
});

after(() => {
  console.warn = originalWarn;
  if (sandbox) fs.rmSync(sandbox, { recursive: true, force: true });
});

const REFUSED = [
  '.git/config', '.git/hooks/pre-commit', 'sub/.git/config', '.GIT/config',
  'gitlink/config', 'hooklink', '.git/does-not-exist',
];
const ALLOWED = ['.gitignore', '.gitattributes', '.github/workflows/x.yml', 'src/app.js'];

test('isGitDirSegment matches only a .git directory name', () => {
  for (const name of ['.git', '.GIT', '.Git', '.git.', '.git ', '.git. ']) {
    assert.equal(isGitDirSegment(name), true, name);
  }
  for (const name of ['.gitignore', '.github', '.gitattributes', '.gitmodules', '.gitkeep', 'git', '.git2', 'x.git']) {
    assert.equal(isGitDirSegment(name), false, name);
  }
});

test('reads inside .git are refused like an out-of-root path, before any existence check', async () => {
  warnings = [];
  for (const requested of REFUSED) {
    const guard = await resolveReadPathInProject(root, requested);
    assert.deepEqual({ ...guard }, { valid: false, code: 'GIT_DIR', error: REFUSAL }, requested);
  }
  const absolute = await resolveReadPathInProject(root, path.join(root, '.git', 'config'));
  assert.equal(absolute.code, 'GIT_DIR');
  assert.equal(warnings.length, REFUSED.length + 1, 'one log line per refusal');
  const logged = JSON.stringify(warnings);
  assert.equal(logged.includes('project_file_git_dir_refused'), true);
  assert.equal(logged.includes('[core]') || logged.includes('#!/bin/sh'), false, 'never the content');
});

test('writes inside .git are refused, including new files and folded name variants', () => {
  const targets = [
    ...REFUSED, '.git/hooks/post-checkout', '.git./x', '.git /x', 'gitlink/hooks/post-merge',
    'gitlink/new-dir/x', path.join(root, '.git', 'config'),
  ];
  for (const target of targets) {
    assert.deepEqual(validatePathInProject(root, target), { valid: false, error: REFUSAL }, target);
  }
  assert.equal(fs.existsSync(path.join(root, '.git', 'hooks', 'post-checkout')), false);
});

test('.gitignore, .gitattributes, .github and normal files stay readable and writable', async () => {
  for (const requested of ALLOWED) {
    assert.equal((await resolveReadPathInProject(root, requested)).valid, true, requested);
    assert.equal(validatePathInProject(root, requested).valid, true, requested);
  }
  for (const created of ['.gitmodules', '.gitkeep', 'src/new.js', '.github/workflows/new.yml']) {
    assert.equal(validatePathInProject(root, created).valid, true, created);
  }
});

test('a session overlay is reachable only as a trusted overlay root', async () => {
  const viaRoot = path.join(overlay, 'README.md');
  assert.equal((await resolveReadPathInProject(root, viaRoot)).code, 'GIT_DIR', 'no sessionId: refused');
  assert.equal(validatePathInProject(root, viaRoot).valid, false);

  const trusted = { trustedOverlayRoot: true };
  assert.equal((await resolveReadPathInProject(overlay, 'README.md', trusted)).valid, true);
  assert.equal((await resolveReadPathInProject(overlay, viaRoot, trusted)).valid, true, 'absolute path into this overlay');
  assert.equal(validatePathInProject(overlay, 'README.md', trusted).valid, true);
  assert.equal((await resolveReadPathInProject(overlay, '.git', trusted)).code, 'GIT_DIR', "the worktree's gitdir file");
  assert.equal(validatePathInProject(overlay, '.git', trusted).valid, false);
});

test('without refuseGitDir the mutate guard is unchanged', () => {
  assert.equal(isResolvedPathInsideRootReal(root, path.join(root, '.git', 'config')), true);
});

test('qa F6: an escape outside the root is refused but not logged as a git path', () => {
  warnings = [];
  const escape = path.join(root, '..', 'elsewhere', '.git', 'config');
  assert.equal(isResolvedPathInsideRootReal(root, escape, { refuseGitDir: true }), false);
  assert.deepEqual(validatePathInProject(root, escape), { valid: false, error: REFUSAL });
  assert.deepEqual(warnings, []);
});

test('qa F8: a root inside .git is refused unless the caller marks a trusted overlay', async () => {
  warnings = [];
  const legacy = path.join(root, '.git');
  assert.equal((await resolveReadPathInProject(legacy, 'config')).code, 'GIT_DIR');
  assert.equal(validatePathInProject(legacy, 'hooks/pre-commit').valid, false);
  assert.equal(validatePathInProject(legacy, 'config').valid, false);
  assert.equal((await resolveReadPathInProject(overlay, 'README.md', { trustedOverlayRoot: false })).code, 'GIT_DIR');
  assert.equal(validatePathInProject(overlay, 'README.md').valid, false, 'shape alone never exempts');
  assert.equal(
    (await resolveReadPathInProject(path.join(root, 'gitlink'), 'config')).code, 'GIT_DIR', 'symlinked root',
  );
  assert.equal(JSON.stringify(warnings).includes('project_root_git_dir_refused'), true);
});
