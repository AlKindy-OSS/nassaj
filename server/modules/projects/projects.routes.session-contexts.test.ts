/**
 * B-1431 — POST /api/projects/session-contexts (batched deep-link contexts).
 *
 * Mounts the real router over a throwaway migrated SQLite DB (temp dirs only,
 * B-1420) behind an injected `req.user`, as index.js does after
 * authenticateToken. Proves:
 *   - input validation: > MAX ids, non-array, non-string, malformed, empty => 400;
 *   - the visibility boundary drops archived sessions, sessions of archived
 *     projects, missing ids and (under PROJECT_MEMBERSHIP_ENFORCE) non-member
 *     projects — and a missing id is indistinguishable from an invisible one;
 *   - unauthenticated callers are refused, and the route is rate limited.
 *
 * Framework: node:test + node:assert/strict via tsx.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after, before } from 'node:test';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

import express from 'express';

import { closeConnection, getConnection, initializeDatabase, projectsDb, sessionsDb, userDb } from '@/modules/database/index.js';
import { AppError } from '@/shared/utils.js';

import projectsRouter, { MAX_SESSION_CONTEXT_IDS } from './projects.routes.js';

type TestUser = { id: number; role: string };
type Context = { projectId: string; provider: string; session: { id: string } };

let currentUser: TestUser | null = null;
let server: Server;
let baseUrl = '';
let tempRoot = '';
let creator: TestUser;
let outsider: TestUser;
let activeProjectId = '';

const S_VISIBLE = 'ctx-visible-001';
const S_ARCHIVED_SESSION = 'ctx-archived-session-001';
const S_ARCHIVED_PROJECT = 'ctx-archived-project-001';

async function post(user: TestUser | null, body: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  currentUser = user;
  const response = await fetch(`${baseUrl}/api/projects/session-contexts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: response.status, json };
}

function contextIds(json: Record<string, unknown>): string[] {
  return ((json.contexts ?? []) as Context[]).map((context) => context.session.id);
}

before(async () => {
  closeConnection();
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nassaj-session-contexts-'));
  process.env.DATABASE_PATH = path.join(tempRoot, 'db.sqlite');
  delete process.env.PROJECT_MEMBERSHIP_ENFORCE;
  await initializeDatabase();

  creator = userDb.createUser('ctx_creator', 'hash', 'user') as TestUser;
  outsider = userDb.createUser('ctx_outsider', 'hash', 'user') as TestUser;

  const activePath = fs.mkdtempSync(path.join(tempRoot, 'active-'));
  const archivedPath = fs.mkdtempSync(path.join(tempRoot, 'archived-'));
  activeProjectId = projectsDb.createProjectPath(activePath, 'Active', creator.id).project?.project_id ?? '';
  const archivedProjectId = projectsDb.createProjectPath(archivedPath, 'Archived', creator.id).project?.project_id ?? '';
  assert.ok(activeProjectId && archivedProjectId, 'fixture projects exist');

  sessionsDb.createSession(S_VISIBLE, 'claude', activePath, 'Visible');
  sessionsDb.createSession(S_ARCHIVED_SESSION, 'claude', activePath, 'Archived session');
  sessionsDb.createSession(S_ARCHIVED_PROJECT, 'claude', archivedPath, 'In archived project');
  const db = getConnection();
  db.prepare('UPDATE sessions SET isArchived = 1 WHERE session_id = ?').run(S_ARCHIVED_SESSION);
  db.prepare('UPDATE projects SET isArchived = 1 WHERE project_id = ?').run(archivedProjectId);

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { user: TestUser | null }).user = currentUser;
    next();
  });
  app.use('/api/projects', projectsRouter);
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
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

test('more than the maximum distinct ids is a 400', async () => {
  const ids = Array.from({ length: MAX_SESSION_CONTEXT_IDS + 1 }, (_, i) => `id-${i}`);
  const { status, json } = await post(creator, { sessionIds: ids });
  assert.equal(status, 400);
  assert.equal((json.error as { code: string }).code, 'INVALID_SESSION_IDS');
});

test('malformed bodies are a 400', async () => {
  for (const body of [
    {},
    { sessionIds: 'ctx-visible-001' },
    { sessionIds: [42] },
    { sessionIds: ['../etc/passwd'] },
    { sessionIds: ['x'.repeat(121)] },
    { sessionIds: [] },
  ]) {
    const { status } = await post(creator, body);
    assert.equal(status, 400, `rejected: ${JSON.stringify(body).slice(0, 60)}`);
  }
});

test('duplicates are collapsed before the size check', async () => {
  const { status, json } = await post(creator, {
    sessionIds: Array.from({ length: MAX_SESSION_CONTEXT_IDS + 10 }, () => S_VISIBLE),
  });
  assert.equal(status, 200);
  assert.deepEqual(contextIds(json), [S_VISIBLE]);
});

test('only visible, active sessions of active projects are returned', async () => {
  const { status, json } = await post(creator, {
    sessionIds: ['no-such-session', S_ARCHIVED_SESSION, S_ARCHIVED_PROJECT, S_VISIBLE],
  });
  assert.equal(status, 200);
  const contexts = json.contexts as Context[];
  assert.equal(contexts.length, 1);
  assert.equal(contexts[0].projectId, activeProjectId);
  assert.equal(contexts[0].provider, 'claude');
  assert.equal(contexts[0].session.id, S_VISIBLE);
});

test('a missing id and an invisible id produce identical responses', async () => {
  const missing = await post(creator, { sessionIds: ['no-such-session'] });
  const archivedProject = await post(creator, { sessionIds: [S_ARCHIVED_PROJECT] });
  const archivedSession = await post(creator, { sessionIds: [S_ARCHIVED_SESSION] });
  assert.deepEqual(missing, { status: 200, json: { contexts: [] } });
  assert.deepEqual(archivedProject, missing);
  assert.deepEqual(archivedSession, missing);
});

test('under PROJECT_MEMBERSHIP_ENFORCE a non-member gets nothing, identically', async () => {
  process.env.PROJECT_MEMBERSHIP_ENFORCE = '1';
  try {
    const member = await post(creator, { sessionIds: [S_VISIBLE] });
    assert.deepEqual(contextIds(member.json), [S_VISIBLE], 'the creator still sees it');
    const stranger = await post(outsider, { sessionIds: [S_VISIBLE] });
    const missing = await post(outsider, { sessionIds: ['no-such-session'] });
    assert.deepEqual(stranger, { status: 200, json: { contexts: [] } });
    assert.deepEqual(stranger, missing);
  } finally {
    delete process.env.PROJECT_MEMBERSHIP_ENFORCE;
  }
});

test('unauthenticated callers are refused', async () => {
  const { status } = await post(null, { sessionIds: [S_VISIBLE] });
  assert.equal(status, 401);
  // And in production the router is mounted behind authenticateToken.
  const indexSource = fs.readFileSync(path.resolve('server/index.js'), 'utf8');
  assert.match(indexSource, /app\.use\('\/api\/projects', authenticateToken, projectModuleRoutes\)/);
});

test('the route is rate limited per user', async () => {
  const limited = userDb.createUser('ctx_rate', 'hash', 'user') as TestUser;
  let lastStatus = 0;
  let firstLimitedAt = -1;
  for (let i = 0; i < 61 && firstLimitedAt === -1; i += 1) {
    lastStatus = (await post(limited, { sessionIds: [S_VISIBLE] })).status;
    if (lastStatus === 429) firstLimitedAt = i;
  }
  assert.equal(lastStatus, 429);
  assert.equal(firstLimitedAt, 60, 'the 61st request in the window is limited');
  const other = await post(creator, { sessionIds: [S_VISIBLE] });
  assert.equal(other.status, 200, 'the bucket is per user');
});
