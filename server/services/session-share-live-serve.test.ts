/**
 * ADR-205 stage 4: attachment loading for live read links against real files
 * in a /var/tmp scratch tree: contained descriptor reads (O_NOFOLLOW, fstat,
 * containment through the fd, size cap, secret paths), the existing
 * validators per source, raster-only images (no SVG), policy (a) for files,
 * and opaque refs.
 */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test, { after } from 'node:test';

import { getChatImageRoot } from './chat-image-store.js';
import { mintAttachmentRef, verifyAttachmentRef } from './session-share-live-keys.js';
import { ATTACHMENT_MAX_BYTES, isTextLike, readContainedFile } from './session-share-live-files.js';
import { isServableTextFile, loadAttachment, type AttachmentContext } from './session-share-live-serve.js';

const PNG = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.from('fixture-png-body')]);
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
const SECRET = ['gh', 'p_', 'Ab1'.repeat(12)].join('');
const SCRATCH = fs.realpathSync(fs.mkdtempSync(path.join('/var/tmp', 'share-live-serve-')));
const PROJECT = path.join(SCRATCH, 'project');
const INBOX = path.join(PROJECT, '.nassaj-uploads', 'inbox');
const OUTSIDE = path.join(SCRATCH, 'outside');
const BUCKET = '0123456789abcdef0123456789abcdef';
const ctx: AttachmentContext = { sessionId: 'session-serve-1', projectRoot: PROJECT, home: '/home/operator' };

fs.mkdirSync(INBOX, { recursive: true });
fs.mkdirSync(OUTSIDE, { recursive: true });
fs.mkdirSync(path.join(PROJECT, 'out'), { recursive: true });
const chatBucket = path.join(getChatImageRoot(), BUCKET);
fs.mkdirSync(chatBucket, { recursive: true });
after(() => {
  fs.rmSync(SCRATCH, { recursive: true, force: true });
  fs.rmSync(chatBucket, { recursive: true, force: true });
});

const write = (file: string, bytes: Buffer | string) => { fs.writeFileSync(file, bytes); return file; };

test('contained read: a regular file inside the root is read through its descriptor', () => {
  const file = write(path.join(INBOX, 'plain.txt'), 'hello');
  const read = readContainedFile(fs.realpathSync(INBOX), file);
  assert.deepEqual(read, { ok: true, bytes: Buffer.from('hello'), size: 5, complete: true });
  const prefix = readContainedFile(fs.realpathSync(INBOX), file, { readBytes: 2 });
  assert.ok(prefix.ok && prefix.bytes.toString() === 'he' && !prefix.complete);
});

test('L1: a hardlink inside the root to a file outside it is refused; the normal file is still served', () => {
  const root = fs.realpathSync(INBOX);
  const target = write(path.join(OUTSIDE, 'creds.txt'), 'outside-credentials');
  const alias = path.join(INBOX, 'hardlink.txt');
  fs.linkSync(target, alias);
  assert.deepEqual(readContainedFile(root, alias), { ok: false, reason: 'gone' });
  const plain = write(path.join(INBOX, 'still-plain.txt'), 'ok');
  assert.ok(readContainedFile(root, plain).ok);
});

test('L1: symlink leaf (O_NOFOLLOW), symlinked directory leading out, non-regular, oversize and secret are refused', () => {
  const root = fs.realpathSync(INBOX);
  const target = write(path.join(OUTSIDE, 'target.txt'), 'outside');
  fs.symlinkSync(target, path.join(INBOX, 'leaf-link.txt'));
  fs.symlinkSync(path.join(INBOX, 'plain.txt'), path.join(INBOX, 'inner-link.txt'));
  fs.symlinkSync(OUTSIDE, path.join(INBOX, 'dir-link'));
  fs.mkdirSync(path.join(INBOX, 'a-directory'));
  write(path.join(INBOX, 'big.txt'), Buffer.alloc(ATTACHMENT_MAX_BYTES + 1, 0x61));
  write(path.join(INBOX, '.env'), `TOKEN=${SECRET}`);
  assert.deepEqual(readContainedFile(root, path.join(INBOX, 'leaf-link.txt')), { ok: false, reason: 'gone' });
  assert.deepEqual(readContainedFile(root, path.join(INBOX, 'inner-link.txt')), { ok: false, reason: 'gone' },
    'O_NOFOLLOW refuses even a link that stays inside');
  assert.deepEqual(readContainedFile(root, path.join(INBOX, 'dir-link', 'target.txt')), { ok: false, reason: 'gone' },
    'a symlinked directory in the chain is judged by where the descriptor really is');
  assert.deepEqual(readContainedFile(root, path.join(INBOX, 'a-directory')), { ok: false, reason: 'gone' });
  assert.deepEqual(readContainedFile(root, path.join(INBOX, 'big.txt')), { ok: false, reason: 'too_large' });
  assert.deepEqual(readContainedFile(root, path.join(INBOX, '.env')), { ok: false, reason: 'secret' });
  assert.deepEqual(readContainedFile(root, path.join(INBOX, 'missing.txt')), { ok: false, reason: 'gone' });
  assert.deepEqual(readContainedFile(root, 'relative.txt'), { ok: false, reason: 'gone' });
});

