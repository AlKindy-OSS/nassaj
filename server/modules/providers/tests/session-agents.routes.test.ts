/**
 * ADR-218: GET /api/sessions/:sessionId/agents/live over the real router and
 * DB. The read gate is the B-137 predicate the mirror registration uses: a
 * non-member of a private project gets the same 404 as a missing session, a
 * non-Claude session answers `{ supported: false }`.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import test, { after, before } from 'node:test';

import express from 'express';

import { closeConnection, getConnection, initializeDatabase, participantsDb, projectsDb, sessionsDb, userDb } from '@/modules/database/index.js';
import { AppError } from '@/shared/utils.js';

import participantsRouter from '../participants.routes.js';
import { resetSessionAgentsForTests } from '../services/session-agents/session-agents.service.js';

type TestUser = { id: number; role: string };
type Json = Record<string, any>;

const CLAUDE_SESSION = 'live-agents-claude';
const CODEX_SESSION = 'live-agents-codex';
const PUBLIC_SESSION = 'live-agents-public';

let currentUser: TestUser | null = null;
let server: Server;
let baseUrl = '';
let scratchDir = '';
let owner: TestUser;
let outsider: TestUser;
let member: TestUser;

async function get(sessionId: string, user: TestUser): Promise<{ status: number; json: Json }> {
  currentUser = user;
  const response = await fetch(`${baseUrl}/api/sessions/${sessionId}/agents/live`);
  return { status: response.status, json: (await response.json()) as Json };
}

before(async () => {
  closeConnection();
  scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nassaj-live-agents-'));
  process.env.DATABASE_PATH = path.join(scratchDir, 'db.sqlite');
  process.env.PROJECT_MEMBERSHIP_ENFORCE = '1';
  process.env.WORKSPACES_ROOT = fs.realpathSync(scratchDir);
  await initializeDatabase();

  owner = userDb.createUser('live_agents_owner', 'hash', 'user') as TestUser;
  outsider = userDb.createUser('live_agents_outsider', 'hash', 'user') as TestUser;
  const projectPath = path.join(fs.realpathSync(scratchDir), 'private-project');
  fs.mkdirSync(projectPath);
  const project = projectsDb.createProjectPath(projectPath, 'Private', owner.id).project!;
  projectsDb.setProjectVisibility(project.project_id, 'private');
  sessionsDb.createSession(CLAUDE_SESSION, 'claude', projectPath);
  sessionsDb.createSession(CODEX_SESSION, 'codex', projectPath);
  participantsDb.recordSpawn(CLAUDE_SESSION, owner.id);
  participantsDb.recordSpawn(CODEX_SESSION, owner.id);
  const publicPath = path.join(fs.realpathSync(scratchDir), 'public-project');
  fs.mkdirSync(publicPath);
  const publicProject = projectsDb.createProjectPath(publicPath, 'Public', owner.id).project!;
  projectsDb.setProjectVisibility(publicProject.project_id, 'public');
  member = userDb.createUser('live_agents_member', 'hash', 'user') as TestUser;
  getConnection().prepare('INSERT INTO project_members (project_id, user_id, role, added_by) VALUES (?, ?, ?, ?)')
    .run(publicProject.project_id, member.id, 'member', owner.id);
  sessionsDb.createSession(PUBLIC_SESSION, 'claude', publicPath);
  participantsDb.recordSpawn(PUBLIC_SESSION, owner.id);

  resetSessionAgentsForTests({ reconstruct: async () => [] });

  const app = express();
  app.use((req, _res, next) => {
    (req as unknown as { user: TestUser | null }).user = currentUser;
    next();
  });
  app.use('/api/sessions', participantsRouter);
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

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  closeConnection();
  delete process.env.DATABASE_PATH;
  delete process.env.PROJECT_MEMBERSHIP_ENFORCE;
  delete process.env.WORKSPACES_ROOT;
  fs.rmSync(scratchDir, { recursive: true, force: true });
});

test('a member reads the Claude session snapshot', async () => {
  const response = await get(CLAUDE_SESSION, owner);
  assert.equal(response.status, 200);
  assert.deepEqual(response.json.data, { supported: true, agents: [] });
});

test('a non-member of the private project gets the same 404 as a missing session', async () => {
  const hidden = await get(CLAUDE_SESSION, outsider);
  const missing = await get('live-agents-missing', owner);
  assert.equal(hidden.status, 404);
  assert.equal(missing.status, 404);
  assert.equal(hidden.json.error.code, missing.json.error.code);
});

test('a non-Claude session is reported unsupported', async () => {
  const response = await get(CODEX_SESSION, owner);
  assert.equal(response.status, 200);
  assert.deepEqual(response.json.data, { supported: false, agents: [] });
});

test('an invalid session id is a 400', async () => {
  const response = await get('bad%20id', owner);
  assert.equal(response.status, 400);
});

// Runs last: it exhausts the owner's per-session bucket.
test('one member exhausting their quota never locks the view for another member', async () => {
  for (let i = 0; i < 60; i += 1) {
    assert.equal((await get(PUBLIC_SESSION, owner)).status, 200);
  }
  const limited = await get(PUBLIC_SESSION, owner);
  assert.equal(limited.status, 429);
  assert.equal(limited.json.code, 'RATE_LIMITED');

  assert.equal((await get(PUBLIC_SESSION, member)).status, 200, 'another member still reads it');
  assert.equal((await get(CLAUDE_SESSION, owner)).status, 200, "the owner's other sessions still read");
});
