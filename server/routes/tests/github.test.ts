/**
 * Tests for GET /api/github/repos (server/routes/github.js).
 *
 * Security-focused coverage:
 *  1. IDOR scoping  — a user supplying a tokenId belonging to another user
 *                     gets 404 no_token, and getGithubTokenById is invoked
 *                     scoped to the *requesting* user's id (never the victim's).
 *  2. no_token      — a user with no active token gets 404 no_token.
 *  3. Safe response — successful response exposes only the six whitelisted
 *                     fields and never leaks github_token / credential_value /
 *                     any raw token material.
 *  4. invalid_token — Octokit throwing a 401 maps to 401 invalid_token with no
 *                     leakage of internal error detail.
 *
 * Framework: node:test (built-in) + node:assert/strict, run via tsx — matching
 * the existing server test suite. Octokit and the database index are isolated
 * with node:test module mocking (requires --experimental-test-module-mocks),
 * because github.js constructs `new Octokit(...)` directly and imports the
 * githubTokensDb singleton — neither is dependency-injected.
 *
 * node:test only allows mocking a given module specifier once, so the mocks are
 * registered a single time at module load and delegate to a mutable `current`
 * behaviour that each test reconfigures before driving the router.
 */

import assert from 'node:assert/strict';
import { AddressInfo } from 'node:net';
import path from 'node:path';
import test, { mock } from 'node:test';
import { pathToFileURL } from 'node:url';

import express from 'express';

type RepoListResult = { data: unknown[] };

type Behaviour = {
  // Octokit
  authSeen: string[];
  listForAuthenticatedUser: () => Promise<RepoListResult>;
  // DB
  getGithubTokenById: (userId: number, tokenId: number) => unknown;
  getActiveGithubToken: (userId: number) => string | null;
  byIdCalls: Array<{ userId: number; tokenId: number }>;
  activeCalls: Array<{ userId: number }>;
};

function freshBehaviour(): Behaviour {
  return {
    authSeen: [],
    listForAuthenticatedUser: async () => ({ data: [] }),
    getGithubTokenById: () => null,
    getActiveGithubToken: () => null,
    byIdCalls: [],
    activeCalls: [],
  };
}

// Mutable behaviour shared by the (single) registered mocks.
let current: Behaviour = freshBehaviour();

// Resolve the exact module specifier github.js imports for the db, as an
// absolute file URL so the mock registry matches the resolved module
// regardless of which file imports it.
const dbIndexUrl = pathToFileURL(
  path.resolve(import.meta.dirname, '../../modules/database/index.js')
).href;

// Register mocks ONCE. node:test forbids re-mocking the same specifier.
mock.module('@octokit/rest', {
  namedExports: {
    Octokit: class {
      repos: { listForAuthenticatedUser: () => Promise<RepoListResult> };
      constructor(options: { auth?: string }) {
        current.authSeen.push(String(options?.auth));
        this.repos = {
          listForAuthenticatedUser: () => current.listForAuthenticatedUser(),
        };
      }
    },
  },
});

mock.module(dbIndexUrl, {
  namedExports: {
    githubTokensDb: {
      getGithubTokenById: (userId: number, tokenId: number) => {
        current.byIdCalls.push({ userId, tokenId });
        return current.getGithubTokenById(userId, tokenId);
      },
      getActiveGithubToken: (userId: number) => {
        current.activeCalls.push({ userId });
        return current.getActiveGithubToken(userId);
      },
    },
  },
});

// Import the router once, after mocks are registered.
const { default: githubRouter } = await import('../github.js');

/**
 * Builds a real express app mounting the github router behind a fake
 * authenticateToken middleware that injects req.user, applies the test's
 * behaviour overrides, and returns a fetch-based request helper.
 */
async function buildServer(opts: {
  user: { id: number };
  behaviour?: Partial<Behaviour>;
}) {
  current = { ...freshBehaviour(), ...opts.behaviour };

  const app = express();
  // Stand-in for authenticateToken (applied at mount time in production:
  // app.use('/api/github', authenticateToken, githubRoutes)). We inject a
  // verified user so req.user.id scoping is exercised directly.
  app.use((req, _res, next) => {
    (req as express.Request & { user: { id: number } }).user = opts.user;
    next();
  });
  app.use('/api/github', githubRouter);

  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const { port } = server.address() as AddressInfo;

  const request = async (query = '') => {
    const res = await fetch(`http://127.0.0.1:${port}/api/github/repos${query}`);
    const body = (await res.json()) as Record<string, unknown>;
    return { status: res.status, body };
  };

  const close = () =>
    new Promise<void>((resolve) => server.close(() => resolve()));

  return { request, close };
}

