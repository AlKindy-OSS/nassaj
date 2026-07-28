/**
 * cost.routes.test.ts — the HTTP contract of the cost + close surface, driven
 * over the REAL routers and a REAL (throwaway) sqlite database. No stubbed
 * authorization gate, no mocked repository: what is asserted is what a browser
 * would get.
 *
 * Three properties are load-bearing here, and each has its own block below:
 *
 *  1. AUTHORIZATION. A conversation's cost is a property OF the conversation, so
 *     a caller who may not read the conversation may not price it — and the
 *     refusal is the SAME 404 an unknown id gets, so the endpoint cannot be used
 *     to confirm that another user's session exists. Closing goes further and
 *     needs the 'write' side of the gate: every project is public by default, so
 *     the read predicate would let any authenticated user close (or reopen)
 *     every conversation in the install. The tests prove the split by using ONE
 *     session in a PUBLIC project: the outsider may price it and may NOT close
 *     it.
 *
 *  2. NO FABRICATED NUMBERS. The pricing engine's answer is forwarded verbatim:
 *     `available:false` stays unavailable (never 0.00), `costUsd:null` stays
 *     null, `metered:false` (subscription = API-equivalent value, not money
 *     billed) survives serialization. The cost service is swapped for a stub so
 *     the route's own behaviour is what is measured, and the stub also RECORDS
 *     its calls — proving a refused caller never causes a transcript to be read.
 *
 *  3. THE SIDEBAR RIDE-ALONG. Closed state is GLOBAL, so it must be identical
 *     with and without a requesting user (the websocket broadcast path carries
 *     none), and it must be batched: the per-row `getClosedSession` API is
 *     asserted to be untouched while a page is built.
 *
 * Fixture provenance: the session ids are real values from this install's
 * `sessions` table (claude uuid v4, codex uuid v7, opencode base62), so the id
 * pattern is exercised against ids that actually exist rather than "session-1".
 *
 * Framework: node:test + node:assert/strict via tsx.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after, before, beforeEach } from 'node:test';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

import express from 'express';

import {
  closeConnection,
  closedSessionsDb,
  initializeDatabase,
  participantsDb,
  projectsDb,
  sessionsDb,
  userDb,
} from '@/modules/database/index.js';
import { getProjectsWithSessions } from '@/modules/projects/index.js';
import { AppError } from '@/shared/utils.js';

import { PRICES_AS_OF } from '../services/cost/model-pricing.js';
import { sessionCostService } from '../services/cost/session-cost.service.js';
import { subscriptionConfigService } from '../services/cost/subscription-config.service.js';
import participantsRouter from '../participants.routes.js';
import providerRouter from '../provider.routes.js';

type TestUser = { id: number; role: string };
type Json = Record<string, unknown>;

// Live-derived session ids (see header).
const PUBLIC_CLAUDE_SID = '2048b532-3b2a-4e32-b57c-4af1a5a6f9e7';
const PUBLIC_OPENCODE_SID = 'ses_06214044dffemD26QTiayDywHC';
const PRIVATE_CODEX_SID = '019f665c-95f4-7f53-98f5-f7977d3362bb';
const UNKNOWN_SID = '00000000-0000-4000-8000-000000000000';

let currentUser: TestUser | null = null;
let server: Server;
let baseUrl = '';
let dbDir = '';
let workspaceRoot = '';

let memberUser: TestUser;
let outsiderUser: TestUser;
let ownerUser: TestUser;

let publicProjectPath = '';
let privateProjectPath = '';
let publicProjectId = '';

/** Every cost-service call, so "was the engine reached?" is assertable. */
let costCalls: Array<{ method: string; sessionId?: string; userId: number }> = [];

const originalCostService = {
  getSessionCost: sessionCostService.getSessionCost,
  getSubscriptionCosts: sessionCostService.getSubscriptionCosts,
};

