/**
 * T-2116 acceptance: the owner-configurable per-file cap for chat attachments
 * (POST /api/projects/:projectId/upload-attachments).
 *
 * Real pieces: the storage-policy router (server/routes/system.js) on an isolated
 * temp SQLite DB, the same multer disk builder the route uses
 * (temp-upload-multer.js), and the same error mapping (attachment-limits.js).
 * The route glue in index.js is pinned by the drift guard in
 * server/attachment-security.test.js.
 *
 * Owner's terms: default 50 MB; owner sets 120 -> a 100 MB file goes through and
 * a 130 MB file is refused with a clear error; the refused bytes leave nothing in
 * the staging dir; a member reads the limit but cannot change it.
 */

import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import http from 'node:http';
import path from 'node:path';
import test, { after, beforeEach } from 'node:test';

import express from 'express';

process.env.JWT_SECRET = 'attachment-limits-acceptance-secret-0123456789abcdef';
const tmpDir = await mkdtemp(path.join(process.env.NASSAJ_TEST_TMP || tmpdir(), 'attachment-limits-'));
process.env.DATABASE_PATH = path.join(tmpDir, 'db.sqlite');
const stagingDir = path.join(tmpDir, 'staging');
await mkdir(stagingDir);

const { closeConnection, getConnection } = await import('@/modules/database/connection.js');
const { initializeDatabase } = await import('@/modules/database/init-db.js');
const { appConfigDb } = await import('@/modules/database/index.js');
const { default: systemRouter } = await import('../routes/system.js');
const {
  readAttachmentLimit, attachmentUploadErrorResponse, attachmentRequestByteCap,
  checkAttachmentRequestSize, createAttachmentUploadLimiter,
} = await import('./attachment-limits.js');
const { buildTempUploadMulter } = await import('./temp-upload-multer.js');

closeConnection();
await initializeDatabase();

type TestUser = { id: number; username: string; role: string };
const OWNER: TestUser = { id: 1, username: 'owner', role: 'owner' };
const ADMIN: TestUser = { id: 2, username: 'adm', role: 'admin' };
const MEMBER: TestUser = { id: 3, username: 'member', role: 'user' };
const BURST_A: TestUser = { id: 10, username: 'burst-a', role: 'user' };
const BURST_B: TestUser = { id: 11, username: 'burst-b', role: 'user' };
const seedUser = getConnection().prepare('INSERT INTO users (id, username, password_hash, role) VALUES (?, ?, ?, ?)');
for (const u of [OWNER, ADMIN, MEMBER, BURST_A, BURST_B]) seedUser.run(u.id, u.username, 'x', u.role);

const MB = 1024 * 1024;
const MAX_COUNT = 20;
let currentUser: TestUser = OWNER;

const app = express();
app.use(express.json());
app.use('/api/system', (req, _res, next) => {
  (req as express.Request & { user: TestUser }).user = currentUser;
  next();
}, systemRouter);
// Same per-request sequence as the index.js route: per-user rate limit, read the
// cap, refuse an oversize request by its declared length, build the disk multer
// with the cap, map multer errors through the shared helper.
const setUser = (req: express.Request, _res: express.Response, next: express.NextFunction) => {
  (req as express.Request & { user: TestUser }).user = currentUser;
  next();
};
app.post('/upload', setUser, createAttachmentUploadLimiter(), async (req, res) => {
  const limit = readAttachmentLimit();
  const sizeRefusal = checkAttachmentRequestSize(req, limit);
  if (sizeRefusal) {
    res.set('Connection', 'close');
    return res.status(sizeRefusal.status).json(sizeRefusal.body);
  }
  const upload = await buildTempUploadMulter({
    fileFilter: (_req: unknown, _file: unknown, cb: (e: null, ok: boolean) => void) => cb(null, true),
    maxSizeBytes: limit.maxBytes,
    maxCount: MAX_COUNT,
    destination: (_req: unknown, _file: unknown, cb: (e: null, dir: string) => void) => cb(null, stagingDir),
  });
  upload.array('files', MAX_COUNT)(req, res, async (err: unknown) => {
    if (err) {
      const { status, body } = attachmentUploadErrorResponse(err, { maxMb: limit.maxMb, maxCount: MAX_COUNT });
      return res.status(status).json(body);
    }
    const files = (req as express.Request & { files: Array<{ path: string; size: number }> }).files;
    await Promise.all(files.map((f) => rm(f.path, { force: true })));
    return res.json({ ok: true, sizes: files.map((f) => f.size) });
  });
});

const server = app.listen(0);
await new Promise<void>((resolve) => server.once('listening', () => resolve()));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  closeConnection();
  await rm(tmpDir, { recursive: true, force: true });
});

