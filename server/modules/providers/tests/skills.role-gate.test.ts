/**
 * Authorization tests for the provider skill WRITE routes
 * (server/modules/providers/provider.routes.ts).
 *
 * T-926 (security gate): the provider skill service reads and writes under the
 * shared owner home (os.homedir()/.claude and siblings) with no per-user
 * CLAUDE_CONFIG_DIR isolation (B-26), so any member's write mutates every
 * member's skills. The two state-mutating verbs — POST /:provider/skills
 * (install/overwrite) and DELETE /:provider/skills/:name (uninstall) — are
 * therefore restricted to owner/admin via an IN-HANDLER role check that reads
 * req.user.role directly; the read route GET /:provider/skills stays open.
 *
 * WHY in-handler and not a mounted path-matching guard: Express routing is
 * case-INSENSITIVE, so `POST /api/providers/claude/SKILLS` reaches the same
 * handler as `/skills`. A guard keyed on a case-sensitive path regex let that
 * request slip past the role check (qa-critic veto, proven live). Reading the
 * role inside the handler is immune to path casing/formatting. The dedicated
 * UPPERCASE/mixed-case cases below lock that regression shut.
 *
 * These tests mount the REAL provider router and inject a configurable user role
 * via a stand-in auth middleware (what server/index.js's authenticateToken does
 * in production), asserting:
 *  - role 'user' -> 403 on POST and DELETE (incl. /SKILLS, /Skills), and the
 *    skills service is NEVER invoked (the gate short-circuits the handler).
 *  - roles 'owner' and 'admin' clear the gate and reach the handler.
 *  - GET /:provider/skills stays reachable by a plain 'user'.
 *
 * Framework: node:test with --experimental-test-module-mocks. The skills service
 * and the database barrel are isolated with module mocking so no filesystem or DB
 * is touched.
 */

import assert from 'node:assert/strict';
import { AddressInfo } from 'node:net';
import path from 'node:path';
import test, { mock } from 'node:test';
import { pathToFileURL } from 'node:url';

import express from 'express';

import { mockDatabaseBarrel } from './helpers/database-barrel-mock.js';

// auth.js resolves its JWT secret at load time (env first, then db). Removing the
// env var forces the deterministic mocked-db path if auth.js is transitively hit.
delete process.env.JWT_SECRET;

// Track which skills-service functions run so we can prove the role gate
// short-circuits BEFORE the handler for an unauthorized user.
const calls: string[] = [];

const skillsServiceUrl = pathToFileURL(
  path.resolve(import.meta.dirname, '../services/skills.service.js'),
).href;
const dbIndexUrl = pathToFileURL(
  path.resolve(import.meta.dirname, '../../database/index.js'),
).href;

mock.module(skillsServiceUrl, {
  namedExports: {
    providerSkillsService: {
      listProviderSkills: async () => {
        calls.push('listProviderSkills');
        return [];
      },
      addProviderSkills: async () => {
        calls.push('addProviderSkills');
        return [];
      },
      removeProviderSkill: async () => {
        calls.push('removeProviderSkill');
        return {
          provider: 'claude',
          name: 'demo',
          description: '',
          command: '/demo',
          scope: 'user',
          sourcePath: '/tmp/demo/SKILL.md',
        };
      },
    },
  },
});

// The provider registry eagerly instantiates every provider, and several of
// them statically import repository singletons from the database barrel at load
// time. ESM validates named imports structurally, so the mock must expose EVERY
// value export of @/modules/database/index.js. The export list is derived from
// the real barrel (helpers/database-barrel-mock.ts): repositories become
// permissive Proxy stubs and functions inert no-ops, so adding an export to the
// barrel can no longer break this test. Only what the gate path calls is
// overridden below.
await mockDatabaseBarrel(dbIndexUrl, {
  // auth.js falls back to this when process.env.JWT_SECRET is unset.
  appConfigDb: {
    getOrCreateJwtSecret: () => 'nassaj-skills-test-jwt-secret-0123456789abcd',
  },
  auditLogDb: { record: () => {} },
  getConnection: () => ({}),
  getDatabasePath: () => ':memory:',
  hashMessageAuthorContent: () => '',
  // (value: unknown) => number | null — no stored row exists in this test.
  parseStoredTimestampMs: () => null,
});

// Import the router AFTER the mocks are registered.
const { default: providerRouter } = await import('../provider.routes.js');

