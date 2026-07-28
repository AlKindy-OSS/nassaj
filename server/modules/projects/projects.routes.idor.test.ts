/**
 * B-IDOR-PROJECT — the mutating project routes must not be guarded by the READ
 * predicate.
 *
 * The bug: `DELETE /api/projects/:projectId`, `PUT /:projectId/rename`,
 * `POST /:projectId/toggle-star` and `POST /:projectId/restore` all called
 * `assertProjectVisible`, which returns true for EVERY `visibility = 'public'`
 * project to ANY authenticated user. Every project on the live install is public
 * and three of its five accounts hold the plain `user` role, so the guard
 * authorized nothing: any of them could rename, (un)star, archive — or, with
 * `?force=true`, permanently destroy — the owner's project, taking every session
 * row and every transcript file on disk with it.
 *
 * These tests reproduce exactly that shape: a PUBLIC project created by one user,
 * a real session row with a real `.jsonl` transcript on disk, and a second
 * authenticated plain-`user` account that is neither creator, member, nor
 * participant. The real router is mounted over a real (throwaway) SQLite database
 * behind an injected `req.user`, exactly as index.js does after authenticateToken,
 * and the production global error middleware is reproduced so the status codes
 * asserted here are the ones a client actually receives.
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

import { closeConnection, initializeDatabase, projectsDb, sessionsDb, userDb } from '@/modules/database/index.js';
import { AppError } from '@/shared/utils.js';

import projectsRouter from './projects.routes.js';

type TestUser = { id: number; role: string };

let currentUser: TestUser | null = null;
let server: Server;
let baseUrl = '';
let dbDir = '';
let workspaceRoot = '';

let ownerUser: TestUser;
let strangerUser: TestUser;

const SESSION_ID = 'idor-project-session-001';
let projectId = '';
let projectPath = '';
let transcriptPath = '';

/** Recreates the project + session + transcript fixture from scratch. */
function seedPublicProject(): void {
  projectPath = fs.mkdtempSync(path.join(workspaceRoot, 'proj-'));
  transcriptPath = path.join(projectPath, `${SESSION_ID}.jsonl`);
  fs.writeFileSync(transcriptPath, '{"type":"message"}\n', 'utf8');

  const created = projectsDb.createProjectPath(projectPath, 'Owner Project', ownerUser.id);
  projectId = created.project?.project_id ?? '';
  assert.notEqual(projectId, '', 'fixture project row exists');

  // A real session row for the project path, carrying the transcript that
  // force-delete unlinks.
  sessionsDb.createSession(SESSION_ID, 'claude', projectPath, 'Owner session', undefined, undefined, transcriptPath);

  // Production default — and the state of every project on the live install.
  assert.equal(projectsDb.getProjectVisibility(projectId), 'public', 'fixture project is public');
}

