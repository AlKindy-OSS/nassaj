import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { AddressInfo } from 'node:net';
import path from 'node:path';
import test, { after, mock } from 'node:test';

import express from 'express';

const repository = fs.mkdtempSync('/var/tmp/nassaj-git-route-');
const git = (...args: string[]) => execFileSync('git', ['-C', repository, ...args], { encoding: 'utf8' }).trim();

git('init', '-b', 'main');
git('config', 'user.name', 'Route Fixture');
git('config', 'user.email', 'route-fixture@example.test');
fs.mkdirSync(path.join(repository, 'server'));
fs.mkdirSync(path.join(repository, 'src'));
fs.writeFileSync(path.join(repository, 'server/selected-a.txt'), 'old a\n');
fs.writeFileSync(path.join(repository, 'src/selected-b.txt'), 'old b\n');
fs.writeFileSync(path.join(repository, 'outside.txt'), 'old outside\n');
git('add', 'server/selected-a.txt', 'src/selected-b.txt', 'outside.txt');
git('commit', '-m', 'chore: route fixture baseline');

mock.module('@/modules/database/index.js', {
  namedExports: {
    projectsDb: {
      isProjectVisibleToUser: () => true,
      isProjectWritableByUser: () => true,
      getProjectPathById: () => repository,
    },
    userDb: {
      getGitConfig: () => ({ git_name: 'Route User', git_email: 'route-user@example.test' }),
    },
    githubTokensDb: { getActiveGithubToken: () => null },
  },
});
mock.module('@/claude-sdk.js', { namedExports: { queryClaudeSDK: async () => undefined } });
mock.module('@/cursor-cli.js', { namedExports: { spawnCursor: async () => undefined } });

const gitRouter = (await import('./git.js')).default;
const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  (req as express.Request & { user: unknown }).user = { id: 41, role: 'user' };
  next();
});
app.use('/api/git', gitRouter);
const server = app.listen(0);
await new Promise<void>((resolve) => server.once('listening', resolve));
const { port } = server.address() as AddressInfo;

async function commit(message: string, files: string[]) {
  return post('/api/git/commit', { project: 'route-project', message, files });
}

