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
import os from 'node:os';
import path from 'node:path';
import test, { after, before } from 'node:test';
import { mkdtemp, mkdir, writeFile, symlink, rm, realpath, truncate } from 'node:fs/promises';

import express from 'express';

import {
  detectImageType,
  encodeProjectPathForScratchpad,
  deriveAllowedRoots,
  deriveOverlayWorkspace,
  ASSISTANT_IMAGES_DIRNAME,
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

  // B-1082 new roots: a well-known per-session drop folder, plus a DIFFERENT
  // session's drop folder that must remain unreachable, and a symlink inside the
  // drop folder escaping the tree.
  const tmpBase = path.join(base, 'tmp');
  const sid = 'sid';
  const dropDir = path.join(tmpBase, 'nassaj-assistant-images', sid);
  const otherSessionDrop = path.join(tmpBase, 'nassaj-assistant-images', 'other-sid');
  await mkdir(dropDir, { recursive: true });
  await mkdir(otherSessionDrop, { recursive: true });
  await writeFile(path.join(dropDir, 'drop.png'), PNG_SIG);
  await writeFile(path.join(otherSessionDrop, 'peek.png'), PNG_SIG);
  await symlink(outside, path.join(dropDir, 'escape'));

  const roots = [projectRoot, scratchpad, dropDir];
  return {
    base, outside, projectRoot, scratchpad, tmpBase, dropDir, otherSessionDrop, roots,
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
  const roots = deriveAllowedRoots({
    projectRoot: '/home/operator/Project/p',
    sessionId: 'sid',
    scratchpadBase: '/base',
    tmpBases: [],
  });
  assert.deepEqual(roots.map(root => root.path), ['/home/operator/Project/p', '/base/-home-operator-Project-p/sid/scratchpad']);
  assert.ok(!roots.includes('/home/operator'));
  assert.ok(!roots.includes('/home/operator/Project'));
});

test('deriveAllowedRoots — B-1082: every scratchpad base × encoding, overlay tree, and the drop folder', () => {
  const projectRoot = '/home/operator/Project/p';
  const overlayWorkspace = `${projectRoot}/.git/nassaj-session-overlays/instances/7f87b639-7adb-4c1b-97a1-590fc7c9baee/workspace`;
  const overlayEncoding = encodeProjectPathForScratchpad(overlayWorkspace);
  const roots = deriveAllowedRoots({
    projectRoot,
    sessionId: 'sid',
    overlayWorkspace,
    encodings: [overlayEncoding],
    scratchpadBases: ['/home/operator/.cache/tmp/claude-1000', '/var/tmp/claude-1000'],
    tmpBases: ['/var/tmp', '/home/operator/.cache/tmp'],
  });
  // 1 project + 1 overlay + (2 bases × 2 encodings) + 2 drop folders = 8.
  const paths = roots.map(root => root.path);
  assert.equal(roots.length, 8);
  assert.equal(paths[0], projectRoot);
  assert.equal(paths[1], overlayWorkspace);
  // Both bases and both encodings are present.
  assert.ok(roots.map(root => root.path).includes(`/var/tmp/claude-1000/-home-operator-Project-p/sid/scratchpad`));
  assert.ok(roots.map(root => root.path).includes(`/home/operator/.cache/tmp/claude-1000/${overlayEncoding}/sid/scratchpad`));
  // The announced drop folder under each tmp base, scoped to the session id.
  assert.ok(roots.map(root => root.path).includes(`/var/tmp/${ASSISTANT_IMAGES_DIRNAME}/sid`));
  assert.ok(roots.map(root => root.path).includes(`/home/operator/.cache/tmp/${ASSISTANT_IMAGES_DIRNAME}/sid`));
  // Never a bare tmp root or a home root.
  assert.ok(!roots.includes('/var/tmp'));
  assert.ok(!roots.includes('/home/operator/.cache/tmp'));
  assert.ok(!roots.includes('/home/operator'));
  // Every ephemeral root ends with the session id (isolation invariant).
  for (const r of roots.slice(2)) {
    assert.ok(r.path.split(path.sep).includes('sid'), `root missing session id: ${r}`);
  }
});

