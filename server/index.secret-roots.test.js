/**
 * B-1373 route-level wiring tests for handlers inside server/index.js.
 *
 * Same harness as index.security.test.js: index.js boots the server at module
 * scope and its handlers are not exported, so each test EXTRACTS THE REAL
 * HANDLER SOURCE and evaluates it with fakes for DB/tree collaborators and the
 * REAL secret-path guard. Removing a guard line from index.js fails a test here.
 *
 * A throwaway home under os.tmpdir() is installed as $HOME, so the operator's
 * real home is never read.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { after, before } from 'node:test';

import { isForbiddenProjectRoot, isSecretPath } from './shared/secret-path-guard.js';
import { resolveReadPathInProject } from './utils/path-guard.js';

const INDEX_SOURCE = fs.readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), 'index.js'),
  'utf8',
);

/** Slice the balanced `{...}` block that starts at the first `{` at/after `from`. */
function sliceBalancedBlock(source, from) {
  const start = source.indexOf('{', from);
  assert.notStrictEqual(start, -1, 'expected a block to extract');
  let depth = 0;
  for (let i = start; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') {
      depth--;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error('unbalanced block while extracting handler source');
}

/** The `async (req, res) => {...}` handler registered at `routeMarker`. */
function extractRouteHandler(routeMarker) {
  const at = INDEX_SOURCE.indexOf(routeMarker);
  assert.notStrictEqual(at, -1, `${routeMarker} not found in index.js`);
  const arrow = 'async (req, res) => {';
  const arrowAt = INDEX_SOURCE.indexOf(arrow, at);
  assert.notStrictEqual(arrowAt, -1, `handler arrow for ${routeMarker} not found`);
  return `async (req, res) => ${sliceBalancedBlock(INDEX_SOURCE, arrowAt + arrow.length - 1)}`;
}

/** Evaluates a handler with the named collaborators injected. */
function buildHandler(routeMarker, collaborators) {
  const names = Object.keys(collaborators);
  const factory = new Function(...names, `return ${extractRouteHandler(routeMarker)};`);
  return factory(...names.map((name) => collaborators[name]));
}

/** Records the single response a handler sends. */
function makeResponseDouble() {
  const sent = [];
  const res = {
    statusCode: 200,
    headersSent: false,
    status(code) { res.statusCode = code; return res; },
    setHeader() { return res; },
    json(payload) {
      res.headersSent = true;
      sent.push({ status: res.statusCode, payload });
      return res;
    },
  };
  return { res, sent };
}

const quiet = { log: () => {}, warn: () => {}, error: () => {} };

let sandbox = '';
let fakeHome = '';
let project = '';
let originalHome;

before(() => {
  sandbox = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'idx-b1373-')));
  fakeHome = path.join(sandbox, 'home');
  project = path.join(fakeHome, 'Project', 'app');
  fs.mkdirSync(path.join(fakeHome, '.ssh'), { recursive: true });
  fs.writeFileSync(path.join(fakeHome, '.ssh', 'id_ed25519'), 'PRIVATE');
  fs.mkdirSync(path.join(fakeHome, '.cloudflared'), { recursive: true });
  fs.mkdirSync(project, { recursive: true });
  fs.writeFileSync(path.join(project, 'README.md'), 'hello');
  originalHome = process.env.HOME;
  process.env.HOME = fakeHome;
});

