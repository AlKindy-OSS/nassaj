/**
 * B-1592: the commit view never renders secret files from history.
 *
 * Real repositories under /var/tmp, driven through the router's spawnAsync so
 * GIT_LITERAL_PATHSPECS=1 is set exactly as in production.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { spawnAsync } from '../routes/git.js';
import {
  HIDDEN_SECRET_FILE_MARKER,
  readCommitDiffWithoutSecrets,
  redactSecretDiffSections,
} from './commit-diff-redaction.js';

const SECRET = 'JWT_SECRET=s3cret-history';

/** Fresh repository with a helper that writes files and commits them. */
function scratchRepo(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join('/var/tmp', 'commit-diff-redaction-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...args],
    { cwd: root, encoding: 'utf8', env: { ...process.env, GIT_LITERAL_PATHSPECS: '0' } });
  git('init', '-q');
  const write = (relative, content) => {
    fs.mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
    fs.writeFileSync(path.join(root, relative), content);
  };
  const commit = (message) => {
    git('add', '-A');
    git('commit', '-q', '-m', message);
    return git('rev-parse', 'HEAD').trim();
  };
  return { root, git, write, commit };
}

/** The route's call shape: peeled ref, cwd may be a sub-directory. */
function render(root, ref, cwd = root) {
  return readCommitDiffWithoutSecrets({
    runGit: (args) => spawnAsync('git', args, { cwd }),
    repositoryRootPath: root,
    commitRef: `${ref}^{commit}`,
  });
}

test('a committed .env never shows its content; other files still do', async (t) => {
  const repo = scratchRepo(t);
  repo.write('.env', `${SECRET}\n`);
  repo.write('config/app.env', `${SECRET}\n`);
  repo.write('data/app.sqlite', 'not really sqlite\n');
  repo.write('weird name)/.env.local', `${SECRET}\n`);
  repo.write('.env.example', 'JWT_SECRET=\n');
  repo.write('src/a.ts', 'export const a = 1;\n');
  const added = repo.commit('add files');

  const diff = await render(repo.root, added);
  assert.equal(diff.includes('s3cret-history'), false, diff);
  assert.equal(diff.includes('not really sqlite'), false);
  assert.match(diff, /export const a = 1;/);
  assert.match(diff, /JWT_SECRET=\n/, 'the public template stays visible');
  assert.match(diff, /add files/, 'the commit message is kept');
  for (const hidden of ['.env', 'config/app.env', 'data/app.sqlite', 'weird name)/.env.local']) {
    assert.ok(diff.includes(`diff --git a/${hidden} b/${hidden}\n${HIDDEN_SECRET_FILE_MARKER}`), hidden);
  }
});

test('a .env committed then deleted stays hidden in the deleting commit', async (t) => {
  const repo = scratchRepo(t);
  repo.write('.env', `${SECRET}\n`);
  repo.commit('add env');
  fs.rmSync(path.join(repo.root, '.env'));
  const deleted = repo.commit('remove env');

  const diff = await render(repo.root, deleted);
  assert.equal(diff.includes('s3cret-history'), false, diff);
  assert.match(diff, /remove env/, 'header is shown even when every change is hidden');
  assert.ok(diff.includes(`diff --git a/.env b/.env\n${HIDDEN_SECRET_FILE_MARKER}`));
});

test('a rename touching a secret name hides both sides', async (t) => {
  const repo = scratchRepo(t);
  repo.write('notes.txt', `${SECRET}\n`);
  repo.commit('add notes');
  repo.git('mv', 'notes.txt', '.env');
  const intoEnv = await render(repo.root, repo.commit('rename to env'));
  for (const hidden of ['.env', 'notes.txt']) {
    assert.ok(intoEnv.includes(`diff --git a/${hidden} b/${hidden}\n${HIDDEN_SECRET_FILE_MARKER}`), hidden);
  }
  assert.equal(intoEnv.includes('s3cret-history'), false, intoEnv);

  repo.git('mv', '.env', 'readme-copy.txt');
  const outOfEnv = await render(repo.root, repo.commit('rename env away'));
  assert.equal(outOfEnv.includes('s3cret-history'), false, 'the renamed copy shows no content');
  assert.ok(outOfEnv.includes(`diff --git a/readme-copy.txt b/readme-copy.txt\n${HIDDEN_SECRET_FILE_MARKER}`));
});

