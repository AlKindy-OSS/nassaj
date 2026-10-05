/**
 * B-1373 — session discovery never auto-registers the service user's home (or a
 * root holding credentials) as a project; ordinary project paths still register.
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { after, before } from 'node:test';

import { closeConnection } from '@/modules/database/connection.js';
import { initializeDatabase } from '@/modules/database/init-db.js';
import { projectsDb } from '@/modules/database/repositories/projects.db.js';
import { sessionsDb } from '@/modules/database/repositories/sessions.db.js';

let tempDirectory = '';

before(async () => {
  tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'sessions-forbidden-root-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
  await initializeDatabase();
});

after(async () => {
  closeConnection();
  if (tempDirectory) await rm(tempDirectory, { recursive: true, force: true });
});

test('a session discovered in the home directory registers no project and no session', () => {
  const home = os.homedir();
  sessionsDb.createSession('home-session', 'claude', home);
  assert.equal(projectsDb.getProjectPath(home), null);
  assert.equal(sessionsDb.getSessionById('home-session'), null);
});

test('a session discovered inside a secret location registers no project', () => {
  const secretRoot = path.join(os.homedir(), '.nassaj-users', '7');
  sessionsDb.createSession('secret-session', 'claude', secretRoot);
  assert.equal(projectsDb.getProjectPath(secretRoot), null);
});

test('a session under an ordinary project path still registers its project', () => {
  const projectPath = path.join(os.homedir(), 'Project', 'ordinary');
  sessionsDb.createSession('ordinary-session', 'claude', projectPath);
  assert.ok(projectsDb.getProjectPath(projectPath));
  assert.equal(sessionsDb.getSessionById('ordinary-session')?.project_path, projectPath);
});
