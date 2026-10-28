/**
 * B-1689 — editor file reads/saves follow the chat session's overlay.
 *
 * The REAL handlers and the REAL resolveFileRootOrRespond are extracted from
 * index.js and run against the REAL path guards; only the session row, the
 * session-access predicate and the overlay lookup are fakes. Pinned contract:
 *   - with a `sessionId` the requester may use, GET /file, GET /files/content
 *     and PUT /file resolve against the session overlay (overlay wins even for
 *     files that also exist in the project root);
 *   - no sessionId, or a session without an overlay, keeps the project root;
 *   - a session of another project, one the requester may not use, a broken
 *     overlay or a malformed id is refused (404/400) — never a root fallback;
 *   - saves ask the access predicate for 'write', reads for 'read';
 *   - path guards (symlink escape) and the B-1593 428 contract are unchanged
 *     inside the overlay;
 *   - a docs/*.md overlay save does not go through the project-root share store.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { after, before } from 'node:test';

import { classifySecretPath, resetSecretPathGuardCache } from './shared/secret-path-guard.js';
import { isResolvedPathInsideRootReal, openReadableProjectFile } from './utils/path-guard.js';
import {
  SECRET_FILE_AUDIT_ACTION,
  buildSecretFileAuditEntry,
  isSecretFileConfirmed,
  sendSecretFileConfirmationRequired,
} from './utils/secret-file-access.js';
import {
  OVERLAY_FILE_WRITE_AUDIT_ACTION,
  buildOverlayFileWriteAuditEntry,
  rebaseRequestedPath,
  resolveSessionFileRoot,
} from './services/session-file-root.js';
import { isShareableDocument, saveSharedDocumentAtomically } from './services/document-share-files.js';

const INDEX_SOURCE = fs.readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), 'index.js'),
  'utf8',
);

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

function evaluate(source, collaborators) {
  const names = Object.keys(collaborators);
  return new Function(...names, `return ${source};`)(...names.map((name) => collaborators[name]));
}

function extractFunction(signature, collaborators) {
  const at = INDEX_SOURCE.indexOf(signature);
  assert.notStrictEqual(at, -1, `${signature} not found in index.js`);
  // Search after the signature: a destructured parameter also opens with `{`.
  return evaluate(`${signature}${sliceBalancedBlock(INDEX_SOURCE, at + signature.length)}`, collaborators);
}

function buildHandler(routeMarker, collaborators) {
  const at = INDEX_SOURCE.indexOf(routeMarker);
  assert.notStrictEqual(at, -1, `${routeMarker} not found in index.js`);
  const arrow = 'async (req, res) => {';
  const arrowAt = INDEX_SOURCE.indexOf(arrow, at);
  return evaluate(`async (req, res) => ${sliceBalancedBlock(INDEX_SOURCE, arrowAt + arrow.length - 1)}`,
    collaborators);
}

function makeResponseDouble() {
  const sent = [];
  const headers = {};
  let resolveDone;
  const done = new Promise((resolve) => { resolveDone = resolve; });
  const res = {
    statusCode: 200,
    headersSent: false,
    chunks: [],
    status(code) { res.statusCode = code; return res; },
    setHeader(name, value) { headers[name.toLowerCase()] = value; return res; },
    set(name, value) { headers[name.toLowerCase()] = value; return res; },
    json(payload) {
      res.headersSent = true;
      sent.push({ status: res.statusCode, payload });
      resolveDone();
      return res;
    },
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
const OVERLAY_ID = '11111111-2222-4333-8444-555555555555';
let sandbox = '';
let project = '';
let otherProject = '';
let overlay = '';
let outside = '';
let auditRows = [];
let accessCalls = [];
let denyAccess = false;
let brokenOverlay = false;
const saved = {};

before(() => {
  sandbox = fs.realpathSync(fs.mkdtempSync(path.join('/var/tmp', 'idx-overlay-files-')));
  const home = path.join(sandbox, 'home');
  project = path.join(home, 'work', 'app');
  otherProject = path.join(home, 'work', 'other');
  overlay = path.join(project, '.git', 'nassaj-session-overlays', 'instances', OVERLAY_ID, 'workspace');
  outside = path.join(sandbox, 'outside');
  fs.mkdirSync(path.join(overlay, 'docs'), { recursive: true });
  fs.mkdirSync(otherProject, { recursive: true });
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(project, 'README.md'), 'root readme');
  fs.writeFileSync(path.join(overlay, 'README.md'), 'overlay readme');
  fs.writeFileSync(path.join(overlay, 'docs', 'foo.md'), 'overlay only');
  fs.writeFileSync(path.join(overlay, '.env'), 'TOKEN=overlay-value');
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'OUTSIDE');
  fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(overlay, 'escape.txt'));
  for (const key of ['HOME', 'DATABASE_PATH', 'CLAUDE_CONFIG_DIR', 'NASSAJ_SERVICE_SECRET_ROOTS']) {
    saved[key] = process.env[key];
  }
  process.env.HOME = home;
  process.env.DATABASE_PATH = path.join(sandbox, 'service', 'db.sqlite');
  process.env.NASSAJ_SERVICE_SECRET_ROOTS = path.join(sandbox, 'service');
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

const SESSIONS = {
  'sess-overlay': () => ({ session_id: 'sess-overlay', project_path: project }),
  'sess-plain': () => ({ session_id: 'sess-plain', project_path: project }),
  'sess-other': () => ({ session_id: 'sess-other', project_path: otherProject }),
};

function fileRootResolver() {
  return extractFunction('function resolveFileRootOrRespond(req, res, projectRoot, sessionId, mode) ', {
    resolveSessionFileRoot,
    coerceUserId: (id) => id,
    sessionsDb: { getSessionById: (id) => SESSIONS[id]?.() ?? null },
    isSessionAccessibleByUser: (sessionId, projectPath, userId, mode) => {
      accessCalls.push({ sessionId, userId, mode });
      return !denyAccess;
    },
    findSessionOverlayWorkspace: ({ projectPath, sessionId }) => {
      assert.equal(projectPath, project);
      if (brokenOverlay) throw new Error('session overlay alias is malformed');
      return sessionId === 'sess-overlay' ? { cwd: overlay, overlayId: OVERLAY_ID } : null;
    },
  });
}

/** The REAL audit helpers from index.js, recording into `auditRows` instead of the DB. */
function auditHelpers() {
  const collaborators = {
    auditLogDb: { record: (action, entry) => auditRows.push({ action, ...entry }) },
    coerceUserId: (id) => id,
    SECRET_FILE_AUDIT_ACTION,
    buildSecretFileAuditEntry,
    OVERLAY_FILE_WRITE_AUDIT_ACTION,
    buildOverlayFileWriteAuditEntry,
  };
  return {
    auditSecretFileAccess: extractFunction(
      'function auditSecretFileAccess(req, projectId, projectRoot, absolutePath, access, overlayScope = null) ',
      collaborators,
    ),
    auditOverlayFileWrite: extractFunction(
      'function auditOverlayFileWrite(req, projectId, scope, absolutePath) ',
      collaborators,
    ),
  };
}