test('deriveAllowedRoots — missing session identity grants no roots', () => {
  const roots = deriveAllowedRoots({
    projectRoot: '/home/operator/Project/p',
    sessionId: '',
    overlayWorkspace: '/home/operator/Project/p/.git/nassaj-session-overlays/instances/x/workspace',
    scratchpadBases: ['/base'],
    tmpBases: ['/var/tmp'],
  });
  assert.deepEqual(roots, []);
});

test('deriveOverlayWorkspace — reconstructs the overlay tree loss-free, else null', () => {
  const projectRoot = '/home/operator/Project/nassaj-dev';
  const workspace = `${projectRoot}/.git/nassaj-session-overlays/instances/7f87b639-7adb-4c1b-97a1-590fc7c9baee/workspace`;
  const enc = encodeProjectPathForScratchpad(workspace);
  assert.equal(deriveOverlayWorkspace(projectRoot, enc), workspace);
  // A plain (non-overlay) project-path encoding is not an overlay cwd.
  assert.equal(deriveOverlayWorkspace(projectRoot, encodeProjectPathForScratchpad(projectRoot)), null);
  // Junk / another project's encoding does not resolve.
  assert.equal(deriveOverlayWorkspace(projectRoot, 'totally-unrelated'), null);
  assert.equal(deriveOverlayWorkspace(projectRoot, null), null);
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

test('B-1082 drop folder — a PNG in the per-session drop folder resolves', async () => {
  const r = await resolveImageWithinRoots(fx.roots, path.join(fx.dropDir, 'drop.png'));
  assert.equal(r.ok, true);
  assert.equal(r.contentType, 'image/png');
});

test('B-1082 isolation — another session\'s drop folder is not reachable (403)', async () => {
  const r = await resolveImageWithinRoots(fx.roots, path.join(fx.otherSessionDrop, 'peek.png'));
  assert.equal(r.ok, false);
  assert.equal(r.status, 403);
});

test('B-1082 isolation — sibling traversal from the drop folder to another session is 403', async () => {
  const sneaky = path.join(fx.dropDir, '..', 'other-sid', 'peek.png');
  const r = await resolveImageWithinRoots(fx.roots, sneaky);
  assert.equal(r.ok, false);
  assert.equal(r.status, 403);
});

test('B-1082 symlink escape from the drop folder is 403', async () => {
  const r = await resolveImageWithinRoots(fx.roots, path.join(fx.dropDir, 'escape', 'secret.png'));
  assert.equal(r.ok, false);
  assert.equal(r.status, 403);
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
    req.assertCurrentIdentity = () => true;
    return next();
  }
  if (req.query.authed === 'platform') {
    req.user = { id: 1, role: 'owner', authenticationKind: 'platform_unverified' };
    return next();
  }
  return res.status(401).json({ error: 'Access denied. No token provided.' });
};

let server;
let baseUrl;
let rootResolutionCalls = 0;
before(async () => {
  const app = express();
  app.use('/api/assistant-images', createAssistantImagesRouter({
    authenticateToken: fakeAuth,
    // Owned session "good" yields the fixture roots; anything else is not owned.
    resolveAllowedRoots: (sessionId) => {
      rootResolutionCalls += 1;
      if (sessionId === 'good') return { roots: fx.roots, isCurrent: () => true };
      if (sessionId === 'stale-before-stream') {
        let checks = 0;
        return { roots: fx.roots, isCurrent: () => ++checks < 2 };
      }
      if (sessionId === 'stale-at-chunk') {
        let checks = 0;
        return { roots: fx.roots, isCurrent: () => ++checks < 4 };
      }
      return null;
    },
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

test('HTTP — a principal without the exact identity fence performs zero protected reads', async () => {
  const before = rootResolutionCalls;
  const target = encodeURIComponent(path.join(fx.projectRoot, 'pic.png'));
  const res = await fetch(url(`path=${target}&session=good&authed=platform`));
  assert.equal(res.status, 409);
  assert.equal((await res.json()).code, 'identity_changed');
  assert.equal(rootResolutionCalls, before);
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

test('HTTP — project revocation after file resolution returns a non-disclosing 409', async () => {
  const target = encodeURIComponent(path.join(fx.projectRoot, 'pic.png'));
  const res = await fetch(url(`path=${target}&session=stale-before-stream&authed=1`));
  assert.equal(res.status, 409);
  assert.equal((await res.json()).code, 'project_access_changed');
});

test('HTTP — project revocation at the chunk boundary releases no image body', async () => {
  const target = encodeURIComponent(path.join(fx.projectRoot, 'pic.png'));
  let bodyBytes = 0;
  try {
    const res = await fetch(url(`path=${target}&session=stale-at-chunk&authed=1`));
    const body = await res.arrayBuffer();
    bodyBytes = body.byteLength;
  } catch {
    // Destroying a response before its first guarded chunk may reject fetch.
  }
  assert.equal(bodyBytes, 0);
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


test('typed drop roots reject symlinked session roots and writable directories', async () => {
  const typed = deriveAllowedRoots({ projectRoot: fx.projectRoot, sessionId: 'sid',
    scratchpadBases: [], tmpBases: [fx.tmpBase] });
  assert.equal((await resolveImageWithinRoots(typed, path.join(fx.dropDir, 'drop.png'))).ok, true);
  const linked = path.join(fx.tmpBase, ASSISTANT_IMAGES_DIRNAME, 'linked');
  await symlink(fx.otherSessionDrop, linked);
  const other = deriveAllowedRoots({ projectRoot: fx.projectRoot, sessionId: 'linked',
    scratchpadBases: [], tmpBases: [fx.tmpBase] });
  assert.equal((await resolveImageWithinRoots(other, path.join(linked, 'peek.png'))).status, 403);
  const { chmod } = await import('node:fs/promises');
  await chmod(fx.dropDir, 0o777);
  try { assert.equal((await resolveImageWithinRoots(typed, path.join(fx.dropDir, 'drop.png'))).status, 403); }
  finally { await chmod(fx.dropDir, 0o755); }
});

test('stored path components and nonexact overlay metadata cannot grant roots', () => {
  for (const sessionId of ['../sid', 'x/y', 'x\\y', '%2e%2e', '.', '']) {
    assert.deepEqual(deriveAllowedRoots({ projectRoot: fx.projectRoot, sessionId }), []);
  }
  const roots = deriveAllowedRoots({ projectRoot: fx.projectRoot, sessionId: 'sid',
    overlayWorkspace: '/home', encodings: ['../../escape'], scratchpadBases: ['/var/tmp/base'], tmpBases: [] });
  assert.equal(roots.length, 2);
  assert.equal(roots.some(root => root.path === '/home'), false);
});

test('the exact overlay root beats project dot refusal and keeps sibling overlays hidden', async () => {
  const id = '7f87b639-7adb-4c1b-97a1-590fc7c9baee';
  const overlay = path.join(fx.projectRoot, '.git/nassaj-session-overlays/instances', id, 'workspace');
  await mkdir(overlay, { recursive: true });
  await writeFile(path.join(overlay, 'preview.png'), PNG_SIG);
  const roots = deriveAllowedRoots({ projectRoot: fx.projectRoot, sessionId: 'sid', overlayWorkspace: overlay,
    encodings: [encodeProjectPathForScratchpad(overlay)], scratchpadBases: [], tmpBases: [] });
  assert.equal((await resolveImageWithinRoots(roots, path.join(overlay, 'preview.png'))).ok, true);
  assert.equal((await resolveImageWithinRoots(roots, path.join(fx.projectRoot, '.git', 'secret.png'))).status, 403);
  await writeFile(path.join(overlay, '.hidden.png'), PNG_SIG);
  assert.equal((await resolveImageWithinRoots(roots, path.join(overlay, '.hidden.png'))).status, 403);
});

test('retained image descriptor rejects replacement and closes exactly once', async () => {
  const { rename } = await import('node:fs/promises');
  const file = path.join(fx.projectRoot, 'pinned.png');
  await writeFile(file, PNG_SIG);
  const opened = await resolveImageWithinRoots(fx.roots, file, { retainHandle: true });
  assert.equal(opened.ok, true);
  const originalFd = opened.handle.fd;
  await rename(file, `${file}.old`);
  await writeFile(file, Buffer.concat([PNG_SIG, Buffer.from('replacement')]));
  try {
    await assert.rejects(() => opened.verify());
    const bytes = Buffer.alloc(PNG_SIG.length);
    await opened.handle.read(bytes, 0, bytes.length, 0);
    assert.deepEqual(bytes, PNG_SIG);
  } finally { await opened.close(); await opened.close(); }
  assert.notEqual(originalFd, -1);
  assert.equal(opened.handle.fd, -1);
});

test('HTTP decodes paths only once and refuses literal traversal before normalization', async () => {
  const escaped = `${fx.dropDir}/../other-sid/peek.png`;
  assert.equal((await fetch(url(`authed=1&session=good&path=${encodeURIComponent(escaped)}`))).status, 403);
  assert.equal((await fetch(url(`authed=1&session=good&path=${encodeURIComponent(encodeURIComponent(escaped))}`))).status, 400);
});


test('in-root symlinks preserve existing image behavior', async () => {
  const link = path.join(fx.projectRoot, 'inside.png');
  await symlink(path.join(fx.projectRoot, 'pic.png'), link);
  assert.equal((await resolveImageWithinRoots(fx.roots, link)).ok, true);
});

test('parent inode replacement is denied and the pinned stream cannot read replacement content', async () => {
  const { rename } = await import('node:fs/promises');
  const dir = path.join(fx.projectRoot, 'race-directory');
  await mkdir(dir);
  const original = Buffer.concat([PNG_SIG, Buffer.from('original')]);
  await writeFile(path.join(dir, 'image.png'), original);
  const result = await resolveImageWithinRoots(fx.roots, path.join(dir, 'image.png'), { retainHandle: true });
  assert.equal(result.ok, true);
  await rename(dir, `${dir}-old`);
  await mkdir(dir);
  await writeFile(path.join(dir, 'image.png'), Buffer.concat([PNG_SIG, Buffer.from('replacement')]));
  try {
    await assert.rejects(() => result.verify());
    const chunks = [];
    for await (const chunk of result.handle.createReadStream({ start: 0, autoClose: false })) chunks.push(chunk);
    assert.deepEqual(Buffer.concat(chunks), original);
  } finally { await result.close(); }
  assert.equal(result.handle.fd, -1);
});

test('denials release every opened descriptor and create no directories', async () => {
  const { readdir } = await import('node:fs/promises');
  const before = (await readdir('/proc/self/fd')).length;
  const absent = path.join(fx.tmpBase, 'absent-base');
  const roots = deriveAllowedRoots({ projectRoot: fx.projectRoot, sessionId: 'sid', scratchpadBases: [], tmpBases: [absent] });
  for (let i = 0; i < 8; i++) {
    assert.equal((await resolveImageWithinRoots(roots, path.join(absent, ASSISTANT_IMAGES_DIRNAME, 'sid', 'x.png'))).status, 404);
    assert.equal((await resolveImageWithinRoots(fx.roots, path.join(fx.projectRoot, 'notimage.png'))).status, 415);
  }
  assert.equal((await readdir('/proc/self/fd')).length, before);
  await assert.rejects(() => readdir(absent), { code: 'ENOENT' });
});