test('text-like means no NUL and valid UTF-8; a prefix may end inside a multi-byte sequence', () => {
  assert.equal(isTextLike(Buffer.from('مرحبا hello'), true), true);
  assert.equal(isTextLike(Buffer.from([0x61, 0x00, 0x62]), true), false);
  assert.equal(isTextLike(Buffer.from([0xff, 0xfe, 0x61]), true), false);
  const cut = Buffer.from('م', 'utf8').subarray(0, 1);
  assert.equal(isTextLike(cut, false), true);
  assert.equal(isTextLike(cut, true), false);
});

test('chat-image store: raster served by magic bytes; SVG, missing, oversize and malformed names are not', async () => {
  write(path.join(chatBucket, 'image_0.png'), PNG);
  write(path.join(chatBucket, 'image_1.svg'), SVG);
  write(path.join(chatBucket, 'image_2.png'), SVG);
  write(path.join(chatBucket, 'image_3.png'), Buffer.concat([PNG, Buffer.alloc(ATTACHMENT_MAX_BYTES)]));
  const load = (name: string, bucket = BUCKET) => loadAttachment({ source: 'chat-image', bucket, name }, ctx);
  assert.deepEqual(await load('image_0.png'), { ok: true, kind: 'image', contentType: 'image/png', bytes: PNG });
  assert.deepEqual(await load('image_1.svg'), { ok: false, reason: 'gone' }, 'SVG is never served (B-158)');
  assert.deepEqual(await load('image_2.png'), { ok: false, reason: 'gone' }, 'SVG bytes behind a raster name');
  assert.deepEqual(await load('image_3.png'), { ok: false, reason: 'too_large' });
  assert.deepEqual(await load('image_9.png'), { ok: false, reason: 'gone' });
  assert.deepEqual(await load('../image_0.png'), { ok: false, reason: 'gone' });
  assert.deepEqual(await load('image_0.png', '../../etc'), { ok: false, reason: 'gone' });
});

test('N2 inbox files: text is served redacted under a sanitized name; binary, NUL and escapes are withheld', async () => {
  write(path.join(INBOX, 'notes‮.txt'), `deploy notes\napi token ${SECRET}\npath ${PROJECT}/src/app.ts\n`);
  write(path.join(INBOX, 'report.pdf'), Buffer.from('%PDF-1.7\nÿþ binary \u0000 stream'));
  write(path.join(INBOX, 'nul.txt'), Buffer.from([0x61, 0x00]));
  const load = (relative: string) => loadAttachment({ source: 'inbox-file', path: relative }, ctx);
  const served = await load('.nassaj-uploads/inbox/notes‮.txt');
  assert.ok(served.ok && served.kind === 'file');
  if (served.ok && served.kind === 'file') {
    assert.equal(served.name, 'notes.txt', 'bidi override stripped from the name');
    const text = served.bytes.toString('utf8');
    assert.ok(text.includes('deploy notes'));
    assert.ok(!text.includes(SECRET), 'the known secret pattern is redacted in the served bytes');
    assert.ok(!text.includes(PROJECT), 'the project path is redacted');
  }
  for (const relative of ['.nassaj-uploads/inbox/report.pdf', '.nassaj-uploads/inbox/nul.txt', '.nassaj-uploads/inbox/leaf-link.txt',
    '.nassaj-uploads/inbox/../../../outside/target.txt', '.nassaj-uploads/inbox/.env', '.nassaj-uploads/inbox/gone.txt']) {
    assert.deepEqual(await load(relative), { ok: false, reason: 'gone' }, relative);
  }
  assert.deepEqual(await loadAttachment({ source: 'inbox-file', path: '.nassaj-uploads/inbox/notes‮.txt' },
    { ...ctx, projectRoot: null }), { ok: false, reason: 'gone' });
});

