/**
 * B-1524 — live board push for an externally bound state file, with the REAL
 * chokidar watcher (the visibility suite mocks it).
 *
 * A project whose docs/project-state.json is a symlink to the operator-bound
 * file (NASSAJ_BOARD_EXTERNAL_BINDINGS) must still push `project-board-updated`
 * when that external file is replaced by rename (how atomic writers save).
 *
 * Framework: node:test + node:assert/strict via tsx.
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
import { projectsDb } from '@/modules/database/repositories/projects.db.js';
import { userDb } from '@/modules/database/repositories/users.js';

import projectBoardRouter, { __test__ as routeTest } from './project-board.js';

type Sent = { type: string; projectId: string };

const sent: Sent[] = [];
const wss = { clients: new Set([{ readyState: 1, send: (raw: string) => sent.push(JSON.parse(raw)) }]) };

let server: Server;
let baseUrl = '';
let dbDir = '';
let fixtureRoot = '';
let projectId = '';
let boundFile = '';
let user: { id: number };
const previousBindings = process.env.NASSAJ_BOARD_EXTERNAL_BINDINGS;

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return predicate();
}

before(async () => {
  closeConnection();
  dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nassaj-board-watch-db-'));
  fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nassaj-board-watch-'));
  process.env.DATABASE_PATH = path.join(dbDir, 'db.sqlite');
  await initializeDatabase();
  user = userDb.createUser('watch_owner', 'hash', 'user') as { id: number };

  const projectPath = path.join(fixtureRoot, 'project');
  const externalDir = path.join(fixtureRoot, 'governance');
  fs.mkdirSync(path.join(projectPath, 'docs'), { recursive: true });
  fs.mkdirSync(externalDir);
  boundFile = path.join(externalDir, 'project-state.json');
  fs.writeFileSync(boundFile, JSON.stringify({ tasks: [{ id: 'EXT-1' }] }));
  fs.symlinkSync(boundFile, path.join(projectPath, 'docs', 'project-state.json'));

  projectId = projectsDb.createProjectPath(projectPath, 'Watched', user.id).project?.project_id as string;
  process.env.NASSAJ_BOARD_EXTERNAL_BINDINGS = `${projectId}=${boundFile}`;

  const app = express();
  app.locals.wss = wss;
  app.use((req, _res, next) => {
    (req as unknown as { user: { id: number } }).user = user;
    next();
  });
  app.use('/api/project-board', projectBoardRouter);
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await routeTest.closeAll();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
    server.closeAllConnections();
  });
  closeConnection();
  delete process.env.DATABASE_PATH;
  if (previousBindings === undefined) delete process.env.NASSAJ_BOARD_EXTERNAL_BINDINGS;
  else process.env.NASSAJ_BOARD_EXTERNAL_BINDINGS = previousBindings;
  fs.rmSync(dbDir, { recursive: true, force: true });
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
});

test('bound external state is served and a rename-replace of it pushes an update', async () => {
  const response = await fetch(`${baseUrl}/api/project-board/${projectId}`);
  const parsed = await response.json();
  assert.equal(parsed.stateReason, 'ok');
  assert.equal(parsed.state.tasks[0].id, 'EXT-1');

  await new Promise((resolve) => setTimeout(resolve, 400)); // let chokidar settle
  sent.length = 0;
  const staging = path.join(path.dirname(boundFile), '.project-state.json.tmp');
  fs.writeFileSync(staging, JSON.stringify({ tasks: [{ id: 'EXT-2' }] }));
  fs.renameSync(staging, boundFile);

  const pushed = await waitFor(
    () => sent.some((message) => message.type === 'project-board-updated' && message.projectId === projectId),
    5000,
  );
  assert.ok(pushed, 'the replaced external target must trigger a board push');

  const again = await (await fetch(`${baseUrl}/api/project-board/${projectId}`)).json();
  assert.equal(again.state.tasks[0].id, 'EXT-2');

  // A second replacement: the watch must survive the first inode swap.
  await new Promise((resolve) => setTimeout(resolve, 400));
  sent.length = 0;
  fs.writeFileSync(staging, JSON.stringify({ tasks: [{ id: 'EXT-3' }] }));
  fs.renameSync(staging, boundFile);
  assert.ok(await waitFor(() => sent.length > 0, 5000), 'second replacement also pushes');
  assert.equal(sent.length, 1, 'link path and bound target events coalesce into one push');
});