const common = () => ({
  coerceUserId: (id) => id,
  console: quiet,
  isSecretFileConfirmed,
  sendSecretFileConfirmationRequired,
  ...auditHelpers(),
  resolveFileRootOrRespond: fileRootResolver(),
  rebaseRequestedPath,
});

/** Secret-file audit rows, reduced to what the assertions compare. */
const secretAudits = () => auditRows.filter((row) => row.action === SECRET_FILE_AUDIT_ACTION)
  .map((row) => row.metadata);

async function read(query, root = project) {
  const handler = buildHandler("app.get('/api/projects/:projectId/file'", {
    ...common(),
    isProjectVisible: () => true,
    projectsDb: { getProjectPathById: async () => root },
    openReadableProjectFile,
  });
  const { res, sent } = makeResponseDouble();
  await handler({ params: { projectId: 'p' }, query, user: { id: 7 } }, res);
  return sent[0];
}

async function raw(query, root = project) {
  const handler = buildHandler("app.get('/api/projects/:projectId/files/content'", {
    ...common(),
    isProjectVisible: () => true,
    projectsDb: { getProjectPathById: async () => root },
    openReadableProjectFile,
    applyRawFileResponseHeaders: () => {},
    mime: { lookup: () => 'text/plain' },
  });
  const { res, sent, done } = makeResponseDouble();
  await handler({ params: { projectId: 'p' }, query, user: { id: 7 } }, res);
  await done;
  return sent[0];
}

