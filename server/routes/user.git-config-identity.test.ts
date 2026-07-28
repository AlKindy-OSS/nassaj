/**
 * Identity-leak tests for GET /api/user/git-config (server/routes/user.js).
 *
 * B-119 (high): the endpoint that feeds the new-member onboarding wizard
 * ("Git Configuration — Required") used to auto-populate ANY user whose row was
 * empty from the HOST's `git config --global` identity, and persist it. A member
 * who had just accepted an invite therefore saw another real person's name and
 * email pre-filled (the operator's), and — via buildGitAuthorEnv — had his
 * commits attributed to that person. Live DB confirmed three non-owner rows
 * carrying the operator's identity.
 *
 * The fix keeps the host-global fallback for the operator (role 'owner', read
 * from the DB row, not from the JWT) and gives every other account empty fields,
 * plus a read-path remediation that clears already-poisoned rows.
 *
 * These tests mount the REAL router with node:test module mocking for the DB,
 * the auth middleware and the host git reader, so no DB, subprocess or JWT is
 * involved. Runner:
 *   npx tsx --experimental-test-module-mocks --tsconfig server/tsconfig.json \
 *     --test server/routes/user.git-config-identity.test.ts
 */

import assert from 'node:assert/strict';
import { AddressInfo } from 'node:net';
import path from 'node:path';
import test, { mock } from 'node:test';
import { pathToFileURL } from 'node:url';

import express from 'express';

const HOST_IDENTITY = {
  git_name: 'Dev User',
  git_email: 'dev@example.com',
};

type StoredConfig = { git_name: string | null; git_email: string | null };

// Mutable fixture state, reset per test.
const state = {
  jwtRole: 'user' as string,
  storedRole: 'user' as string | null,
  stored: { git_name: null, git_email: null } as StoredConfig,
  systemReads: 0,
  writes: [] as Array<{ userId: number; name: string | null; email: string | null }>,
};

const dbIndexUrl = pathToFileURL(
  path.resolve(import.meta.dirname, '../modules/database/index.js')
).href;
const authUrl = pathToFileURL(
  path.resolve(import.meta.dirname, '../middleware/auth.js')
).href;
const gitConfigUrl = pathToFileURL(
  path.resolve(import.meta.dirname, '../utils/gitConfig.js')
).href;
const claudeOnboardingUrl = pathToFileURL(
  path.resolve(import.meta.dirname, '../services/isolation/claude-onboarding.service.js')
).href;
const agyOnboardingUrl = pathToFileURL(
  path.resolve(import.meta.dirname, '../services/isolation/agy-onboarding.service.js')
).href;

mock.module(dbIndexUrl, {
  namedExports: {
    userDb: {
      getGitConfig: () => ({ ...state.stored }),
      updateGitConfig: (userId: number, name: string | null, email: string | null) => {
        state.writes.push({ userId, name, email });
        state.stored = { git_name: name, git_email: email };
      },
      getUserById: (id: number) =>
        state.storedRole === null
          ? undefined
          : { id, username: 'member', role: state.storedRole },
      completeOnboarding: () => {},
      hasCompletedOnboarding: () => true,
    },
  },
});

mock.module(authUrl, {
  namedExports: {
    authenticateToken: (
      req: express.Request & { user?: unknown },
      _res: express.Response,
      next: express.NextFunction
    ) => {
      req.user = { id: 7, username: 'wiki-diag-test', role: state.jwtRole };
      next();
    },
  },
});

mock.module(gitConfigUrl, {
  namedExports: {
    getSystemGitConfig: async () => {
      state.systemReads += 1;
      return { ...HOST_IDENTITY };
    },
  },
});

mock.module(claudeOnboardingUrl, {
  namedExports: { getClaudeConnectionStatus: async () => ({ connected: false }) },
});
mock.module(agyOnboardingUrl, {
  namedExports: { getAgyConnectionStatus: async () => ({ connected: false }) },
});

const { default: userRouter } = await import('./user.js');

async function getGitConfig() {
  const app = express();
  app.use(express.json());
  app.use('/api/user', userRouter);
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const { port } = server.address() as AddressInfo;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/user/git-config`);
    return (await res.json()) as { gitName: string | null; gitEmail: string | null };
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

function reset(options: {
  jwtRole?: string;
  storedRole?: string | null;
  stored?: StoredConfig;
}) {
  state.jwtRole = options.jwtRole ?? options.storedRole ?? 'user';
  state.storedRole = options.storedRole === undefined ? 'user' : options.storedRole;
  state.stored = options.stored ?? { git_name: null, git_email: null };
  state.systemReads = 0;
  state.writes = [];
}

test('a new member with no stored identity never receives the host git identity', async () => {
  reset({ storedRole: 'user' });

  const payload = await getGitConfig();

  assert.equal(payload.gitName, null, 'the wizard must not pre-fill another user name');
  assert.equal(payload.gitEmail, null, 'the wizard must not pre-fill another user email');
  assert.equal(state.systemReads, 0, 'the host global git config must not even be read');
  assert.deepEqual(state.writes, [], 'no foreign identity may be persisted into the member row');
});

test('a member row already poisoned with the host identity is cleared on read', async () => {
  reset({ storedRole: 'user', stored: { ...HOST_IDENTITY } });

  const payload = await getGitConfig();

  assert.equal(payload.gitName, null);
  assert.equal(payload.gitEmail, null);
  assert.deepEqual(
    state.writes,
    [{ userId: 7, name: null, email: null }],
    'the leaked identity must be removed from the row, not just hidden'
  );
});

test("a member's own stored identity is returned untouched", async () => {
  const own = { git_name: 'Other User', git_email: 'other@example.com' };
  reset({ storedRole: 'user', stored: { ...own } });

  const payload = await getGitConfig();

  assert.equal(payload.gitName, own.git_name);
  assert.equal(payload.gitEmail, own.git_email);
  assert.deepEqual(state.writes, [], 'a legitimate identity must never be cleared');
});

test('the owner still inherits the host git identity (owner experience preserved)', async () => {
  reset({ storedRole: 'owner' });

  const payload = await getGitConfig();

  assert.equal(payload.gitName, HOST_IDENTITY.git_name);
  assert.equal(payload.gitEmail, HOST_IDENTITY.git_email);
  assert.deepEqual(state.writes, [
    { userId: 7, name: HOST_IDENTITY.git_name, email: HOST_IDENTITY.git_email },
  ]);
});

test("the owner's stored identity equal to the host one is kept, not scrubbed", async () => {
  reset({ storedRole: 'owner', stored: { ...HOST_IDENTITY } });

  const payload = await getGitConfig();

  assert.equal(payload.gitName, HOST_IDENTITY.git_name);
  assert.equal(payload.gitEmail, HOST_IDENTITY.git_email);
  assert.deepEqual(state.writes, [], 'the owner row must not be modified');
});

test('the owner privilege comes from the DB row, not from the JWT claim', async () => {
  // Stale/forged token claiming owner while the stored role is a plain member.
  reset({ jwtRole: 'owner', storedRole: 'user' });

  const payload = await getGitConfig();

  assert.equal(payload.gitName, null);
  assert.equal(payload.gitEmail, null);
  assert.equal(state.systemReads, 0);
});

test('an unreadable user row falls back to no inheritance (fail-closed)', async () => {
  reset({ jwtRole: 'owner', storedRole: null });

  const payload = await getGitConfig();

  assert.equal(payload.gitName, null);
  assert.equal(payload.gitEmail, null);
  assert.deepEqual(state.writes, []);
});
