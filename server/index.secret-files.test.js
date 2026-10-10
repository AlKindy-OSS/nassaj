/**
 * Route-level wiring for secret files inside a visible project: a member who
 * can see the project must not read `.env` or the configured database through
 * GET /api/projects/:projectId/file or /files/content, nor a database backup
 * copy under a non-database name, nor a harness transcript inside a registered
 * checkout, while a normal file still reads. Same extraction harness as index.secret-roots.test.js: the REAL
 * handler source runs against the REAL guards with fake DB collaborators.
 *
 * Fixtures live under /var/tmp with a throwaway $HOME, DATABASE_PATH and
 * CLAUDE_CONFIG_DIR.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { after, before } from 'node:test';

import { resetSecretPathGuardCache } from './shared/secret-path-guard.js';
import { openReadableProjectFile } from './utils/path-guard.js';

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

/** Evaluates the real handler registered at `routeMarker` with injected collaborators. */
function buildHandler(routeMarker, collaborators) {
  const at = INDEX_SOURCE.indexOf(routeMarker);
  assert.notStrictEqual(at, -1, `${routeMarker} not found in index.js`);
  const arrow = 'async (req, res) => {';
  const arrowAt = INDEX_SOURCE.indexOf(arrow, at);
  const source = `async (req, res) => ${sliceBalancedBlock(INDEX_SOURCE, arrowAt + arrow.length - 1)}`;
  const names = Object.keys(collaborators);
  const factory = new Function(...names, `return ${source};`);
  return factory(...names.map((name) => collaborators[name]));
}

/** Records the response; `pipe` targets collect streamed bytes. */
function makeResponseDouble() {
  const sent = [];
  let resolveDone;
  const done = new Promise((resolve) => { resolveDone = resolve; });
  const res = {
    statusCode: 200,
    headersSent: false,
    chunks: [],
    status(code) { res.statusCode = code; return res; },
    setHeader() { return res; },
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

let sandbox = '';
let project = '';
let databasePath = '';
let core = '';
const saved = {};

before(() => {
  sandbox = fs.realpathSync(fs.mkdtempSync(path.join('/var/tmp', 'idx-secret-files-')));
  const home = path.join(sandbox, 'home');
  project = path.join(home, 'work', 'app');
  fs.mkdirSync(path.join(project, 'data'), { recursive: true });
  fs.writeFileSync(path.join(project, '.env'), 'JWT_SECRET=s3cret');
  fs.writeFileSync(path.join(project, '.env.example'), 'JWT_SECRET=');
  fs.writeFileSync(path.join(project, 'README.md'), 'hello');
  databasePath = path.join(project, 'data', 'app.sqlite');
  fs.writeFileSync(databasePath, 'SQLite format 3\0 s3cret');
  fs.mkdirSync(path.join(project, '.backups'), { recursive: true });
  fs.writeFileSync(path.join(project, '.backups', 'db.pre-cutover.bak'), 'SQLite format 3\0 s3cret copy');
  // ~/.claude points into a registered checkout holding transcripts.
  core = path.join(home, 'governance-core');
  fs.mkdirSync(path.join(core, 'projects', '-x'), { recursive: true });
  fs.writeFileSync(path.join(core, 'projects', '-x', 'session.jsonl'), 'JWT_SECRET=s3cret');
  fs.writeFileSync(path.join(core, 'README.md'), 'governance');
  fs.symlinkSync(core, path.join(home, '.claude'));
  for (const key of ['HOME', 'DATABASE_PATH', 'CLAUDE_CONFIG_DIR']) saved[key] = process.env[key];
  process.env.HOME = home;
  process.env.DATABASE_PATH = databasePath;
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

function readHandler(root = project) {
  return buildHandler("app.get('/api/projects/:projectId/file'", {
    isProjectVisible: () => true,
    coerceUserId: (id) => id,
    projectsDb: { getProjectPathById: async () => root },
    openReadableProjectFile,
    console: quiet,
  });
}

function rawHandler() {
  return buildHandler("app.get('/api/projects/:projectId/files/content'", {
    isProjectVisible: () => true,
    coerceUserId: (id) => id,
    projectsDb: { getProjectPathById: async () => project },
    openReadableProjectFile,
    applyRawFileResponseHeaders: () => {},
    mime: { lookup: () => 'text/plain' },
    console: quiet,
  });
}

test('GET /file refuses .env, the configured database and a backup copy for a member', async () => {
  for (const filePath of ['.env', 'data/app.sqlite', databasePath, '.backups/db.pre-cutover.bak']) {
    const { res, sent } = makeResponseDouble();
    await readHandler()({ params: { projectId: 'p' }, query: { filePath }, user: member }, res);
    assert.equal(sent[0].status, 403, filePath);
    assert.equal(JSON.stringify(sent[0].payload).includes('s3cret'), false, filePath);
  }
});

test('GET /file still reads a normal file and the .env template', async () => {
  for (const [filePath, content] of [['README.md', 'hello'], ['.env.example', 'JWT_SECRET=']]) {
    const { res, sent } = makeResponseDouble();
    await readHandler()({ params: { projectId: 'p' }, query: { filePath }, user: member }, res);
    assert.equal(sent[0].status, 200, filePath);
    assert.equal(sent[0].payload.content, content);
  }
});

test('GET /files/content refuses .env and the database but streams a normal file', async () => {
  for (const filePath of ['.env', 'data/app.sqlite', '.backups/db.pre-cutover.bak']) {
    const { res, sent } = makeResponseDouble();
    await rawHandler()({ params: { projectId: 'p' }, query: { path: filePath }, user: member }, res);
    assert.equal(sent[0].status, 403, filePath);
  }
  const { res, sent, done } = makeResponseDouble();
  await rawHandler()({ params: { projectId: 'p' }, query: { path: 'README.md' }, user: member }, res);
  await done;
  assert.equal(sent[0].status, 200);
  assert.equal(sent[0].payload, 'hello');
});

test('GET /file refuses a harness transcript inside a registered checkout, serves its docs', async () => {
  const refused = makeResponseDouble();
  await readHandler(core)(
    { params: { projectId: 'p' }, query: { filePath: 'projects/-x/session.jsonl' }, user: member }, refused.res);
  assert.equal(refused.sent[0].status, 403);
  assert.equal(JSON.stringify(refused.sent[0].payload).includes('s3cret'), false);

  const ok = makeResponseDouble();
  await readHandler(core)({ params: { projectId: 'p' }, query: { filePath: 'README.md' }, user: member }, ok.res);
  assert.equal(ok.sent[0].status, 200);
  assert.equal(ok.sent[0].payload.content, 'governance');
});