/**
 * A deliberately UNPRICEABLE answer: a subscription session (metered:false) with
 * one unpriced model. If the route ever "helps" by defaulting the unknown to a
 * number, these fields change and the assertions fail.
 */
const STUB_COST = {
  sessionId: PUBLIC_CLAUDE_SID,
  provider: 'claude',
  available: true,
  metered: false,
  totalUsd: 1.2345,
  complete: false,
  unpricedModels: ['claude-experimental-1'],
  subagentRequests: 3,
  pricesAsOf: PRICES_AS_OF,
  perModel: [
    {
      model: 'claude-experimental-1',
      costUsd: null,
      requests: 2,
      tokens: { input: 10, output: 20, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 5 },
    },
  ],
};

const STUB_UNAVAILABLE = {
  sessionId: PRIVATE_CODEX_SID,
  provider: 'codex',
  available: false,
  reason: 'PROVIDER_DOES_NOT_PERSIST_USAGE',
  metered: false,
  totalUsd: 0,
  complete: false,
  unpricedModels: [],
  subagentRequests: 0,
  pricesAsOf: PRICES_AS_OF,
  perModel: [],
};

const STUB_SUBSCRIPTIONS = [
  {
    provider: 'claude',
    displayName: 'Claude',
    plan: 'Max 20x',
    anchorDay: 1,
    cycleStart: '2026-07-01T00:00:00.000Z',
    cycleEnd: '2026-08-01T00:00:00.000Z',
    available: true,
    metered: false,
    totalUsd: 42.5,
    sessions: 7,
    complete: true,
    unpricedModels: [],
  },
];

async function request(
  method: string,
  urlPath: string,
  user: TestUser | null,
  body?: unknown,
): Promise<{ status: number; text: string; json: Json }> {
  currentUser = user;
  const response = await fetch(`${baseUrl}${urlPath}`, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let parsed: Json = {};
  try {
    parsed = JSON.parse(text) as Json;
  } catch {
    parsed = {};
  }
  return { status: response.status, text, json: parsed };
}

before(async () => {
  closeConnection();
  dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nassaj-cost-db-'));
  workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nassaj-cost-ws-'));
  process.env.DATABASE_PATH = path.join(dbDir, 'db.sqlite');
  await initializeDatabase();

  memberUser = userDb.createUser('cost_member', 'hash', 'user') as TestUser;
  outsiderUser = userDb.createUser('cost_outsider', 'hash', 'user') as TestUser;
  // Subscription config is install-wide, so writing it is owner/admin work.
  ownerUser = userDb.createUser('cost_owner', 'hash', 'owner') as TestUser;

  publicProjectPath = fs.mkdtempSync(path.join(workspaceRoot, 'public-proj-'));
  privateProjectPath = fs.mkdtempSync(path.join(workspaceRoot, 'private-proj-'));

  const publicCreated = projectsDb.createProjectPath(publicProjectPath, 'Public Project', memberUser.id);
  publicProjectId = publicCreated.project?.project_id as string;
  const privateCreated = projectsDb.createProjectPath(privateProjectPath, 'Private Project', memberUser.id);
  projectsDb.setProjectVisibility(privateCreated.project?.project_id as string, 'private');

  sessionsDb.createSession(PUBLIC_CLAUDE_SID, 'claude', publicProjectPath);
  sessionsDb.createSession(PUBLIC_OPENCODE_SID, 'opencode', publicProjectPath);
  sessionsDb.createSession(PRIVATE_CODEX_SID, 'codex', privateProjectPath);

  // The member owns the conversations; the outsider owns nothing anywhere.
  participantsDb.recordSpawn(PUBLIC_CLAUDE_SID, memberUser.id);
  participantsDb.recordSpawn(PUBLIC_OPENCODE_SID, memberUser.id);
  participantsDb.recordSpawn(PRIVATE_CODEX_SID, memberUser.id);

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { user: TestUser | null }).user = currentUser;
    next();
  });
  app.use('/api/providers', providerRouter);
  app.use('/api/sessions', participantsRouter);
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