async function post(url: string, body: Record<string, unknown>) {
  const response = await fetch(`http://127.0.0.1:${port}${url}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}

function makeFixtureRemovable(target: string) {
  if (!fs.existsSync(target) || fs.lstatSync(target).isSymbolicLink()) return;
  const metadata = fs.lstatSync(target);
  if (!metadata.isDirectory()) return;
  fs.chmodSync(target, 0o700);
  for (const child of fs.readdirSync(target)) makeFixtureRemovable(path.join(target, child));
}

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  makeFixtureRemovable(repository);
  fs.rmSync(repository, { recursive: true, force: true });
});

test('POST /commit rejects non-Conventional messages before changing HEAD', async () => {
  const before = git('rev-parse', 'HEAD');
  const response = await commit('plain message', ['server/selected-a.txt']);
  assert.equal(response.status, 400);
  assert.equal(response.body.error, 'Commit message must follow Conventional Commits');
  assert.equal(git('rev-parse', 'HEAD'), before);
});

test('POST /commit keeps non-overlapping requests independent and excludes unrelated dirt', async () => {
  fs.writeFileSync(path.join(repository, 'server/selected-a.txt'), 'new a\n');
  fs.writeFileSync(path.join(repository, 'src/selected-b.txt'), 'new b\n');
  fs.writeFileSync(path.join(repository, 'outside.txt'), 'dirty but not selected\n');

  const [first, second] = await Promise.all([
    commit('fix: commit selected server file', ['server/selected-a.txt']),
    commit('fix: commit selected client file', ['src/selected-b.txt']),
  ]);

  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.equal(first.body.success, true);
  assert.equal(second.body.success, true);
  assert.notEqual(first.body.commit, second.body.commit);
  assert.equal(git('show', 'HEAD:server/selected-a.txt'), 'new a');
  assert.equal(git('show', 'HEAD:src/selected-b.txt'), 'new b');
  assert.equal(git('show', 'HEAD:outside.txt'), 'old outside');
  assert.equal(fs.readFileSync(path.join(repository, 'outside.txt'), 'utf8'), 'dirty but not selected\n');
  assert.equal(git('diff', '--cached', '--name-only'), '', 'clean default index follows HEAD without staging worktree dirt');
  assert.equal(git('write-tree'), git('show', '-s', '--format=%T', 'HEAD'));
  const firstSequence = String(first.body.sequence).padStart(16, '0');
  const secondSequence = String(second.body.sequence).padStart(16, '0');
  assert.equal(git('rev-parse', `refs/nassaj/previews/v1/events/${firstSequence}/event`), first.body.commit);
  assert.equal(git('rev-parse', `refs/nassaj/previews/v1/events/${secondSequence}/event`), second.body.commit);
  assert.equal(git('show', '-s', '--format=%an <%ae>', String(first.body.commit)), 'Route User <route-user@example.test>');
});

test('POST /commit rebases pre-existing staged intent without inverse staged changes', async () => {
  fs.writeFileSync(path.join(repository, 'outside.txt'), 'intentional staged value\n');
  git('add', 'outside.txt');
  fs.writeFileSync(path.join(repository, 'server/selected-a.txt'), 'new a again\n');

  const response = await commit('fix: commit selected file around staged intent', ['server/selected-a.txt']);

  assert.equal(response.status, 200);
  assert.equal(response.body.success, true);
  assert.equal(response.body.needsReconciliation, false);
  assert.equal(git('diff', '--cached', '--name-only'), 'outside.txt');
  assert.match(git('diff', '--cached', '--', 'outside.txt'), /\+intentional staged value/);
  assert.equal(git('diff', '--cached', '--', 'server/selected-a.txt'), '');
  assert.equal(git('show', 'HEAD:outside.txt'), 'old outside');
  assert.equal(git('show', 'HEAD:server/selected-a.txt'), 'new a again');
});

test('POST conflict retains its request and resolve resumes it under a fresh fence', async () => {
  git('reset', 'HEAD', '--', 'outside.txt');
  fs.writeFileSync(path.join(repository, 'src/selected-b.txt'), 'staged same-path intent\n');
  git('add', 'src/selected-b.txt');
  fs.writeFileSync(path.join(repository, 'src/selected-b.txt'), 'resolved selected value\n');
  const beforeHead = git('rev-parse', 'HEAD');

  const conflicted = await commit('fix: selected value conflicts with staged intent', ['src/selected-b.txt']);
  assert.equal(conflicted.status, 409);
  assert.equal(git('rev-parse', 'HEAD'), beforeHead);
  const conflict = conflicted.body.conflict as { requestId?: string };
  assert.match(String(conflict?.requestId), /^[0-9a-f-]{36}$/);

  git('reset', 'HEAD', '--', 'src/selected-b.txt');
  const resumed = await post('/api/git/resolve-commit-conflict', {
    project: 'route-project',
    requestId: conflict.requestId,
    message: 'fix: resume resolved selected value',
  });
  assert.equal(resumed.status, 200);
  assert.equal(resumed.body.success, true);
  assert.equal(git('show', 'HEAD:src/selected-b.txt'), 'resolved selected value');
  assert.equal(git('diff', '--cached', '--name-only'), '');
});

test('direct push and publish fail closed until the owner release broker authorizes an exact OID', async () => {
  const push = await post('/api/git/push', { project: 'route-project' });
  const publish = await post('/api/git/publish', { project: 'route-project', branch: 'main' });
  assert.equal(push.status, 403);
  assert.equal(publish.status, 403);
  assert.match(String(push.body.error), /owner-authorized release broker/);
});
