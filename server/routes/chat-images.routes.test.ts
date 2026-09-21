/**
 * chat-images.routes.test.ts — the HTTP contract of the stored-attachment
 * surface, driven over the REAL router and a REAL file on disk.
 *
 * What it pins (qa-critic condition 7 on B-430): the route is behind the auth
 * gate, an unknown or malformed path is a 404 that leaks nothing, traversal
 * attempts never reach the filesystem, and the hardening headers actually ship
 * on the response — the headers are the last line of defence for a stored SVG,
 * so "we set them" has to be an assertion, not a comment.
 *
 * Framework: node:test + node:assert/strict via tsx.
 */
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test, { after, before } from 'node:test';
import type { AddressInfo } from 'node:net';

import express from 'express';

const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'chat-images-routes-test-'));
const ORIGINAL_DB = process.env.DATABASE_PATH;
process.env.DATABASE_PATH = path.join(sandbox, 'db.sqlite');

const { createChatImagesRouter } = await import('./chat-images.js');
const { saveChatImages } = await import('../services/chat-image-store.js');

const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

/** Stands in for the real JWT middleware: `?authed=1` is an authenticated call. */
const fakeAuth: express.RequestHandler = (req, res, next) => {
  if (req.query.authed === '1') {
    (req as unknown as { user: unknown }).user = { id: 1, role: 'owner' };
    return next();
  }
  res.status(401).json({ error: 'Access denied. No token provided.' });
};

let server: http.Server;
let baseUrl: string;
let bucket: string;

before(async () => {
  const app = express();
  app.use('/api/chat-images', createChatImagesRouter({ authenticateToken: fakeAuth }));
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const saved = await saveChatImages([{ data: `data:image/png;base64,${PNG_BASE64}` }]);
  bucket = saved.bucket!;
});

after(async () => {
  server.close();
  if (ORIGINAL_DB === undefined) delete process.env.DATABASE_PATH;
  else process.env.DATABASE_PATH = ORIGINAL_DB;
  await fs.rm(sandbox, { recursive: true, force: true });
});

test('serves a stored image to an authenticated caller', async () => {
  const res = await fetch(`${baseUrl}/api/chat-images/${bucket}/image_0.png?authed=1`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'image/png');
  assert.ok((await res.arrayBuffer()).byteLength > 0);
});

test('ships the hardening headers on every served byte', async () => {
  const res = await fetch(`${baseUrl}/api/chat-images/${bucket}/image_0.png?authed=1`);
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.match(res.headers.get('content-security-policy') ?? '', /sandbox/);
  // NOT immutable — retention will delete these files (see router comment).
  assert.match(res.headers.get('cache-control') ?? '', /must-revalidate/);
  assert.doesNotMatch(res.headers.get('cache-control') ?? '', /immutable/);
});

test('refuses an unauthenticated caller even with a valid path', async () => {
  const res = await fetch(`${baseUrl}/api/chat-images/${bucket}/image_0.png`);
  assert.equal(res.status, 401);
});

test('a missing file is a 404, not a 500', async () => {
  const res = await fetch(`${baseUrl}/api/chat-images/${bucket}/image_9.png?authed=1`);
  assert.equal(res.status, 404);
});

test('an unknown bucket is a 404 that reveals nothing', async () => {
  const res = await fetch(`${baseUrl}/api/chat-images/${'b'.repeat(32)}/image_0.png?authed=1`);
  assert.equal(res.status, 404);
  assert.deepEqual(await res.json(), { error: 'Image not found' });
});

test('rejects traversal, odd buckets and unlisted extensions', async () => {
  const targets = [
    `/api/chat-images/${bucket}/..%2f..%2fdb.sqlite`,
    `/api/chat-images/${bucket}/db.sqlite`,
    `/api/chat-images/${bucket}/image_0.sh`,
    '/api/chat-images/NOTHEX/image_0.png',
    `/api/chat-images/${bucket}/image_0.png%00.txt`,
  ];
  for (const target of targets) {
    const res = await fetch(`${baseUrl}${target}?authed=1`);
    assert.ok(res.status === 404 || res.status === 400, `${target} returned ${res.status}`);
  }
});