after(async () => {
  sessionCostService.getSessionCost = originalCostService.getSessionCost;
  sessionCostService.getSubscriptionCosts = originalCostService.getSubscriptionCosts;
  await new Promise((resolve) => server.close(resolve));
  closeConnection();
  delete process.env.DATABASE_PATH;
  fs.rmSync(dbDir, { recursive: true, force: true });
  fs.rmSync(workspaceRoot, { recursive: true, force: true });
});

beforeEach(() => {
  costCalls = [];
  sessionCostService.getSessionCost = async (sessionId: string, userId: number) => {
    costCalls.push({ method: 'getSessionCost', sessionId, userId });
    return sessionId === PRIVATE_CODEX_SID ? STUB_UNAVAILABLE : STUB_COST;
  };
  sessionCostService.getSubscriptionCosts = async (userId: number) => {
    costCalls.push({ method: 'getSubscriptionCosts', userId });
    return STUB_SUBSCRIPTIONS;
  };
});

// ---------------------------------------------------------------------------
// 1. Authorization
// ---------------------------------------------------------------------------

test('fixture sanity: the private project really is invisible to the outsider', () => {
  const projectId = projectsDb.getProjectPath(privateProjectPath)?.project_id as string;
  assert.equal(projectsDb.isProjectVisibleToUser(projectId, outsiderUser.id), false);
  assert.equal(projectsDb.isProjectVisibleToUser(projectId, memberUser.id), true);
});

test('cost of an invisible session is refused exactly like an unknown id', async () => {
  const invisible = await request('GET', `/api/providers/costs/session/${PRIVATE_CODEX_SID}`, outsiderUser);
  const unknown = await request('GET', `/api/providers/costs/session/${UNKNOWN_SID}`, outsiderUser);

  assert.equal(invisible.status, 404);
  assert.equal(invisible.status, unknown.status, 'same status — no 403/404 tell');
  assert.equal(
    (invisible.json.error as Json)?.code,
    (unknown.json.error as Json)?.code,
    'same error code',
  );
  assert.deepEqual(costCalls, [], 'the pricing engine is never reached for a refused caller');
});

test('the same session IS priced for its member (the gate is real, not a blanket refusal)', async () => {
  const { status, json } = await request(
    'GET',
    `/api/providers/costs/session/${PRIVATE_CODEX_SID}`,
    memberUser,
  );
  assert.equal(status, 200);
  assert.equal((json.cost as Json).sessionId, PRIVATE_CODEX_SID);
  assert.deepEqual(costCalls, [
    { method: 'getSessionCost', sessionId: PRIVATE_CODEX_SID, userId: memberUser.id },
  ]);
});

test('an unauthenticated caller is refused with 401 before any pricing work', async () => {
  const { status } = await request('GET', `/api/providers/costs/session/${PUBLIC_CLAUDE_SID}`, null);
  assert.equal(status, 401);
  assert.deepEqual(costCalls, []);
});

test('a malformed session id is rejected without echoing the value', async () => {
  const { status, text } = await request(
    'GET',
    '/api/providers/costs/session/..%2F..%2Fetc%2Fpasswd',
    memberUser,
  );
  assert.equal(status, 400);
  assert.ok(!text.includes('passwd'), 'the rejected value is never reflected');
  assert.deepEqual(costCalls, []);
});

// ---------------------------------------------------------------------------
// 2. No fabricated numbers — the engine's answer is forwarded verbatim
// ---------------------------------------------------------------------------

test('the cost payload is forwarded verbatim under the flat contract envelope', async () => {
  const { status, json } = await request(
    'GET',
    `/api/providers/costs/session/${PUBLIC_CLAUDE_SID}`,
    memberUser,
  );

  assert.equal(status, 200);
  assert.equal(json.success, true);
  assert.deepEqual(json.cost, STUB_COST, 'not a single field is rewritten by the route');
});

