/**
 * Route-level wiring for secret files inside a visible project (B-1581,
 * B-1593). Same extraction harness as index.secret-roots.test.js: the REAL
 * handler source runs against the REAL guards with fake DB collaborators.
 *
 *   - Service secrets (the configured database, a harness transcript, any
 *     dotenv/SQLite file under a service root) are refused with 403 even when
 *     the request confirms.
 *   - A project `.env` or SQLite file answers 428 secret_file_confirmation_required
 *     unless the request carries the confirmation flag, then it is served (or
 *     saved) and audited without its content.
 *   - Normal files and the .env template read as before.
 *
 * Fixtures live under /var/tmp with a throwaway $HOME, DATABASE_PATH,
 * CLAUDE_CONFIG_DIR and NASSAJ_SERVICE_SECRET_ROOTS.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { after, before } from 'node:test';

import { resetSecretPathGuardCache, classifySecretPath } from './shared/secret-path-guard.js';
import { isResolvedPathInsideRootReal, openReadableProjectFile } from './utils/path-guard.js';
import {
  SECRET_FILE_CONFIRMATION_CODE,
  isSecretFileConfirmed,
  sendSecretFileConfirmationRequired,
} from './utils/secret-file-access.js';

const INDEX_SOURCE = fs.readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), 'index.js'),
  'utf8',
);

/** Slice the balanced `{...}` block that starts at the first `{` at/after `from`. */
function sliceBalancedBlock(source, from) {
  const start = source.indexOf('{', from);
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

/** Evaluates `source` as an expression with injected collaborators. */
function evaluate(source, collaborators) {
  const names = Object.keys(collaborators);
  const factory = new Function(...names, `return ${source};`);
  return factory(...names.map((name) => collaborators[name]));
}

/** Evaluates the real handler registered at `routeMarker` with injected collaborators. */
function buildHandler(routeMarker, collaborators) {
  const at = INDEX_SOURCE.indexOf(routeMarker);
  assert.notStrictEqual(at, -1, `${routeMarker} not found in index.js`);
  const arrow = 'async (req, res) => {';
  const arrowAt = INDEX_SOURCE.indexOf(arrow, at);
  return evaluate(`async (req, res) => ${sliceBalancedBlock(INDEX_SOURCE, arrowAt + arrow.length - 1)}`,
    collaborators);
}

/** The real top-level `function validatePathInProject(...)` from index.js. */
function buildValidatePathInProject() {
  const marker = 'function validatePathInProject(projectRoot, targetPath) ';
  const at = INDEX_SOURCE.indexOf(marker);
  assert.notStrictEqual(at, -1, 'validatePathInProject not found in index.js');
  return evaluate(`function validatePathInProject(projectRoot, targetPath) ${sliceBalancedBlock(INDEX_SOURCE, at)}`,
    { path, isResolvedPathInsideRootReal });
}

/** Records the response; `pipe` targets collect streamed bytes. */
function makeResponseDouble() {
  const sent = [];
  const headers = {};
  let resolveDone;
  const done = new Promise((resolve) => { resolveDone = resolve; });
  const res = {
    statusCode: 200,
    headersSent: false,
    chunks: [],
    headers,
    status(code) { res.statusCode = code; return res; },
    setHeader(name, value) { headers[name.toLowerCase()] = value; return res; },
    set(name, value) { headers[name.toLowerCase()] = value; return res; },
    json(payload) {
      res.headersSent = true;
      sent.push({ status: res.statusCode, payload });
      resolveDone();
      return res;
    },
    // Minimal writable surface for stream.pipe(res).
    on() { return res; }, once() { return res; }, emit() { return true; },
    removeListener() { return res; },
    write(chunk) { res.chunks.push(Buffer.from(chunk)); return true; },
    end(chunk) {
      if (chunk) res.chunks.push(Buffer.from(chunk));
      sent.push({ status: res.statusCode, payload: Buffer.concat(res.chunks).toString() });
      resolveDone();
    },
  };
  return { res, sent, done };
}

const quiet = { log: () => {}, warn: () => {}, error: () => {} };
const member = { id: 2 };
/** Stand-in for the running process's JWT secret (set as process.env.JWT_SECRET). */
const LIVE_JWT = 'live-jwt-0123456789abcdef0123456789abcdef';

let sandbox = '';
let project = '';
let databasePath = '';
let core = '';
let install = '';
let audits = [];
const saved = {};

before(() => {
  sandbox = fs.realpathSync(fs.mkdtempSync(path.join('/var/tmp', 'idx-secret-files-')));
  const home = path.join(sandbox, 'home');
  project = path.join(home, 'work', 'app');
  fs.mkdirSync(path.join(project, 'data'), { recursive: true });
  fs.writeFileSync(path.join(project, '.env'), 'JWT_SECRET=s3cret');
  fs.writeFileSync(path.join(project, '.env.example'), 'JWT_SECRET=');
  fs.writeFileSync(path.join(project, 'README.md'), 'hello');
  fs.writeFileSync(path.join(project, 'data', 'local.sqlite'), 'SQLite format 3\0 project db');
  databasePath = path.join(project, 'data', 'app.sqlite');
  fs.writeFileSync(databasePath, 'SQLite format 3\0 s3cret');
  fs.mkdirSync(path.join(project, '.backups'), { recursive: true });
  fs.writeFileSync(path.join(project, '.backups', 'db.pre-cutover.bak'), 'SQLite format 3\0 copy');
  // ~/.claude points into a registered checkout holding transcripts.
  core = path.join(home, 'governance-core');
  fs.mkdirSync(path.join(core, 'projects', '-x'), { recursive: true });
  fs.writeFileSync(path.join(core, 'projects', '-x', 'session.jsonl'), 'JWT_SECRET=s3cret');
  fs.writeFileSync(path.join(core, 'README.md'), 'governance');
  fs.symlinkSync(core, path.join(home, '.claude'));
  // The running service's install root, registered as a project.
  install = path.join(home, 'service-install');
  fs.mkdirSync(path.join(install, 'backups'), { recursive: true });
  fs.writeFileSync(path.join(install, '.env'), 'JWT_SECRET=service-s3cret');
  fs.writeFileSync(path.join(install, 'backups', 'db.sqlite'), 'SQLite format 3\0 service');
  fs.writeFileSync(path.join(install, 'backups', 'renamed.bin'), 'SQLite format 3\0 service');
  fs.writeFileSync(path.join(install, 'README.md'), 'service readme');
  // Copies of the live service's secrets outside every service root (the dev
  // checkout case): a .env carrying the running JWT secret, an application
  // database copy and an SQLite WAL, all under project-looking names.
  fs.writeFileSync(path.join(project, '.env.rollback-1'), `PORT=1\nJWT_SECRET=${LIVE_JWT}\n`);
  fs.writeFileSync(path.join(project, 'notes-copy.txt'), `JWT_SECRET=${LIVE_JWT}\n`);
  fs.writeFileSync(path.join(project, '.backups', 'auth.db'), Buffer.concat([
    Buffer.from('SQLite format 3\0', 'latin1'), Buffer.alloc(84),
    Buffer.from('CREATE TABLE app_config (key TEXT PRIMARY KEY, value TEXT)'),
    Buffer.from('CREATE TABLE IF NOT EXISTS audit_log (id INTEGER PRIMARY KEY)'),
  ]));
  fs.writeFileSync(path.join(project, 'data', 'other.db-wal'), Buffer.from([0x37, 0x7f, 0x06, 0x82, 0, 0, 0, 1]));
  for (const key of ['HOME', 'DATABASE_PATH', 'CLAUDE_CONFIG_DIR', 'NASSAJ_SERVICE_SECRET_ROOTS', 'JWT_SECRET']) {
    saved[key] = process.env[key];
  }
  process.env.JWT_SECRET = LIVE_JWT;
  process.env.HOME = home;
  process.env.DATABASE_PATH = databasePath;
  process.env.NASSAJ_SERVICE_SECRET_ROOTS = install;
  delete process.env.CLAUDE_CONFIG_DIR;
  resetSecretPathGuardCache();
});

after(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  resetSecretPathGuardCache();
  if (sandbox) fs.rmSync(sandbox, { recursive: true, force: true });
});