test('IDOR: tokenId owned by another user yields 404 no_token and is looked up scoped to the requester', async () => {
  // Requester is user 1. They pass tokenId=99, which belongs to user 2.
  // The db lookup is scoped (id AND user_id AND is_active=1), so for user 1 it
  // returns null — the route must not fall back to any other user's token.
  const requesterId = 1;
  const victimsTokenId = 99;

  const srv = await buildServer({
    user: { id: requesterId },
    behaviour: {
      // Returns a row only if the *requesting* user actually owns the id.
      getGithubTokenById: (userId, tokenId) =>
        userId === requesterId && tokenId === 42
          ? { github_token: 'requester-own-token' }
          : null,
      // Must never be consulted when a tokenId is supplied.
      getActiveGithubToken: () => 'should-not-be-used',
    },
  });

  try {
    const { status, body } = await srv.request(`?tokenId=${victimsTokenId}`);

    assert.equal(status, 404);
    assert.equal(body.code, 'no_token');

    // The lookup happened, scoped to the requester — never the victim's id.
    assert.equal(current.byIdCalls.length, 1);
    assert.deepEqual(current.byIdCalls[0], {
      userId: requesterId,
      tokenId: victimsTokenId,
    });

    // No fallback to the active-token path, and no upstream GitHub call.
    assert.equal(current.activeCalls.length, 0);
    assert.equal(current.authSeen.length, 0);

    // No token material of any kind leaks into the error body.
    const serialized = JSON.stringify(body);
    assert.ok(!serialized.includes('should-not-be-used'));
    assert.ok(!serialized.includes('requester-own-token'));
  } finally {
    await srv.close();
  }
});

test('no_token: user with no active token gets 404 no_token', async () => {
  const srv = await buildServer({
    user: { id: 7 },
    behaviour: {
      getActiveGithubToken: () => null,
    },
  });

  try {
    const { status, body } = await srv.request();

    assert.equal(status, 404);
    assert.equal(body.code, 'no_token');

    // Default (no tokenId) path: active-token lookup scoped to the user.
    assert.equal(current.activeCalls.length, 1);
    assert.deepEqual(current.activeCalls[0], { userId: 7 });
    assert.equal(current.byIdCalls.length, 0);

    // No GitHub request attempted when there is no token.
    assert.equal(current.authSeen.length, 0);
  } finally {
    await srv.close();
  }
});

test('success: response contains only the six whitelisted fields and never leaks raw token material', async () => {
  const rawToken = 'ghp_SUPERSECRETrawtokenvalue';
  const srv = await buildServer({
    user: { id: 3 },
    behaviour: {
      getActiveGithubToken: () => rawToken,
      // GitHub returns a rich payload with far more than we expose, plus
      // secret-shaped fields to prove they are stripped.
      listForAuthenticatedUser: async () => ({
        data: [
          {
            name: 'repo-one',
            full_name: 'owner/repo-one',
            clone_url: 'https://github.com/owner/repo-one.git',
            private: true,
            default_branch: 'main',
            updated_at: '2026-01-02T03:04:05Z',
            // Noise that must NOT appear in the response:
            id: 12345,
            owner: { login: 'owner', node_id: 'XYZ' },
            github_token: rawToken,
            credential_value: rawToken,
            ssh_url: 'git@github.com:owner/repo-one.git',
          },
        ],
      }),
    },
  });

  try {
    const { status, body } = await srv.request();

    assert.equal(status, 200);

    // Auth seam: the raw token was handed to Octokit (and only to Octokit).
    assert.deepEqual(current.authSeen, [rawToken]);

    const repositories = body.repositories as Array<Record<string, unknown>>;
    assert.ok(Array.isArray(repositories));
    assert.equal(repositories.length, 1);

    // Exactly the six documented fields, no more, no less.
    assert.deepEqual(Object.keys(repositories[0]).sort(), [
      'cloneUrl',
      'defaultBranch',
      'fullName',
      'name',
      'private',
      'updatedAt',
    ]);

    assert.deepEqual(repositories[0], {
      name: 'repo-one',
      fullName: 'owner/repo-one',
      cloneUrl: 'https://github.com/owner/repo-one.git',
      private: true,
      defaultBranch: 'main',
      updatedAt: '2026-01-02T03:04:05Z',
    });

    // Hard guarantee: no raw token anywhere in the serialized response, and no
    // secret-shaped keys leaked through.
    const serialized = JSON.stringify(body);
    assert.ok(!serialized.includes(rawToken), 'raw token leaked in response');
    assert.ok(!serialized.includes('github_token'));
    assert.ok(!serialized.includes('credential_value'));
  } finally {
    await srv.close();
  }
});

test('invalid_token: Octokit 401 maps to 401 invalid_token without leaking internal detail', async () => {
  const srv = await buildServer({
    user: { id: 5 },
    behaviour: {
      getActiveGithubToken: () => 'revoked-token-value',
      listForAuthenticatedUser: async () => {
        const err = new Error(
          'Bad credentials: token ghp_LEAKYINTERNALDETAIL'
        ) as Error & { status: number };
        err.status = 401;
        throw err;
      },
    },
  });

  try {
    const { status, body } = await srv.request();

    assert.equal(status, 401);
    assert.equal(body.code, 'invalid_token');

    // The client message is generic; the raw token and internal Octokit error
    // text must not leak.
    const serialized = JSON.stringify(body);
    assert.ok(!serialized.includes('revoked-token-value'));
    assert.ok(!serialized.includes('ghp_LEAKYINTERNALDETAIL'));
    assert.ok(!serialized.includes('Bad credentials'));
  } finally {
    await srv.close();
  }
});