async function save(body, root = project) {
  const validatePathInProject = extractFunction('function validatePathInProject(projectRoot, targetPath, { trustedOverlayRoot = false } = {}) ', {
    path, isResolvedPathInsideRootReal,
  });
  const handler = buildHandler("app.put('/api/projects/:projectId/file'", {
    ...common(),
    projectsDb: { isProjectWritableByUser: () => true, getProjectPathById: async () => root },
    validatePathInProject,
    classifySecretPath,
    // REAL share-store save: it refuses an overlay root (under `.git`), so a
    // docs/*.md overlay save must take the guarded plain write instead.
    isShareableDocument,
    saveSharedDocumentAtomically,
    fsPromises: fs.promises,
    path,
  });
  const { res, sent } = makeResponseDouble();
  await handler({ params: { projectId: 'p' }, body, user: { id: 7 } }, res);
  return sent[0];
}

function reset() {
  auditRows = [];
  accessCalls = [];
  denyAccess = false;
  brokenOverlay = false;
}

test('GET /file reads a file that exists only in the session overlay', async () => {
  reset();
  assert.equal((await read({ filePath: 'docs/foo.md' })).status, 404, 'not in the project root');
  const hit = await read({ filePath: 'docs/foo.md', sessionId: 'sess-overlay' });
  assert.equal(hit.status, 200);
  assert.equal(hit.payload.content, 'overlay only');
  assert.deepEqual(accessCalls, [{ sessionId: 'sess-overlay', userId: 7, mode: 'read' }]);
});

test('the overlay wins for files present in both copies; no session keeps the root', async () => {
  reset();
  assert.equal((await read({ filePath: 'README.md', sessionId: 'sess-overlay' })).payload.content, 'overlay readme');
  assert.equal((await read({ filePath: 'README.md' })).payload.content, 'root readme');
  assert.equal((await read({ filePath: 'README.md', sessionId: '' })).payload.content, 'root readme');
  assert.equal((await read({ filePath: 'README.md', sessionId: 'sess-plain' })).payload.content, 'root readme',
    'a session without an overlay reads the project root');
});

test('an absolute project-root path from a chat link is rebased into the overlay', async () => {
  reset();
  const hit = await read({ filePath: path.join(project, 'docs', 'foo.md'), sessionId: 'sess-overlay' });
  assert.equal(hit.status, 200);
  assert.equal(hit.payload.content, 'overlay only');
  const direct = await read({ filePath: path.join(overlay, 'README.md'), sessionId: 'sess-overlay' });
  assert.equal(direct.payload.content, 'overlay readme');
});

test('refused sessions never fall back to the project root', async () => {
  reset();
  assert.equal((await read({ filePath: 'README.md', sessionId: 'sess-other' })).status, 404, 'another project');
  assert.equal((await read({ filePath: 'README.md', sessionId: 'missing' })).status, 404, 'unknown session');
  assert.equal((await read({ filePath: 'README.md', sessionId: '../x' })).status, 400, 'malformed id');
  assert.equal((await read({ filePath: 'README.md', sessionId: ['a', 'b'] })).status, 400, 'array id');
  denyAccess = true;
  const denied = await read({ filePath: 'README.md', sessionId: 'sess-overlay' });
  assert.equal(denied.status, 404, 'requester may not read the session');
  assert.equal(JSON.stringify(denied.payload).includes('readme'), false);
  denyAccess = false;
  brokenOverlay = true;
  assert.equal((await read({ filePath: 'README.md', sessionId: 'sess-overlay' })).status, 404, 'broken overlay');
});

test('path guards and the secret-file confirmation are unchanged inside the overlay', async () => {
  reset();
  const escape = await read({ filePath: 'escape.txt', sessionId: 'sess-overlay' });
  assert.equal(escape.status, 403);
  assert.equal(JSON.stringify(escape.payload).includes('OUTSIDE'), false);
  assert.equal((await read({ filePath: '../../../../../README.md', sessionId: 'sess-overlay' })).status, 403);

  const asked = await read({ filePath: '.env', sessionId: 'sess-overlay' });
  assert.equal(asked.status, 428);
  assert.deepEqual(auditRows, []);
  const confirmed = await read({ filePath: '.env', sessionId: 'sess-overlay', confirmSecret: '1' });
  assert.equal(confirmed.payload.content, 'TOKEN=overlay-value');
});

test('qa M-2: a secret-file audit line tells an overlay access from a root access', async () => {
  reset();
  fs.writeFileSync(path.join(project, '.env'), 'TOKEN=root-value');
  try {
    assert.equal((await read({ filePath: '.env', sessionId: 'sess-overlay', confirmSecret: '1' })).status, 200);
    assert.equal((await read({ filePath: '.env', confirmSecret: '1' })).status, 200);
    assert.equal((await raw({ path: '.env', sessionId: 'sess-overlay', confirmSecret: '1' })).status, 200);
  } finally {
    fs.rmSync(path.join(project, '.env'));
  }
  assert.deepEqual(secretAudits(), [
    { projectId: 'p', path: '.env', access: 'read', overlay: true, sessionId: 'sess-overlay', overlayId: OVERLAY_ID },
    { projectId: 'p', path: '.env', access: 'read' },
    {
      projectId: 'p', path: '.env', access: 'download', overlay: true, sessionId: 'sess-overlay', overlayId: OVERLAY_ID,
    },
  ]);
  assert.equal(auditRows.every((row) => row.userId === 7), true);
  assert.equal(JSON.stringify(auditRows).includes('value'), false, 'never the content');
});

