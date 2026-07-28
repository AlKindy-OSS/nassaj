/**
 * Security regression tests for two handlers that live inside server/index.js.
 *
 * WHY THE UNUSUAL HARNESS: index.js is the process entry point — it calls
 * startServer() at module scope, so `import`ing it would boot the HTTP server,
 * the websocket server, the sessions watcher and the real database. The
 * handlers under test are inline arrow functions in that 2600-line module and
 * are not exported, so there is nothing to import either.
 *
 * Instead of re-implementing the handlers in the test (which would assert only
 * that the copy is correct — the "synthetic fixture" trap), each test EXTRACTS
 * THE REAL SOURCE TEXT of the handler from server/index.js and evaluates it
 * with the collaborators it closes over injected as parameters. The bytes under
 * test are therefore the bytes that ship; only the surroundings are fakes.
 * If someone reverts the fix in index.js, these tests fail.
 *
 * Covers:
 *   - PUT /api/projects/:projectId/file — must route through the shared
 *     symlink-aware guard instead of a local lexical startsWith check, so a
 *     write cannot escape the project root via a planted symlink.
 *   - POST /api/system/update — must answer the request exactly once, even when
 *     a failed spawn emits BOTH 'error' and 'close'.
 */

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import { mkdtemp, mkdir, writeFile, symlink, rm, realpath, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { isResolvedPathInsideRootReal } from './utils/path-guard.js';

const INDEX_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'index.js');
const INDEX_SOURCE = fs.readFileSync(INDEX_PATH, 'utf8');

/**
 * Slice a balanced `{...}` block starting at the first `{` at/after `from`.
 * The regions extracted below contain no braces inside string/template
 * literals, so plain counting is exact; the callers assert on the extracted
 * text, which would break loudly if that ever stopped holding.
 */
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

/** Extract the body of a top-level `function <name>(...) {...}` declaration. */
function extractFunctionSource(name) {
  const marker = `function ${name}(`;
  const at = INDEX_SOURCE.indexOf(marker);
  assert.notStrictEqual(at, -1, `${name} not found in index.js`);
  const signatureEnd = INDEX_SOURCE.indexOf(')', at);
  const params = INDEX_SOURCE.slice(at + marker.length, signatureEnd);
  return { params, body: sliceBalancedBlock(INDEX_SOURCE, signatureEnd) };
}

/**
 * Extract the whole `async (req, res) => {...}` handler registered at
 * `routeMarker`, as an evaluable function expression.
 */
function extractRouteHandler(routeMarker) {
  const at = INDEX_SOURCE.indexOf(routeMarker);
  assert.notStrictEqual(at, -1, `${routeMarker} not found in index.js`);
  const arrow = 'async (req, res) => {';
  const arrowAt = INDEX_SOURCE.indexOf(arrow, at);
  assert.notStrictEqual(arrowAt, -1, `handler arrow for ${routeMarker} not found`);
  return `async (req, res) => ${sliceBalancedBlock(INDEX_SOURCE, arrowAt + arrow.length - 1)}`;
}

/**
 * Extract a top-level `process.on('<event>', (<params>) => {...})` listener as
 * an evaluable arrow function.
 */
function extractProcessHandler(event, params) {
  const marker = `process.on('${event}', (${params}) => {`;
  const at = INDEX_SOURCE.indexOf(marker);
  assert.notStrictEqual(at, -1, `${event} handler not found in index.js`);
  return `(${params}) => ${sliceBalancedBlock(INDEX_SOURCE, at + marker.length - 1)}`;
}

/** Minimal express-style response double that records exactly what was sent. */
function makeResponseDouble() {
  const sent = [];
  const res = {
    headersSent: false,
    statusCode: 200,
    status(code) {
      res.statusCode = code;
      return res;
    },
    json(payload) {
      // Mirror express: a second write after headers are sent is fatal.
      if (res.headersSent) {
        const err = new Error('Cannot set headers after they are sent to the client');
        err.code = 'ERR_HTTP_HEADERS_SENT';
        throw err;
      }
      res.headersSent = true;
      sent.push({ status: res.statusCode, payload });
      return res;
    },
  };
  return { res, sent };
}

// ---------------------------------------------------------------------------
// PUT /api/projects/:projectId/file
// ---------------------------------------------------------------------------

