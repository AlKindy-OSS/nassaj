import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test, { after, before, beforeEach } from 'node:test';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

import express from 'express';

import { closeConnection, closedSessionsDb, initializeDatabase, participantsDb, projectsDb, sessionsDb, userDb } from '@/modules/database/index.js';
import { providerRoutes } from '@/modules/providers/index.js';
import { AppError } from '@/shared/utils.js';

import projectRoutes from './projects.routes.js';

type TestUser = { id: number; role: string };

let currentUser: TestUser | null = null;
let server: Server;
let baseUrl = '';
let dbDir = '';
let workspaceRoot = '';
let owner: TestUser;
let stranger: TestUser;
let ownProjectId = '';
let otherProjectId = '';

function makeTestDirectory(prefix: string): string {
  return fs.mkdtempSync(path.join('/var/tmp', prefix));
}

function seed(): void {
  const ownPath = fs.mkdtempSync(path.join(workspaceRoot, 'own-'));
  const otherPath = fs.mkdtempSync(path.join(workspaceRoot, 'other-'));
  ownProjectId = projectsDb.createProjectPath(ownPath, 'Own', owner.id).project?.project_id ?? '';
  otherProjectId = projectsDb.createProjectPath(otherPath, 'Other', stranger.id).project?.project_id ?? '';
  sessionsDb.createSession('bulk-owned-session', 'claude', ownPath);
  sessionsDb.createSession('bulk-other-session', 'claude', otherPath);
  participantsDb.recordSpawn('bulk-owned-session', owner.id);
  participantsDb.recordSpawn('bulk-other-session', stranger.id);
}

async function call(pathname: string, body: unknown, user: TestUser): Promise<{ status: number; json: any }> {
  currentUser = user;
  const response = await fetch(`${baseUrl}${pathname}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: response.status, json: await response.json() };
}

before(async () => {
  closeConnection();
  dbDir = makeTestDirectory('nassaj-bulk-db-');
  workspaceRoot = makeTestDirectory('nassaj-bulk-ws-');
  process.env.DATABASE_PATH = path.join(dbDir, 'db.sqlite');
  await initializeDatabase();
  owner = userDb.createUser('bulk-owner', 'hash', 'user') as TestUser;
  stranger = userDb.createUser('bulk-stranger', 'hash', 'user') as TestUser;

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { user: TestUser | null }).user = currentUser;
    next();
  });
  app.use('/api/projects', projectRoutes);
  app.use('/api/providers', providerRoutes);
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (error instanceof AppError) {
      res.status(error.statusCode).json({ success: false, error: { code: error.code } });
      return;
    }
    res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR' } });
  });
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

beforeEach(seed);

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  closeConnection();
  delete process.env.DATABASE_PATH;
  fs.rmSync(dbDir, { recursive: true, force: true });
  fs.rmSync(workspaceRoot, { recursive: true, force: true });
});

test('bulk actions authorize every selected id and hide inaccessible records', async () => {
  const response = await call('/api/providers/sessions/bulk', {
    action: 'archive', ids: ['bulk-owned-session', 'bulk-owned-session', 'bulk-other-session'],
  }, owner);
  assert.equal(response.status, 200);
  assert.deepEqual(response.json.data.results.map((result: any) => result.id), ['bulk-owned-session', 'bulk-other-session']);
  assert.equal(response.json.data.results[0].success, true);
  assert.equal(response.json.data.results[1].error.code, 'SESSION_NOT_FOUND');
  assert.equal(Boolean(sessionsDb.getSessionById('bulk-owned-session')?.isArchived), true);
  assert.equal(Boolean(sessionsDb.getSessionById('bulk-other-session')?.isArchived), false);
});

test('bulk permanent deletion retains the stricter project-management guard', async () => {
  const response = await call('/api/projects/bulk', {
    action: 'delete_permanently', ids: [ownProjectId, otherProjectId],
  }, owner);
  assert.equal(response.status, 200);
  assert.deepEqual(response.json.data.results.map((result: any) => result.success), [true, false]);
  assert.equal(response.json.data.results[1].error.code, 'PROJECT_NOT_FOUND');
  assert.equal(projectsDb.getProjectById(ownProjectId), null);
  assert.notEqual(projectsDb.getProjectById(otherProjectId), null);
});

test('bulk actions reject malformed input before any mutation', async () => {
  const response = await call('/api/providers/sessions/bulk', {
    action: 'archive', ids: Array.from({ length: 101 }, () => 'bulk-owned-session'),
  }, owner);
  assert.equal(response.status, 400);
  assert.equal(response.json.error.code, 'INVALID_BULK_IDS');
  assert.equal(Boolean(sessionsDb.getSessionById('bulk-owned-session')?.isArchived), false);
});

test('bulk close and reopen use the same session write entitlement', async () => {
  const closed = await call('/api/providers/sessions/bulk', {
    action: 'close', ids: ['bulk-owned-session'],
  }, owner);
  assert.equal(closed.status, 200);
  assert.equal(closed.json.data.results[0].result.closed, true);
  assert.notEqual(closedSessionsDb.getClosedSession('bulk-owned-session'), null);

  const reopened = await call('/api/providers/sessions/bulk', {
    action: 'reopen', ids: ['bulk-owned-session'],
  }, owner);
  assert.equal(reopened.status, 200);
  assert.equal(reopened.json.data.results[0].result.closed, false);
  assert.equal(closedSessionsDb.getClosedSession('bulk-owned-session'), null);
});