test('an unavailable cost stays unavailable — it is never rendered as a 0.00 total', async () => {
  const { json } = await request('GET', `/api/providers/costs/session/${PRIVATE_CODEX_SID}`, memberUser);
  const cost = json.cost as Json;

  assert.equal(cost.available, false);
  assert.equal(cost.reason, 'PROVIDER_DOES_NOT_PERSIST_USAGE');
  // The zero is only legible BECAUSE available is false; the flag must survive.
  assert.ok('available' in cost && 'reason' in cost);
});

test('costUsd:null and metered:false survive JSON serialization', async () => {
  const { text, json } = await request(
    'GET',
    `/api/providers/costs/session/${PUBLIC_CLAUDE_SID}`,
    memberUser,
  );
  const cost = json.cost as Json;
  const perModel = cost.perModel as Json[];

  assert.equal(perModel[0].costUsd, null, 'an unpriced model is null, never 0');
  assert.ok(text.includes('"costUsd":null'), 'the null is on the wire, not an absent key');
  assert.equal(cost.metered, false, 'subscription usage is API-equivalent value, not money billed');
  assert.deepEqual(cost.unpricedModels, ['claude-experimental-1']);
  assert.equal(cost.complete, false);
});

test('subscriptions answer carries the price date at the envelope level', async () => {
  const { status, json } = await request('GET', '/api/providers/costs/subscriptions', memberUser);

  assert.equal(status, 200);
  assert.equal(json.success, true);
  assert.equal(json.pricesAsOf, PRICES_AS_OF);
  assert.deepEqual(json.subscriptions, STUB_SUBSCRIPTIONS);
  assert.deepEqual(costCalls, [{ method: 'getSubscriptionCosts', userId: memberUser.id }]);
});

test('the subscriptions total is scoped to the CALLER, not to a request field', async () => {
  await request('GET', '/api/providers/costs/subscriptions', outsiderUser);
  assert.deepEqual(costCalls, [{ method: 'getSubscriptionCosts', userId: outsiderUser.id }]);
});

// ---------------------------------------------------------------------------
// 3. Subscription config writes
// ---------------------------------------------------------------------------

test('PUT stores the renewal day and answers with the stored row', async () => {
  const { status, json } = await request(
    'PUT',
    '/api/providers/costs/subscriptions/claude',
    ownerUser,
    { anchorDay: 17, plan: 'Max 20x' },
  );

  assert.equal(status, 200);
  assert.equal(json.success, true);
  const subscription = json.subscription as Json;
  assert.equal(subscription.provider, 'claude');
  // Persisted, not merely echoed back. The ANSWER is the recomputed cost row
  // (see the next test), so the stored values are asserted at the store.
  assert.equal(subscriptionConfigService.getSettings('claude').anchorDay, 17);
  assert.equal(subscriptionConfigService.getSettings('claude').plan, 'Max 20x');
});

test('a plain member cannot rewrite the install-wide subscription config', async () => {
  const before = subscriptionConfigService.getSettings('claude').anchorDay;

  const { status } = await request(
    'PUT',
    '/api/providers/costs/subscriptions/claude',
    memberUser,
    { anchorDay: 3 },
  );

  // The key is a single app_config row shared by everyone: authentication alone
  // would let any member move the whole team's cycle, or hide a provider from
  // the panel with no surface to bring it back.
  assert.equal(status, 403);
  assert.equal(subscriptionConfigService.getSettings('claude').anchorDay, before);
});

