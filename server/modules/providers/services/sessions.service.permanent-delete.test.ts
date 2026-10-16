/**
 * B-1647 — permanent deletion of a SHARED session is narrower than 'write'.
 *
 * Under ADR-173 shared writing any author of one message is a session
 * participant, and participation grants 'write'. Before this fix that was
 * enough to delete the creator's conversation permanently (row + transcript on
 * disk). Owner decision 2026-10-16: permanent delete is allowed only to the
 * session creator (strict spawn owner), the project owner, or a platform
 * owner/admin — each still holding 'write'. Archive stays on 'write'.
 *
 * Refusal contract: a caller who can READ the session gets 403
 * `session_delete_forbidden`; one who cannot read it keeps the 404.
 *
 * Covers the service and the two REST surfaces (single DELETE ?force and the
 * bulk `delete_permanently` action) over a real sqlite DB and on-disk transcripts.
 *
 * Framework: node:test + node:assert/strict via tsx.
 */

// FIRST import — HOME becomes a /var/tmp sandbox: transcripts live in its Claude tree (B-1596).
// eslint-disable-next-line import-x/order -- must evaluate before every other import
import { SANDBOX_HOME } from '@/shared/__tests__/sandbox-home.js';

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test, { after, before, beforeEach } from 'node:test';

import express from 'express';

import {
  closeConnection,
  initializeDatabase,
  messageAuthorsDb,
  participantsDb,
  projectMembersDb,
  projectsDb,
  sessionsDb,
  userDb,
} from '@/modules/database/index.js';
import { AppError } from '@/shared/utils.js';

import providerRouter from '../provider.routes.js';

import { canPermanentlyDeleteSession, sessionsService } from './sessions.service.js';

type TestUser = { id: number; role: string };

let dbDir = '';
let workspaceRoot = '';
let server: Server;
let baseUrl = '';
let currentUser: TestUser | null = null;

let projectOwner: TestUser;
let creator: TestUser;
let coWriter: TestUser;
let admin: TestUser;
let reader: TestUser;
let projectPath = '';
let projectId = '';

let sessionId = '';
let transcript = '';

/** One shared session: spawned by `creator`, co-written by `coWriter`. */
function seedSession(): void {
  sessionId = randomUUID();
  transcript = path.join(SANDBOX_HOME, '.claude', 'projects', '-b1647', `${sessionId}.jsonl`);
  fs.mkdirSync(path.dirname(transcript), { recursive: true });
  fs.writeFileSync(transcript, `${JSON.stringify({ type: 'user', sessionId })}\n`, 'utf8');
  sessionsDb.createSession(sessionId, 'claude', projectPath, 'Shared', undefined, undefined, transcript);
  participantsDb.recordSpawn(sessionId, creator.id);
  messageAuthorsDb.recordUserMessage(sessionId, coWriter.id, 'one shared-writing message');
}

function assertStatus(error: unknown, statusCode: number, code: string): boolean {
  assert.ok(error instanceof AppError, 'refusal is an AppError');
  assert.equal(error.statusCode, statusCode);
  assert.equal(error.code, code);
  return true;
}

function assertSessionSurvives(id = sessionId, file = transcript): void {
  assert.notEqual(sessionsDb.getSessionById(id), null, 'row survives');
  assert.equal(fs.existsSync(file), true, 'transcript survives on disk');
}