after(() => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (sandbox) fs.rmSync(sandbox, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// GET /api/projects/:projectId/files (tree)
// ---------------------------------------------------------------------------

function buildTreeHandler(projectRoot, treeCalls) {
  return buildHandler("app.get('/api/projects/:projectId/files', authenticateToken", {
    isProjectVisible: () => true,
    coerceUserId: (id) => id,
    projectsDb: { getProjectPathById: async () => projectRoot },
    fsPromises: fs.promises,
    isForbiddenProjectRoot,
    buildProjectFileTreeResponse: async (root) => {
      treeCalls.push(root);
      return { status: 200, body: { tree: [] } };
    },
    console: quiet,
  });
}

test('GET /files refuses to list a home-rooted project before building the tree', async () => {
  const treeCalls = [];
  const { res, sent } = makeResponseDouble();
  await buildTreeHandler(fakeHome, treeCalls)({ params: { projectId: 'p' }, user: { id: 1 } }, res);
  assert.equal(sent[0].status, 403);
  assert.deepEqual(treeCalls, [], 'the tree must never be built for a forbidden root');
});

test('GET /files refuses a project rooted in a hidden home entry', async () => {
  const treeCalls = [];
  const { res, sent } = makeResponseDouble();
  await buildTreeHandler(path.join(fakeHome, '.cloudflared'), treeCalls)(
    { params: { projectId: 'p' }, user: { id: 1 } }, res);
  assert.equal(sent[0].status, 403);
  assert.deepEqual(treeCalls, []);
});

test('GET /files still lists a legitimate ~/Project root', async () => {
  const treeCalls = [];
  const { res, sent } = makeResponseDouble();
  await buildTreeHandler(project, treeCalls)({ params: { projectId: 'p' }, user: { id: 1 } }, res);
  assert.equal(sent[0].status, 200);
  assert.deepEqual(treeCalls, [project]);
});

// ---------------------------------------------------------------------------
// GET /api/projects/:projectId/file (read)
// ---------------------------------------------------------------------------

function buildReadHandler(projectRoot) {
  return buildHandler("app.get('/api/projects/:projectId/file'", {
    isProjectVisible: () => true,
    coerceUserId: (id) => id,
    projectsDb: { getProjectPathById: async () => projectRoot },
    resolveReadPathInProject,
    fsPromises: fs.promises,
    console: quiet,
  });
}

test('GET /file cannot read ~/.ssh through a home-rooted project', async () => {
  const { res, sent } = makeResponseDouble();
  await buildReadHandler(fakeHome)(
    { params: { projectId: 'p' }, query: { filePath: '.ssh/id_ed25519' }, user: { id: 1 } }, res);
  assert.equal(sent[0].status, 403);
  assert.equal(JSON.stringify(sent[0].payload).includes('PRIVATE'), false);
});

test('GET /file still reads inside a legitimate project', async () => {
  const { res, sent } = makeResponseDouble();
  await buildReadHandler(project)(
    { params: { projectId: 'p' }, query: { filePath: 'README.md' }, user: { id: 1 } }, res);
  assert.equal(sent[0].status, 200);
  assert.equal(sent[0].payload.content, 'hello');
});

// ---------------------------------------------------------------------------
// GET /api/browse-filesystem and POST /api/create-folder
// ---------------------------------------------------------------------------

/** validateWorkspacePath fake: everything under the fake home is "valid". */
const acceptUnderHome = async (target) => ({ valid: true, resolvedPath: path.resolve(target) });

test('browse-filesystem refuses a hidden home entry and allows a normal folder', async () => {
  const listed = [];
  const handler = buildHandler("app.get('/api/browse-filesystem'", {
    console: quiet,
    WORKSPACES_ROOT: fakeHome,
    expandWorkspacePath: (p) => p,
    path,
    validateWorkspacePath: acceptUnderHome,
    isSecretPath,
    fs,
    fsPromises: fs.promises,
    getFileTree: async (dir) => { listed.push(dir); return []; },
  });
  const secret = makeResponseDouble();
  await handler({ query: { path: path.join(fakeHome, '.ssh') } }, secret.res);
  assert.equal(secret.sent[0].status, 403);
  assert.deepEqual(listed, []);

  const normal = makeResponseDouble();
  await handler({ query: { path: path.join(fakeHome, 'Project') } }, normal.res);
  assert.equal(normal.sent[0].status, 200);
  assert.deepEqual(listed, [path.join(fakeHome, 'Project')]);
});

test('create-folder refuses to create inside a hidden home entry', async () => {
  const handler = buildHandler("app.post('/api/create-folder'", {
    console: quiet,
    expandWorkspacePath: (p) => p,
    path,
    validateWorkspacePath: acceptUnderHome,
    isSecretPath,
    fs,
  });
  const target = path.join(fakeHome, '.ssh', 'planted');
  const refused = makeResponseDouble();
  await handler({ body: { path: target } }, refused.res);
  assert.equal(refused.sent[0].status, 403);
  assert.equal(fs.existsSync(target), false);

  const ok = makeResponseDouble();
  const allowed = path.join(fakeHome, 'Project', 'new-one');
  await handler({ body: { path: allowed } }, ok.res);
  assert.equal(ok.sent[0].status, 200);
  assert.equal(fs.existsSync(allowed), true);
});
