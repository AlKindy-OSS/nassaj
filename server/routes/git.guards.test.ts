/**
 * git.guards.test.ts — security regression tests for server/routes/git.js
 * (B-GIT-SEC-1 … B-GIT-SEC-4).
 *
 * Drives the REAL router over a real express server, with only the two edges
 * mocked: `child_process.spawn` (so no git process ever runs) and the database
 * barrel (so visibility/writability are scripted). Nothing from git.js is
 * re-implemented here — the guards under test are imported from the module.
 *
 * What is proven:
 *   (a) B-GIT-SEC-1 read gate  — a non-member cannot read the diff of a project
 *       that is not visible to him: 404, body identical to a missing project,
 *       and NOT ONE git process is spawned (the guard runs before execution).
 *   (b) B-GIT-SEC-1 write gate — a user who may READ a public project (visible)
 *       but is not a member (not writable) is refused POST /discard with the
 *       same 404, again before any spawn; the writable user goes through, so
 *       the gate is not a blanket deny.
 *   (c) B-GIT-SEC-2 traversal — the path guard that used to be dead code (the
 *       caller passed one argument, so the whole block was skipped) now rejects
 *       `../../../etc/passwd`, rejects a symlink escaping the project, rejects a
 *       candidate that resolves above the project into the wider repository, and
 *       refuses to run at all without a project root (fail-closed).
 *   (d) B-GIT-SEC-3 token    — a failing push answers WITHOUT any
 *       `https://…@…` credential and without the token, the token is absent from
 *       the push argv, and it is delivered through the git config ENVIRONMENT
 *       instead; the stderr-based error branch that never matched before now
 *       resolves to "Authentication failed".
 *
 * Framework: node:test + module mocking (--experimental-test-module-mocks) via
 * tsx, matching server/routes/tests/system-actions.test.ts. Mocks are registered
 * BEFORE the router is imported (node:test mocks are not hoisted).
 */

import assert from 'node:assert/strict';
import * as realChildProcess from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test, { after, beforeEach, mock } from 'node:test';

import express from 'express';

// ── real directories: the guards call fs.realpath, so the tree must exist ─────
const WORKSPACE = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'git-guards-')));
const PROJECT_DIR = path.join(WORKSPACE, 'repo', 'project');
const OUTSIDE_DIR = path.join(WORKSPACE, 'outside');
fs.mkdirSync(PROJECT_DIR, { recursive: true });
fs.mkdirSync(OUTSIDE_DIR, { recursive: true });
fs.writeFileSync(path.join(OUTSIDE_DIR, 'secret.txt'), 'TOP SECRET\n');
fs.writeFileSync(path.join(WORKSPACE, 'repo', 'sibling.txt'), 'sibling of the project\n');
fs.symlinkSync(OUTSIDE_DIR, path.join(PROJECT_DIR, 'escape'));

const REPO_ROOT = path.join(WORKSPACE, 'repo'); // git toplevel ABOVE the project

// ── spawn mock ────────────────────────────────────────────────────────────────
type SpawnCall = { cmd: string; args: string[]; options: { env?: NodeJS.ProcessEnv } };
type ScriptedResult = { stdout?: string; stderr?: string; code?: number };

let spawnCalls: SpawnCall[] = [];
/** Per-test override; falls back to defaultGitScript. */
let gitScript: (args: string[]) => ScriptedResult | undefined = () => undefined;
/** `git rev-parse --show-toplevel` answer (a test moves it above the project). */
let toplevel = PROJECT_DIR;

const SECRET_TOKEN = 'ghp_SeCrEtTokenForTests0123456789';
const TOKEN_PUSH_URL = `https://${SECRET_TOKEN}@github.com/owner/repo.git`;