const auditSecretFileAccess = (_req, projectId, projectRoot, absolutePath, access) => {
  audits.push({ projectId, path: path.relative(projectRoot, absolutePath), access });
};

const secretCollaborators = { isSecretFileConfirmed, sendSecretFileConfirmationRequired, auditSecretFileAccess };

function readHandler(root = project) {
  return buildHandler("app.get('/api/projects/:projectId/file'", {
    isProjectVisible: () => true,
    coerceUserId: (id) => id,
    projectsDb: { getProjectPathById: async () => root },
    openReadableProjectFile,
    console: quiet,
    ...secretCollaborators,
  });
}

function rawHandler(root = project) {
  return buildHandler("app.get('/api/projects/:projectId/files/content'", {
    isProjectVisible: () => true,
    coerceUserId: (id) => id,
    projectsDb: { getProjectPathById: async () => root },
    openReadableProjectFile,
    applyRawFileResponseHeaders: () => {},
    mime: { lookup: () => 'text/plain' },
    console: quiet,
    ...secretCollaborators,
  });
}

function saveHandler(root = project) {
  return buildHandler("app.put('/api/projects/:projectId/file'", {
    coerceUserId: (id) => id,
    projectsDb: { isProjectWritableByUser: () => true, getProjectPathById: async () => root },
    validatePathInProject: buildValidatePathInProject(),
    classifySecretPath,
    isShareableDocument: () => false,
    saveSharedDocumentAtomically: async () => {},
    fsPromises: fs.promises,
    path,
    console: quiet,
    ...secretCollaborators,
  });
}

