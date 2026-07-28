/**
 * B-145 — POST /api/commands/execute must not read a project's .claude/commands
 * from an arbitrary caller-supplied projectPath. The path-containment check
 * alone accepted ANY directory as a project base, so an authenticated user could
 * point context.projectPath at a project they cannot see (or any directory) and
 * read its command files. The fix gates the project command source on
 * projectsDb.isProjectPathVisibleToUser(projectPath, userId).
 *
 * Framework: node:test + node:assert/strict via tsx against a REAL but
 * throwaway SQLite database (its own temp dir; the live database is never
 * touched). This exercises the real visibility predicate and repository rows
 * together with the real route. The router is mounted with an injected
 * authenticated user (the server applies authenticateToken before it), and real
 * command files on disk back the read.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after, before } from 'node:test';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

import express from 'express';

import { closeConnection } from '@/modules/database/connection.js';
import { initializeDatabase } from '@/modules/database/init-db.js';
import { userDb } from '@/modules/database/repositories/users.js';
import { projectsDb } from '@/modules/database/repositories/projects.db.js';

import { hashPassword } from '../services/password.service.js';
import commandsRouter from './commands.js';

let currentUser: { id: number; role: string } | null = null;
let server: Server;
let baseUrl = '';
let dbDir = '';
let ownerId = 0;
let otherId = 0;

// A registered project dir (owned by ownerId) and an unregistered/arbitrary dir,
// each with a real custom command under .claude/commands.
const registeredDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nassaj-cmd-reg-'));
const arbitraryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nassaj-cmd-arb-'));

function seedCommand(dir: string): string {
  const commandsDir = path.join(dir, '.claude', 'commands');
  fs.mkdirSync(commandsDir, { recursive: true });
  const file = path.join(commandsDir, 'greet.md');
  fs.writeFileSync(file, '---\ndescription: greet\n---\nHello $1\n', 'utf8');
  return file;
}
const registeredCmd = seedCommand(registeredDir);
const arbitraryCmd = seedCommand(arbitraryDir);

before(async () => {
  // Own isolated database so parallel test files never share a connection.
  closeConnection();
  dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nassaj-cmd-db-'));
  process.env.DATABASE_PATH = path.join(dbDir, 'db.sqlite');
  await initializeDatabase();

  const hash = await hashPassword('password1234');
  ownerId = userDb.createUser('cmd_owner', hash, 'user').id;
  otherId = userDb.createUser('cmd_other', hash, 'user').id;
  // registeredDir is a project OWNED by ownerId, forced PRIVATE (projects default
  // to 'public') → visible only to the owner, not otherId.
  projectsDb.createProjectPath(registeredDir, null, ownerId);
  const registeredRow = projectsDb.getProjectPath(registeredDir);
  projectsDb.setProjectVisibility(registeredRow!.project_id, 'private');
  // arbitraryDir is intentionally NOT registered (a raw attacker-supplied path).

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as { user?: unknown }).user = currentUser;
    next();
  });
  app.use('/api/commands', commandsRouter);

  server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  closeConnection();
  for (const dir of [registeredDir, arbitraryDir, dbDir]) {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

async function execute(body: unknown): Promise<Response> {
  return fetch(`${baseUrl}/api/commands/execute`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

test('B-145 attack: an unregistered/arbitrary projectPath is refused (403), no leak', async () => {
  currentUser = { id: ownerId, role: 'user' };

  const res = await execute({
    commandName: 'greet',
    commandPath: arbitraryCmd,
    context: { projectPath: arbitraryDir },
  });

  assert.equal(res.status, 403);
  const body = (await res.json()) as { error?: string; content?: string };
  assert.equal(body.error, 'Access denied');
  assert.equal(body.content, undefined); // the command file was never read
});

test('B-145 attack: a private project the caller cannot see is refused (403)', async () => {
  // registeredDir is owned by ownerId; otherId is not a member → not visible.
  currentUser = { id: otherId, role: 'user' };

  const res = await execute({
    commandName: 'greet',
    commandPath: registeredCmd,
    context: { projectPath: registeredDir },
  });

  assert.equal(res.status, 403);
});

test('B-145 behavior: the project owner passes and gets the command content (200)', async () => {
  currentUser = { id: ownerId, role: 'user' };

  const res = await execute({
    commandName: 'greet',
    commandPath: registeredCmd,
    context: { projectPath: registeredDir },
    args: ['world'],
  });

  assert.equal(res.status, 200);
  const body = (await res.json()) as { type?: string; content?: string };
  assert.equal(body.type, 'custom');
  assert.ok(body.content?.includes('Hello world'));
});