// Mutable role for the injected stand-in user, switched per test.
let currentRole = 'user';

async function buildServer() {
  calls.length = 0;
  const app = express();
  app.use(express.json());
  // Stand-in for authenticateToken (server/index.js mounts it before the router):
  // inject a user carrying the role under test so the handler role check reads it.
  app.use('/api/providers', (req, _res, next) => {
    (req as express.Request & { user: unknown }).user = {
      id: 1,
      username: currentRole,
      role: currentRole,
    };
    next();
  }, providerRouter);

  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const { port } = server.address() as AddressInfo;

  const request = async (method: string, urlPath: string, body?: unknown) => {
    const res = await fetch(`http://127.0.0.1:${port}${urlPath}`, {
      method,
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status };
  };

  const close = () => new Promise<void>((resolve) => server.close(() => resolve()));
  return { request, close };
}

const POST_BODY = {
  entries: [
    { directoryName: 'demo', content: '---\nname: demo\ndescription: d\n---\n\nBody.\n' },
  ],
};

// The two state-mutating verbs the gate protects, each exercised at the canonical
// lowercase path AND at UPPERCASE/mixed-case variants. Express matches all of them
// to the same handler (case-insensitive routing), so all must be gated equally.
// `handlerCall` is the skills-service fn the handler invokes once the gate clears.
const GATED = [
  {
    name: 'POST /:provider/skills',
    method: 'POST',
    path: '/api/providers/claude/skills',
    body: POST_BODY,
    handlerCall: 'addProviderSkills',
  },
  {
    name: 'POST /:provider/SKILLS (uppercase)',
    method: 'POST',
    path: '/api/providers/claude/SKILLS',
    body: POST_BODY,
    handlerCall: 'addProviderSkills',
  },
  {
    name: 'POST /:provider/Skills (mixed case)',
    method: 'POST',
    path: '/api/providers/claude/Skills',
    body: POST_BODY,
    handlerCall: 'addProviderSkills',
  },
  {
    name: 'DELETE /:provider/skills/:name',
    method: 'DELETE',
    path: '/api/providers/claude/skills/demo',
    body: undefined,
    handlerCall: 'removeProviderSkill',
  },
  {
    name: 'DELETE /:provider/SKILLS/:name (uppercase)',
    method: 'DELETE',
    path: '/api/providers/claude/SKILLS/demo',
    body: undefined,
    handlerCall: 'removeProviderSkill',
  },
  {
    name: 'DELETE /:provider/Skills/:name (mixed case)',
    method: 'DELETE',
    path: '/api/providers/claude/Skills/demo',
    body: undefined,
    handlerCall: 'removeProviderSkill',
  },
] as const;

for (const verb of GATED) {
  test(`${verb.name} is 403 for a plain user and never reaches the handler`, async () => {
    currentRole = 'user';
    const srv = await buildServer();
    try {
      const { status } = await srv.request(verb.method, verb.path, verb.body);
      assert.equal(status, 403, `${verb.name} must be forbidden for role=user`);
      // The gate must short-circuit before ANY skills-service work — this is what
      // would (and did) fail when a case-sensitive path guard was bypassed.
      assert.deepEqual(
        calls,
        [],
        `${verb.name} must not invoke any skills service work when forbidden (calls: ${calls.join(',')})`,
      );
    } finally {
      await srv.close();
    }
  });
}

for (const role of ['owner', 'admin'] as const) {
  for (const verb of GATED) {
    test(`${verb.name} passes the role gate for role=${role}`, async () => {
      currentRole = role;
      const srv = await buildServer();
      try {
        const { status } = await srv.request(verb.method, verb.path, verb.body);
        assert.notEqual(status, 403, `${verb.name} must clear the role gate for role=${role}`);
        assert.ok(
          calls.includes(verb.handlerCall),
          `${verb.name} handler must run for role=${role} (calls: ${calls.join(',')})`,
        );
      } finally {
        await srv.close();
      }
    });
  }
}

test('GET /:provider/skills (list) stays open to a plain user (read-only, ungated)', async () => {
  currentRole = 'user';
  const srv = await buildServer();
  try {
    const { status } = await srv.request('GET', '/api/providers/claude/skills');
    assert.equal(status, 200, 'read-only skill list must be reachable by any authenticated user');
    assert.ok(calls.includes('listProviderSkills'), 'GET must reach the skills service');
  } finally {
    await srv.close();
  }
});
