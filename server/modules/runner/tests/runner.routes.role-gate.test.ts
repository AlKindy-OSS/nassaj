/**
 * Authorization tests for the runner bridge routes (runner.routes.ts).
 *
 * The five control verbs (start/stop/pause/resume/approve) write control files
 * that launch self-driving `claude -p` sessions which consume Anthropic quota,
 * mutate the repo and approve phase transitions. The contract describes the
 * actor as "the owner", so these verbs are gated with requireRole('owner',
 * 'admin'); GET stays open to any authenticated user (read-only status).
 *
 * These tests mount the real router (with the real requireRole middleware) and
 * inject a configurable user role via a stand-in auth middleware, asserting:
 *  - a plain 'user' role gets 403 on every control verb and the service is NEVER
 *    invoked (the gate runs before the handler).
 *  - 'owner' and 'admin' pass the gate and reach the handler.
 *  - GET /:projectId is reachable by a plain 'user'.
 *
 * Framework: node:test (built-in) + node:assert/strict via tsx, matching the
 * existing server suite. The runner-bridge / watcher services and the database
 * index are isolated with node:test module mocking (requires
 * --experimental-test-module-mocks) so no filesystem or DB is touched. auth.js
 * reads its JWT secret from the mocked db when env is unset.
 */

import assert from 'node:assert/strict';
import { AddressInfo } from 'node:net';
import path from 'node:path';
import test, { mock } from 'node:test';
import { pathToFileURL } from 'node:url';

import express from 'express';

// Make the run deterministic: auth.js resolves its JWT secret at load time (env
// first, then the db). Removing the env var forces the mocked db path.
delete process.env.JWT_SECRET;

// Track which bridge service functions are invoked so we can prove the role gate
// short-circuits BEFORE the handler runs for an unauthorized user.
const calls: string[] = [];

const bridgeUrl = pathToFileURL(
  path.resolve(import.meta.dirname, '../runner-bridge.service.js')
).href;
const watcherUrl = pathToFileURL(
  path.resolve(import.meta.dirname, '../runner-watcher.service.js')
).href;
const dbIndexUrl = pathToFileURL(
  path.resolve(import.meta.dirname, '../../database/index.js')
).href;

// A merged status fixture (v2); awaiting_approval so the approve verb passes its
// stage guard once the role gate is cleared. `cycleStage` is mutable so a test
// can drive the approve 409 branch (stage != awaiting_approval).
let cycleStage = 'awaiting_approval';
const statusFixture = () => ({
  registered: true,
  name: 'demo',
  dir: '/tmp/demo',
  enabled: true,
  priority: 1,
  paused: false,
  // v2: stage lives in checkpoint.pointer.stage
  checkpoint: {
    schema_version: '2.0',
    project: 'demo',
    pointer: { phase: 'S0', cycle: 1, active_task_id: 'T-01', stage: cycleStage },
    progress: { done: [], remaining: [], partial: {} },
    blocked: {},
    last_commit: 'abc1234',
    last_updated: new Date().toISOString(),
  },
  supervisor: null,
  config: null,
  stateError: false,
});

mock.module(bridgeUrl, {
  namedExports: {
    readRunnerStatus: async () => {
      calls.push('readRunnerStatus');
      return statusFixture();
    },
    resolveRunnerProject: async () => {
      calls.push('resolveRunnerProject');
      return { name: 'demo' };
    },
    startRunner: async () => {
      calls.push('startRunner');
      return true;
    },
    stopRunner: async () => {
      calls.push('stopRunner');
      return true;
    },
    forceStopRunner: async () => {
      calls.push('forceStopRunner');
      return true;
    },
    pauseRunner: async () => {
      calls.push('pauseRunner');
    },
    resumeRunner: async () => {
      calls.push('resumeRunner');
    },
    approveNextPhase: async () => {
      calls.push('approveNextPhase');
    },
    readPendingApproval: async () => {
      calls.push('readPendingApproval');
      return { id: 'T-01__secret', task_id: 'T-01', phase_id: 'S0', kind: 'secret', reason: 'x' };
    },
    approveApproval: async () => {
      calls.push('approveApproval');
    },
    rejectApproval: async () => {
      calls.push('rejectApproval');
    },
    findRunnerProjectName: async () => 'demo',
  },
});

mock.module(watcherUrl, {
  namedExports: {
    ensureRunnerWatcher: () => {},
    broadcastNow: () => {},
  },
});

mock.module(dbIndexUrl, {
  namedExports: {
    projectsDb: {
      // Any non-empty path resolves; the bridge mock handles the rest.
      getProjectPathById: () => '/tmp/demo',
    },
    // auth.js falls back to this when process.env.JWT_SECRET is unset.
    appConfigDb: {
      getOrCreateJwtSecret: () => 'nassaj-runner-test-jwt-secret-0123456789abcd',
    },
    // auth.js records failures via auditLogDb.record on a 403.
    auditLogDb: { record: () => {} },
    userDb: {},
    initializeDatabase: () => {},
    closeConnection: () => {},
    getConnection: () => ({}),
    getDatabasePath: () => ':memory:',
  },
});