function defaultGitScript(args: string[]): ScriptedResult {
  const [verb] = args;
  if (verb === 'rev-parse' && args.includes('--is-inside-work-tree')) return { stdout: 'true\n' };
  if (verb === 'rev-parse' && args.includes('--show-toplevel')) return { stdout: `${toplevel}\n` };
  // No upstream configured — the realistic default, which sends push/pull down
  // the `origin` + current-branch fallback.
  if (verb === 'rev-parse' && args.some((arg) => arg.includes('@{upstream}'))) {
    return { code: 128, stderr: 'fatal: no upstream configured for branch\n' };
  }
  if (verb === 'rev-parse') return { stdout: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n' };
  if (verb === 'symbolic-ref') return { stdout: 'main\n' };
  if (verb === 'status') return { stdout: ' M a.txt\n' };
  if (verb === 'remote' && args[1] === 'get-url') return { stdout: 'https://github.com/owner/repo.git\n' };
  return { stdout: '' };
}

function fakeSpawn(cmd: string, args: string[], options: { env?: NodeJS.ProcessEnv }) {
  spawnCalls.push({ cmd, args: [...args], options: options ?? {} });

  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();

  const result = gitScript(args) ?? defaultGitScript(args);
  process.nextTick(() => {
    if (result.stdout) child.stdout.emit('data', Buffer.from(result.stdout));
    if (result.stderr) child.stderr.emit('data', Buffer.from(result.stderr));
    child.emit('close', result.code ?? 0);
  });
  return child;
}

mock.module('child_process', {
  namedExports: { ...realChildProcess, spawn: fakeSpawn },
});

// ── database mock: scripted visibility / writability ──────────────────────────
const PUBLIC_PROJECT = 'proj-public';   // visible to everyone, writable by member only
const PRIVATE_PROJECT = 'proj-private'; // invisible to a non-member

let currentUserId: number | null = 7;
/** userId → { visible, writable } per project id. */
const ACCESS: Record<string, Record<number, { visible: boolean; writable: boolean }>> = {
  [PUBLIC_PROJECT]: {
    7: { visible: true, writable: false }, // reader: sees the public project, not a member
    9: { visible: true, writable: true },  // member
  },
  [PRIVATE_PROJECT]: {
    7: { visible: false, writable: false },
    9: { visible: true, writable: true },
  },
};

function accessFor(projectId: string, userId: number | null) {
  if (userId === null) return { visible: false, writable: false };
  return ACCESS[projectId]?.[userId] ?? { visible: false, writable: false };
}

let storedGithubToken: string | null = null;

mock.module('@/modules/database/index.js', {
  namedExports: {
    projectsDb: {
      isProjectVisibleToUser: (projectId: string, userId: number | null) =>
        accessFor(projectId, userId).visible,
      isProjectWritableByUser: (projectId: string, userId: number | null) =>
        accessFor(projectId, userId).writable,
      getProjectPathById: (projectId: string) =>
        projectId === PUBLIC_PROJECT || projectId === PRIVATE_PROJECT ? PROJECT_DIR : null,
    },
    userDb: { getGitConfig: () => null },
    githubTokensDb: { getActiveGithubToken: () => storedGithubToken },
  },
});

// The AI helpers are never exercised here; keep their heavy graphs out.
mock.module('@/claude-sdk.js', { namedExports: { queryClaudeSDK: async () => undefined } });
mock.module('@/cursor-cli.js', { namedExports: { spawnCursor: async () => undefined } });

// ── import the REAL router after the mocks ────────────────────────────────────
const gitModule = await import('./git.js');
const gitRouter = gitModule.default;
const { validateFilePath, redactCredentials, spawnAsync } = gitModule;

// ── test server ───────────────────────────────────────────────────────────────
const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  if (currentUserId !== null) {
    (req as express.Request & { user: unknown }).user = { id: currentUserId, role: 'user' };
  }
  next();
});
app.use('/api/git', gitRouter);

const server = app.listen(0);
await new Promise<void>((resolve) => server.once('listening', resolve));
const { port } = server.address() as AddressInfo;