async function read(filePath, { root = project, confirm = false } = {}) {
  const { res, sent } = makeResponseDouble();
  const query = confirm ? { filePath, confirmSecret: '1' } : { filePath };
  await readHandler(root)({ params: { projectId: 'p' }, query, user: member }, res);
  return { ...sent[0], headers: res.headers };
}

test('GET /file asks for confirmation on a project .env and serves it once confirmed', async () => {
  audits = [];
  for (const filePath of ['.env', 'data/local.sqlite', '.backups/db.pre-cutover.bak']) {
    const asked = await read(filePath);
    assert.equal(asked.status, 428, filePath);
    assert.equal(asked.payload.code, SECRET_FILE_CONFIRMATION_CODE, filePath);
    assert.equal(JSON.stringify(asked.payload).includes('s3cret'), false, filePath);
  }
  assert.deepEqual(audits, [], 'nothing is audited before confirmation');

  const confirmed = await read('.env', { confirm: true });
  assert.equal(confirmed.status, 200);
  assert.equal(confirmed.payload.content, 'JWT_SECRET=s3cret');
  assert.equal(confirmed.headers['cache-control'], 'no-store');
  assert.deepEqual(audits, [{ projectId: 'p', path: '.env', access: 'read' }]);

  const copy = await read('.backups/db.pre-cutover.bak', { confirm: true });
  assert.equal(copy.status, 200, 'a project SQLite copy is a project file');
});

test('GET /file never serves service secrets, even with confirmation', async () => {
  audits = [];
  for (const [root, filePath] of [[project, 'data/app.sqlite'], [project, databasePath],
    [install, '.env'], [install, 'backups/db.sqlite'], [install, 'backups/renamed.bin'],
    [core, 'projects/-x/session.jsonl']]) {
    for (const confirm of [false, true]) {
      const refused = await read(filePath, { root, confirm });
      assert.equal(refused.status, 403, `${filePath} confirm=${confirm}`);
      assert.equal(JSON.stringify(refused.payload).includes('s3cret'), false, filePath);
    }
  }
  assert.deepEqual(audits, []);
  assert.equal((await read('README.md', { root: install })).status, 200, 'other install files still read');
});

