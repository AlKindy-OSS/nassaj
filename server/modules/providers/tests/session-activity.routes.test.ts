/**
 * session-activity.routes.test.ts — ج1 step 2, HTTP contract of
 * `GET /api/providers/sessions/:sessionId/activity`.
 *
 * Drives the REAL provider router over a REAL (throwaway) sqlite database — no
 * database mock, no stubbed visibility gate — so what is asserted is the wire
 * behaviour a browser gets:
 *
 *   - ALWAYS 200 with a body of EXACTLY `{"isProcessing": <boolean>}`: one key,
 *     no session id echoed back, no envelope, no provider name;
 *   - an active session is `true`, an idle one is `false`;
 *   - an UNKNOWN id, and a REAL RUNNING session belonging to a private project
 *     the caller is not a member of, produce the SAME status and the SAME raw
 *     response text — compared as strings, so "byte for byte" is literal;
 *   - the same private session IS reported to its member, proving the equality
 *     above is a working gate and not a route that always answers false;
 *   - a malformed id is rejected by the shared syntax validator without echoing
 *     the value.
 *
 * The liveness probes are injected exactly as server/index.js injects them, and
 * they RECORD their calls: the test asserts the probe is never reached for a
 * refused caller, i.e. the refusal is not a filter applied after the answer was
 * computed. That is a "no hidden state is read" property and nothing more — the
 * UNKNOWN id, by contrast, passes the visibility gate (which fail-opens on a
 * session that resolves to no project) and DOES reach the probe. Equal bytes
 * out; unequal work done. No constant-time behaviour is claimed here.
 *
 * Fixture provenance: the ids and the id ALPHABET come from the live database of
 * this install — claude's uuid v4, codex's uuid v7 and opencode's `ses_…` base62
 * are all real values from its `sessions` table, so the route's id pattern is
 * exercised against what actually exists rather than an invented "session-1".
 * The private project is the only synthesized element (this install has no
 * private project today), created through the production repository API.
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
  initializeDatabase,
  projectsDb,
  sessionsDb,
  userDb,
} from '@/modules/database/index.js';
import { AppError } from '@/shared/utils.js';

import { setSessionLivenessProbes } from '../services/session-activity.service.js';
import providerRouter from '../provider.routes.js';

type TestUser = { id: number; role: string };

// Live-derived session ids (see header). uuid v4 / uuid v7 / opencode base62.
const PUBLIC_CLAUDE_SID = '2048b532-3b2a-4e32-b57c-4af1a5a6f9e7';
const PUBLIC_OPENCODE_SID = 'ses_06214044dffemD26QTiayDywHC';
const PRIVATE_CODEX_SID = '019f665c-95f4-7f53-98f5-f7977d3362bb';
const UNKNOWN_SID = '00000000-0000-4000-8000-000000000000';

const IDLE_BODY = '{"isProcessing":false}';

let currentUser: TestUser | null = null;
let server: Server;
let baseUrl = '';
let dbDir = '';
let workspaceRoot = '';

let memberUser: TestUser;
let outsiderUser: TestUser;

let publicProjectPath = '';
let privateProjectPath = '';

/** Every liveness probe call, so "was the probe reached?" is assertable. */
let probeCalls: string[] = [];

/** Session ids the fake providers report as RUNNING. */
const RUNNING = new Set<string>([PUBLIC_CLAUDE_SID, PRIVATE_CODEX_SID]);

const makeProbe = () => (sessionId: string) => {
  probeCalls.push(sessionId);
  return RUNNING.has(sessionId);
};

async function get(
  urlPath: string,
  user: TestUser | null
): Promise<{ status: number; text: string }> {
  currentUser = user;
  const response = await fetch(`${baseUrl}${urlPath}`);
  return { status: response.status, text: await response.text() };
}

before(async () => {
  closeConnection();
  dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nassaj-activity-db-'));
  workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nassaj-activity-ws-'));
  process.env.DATABASE_PATH = path.join(dbDir, 'db.sqlite');
  await initializeDatabase();

  memberUser = userDb.createUser('activity_member', 'hash', 'user') as TestUser;
  outsiderUser = userDb.createUser('activity_outsider', 'hash', 'user') as TestUser;

  publicProjectPath = fs.mkdtempSync(path.join(workspaceRoot, 'public-proj-'));
  privateProjectPath = fs.mkdtempSync(path.join(workspaceRoot, 'private-proj-'));

  projectsDb.createProjectPath(publicProjectPath, 'Public Project', memberUser.id);
  const privateCreated = projectsDb.createProjectPath(
    privateProjectPath,
    'Private Project',
    memberUser.id
  );
  projectsDb.setProjectVisibility(privateCreated.project?.project_id as string, 'private');

  sessionsDb.createSession(PUBLIC_CLAUDE_SID, 'claude', publicProjectPath);
  sessionsDb.createSession(PUBLIC_OPENCODE_SID, 'opencode', publicProjectPath);
  sessionsDb.createSession(PRIVATE_CODEX_SID, 'codex', privateProjectPath);

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { user: TestUser | null }).user = currentUser;
    next();
  });
  app.use('/api/providers', providerRouter);
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
  await new Promise((resolve) => server.close(resolve));
  closeConnection();
  delete process.env.DATABASE_PATH;
  fs.rmSync(dbDir, { recursive: true, force: true });
  fs.rmSync(workspaceRoot, { recursive: true, force: true });
});