/**
 * Build the real save-file handler with fakes for its DB collaborators and the
 * REAL path/fs modules plus the REAL validatePathInProject (itself extracted
 * from index.js and wired to the REAL guard from utils/path-guard.js).
 */
function buildSaveFileHandler(projectRoot) {
  const validateSrc = extractFunctionSource('validatePathInProject');
  const handlerSrc = extractRouteHandler("app.put('/api/projects/:projectId/file'");

  // Sanity: the handler must not have kept its own lexical boundary check.
  assert.ok(
    handlerSrc.includes('validatePathInProject'),
    'save-file handler must delegate to the shared guard',
  );
  assert.ok(
    !handlerSrc.includes('normalizedRoot'),
    'save-file handler must not re-implement a local lexical boundary check',
  );

  const factory = new Function(
    'path', 'fsPromises', 'projectsDb', 'coerceUserId', 'isResolvedPathInsideRootReal', 'console',
    `function validatePathInProject(${validateSrc.params}) ${validateSrc.body}
     return ${handlerSrc};`,
  );

  return factory(
    path,
    fs.promises,
    {
      isProjectWritableByUser: () => true,
      getProjectPathById: async () => projectRoot,
    },
    (id) => id,
    isResolvedPathInsideRootReal,
    { error: () => {}, log: () => {}, warn: () => {} },
  );
}

