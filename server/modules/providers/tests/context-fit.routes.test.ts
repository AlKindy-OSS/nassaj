/**
 * context-fit.routes.test.ts — A7 of T-2087 (ADR-223).
 *
 * `GET /api/providers/:provider/sessions/:sessionId/context-fit?model=` answers
 * the check-before-pin question for a session the caller may read. Real router,
 * real throwaway database, real session mandate: a caller who may not read the
 * session gets the same 404 as for an unknown id (the active-model contract).
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after, before } from 'node:test';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

import express from 'express';

import { closeConnection, initializeDatabase, projectsDb, sessionsDb, userDb } from '@/modules/database/index.js';
import { AppError } from '@/shared/utils.js';

import providerRouter from '../provider.routes.js';

type TestUser = { id: number; role: string };

const PUBLIC_SID = randomUUID();
const UNKNOWN_SID = '00000001-0000-4000-8000-000000000001';

let currentUser: TestUser | null = null;
let server: Server;
let baseUrl = '';
let root = '';
let originalHome: string | undefined;
let member: TestUser;
let outsider: TestUser;

const fitUrl = (sessionId: string, model = 'haiku'): string =>
  `/api/providers/claude/sessions/${sessionId}/context-fit?model=${encodeURIComponent(model)}`;

async function get(urlPath: string, user: TestUser | null): Promise<{ status: number; text: string }> {
  currentUser = user;
  const response = await fetch(`${baseUrl}${urlPath}`);
  return { status: response.status, text: await response.text() };
}

before(async () => {
  delete process.env.PROJECT_MEMBERSHIP_ENFORCE;
  closeConnection();
  root = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), 'nassaj-contextfit-'));
  originalHome = process.env.HOME;
  process.env.HOME = path.join(root, 'home');
  fs.mkdirSync(process.env.HOME);
  process.env.DATABASE_PATH = path.join(root, 'db.sqlite');
  await initializeDatabase();
  member = userDb.createUser('contextfit_member', 'hash', 'user') as TestUser;
  outsider = userDb.createUser('contextfit_outsider', 'hash', 'user') as TestUser;
  const projectPath = fs.mkdtempSync(path.join(root, 'project-'));
  projectsDb.createProjectPath(projectPath, 'Project', member.id);
  sessionsDb.createSession(PUBLIC_SID, 'claude', projectPath);

  const app = express();
  app.use((req, _res, next) => {
    (req as unknown as { user: TestUser | null }).user = currentUser;
    (req as unknown as { assertCurrentIdentity: () => boolean }).assertCurrentIdentity = () => true;
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
  delete process.env.PROJECT_MEMBERSHIP_ENFORCE;
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  fs.rmSync(root, { recursive: true, force: true });
});

test('a member gets the verdict contract; no usage source yet → unknown', async () => {
  const { status, text } = await get(fitUrl(PUBLIC_SID), member);
  assert.equal(status, 200);
  const { data } = JSON.parse(text);
  assert.deepEqual(Object.keys(data).sort(), ['budget', 'model', 'previousModel', 'used', 'verdict', 'window']);
  assert.equal(data.verdict, 'unknown');
  assert.equal(data.model, 'haiku');
});

test('A7: a non-member gets the same 404 as an unknown session, exactly like active-model', async () => {
  process.env.PROJECT_MEMBERSHIP_ENFORCE = '1';
  try {
    const hidden = await get(fitUrl(PUBLIC_SID), outsider);
    const unknown = await get(fitUrl(UNKNOWN_SID), outsider);
    const sibling = await get(`/api/providers/claude/sessions/${PUBLIC_SID}/active-model`, outsider);
    assert.equal(hidden.status, 404);
    assert.equal(unknown.status, 404);
    assert.equal(sibling.status, 404, 'the active-model route refuses the same caller');
    const code = (reply: { text: string }) => JSON.parse(reply.text).error.code;
    assert.equal(code(hidden), 'SESSION_NOT_FOUND');
    assert.equal(code(unknown), code(hidden));
    assert.equal(code(sibling), code(hidden));
  } finally {
    delete process.env.PROJECT_MEMBERSHIP_ENFORCE;
  }
});

test('a missing or malformed model is a 400', async () => {
  assert.equal((await get(`/api/providers/claude/sessions/${PUBLIC_SID}/context-fit`, member)).status, 400);
  assert.equal((await get(fitUrl(PUBLIC_SID, 'bad model; rm'), member)).status, 400);
});