async function call(
  method: string,
  urlPath: string,
  user: TestUser | null,
  body?: unknown,
): Promise<{ status: number; json: Record<string, unknown> }> {
  currentUser = user;
  const response = await fetch(`${baseUrl}${urlPath}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: response.status, json };
}

before(async () => {
  closeConnection();
  dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nassaj-proj-idor-db-'));
  workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nassaj-proj-idor-ws-'));
  process.env.DATABASE_PATH = path.join(dbDir, 'db.sqlite');
  await initializeDatabase();

  ownerUser = userDb.createUser('idor_owner', 'hash', 'user') as TestUser;
  strangerUser = userDb.createUser('idor_stranger', 'hash', 'user') as TestUser;
  // The threat model is a PLAIN member, not an admin: this is the live install's
  // three `user`-role accounts.
  assert.equal(strangerUser.role, 'user', 'attacker holds the plain user role');

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { user: TestUser | null }).user = currentUser;
    next();
  });
  app.use('/api/projects', projectsRouter);
  // Same shape as the production global error middleware in index.js.
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

beforeEach(() => {
  seedPublicProject();
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  closeConnection();
  delete process.env.DATABASE_PATH;
  fs.rmSync(dbDir, { recursive: true, force: true });
  fs.rmSync(workspaceRoot, { recursive: true, force: true });
});

test('CRUX: a stranger cannot force-delete a PUBLIC project (row, sessions and transcript survive)', async () => {
  // The pre-fix guard (assertProjectVisible) passes here — the project is public
  // — which is exactly why it authorized nothing.
  assert.equal(
    projectsDb.isProjectVisibleToUser(projectId, strangerUser.id),
    true,
    'the READ predicate admits the stranger (public project) — the old guard',
  );

  const { status } = await call('DELETE', `/api/projects/${projectId}?force=true`, strangerUser);

  assert.equal(status, 404, '404, not 403: existence is never disclosed');
  assert.notEqual(projectsDb.getProjectById(projectId), null, 'project row survives');
  assert.notEqual(sessionsDb.getSessionById(SESSION_ID), null, 'session row survives');
  assert.equal(fs.existsSync(transcriptPath), true, 'transcript file survives on disk');
});

test('a stranger cannot archive (soft-delete) a public project', async () => {
  const { status } = await call('DELETE', `/api/projects/${projectId}`, strangerUser);

  assert.equal(status, 404);
  assert.equal(Boolean(projectsDb.getProjectById(projectId)?.isArchived), false, 'project stays active');
});

test('a stranger cannot rename a public project', async () => {
  const { status } = await call('PUT', `/api/projects/${projectId}/rename`, strangerUser, {
    displayName: 'pwned',
  });

  assert.equal(status, 404);
  assert.equal(
    projectsDb.getProjectById(projectId)?.custom_project_name,
    'Owner Project',
    'display name unchanged',
  );
});

test('a stranger cannot toggle the (shared) star of a public project', async () => {
  const before = Boolean(projectsDb.getProjectById(projectId)?.isStarred);

  const { status } = await call('POST', `/api/projects/${projectId}/toggle-star`, strangerUser);

  assert.equal(status, 404);
  assert.equal(Boolean(projectsDb.getProjectById(projectId)?.isStarred), before, 'star unchanged');
});

test('a stranger cannot restore an archived public project', async () => {
  projectsDb.updateProjectIsArchivedById(projectId, true);

  const { status } = await call('POST', `/api/projects/${projectId}/restore`, strangerUser);

  assert.equal(status, 404);
  assert.equal(Boolean(projectsDb.getProjectById(projectId)?.isArchived), true, 'still archived');
});

test('the creator keeps full control: rename, star, archive, restore, force-delete', async () => {
  const renamed = await call('PUT', `/api/projects/${projectId}/rename`, ownerUser, { displayName: 'Renamed' });
  assert.equal(renamed.status, 200, 'creator renames');
  assert.equal(projectsDb.getProjectById(projectId)?.custom_project_name, 'Renamed');

  const starred = await call('POST', `/api/projects/${projectId}/toggle-star`, ownerUser);
  assert.equal(starred.status, 200, 'creator stars');
  assert.equal(Boolean(projectsDb.getProjectById(projectId)?.isStarred), true);

  const archived = await call('DELETE', `/api/projects/${projectId}`, ownerUser);
  assert.equal(archived.status, 200, 'creator archives');
  assert.equal(Boolean(projectsDb.getProjectById(projectId)?.isArchived), true);

  const restored = await call('POST', `/api/projects/${projectId}/restore`, ownerUser);
  assert.equal(restored.status, 200, 'creator restores');
  assert.equal(Boolean(projectsDb.getProjectById(projectId)?.isArchived), false);

  const deleted = await call('DELETE', `/api/projects/${projectId}?force=true`, ownerUser);
  assert.equal(deleted.status, 200, 'creator force-deletes');
  assert.equal(projectsDb.getProjectById(projectId), null, 'project row gone');
  assert.equal(fs.existsSync(transcriptPath), false, 'transcript removed — the destructive path still works');
});

test('an explicit project member may WRITE but may not FORCE-DELETE (participant ⊄ manager)', async () => {
  const memberUser = userDb.createUser(`idor_member_${Date.now()}`, 'hash', 'user') as TestUser;
  const added = await call('POST', `/api/projects/${projectId}/members`, ownerUser, {
    userId: memberUser.id,
    role: 'member',
  });
  assert.equal(added.status, 200, 'creator adds a member');

  const renamed = await call('PUT', `/api/projects/${projectId}/rename`, memberUser, { displayName: 'By member' });
  assert.equal(renamed.status, 200, 'a member may rename (write mandate)');

  const destroyed = await call('DELETE', `/api/projects/${projectId}?force=true`, memberUser);
  assert.equal(destroyed.status, 404, 'a plain member may NOT irreversibly destroy the project');
  assert.notEqual(projectsDb.getProjectById(projectId), null, 'project row survives');
  assert.equal(fs.existsSync(transcriptPath), true, 'transcript survives');
});

test('the platform owner retains administrative control over a project they did not create', async () => {
  const platformOwner = userDb.createUser(`idor_platform_${Date.now()}`, 'hash', 'owner') as TestUser;

  const renamed = await call('PUT', `/api/projects/${projectId}/rename`, platformOwner, { displayName: 'By owner' });
  assert.equal(renamed.status, 200, 'platform owner manages metadata');
  assert.equal(projectsDb.getProjectById(projectId)?.custom_project_name, 'By owner');
});