beforeEach(() => {
  getConnection().prepare("DELETE FROM app_config WHERE key = 'chat_attachment_max_mb'").run();
});

let ipCounter = 0;
async function call(method: string, urlPath: string, opts: { user?: TestUser; body?: unknown } = {}) {
  currentUser = opts.user ?? OWNER;
  ipCounter += 1;
  const res = await fetch(base + urlPath, {
    method,
    headers: { 'content-type': 'application/json', 'cf-connecting-ip': `10.9.2.${ipCounter}` },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  return { status: res.status, body: await res.json() as Record<string, any> };
}

async function uploadBytes(size: number, user: TestUser = OWNER) {
  currentUser = user;
  const form = new FormData();
  form.append('files', new Blob([new Uint8Array(size)], { type: 'application/pdf' }), 'report.pdf');
  const res = await fetch(`${base}/upload`, { method: 'POST', body: form });
  return { status: res.status, body: await res.json() as Record<string, unknown> };
}

test('default limit is 50 MB when nothing is stored', async () => {
  assert.deepEqual(readAttachmentLimit(), { maxMb: 50, maxBytes: 50 * MB });
  const read = await call('GET', '/api/system/storage-policy');
  assert.equal(read.body.attachmentMaxMb, 50);
  assert.equal(read.body.attachmentMaxMbIsDefault, true);
  assert.deepEqual(read.body.bounds.attachmentMaxMb, { min: 1, max: 200, fallback: 50 });
});

test('out-of-range or garbage stored values fall back to 50 MB', () => {
  for (const bad of ['0', '201', '2.5', 'abc', '', ' 7']) {
    appConfigDb.set('chat_attachment_max_mb', bad);
    assert.equal(readAttachmentLimit().maxMb, 50, `stored ${JSON.stringify(bad)}`);
  }
});

test('owner sets 120: a 100 MB file is accepted and a 130 MB file is refused clearly', async () => {
  const put = await call('PUT', '/api/system/storage-policy', { body: { attachmentMaxMb: 120 } });
  assert.equal(put.status, 200);
  assert.equal(put.body.attachmentMaxMb, 120);

  const ok = await uploadBytes(100 * MB);
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.body.sizes, [100 * MB]);

  const refused = await uploadBytes(130 * MB);
  assert.equal(refused.status, 413);
  assert.deepEqual(refused.body, {
    error: 'File too large. Maximum size is 120MB per file.',
    code: 'attachment_too_large',
    maxMb: 120,
  });
});

test('a refused oversize upload leaves no partial file in the staging dir', async () => {
  appConfigDb.set('chat_attachment_max_mb', '1');
  const refused = await uploadBytes(2 * MB + 512 * 1024);
  assert.equal(refused.status, 413);
  assert.deepEqual(await readdir(stagingDir), []);
});

test('a change applies to the very next upload without restart', async () => {
  appConfigDb.set('chat_attachment_max_mb', '2');
  assert.equal((await uploadBytes(MB + 1)).status, 200);
  appConfigDb.set('chat_attachment_max_mb', '1');
  const refused = await uploadBytes(MB + 1);
  assert.equal(refused.status, 413);
  assert.equal(refused.body.maxMb, 1);
});

test('a member and an admin read the limit but cannot change it', async () => {
  appConfigDb.set('chat_attachment_max_mb', '120');
  for (const user of [MEMBER, ADMIN]) {
    const read = await call('GET', '/api/system/attachment-limit', { user });
    assert.equal(read.status, 200, `${user.role} reads the limit`);
    assert.deepEqual(read.body, { attachmentMaxMb: 120 });
    const put = await call('PUT', '/api/system/storage-policy', { user, body: { attachmentMaxMb: 10 } });
    assert.equal(put.status, 403, `${user.role} cannot change it`);
  }
  assert.equal(appConfigDb.get('chat_attachment_max_mb'), '120');
});

test('the member-readable limit endpoint reports the default when unset', async () => {
  const read = await call('GET', '/api/system/attachment-limit', { user: MEMBER });
  assert.deepEqual(read.body, { attachmentMaxMb: 50 });
});

test('invalid values are rejected without writing (integer MB 1..200 only)', async () => {
  for (const bad of [0, 201, 1.5, -5, 'abc', '120', true, [120], null, {}]) {
    const put = await call('PUT', '/api/system/storage-policy', { body: { attachmentMaxMb: bad } });
    assert.equal(put.status, 400, `value ${JSON.stringify(bad)} must be rejected`);
    assert.equal(put.body.error, 'attachmentMaxMb must be an integer between 1 and 200');
  }
  assert.equal(appConfigDb.get('chat_attachment_max_mb'), null);
});

test('the boundaries 1 and 200 are accepted', async () => {
  for (const edge of [1, 200]) {
    const put = await call('PUT', '/api/system/storage-policy', { body: { attachmentMaxMb: edge } });
    assert.equal(put.status, 200);
    assert.equal(readAttachmentLimit().maxMb, edge);
  }
});

test('error mapping: count overflow and filter errors stay 400', () => {
  const count = attachmentUploadErrorResponse({ code: 'LIMIT_FILE_COUNT' }, { maxMb: 50, maxCount: 20 });
  assert.deepEqual(count, { status: 400, body: { error: 'Too many files. Maximum is 20 files.' } });
  const filter = attachmentUploadErrorResponse(new Error('File type .exe is not allowed.'), { maxMb: 50, maxCount: 20 });
  assert.deepEqual(filter, { status: 400, body: { error: 'File type .exe is not allowed.' } });
});

/** Sends only headers (no body bytes), so a refusal must come before any read. */
function rawUpload(headers: Record<string, string>, user: TestUser) {
  currentUser = user;
  return new Promise<{ status: number; body: Record<string, unknown> }>((resolve, reject) => {
    const req = http.request(`${base}/upload`, {
      method: 'POST',
      headers: { 'content-type': 'multipart/form-data; boundary=x', ...headers },
    }, (res) => {
      let text = '';
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(text) }));
    });
    req.on('error', reject);
    req.flushHeaders();
  });
}