async function call(
  method: 'DELETE' | 'POST',
  urlPath: string,
  user: TestUser | null,
  body?: unknown,
): Promise<{ status: number; json: Record<string, any> }> {
  currentUser = user;
  const response = await fetch(`${baseUrl}${urlPath}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: response.status, json: await response.json() as Record<string, any> };
}

before(async () => {
  closeConnection();
  dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nassaj-b1647-db-'));
  workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nassaj-b1647-ws-'));
  process.env.DATABASE_PATH = path.join(dbDir, 'db.sqlite');
  delete process.env.PROJECT_MEMBERSHIP_ENFORCE;
  await initializeDatabase();

  projectOwner = userDb.createUser('b1647_powner', 'hash', 'user') as TestUser;
  creator = userDb.createUser('b1647_creator', 'hash', 'user') as TestUser;
  coWriter = userDb.createUser('b1647_cowriter', 'hash', 'user') as TestUser;
  admin = userDb.createUser('b1647_admin', 'hash', 'admin') as TestUser;
  reader = userDb.createUser('b1647_reader', 'hash', 'user') as TestUser;

  projectPath = fs.mkdtempSync(path.join(workspaceRoot, 'proj-'));
  projectId = projectsDb.createProjectPath(projectPath, 'B1647', projectOwner.id).project?.project_id as string;
  projectMembersDb.add(projectId, creator.id, 'member', projectOwner.id);
  // The admin needs 'write' like everyone else; membership supplies it.
  projectMembersDb.add(projectId, admin.id, 'member', projectOwner.id);

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { user: TestUser | null }).user = currentUser;
    (req as unknown as { assertCurrentIdentity: () => boolean }).assertCurrentIdentity = () => true;
    next();
  });
  app.use('/api/providers', providerRouter);
  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const appError = err instanceof AppError ? err : null;
    res.status(appError?.statusCode ?? 500).json({
      success: false,
      error: { code: appError?.code ?? 'INTERNAL', message: appError?.message ?? 'error' },
    });
  });
  server = app.listen(0);
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

beforeEach(() => {
  seedSession();
});

after(() => {
  server?.close();
  closeConnection();
  delete process.env.DATABASE_PATH;
  delete process.env.PROJECT_MEMBERSHIP_ENFORCE;
  fs.rmSync(dbDir, { recursive: true, force: true });
  fs.rmSync(workspaceRoot, { recursive: true, force: true });
});

test('predicate: creator, project owner and admin may destroy; co-writer and reader may not', () => {
  const allowed = (user: TestUser | null) =>
    canPermanentlyDeleteSession(sessionId, projectPath, user?.id ?? null);
  assert.equal(allowed(creator), true, 'creator (strict spawn owner)');
  assert.equal(allowed(projectOwner), true, 'project owner');
  assert.equal(allowed(admin), true, 'platform admin with write');
  assert.equal(allowed(coWriter), false, 'shared-writing participant');
  assert.equal(allowed(reader), false, 'reader');
  assert.equal(allowed(null), false, 'anonymous');
});

test('service: a co-writer is refused permanent delete with 403 but can still archive', async () => {
  for (const options of [{ force: true }, { force: true, deletedFromDisk: true }]) {
    await assert.rejects(
      () => sessionsService.deleteOrArchiveSessionById(sessionId, coWriter.id, options),
      (error: unknown) => assertStatus(error, 403, 'session_delete_forbidden'),
    );
    assertSessionSurvives();
  }

  const archived = await sessionsService.deleteOrArchiveSessionById(sessionId, coWriter.id, {});
  assert.equal(archived.action, 'archived', 'archive stays on the write mandate');
  assertSessionSurvives();
});

test('service: a reader gets 403, an unknown id or anonymous caller keeps the 404', async () => {
  await assert.rejects(
    () => sessionsService.deleteOrArchiveSessionById(sessionId, reader.id, { force: true, deletedFromDisk: true }),
    (error: unknown) => assertStatus(error, 403, 'session_delete_forbidden'),
  );
  await assert.rejects(
    () => sessionsService.deleteOrArchiveSessionById(sessionId, null, { force: true, deletedFromDisk: true }),
    (error: unknown) => assertStatus(error, 404, 'SESSION_NOT_FOUND'),
  );
  await assert.rejects(
    () => sessionsService.deleteOrArchiveSessionById(randomUUID(), reader.id, { force: true }),
    (error: unknown) => assertStatus(error, 404, 'SESSION_NOT_FOUND'),
  );
  assertSessionSurvives();
});

test('service: under ADR-172 enforcement a non-member keeps the 404, a plain member gets 403', async () => {
  const outsider = userDb.createUser(`b1647_out_${sessionId.slice(0, 8)}`, 'hash', 'user') as TestUser;
  const member = userDb.createUser(`b1647_mem_${sessionId.slice(0, 8)}`, 'hash', 'user') as TestUser;
  projectMembersDb.add(projectId, member.id, 'member', projectOwner.id);
  process.env.PROJECT_MEMBERSHIP_ENFORCE = '1';
  try {
    await assert.rejects(
      () => sessionsService.deleteOrArchiveSessionById(sessionId, outsider.id, { force: true, deletedFromDisk: true }),
      (error: unknown) => assertStatus(error, 404, 'SESSION_NOT_FOUND'),
    );
    await assert.rejects(
      () => sessionsService.deleteOrArchiveSessionById(sessionId, member.id, { force: true, deletedFromDisk: true }),
      (error: unknown) => assertStatus(error, 403, 'session_delete_forbidden'),
    );
    assertSessionSurvives();
  } finally {
    delete process.env.PROJECT_MEMBERSHIP_ENFORCE;
  }
});

for (const [label, pick] of [
  ['creator', () => creator],
  ['project owner', () => projectOwner],
  ['admin', () => admin],
] as const) {
  test(`service: the ${label} deletes permanently, transcript included`, async () => {
    const result = await sessionsService.deleteOrArchiveSessionById(sessionId, pick().id, {
      force: true,
      deletedFromDisk: true,
    });
    assert.equal(result.action, 'deleted');
    assert.equal(result.deletedFromDisk, true);
    assert.equal(sessionsDb.getSessionById(sessionId), null);
    assert.equal(fs.existsSync(transcript), false);
  });
}

test('REST DELETE ?force: co-writer 403 + survives, archive allowed, creator deletes', async () => {
  const forced = await call('DELETE', `/api/providers/sessions/${sessionId}?force=true`, coWriter);
  assert.equal(forced.status, 403);
  assert.equal(forced.json.error.code, 'session_delete_forbidden');
  assertSessionSurvives();

  const anonymous = await call('DELETE', `/api/providers/sessions/${sessionId}?force=true`, null);
  assert.equal(anonymous.status, 404, 'unresolved identity stays non-disclosing');
  assertSessionSurvives();

  const archived = await call('DELETE', `/api/providers/sessions/${sessionId}`, coWriter);
  assert.equal(archived.status, 200);
  assert.equal(archived.json.data.action, 'archived');

  const deleted = await call('DELETE', `/api/providers/sessions/${sessionId}?force=true`, creator);
  assert.equal(deleted.status, 200);
  assert.equal(deleted.json.data.action, 'deleted');
  assert.equal(fs.existsSync(transcript), false);
});

test('REST bulk delete_permanently: per-item results, refused items survive untouched', async () => {
  const ownId = sessionId;
  const ownTranscript = transcript;
  seedSession(); // a second shared session, also spawned by `creator`
  const otherId = sessionId;
  const otherTranscript = transcript;
  // coWriter spawns its own session: it is that session's creator.
  const mineId = randomUUID();
  sessionsDb.createSession(mineId, 'claude', projectPath, 'Mine');
  participantsDb.recordSpawn(mineId, coWriter.id);
  const unknownId = randomUUID();

  const response = await call('POST', '/api/providers/sessions/bulk', coWriter, {
    action: 'delete_permanently',
    ids: [ownId, mineId, unknownId, otherId],
  });
  assert.equal(response.status, 200);
  const byId = new Map<string, any>(response.json.data.results.map((row: any) => [row.id, row]));
  assert.equal(byId.get(ownId).success, false);
  assert.equal(byId.get(ownId).error.code, 'session_delete_forbidden');
  assert.equal(byId.get(otherId).error.code, 'session_delete_forbidden');
  assert.equal(byId.get(unknownId).error.code, 'SESSION_NOT_FOUND');
  assert.equal(byId.get(mineId).success, true, 'the co-writer may destroy its own session');
  assert.equal(sessionsDb.getSessionById(mineId), null);
  assertSessionSurvives(ownId, ownTranscript);
  assertSessionSurvives(otherId, otherTranscript);

  const archive = await call('POST', '/api/providers/sessions/bulk', coWriter, {
    action: 'archive',
    ids: [ownId, otherId],
  });
  assert.ok(archive.json.data.results.every((row: any) => row.success), 'bulk archive still allowed');
});
