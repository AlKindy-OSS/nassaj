/**
 * B-IDOR-GEMINI — `DELETE /api/gemini/sessions/:sessionId`.
 *
 * The module read `req.user` NOWHERE, so any authenticated caller could destroy
 * any session by id. Worse, `sessionsDb.deleteSessionById` is not provider
 * scoped, so this Gemini-specific route deleted Claude / Codex / Cursor sessions
 * just as happily — the transcript file first (sessionManager.deleteSession),
 * then the row.
 *
 * The route is JavaScript and `checkJs` is off in server/tsconfig.json, so tsc
 * proves nothing about this file: these tests are the only thing that shows the
 * guard is imported correctly and actually reached at runtime.
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

import { closeConnection } from '@/modules/database/connection.js';
import { initializeDatabase } from '@/modules/database/init-db.js';
import { participantsDb } from '@/modules/database/repositories/participants.db.js';
import { projectsDb } from '@/modules/database/repositories/projects.db.js';
import { sessionsDb } from '@/modules/database/repositories/sessions.db.js';
import { userDb } from '@/modules/database/repositories/users.js';

import geminiRouter from './gemini.js';

type TestUser = { id: number; role: string };

let currentUser: TestUser | null = null;
let server: Server;
let baseUrl = '';
let dbDir = '';
let workspaceRoot = '';
let ownerUser: TestUser;
let strangerUser: TestUser;
let projectPath = '';

const GEMINI_SESSION = 'gemini-owned-001';
const CLAUDE_SESSION = 'claude-owned-002';

async function del(sessionId: string, user: TestUser | null): Promise<number> {
  currentUser = user;
  const response = await fetch(`${baseUrl}/api/gemini/sessions/${sessionId}`, { method: 'DELETE' });
  return response.status;
}

before(async () => {
  closeConnection();
  dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nassaj-gemini-idor-db-'));
  workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nassaj-gemini-idor-ws-'));
  process.env.DATABASE_PATH = path.join(dbDir, 'db.sqlite');
  await initializeDatabase();

  ownerUser = userDb.createUser('gem_owner', 'hash', 'user') as TestUser;
  strangerUser = userDb.createUser('gem_stranger', 'hash', 'user') as TestUser;
  projectPath = fs.mkdtempSync(path.join(workspaceRoot, 'proj-'));
  projectsDb.createProjectPath(projectPath, 'Gemini Project', ownerUser.id);

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { user: TestUser | null }).user = currentUser;
    next();
  });
  app.use('/api/gemini', geminiRouter);

  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

beforeEach(() => {
  sessionsDb.createSession(GEMINI_SESSION, 'gemini', projectPath);
  sessionsDb.createSession(CLAUDE_SESSION, 'claude', projectPath);
  participantsDb.recordSpawn(GEMINI_SESSION, ownerUser.id);
  participantsDb.recordSpawn(CLAUDE_SESSION, ownerUser.id);
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  closeConnection();
  delete process.env.DATABASE_PATH;
  fs.rmSync(dbDir, { recursive: true, force: true });
  fs.rmSync(workspaceRoot, { recursive: true, force: true });
});

test('CRUX: a stranger cannot delete another user\'s gemini session', async () => {
  const status = await del(GEMINI_SESSION, strangerUser);

  assert.equal(status, 404, '404, not 403 — existence is not disclosed');
  assert.notEqual(sessionsDb.getSessionById(GEMINI_SESSION), null, 'session row survives');
});

test('the gemini route refuses a session belonging to ANOTHER provider, even for its owner', async () => {
  const status = await del(CLAUDE_SESSION, ownerUser);

  assert.equal(status, 404, 'provider-scoped: this endpoint owns gemini rows only');
  assert.notEqual(sessionsDb.getSessionById(CLAUDE_SESSION), null, 'the claude session survives');
});

test('the owner still deletes their own gemini session', async () => {
  const status = await del(GEMINI_SESSION, ownerUser);

  assert.equal(status, 200);
  assert.equal(sessionsDb.getSessionById(GEMINI_SESSION), null, 'row removed');
});

test('an unresolved identity is refused', async () => {
  const status = await del(GEMINI_SESSION, null);

  assert.equal(status, 404);
  assert.notEqual(sessionsDb.getSessionById(GEMINI_SESSION), null, 'session row survives');
});