test('N2 projection-time check: only an existing, contained, text-like inbox file is servable', () => {
  assert.equal(isServableTextFile(PROJECT, { source: 'inbox-file', path: '.nassaj-uploads/inbox/plain.txt' }), true);
  for (const relative of ['report.pdf', 'nul.txt', 'leaf-link.txt', 'gone.txt', '.env', 'big.txt']) {
    assert.equal(isServableTextFile(PROJECT, { source: 'inbox-file', path: `.nassaj-uploads/inbox/${relative}` }), false, relative);
  }
  assert.equal(isServableTextFile(null, { source: 'inbox-file', path: '.nassaj-uploads/inbox/plain.txt' }), false);
  assert.equal(isServableTextFile(PROJECT, { source: 'chat-image', bucket: BUCKET, name: 'image_0.png' }), false);
});

test('ADR-157 assistant images: served through the session roots; SVG, hidden segments and escapes are not', async () => {
  write(path.join(PROJECT, 'out', 'chart.png'), PNG);
  write(path.join(PROJECT, 'out', 'chart.svg'), SVG);
  fs.mkdirSync(path.join(PROJECT, '.hidden'), { recursive: true });
  write(path.join(PROJECT, '.hidden', 'x.png'), PNG);
  fs.symlinkSync(path.join(OUTSIDE, 'target.txt'), path.join(PROJECT, 'out', 'escape.png'));
  const load = (file: string) => loadAttachment({ source: 'assistant-image', path: file }, ctx);
  assert.deepEqual(await load(path.join(PROJECT, 'out', 'chart.png')), { ok: true, kind: 'image', contentType: 'image/png', bytes: PNG });
  for (const file of [path.join(PROJECT, 'out', 'chart.svg'), path.join(PROJECT, '.hidden', 'x.png'),
    path.join(PROJECT, 'out', 'escape.png'), path.join(OUTSIDE, 'target.txt'), `${PROJECT}/out/../out/chart.png`]) {
    assert.deepEqual(await load(file), { ok: false, reason: 'gone' }, file);
  }
  assert.deepEqual(await loadAttachment({ source: 'assistant-image', path: path.join(PROJECT, 'out', 'chart.png') },
    { ...ctx, sessionId: 'bad/session' }), { ok: false, reason: 'gone' });
});

test('embedded images: the declared raster type must match the bytes', async () => {
  const uri = (type: string, bytes: Buffer) => `data:image/${type};base64,${bytes.toString('base64')}`;
  assert.deepEqual(await loadAttachment({ source: 'embedded-image', dataUri: uri('png', PNG) }, ctx),
    { ok: true, kind: 'image', contentType: 'image/png', bytes: PNG });
  for (const dataUri of [uri('jpeg', PNG), uri('png', SVG), `data:image/svg+xml;base64,${SVG.toString('base64')}`, 'data:image/png;base64,***']) {
    assert.deepEqual(await loadAttachment({ source: 'embedded-image', dataUri }, ctx), { ok: false, reason: 'gone' }, dataUri.slice(0, 30));
  }
});

test('C1: a ref carries no path, kind or locator, only the message key, index and a per-share MAC', () => {
  const share = { shareId: 'f'.repeat(32), refKey: randomBytes(32) };
  const ref = mintAttachmentRef(share, 'K'.repeat(22), 3);
  assert.match(ref, /^[A-Za-z0-9_-]{22}\.[0-9]{1,2}\.[A-Za-z0-9_-]{32}$/);
  for (const forbidden of ['/', PROJECT, SCRATCH, '/home/', ctx.sessionId, 'inbox', 'chat-image', 'png']) {
    assert.ok(!ref.includes(forbidden), forbidden);
  }
  assert.deepEqual(verifyAttachmentRef(share, ref), { k: 'K'.repeat(22), index: 3 });
  assert.equal(verifyAttachmentRef({ ...share, refKey: randomBytes(32) }, ref), null, 'a rotated (revoked) ref key invalidates it');
});