test('GET /files/content streams the overlay copy under the same rules', async () => {
  reset();
  assert.equal((await raw({ path: 'docs/foo.md', sessionId: 'sess-overlay' })).payload, 'overlay only');
  assert.equal((await raw({ path: 'docs/foo.md' })).status, 404);
  assert.equal((await raw({ path: '.env', sessionId: 'sess-overlay' })).status, 428);
  assert.equal((await raw({ path: 'README.md', sessionId: 'sess-other' })).status, 404);
});

test('PUT /file saves into the overlay, asks for write access, and refuses without it', async () => {
  reset();
  const ok = await save({ filePath: 'docs/foo.md', content: 'edited', sessionId: 'sess-overlay' });
  assert.equal(ok.status, 200);
  assert.equal(ok.payload.path, path.join('docs', 'foo.md'), 'qa L-4: root-relative, not absolute');
  assert.equal(fs.readFileSync(path.join(overlay, 'docs', 'foo.md'), 'utf8'), 'edited');
  assert.equal(fs.existsSync(path.join(project, 'docs', 'foo.md')), false, 'the root is untouched');
  assert.deepEqual(accessCalls, [{ sessionId: 'sess-overlay', userId: 7, mode: 'write' }]);

  denyAccess = true;
  const denied = await save({ filePath: 'README.md', content: 'nope', sessionId: 'sess-overlay' });
  assert.equal(denied.status, 404);
  assert.equal(fs.readFileSync(path.join(overlay, 'README.md'), 'utf8'), 'overlay readme');
  assert.equal(fs.readFileSync(path.join(project, 'README.md'), 'utf8'), 'root readme');
  denyAccess = false;

  assert.equal((await save({ filePath: '.env', content: 'TOKEN=x', sessionId: 'sess-overlay' })).status, 428);
  assert.equal((await save({ filePath: 'escape.txt', content: 'x', sessionId: 'sess-overlay' })).status, 403);
  assert.equal(fs.readFileSync(path.join(outside, 'secret.txt'), 'utf8'), 'OUTSIDE');

  const rootSave = await save({ filePath: 'README.md', content: 'root edited' });
  assert.equal(rootSave.status, 200);
  assert.equal(fs.readFileSync(path.join(project, 'README.md'), 'utf8'), 'root edited');
  assert.equal(fs.readFileSync(path.join(overlay, 'README.md'), 'utf8'), 'overlay readme');
});

test('qa M-1: every overlay save is audited without content; root saves are not', async () => {
  reset();
  assert.equal((await save({ filePath: 'docs/foo.md', content: 'audited body', sessionId: 'sess-overlay' })).status,
    200);
  assert.equal((await save({ filePath: '.env', content: 'TOKEN=new', sessionId: 'sess-overlay',
    confirmSecret: true })).status, 200);
  assert.equal((await save({ filePath: 'README.md', content: 'root only' })).status, 200);
  assert.equal((await save({ filePath: 'README.md', content: 'plain', sessionId: 'sess-plain' })).status, 200);

  const writes = auditRows.filter((row) => row.action === OVERLAY_FILE_WRITE_AUDIT_ACTION);
  assert.deepEqual(writes.map((row) => ({ userId: row.userId, ...row.metadata })), [
    { userId: 7, projectId: 'p', sessionId: 'sess-overlay', overlayId: OVERLAY_ID, path: 'docs/foo.md' },
    { userId: 7, projectId: 'p', sessionId: 'sess-overlay', overlayId: OVERLAY_ID, path: '.env' },
  ], 'one line per overlay save, none for root saves (with or without an overlay-less session)');
  assert.deepEqual(secretAudits(), [
    { projectId: 'p', path: '.env', access: 'save', overlay: true, sessionId: 'sess-overlay', overlayId: OVERLAY_ID },
  ]);
  const serialized = JSON.stringify(auditRows);
  assert.equal(serialized.includes('audited body') || serialized.includes('TOKEN=new'), false, 'never the content');
});

