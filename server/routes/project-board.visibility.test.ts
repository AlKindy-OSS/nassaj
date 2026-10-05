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
 * B-1524: the board is read from the project's own folder (no governance
 * catalog). This suite also covers `stateReason`, lastGoodState on invalid
 * JSON, and the ADR-172 membership flag (404 for a non-member, 200 for admin).
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
let adminUser: TestUser;
let privateProjectId = '';
let publicProjectId = '';
let privateProjectPath = '';
let publicProjectPath = '';
let app: express.Express;

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
  workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nassaj-board idor ws مشروع-'));
  process.env.DATABASE_PATH = path.join(dbDir, 'db.sqlite');
  await initializeDatabase();

  ownerUser = userDb.createUser('board_owner', 'hash', 'user') as TestUser;
  strangerUser = userDb.createUser('board_stranger', 'hash', 'user') as TestUser;
  adminUser = userDb.createUser('board_admin', 'hash', 'admin') as TestUser;

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

  app = express();
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

test('ADR-089: a teammate reads any registered project\'s board', async () => {
  const { status, body } = await getBoard(privateProjectId, strangerUser);

  assert.equal(status, 200, 'project visibility is retired — the board is shared with the team');
  assert.equal(body.includes(SECRET_MARKER), true, 'the board content is served, not withheld');
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

test('state and architecture come from the project folder with stateReason ok', async () => {
  const { status, body } = await getBoard(publicProjectId, ownerUser);
  assert.equal(status, 200);
  const parsed = JSON.parse(body);
  assert.equal(parsed.available, true);
  assert.equal(parsed.stateError, false);
  assert.equal(parsed.stateReason, 'ok');
  assert.equal(parsed.stateLimitMb, 16, 'the state cap is sent in MiB');
  assert.equal(parsed.state.phases[0].name, 'PUBLIC-MARKER');
  assert.match(parsed.architecture.technical, /PUBLIC-MARKER/);
  assert.equal('governance' in parsed, false, 'the governance field is gone');
});

test('invalid JSON serves the last good state with stateError and stateReason', async () => {
  const stateFile = path.join(publicProjectPath, 'docs', 'project-state.json');
  const good = fs.readFileSync(stateFile, 'utf8');
  try {
    await getBoard(publicProjectId, ownerUser);
    fs.writeFileSync(stateFile, '{broken', 'utf8');
    const parsed = JSON.parse((await getBoard(publicProjectId, ownerUser)).body);
    assert.equal(parsed.available, true);
    assert.equal(parsed.stateError, true);
    assert.equal(parsed.stateReason, 'invalid_json');
    assert.equal(parsed.state.phases[0].name, 'PUBLIC-MARKER', 'last good copy is served');
  } finally {
    fs.writeFileSync(stateFile, good, 'utf8');
  }
});

test('the governance stub reads as external_source_unconfigured, architecture still served', async () => {
  const stateFile = path.join(publicProjectPath, 'docs', 'project-state.json');
  const good = fs.readFileSync(stateFile, 'utf8');
  try {
    fs.writeFileSync(stateFile, JSON.stringify({
      $schema: 'nassaj-governance-boundary/v1', available: false,
    }), 'utf8');
    const parsed = JSON.parse((await getBoard(publicProjectId, ownerUser)).body);
    assert.equal(parsed.available, false);
    assert.equal(parsed.state, null);
    assert.equal(parsed.stateReason, 'external_source_unconfigured');
    assert.match(parsed.architecture.technical, /PUBLIC-MARKER/);
  } finally {
    fs.writeFileSync(stateFile, good, 'utf8');
  }
});

test('a state file symlinked outside the project is refused without leaking content', async () => {
  const stateFile = path.join(publicProjectPath, 'docs', 'project-state.json');
  const good = fs.readFileSync(stateFile, 'utf8');
  const outside = path.join(workspaceRoot, 'home-like-settings.json');
  fs.writeFileSync(outside, JSON.stringify({ secret: 'HOME-SECRET-MARKER' }), 'utf8');
  try {
    fs.rmSync(stateFile);
    fs.symlinkSync(outside, stateFile);
    const { body } = await getBoard(publicProjectId, ownerUser);
    const parsed = JSON.parse(body);
    assert.equal(parsed.stateReason, 'outside_project');
    assert.equal(body.includes('HOME-SECRET-MARKER'), false);
    assert.equal(body.includes(outside), false, 'no host path in the response');
  } finally {
    fs.rmSync(stateFile, { force: true });
    fs.writeFileSync(stateFile, good, 'utf8');
  }
});

test('PROJECT_MEMBERSHIP_ENFORCE on: non-member gets 404 with no read, admin and owner get 200', async () => {
  const previous = process.env.PROJECT_MEMBERSHIP_ENFORCE;
  process.env.PROJECT_MEMBERSHIP_ENFORCE = '1';
  try {
    const refused = await getBoard(privateProjectId, strangerUser);
    assert.equal(refused.status, 404);
    assert.equal(refused.body.includes(SECRET_MARKER), false);
    const admin = await getBoard(privateProjectId, adminUser);
    assert.equal(admin.status, 200);
    assert.ok(admin.body.includes(SECRET_MARKER));
    assert.equal((await getBoard(privateProjectId, ownerUser)).status, 200);
  } finally {
    if (previous === undefined) delete process.env.PROJECT_MEMBERSHIP_ENFORCE;
    else process.env.PROJECT_MEMBERSHIP_ENFORCE = previous;
  }
});
