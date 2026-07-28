/**
 * B-IDOR-BOARD — `GET /api/project-board/:projectId`.
 *
 * The route resolved the project path from the id and immediately read
 * `docs/project-state.json`, `docs/ARCHITECTURE.md` and `docs/ARCHITECTURE_AR.md`
 * off disk, returning them verbatim, with no visibility guard at all. That is the
 * project's whole task/issue/decision history and its architecture documents,
 * readable for any projectId that is guessed or enumerated — including a private
 * project.
 *
 * The route is JavaScript and `checkJs` is off, so tsc proves nothing here: this
 * test is what shows the guard is wired and reached, and that its 404 survives
 * the handler's own try/catch instead of collapsing into a 500.
 *
 * Framework: node:test + node:assert/strict via tsx.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after, before, mock } from 'node:test';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

import express from 'express';

import { closeConnection } from '@/modules/database/connection.js';
import { initializeDatabase } from '@/modules/database/init-db.js';
import { projectsDb } from '@/modules/database/repositories/projects.db.js';
import { userDb } from '@/modules/database/repositories/users.js';

// --- chokidar boundary mock (must be registered before importing the route) --
//
// On every AUTHORIZED read the route lazily attaches a live chokidar watcher to
// the project's three board files and keeps it in a module-level map with no
// teardown export (project-board.js:101-133, only `router` is exported). Each
// watcher is an libuv FSWatcher handle, so under the test runner the process
// never reaches an empty event loop: this file used to pass all four assertions
// and then hang forever, taking the whole `server/**/*.test.ts` run with it.
//
// The file-watching transport is not what this suite asserts (that is the
// board's live-push path), so it is mocked at the module boundary — no route
// logic is reimplemented here. The recorded calls are then used to assert
// something the real watcher makes observable: a REFUSED read must not attach a
// filesystem watcher to a hidden project's docs.
const watchCalls: string[][] = [];
mock.module('chokidar', {
  defaultExport: {
    watch: (targets: string[]) => {
      watchCalls.push(Array.isArray(targets) ? targets : [String(targets)]);
      const watcher = {
        on() {
          return watcher;
        },
        async close() {},
      };
      return watcher;
    },
  },
});

const { default: projectBoardRouter } = await import('./project-board.js');

type TestUser = { id: number; role: string };

let currentUser: TestUser | null = null;
let server: Server;
let baseUrl = '';
let dbDir = '';
let workspaceRoot = '';
let ownerUser: TestUser;
let strangerUser: TestUser;
let privateProjectId = '';
let publicProjectId = '';
let privateProjectPath = '';
let publicProjectPath = '';

/** How many watchers the route attached to files under `projectPath`. */
function watchersFor(projectPath: string): number {
  return watchCalls.filter((targets) => targets.some((target) => target.startsWith(projectPath)))
    .length;
}

const SECRET_MARKER = 'CONFIDENTIAL-ROADMAP-MARKER';

/** Writes the three board files a real project carries. */
function seedBoardFiles(projectPath: string, marker: string): void {
  const docs = path.join(projectPath, 'docs');
  fs.mkdirSync(docs, { recursive: true });
  fs.writeFileSync(
    path.join(docs, 'project-state.json'),
    JSON.stringify({ phases: [{ id: 'P0', name: marker }] }),
    'utf8',
  );
  fs.writeFileSync(path.join(docs, 'ARCHITECTURE.md'), `# ${marker}\n`, 'utf8');
  fs.writeFileSync(path.join(docs, 'ARCHITECTURE_AR.md'), `# ${marker}\n`, 'utf8');
}

async function getBoard(projectId: string, user: TestUser | null): Promise<{ status: number; body: string }> {
  currentUser = user;
  const response = await fetch(`${baseUrl}/api/project-board/${projectId}`);
  return { status: response.status, body: await response.text() };
}

before(async () => {
  closeConnection();
  dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nassaj-board-idor-db-'));
  workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nassaj-board-idor-ws-'));
  process.env.DATABASE_PATH = path.join(dbDir, 'db.sqlite');
  await initializeDatabase();

  ownerUser = userDb.createUser('board_owner', 'hash', 'user') as TestUser;
  strangerUser = userDb.createUser('board_stranger', 'hash', 'user') as TestUser;

  privateProjectPath = fs.mkdtempSync(path.join(workspaceRoot, 'private-'));
  seedBoardFiles(privateProjectPath, SECRET_MARKER);
  const privateCreated = projectsDb.createProjectPath(
    privateProjectPath,
    'Private Project',
    ownerUser.id,
  );
  privateProjectId = privateCreated.project?.project_id as string;
  projectsDb.setProjectVisibility(privateProjectId, 'private');

  publicProjectPath = fs.mkdtempSync(path.join(workspaceRoot, 'public-'));
  seedBoardFiles(publicProjectPath, 'PUBLIC-MARKER');
  const publicCreated = projectsDb.createProjectPath(
    publicProjectPath,
    'Public Project',
    ownerUser.id,
  );
  publicProjectId = publicCreated.project?.project_id as string;

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { user: TestUser | null }).user = currentUser;
    next();
  });
  app.use('/api/project-board', projectBoardRouter);

  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  // `server.close()` refuses NEW connections but only settles once the LAST
  // socket is gone, and Node's global fetch (undici) holds its sockets with
  // keep-alive. Measured, that adds only the undici idle delay here (the file's
  // former infinite hang was the unclosed chokidar watchers, see the mock
  // above), but destroying them explicitly (Node >= 18.2) keeps teardown
  // deterministic instead of timing-dependent.
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
    server.closeAllConnections();
  });
  closeConnection();
  delete process.env.DATABASE_PATH;
  fs.rmSync(dbDir, { recursive: true, force: true });
  fs.rmSync(workspaceRoot, { recursive: true, force: true });
});

test('CRUX: a stranger cannot read a private project\'s board (no content leaks)', async () => {
  const { status, body } = await getBoard(privateProjectId, strangerUser);

  assert.equal(status, 404, '404, not 403 — the project\'s existence is not disclosed');
  assert.equal(body.includes(SECRET_MARKER), false, 'no state/architecture content in the response');
  assert.equal(
    watchersFor(privateProjectPath),
    0,
    'the refusal happens BEFORE the board entry/watcher is created — a stranger '
    + 'cannot make the server watch a hidden project\'s docs',
  );
});

test('an unknown projectId is also a 404 (indistinguishable from a hidden one)', async () => {
  const { status } = await getBoard('does-not-exist-at-all', strangerUser);

  assert.equal(status, 404);
});

test('the owner still reads their own private board', async () => {
  const { status, body } = await getBoard(privateProjectId, ownerUser);

  assert.equal(status, 200);
  assert.ok(body.includes(SECRET_MARKER), 'owner gets the real content');
  assert.equal(
    watchersFor(privateProjectPath),
    1,
    'the authorized read is what arms the live-board watcher (guard first, watcher after)',
  );
});

test('a public project\'s board stays readable for the whole team', async () => {
  const { status, body } = await getBoard(publicProjectId, strangerUser);

  assert.equal(status, 200, 'public ⇒ readable (B-PRIV by design)');
  assert.ok(body.includes('PUBLIC-MARKER'));
  assert.equal(watchersFor(publicProjectPath), 1, 'the public board is watched for live updates');
});
