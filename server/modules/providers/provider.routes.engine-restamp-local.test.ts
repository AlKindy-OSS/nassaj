/**
 * ADR-227 (local↔cloud move refused) — the engine re-stamp route must not move a
 * chat pinned to a local model server onto a cloud engine. Its past turns are
 * booked at zero through that pin (T-2103); a re-stamp would also re-attribute
 * them to the cloud vendor. Body-neutral: any session whose stored pin is a local
 * pin is refused, whatever body created it.
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after, before } from 'node:test';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

import express from 'express';

import {
  closeConnection, getConnection, initializeDatabase, participantsDb, sessionsDb, userDb,
} from '@/modules/database/index.js';
import { PIN_SOURCE } from '@/services/isolation/engine-pin.js';
import { formatLocalEnginePin } from '@/services/isolation/local-engine-pin.js';
import { AppError } from '@/shared/utils.js';

import providerRouter from './provider.routes.js';

type TestUser = { id: number; role: string };
let currentUser: TestUser | null = null;
let server: Server;
let baseUrl = '';
let sandbox = '';
let member: TestUser;
const originalEnv = { HOME: process.env.HOME, DATABASE_PATH: process.env.DATABASE_PATH };

before(async () => {
  closeConnection();
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'nassaj-restamp-local-'));
  process.env.HOME = path.join(sandbox, 'home');
  fs.mkdirSync(process.env.HOME, { recursive: true });
  process.env.DATABASE_PATH = path.join(sandbox, 'db.sqlite');
  await initializeDatabase();
  member = userDb.createUser('restamp_local', 'hash', 'user') as TestUser;
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    Object.assign(req, { user: currentUser, assertCurrentIdentity: () => true });
    next();
  });
  app.use('/api/providers', providerRouter);
  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (err instanceof AppError) {
      res.status(err.statusCode).json({ error: err.message, code: err.code });
      return;
    }
    res.status(500).json({ code: 'INTERNAL_ERROR' });
  });
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  closeConnection();
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(sandbox, { recursive: true, force: true });
});

/** A session the member took part in, pinned to `engine` (or unpinned). */
function seedSession(provider: string, engine: string | null): string {
  const sessionId = crypto.randomUUID();
  getConnection().prepare(
    'INSERT INTO sessions (session_id, provider, project_path, jsonl_path) VALUES (?, ?, NULL, NULL)',
  ).run(sessionId, provider);
  participantsDb.recordSpawn(sessionId, member.id, { provider, projectPath: null });
  if (engine) sessionsDb.setSessionEnginePin(sessionId, engine, PIN_SOURCE.SERVER_VERDICT);
  return sessionId;
}

async function restamp(sessionId: string, engine: string) {
  currentUser = member;
  const response = await fetch(`${baseUrl}/api/providers/claude/sessions/${sessionId}/engine`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ engine, model: 'claude-opus-5', acknowledgedExport: true }),
  });
  const text = await response.text();
  return { status: response.status, json: text ? JSON.parse(text) : {} };
}

const LOCAL_PIN = formatLocalEnginePin({
  serverId: '0b9c6a3e-6f1e-4c41-9a4e-2f1b9e0c7d11', ownerId: 1, origin: 'http://127.0.0.1:18080',
});

for (const provider of ['claude', 'codex']) {
  test(`a ${provider} chat pinned to my local server cannot be re-stamped to a cloud engine`, async () => {
    const sessionId = seedSession(provider, LOCAL_PIN);
    const result = await restamp(sessionId, 'anthropic');
    assert.equal(result.status, 409);
    assert.equal(result.json.code, 'ENGINE_RESTAMP_LOCAL_PIN');
    assert.equal(sessionsDb.getSessionEnginePin(sessionId)?.engine, LOCAL_PIN, 'the local pin is untouched');
  });
}

test('a cloud chat cannot be re-stamped onto a local pin', async () => {
  const sessionId = seedSession('claude', 'anthropic');
  const result = await restamp(sessionId, LOCAL_PIN);
  assert.equal(result.status, 409);
  assert.equal(result.json.code, 'ENGINE_RESTAMP_LOCAL_PIN');
  assert.equal(sessionsDb.getSessionEnginePin(sessionId)?.engine, 'anthropic');
});

test('a cloud chat still passes the local guard (behaviour unchanged)', async () => {
  const sessionId = seedSession('claude', null);
  const result = await restamp(sessionId, 'anthropic');
  assert.notEqual(result.json.code, 'ENGINE_RESTAMP_LOCAL_PIN');
});