// Import the router and the control-guard seam after mocks are registered, then
// inject a guard equivalent to the one server/index.js wires
// (requireRole('owner','admin')) via the router's setRunnerControlGuard() seam.
// We replicate requireRole inline rather than importing it directly: the backend
// boundaries plugin classifies module routers, and a test reaching into
// server/middleware/* would be an unclassified cross-element dependency. The
// production wiring (the real requireRole) is what index.js passes to this same
// seam, so the seam + the role semantics are both covered.
const { default: runnerRouter, setRunnerControlGuard } = await import('../runner.routes.js');

const requireOwnerOrAdmin: express.RequestHandler = (req, res, next) => {
  const role = (req as express.Request & { user?: { role?: string } }).user?.role;
  if (!role || !['owner', 'admin'].includes(role)) {
    return res.status(403).json({ error: 'Insufficient permissions' });
  }
  next();
};
setRunnerControlGuard(requireOwnerOrAdmin);

// Mutable role for the injected stand-in user, switched per test.
let currentRole: string = 'user';

async function buildServer() {
  calls.length = 0;
  cycleStage = 'awaiting_approval';
  const app = express();
  app.use(express.json());
  // Stand-in for authenticateToken: inject a user with the role under test.
  app.use((req, _res, next) => {
    (req as express.Request & { user: unknown }).user = {
      id: 1,
      username: currentRole,
      role: currentRole,
    };
    next();
  });
  app.use('/api/runner', runnerRouter);

  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const { port } = server.address() as AddressInfo;

  const request = async (method: string, urlPath: string) => {
    const res = await fetch(`http://127.0.0.1:${port}${urlPath}`, { method });
    return { status: res.status };
  };

  const close = () => new Promise<void>((resolve) => server.close(() => resolve()));
  return { request, close };
}

const CONTROL_VERBS = ['start', 'stop', 'pause', 'resume', 'force-stop', 'approve'] as const;

for (const verb of CONTROL_VERBS) {
  test(`POST /api/runner/:id/${verb} is 403 for a plain user and never reaches the handler`, async () => {
    currentRole = 'user';
    const srv = await buildServer();
    try {
      const { status } = await srv.request('POST', `/api/runner/demo/${verb}`);
      assert.equal(status, 403, `${verb} must be forbidden for role=user`);
      // The gate must short-circuit before any service work.
      assert.deepEqual(
        calls,
        [],
        `${verb} must not invoke any bridge service when forbidden (calls: ${calls.join(',')})`
      );
    } finally {
      await srv.close();
    }
  });
}

for (const role of ['owner', 'admin'] as const) {
  test(`POST /api/runner/:id/start passes the role gate for role=${role}`, async () => {
    currentRole = role;
    const srv = await buildServer();
    try {
      const { status } = await srv.request('POST', '/api/runner/demo/start');
      assert.equal(status, 200, `start must succeed for role=${role}`);
      assert.ok(calls.includes('startRunner'), 'handler must run for an authorized role');
    } finally {
      await srv.close();
    }
  });

  test(`POST /api/runner/:id/force-stop passes the role gate for role=${role}`, async () => {
    currentRole = role;
    const srv = await buildServer();
    try {
      const { status } = await srv.request('POST', '/api/runner/demo/force-stop');
      assert.equal(status, 200, `force-stop must succeed for role=${role}`);
      assert.ok(
        calls.includes('forceStopRunner'),
        'handler must run for an authorized role',
      );
    } finally {
      await srv.close();
    }
  });

  test(`POST /api/runner/:id/approve passes the role gate for role=${role}`, async () => {
    currentRole = role;
    const srv = await buildServer();
    try {
      const { status } = await srv.request('POST', '/api/runner/demo/approve');
      // awaiting_approval fixture => 200; the point is it is NOT 403.
      assert.notEqual(status, 403, `approve must clear the role gate for role=${role}`);
      assert.equal(status, 200);
    } finally {
      await srv.close();
    }
  });
}

test('POST /api/runner/:id/approve is 409 when the runner is NOT awaiting approval', async () => {
  // Role gate cleared (owner) but the stage guard must reject a stale approval
  // so it is not consumed by a future awaiting_approval boundary.
  currentRole = 'owner';
  const srv = await buildServer();
  cycleStage = 'fix'; // any non-awaiting stage
  try {
    const { status } = await srv.request('POST', '/api/runner/demo/approve');
    assert.equal(status, 409, 'approve must 409 unless stage=awaiting_approval');
    assert.ok(
      !calls.includes('approveNextPhase'),
      'the control file must NOT be written when not awaiting approval'
    );
  } finally {
    await srv.close();
  }
});

test('GET /api/runner/:id stays open to a plain user (read-only status)', async () => {
  currentRole = 'user';
  const srv = await buildServer();
  try {
    const { status } = await srv.request('GET', '/api/runner/demo');
    assert.equal(status, 200, 'read-only status must be reachable by any authenticated user');
    assert.ok(calls.includes('readRunnerStatus'), 'GET must reach the status reader');
  } finally {
    await srv.close();
  }
});
