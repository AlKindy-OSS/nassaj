import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { AddressInfo } from 'node:net';
import path from 'node:path';
import test, { after, mock } from 'node:test';

import express from 'express';

import {
  bindSessionWorkspace,
  createSessionWorkspace,
} from '@/modules/session-workspaces/index.js';

const repository = fs.mkdtempSync('/var/tmp/nassaj-overlay-read-route-');
const git = (...args: string[]) => execFileSync(
  'git', ['-C', repository, ...args], { encoding: 'utf8' },
).trim();

git('init', '-b', 'main');
git('config', 'user.name', 'Overlay Read Fixture');
git('config', 'user.email', 'overlay-read@example.test');
fs.writeFileSync(path.join(repository, 'overlay.txt'), 'base overlay\n');
fs.writeFileSync(path.join(repository, 'shared.txt'), 'base shared\n');
git('add', 'overlay.txt', 'shared.txt');
git('commit', '-m', 'chore: overlay read baseline');

createSessionWorkspace({
  projectPath: repository,
  launchKey: 'overlay-read-launch',
  principalId: 41,
});
const binding = bindSessionWorkspace({
  projectPath: repository,
  launchKey: 'overlay-read-launch',
  sessionId: 'overlay-read-session',
  principalId: 41,
});
const otherOwner = createSessionWorkspace({
  projectPath: repository,
  launchKey: 'other-owner-launch',
  principalId: 99,
});
bindSessionWorkspace({
  projectPath: repository,
  launchKey: 'other-owner-launch',
  sessionId: 'other-owner-session',
  principalId: 99,
});
fs.writeFileSync(path.join(binding.cwd, 'overlay.txt'), 'overlay owned value\n');
fs.writeFileSync(path.join(binding.cwd, 'overlay-only.txt'), 'overlay only\n');
fs.symlinkSync(path.join(repository, 'shared.txt'), path.join(binding.cwd, 'escape.txt'));
fs.writeFileSync(path.join(repository, 'shared.txt'), 'shared dirty value\n');
fs.writeFileSync(path.join(repository, 'shared-only.txt'), 'shared only\n');

mock.module('@/modules/database/index.js', {
  namedExports: {
    projectsDb: {
      isProjectVisibleToUser: () => true,
      isProjectWritableByUser: () => true,
      getProjectPathById: () => repository,
    },
    userDb: { getGitConfig: () => ({ git_name: 'Reader', git_email: 'reader@example.test' }) },
    githubTokensDb: { getActiveGithubToken: () => null },
  },
});
mock.module('@/claude-sdk.js', { namedExports: { queryClaudeSDK: async () => undefined } });
mock.module('@/cursor-cli.js', { namedExports: { spawnCursor: async () => undefined } });

const gitRouter = (await import('./git.js')).default;
const app = express();
app.use((req, _res, next) => {
  (req as express.Request & { user: unknown }).user = { id: 41, role: 'user' };
  next();
});
app.use('/api/git', gitRouter);
const server = app.listen(0);
await new Promise<void>((resolve) => server.once('listening', resolve));
const { port } = server.address() as AddressInfo;

async function get(route: string) {
  const response = await fetch(`http://127.0.0.1:${port}${route}`);
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}

function overlayQuery() {
  return `project=project-1&sessionId=overlay-read-session&generation=${encodeURIComponent(binding.generation)}`;
}

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  fs.chmodSync(repository, 0o700);
  fs.rmSync(repository, { recursive: true, force: true });
});

test('overlay status excludes shared dirt and shared status excludes overlay dirt', async () => {
  const isolated = await get(`/api/git/status?${overlayQuery()}`);
  assert.equal(isolated.status, 200);
  assert.deepEqual(isolated.body.modified, ['overlay.txt']);
  assert.deepEqual(isolated.body.untracked, ['escape.txt', 'overlay-only.txt']);
  assert.equal((isolated.body.modified as string[]).includes('shared.txt'), false);
  assert.equal((isolated.body.untracked as string[]).includes('shared-only.txt'), false);

  const shared = await get('/api/git/status?project=project-1');
  assert.equal(shared.status, 200);
  assert.deepEqual(shared.body.modified, ['shared.txt']);
  assert.deepEqual(shared.body.untracked, ['shared-only.txt']);
  assert.equal((shared.body.modified as string[]).includes('overlay.txt'), false);
});

test('overlay diff is generated from overlay bytes, never shared bytes', async () => {
  const response = await get(`/api/git/diff?${overlayQuery()}&file=overlay.txt`);
  assert.equal(response.status, 200);
  assert.match(String(response.body.diff), /\+overlay owned value/);
  assert.doesNotMatch(String(response.body.diff), /shared dirty value/);

  const untracked = await get(`/api/git/diff?${overlayQuery()}&file=overlay-only.txt`);
  assert.equal(untracked.status, 200);
  assert.match(String(untracked.body.diff), /\+overlay only/);
});

test('overlay reads fail closed for missing or stale generation', async () => {
  const incomplete = await get('/api/git/status?project=project-1&sessionId=overlay-read-session');
  assert.equal(incomplete.status, 400);

  const ambiguous = await get('/api/git/status?project=project-1&sessionId=overlay-read-session&sessionId=spoof&generation=stale');
  assert.equal(ambiguous.status, 400);

  const stale = await get('/api/git/status?project=project-1&sessionId=overlay-read-session&generation=stale');
  assert.equal(stale.status, 409);

  const wrongPrincipal = await get(`/api/git/status?project=project-1&sessionId=other-owner-session&generation=${encodeURIComponent(otherOwner.generation)}`);
  assert.equal(wrongPrincipal.status, 404);
});

test('overlay diff refuses a symlink that escapes the isolated worktree', async () => {
  const response = await get(`/api/git/diff?${overlayQuery()}&file=escape.txt`);
  assert.equal(typeof response.body.error, 'string');
  assert.doesNotMatch(JSON.stringify(response.body), /shared dirty value/);
});