test('B-1691: the overlay under .git opens only through its sessionId; .git itself never', async () => {
  reset();
  const otherOverlay = path.join(project, '.git', 'nassaj-session-overlays', 'instances', 'other', 'workspace');
  fs.mkdirSync(otherOverlay, { recursive: true });
  fs.writeFileSync(path.join(otherOverlay, 'x.md'), 'other session');
  fs.writeFileSync(path.join(overlay, '.git'), 'gitdir: /elsewhere\n');
  fs.writeFileSync(path.join(project, '.gitignore'), 'node_modules\n');
  const silenced = console.warn;
  console.warn = () => {};
  try {
    const own = path.join(overlay, 'README.md');
    assert.equal((await read({ filePath: own, sessionId: 'sess-overlay' })).payload.content, 'overlay readme');
    assert.equal((await raw({ path: own, sessionId: 'sess-overlay' })).payload, 'overlay readme');
    for (const filePath of [own, path.join(otherOverlay, 'x.md'), '.git/config']) {
      const refused = await read({ filePath });
      assert.deepEqual(refused, { status: 403, payload: { error: 'Path must be under project root' } }, filePath);
      assert.equal((await raw({ path: filePath })).status, 403, filePath);
    }
    const crossSession = await read({ filePath: path.join(otherOverlay, 'x.md'), sessionId: 'sess-overlay' });
    assert.equal(crossSession.status, 403, "another session's overlay is refused, not mapped");
    assert.equal((await read({ filePath: '.git', sessionId: 'sess-overlay' })).status, 403);
    assert.equal((await read({ filePath: '.gitignore' })).payload.content, 'node_modules\n');

    for (const body of [
      { filePath: '.git/config', content: '[core]\n\tfsmonitor = x' },
      { filePath: '.git/hooks/pre-commit', content: '#!/bin/sh' },
      { filePath: own, content: 'bypass' },
      { filePath: '.git', content: 'gitdir: /attacker', sessionId: 'sess-overlay' },
    ]) {
      assert.equal((await save(body)).status, 403, body.filePath);
    }
    assert.equal(fs.existsSync(path.join(project, '.git', 'config')), false);
    assert.equal(fs.readFileSync(own, 'utf8'), 'overlay readme');
    assert.equal(fs.readFileSync(path.join(overlay, '.git'), 'utf8'), 'gitdir: /elsewhere\n');
    assert.equal((await save({ filePath: own, content: 'via session', sessionId: 'sess-overlay' })).status, 200);
    assert.equal(fs.readFileSync(own, 'utf8'), 'via session');
  } finally {
    console.warn = silenced;
    fs.writeFileSync(path.join(overlay, 'README.md'), 'overlay readme');
    fs.rmSync(path.join(overlay, '.git'));
    fs.rmSync(path.join(project, '.gitignore'));
  }
});

test('B-1691 (qa F8): a legacy project row rooted inside .git is refused for read and write', async () => {
  reset();
  const legacyRoot = path.join(project, '.git');
  fs.writeFileSync(path.join(legacyRoot, 'config'), '[core]\n');
  fs.mkdirSync(path.join(legacyRoot, 'hooks'), { recursive: true });
  const silenced = console.warn;
  console.warn = () => {};
  try {
    const refused = { status: 403, payload: { error: 'Path must be under project root' } };
    assert.deepEqual(await read({ filePath: 'config' }, legacyRoot), refused);
    assert.equal((await raw({ path: 'config' }, legacyRoot)).status, 403);
    assert.equal((await save({ filePath: 'config', content: '[filter "y"]\n\tclean = x' }, legacyRoot)).status, 403);
    assert.equal((await save({ filePath: 'hooks/pre-commit', content: '#!/bin/sh' }, legacyRoot)).status, 403);
    assert.equal(fs.readFileSync(path.join(legacyRoot, 'config'), 'utf8'), '[core]\n');
    assert.equal(fs.existsSync(path.join(legacyRoot, 'hooks', 'pre-commit')), false);
    assert.equal((await read({ filePath: 'README.md' }, overlay)).status, 403, 'an overlay registered as a project');
    assert.equal((await save({ filePath: 'README.md', content: 'x' }, overlay)).status, 403);
    assert.equal((await read({ filePath: 'README.md', sessionId: 'sess-overlay' })).payload.content, 'overlay readme',
      'the overlay stays reachable through its sessionId');
  } finally {
    console.warn = silenced;
    fs.rmSync(path.join(legacyRoot, 'config'));
  }
});