async function request(method: string, urlPath: string, body?: unknown) {
  const res = await fetch(`http://127.0.0.1:${port}${urlPath}`, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json: Record<string, unknown> = {};
  try {
    json = JSON.parse(text) as Record<string, unknown>;
  } catch {
    /* non-JSON body */
  }
  return { status: res.status, json, text };
}

beforeEach(() => {
  spawnCalls = [];
  gitScript = () => undefined;
  toplevel = PROJECT_DIR;
  currentUserId = 7;
  storedGithubToken = null;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  fs.rmSync(WORKSPACE, { recursive: true, force: true });
});

// ── (a) read gate ─────────────────────────────────────────────────────────────

test('B-GIT-SEC-1: a non-member cannot read the diff of a project he cannot see', async () => {
  currentUserId = 7; // not a member of the private project
  const res = await request('GET', `/api/git/diff?project=${PRIVATE_PROJECT}&file=a.txt`);

  assert.equal(res.status, 404);
  assert.deepEqual(res.json, { error: 'Project not found' });
  assert.equal(spawnCalls.length, 0, 'the guard must run BEFORE any git process is spawned');
});

test('B-GIT-SEC-1: the denial is indistinguishable from an unknown project id', async () => {
  currentUserId = 7;
  const hidden = await request('GET', `/api/git/diff?project=${PRIVATE_PROJECT}&file=a.txt`);
  const unknown = await request('GET', '/api/git/diff?project=does-not-exist&file=a.txt');

  assert.equal(hidden.status, unknown.status);
  assert.equal(hidden.text, unknown.text, 'no existence oracle: identical body');
});

test('B-GIT-SEC-1: a member DOES read the diff (the gate is not a blanket deny)', async () => {
  currentUserId = 9;
  gitScript = (args) => (args[0] === 'diff' ? { stdout: '@@ -1 +1 @@\n-a\n+b\n' } : undefined);

  const res = await request('GET', `/api/git/diff?project=${PRIVATE_PROJECT}&file=a.txt`);

  assert.equal(res.status, 200);
  assert.match(String(res.json.diff), /\+b/);
  assert.ok(spawnCalls.length > 0, 'the authorized request reaches git');
});

// ── (b) write gate ────────────────────────────────────────────────────────────

test('B-GIT-SEC-1: read-only user is refused POST /discard on a project he can READ', async () => {
  currentUserId = 7; // visible: true, writable: false on the public project
  const readable = await request('GET', `/api/git/status?project=${PUBLIC_PROJECT}`);
  assert.equal(readable.status, 200, 'precondition: the same user CAN read this project');

  spawnCalls = [];
  const res = await request('POST', '/api/git/discard', { project: PUBLIC_PROJECT, file: 'a.txt' });

  assert.equal(res.status, 404);
  assert.deepEqual(res.json, { error: 'Project not found' });
  assert.equal(spawnCalls.length, 0, 'no git process for an unauthorized mutation');
});

test('B-GIT-SEC-1: every mutating endpoint is covered by the write gate', async () => {
  currentUserId = 7; // read-only on the public project
  const mutations: Array<[string, Record<string, unknown>]> = [
    ['/api/git/commit', { message: 'm', files: ['a.txt'] }],
    ['/api/git/initial-commit', {}],
    ['/api/git/revert-local-commit', {}],
    ['/api/git/checkout', { branch: 'main' }],
    ['/api/git/create-branch', { branch: 'feat' }],
    ['/api/git/delete-branch', { branch: 'feat' }],
    ['/api/git/generate-commit-message', { files: ['a.txt'] }],
    ['/api/git/fetch', {}],
    ['/api/git/pull', {}],
    ['/api/git/push', {}],
    ['/api/git/publish', { branch: 'main' }],
    ['/api/git/discard', { file: 'a.txt' }],
    ['/api/git/delete-untracked', { file: 'a.txt' }],
  ];

  for (const [route, body] of mutations) {
    spawnCalls = [];
    const res = await request('POST', route, { project: PUBLIC_PROJECT, ...body });
    assert.equal(res.status, 404, `${route} must refuse a non-writable caller`);
    assert.deepEqual(res.json, { error: 'Project not found' }, `${route} body`);
    assert.equal(spawnCalls.length, 0, `${route} must not spawn git`);
  }
});

test('B-GIT-SEC-1: a writable member goes through /discard', async () => {
  currentUserId = 9;
  const res = await request('POST', '/api/git/discard', { project: PUBLIC_PROJECT, file: 'a.txt' });

  assert.equal(res.status, 200);
  assert.equal(res.json.success, true);
  assert.ok(
    spawnCalls.some((call) => call.args[0] === 'restore'),
    'the authorized discard reaches `git restore`',
  );
});

test('B-GIT-SEC-1: an anonymous request (no req.user) is refused', async () => {
  currentUserId = null;
  const res = await request('GET', `/api/git/status?project=${PUBLIC_PROJECT}`);

  assert.equal(res.status, 404);
  assert.equal(spawnCalls.length, 0);
});

// ── (c) path traversal ────────────────────────────────────────────────────────

test('B-GIT-SEC-2: validateFilePath rejects the traversal that used to pass', () => {
  // Before the fix the single call site invoked validateFilePath(file) with ONE
  // argument, so `projectPath` was undefined and the whole traversal block was
  // skipped — only the NUL check survived. Both failure modes are closed now.
  assert.throws(
    () => validateFilePath('../../../etc/passwd', PROJECT_DIR),
    /path traversal detected/,
  );
  assert.throws(
    () => validateFilePath('/etc/passwd', PROJECT_DIR),
    /path traversal detected/,
  );
  assert.throws(
    () => validateFilePath('escape/secret.txt', PROJECT_DIR),
    /path traversal detected/,
    'a symlink inside the project that points outside must be rejected',
  );
  // Fail-closed: no root supplied -> error, never a silent bypass.
  assert.throws(() => validateFilePath('a.txt', ''), /project root is required/);
  // A legitimate in-project path still passes.
  assert.equal(validateFilePath('src/a.txt', PROJECT_DIR), 'src/a.txt');
});

test('B-GIT-SEC-2: GET /diff refuses a traversing file path before reading anything', async () => {
  currentUserId = 9;
  const res = await request(
    'GET',
    `/api/git/diff?project=${PUBLIC_PROJECT}&file=${encodeURIComponent('../../../etc/passwd')}`,
  );

  assert.match(String(res.json.error), /path traversal detected/);
  assert.ok(
    !spawnCalls.some((call) => call.args[0] === 'status' || call.args[0] === 'diff'),
    'rejected before any file-scoped git command',
  );
});

test('B-GIT-SEC-2: GET /file-with-diff refuses a symlink escaping the project', async () => {
  currentUserId = 9;
  const res = await request(
    'GET',
    `/api/git/file-with-diff?project=${PUBLIC_PROJECT}&file=${encodeURIComponent('escape/secret.txt')}`,
  );

  assert.match(String(res.json.error), /path traversal detected/);
  assert.ok(!res.text.includes('TOP SECRET'), 'the file outside the project is never read');
});

test('B-GIT-SEC-2: a candidate resolving above the project (wider repo) is refused', async () => {
  // git toplevel sits ABOVE the project, and `git status` "confirms" a file that
  // lives next to the project: resolving it would hand out a path the caller is
  // not authorized for. This is the second guard layer, inside
  // resolveRepositoryFilePath.
  currentUserId = 9;
  toplevel = REPO_ROOT;
  gitScript = (args) => (args[0] === 'status' ? { stdout: ' M sibling.txt\n' } : undefined);

  const res = await request(
    'GET',
    `/api/git/file-with-diff?project=${PUBLIC_PROJECT}&file=sibling.txt`,
  );

  assert.match(String(res.json.error), /path traversal detected/);
  assert.ok(!res.text.includes('sibling of the project'), 'content outside the project is not returned');
});

// ── (d) push credentials ──────────────────────────────────────────────────────

test('B-GIT-SEC-3: a failed push leaks neither the token nor a credential URL', async () => {
  currentUserId = 9;
  storedGithubToken = SECRET_TOKEN;
  gitScript = (args) =>
    args[0] === 'push'
      ? {
          code: 128,
          stderr:
            'remote: Invalid username or password.\n'
            + `fatal: Authentication failed for '${TOKEN_PUSH_URL}/'\n`,
        }
      : undefined;

  const res = await request('POST', '/api/git/push', { project: PUBLIC_PROJECT });

  assert.equal(res.status, 500);
  // The response must not carry the credential in any shape.
  assert.ok(!res.text.includes(SECRET_TOKEN), 'token absent from the response');
  assert.ok(!/https:\/\/[^\s/@"]+@/.test(res.text), `credential URL absent, got: ${res.text}`);
  assert.ok(!res.text.includes('ghp_'), 'no token prefix anywhere in the response');

  // The stderr-driven branch now matches (it never did while the code inspected
  // error.message, which only held the argv).
  assert.equal(res.json.error, 'Authentication failed');

  // The token never appears in argv…
  const pushCall = spawnCalls.find((call) => call.args[0] === 'push');
  assert.ok(pushCall, 'push was attempted');
  assert.deepEqual(pushCall.args, ['push', 'origin', 'main']);
  assert.ok(
    !pushCall.args.some((arg) => arg.includes('@') || arg.includes(SECRET_TOKEN)),
    'no credential in the push argv',
  );

  // …it is handed to git as transient environment config instead, so the push is
  // still authenticated as the requesting user.
  const env = pushCall.options.env ?? {};
  assert.equal(env.GIT_CONFIG_COUNT, '2');
  assert.equal(env.GIT_CONFIG_KEY_0, 'remote.origin.url');
  assert.equal(env.GIT_CONFIG_VALUE_0, TOKEN_PUSH_URL);
  assert.equal(env.GIT_CONFIG_KEY_1, 'remote.origin.pushurl');
  assert.equal(env.GIT_CONFIG_VALUE_1, TOKEN_PUSH_URL);
});

test('B-GIT-SEC-3: /publish keeps the token out of argv too', async () => {
  currentUserId = 9;
  storedGithubToken = SECRET_TOKEN;
  gitScript = (args) => {
    if (args[0] === 'remote' && args.length === 1) return { stdout: 'origin\n' };
    if (args[0] === 'push') return { stdout: 'branch published\n' };
    return undefined;
  };

  const res = await request('POST', '/api/git/publish', { project: PUBLIC_PROJECT, branch: 'main' });

  assert.equal(res.status, 200);
  const pushCall = spawnCalls.find((call) => call.args[0] === 'push');
  assert.ok(pushCall, 'publish pushed');
  assert.deepEqual(pushCall.args, ['push', '--set-upstream', 'origin', 'main']);
  assert.equal(pushCall.options.env?.GIT_CONFIG_VALUE_0, TOKEN_PUSH_URL);
  // The upstream is recorded against the clean remote NAME, so .git/config is
  // never written with a credential (no `git config branch.*` fallback needed).
  assert.ok(!spawnCalls.some((call) => call.args[0] === 'config'), 'no manual config writes');
});

test('B-GIT-SEC-3: spawnAsync never puts argv (hence a credential) in the error message', async () => {
  gitScript = () => ({ code: 1, stderr: `fatal: could not read from '${TOKEN_PUSH_URL}'\n` });

  await assert.rejects(
    () => spawnAsync('git', ['push', TOKEN_PUSH_URL, 'main'], {}),
    (error: Error & { stderr?: string; stdout?: string }) => {
      assert.ok(!error.message.includes(SECRET_TOKEN), 'message carries no token');
      assert.ok(!error.message.includes('@github.com'), 'message carries no credential URL');
      assert.equal(error.message, 'Command failed: git (exit code 1)');
      // git's own output is preserved for the error branches, but redacted.
      assert.ok(!String(error.stderr).includes(SECRET_TOKEN), 'stderr redacted');
      assert.match(String(error.stderr), /https:\/\/\*\*\*@github\.com/);
      return true;
    },
  );
});

test('B-GIT-SEC-3: redactCredentials strips credentials but keeps ordinary text', () => {
  assert.equal(
    redactCredentials(`fatal: repository '${TOKEN_PUSH_URL}' not found`),
    "fatal: repository 'https://***@github.com/owner/repo.git' not found",
  );
  assert.equal(redactCredentials(`token=${SECRET_TOKEN}`), 'token=***');
  // An email address has no scheme prefix and must survive untouched.
  assert.equal(
    redactCredentials('Author: Someone <someone@example.com>'),
    'Author: Someone <someone@example.com>',
  );
});

// ── option injection ──────────────────────────────────────────────────────────

test('B-GIT-SEC-4: dash-prefixed refs are rejected, and user values are fenced', async () => {
  currentUserId = 9;

  const checkout = await request('POST', '/api/git/checkout', {
    project: PUBLIC_PROJECT,
    branch: '--upload-pack=touch /tmp/pwned',
  });
  assert.equal(checkout.status, 500);
  assert.match(String(checkout.json.error), /Invalid branch name/);
  assert.ok(!spawnCalls.some((call) => call.args[0] === 'checkout'), 'no checkout was spawned');

  spawnCalls = [];
  const deleteBranch = await request('POST', '/api/git/delete-branch', {
    project: PUBLIC_PROJECT,
    branch: '-D',
  });
  assert.equal(deleteBranch.status, 500);
  assert.match(String(deleteBranch.json.error), /Invalid branch name/);

  // A legitimate branch is still fenced with --end-of-options on the wire.
  spawnCalls = [];
  await request('POST', '/api/git/checkout', { project: PUBLIC_PROJECT, branch: 'feature/x' });
  const checkoutCall = spawnCalls.find((call) => call.args[0] === 'checkout');
  assert.ok(checkoutCall, 'checkout ran for a valid branch');
  assert.deepEqual(checkoutCall.args, ['checkout', '--end-of-options', 'feature/x']);

  spawnCalls = [];
  await request('GET', `/api/git/commit-diff?project=${PUBLIC_PROJECT}&commit=HEAD`);
  const showCall = spawnCalls.find((call) => call.args[0] === 'show');
  assert.ok(showCall, 'commit-diff ran');
  assert.deepEqual(showCall.args, ['show', '--end-of-options', 'HEAD']);
});