beforeEach(() => {
  probeCalls = [];
  setSessionLivenessProbes({
    claude: makeProbe(),
    codex: makeProbe(),
    opencode: makeProbe(),
  });
});

test('fixture sanity: the private project really is private for the outsider', () => {
  const projectId = projectsDb.getProjectPath(privateProjectPath)?.project_id as string;
  assert.equal(projectsDb.getProjectVisibility(projectId), 'private');
  assert.equal(projectsDb.isProjectVisibleToUser(projectId, outsiderUser.id), false);
  assert.equal(projectsDb.isProjectVisibleToUser(projectId, memberUser.id), true);
});

test('active session → 200 with exactly {"isProcessing":true}', async () => {
  const { status, text } = await get(
    `/api/providers/sessions/${PUBLIC_CLAUDE_SID}/activity`,
    memberUser
  );
  assert.equal(status, 200);
  assert.equal(text, '{"isProcessing":true}');
  assert.deepEqual(Object.keys(JSON.parse(text)), ['isProcessing'], 'exactly one field');
});

test('idle session → 200 with an EXPLICIT false (the field is never missing)', async () => {
  const { status, text } = await get(
    `/api/providers/sessions/${PUBLIC_OPENCODE_SID}/activity`,
    memberUser
  );
  assert.equal(status, 200);
  assert.equal(text, IDLE_BODY);
  assert.equal(JSON.parse(text).isProcessing, false);
});

test('CRUX: a running invisible session is indistinguishable from an unknown one', async () => {
  const invisible = await get(`/api/providers/sessions/${PRIVATE_CODEX_SID}/activity`, outsiderUser);
  const unknown = await get(`/api/providers/sessions/${UNKNOWN_SID}/activity`, outsiderUser);

  assert.equal(invisible.status, unknown.status, 'same status — no 403/404 tell');
  assert.equal(invisible.text, unknown.text, 'same body, byte for byte');
  assert.equal(invisible.status, 200);
  assert.equal(invisible.text, IDLE_BODY);
  assert.ok(!invisible.text.includes(PRIVATE_CODEX_SID), 'the id is never echoed');
});

test('the refused caller never reaches the liveness probe', async () => {
  await get(`/api/providers/sessions/${PRIVATE_CODEX_SID}/activity`, outsiderUser);
  assert.deepEqual(probeCalls, []);
});

test('the same private session IS reported to its member (the gate is real)', async () => {
  const { status, text } = await get(
    `/api/providers/sessions/${PRIVATE_CODEX_SID}/activity`,
    memberUser
  );
  assert.equal(status, 200);
  assert.equal(text, '{"isProcessing":true}');
  assert.deepEqual(probeCalls, [PRIVATE_CODEX_SID], 'probed once, by the codex probe');
});

test('an unresolvable caller (no req.user) is refused on a private session', async () => {
  const { status, text } = await get(`/api/providers/sessions/${PRIVATE_CODEX_SID}/activity`, null);
  assert.equal(status, 200);
  assert.equal(text, IDLE_BODY);
  assert.deepEqual(probeCalls, []);
});

test('a malformed session id is refused by the shared validator without echoing it', async () => {
  const { status, text } = await get(
    '/api/providers/sessions/..%2F..%2Fetc%2Fpasswd/activity',
    memberUser
  );
  assert.equal(status, 400);
  assert.ok(!text.includes('passwd'), 'the rejected value is never reflected');
  assert.deepEqual(probeCalls, []);
});

test('the route performs no writes: session and project rows are untouched', async () => {
  const before = {
    session: sessionsDb.getSessionById(PUBLIC_CLAUDE_SID),
    visibility: projectsDb.getProjectVisibility(
      projectsDb.getProjectPath(privateProjectPath)?.project_id as string
    ),
  };

  await get(`/api/providers/sessions/${PUBLIC_CLAUDE_SID}/activity`, memberUser);
  await get(`/api/providers/sessions/${PRIVATE_CODEX_SID}/activity`, outsiderUser);
  await get(`/api/providers/sessions/${UNKNOWN_SID}/activity`, outsiderUser);

  assert.deepEqual(sessionsDb.getSessionById(PUBLIC_CLAUDE_SID), before.session);
  assert.equal(
    projectsDb.getProjectVisibility(
      projectsDb.getProjectPath(privateProjectPath)?.project_id as string
    ),
    before.visibility
  );
  // The unknown id was NOT adopted into the sessions table by asking about it.
  assert.equal(sessionsDb.getSessionById(UNKNOWN_SID), null);
});