test('PUT answers with the recomputed COST row, not the stored config entry', async () => {
  const { status, json } = await request(
    'PUT',
    '/api/providers/costs/subscriptions/claude',
    ownerUser,
    // Same value the previous test stored: these tests share one config row in
    // sequence, so this one proves a SHAPE without disturbing that sequence.
    { anchorDay: 17 },
  );

  assert.equal(status, 200);
  const subscription = json.subscription as Json;
  // Moving the anchor moves the cycle window, so the amount and dates the user
  // is looking at are stale the instant the write lands. Answering with the
  // config shape {provider, anchorDay, plan, hidden} would blank the figure.
  assert.ok('totalUsd' in subscription, 'the answer carries the amount');
  assert.ok('cycleStart' in subscription && 'cycleEnd' in subscription);
  assert.ok('metered' in subscription && 'available' in subscription);
  // The write itself landed in the store; the row above comes from the cost
  // service (stubbed here), which is exactly the point — the route no longer
  // hands back the config shape.
  assert.equal(subscriptionConfigService.getSettings('claude').anchorDay, 17);
});

test('PUT applies a partial patch without clearing the untouched fields', async () => {
  await request('PUT', '/api/providers/costs/subscriptions/claude', ownerUser, { hidden: true });

  const settings = subscriptionConfigService.getSettings('claude');
  assert.equal(settings.hidden, true);
  assert.equal(settings.plan, 'Max 20x', 'the plan label set by the previous test survived');
  assert.equal(settings.anchorDay, 17);
});

test('an out-of-range anchorDay is refused and nothing is written', async () => {
  const before = subscriptionConfigService.getSettings('claude').anchorDay;
  const { status, json } = await request(
    'PUT',
    '/api/providers/costs/subscriptions/claude',
    ownerUser,
    { anchorDay: 32 },
  );

  assert.equal(status, 400);
  assert.equal((json.error as Json)?.code, 'INVALID_ANCHOR_DAY');
  assert.equal(subscriptionConfigService.getSettings('claude').anchorDay, before);
});

test('an unknown provider and an empty patch are both refused', async () => {
  const unknownProvider = await request(
    'PUT',
    '/api/providers/costs/subscriptions/notaprovider',
    ownerUser,
    { anchorDay: 3 },
  );
  assert.equal(unknownProvider.status, 400);

  const emptyPatch = await request('PUT', '/api/providers/costs/subscriptions/claude', ownerUser, {});
  assert.equal(emptyPatch.status, 400);
  assert.equal((emptyPatch.json.error as Json)?.code, 'EMPTY_SUBSCRIPTION_PATCH');
});

test('unknown body fields cannot ride along into the store', async () => {
  await request('PUT', '/api/providers/costs/subscriptions/claude', ownerUser, {
    anchorDay: 5,
    injected: 'value',
  });

  const stored = subscriptionConfigService.getStored().claude as Record<string, unknown>;
  assert.deepEqual(Object.keys(stored).sort(), ['anchorDay', 'hidden', 'plan']);
});

// ---------------------------------------------------------------------------
// 4. Closing a conversation (display-only, reversible, gated on 'write')
// ---------------------------------------------------------------------------

test('a member closes a conversation and the marker names the closer', async () => {
  const { status, json } = await request(
    'POST',
    `/api/sessions/${PUBLIC_CLAUDE_SID}/close`,
    memberUser,
  );

  assert.equal(status, 200);
  assert.equal(json.success, true);
  const closed = json.closed as Json;
  assert.equal(closed.sessionId, PUBLIC_CLAUDE_SID);
  assert.equal(closed.closedBy, memberUser.id);
  assert.ok(typeof closed.closedAt === 'string' && closed.closedAt.length > 0);
  assert.equal(closedSessionsDb.isClosed(PUBLIC_CLAUDE_SID), true);
});

test('closing twice is idempotent and keeps the ORIGINAL closer', async () => {
  const first = await request('POST', `/api/sessions/${PUBLIC_CLAUDE_SID}/close`, memberUser);
  const again = await request('POST', `/api/sessions/${PUBLIC_CLAUDE_SID}/close`, memberUser);

  assert.equal(again.status, 200);
  assert.deepEqual(again.json.closed, first.json.closed);
});

