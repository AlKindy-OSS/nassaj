/**
 * assistant-images security tests (ADR-157) — the read-access boundary of the
 * assistant inline-image surface, driven against a REAL temp-dir filesystem (not
 * a mock) so fs.realpath canonicalization and magic-bytes sniffing are genuinely
 * exercised, plus the HTTP contract over the REAL router (headers, streaming,
 * status codes).
 *
 * Mirrors server/path-guard.test.js (real fixtures, in-tree symlink escape) and
 * server/attachment-security.test.js (pure-function assertions). Arrange -> Act
 * -> Assert throughout.
 *
 * Framework: node:test + node:assert/strict.
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test, { after, before } from 'node:test';
import { mkdtemp, mkdir, writeFile, symlink, rm, realpath, truncate } from 'node:fs/promises';

import express from 'express';

import {
  detectImageType,
  encodeProjectPathForScratchpad,
  deriveAllowedRoots,
  hasDotSegment,
  resolveImageWithinRoots,
  createAssistantImagesRouter,
  MAX_IMAGE_BYTES,
} from './assistant-images.js';

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0, 0, 0, 0, 0]);
const JPEG_SIG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]);
const GIF_SIG = Buffer.from('GIF89a\0\0', 'ascii');
const WEBP_SIG = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0, 0, 0, 0]), Buffer.from('WEBP')]);

// Build an isolated project root + scratchpad (under a dot-prefixed base to prove
// a dot in the ROOT prefix does not trip the below-root dot check) + an outside
// dir with a secret, plus an in-tree symlink escaping to it. Every path is
// realpath()'d so assertions hold even when tmpdir itself is a symlink.
async function makeFixture() {
  const base = await realpath(await mkdtemp(path.join(os.tmpdir(), 'ai-')));
  const outside = path.join(base, 'outside');
  const projectRoot = path.join(base, 'proj');
  // A dot-prefixed segment in the scratchpad base, exactly like the real
  // `.cache` prefix, to guard against a naive absolute-path dot rejection.
  const scratchpad = path.join(base, '.fakecache', 'enc', 'sid', 'scratchpad');
  await mkdir(outside, { recursive: true });
  await mkdir(path.join(projectRoot, 'src'), { recursive: true });
  await mkdir(path.join(projectRoot, '.ssh'), { recursive: true });
  await mkdir(scratchpad, { recursive: true });

  await writeFile(path.join(projectRoot, 'pic.png'), PNG_SIG);
  await writeFile(path.join(projectRoot, 'notimage.png'), Buffer.from('this is plainly not an image'));
  await writeFile(path.join(projectRoot, '.ssh', 'id_rsa'), 'SECRET KEY');
  await writeFile(path.join(scratchpad, 'shot.png'), PNG_SIG);
  await writeFile(path.join(outside, 'secret.png'), PNG_SIG);

  // Oversize but with a valid PNG signature (sparse via truncate — no real 10MB write).
  const big = path.join(projectRoot, 'huge.png');
  await writeFile(big, PNG_SIG);
  await truncate(big, MAX_IMAGE_BYTES + 1);

  // In-tree symlink whose target is OUTSIDE the tree (the classic escape).
  await symlink(outside, path.join(projectRoot, 'escape'));

  const roots = [projectRoot, scratchpad];
  return {
    base, outside, projectRoot, scratchpad, roots,
    cleanup: async () => { await rm(base, { recursive: true, force: true }); },
  };
}

let fx;
before(async () => { fx = await makeFixture(); });
after(async () => { await fx.cleanup(); });

// ---------------------------------------------------------------------------
// 1. Pure helpers
// ---------------------------------------------------------------------------

test('detectImageType — recognises the four allowed signatures and rejects others', () => {
  assert.equal(detectImageType(PNG_SIG), 'image/png');
  assert.equal(detectImageType(JPEG_SIG), 'image/jpeg');
  assert.equal(detectImageType(GIF_SIG), 'image/gif');
  assert.equal(detectImageType(WEBP_SIG), 'image/webp');
  assert.equal(detectImageType(Buffer.from('<svg xmlns=')), null);
  assert.equal(detectImageType(Buffer.from('plain text')), null);
});

test('encodeProjectPathForScratchpad — replaces every / and . with - (dot dir like .git)', () => {
  assert.equal(encodeProjectPathForScratchpad('/home/operator/Project/nassaj-dev'), '-home-operator-Project-nassaj-dev');
  assert.equal(encodeProjectPathForScratchpad('/home/operator/Project/nassaj-dev/.git/x'), '-home-operator-Project-nassaj-dev--git-x');
});

test('deriveAllowedRoots — project root + session scratchpad, never a home root', () => {
  const roots = deriveAllowedRoots({ projectRoot: '/home/operator/Project/p', sessionId: 'sid', scratchpadBase: '/base' });
  assert.deepEqual(roots, ['/home/operator/Project/p', '/base/-home-operator-Project-p/sid/scratchpad']);
  assert.ok(!roots.includes('/home/operator'));
});

test('hasDotSegment — flags a segment below root, exempts the root prefix itself', () => {
  assert.equal(hasDotSegment('/base/.cache/scratchpad', '/base/.cache/scratchpad/img.png'), false);
  assert.equal(hasDotSegment('/proj', '/proj/.ssh/id_rsa'), true);
  assert.equal(hasDotSegment('/proj', '/proj/src/app.png'), false);
});

// ---------------------------------------------------------------------------
// 2. resolveImageWithinRoots — the security pipeline against real files
// ---------------------------------------------------------------------------

test('happy path — a real PNG under the project root resolves with image/png', async () => {
  const r = await resolveImageWithinRoots(fx.roots, path.join(fx.projectRoot, 'pic.png'));
  assert.equal(r.ok, true);
  assert.equal(r.contentType, 'image/png');
});

test('happy path — a PNG in the session scratchpad resolves (dot in base prefix is fine)', async () => {
  const r = await resolveImageWithinRoots(fx.roots, path.join(fx.scratchpad, 'shot.png'));
  assert.equal(r.ok, true);
  assert.equal(r.contentType, 'image/png');
});

test('symlink escape — an in-tree link pointing outside is 403', async () => {
  const r = await resolveImageWithinRoots(fx.roots, path.join(fx.projectRoot, 'escape', 'secret.png'));
  assert.equal(r.ok, false);
  assert.equal(r.status, 403);
});

test('outside the allow-list — a real file outside every root is 403', async () => {
  const r = await resolveImageWithinRoots(fx.roots, path.join(fx.outside, 'secret.png'));
  assert.equal(r.ok, false);
  assert.equal(r.status, 403);
});

test('dot-path rejection — a .ssh path under the project root is 403 (not 404)', async () => {
  const r = await resolveImageWithinRoots(fx.roots, path.join(fx.projectRoot, '.ssh', 'id_rsa'));
  assert.equal(r.ok, false);
  assert.equal(r.status, 403);
});

test('/home/operator/.ssh-style path is rejected (outside roots) — 403', async () => {
  const r = await resolveImageWithinRoots(fx.roots, '/home/operator/.ssh/id_rsa');
  assert.equal(r.ok, false);
  assert.equal(r.status, 403);
});

test('wrong magic bytes — a text file named .png is 415', async () => {
  const r = await resolveImageWithinRoots(fx.roots, path.join(fx.projectRoot, 'notimage.png'));
  assert.equal(r.ok, false);
  assert.equal(r.status, 415);
});

test('size cap — a file over 10 MB is 413 (before the magic sniff)', async () => {
  const r = await resolveImageWithinRoots(fx.roots, path.join(fx.projectRoot, 'huge.png'));
  assert.equal(r.ok, false);
  assert.equal(r.status, 413);
});

test('403 vs 404 distinction — a missing file UNDER a root is 404, outside is 403', async () => {
  const missing = await resolveImageWithinRoots(fx.roots, path.join(fx.projectRoot, 'nope.png'));
  assert.equal(missing.status, 404);
  const outside = await resolveImageWithinRoots(fx.roots, path.join(fx.outside, 'nope.png'));
  assert.equal(outside.status, 403);
});

test('non-absolute path is 400', async () => {
  const r = await resolveImageWithinRoots(fx.roots, 'relative/pic.png');
  assert.equal(r.ok, false);
  assert.equal(r.status, 400);
});

// ---------------------------------------------------------------------------
// 3. HTTP contract over the real router
// ---------------------------------------------------------------------------

/** `?authed=1` stands in for the JWT middleware. */
const fakeAuth = (req, res, next) => {
  if (req.query.authed === '1') {
    req.user = { id: 1, role: 'owner' };
    return next();
  }
  return res.status(401).json({ error: 'Access denied. No token provided.' });
};

