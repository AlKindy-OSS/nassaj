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
 *   - POST /api/system/update — must bind the request to the exact advertised
 *     release and return structured updater errors without spawning a shell.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mkdtemp, mkdir, writeFile, symlink, rm, realpath, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { isResolvedPathInsideRootReal } from './utils/path-guard.js';
import { buildPendingAction } from './services/server-actions.js';
import { isShareableDocument, saveSharedDocumentAtomically } from './services/document-share-files.js';

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
    'isShareableDocument', 'saveSharedDocumentAtomically',
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
    isShareableDocument,
    saveSharedDocumentAtomically,
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

test('save-file endpoint — a shareable document is replaced atomically', async () => {
  // The real document guard requires a disk-backed, non-hidden project root.
  const projectRoot = await realpath(await mkdtemp(path.join(process.cwd(), 'idx-doc-proj-')));
  let previousVersion;
  try {
    await mkdir(path.join(projectRoot, 'docs'));
    const document = path.join(projectRoot, 'docs', 'notes.md');
    await writeFile(document, 'old version', { mode: 0o640 });
    previousVersion = await fs.promises.open(document, 'r');
    const before = await previousVersion.stat();
    const handler = buildSaveFileHandler(projectRoot);
    const { res, sent } = makeResponseDouble();
    await handler(
      { params: { projectId: '1' }, body: { filePath: 'docs/notes.md', content: 'new version' }, user: { id: 1 } },
      res,
    );

    assert.strictEqual(sent.length, 1);
    assert.strictEqual(sent[0].status, 200);
    assert.strictEqual(sent[0].payload.success, true);
    assert.strictEqual(await readFile(document, 'utf8'), 'new version');
    assert.strictEqual(await previousVersion.readFile('utf8'), 'old version',
      'an existing reader must retain the complete previous version');
    const after = await fs.promises.stat(document);
    assert.notStrictEqual(after.ino, before.ino, 'save must replace the document, not truncate it');
    assert.strictEqual(after.mode & 0o777, before.mode & 0o777);
    assert.deepStrictEqual(await fs.promises.readdir(path.dirname(document)), ['notes.md']);
  } finally {
    await previousVersion?.close();
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

test('system update routes expose only the v2 jobs contract and matching status URL', () => {
  assert.match(INDEX_SOURCE, /app\.post\('\/api\/system\/update\/jobs'/);
  assert.match(INDEX_SOURCE, /app\.get\('\/api\/system\/update\/jobs\/:jobId'/);
  assert.match(INDEX_SOURCE, /statusUrl: `\/api\/system\/update\/jobs\/\$\{created\.job\.id\}`/);
  // 9bfac874: the offer is a single predicate that also requires usable storage.
  assert.match(INDEX_SOURCE, /const updateOffered = !IS_PLATFORM && updateHostCapability\.ready === true && updateStorage\.ok;/);
  assert.match(INDEX_SOURCE, /updaterProtocol: updateOffered \? 'async-v2' : null/);
  assert.match(INDEX_SOURCE, /updaterStrategy: updateOffered/);
  assert.match(INDEX_SOURCE, /updateReady: updateOffered/);
  assert.match(INDEX_SOURCE, /blockedReasonCode:/);
  assert.match(INDEX_SOURCE, /update_protocol_upgrade_required/);
});

test('boot completes handoff proof and opens the gate before starting the update worker', () => {
  const complete = INDEX_SOURCE.indexOf('completeBootstrappedSourceUpdate();');
  // The worker is optional-chained: it is null when the release source is invalid.
  const workerStart = INDEX_SOURCE.indexOf('sourceUpdateWorker?.start();', complete);
  assert.ok(complete >= 0 && workerStart > complete);
  const functionStart = INDEX_SOURCE.indexOf('function completeBootstrappedSourceUpdate()');
  const functionEnd = INDEX_SOURCE.indexOf('// Initialize database and start server', functionStart);
  const body = INDEX_SOURCE.slice(functionStart, functionEnd);
  assert.ok(body.indexOf('appendActivationReceipt') < body.indexOf('durableReceiptFile'));
  assert.ok(body.indexOf('durableReceiptFile') < body.indexOf('ownership.complete'));
  assert.ok(body.indexOf('ownership.complete') < body.indexOf("['runtime_verifying'], 'activated'"));
  assert.match(INDEX_SOURCE, /listRuntimeVerifying\(\)/);
  assert.match(INDEX_SOURCE, /source_update_runtime_recovery_cas_failed/);
  assert.match(INDEX_SOURCE, /verifyReleaseLayoutRuntimeRecovery\(job\)/);
  for (const field of ['release_asset_sha256', 'archive_sha256', 'source_tree_sha256',
    'activation_identity_sha256', 'expected_server_build_id', 'expected_client_build_id']) {
    assert.ok(INDEX_SOURCE.includes(`job.${field}`), `runtime recovery must bind ${field}`);
  }
  assert.equal(INDEX_SOURCE.match(/sourceUpdateWorker\??\.start\(\);/g)?.length, 1);
  assert.match(INDEX_SOURCE, /readReleaseActivationAction/);
  assert.match(INDEX_SOURCE, /updateRuntimeOrchestrator\.sealGeneration/);
  assert.match(INDEX_SOURCE, /queueSourceUpdateRestart/);
});

function buildSystemUpdateHandler(overrides = {}) {
  const handlerSrc = extractRouteHandler("app.post('/api/system/update/jobs'");
  assert.equal(handlerSrc.includes("spawn('sh'"), false);
  assert.equal(handlerSrc.includes('git pull'), false);

  const factory = new Function(
    'IS_PLATFORM', 'updateHostCapability', 'isNassajReleaseVersion',
    'SOURCE_UPDATE_IDEMPOTENCY_KEY', 'sourceUpdateJobsDb', 'crypto',
    'hashSourceUpdateIdempotencyKey', 'sourceUpdateRequestFingerprint', 'sourceUpdateWorker',
    'sourceUpdateErrorPayload',
    `return ${handlerSrc};`,
  );
  return factory(
    overrides.isPlatform ?? false,
    overrides.updateHostCapability ?? { ready: true, protocol: 'async-v2', jobStrategy: 'git-checkout-v2' },
    (value) => /^\d+\.\d+\.\d+\.\d+$/.test(value || ''),
    /^[0-9a-f-]{36}$/i,
    overrides.jobs || { createOrReuse: () => ({ job: { id: 'job-1', state: 'accepted' }, reused: false, mismatch: false }) },
    { randomUUID: () => 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' },
    (value) => `hash:${value}`,
    (_owner, version, strategy) => `${version}:${strategy}`,
    { start() {} },
    (error) => ({ status: error.status || 500, body: { success: false, code: error.code || 'update_failed', error: error.message } }),
  );
}

test('system update — active conflict exposes a descriptor only to the job owner', async () => {
  for (const owned of [true, false]) {
    const job = { id: 'active-job', state: 'restart_queued', expected_version: '2.2.0.1' };
    const handler = buildSystemUpdateHandler({ jobs: {
      createOrReuse: () => ({ job, reused: true, mismatch: true, activeConflict: true }),
      getForOwner(id, ownerId) {
        assert.equal(id, job.id);
        assert.equal(ownerId, 1);
        return owned ? job : null;
      },
    } });
    const { res, sent } = makeResponseDouble();
    await handler({ body: { expectedVersion: '2.2.0.0' }, user: { id: 1 },
      get: () => 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }, res);
    assert.equal(sent[0].status, 409);
    assert.equal(sent[0].payload.code, 'update_in_progress');
    assert.equal(sent[0].payload.jobId, owned ? job.id : undefined);
    assert.equal(sent[0].payload.targetVersion, owned ? '2.2.0.1' : undefined);
    assert.equal(sent[0].payload.statusUrl, owned ? '/api/system/update/jobs/active-job' : undefined);
  }
});

test('system update — active discovery is guarded, read-only and handles a missing job', () => {
  const marker = "app.get('/api/system/update/jobs/active', authenticateToken, requireRole('owner'), (req, res) => {";
  const offset = INDEX_SOURCE.indexOf(marker);
  assert.ok(offset > 0 && offset < INDEX_SOURCE.indexOf("app.get('/api/system/update/jobs/:jobId'"));
  const body = sliceBalancedBlock(INDEX_SOURCE, offset + marker.length - 1);
  const job = { id: 'owned', state: 'awaiting_sessions', expected_version: '2.2.0.1' };
  for (const ownerId of [1, 2, undefined, -1]) {
    const calls = [];
    const handler = new Function('sourceUpdateJobsDb', `return (req, res) => ${body};`)({
      getActiveForOwner(id) { calls.push(id); return id === 1 ? job : null; },
    });
    const { res, sent } = makeResponseDouble();
    res.set = (key, value) => { assert.equal(key, 'Cache-Control'); assert.equal(value, 'no-store'); };
    handler({ user: { id: ownerId } }, res);
    if (ownerId === undefined || ownerId === -1) {
      assert.equal(sent[0].status, 403);
      assert.deepEqual(calls, []);
    } else {
      assert.deepEqual(calls, [ownerId]);
      assert.equal(sent[0].payload.job?.jobId ?? null, ownerId === 1 ? 'owned' : null);
    }
  }
});

test('system update — persists exact advertised version and returns the async 202 contract', async () => {
  const versions = [];
  const handler = buildSystemUpdateHandler({ jobs: { createOrReuse(input) {
    versions.push(input.expectedVersion);
    return { job: { id: input.id, state: 'accepted' }, reused: false, mismatch: false };
  } } });
  const { res, sent } = makeResponseDouble();

  await handler({ body: { expectedVersion: '1.42.0.1' }, user: { id: 1 }, get: () => 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }, res);
  assert.deepEqual(versions, ['1.42.0.1']);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].status, 202);
  assert.equal(sent[0].payload.state, 'accepted');
  assert.equal(sent[0].payload.statusUrl, '/api/system/update/jobs/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
});

test('system update — rejects idempotency reuse with a different request fingerprint', async () => {
  const handler = buildSystemUpdateHandler({ jobs: { createOrReuse() {
    return { job: { id: 'job-1', state: 'accepted' }, reused: true, mismatch: true, activeConflict: false };
  } } });
  const { res, sent } = makeResponseDouble();

  await handler({ body: { expectedVersion: '1.42.0.1' }, user: { id: 1 }, get: () => 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }, res);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].status, 409);
  assert.equal(sent[0].payload.code, 'idempotency_mismatch');
});

test('system update — returns repository structured error exactly once', async () => {
  const handler = buildSystemUpdateHandler({ jobs: { createOrReuse() {
    const error = new Error('database unavailable');
    error.code = 'update_store_unavailable';
    error.status = 503;
    throw error;
  } } });
  const { res, sent } = makeResponseDouble();

  await handler({ body: { expectedVersion: '1.42.0.1' }, user: { id: 1 }, get: () => 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }, res);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].status, 503);
  assert.equal(sent[0].payload.code, 'update_store_unavailable');
});

/* legacy synchronous updater assertions were replaced by the durable job contract. */
test('system update — fails closed when the verified capability is unavailable', async () => {
  let called = false;
  const handler = buildSystemUpdateHandler({ updateHostCapability: { ready: false, protocol: null, jobStrategy: null }, jobs: { createOrReuse() { called = true; } } });
  const { res, sent } = makeResponseDouble();

  await handler({ body: { expectedVersion: '1.42.0.1' }, user: { id: 1 }, get: () => 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }, res);
  assert.equal(called, false);
  assert.equal(sent[0].status, 503);
  assert.equal(sent[0].payload.code, 'update_capability_unavailable');
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
    'fs', 'closeUniversalConversationShadowRuntime', 'closeConnection', 'process',
    `let fatalHandlerRan = false;
     return ${handlerSrc};`,
  )(
    { writeSync: (fd, text) => writes.push({ fd, text }) },
    () => {},
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

// ── B-1056 / ADR-156 WI-2: a restart row is never rebound to another job ─────

/**
 * Evaluates the REAL source text of queueSourceUpdateRestart (and the two
 * helpers it closes over) with its repositories injected, so the bytes under
 * test are the bytes that ship. Sliced between explicit markers rather than by
 * brace counting, because this region contains a template literal.
 */
function buildQueueSourceUpdateRestart({ rows, jobs, refusals = [], insert, onRead }) {
  const from = INDEX_SOURCE.indexOf('const SAME_GENERATION_SUPERSEDE_PASSES');
  const to = INDEX_SOURCE.indexOf('const updateNassajSource', from);
  assert.ok(from !== -1 && to > from, 'queueSourceUpdateRestart region not found in index.js');
  const region = INDEX_SOURCE.slice(from, to);
  assert.match(region, /superseded_by_job:/, 'the supersede reason must be declared in index.js');

  const pendingServerActionsDb = {
    supersedeOtherGenerations: () => 0,
    getQueuedByActionType: (actionType, expectedServerBuildId) => {
      const row = rows.find((candidate) => candidate.actionType === actionType
        && candidate.expectedServerBuildId === expectedServerBuildId
        && (candidate.status === 'pending' || candidate.status === 'failed')) ?? null;
      // Lets a test reproduce a concurrent claim landing between the read and
      // the write — the exact window the CAS guard of ت-1 exists for.
      if (row && onRead) onRead(row);
      return row;
    },
    // Mirrors the repository's CAS guard: only a QUEUED row may be settled here.
    supersedeQueued: (id, error) => {
      const row = rows.find((candidate) => candidate.id === id);
      if (!row || !['pending', 'failed'].includes(row.status)) return 0;
      row.status = 'superseded';
      row.error = error;
      return 1;
    },
    markSuperseded: () => {
      throw new Error('WI-2 must use the CAS-guarded supersedeQueued (ت-1)');
    },
    insert: insert ?? ((action) => {
      rows.push({ ...action, status: 'pending', error: null });
      return 1;
    }),
  };
  const sourceUpdateJobsDb = { getById: (id) => jobs.get(id) ?? null };
  const auditLogDb = { record: (action, options) => refusals.push({ action, ...options.metadata }) };

  return new Function(
    'buildPendingAction', 'pendingServerActionsDb', 'sourceUpdateJobsDb', 'auditLogDb',
    `${region}\nreturn queueSourceUpdateRestart;`,
  )(buildPendingAction, pendingServerActionsDb, sourceUpdateJobsDb, auditLogDb);
}

const BUILD_ID = 'a'.repeat(64);
const IDENTITY_OLD = 'c'.repeat(64);
const IDENTITY_NEW = 'd'.repeat(64);

function queuedRow(overrides = {}) {
  return {
    id: 'row-old',
    actionType: 'safe-restart',
    status: 'pending',
    expectedServerBuildId: BUILD_ID,
    sourceUpdateJobId: 'job-old',
    sourceUpdateTransactionId: 'tx-old',
    activationIdentitySha256: IDENTITY_OLD,
    releaseCommit: 'e'.repeat(40),
    error: null,
    ...overrides,
  };
}

function newJobRequest(overrides = {}) {
  return {
    expectedServerBuildId: BUILD_ID,
    reason: 'source update',
    transactionId: 'tx-new',
    sourceUpdateJobId: 'job-new',
    activationIdentitySha256: IDENTITY_NEW,
    releaseCommit: 'f'.repeat(40),
    ...overrides,
  };
}

test('B-1056 queueSourceUpdateRestart: a row from a terminated job is superseded, never rebound', async () => {
  for (const state of ['failed', 'rolled_back', 'superseded', 'manual_recovery_required']) {
    const rows = [queuedRow()];
    const jobs = new Map([['job-old', { id: 'job-old', state }]]);
    const queue = buildQueueSourceUpdateRestart({ rows, jobs });

    assert.equal(await queue(newJobRequest()), true, `${state}: queueing must succeed`);
    assert.equal(rows.length, 2, `${state}: a NEW row must be inserted, not the old one reused`);

    const old = rows[0];
    assert.equal(old.status, 'superseded', `${state}: the old row must be settled`);
    assert.equal(old.error, 'superseded_by_job:job-new', `${state}: the reason must name the new job`);
    assert.equal(old.sourceUpdateJobId, 'job-old', `${state}: the old row keeps its own identity`);
    assert.equal(old.activationIdentitySha256, IDENTITY_OLD);

    const fresh = rows[1];
    assert.equal(fresh.sourceUpdateJobId, 'job-new');
    assert.equal(fresh.sourceUpdateTransactionId, 'tx-new');
    assert.equal(fresh.activationIdentitySha256, IDENTITY_NEW);
    assert.equal(fresh.releaseCommit, 'f'.repeat(40));
  }
});

test('B-1056 queueSourceUpdateRestart: a row owned by a LIVE job still refuses the new job', async () => {
  for (const state of ['accepted', 'staging', 'candidate_sealed', 'restart_queued', 'activating', 'activated']) {
    const rows = [queuedRow()];
    const refusals = [];
    const jobs = new Map([['job-old', { id: 'job-old', state }]]);
    const queue = buildQueueSourceUpdateRestart({ rows, jobs, refusals });

    assert.equal(await queue(newJobRequest()), false, `${state}: must refuse`);
    assert.equal(rows.length, 1, `${state}: no new row`);
    assert.equal(rows[0].status, 'pending', `${state}: the live job keeps its row`);
    assert.equal(rows[0].error, null);
    assert.deepEqual(refusals, [{
      action: 'server_action_queue_refused', code: 'restart_row_bound_to_live_job',
      expectedServerBuildId: BUILD_ID, sourceUpdateJobId: 'job-new', conflictingActionId: 'row-old',
    }], `${state}: the refusal must be recorded under its own code`);
  }
});

test('ت-2 queueSourceUpdateRestart: an unbound or unknown-job row refuses under its own code', async () => {
  for (const row of [queuedRow({ sourceUpdateJobId: null }), queuedRow({ sourceUpdateJobId: 'job-gone' })]) {
    const rows = [row];
    const refusals = [];
    const queue = buildQueueSourceUpdateRestart({ rows, jobs: new Map(), refusals });
    assert.equal(await queue(newJobRequest()), false);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, 'pending', 'an unbound row is never superseded on a guess');
    assert.equal(refusals.length, 1);
    assert.equal(refusals[0].code, 'restart_row_unbound');
    assert.equal(refusals[0].conflictingActionId, 'row-old');
  }
});

test('ت-1 queueSourceUpdateRestart: losing the CAS race refuses instead of clobbering', async () => {
  // The row reads as abandoned, then a claim turns it 'executing' before the
  // write lands. Settling it then would erase a live attempt's identity.
  const rows = [queuedRow()];
  const refusals = [];
  const jobs = new Map([['job-old', { id: 'job-old', state: 'failed' }]]);
  const queue = buildQueueSourceUpdateRestart({
    rows, jobs, refusals, onRead: (row) => { row.status = 'executing'; },
  });

  assert.equal(await queue(newJobRequest()), false);
  assert.equal(refusals.at(-1)?.code, 'restart_row_supersede_lost_race');
  assert.equal(rows.length, 1, 'no row is inserted behind a live attempt');
  assert.equal(rows[0].status, 'executing', 'the live attempt keeps its row');
  assert.equal(rows[0].error, null);
});

test('ت-1 queueSourceUpdateRestart: the supersede pass count is bounded and never spins', async () => {
  const bound = Number(/const SAME_GENERATION_SUPERSEDE_PASSES = (\d+);/.exec(INDEX_SOURCE)?.[1]);
  assert.ok(Number.isSafeInteger(bound) && bound > 0, 'the pass bound must be a positive literal');

  // A queue that keeps producing another abandoned row on every read. Without
  // the bound this call would never return.
  const rows = [queuedRow({ id: 'row-0' })];
  const refusals = [];
  const jobs = new Map([['job-old', { id: 'job-old', state: 'failed' }]]);
  const queue = buildQueueSourceUpdateRestart({
    rows, jobs, refusals,
    onRead: () => { rows.push(queuedRow({ id: `row-${rows.length}` })); },
  });

  assert.equal(await queue(newJobRequest()), false, 'an undrainable queue refuses');
  assert.equal(
    rows.filter((row) => row.status === 'superseded').length, bound,
    `at most ${bound} passes may settle a row`,
  );
  assert.equal(refusals.at(-1)?.code, 'restart_row_queue_not_drained');
  assert.equal(rows.filter((row) => row.sourceUpdateJobId === 'job-new').length, 0,
    'no row is queued while the fingerprint is still occupied');
});

test('ت-2 queueSourceUpdateRestart: a raced insert is adopted only on a full identity match', async () => {
  for (const [raced, expected, code] of [
    [queuedRow({
      id: 'raced-same', sourceUpdateJobId: 'job-new', sourceUpdateTransactionId: 'tx-new',
      activationIdentitySha256: IDENTITY_NEW, releaseCommit: 'f'.repeat(40),
    }), true, null],
    [queuedRow({ id: 'raced-other' }), false, 'restart_row_raced_identity_mismatch'],
    [null, false, 'restart_row_raced_identity_mismatch'],
  ]) {
    const rows = [];
    const refusals = [];
    const queue = buildQueueSourceUpdateRestart({
      rows, jobs: new Map(), refusals,
      // Dedup: the insert is a no-op because a row landed concurrently.
      insert: () => { if (raced) rows.push(raced); return 0; },
    });

    assert.equal(await queue(newJobRequest()), expected, `${raced?.id ?? 'none'}`);
    if (code) {
      assert.equal(refusals.at(-1)?.code, code);
      assert.equal(refusals.at(-1)?.conflictingActionId, raced?.id ?? null);
    } else {
      assert.deepEqual(refusals, [], 'adopting this job\'s own row is not a refusal');
    }
  }
});

test('B-1056 queueSourceUpdateRestart: the same job re-queueing is idempotent', async () => {
  const rows = [queuedRow({
    id: 'row-same', sourceUpdateJobId: 'job-new', sourceUpdateTransactionId: 'tx-new',
    activationIdentitySha256: IDENTITY_NEW, releaseCommit: 'f'.repeat(40),
  })];
  const queue = buildQueueSourceUpdateRestart({ rows, jobs: new Map() });
  assert.equal(await queue(newJobRequest()), true);
  assert.equal(rows.length, 1, 'an identical request must collapse onto its own row');
  assert.equal(rows[0].status, 'pending');
});

test('B-1056 queueSourceUpdateRestart: a partial identity match is a different package', async () => {
  for (const drift of [
    { sourceUpdateTransactionId: 'tx-other' },
    { activationIdentitySha256: 'b'.repeat(64) },
    { releaseCommit: '9'.repeat(40) },
  ]) {
    const rows = [queuedRow({
      sourceUpdateJobId: 'job-new', sourceUpdateTransactionId: 'tx-new',
      activationIdentitySha256: IDENTITY_NEW, releaseCommit: 'f'.repeat(40), ...drift,
    })];
    const jobs = new Map([['job-new', { id: 'job-new', state: 'staging' }]]);
    const queue = buildQueueSourceUpdateRestart({ rows, jobs });
    assert.equal(await queue(newJobRequest()), false, `${JSON.stringify(drift)} must not pass as identical`);
    assert.equal(rows.length, 1);
  }
});

// ── ADR-156 WI-6: /health publishes the RUNNING build and a degraded signal ──

test('ADR-156 WI-6 /health adds runtime identity and degraded without dropping a field', () => {
  const at = INDEX_SOURCE.indexOf("app.get('/health'");
  assert.notStrictEqual(at, -1, '/health handler not found in index.js');
  const end = INDEX_SOURCE.indexOf('// Optional API key validation', at);
  const handler = INDEX_SOURCE.slice(at, end);

  // The new PUBLIC fields, and the fact they come from the LOADED build.
  for (const added of [
    'runtimeVersion: SERVER_RUNTIME_IDENTITY.runtimeVersion',
    'degraded: maintenance.degraded',
    'degradedReason: maintenance.degradedReason',
  ]) {
    assert.ok(handler.includes(added), `/health must publish ${added}`);
  }
  assert.match(INDEX_SOURCE, /resolveDegraded\(\(\) => requestMaintenanceGate\.readPublicStatus\(\)\)/);
  assert.match(INDEX_SOURCE, /const SERVER_RUNTIME_IDENTITY = readRuntimeIdentity\(APP_ROOT\);/);

  // م-9: /health is unauthenticated. The exact source commit and the gate's
  // internal phase must NOT be readable by a stranger.
  for (const withheld of ['runtimeCommit', 'degradedPhase']) {
    assert.equal(handler.includes(`${withheld}:`), false,
      `${withheld} must not be published on the public /health`);
  }

  // WI-6 is additive: every field consumers already read must still be emitted.
  for (const kept of [
    'serverBuildId:', 'serverLoadedBuildId:', 'serverBuildIdOnDisk,', 'serverPromotedBuildId:',
    'serverCandidateBuildId,', 'clientBuildIdServed,', 'restartRequired,', 'clientReloadRequired,',
    'sourceVersion:', 'installMode,', 'hasPendingActions,', 'updateReady:', 'updaterProtocol:',
    'updaterStrategy:', 'blockedReasonCode:', 'bulkLifecycleActions:',
  ]) {
    assert.ok(handler.includes(kept), `/health must keep publishing ${kept}`);
  }
});
