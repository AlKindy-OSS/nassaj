/**
 * Authorization tests for the plugin management routes (server/routes/plugins.js).
 *
 * B-134 (critical): /api/plugins was mounted with authenticateToken only (no
 * requireRole in server/index.js), so ANY authenticated user — not just the
 * owner — could POST /install, which clones an attacker-suppliable git URL and
 * runs its build script on the host (RCE), plus update / enable / uninstall.
 * The four state-mutating lifecycle verbs are now gated with
 * requireRole('owner','admin'); the read routes (list / manifest / assets) and
 * the rpc data-plane proxy stay open to any authenticated user.
 *
 * These tests mount the REAL plugins router (with the REAL requireRole baked in
 * by the route edit — plugins.js imports it directly, no seam) and inject a
 * configurable user role via a stand-in auth middleware, asserting:
 *  - role 'user' -> 403 on every gated verb, and the plugin loader / process
 *    manager are NEVER invoked (the gate short-circuits before the handler).
 *  - roles 'owner' and 'admin' clear the gate and reach the handler.
 *  - GET / (list) stays reachable by a plain 'user'.
 *
 * Framework: node:test (built-in) + node:assert/strict via tsx, matching the
 * server suite (package.json "test"; vitest here is client-only, scoped to
 * src/** by vite.config.js). The plugin loader / process manager and the
 * database index are isolated with node:test module mocking (requires
 * --experimental-test-module-mocks) so no filesystem, git, subprocess or DB is
 * touched. auth.js reads its JWT secret from the mocked db when env is unset.
 */

import assert from 'node:assert/strict';
import { AddressInfo } from 'node:net';
import path from 'node:path';
import test, { mock } from 'node:test';
import { pathToFileURL } from 'node:url';

import express from 'express';

// auth.js resolves its JWT secret at load time (env first, then db). Removing the
// env var forces the deterministic mocked-db path.
delete process.env.JWT_SECRET;

// Track which loader / process-manager functions run so we can prove the role
// gate short-circuits BEFORE the handler for an unauthorized user.
const calls: string[] = [];

const loaderUrl = pathToFileURL(
  path.resolve(import.meta.dirname, '../utils/plugin-loader.js')
).href;
const procMgrUrl = pathToFileURL(
  path.resolve(import.meta.dirname, '../utils/plugin-process-manager.js')
).href;
const dbIndexUrl = pathToFileURL(
  path.resolve(import.meta.dirname, '../modules/database/index.js')
).href;

// Loader mock: every export a no-op that records its name and returns a benign
// value, so a handler that runs past the gate does no real git/fs work but we
// can still see it executed.
mock.module(loaderUrl, {
  namedExports: {
    scanPlugins: () => {
      calls.push('scanPlugins');
      return [];
    },
    getPluginsConfig: () => {
      calls.push('getPluginsConfig');
      return {};
    },
    getPluginsDir: () => {
      calls.push('getPluginsDir');
      return '/tmp/plugins';
    },
    savePluginsConfig: () => {
      calls.push('savePluginsConfig');
    },
    getPluginDir: () => {
      calls.push('getPluginDir');
      return '/tmp/plugins/demo';
    },
    resolvePluginAssetPath: () => {
      calls.push('resolvePluginAssetPath');
      return null;
    },
    installPluginFromGit: async () => {
      calls.push('installPluginFromGit');
      return { name: 'demo' };
    },
    updatePluginFromGit: async () => {
      calls.push('updatePluginFromGit');
      return { name: 'demo' };
    },
    uninstallPlugin: async () => {
      calls.push('uninstallPlugin');
    },
  },
});

mock.module(procMgrUrl, {
  namedExports: {
    startPluginServer: async () => {
      calls.push('startPluginServer');
      return 12345;
    },
    stopPluginServer: async () => {
      calls.push('stopPluginServer');
    },
    getPluginPort: () => {
      calls.push('getPluginPort');
      return null;
    },
    isPluginRunning: () => {
      calls.push('isPluginRunning');
      return false;
    },
  },
});

mock.module(dbIndexUrl, {
  namedExports: {
    // auth.js falls back to this when process.env.JWT_SECRET is unset.
    appConfigDb: {
      getOrCreateJwtSecret: () => 'nassaj-plugins-test-jwt-secret-0123456789abcd',
    },
    // requireRole records a row via auditLogDb.record on a 403 (and
    // auth-rejection-audit.js imports the same auditLogDb).
    auditLogDb: { record: () => {} },
    userDb: {},
    initializeDatabase: () => {},
    closeConnection: () => {},
    getConnection: () => ({}),
    getDatabasePath: () => ':memory:',
  },
});

// Import the router AFTER the mocks are registered. plugins.js imports the REAL
// requireRole from ../middleware/auth.js, so the production gate is exercised.
const { default: pluginsRouter } = await import('./plugins.js');

// Mutable role for the injected stand-in user, switched per test.
let currentRole = 'user';

async function buildServer() {
  calls.length = 0;
  const app = express();
  app.use(express.json());
  // Stand-in for authenticateToken (server/index.js mounts it before the router):
  // inject a user carrying the role under test so requireRole has something to read.
  app.use((req, _res, next) => {
    (req as express.Request & { user: unknown }).user = {
      id: 1,
      username: currentRole,
      role: currentRole,
    };
    next();
  });
  app.use('/api/plugins', pluginsRouter);

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

// The four state-mutating verbs the fix gates. `handlerCall` is a loader/proc-mgr
// function the handler invokes once the gate is cleared — its presence in `calls`
// proves execution reached the handler body (i.e. the gate passed).
const GATED = [
  {
    name: 'POST /install',
    method: 'POST',
    path: '/api/plugins/install',
    body: { url: 'https://example.com/evil.git' },
    handlerCall: 'installPluginFromGit',
  },
  {
    name: 'POST /:name/update',
    method: 'POST',
    path: '/api/plugins/demo/update',
    body: {},
    handlerCall: 'updatePluginFromGit',
  },
  {
    name: 'PUT /:name/enable',
    method: 'PUT',
    path: '/api/plugins/demo/enable',
    body: { enabled: true },
    handlerCall: 'scanPlugins',
  },
  {
    name: 'DELETE /:name',
    method: 'DELETE',
    path: '/api/plugins/demo',
    body: undefined,
    handlerCall: 'uninstallPlugin',
  },
] as const;

for (const verb of GATED) {
  test(`${verb.name} is 403 for a plain user and never reaches the handler`, async () => {
    currentRole = 'user';
    const srv = await buildServer();
    try {
      const { status } = await srv.request(verb.method, verb.path, verb.body);
      assert.equal(status, 403, `${verb.name} must be forbidden for role=user`);
      // The gate must short-circuit before ANY loader / process-manager work —
      // this is what would fail if the requireRole middleware were missing.
      assert.deepEqual(
        calls,
        [],
        `${verb.name} must not invoke any plugin loader/process work when forbidden (calls: ${calls.join(',')})`
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
          `${verb.name} handler must run for role=${role} (calls: ${calls.join(',')})`
        );
      } finally {
        await srv.close();
      }
    });
  }
}

test('GET / (list plugins) stays open to a plain user (read-only, ungated)', async () => {
  currentRole = 'user';
  const srv = await buildServer();
  try {
    const { status } = await srv.request('GET', '/api/plugins/');
    assert.equal(status, 200, 'read-only plugin list must be reachable by any authenticated user');
    assert.ok(calls.includes('scanPlugins'), 'GET / must reach the plugin scanner');
  } finally {
    await srv.close();
  }
});