test('save-file endpoint — refuses to write through a DANGLING symlink escaping the root', async () => {
  const outside = await realpath(await mkdtemp(path.join(tmpdir(), 'idx-out-')));
  const projectRoot = await realpath(await mkdtemp(path.join(tmpdir(), 'idx-proj-')));
  try {
    await mkdir(path.join(projectRoot, 'inbox'));
    const victim = path.join(outside, 'authorized_keys');
    // Hostile repo content: link exists, target does not (git ships this shape).
    await symlink(victim, path.join(projectRoot, 'inbox', 'x.md'));

    const handler = buildSaveFileHandler(projectRoot);
    const { res, sent } = makeResponseDouble();
    await handler(
      { params: { projectId: '1' }, body: { filePath: 'inbox/x.md', content: 'ssh-rsa PWNED' }, user: { id: 1 } },
      res,
    );

    assert.strictEqual(sent.length, 1);
    assert.strictEqual(sent[0].status, 403, 'the write must be refused, not performed');
    assert.strictEqual(fs.existsSync(victim), false, 'the symlink target must NOT have been created');
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test('save-file endpoint — refuses to write through a LIVE symlink escaping the root', async () => {
  const outside = await realpath(await mkdtemp(path.join(tmpdir(), 'idx-out-')));
  const projectRoot = await realpath(await mkdtemp(path.join(tmpdir(), 'idx-proj-')));
  try {
    await writeFile(path.join(outside, 'secret.txt'), 'original\n');
    await symlink(outside, path.join(projectRoot, 'escape'));

    const handler = buildSaveFileHandler(projectRoot);
    const { res, sent } = makeResponseDouble();
    await handler(
      { params: { projectId: '1' }, body: { filePath: 'escape/secret.txt', content: 'OVERWRITTEN' }, user: { id: 1 } },
      res,
    );

    assert.strictEqual(sent[0].status, 403);
    assert.strictEqual(await readFile(path.join(outside, 'secret.txt'), 'utf8'), 'original\n',
      'the out-of-tree file must be untouched');
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test('save-file endpoint — an ordinary in-tree save still works', async () => {
  const projectRoot = await realpath(await mkdtemp(path.join(tmpdir(), 'idx-proj-')));
  try {
    await mkdir(path.join(projectRoot, 'src'));
    await writeFile(path.join(projectRoot, 'src', 'app.js'), 'old\n');

    const handler = buildSaveFileHandler(projectRoot);
    const { res, sent } = makeResponseDouble();
    await handler(
      { params: { projectId: '1' }, body: { filePath: 'src/app.js', content: 'new content' }, user: { id: 1 } },
      res,
    );

    assert.strictEqual(sent[0].status, 200);
    assert.strictEqual(sent[0].payload.success, true);
    assert.strictEqual(await readFile(path.join(projectRoot, 'src', 'app.js'), 'utf8'), 'new content');
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test('save-file endpoint — plain ../ traversal is still refused', async () => {
  const projectRoot = await realpath(await mkdtemp(path.join(tmpdir(), 'idx-proj-')));
  try {
    const handler = buildSaveFileHandler(projectRoot);
    const { res, sent } = makeResponseDouble();
    await handler(
      { params: { projectId: '1' }, body: { filePath: '../escaped.txt', content: 'x' }, user: { id: 1 } },
      res,
    );
    assert.strictEqual(sent[0].status, 403);
    assert.strictEqual(fs.existsSync(path.join(path.dirname(projectRoot), 'escaped.txt')), false);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// POST /api/system/update
// ---------------------------------------------------------------------------

/** Child-process double that can replay a real failed-spawn event sequence. */
function makeChildDouble() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  return child;
}

function buildSystemUpdateHandler(child) {
  const handlerSrc = extractRouteHandler("app.post('/api/system/update'");
  assert.ok(handlerSrc.includes('headersSent'), 'update handler must check headersSent');

  const factory = new Function(
    'spawn', 'os', 'console', 'APP_ROOT', 'IS_PLATFORM', 'installMode',
    `return ${handlerSrc};`,
  );
  return factory(
    () => child,
    { homedir: () => '/tmp' },
    { log: () => {}, error: () => {} },
    '/tmp/app-root',
    false,
    'git',
  );
}

test('system update — a failed spawn emitting BOTH error and close answers exactly once', async () => {
  const child = makeChildDouble();
  const handler = buildSystemUpdateHandler(child);
  const { res, sent } = makeResponseDouble();

  await handler({ user: { id: 1 } }, res);

  // The real Node sequence for a spawn that fails (e.g. EAGAIN under memory
  // pressure): 'error' first, then 'close' with a null exit code. Before the
  // fix the second listener threw ERR_HTTP_HEADERS_SENT from inside an event
  // listener — uncatchable by the route's try/catch and, with no process-level
  // handler, fatal to the whole server.
  const spawnError = new Error('spawn EAGAIN');
  spawnError.code = 'EAGAIN';
  assert.doesNotThrow(() => child.emit('error', spawnError));
  assert.doesNotThrow(() => child.emit('close', null));

  assert.strictEqual(sent.length, 1, 'the request must be answered exactly once');
  assert.strictEqual(sent[0].status, 500);
  assert.strictEqual(sent[0].payload.error, 'spawn EAGAIN');
});

test('system update — close-then-error (reverse order) also answers exactly once', async () => {
  const child = makeChildDouble();
  const handler = buildSystemUpdateHandler(child);
  const { res, sent } = makeResponseDouble();

  await handler({ user: { id: 1 } }, res);

  assert.doesNotThrow(() => child.emit('close', 1));
  assert.doesNotThrow(() => child.emit('error', new Error('late failure')));

  assert.strictEqual(sent.length, 1);
  assert.strictEqual(sent[0].status, 500);
  assert.strictEqual(sent[0].payload.error, 'Update command failed');
});

test('system update — the success path is unchanged', async () => {
  const child = makeChildDouble();
  const handler = buildSystemUpdateHandler(child);
  const { res, sent } = makeResponseDouble();

  await handler({ user: { id: 1 } }, res);

  child.stdout.emit('data', Buffer.from('ok\n'));
  child.emit('close', 0);

  assert.strictEqual(sent.length, 1);
  assert.strictEqual(sent[0].status, 200);
  assert.strictEqual(sent[0].payload.success, true);
  assert.strictEqual(sent[0].payload.output, 'ok\n');
});

// ---------------------------------------------------------------------------
// Process-level crash handlers
// ---------------------------------------------------------------------------

test('uncaughtException handler — logs synchronously, closes the DB, then EXITS (no fail-open)', () => {
  const handlerSrc = extractProcessHandler('uncaughtException', 'error, origin');
  const writes = [];
  const exits = [];
  let dbClosed = 0;

  const handler = new Function(
    'fs', 'closeConnection', 'process',
    `let fatalHandlerRan = false;
     return ${handlerSrc};`,
  )(
    { writeSync: (fd, text) => writes.push({ fd, text }) },
    () => { dbClosed += 1; },
    { exit: (code) => exits.push(code) },
  );

  const boom = Object.assign(new Error('kaboom'), { code: 'EBOOM' });
  handler(boom, 'uncaughtException');

  assert.strictEqual(writes.length, 1, 'must emit exactly one record');
  assert.strictEqual(writes[0].fd, 2, 'must write to stderr');
  // A pipe (PM2) swallows async writes when the process exits immediately, so
  // the diagnostic has to be a synchronous fd write, not console.error.
  assert.match(writes[0].text, /uncaughtException/);
  assert.match(writes[0].text, /kaboom/, 'the message must be recorded');
  assert.match(writes[0].text, /EBOOM/, 'the error code must be recorded');
  assert.match(writes[0].text, /stack:/, 'the stack must be recorded — never a silent swallow');

  assert.strictEqual(dbClosed, 1, 'SQLite must be closed so the WAL is checkpointed');
  assert.deepStrictEqual(exits, [1], 'the process MUST exit — staying alive after a corrupt state is fail-open');
});

test('unhandledRejection handler — logs the reason and does NOT exit', () => {
  const handlerSrc = extractProcessHandler('unhandledRejection', 'reason');
  const logged = [];
  const exits = [];

  const handler = new Function(
    'console', 'process',
    `return ${handlerSrc};`,
  )(
    { error: (...args) => logged.push(args) },
    { exit: (code) => exits.push(code) },
  );

  handler(Object.assign(new Error('rejected thing'), { code: 'ENOPE' }));
  assert.strictEqual(logged.length, 1);
  assert.match(String(logged[0][0]), /unhandledRejection/);
  assert.strictEqual(logged[0][1].message, 'rejected thing');
  assert.strictEqual(logged[0][1].code, 'ENOPE');
  assert.ok(logged[0][1].stack, 'the stack must be kept — logging must not be a silent swallow');

  // Non-Error rejection values must still be recorded, not dropped.
  handler('a bare string reason');
  assert.strictEqual(logged[1][1].message, 'a bare string reason');

  assert.deepStrictEqual(exits, [], 'one failed promise must not kill every live session');
});

// ---------------------------------------------------------------------------
// Upload destination-name validation (client-controlled relativePaths)
// ---------------------------------------------------------------------------

function buildUploadNameValidator() {
  const filenameSrc = extractFunctionSource('validateFilename');
  const relPathSrc = extractFunctionSource('validateUploadRelativePath');
  const factory = new Function(
    'path',
    `function validateFilename(${filenameSrc.params}) ${filenameSrc.body}
     function validateUploadRelativePath(${relPathSrc.params}) ${relPathSrc.body}
     return validateUploadRelativePath;`,
  );
  return factory(path);
}

test('upload name guard — rejects traversal, absolute paths, NUL and control characters', () => {
  const validate = buildUploadNameValidator();
  for (const hostile of [
    '../../../etc/passwd',
    '..\\..\\windows\\system32\\x.dll',
    '/etc/passwd',
    'C:\\Windows\\x.dll',
    'a/../../b.txt',
    'ok/\0evil.txt',
    'bad\nname.txt',
    '..',
    '',
    '   ',
  ]) {
    assert.strictEqual(validate(hostile).valid, false, `must reject: ${JSON.stringify(hostile)}`);
  }
  assert.strictEqual(validate(undefined).valid, false);
  assert.strictEqual(validate({ toString: () => '../x' }).valid, false, 'non-strings must be rejected');
});

test('upload name guard — keeps legitimate names, including Arabic and nested folders', () => {
  const validate = buildUploadNameValidator();
  const ok = validate('src/components/App.tsx');
  assert.strictEqual(ok.valid, true);
  assert.strictEqual(ok.safePath, path.join('src', 'components', 'App.tsx'));

  const arabic = validate('مستندات/تقرير نهائي.pdf');
  assert.strictEqual(arabic.valid, true, 'Arabic filenames must survive untouched');
  assert.strictEqual(arabic.safePath, path.join('مستندات', 'تقرير نهائي.pdf'));

  // Leading "./" is a normal browser-supplied prefix, not traversal.
  assert.strictEqual(validate('./readme.md').safePath, 'readme.md');
  // Dotfiles remain allowed: they are ordinary project content.
  assert.strictEqual(validate('.gitignore').valid, true);
});