test('diff.relative, color.ui=always and custom prefixes cannot bypass the redaction', async (t) => {
  const repo = scratchRepo(t);
  for (const [key, value] of [['diff.relative', 'true'], ['color.ui', 'always'], ['diff.noprefix', 'true'],
    ['diff.mnemonicPrefix', 'true'], ['color.diff', 'always']]) {
    repo.git('config', key, value);
  }
  repo.write('app/.env', `${SECRET}\n`);
  repo.write('.env', `${SECRET}\n`);
  repo.write('app/index.js', 'console.log(2);\n');
  const added = repo.commit('configured repo');
  const diff = await render(repo.root, added, path.join(repo.root, 'app'));
  assert.equal(diff.includes('s3cret-history'), false, diff);
  assert.equal(diff.includes('\x1b['), false, 'no colour codes reach the client');
  assert.match(diff, /console\.log\(2\)/);
  assert.ok(diff.includes(`diff --git a/app/.env b/app/.env\n${HIDDEN_SECRET_FILE_MARKER}`));
});

test('rendering from a project sub-directory still hides root-relative secrets', async (t) => {
  const repo = scratchRepo(t);
  repo.write('app/.env', `${SECRET}\n`);
  repo.write('app/index.js', 'console.log(1);\n');
  const added = repo.commit('nested');
  const diff = await render(repo.root, added, path.join(repo.root, 'app'));
  assert.equal(diff.includes('s3cret-history'), false, diff);
  assert.match(diff, /console\.log\(1\)/);
});

test('merge commits hide secret files in the combined diff', async (t) => {
  const repo = scratchRepo(t);
  repo.write('.env', 'A=1\n');
  repo.write('readme.md', 'base\n');
  repo.commit('base');
  const base = repo.git('rev-parse', '--abbrev-ref', 'HEAD').trim();
  repo.git('checkout', '-q', '-b', 'side');
  repo.write('.env', 'A=side\n');
  repo.write('readme.md', 'side\n');
  repo.commit('side');
  repo.git('checkout', '-q', base);
  repo.write('.env', 'A=main\n');
  repo.write('readme.md', 'main\n');
  repo.commit('main');
  try {
    repo.git('merge', '-q', 'side', '-m', 'merge');
  } catch {
    // Conflicted: resolve both files with a secret value and commit.
  }
  repo.write('.env', `${SECRET}\n`);
  repo.write('readme.md', 'merged\n');
  const merged = repo.commit('merge side');
  const diff = await render(repo.root, merged);
  assert.equal(diff.includes('s3cret-history'), false, diff);
  assert.match(diff, /merged/);
});

test('redactSecretDiffSections drops sections that still name a secret path', () => {
  const patch = [
    'diff --git a/ok.txt b/ok.txt', '--- a/ok.txt', '+++ b/ok.txt', '@@ -0,0 +1 @@', '+fine',
    'diff --git "a/sp ace/.env" "b/sp ace/.env"', '--- /dev/null', '+++ "b/sp ace/.env"', '@@ -0,0 +1 @@', '+leak',
    'diff --cc db.sqlite', '--- a/db.sqlite', '+++ b/db.sqlite', '@@@ -1 -1 +1 @@@', '+leak2',
    'diff --git a/.env.example b/.env.example', '@@ -0,0 +1 @@', '+template',
  ].join('\n');
  const isSecret = (entry) => /(^|\/)\.env$|\.sqlite$/.test(entry);
  const { text, hidden } = redactSecretDiffSections(patch, isSecret);
  assert.equal(text.includes('leak'), false, text);
  assert.match(text, /\+fine/);
  assert.match(text, /\+template/, 'a template whose name merely contains .env is kept');
  assert.deepEqual(hidden.sort(), ['db.sqlite', 'sp ace/.env']);
});

test('redactSecretDiffSections falls back to the known secret list on unparseable headers', () => {
  const patch = ['diff --git a/x b/y b/z', '+++ b/strange', '@@ -0,0 +1 @@', '+leak'].join('\n');
  const { text } = redactSecretDiffSections(patch, () => false, ['y b/z']);
  assert.equal(text.includes('leak'), false);
});