test('CRUX: a non-member may PRICE a public conversation but may NOT close it', async () => {
  // Reading is allowed: the project is public, so the read predicate says yes.
  const priced = await request(
    'GET',
    `/api/providers/costs/session/${PUBLIC_OPENCODE_SID}`,
    outsiderUser,
  );
  assert.equal(priced.status, 200);

  // Closing is a mutation and needs the write predicate, which the outsider fails.
  const closed = await request('POST', `/api/sessions/${PUBLIC_OPENCODE_SID}/close`, outsiderUser);
  assert.equal(closed.status, 404, 'refused as "not found" — never a 403 that confirms the id');
  assert.equal(closedSessionsDb.isClosed(PUBLIC_OPENCODE_SID), false, 'nothing was written');
});

test('a non-member cannot REOPEN a conversation someone else closed', async () => {
  await request('POST', `/api/sessions/${PUBLIC_CLAUDE_SID}/close`, memberUser);

  const { status } = await request('DELETE', `/api/sessions/${PUBLIC_CLAUDE_SID}/close`, outsiderUser);
  assert.equal(status, 404);
  assert.equal(closedSessionsDb.isClosed(PUBLIC_CLAUDE_SID), true, 'still closed');
});

test('closing through the ROUTE is what the sidebar payload then shows', async () => {
  // The owner-reported symptom was "I press close and nothing happens": the row
  // in the sidebar never changed. This walks the real path — HTTP close, then
  // rebuild the page the sidebar renders — so a regression that leaves the
  // payload stale fails here rather than in the UI.
  await request('POST', `/api/sessions/${PUBLIC_CLAUDE_SID}/close`, memberUser);

  try {
    const page = await readPublicProject(memberUser.id);
    const row = page.project.sessions.find((session) => session.id === PUBLIC_CLAUDE_SID);
    assert.equal(row?.closed, true, 'the sidebar payload carries the closure');
    assert.equal(row?.closedBy, memberUser.id);

    await request('DELETE', `/api/sessions/${PUBLIC_CLAUDE_SID}/close`, memberUser);
    const after = await readPublicProject(memberUser.id);
    const reopened = after.project.sessions.find((session) => session.id === PUBLIC_CLAUDE_SID);
    assert.equal(reopened?.closed, false, 'reopening un-marks the row');
    assert.equal(reopened?.closedAt, null);
  } finally {
    closedSessionsDb.reopenSession(PUBLIC_CLAUDE_SID);
  }
});

test('reopening is idempotent and leaves no marker behind', async () => {
  await request('POST', `/api/sessions/${PUBLIC_CLAUDE_SID}/close`, memberUser);

  const first = await request('DELETE', `/api/sessions/${PUBLIC_CLAUDE_SID}/close`, memberUser);
  const again = await request('DELETE', `/api/sessions/${PUBLIC_CLAUDE_SID}/close`, memberUser);

  assert.equal(first.status, 200);
  assert.equal(again.status, 200);
  assert.deepEqual(again.json, { success: true });
  assert.equal(closedSessionsDb.getClosedSession(PUBLIC_CLAUDE_SID), null);
});

test('closing an unknown session is refused before any write', async () => {
  const { status } = await request('POST', `/api/sessions/${UNKNOWN_SID}/close`, memberUser);
  assert.equal(status, 404);
  assert.equal(closedSessionsDb.isClosed(UNKNOWN_SID), false);
});

// ---------------------------------------------------------------------------
// 5. The sidebar ride-along
// ---------------------------------------------------------------------------

/** The fixture's public project as the sidebar payload renders it. */
const readPublicProject = async (currentUserId?: number) => {
  const projects = await getProjectsWithSessions(
    currentUserId === undefined
      ? { skipSynchronization: true }
      : { skipSynchronization: true, currentUserId },
  );
  const project = projects.find((candidate) => candidate.projectId === publicProjectId);
  assert.ok(project, 'the fixture project is in the payload');
  return { project, projectCount: projects.length };
};

