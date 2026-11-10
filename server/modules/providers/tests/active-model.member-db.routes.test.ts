/**
 * active-model.member-db.routes.test.ts — B-1752.
 *
 * GET/DELETE `/api/providers/opencode/sessions/:sessionId/active-model` must read
 * the CALLER's opencode.db. A member with a runnable local model server runs their
 * opencode turns inside their own XDG tree, so the session row (and its model)
 * exists ONLY in `<member tree>/.local/share/opencode/opencode.db`. Without the
 * authenticated user id the provider read the operator's shared database, missed
 * the session and reported the catalog default instead of the session's model.
 *
 * Real router, real sqlite app database, real member opencode.db fixture; no
 * network and no local model server is contacted.
 *
 * Framework: node:test + node:assert/strict via tsx.
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after, before } from 'node:test';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

import Database from 'better-sqlite3';
import express from 'express';

import {
  appConfigDb,
  closeConnection,
  initializeDatabase,
  localModelServersDb,
  projectsDb,
  sessionsDb,
  userDb,
} from '@/modules/database/index.js';
import { AppError } from '@/shared/utils.js';

import providerRouter from '../provider.routes.js';
import { resolveOpenCodeDatabasePathForUser } from '../list/opencode/opencode-home.js';

type TestUser = { id: number; role: string };

const SERVER_ID = '7f1c2a9e-4b1d-4c8e-9a51-0d3b6e2f8c11';
const LOCAL_PROVIDER_ID = `nassaj_local_${SERVER_ID.replaceAll('-', '')}`;
const LOCAL_MODEL = `${LOCAL_PROVIDER_ID}/qwen3.6-35b`;
const SESSION_ID = randomUUID();

let currentUser: TestUser | null = null;
let server: Server;
let baseUrl = '';
let sandbox = '';
let originalHome: string | undefined;
let member: TestUser;

const activeModelUrl = `/api/providers/opencode/sessions/${SESSION_ID}/active-model`;

async function call(method: 'GET' | 'DELETE'): Promise<{ status: number; body: any }> {
  currentUser = member;
  const response = await fetch(`${baseUrl}${activeModelUrl}`, { method });
  return { status: response.status, body: await response.json() };
}

/** Writes the minimal opencode `session` table the models provider reads. */
function writeMemberOpenCodeSession(dbPath: string): void {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  try {
    db.exec(`CREATE TABLE session (id TEXT PRIMARY KEY, model TEXT, agent TEXT, directory TEXT,
      time_created INTEGER, time_updated INTEGER)`);
    db.prepare('INSERT INTO session (id, model, agent, directory, time_created, time_updated) VALUES (?,?,?,?,?,?)')
      .run(SESSION_ID, JSON.stringify({ id: 'qwen3.6-35b', providerID: LOCAL_PROVIDER_ID }), 'build', sandbox, 1, 2);
  } finally {
    db.close();
  }
}

before(async () => {
  closeConnection();
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'nassaj-b1752-'));
  originalHome = process.env.HOME;
  process.env.HOME = path.join(sandbox, 'home');
  fs.mkdirSync(process.env.HOME, { recursive: true });
  process.env.DATABASE_PATH = path.join(sandbox, 'db.sqlite');
  await initializeDatabase();

  member = userDb.createUser('b1752_member', 'hash', 'user') as TestUser;
  appConfigDb.set('local_models.enabled', 'true');
  appConfigDb.set('local_models.consent_version', '1');
  localModelServersDb.save({
    id: SERVER_ID, ownerId: member.id, providerId: LOCAL_PROVIDER_ID, name: 'Local qwen',
    baseUrl: 'http://127.0.0.1:9/v1', runtime: 'llamacpp', models: [{ id: 'qwen3.6-35b' }],
  });

  const projectPath = fs.mkdtempSync(path.join(sandbox, 'proj-'));
  projectsDb.createProjectPath(projectPath, 'Member Project', member.id);
  sessionsDb.createSession(SESSION_ID, 'opencode', projectPath);
  writeMemberOpenCodeSession(resolveOpenCodeDatabasePathForUser(member.id));

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { user: TestUser | null }).user = currentUser;
    (req as unknown as { assertCurrentIdentity: () => boolean }).assertCurrentIdentity = () => true;
    next();
  });
  app.use('/api/providers', providerRouter);
  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const status = err instanceof AppError ? err.statusCode : 500;
    res.status(status).json({ success: false, error: { code: err instanceof AppError ? err.code : 'INTERNAL_ERROR' } });
  });
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  closeConnection();
  delete process.env.DATABASE_PATH;
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  fs.rmSync(sandbox, { recursive: true, force: true });
});

test('GET returns the model stored in the member opencode.db, not the catalog default', async () => {
  const { status, body } = await call('GET');
  assert.equal(status, 200, JSON.stringify(body));
  assert.equal(body.data.source, 'provider-current');
  assert.equal(body.data.model, LOCAL_MODEL);
});

test('DELETE reports the member session model as what the next turn resumes on', async () => {
  const { status, body } = await call('DELETE');
  assert.equal(status, 200, JSON.stringify(body));
  assert.equal(body.data.cleared, false);
  assert.equal(body.data.model, LOCAL_MODEL);
});
