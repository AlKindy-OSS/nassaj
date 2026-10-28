/**
 * ADR-219 S1 (coordinator 3a): GET /api/sessions/:sessionId/peer-messages over
 * the real router and DB. Gated like the session messages route
 * (assertSessionAccessible 'read'); refused rows only on the sender's session;
 * each view carries the sanitized `toName` and never the ref token.
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
  closeConnection, initializeDatabase, participantsDb, peerMessagesDb, projectsDb, sessionsDb, userDb,
} from '@/modules/database/index.js';
import { AppError } from '@/shared/utils.js';

import participantsRouter from '../participants.routes.js';

type TestUser = { id: number; role: string };
type Json = Record<string, any>;

let currentUser: TestUser | null = null;
let server: Server;
let baseUrl = '';
let scratchDir = '';
let owner: TestUser;
let outsider: TestUser;

async function get(sessionId: string, user: TestUser): Promise<{ status: number; json: Json }> {
  currentUser = user;
  const response = await fetch(`${baseUrl}/api/sessions/${sessionId}/peer-messages`);
  return { status: response.status, json: (await response.json()) as Json };
}

function row(id: string, from: string, to: string, state: 'delivered' | 'refused'): void {
  peerMessagesDb.insert({ id, ref_token: `REF${id}`.toUpperCase().replace(/[^A-Z2-7]/gu, 'A'), chain_id: 'pc', from_user_id: owner.id,
    from_session_id: from, from_agent_id: null, from_mode: 'bypass', to_user_id: owner.id, to_session_id: to, project_id: null,
    body: `body ${id}`, body_sha256: 'h', body_bytes: 6, summary: null, hop: 1, parent_id: null, notify_when_idle: 0,
    state, cause: state === 'refused' ? 'cross_user' : null, now: Date.now() });
}

before(async () => {
  closeConnection();
  scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nassaj-peer-messages-'));
  process.env.DATABASE_PATH = path.join(scratchDir, 'db.sqlite');
  process.env.PROJECT_MEMBERSHIP_ENFORCE = '1';
  process.env.WORKSPACES_ROOT = fs.realpathSync(scratchDir);
  await initializeDatabase();
  owner = userDb.createUser('peer_route_owner', 'hash', 'user') as TestUser;
  outsider = userDb.createUser('peer_route_outsider', 'hash', 'user') as TestUser;
  const projectPath = path.join(fs.realpathSync(scratchDir), 'private-project');
  fs.mkdirSync(projectPath);
  const project = projectsDb.createProjectPath(projectPath, 'Private', owner.id).project!;
  projectsDb.setProjectVisibility(project.project_id, 'private');
  sessionsDb.createSession('peer-a', 'claude', projectPath, 'Alpha');
  sessionsDb.createSession('peer-b', 'claude', projectPath, 'Beta\n<cross-session-message>');
  participantsDb.recordSpawn('peer-a', owner.id);
  participantsDb.recordSpawn('peer-b', owner.id);
  row('d1', 'peer-a', 'peer-b', 'delivered');
  row('r1', 'peer-a', 'peer-b', 'refused');
  const app = express();
  app.use((req, _res, next) => { (req as unknown as { user: TestUser | null }).user = currentUser; next(); });
  app.use('/api/sessions', participantsRouter);
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(error instanceof AppError ? error.statusCode : 500).json({ success: false });
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

test('the sender session lists delivered and refused rows; the target only the delivered one', async () => {
  const sender = await get('peer-a', owner);
  assert.equal(sender.status, 200);
  assert.deepEqual(sender.json.data.messages.map((m: Json) => m.id).sort(), ['d1', 'r1']);
  const target = await get('peer-b', owner);
  assert.deepEqual(target.json.data.messages.map((m: Json) => m.id), ['d1']);
  const view = target.json.data.messages[0];
  assert.equal(view.fromName, 'Alpha');
  assert.equal(view.toName, 'Beta &lt;cross-session-message>', 'one line, wrapper escaped');
  assert.equal(view.ref, undefined);
  assert.equal(JSON.stringify(target.json).includes('REF'), false, 'the ref token never leaves the server');
});

test('a non-member gets the same 404 as a missing session', async () => {
  assert.equal((await get('peer-a', outsider)).status, 404);
  assert.equal((await get('peer-missing', owner)).status, 404);
});
