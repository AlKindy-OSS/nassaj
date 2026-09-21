/**
 * Project cost & stats routes — authorization and honesty.
 *
 * TWO THINGS ARE UNDER TEST, and they are the two ways this surface can do real
 * damage:
 *
 *  1. **It must not leak.** A project's cost is derived from its conversations,
 *     so anyone who may not read the project may not price it. The dangerous
 *     failure is not a 200 to a stranger — it is a 403, or a differently-worded
 *     404, on a PRIVATE project, because that turns the endpoint into an oracle
 *     that enumerates which private projects exist. The crux test therefore
 *     asserts byte-identical refusals for "private project you are not in" and
 *     "project id that does not exist", and that the ledger is never even
 *     consulted for a refused caller.
 *
 *  2. **It must not invent a number.** ADR-078: no price / no data ⇒ unavailable,
 *     never `0.00` standing in for unknown. The ledger is mocked to answer with
 *     missing, null and malformed fields, and the route is asserted to answer
 *     `null` — never `0` — and to default `complete` to false.
 *
 * The router is mounted over a real (throwaway) SQLite database behind an
 * injected `req.user`, exactly as index.js does after authenticateToken, and the
 * production global error middleware is reproduced so the status codes asserted
 * here are the ones a client actually receives.
 *
 * The cost ledger is mocked: this file tests the API surface (gate, shaping,
 * envelope), not the ledger's arithmetic, which has its own tests.
 *
 * Framework: node:test + node:assert/strict via tsx.
 * Run:
 *   DATABASE_PATH="$(mktemp -d)/auth.db" npx tsx --experimental-test-module-mocks \
 *     --tsconfig server/tsconfig.json --test \
 *     server/modules/projects/tests/project-stats.routes.test.ts
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test, { after, before, beforeEach, mock } from 'node:test';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

import express from 'express';

const url = (relative: string): string => pathToFileURL(path.resolve(import.meta.dirname, relative)).href;

// ---------------------------------------------------------------------------
// Ledger double. Every answer is settable per test; every call is counted, so a
// test can prove the ledger was NOT reached (the authorization crux).
// ---------------------------------------------------------------------------

type LedgerCalls = { scan: number; total: number; daily: number; stats: number };

const calls: LedgerCalls = { scan: 0, total: 0, daily: 0, stats: 0 };

let totalAnswer: unknown = {};
let dailyAnswer: unknown = [];
let statsAnswer: unknown = {};
let scanAnswer: unknown = {};
let lastDailyWindow: unknown = 'never-called';

function resetLedger(): void {
  calls.scan = 0;
  calls.total = 0;
  calls.daily = 0;
  calls.stats = 0;
  totalAnswer = {
    totalUsd: 1234.5,
    measured: true,
    complete: true,
    unpricedModels: [],
    assumedModels: [],
    sessions: 7,
    activeDays: 2,
    firstDay: '2026-06-01',
    lastDay: '2026-07-28',
    pricesAsOf: '2026-07-28',
  };
  dailyAnswer = [
    {
      day: '2026-06-01', costUsd: 10.5, requests: 3, sessions: 1,
      complete: true, unpriced: false, assumed: false,
    },
    {
      day: '2026-07-28', costUsd: 1224, requests: 40, sessions: 6,
      complete: false, unpriced: false, assumed: true,
    },
  ];
  statsAnswer = {
    activeDays: 2,
    gaps: [],
    byVendor: [{
      vendor: 'anthropic', totalUsd: 1234.5, requests: 43,
      complete: true, unpriced: false, assumed: false,
    }],
    byModel: [{
      model: 'claude-opus-5', totalUsd: 1234.5, requests: 43,
      complete: true, unpriced: false, assumed: false,
    }],
  };
  scanAnswer = { scannedFiles: 432, updatedSessions: 268 };
  lastDailyWindow = 'never-called';
}

resetLedger();

mock.module(url('../../providers/services/cost/cost-ledger.service.js'), {
  namedExports: {
    costLedgerService: {
      scan: async () => {
        calls.scan += 1;
        return scanAnswer;
      },
      getProjectTotal: async () => {
        calls.total += 1;
        return totalAnswer;
      },
      getProjectDaily: async (_projectId: string, window?: unknown) => {
        calls.daily += 1;
        lastDailyWindow = window;
        return dailyAnswer;
      },
      getProjectStats: async () => {
        calls.stats += 1;
        return statsAnswer;
      },
    },
    // The providers barrel re-exports the scheduler alongside the service, and a
    // module mock replaces the module WHOLE — omitting these makes the barrel
    // fail to instantiate, which surfaces as an unrelated-looking import error.
    // They are inert here on purpose: this file must never start a real timer.
    startCostLedgerScheduler: () => {},
    stopCostLedgerScheduler: () => {},
  },
});

// Imported AFTER the mock is registered so the router binds to the double.
const { closeConnection, initializeDatabase, projectsDb, sessionAgentsDb, sessionsDb, userDb } = await import(
  '@/modules/database/index.js'
);
const { AppError } = await import('@/shared/utils.js');
// Via the providers barrel — the same public entry point the router uses, so this
// test also proves the barrel really exposes what the route depends on.
const { PRICES_AS_OF } = await import('@/modules/providers/index.js');
const projectStatsRouter = (await import('../project-stats.routes.js')).default;

type TestUser = { id: number; role: string };

let currentUser: TestUser | null = null;
let server: Server;
let baseUrl = '';
let dbDir = '';
let workspaceRoot = '';

let ownerUser: TestUser;
let adminUser: TestUser;
let strangerUser: TestUser;

let publicProjectId = '';
let publicProjectPath = '';
let privateProjectId = '';

const UNKNOWN_PROJECT_ID = 'this-project-id-does-not-exist';

async function call(
  method: string,
  urlPath: string,
  user: TestUser | null,
): Promise<{ status: number; body: string; json: Record<string, unknown> }> {
  currentUser = user;
  const response = await fetch(`${baseUrl}${urlPath}`, { method });
  const body = await response.text();
  let json: Record<string, unknown> = {};
  try {
    json = JSON.parse(body) as Record<string, unknown>;
  } catch {
    json = {};
  }
  return { status: response.status, body, json };
}

before(async () => {
  closeConnection();
  dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nassaj-proj-stats-db-'));
  workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nassaj-proj-stats-ws-'));
  process.env.DATABASE_PATH = path.join(dbDir, 'db.sqlite');
  await initializeDatabase();

  ownerUser = userDb.createUser('stats_owner', 'hash', 'owner') as TestUser;
  adminUser = userDb.createUser('stats_admin', 'hash', 'admin') as TestUser;
  // The threat model is a PLAIN member — the live install's ordinary accounts.
  strangerUser = userDb.createUser('stats_stranger', 'hash', 'user') as TestUser;
  assert.equal(strangerUser.role, 'user', 'attacker holds the plain user role');

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { user: TestUser | null }).user = currentUser;
    next();
  });
  app.use('/api/projects', projectStatsRouter);
  // Same shape as the production global error middleware in index.js.
  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (err instanceof AppError) {
      res.status(err.statusCode).json({ success: false, error: { code: err.code, message: err.message } });
      return;
    }
    res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR' } });
  });

  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

beforeEach(() => {
  resetLedger();

  publicProjectPath = fs.mkdtempSync(path.join(workspaceRoot, 'pub-'));
  const publicProject = projectsDb.createProjectPath(publicProjectPath, 'Public Project', ownerUser.id);
  publicProjectId = publicProject.project?.project_id ?? '';

  const privateProjectPath = fs.mkdtempSync(path.join(workspaceRoot, 'priv-'));
  const privateProject = projectsDb.createProjectPath(privateProjectPath, 'Private Project', ownerUser.id);
  privateProjectId = privateProject.project?.project_id ?? '';
  projectsDb.setProjectVisibility(privateProjectId, 'private');

  assert.notEqual(publicProjectId, '', 'fixture public project exists');
  assert.notEqual(privateProjectId, '', 'fixture private project exists');
  assert.equal(projectsDb.getProjectVisibility(privateProjectId), 'private');
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  closeConnection();
  delete process.env.DATABASE_PATH;
  fs.rmSync(dbDir, { recursive: true, force: true });
  fs.rmSync(workspaceRoot, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 1. Authorization
// ---------------------------------------------------------------------------

test('CRUX: an UNKNOWN project id is refused before any ledger read (no existence oracle)', async () => {
  const unknown = await call('GET', `/api/projects/${UNKNOWN_PROJECT_ID}/cost`, strangerUser);

  assert.equal(unknown.status, 404, '404, never 403 — a 403 would confirm the project exists');
  assert.equal((unknown.json.error as { code?: string })?.code, 'PROJECT_NOT_FOUND');

  // The gate must run BEFORE the ledger: a refused caller never causes a read.
  assert.deepEqual(calls, { scan: 0, total: 0, daily: 0, stats: 0 }, 'ledger never consulted for a refused caller');
});

test('CRUX: /stats refuses an unknown id exactly like /cost — same refusal, no ledger read', async () => {
  const unknown = await call('GET', `/api/projects/${UNKNOWN_PROJECT_ID}/stats`, strangerUser);

  assert.equal(unknown.status, 404);
  assert.deepEqual(calls, { scan: 0, total: 0, daily: 0, stats: 0 }, 'ledger never consulted');
});

test('ADR-089: a teammate reads the cost of a project they did not create', async () => {
  const { status, json } = await call('GET', `/api/projects/${privateProjectId}/cost`, strangerUser);

  assert.equal(status, 200, 'project visibility is retired — the team shares every project');
  assert.equal(json.success, true);
  assert.equal(calls.total, 1, 'the ledger IS consulted for an authorized caller');
});

test('the project creator may read the cost of their own private project', async () => {
  const { status, json } = await call('GET', `/api/projects/${privateProjectId}/cost`, ownerUser);

  assert.equal(status, 200);
  assert.equal(json.success, true);
  assert.equal(calls.total, 1, 'the ledger IS consulted for an authorized caller');
});

test('an unauthenticated request is refused 401 before any project lookup', async () => {
  const { status, json } = await call('GET', `/api/projects/${publicProjectId}/cost`, null);

  assert.equal(status, 401);
  assert.equal((json.error as { code?: string })?.code, 'AUTH_REQUIRED');
  assert.equal(calls.total, 0);
});

test('a malformed projectId is rejected 400 without reaching the ledger', async () => {
  const { status, json } = await call('GET', '/api/projects/..%2F..%2Fetc/cost', strangerUser);

  assert.equal(status, 400);
  assert.equal((json.error as { code?: string })?.code, 'INVALID_PROJECT_ID');
  assert.equal(calls.total, 0);
});

// ---------------------------------------------------------------------------
// 2. The scan is not on a GET path, and is owner/admin only
// ---------------------------------------------------------------------------

test('no GET on this router ever triggers a scan', async () => {
  await call('GET', `/api/projects/${publicProjectId}/cost`, ownerUser);
  await call('GET', `/api/projects/${publicProjectId}/stats`, ownerUser);

  assert.equal(calls.scan, 0, 'a GET must never walk thousands of transcripts');
});

test('a plain user cannot trigger a ledger scan; an admin and the owner can', async () => {
  const refused = await call('POST', '/api/projects/cost-ledger/scan', strangerUser);
  assert.equal(refused.status, 403);
  assert.equal((refused.json.error as { code?: string })?.code, 'COST_SCAN_FORBIDDEN');
  assert.equal(calls.scan, 0, 'the expensive walk never started');

  const byAdmin = await call('POST', '/api/projects/cost-ledger/scan', adminUser);
  assert.equal(byAdmin.status, 200);
  assert.equal(byAdmin.json.success, true);
  assert.deepEqual(byAdmin.json.scan, { scannedFiles: 432, updatedSessions: 268 }, 'summary forwarded verbatim');

  const byOwner = await call('POST', '/api/projects/cost-ledger/scan', ownerUser);
  assert.equal(byOwner.status, 200);
  assert.equal(calls.scan, 2);
});

test("'cost-ledger' is never captured as a project id", async () => {
  // Route ordering regression: if /:projectId/cost were declared first, this POST
  // would 404 through the project gate instead of reaching the scan handler.
  const { status } = await call('POST', '/api/projects/cost-ledger/scan', adminUser);
  assert.equal(status, 200);
});

// ---------------------------------------------------------------------------
// 3. Honesty: unknown is null, never 0
// ---------------------------------------------------------------------------

test('GET /cost forwards the ledger figure and dates it with pricesAsOf', async () => {
  const { status, json } = await call('GET', `/api/projects/${publicProjectId}/cost`, ownerUser);

  assert.equal(status, 200);
  assert.deepEqual(json.cost, {
    projectId: publicProjectId,
    totalUsd: 1234.5,
    complete: true,
    unpricedModels: [],
    assumedModels: [],
    firstDay: '2026-06-01',
    lastDay: '2026-07-28',
    pricesAsOf: '2026-07-28',
  });
});

test('CRUX: an empty ledger answers totalUsd null — NOT 0.00 (ADR-078)', async () => {
  totalAnswer = { totalUsd: 0, measured: false, sessions: 0 };

  const { json } = await call('GET', `/api/projects/${publicProjectId}/cost`, ownerUser);
  const cost = json.cost as Record<string, unknown>;

  assert.equal(cost.totalUsd, null, 'unknown spend is null; 0 would read as "measured, and it was free"');
  assert.notEqual(cost.totalUsd, 0);
  assert.equal(cost.complete, false, 'unknown completeness defaults to partial, never to a whole claim');
  assert.equal(cost.firstDay, null);
  assert.equal(cost.lastDay, null);
});

test('malformed ledger fields degrade to null rather than to a fabricated number', async () => {
  totalAnswer = {
    totalUsd: 'a lot',
    complete: 'yes',
    unpricedModels: [null, 'claude-mystery-9', '   '],
    firstDay: 'June',
    lastDay: 20260728,
    sessions: -3,
  };

  const { json } = await call('GET', `/api/projects/${publicProjectId}/cost`, ownerUser);
  const cost = json.cost as Record<string, unknown>;

  assert.equal(cost.totalUsd, null, 'a non-number is unknown, not zero');
  assert.equal(cost.complete, false, "only a literal true counts as complete ('yes' does not)");
  assert.deepEqual(cost.unpricedModels, ['claude-mystery-9'], 'blank/non-string entries dropped');
  assert.equal(cost.firstDay, null, 'a non YYYY-MM-DD value is not a day');
  assert.equal(cost.lastDay, null);
});

test('an unpriced model marks the total partial and names what is missing', async () => {
  totalAnswer = {
    totalUsd: 500,
    complete: false,
    unpricedModels: ['some-unlisted-model'],
    sessions: 2,
    firstDay: '2026-07-01',
    lastDay: '2026-07-28',
  };

  const { json } = await call('GET', `/api/projects/${publicProjectId}/cost`, ownerUser);
  const cost = json.cost as Record<string, unknown>;

  assert.equal(cost.complete, false);
  assert.deepEqual(cost.unpricedModels, ['some-unlisted-model']);
  assert.equal(cost.totalUsd, 500, 'the priced part is still reported — as a floor');
});

// ---------------------------------------------------------------------------
// 4. /stats shaping
// ---------------------------------------------------------------------------

test('GET /stats returns the curve, the groupings and the conversation count', async () => {
  totalAnswer = { ...(totalAnswer as Record<string, unknown>), lastDay: '2026-07-30' };
  sessionsDb.createSession(
    `stats-project-freshness-${Date.now()}`,
    'codex',
    publicProjectPath,
    'Newer than ledger',
    '2026-08-01T00:00:00.000Z',
    '2026-08-19T04:37:53.334Z',
  );
  const { status, json } = await call('GET', `/api/projects/${publicProjectId}/stats`, ownerUser);
  const stats = json.stats as Record<string, unknown>;

  assert.equal(status, 200);
  assert.equal(stats.totalUsd, 1234.5);
  assert.deepEqual(stats.daily, [
    { day: '2026-06-01', costUsd: 10.5, complete: true, unpriced: false, assumed: false },
    { day: '2026-07-28', costUsd: 1224, complete: false, unpriced: false, assumed: true },
  ]);
  assert.equal(stats.activeDays, 2);
  assert.equal(stats.firstActivity, '2026-06-01');
  assert.equal(stats.lastActivity, '2026-07-30');
  assert.equal(stats.dataThrough, '2026-07-30');
  assert.equal(stats.projectActivityThrough, '2026-08-19');
  assert.deepEqual(stats.assumedModels, []);
  assert.deepEqual(stats.gaps, []);
  assert.equal(stats.conversations, 7, 'the LEDGER count (disk), not the sessions-table row count');
  assert.deepEqual(stats.byVendor, [
    // The label comes from the shared vendor map (which calls 'anthropic' → 'Claude'),
    // so the UI never has to carry a second copy of the vendor naming.
    {
      vendor: 'anthropic', displayName: 'Claude', totalUsd: 1234.5, requests: 43,
      complete: true, unpriced: false, assumed: false,
    },
  ]);
  assert.deepEqual(stats.byModel, [{
    model: 'claude-opus-5', totalUsd: 1234.5, requests: 43,
    complete: true, unpriced: false, assumed: false,
  }]);
  assert.equal(stats.pricesAsOf, '2026-07-28');
});

test('CRUX: agents is null (unknown) when no session of the project has been parsed', async () => {
  // A project with a session row whose agent cache was never populated.
  sessionsDb.createSession(
    `stats-session-${Date.now()}`,
    'claude',
    publicProjectPath,
    'Unparsed session',
    undefined,
    undefined,
    path.join(publicProjectPath, 'transcript.jsonl'),
  );

  const { json } = await call('GET', `/api/projects/${publicProjectId}/stats`, ownerUser);
  const stats = json.stats as Record<string, unknown>;

  assert.equal(stats.agents, null, 'never parsed ⇒ unknown roster, not an authoritative empty one');
  assert.notDeepEqual(stats.agents, [], '[] would claim "we looked and there were none"');
});

test('agent rows preserve model/subagent kind so the client does not count models as delegates', async () => {
  const sessionId = `stats-agent-kinds-${Date.now()}`;
  sessionsDb.createSession(
    sessionId,
    'claude',
    publicProjectPath,
    'Parsed session',
    undefined,
    undefined,
    path.join(publicProjectPath, 'parsed.jsonl'),
  );
  sessionAgentsDb.replaceForSession(sessionId, [
    { agent_name: 'claude-opus-5', agent_kind: 'model', invocation_count: 3 },
    { agent_name: 'backend-dev', agent_kind: 'subagent', invocation_count: 2 },
  ], 1);

  const { json } = await call('GET', `/api/projects/${publicProjectId}/stats`, ownerUser);
  const stats = json.stats as Record<string, unknown>;
  assert.deepEqual(stats.agents, [
    { name: 'claude-opus-5', kind: 'model', invocations: 3 },
    { name: 'backend-dev', kind: 'subagent', invocations: 2 },
  ]);
});

test('a narrowed/dropped daily curve does not change the lifetime active-day count', async () => {
  dailyAnswer = [
    { day: '2026-07-01', costUsd: 5 },
    { day: '2026-07-02', costUsd: null },
    { day: 'not-a-day', costUsd: 9 },
    { costUsd: 3 },
  ];

  const { json } = await call('GET', `/api/projects/${publicProjectId}/stats`, ownerUser);
  const stats = json.stats as Record<string, unknown>;

  assert.deepEqual(stats.daily, [{
    day: '2026-07-01', costUsd: 5, complete: false, unpriced: false, assumed: false,
  }]);
  assert.equal(stats.activeDays, 2, 'activeDays is lifetime metadata, not the chart point count');
});

test('daily points preserve complete, unpriced and assumed causes including an all-unpriced zero', async () => {
  dailyAnswer = [
    { day: '2026-07-01', costUsd: 1, complete: true, unpriced: false, assumed: false },
    { day: '2026-07-02', costUsd: 0, complete: false, unpriced: true, assumed: false },
    { day: '2026-07-03', costUsd: 2, complete: false, unpriced: false, assumed: true },
    { day: '2026-07-04', costUsd: 0, complete: false, unpriced: true, assumed: true },
  ];

  const { json } = await call('GET', `/api/projects/${publicProjectId}/stats`, ownerUser);
  const stats = json.stats as Record<string, unknown>;
  assert.deepEqual(stats.daily, dailyAnswer);
});

test('a vendor/model group with no official price reports null, never 0', async () => {
  statsAnswer = {
    activeDays: 1,
    gaps: [{ harness: 'hermes', reason: 'No project attribution key.' }],
    byVendor: [{
      vendor: 'mystery-vendor', totalUsd: 0, requests: 4,
      complete: false, unpriced: true, assumed: false,
    }],
    byModel: [{
      model: 'unlisted-model', totalUsd: 0, requests: 4,
      complete: false, unpriced: true, assumed: false,
    }],
  };

  const { json } = await call('GET', `/api/projects/${publicProjectId}/stats`, ownerUser);
  const stats = json.stats as Record<string, unknown>;

  assert.deepEqual(stats.byVendor, [
    // Unknown vendor keys fall back to the key itself rather than an invented label.
    {
      vendor: 'mystery-vendor', displayName: 'mystery-vendor', totalUsd: null, requests: 4,
      complete: false, unpriced: true, assumed: false,
    },
  ]);
  assert.deepEqual(stats.byModel, [{
    model: 'unlisted-model', totalUsd: null, requests: 4,
    complete: false, unpriced: true, assumed: false,
  }]);
  assert.deepEqual(stats.gaps, [{ harness: 'hermes', reason: 'No project attribution key.' }]);
});

test('?since/?until narrow the curve only — the header dates stay project-lifetime', async () => {
  const since = Date.UTC(2026, 6, 1);
  const until = Date.UTC(2026, 6, 28);

  const { status, json } = await call(
    'GET',
    `/api/projects/${publicProjectId}/stats?since=${since}&until=${until}`,
    ownerUser,
  );
  const stats = json.stats as Record<string, unknown>;

  assert.equal(status, 200);
  assert.deepEqual(lastDailyWindow, { since, until }, 'the window reaches the ledger');
  assert.equal(stats.firstActivity, '2026-06-01', 'a narrowed window must not make the project look younger');
  assert.equal(stats.lastActivity, '2026-07-28');
});

test('no window params ⇒ no window is passed (the ledger keeps its own default)', async () => {
  await call('GET', `/api/projects/${publicProjectId}/stats`, ownerUser);

  assert.equal(lastDailyWindow, undefined);
});

test('a garbage window is rejected rather than silently ignored', async () => {
  const { status, json } = await call('GET', `/api/projects/${publicProjectId}/stats?since=yesterday`, ownerUser);

  assert.equal(status, 400);
  assert.equal((json.error as { code?: string })?.code, 'INVALID_QUERY_PARAMETER');
  assert.equal(calls.daily, 0, 'a window the caller thinks is applied but is not would mislabel the numbers');
});