test('settings and the upload path read a stored value with one parser', async () => {
  for (const odd of ['1e2', '0x40', '100.0', '080']) {
    appConfigDb.set('chat_attachment_max_mb', odd);
    const read = await call('GET', '/api/system/storage-policy');
    assert.equal(read.body.attachmentMaxMb, readAttachmentLimit().maxMb, `stored ${odd}`);
    assert.equal(read.body.attachmentMaxMb, 50, `stored ${odd} is not a canonical integer`);
    assert.equal(read.body.attachmentMaxMbIsDefault, true);
  }
});

test('total bytes per request: twice the file cap, never above a 256 MB ceiling, +1 MB framing', () => {
  assert.equal(attachmentRequestByteCap(50 * MB), 101 * MB);
  assert.equal(attachmentRequestByteCap(120 * MB), 241 * MB);
  assert.equal(attachmentRequestByteCap(200 * MB), 257 * MB);
});

test('a request declaring more than the total cap is refused before any byte is read', async () => {
  appConfigDb.set('chat_attachment_max_mb', '1');
  const refused = await rawUpload({ 'content-length': String(10 * 1024 * MB) }, MEMBER);
  assert.equal(refused.status, 413);
  assert.deepEqual(refused.body, {
    error: 'Upload too large. The attached files together may not exceed 3MB.',
    code: 'attachment_request_too_large',
    maxRequestMb: 3,
  });
  assert.deepEqual(await readdir(stagingDir), []);
});

test('a request without a declared length (chunked) is refused with 411', async () => {
  const refused = await rawUpload({ 'transfer-encoding': 'chunked' }, MEMBER);
  assert.equal(refused.status, 411);
  assert.equal(refused.body.code, 'attachment_length_required');
});

test('files that each fit but together exceed the total cap are refused', async () => {
  appConfigDb.set('chat_attachment_max_mb', '1');
  // Four files just under 1 MB each: every one fits, the request (~4 MB) does not.
  const form = new FormData();
  for (let i = 0; i < 4; i += 1) {
    form.append('files', new Blob([new Uint8Array(MB - 1024)], { type: 'application/pdf' }), `p${i}.pdf`);
  }
  const encoded = new Response(form);
  const length = (await encoded.arrayBuffer()).byteLength;
  assert.ok(length > 3 * MB && length < 5 * MB);
  const refused = await rawUpload({ 'content-length': String(length) }, MEMBER);
  assert.equal(refused.status, 413);
  assert.equal(refused.body.code, 'attachment_request_too_large');
});

test('uploads are rate limited per user: the 11th in a minute is 429, another user is not', async () => {
  appConfigDb.set('chat_attachment_max_mb', '1');
  for (let i = 0; i < 10; i += 1) {
    assert.equal((await uploadBytes(10, BURST_A)).status, 200, `upload ${i + 1}`);
  }
  const limited = await uploadBytes(10, BURST_A);
  assert.equal(limited.status, 429);
  assert.equal(limited.body.code, 'attachment_rate_limited');
  assert.equal((await uploadBytes(10, BURST_B)).status, 200);
});