test('session rows carry closed + attribution, batched and user-independent', async () => {
  closedSessionsDb.closeSession(PUBLIC_CLAUDE_SID, memberUser.id);

  // The per-row API must stay untouched while a whole page is stamped.
  const originalGetClosedSession = closedSessionsDb.getClosedSession;
  const originalGetClosedSessionIds = closedSessionsDb.getClosedSessionIds;
const originalGetClosedSessionRows = closedSessionsDb.getClosedSessionRows;
  let perRowCalls = 0;
  let batchedCalls = 0;
  closedSessionsDb.getClosedSession = (sessionId: string) => {
    perRowCalls += 1;
    return originalGetClosedSession.call(closedSessionsDb, sessionId);
  };
  // The page builder resolves ids AND attribution in the SAME query, so the
  // batched surface to count is getClosedSessionRows. (The earlier shape read
  // the whole markers table for the attribution, once per project.)
  closedSessionsDb.getClosedSessionRows = (sessionIds: string[]) => {
    batchedCalls += 1;
    return originalGetClosedSessionRows.call(closedSessionsDb, sessionIds);
  };

  try {
    const asMember = await readPublicProject(memberUser.id);
    // The sessions watcher broadcasts this exact payload with NO requester at
    // all — a global flag must not depend on who is looking.
    const asBroadcast = await readPublicProject();

    const closedRow = asMember.project.sessions.find((session) => session.id === PUBLIC_CLAUDE_SID);
    const openRow = asMember.project.opencodeSessions.find(
      (session) => session.id === PUBLIC_OPENCODE_SID,
    );

    assert.ok(closedRow && openRow, 'both fixture sessions are in the page');
    assert.equal(closedRow.closed, true);
    assert.equal(closedRow.closedBy, memberUser.id);
    assert.ok(typeof closedRow.closedAt === 'string' && closedRow.closedAt.length > 0);

    assert.equal(openRow.closed, false);
    assert.equal(openRow.closedAt, null, 'an open row says null — not a fabricated timestamp');
    assert.equal(openRow.closedBy, null);

    assert.deepEqual(
      asBroadcast.project.sessions.map((session) => [session.id, session.closed, session.closedBy]),
      asMember.project.sessions.map((session) => [session.id, session.closed, session.closedBy]),
      'identical with and without a requesting user',
    );

    assert.equal(perRowCalls, 0, 'no N+1: the per-row lookup is never used to build a page');
    assert.equal(
      batchedCalls,
      asMember.projectCount + asBroadcast.projectCount,
      'exactly one batched query per project page — never one per session row',
    );
  } finally {
    closedSessionsDb.getClosedSession = originalGetClosedSession;
    closedSessionsDb.getClosedSessionIds = originalGetClosedSessionIds;
    closedSessionsDb.getClosedSessionRows = originalGetClosedSessionRows;
    closedSessionsDb.reopenSession(PUBLIC_CLAUDE_SID);
  }
});

test('a page with nothing closed skips the attribution read entirely', async () => {
  const originalListClosedSessions = closedSessionsDb.listClosedSessions;
  let listCalls = 0;
  closedSessionsDb.listClosedSessions = () => {
    listCalls += 1;
    return originalListClosedSessions.call(closedSessionsDb);
  };

  try {
    const { project } = await readPublicProject(memberUser.id);
    const rows = [...project.sessions, ...project.opencodeSessions];

    assert.ok(rows.length > 0);
    for (const row of rows) {
      assert.equal(row.closed, false);
      assert.equal(row.closedAt, null);
      assert.equal(row.closedBy, null);
    }
    assert.equal(listCalls, 0, 'the attribution read is skipped when nothing on the page is closed');
  } finally {
    closedSessionsDb.listClosedSessions = originalListClosedSessions;
  }
});