let server;
let baseUrl;
before(async () => {
  const app = express();
  app.use('/api/assistant-images', createAssistantImagesRouter({
    authenticateToken: fakeAuth,
    // Owned session "good" yields the fixture roots; anything else is not owned.
    resolveAllowedRoots: (sessionId) => (sessionId === 'good' ? fx.roots : null),
  }));
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});
after(() => { server.close(); });

function url(qs) {
  return `${baseUrl}/api/assistant-images?${qs}`;
}

test('HTTP — unauthenticated caller is 401 even with a valid path', async () => {
  const res = await fetch(url(`path=${encodeURIComponent(path.join(fx.projectRoot, 'pic.png'))}&session=good`));
  assert.equal(res.status, 401);
});

test('HTTP — missing path or session is 400', async () => {
  assert.equal((await fetch(url('session=good&authed=1'))).status, 400);
  assert.equal((await fetch(url(`path=${encodeURIComponent(path.join(fx.projectRoot, 'pic.png'))}&authed=1`))).status, 400);
  assert.equal((await fetch(url('path=relative/x.png&session=good&authed=1'))).status, 400);
});

test('HTTP — an unknown / not-owned session is 403', async () => {
  const res = await fetch(url(`path=${encodeURIComponent(path.join(fx.projectRoot, 'pic.png'))}&session=stranger&authed=1`));
  assert.equal(res.status, 403);
});

test('HTTP — happy path streams the PNG with the hardening headers', async () => {
  const res = await fetch(url(`path=${encodeURIComponent(path.join(fx.projectRoot, 'pic.png'))}&session=good&authed=1`));
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'image/png');
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.match(res.headers.get('content-security-policy') ?? '', /default-src 'none'; sandbox/);
  assert.match(res.headers.get('cache-control') ?? '', /must-revalidate/);
  assert.doesNotMatch(res.headers.get('cache-control') ?? '', /immutable/);
  assert.ok((await res.arrayBuffer()).byteLength > 0);
});

test('HTTP — a text file named .png is 415', async () => {
  const res = await fetch(url(`path=${encodeURIComponent(path.join(fx.projectRoot, 'notimage.png'))}&session=good&authed=1`));
  assert.equal(res.status, 415);
});
