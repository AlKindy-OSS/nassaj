/**
 * Security contract for per-user session stars over the real router and DB.
 * A star is a pointer, never an authorization grant: POST checks the target
 * before writing, while GET silently drops stale/inaccessible pointers without
 * exposing which kind of refusal occurred.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import test, { after, before } from 'node:test';

import express from 'express';

import {
  closeConnection,
  initializeDatabase,
  participantsDb,
  projectsDb,
  sessionsDb,
  starredSessionsDb,
  userDb,
} from '@/modules/database/index.js';
import { AppError } from '@/shared/utils.js';

import participantsRouter from '../participants.routes.js';

type TestUser = { id: number; role: string };
type Json = Record<string, unknown>;

const ACTIVE_SESSION = 'star-active-session';
const ARCHIVED_SESSION = 'star-archived-session';
const MISSING_SESSION = 'star-missing-session';

let currentUser: TestUser | null = null;
let server: Server;
let baseUrl = '';
let scratchDir = '';
let owner: TestUser;
let teammate: TestUser;

async function request(
  method: string,
  urlPath: string,
  user: TestUser,
  body?: unknown,
): Promise<{ status: number; json: Json }> {
  currentUser = user;
  const response = await fetch(`${baseUrl}${urlPath}`, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, json: (await response.json()) as Json };
}

before(async () => {
  closeConnection();
  scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nassaj-star-routes-'));
  process.env.DATABASE_PATH = path.join(scratchDir, 'db.sqlite');
  await initializeDatabase();

  owner = userDb.createUser('star_route_owner', 'hash', 'user') as TestUser;
  teammate = userDb.createUser('star_route_teammate', 'hash', 'user') as TestUser;

  const activePath = path.join(scratchDir, 'active-project');
  const archivedPath = path.join(scratchDir, 'archived-project');
  projectsDb.createProjectPath(activePath, 'Active', owner.id);
  const archivedProject = projectsDb.createProjectPath(archivedPath, 'Archived', owner.id).project!;
  sessionsDb.createSession(ACTIVE_SESSION, 'claude', activePath);
  sessionsDb.createSession(ARCHIVED_SESSION, 'claude', archivedPath);
  participantsDb.recordSpawn(ACTIVE_SESSION, owner.id);
  participantsDb.recordSpawn(ARCHIVED_SESSION, owner.id);
  projectsDb.updateProjectIsArchivedById(archivedProject.project_id, true);

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { user: TestUser | null }).user = currentUser;
    next();
  });
  app.use('/api/sessions', participantsRouter);
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (error instanceof AppError) {
      res.status(error.statusCode).json({
        success: false,
        error: { code: error.code, message: error.message },
      });
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
  fs.rmSync(scratchDir, { recursive: true, force: true });
});

test('POST refuses missing and inaccessible sessions with the same 404 before writing', async () => {
  const inaccessible = await request('POST', '/api/sessions/star', teammate, {
    sessionId: ARCHIVED_SESSION,
    starred: true,
  });
  const missing = await request('POST', '/api/sessions/star', teammate, {
    sessionId: MISSING_SESSION,
    starred: true,
  });

  assert.equal(inaccessible.status, 404);
  assert.equal(missing.status, 404);
  assert.equal((inaccessible.json.error as Json).code, 'SESSION_NOT_FOUND');
  assert.equal((missing.json.error as Json).code, 'SESSION_NOT_FOUND');
  assert.equal(starredSessionsDb.isStarred(teammate.id, ARCHIVED_SESSION), false);
  assert.equal(starredSessionsDb.isStarred(teammate.id, MISSING_SESSION), false);
});

test('POST removes an existing pointer after access is lost and treats a missing target idempotently', async () => {
  starredSessionsDb.star(teammate.id, ARCHIVED_SESSION, 'Archived');

  const response = await request('POST', '/api/sessions/star', teammate, {
    sessionId: ARCHIVED_SESSION,
    starred: false,
  });
  const missing = await request('POST', '/api/sessions/star', teammate, {
    sessionId: MISSING_SESSION,
    starred: false,
  });

  assert.equal(response.status, 200);
  assert.equal((response.json.data as Json).starred, false);
  assert.equal(starredSessionsDb.isStarred(teammate.id, ARCHIVED_SESSION), false);
  assert.equal(missing.status, 200);
  assert.equal((missing.json.data as Json).starred, false);
});

test('GET returns accessible stars and silently filters inaccessible and missing pointers', async () => {
  starredSessionsDb.star(teammate.id, ACTIVE_SESSION, 'Active');
  starredSessionsDb.star(teammate.id, MISSING_SESSION, 'Missing');

  const response = await request('GET', '/api/sessions/starred', teammate);

  assert.equal(response.status, 200);
  assert.deepEqual(
    ((response.json.data as Json).sessions as Array<{ sessionId: string }>).map((row) => row.sessionId),
    [ACTIVE_SESSION],
  );
});

test('a session participant may star and list a session in an archived project', async () => {
  const starred = await request('POST', '/api/sessions/star', owner, {
    sessionId: ARCHIVED_SESSION,
    projectName: 'Archived',
    starred: true,
  });
  const listed = await request('GET', '/api/sessions/starred', owner);

  assert.equal(starred.status, 200);
  assert.equal((starred.json.data as Json).starred, true);
  assert.deepEqual(
    ((listed.json.data as Json).sessions as Array<{ sessionId: string }>).map((row) => row.sessionId),
    [ARCHIVED_SESSION],
  );
});