test('copies of the live secrets outside the service roots are 403 even when confirmed', async () => {
  audits = [];
  for (const filePath of ['.env.rollback-1', 'notes-copy.txt', '.backups/auth.db', 'data/other.db-wal']) {
    for (const confirm of [false, true]) {
      const refused = await read(filePath, { confirm });
      assert.equal(refused.status, 403, `${filePath} confirm=${confirm}`);
      assert.equal(JSON.stringify(refused.payload).includes(LIVE_JWT), false, filePath);
    }
    const raw = makeResponseDouble();
    await rawHandler()({ params: { projectId: 'p' }, query: { path: filePath, confirmSecret: '1' }, user: member },
      raw.res);
    assert.equal(raw.sent[0].status, 403, `raw ${filePath}`);
  }
  assert.deepEqual(audits, []);
});

test('GET /file still reads a normal file and the .env template without confirmation', async () => {
  for (const [filePath, content] of [['README.md', 'hello'], ['.env.example', 'JWT_SECRET=']]) {
    const ok = await read(filePath);
    assert.equal(ok.status, 200, filePath);
    assert.equal(ok.payload.content, content);
  }
  const docs = await read('README.md', { root: core });
  assert.equal(docs.payload.content, 'governance');
});

test('GET /files/content follows the same confirmation contract', async () => {
  audits = [];
  const asked = makeResponseDouble();
  await rawHandler()({ params: { projectId: 'p' }, query: { path: '.env' }, user: member }, asked.res);
  assert.equal(asked.sent[0].status, 428);

  const streamed = makeResponseDouble();
  await rawHandler()({ params: { projectId: 'p' }, query: { path: '.env', confirmSecret: 'true' }, user: member },
    streamed.res);
  await streamed.done;
  assert.equal(streamed.sent[0].payload, 'JWT_SECRET=s3cret');
  assert.deepEqual(audits, [{ projectId: 'p', path: '.env', access: 'download' }]);

  for (const filePath of ['data/app.sqlite']) {
    const refused = makeResponseDouble();
    await rawHandler()({ params: { projectId: 'p' }, query: { path: filePath, confirmSecret: '1' }, user: member },
      refused.res);
    assert.equal(refused.sent[0].status, 403, filePath);
  }
  const normal = makeResponseDouble();
  await rawHandler()({ params: { projectId: 'p' }, query: { path: 'README.md' }, user: member }, normal.res);
  await normal.done;
  assert.equal(normal.sent[0].payload, 'hello');
});

test('PUT /file saves a project .env only with confirmation and refuses service secrets', async () => {
  audits = [];
  const save = async (root, filePath, body) => {
    const { res, sent } = makeResponseDouble();
    await saveHandler(root)({ params: { projectId: 'p' }, body: { filePath, ...body }, user: member }, res);
    return sent[0];
  };

  const asked = await save(project, '.env', { content: 'JWT_SECRET=new' });
  assert.equal(asked.status, 428);
  assert.equal(fs.readFileSync(path.join(project, '.env'), 'utf8'), 'JWT_SECRET=s3cret', 'unchanged');

  const saved200 = await save(project, '.env', { content: 'JWT_SECRET=new', confirmSecret: true });
  assert.equal(saved200.status, 200);
  assert.equal(fs.readFileSync(path.join(project, '.env'), 'utf8'), 'JWT_SECRET=new');
  assert.deepEqual(audits, [{ projectId: 'p', path: '.env', access: 'save' }]);

  for (const [root, filePath] of [[install, '.env'], [project, 'data/app.sqlite']]) {
    const refused = await save(root, filePath, { content: 'x', confirmSecret: true });
    assert.equal(refused.status, 403, filePath);
  }
  assert.equal(fs.readFileSync(path.join(install, '.env'), 'utf8'), 'JWT_SECRET=service-s3cret');

  const normal = await save(project, 'README.md', { content: 'changed' });
  assert.equal(normal.status, 200, 'normal files need no confirmation');
});
