/** ADR-205 D2 step 7 / D9 / H1 / N8: attachment extraction, secret paths and displayed names. */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ATTACHMENT_SOURCES, extractAttachments, sanitizeAttachmentName, sanitizeLiveRow,
} from './session-share-live-attachments.js';

const ctx = { projectRoot: '/srv/project', home: '/home/operator' };
/** Context whose policy (a) check accepts every file, so extraction alone is under test. */
const textCtx = { ...ctx, isTextFile: () => true };
const counts = () => ({ system: 0, image: 0, secret: 0, path: 0, network: 0 });
const BUCKET = '0123456789abcdef0123456789abcdef';
const store = (name: string) => `/srv/data/chat-images/${BUCKET}/${name}`;
const PNG = `data:image/png;base64,${Buffer.from('png-bytes').toString('base64')}`;

test('the inventory is data: each source names a role and a locator, never a provider', () => {
  assert.deepEqual(ATTACHMENT_SOURCES.map((source) => source.via), ['note', 'note', 'fence', 'field', 'unavailable']);
  assert.ok(ATTACHMENT_SOURCES.every((source) => source.via === 'unavailable' || typeof source.locate === 'function'));
});

test('server-appended image and file notes become image and file parts with server-only locators', () => {
  const text = `please look\n\n[Images provided at the following paths:]\n1. ${store('image_1.png')}\n2. ${store('image_2.jpg')}`
    + '\n\n[Files provided at the following paths:]\n1. .nassaj-uploads/inbox/report.pdf';
  const body = sanitizeLiveRow({ role: 'user', text }, textCtx, counts());
  assert.deepEqual(body.parts, [
    { t: 'text', text: 'please look' }, { t: 'image' }, { t: 'image' }, { t: 'file', name: 'report.pdf' },
  ]);
  assert.deepEqual(body.locators, [
    { source: 'chat-image', bucket: BUCKET, name: 'image_1.png' },
    { source: 'chat-image', bucket: BUCKET, name: 'image_2.jpg' },
    { source: 'inbox-file', path: '.nassaj-uploads/inbox/report.pdf' },
  ]);
  assert.ok(!JSON.stringify(body.parts).includes('chat-images'), 'no store path in viewer parts');
});

test('an image-only prompt keeps its image; a bad store path or an out-of-inbox file is unavailable', () => {
  const body = sanitizeLiveRow({ role: 'user', text: `\n\n[Images provided at the following paths:]\n1. /srv/x/evil.png`
    + '\n\n[Files provided at the following paths:]\n1. ../outside.txt' }, ctx, counts());
  assert.deepEqual(body.parts, [
    { t: 'attachment-unavailable', kind: 'image' }, { t: 'attachment-unavailable', kind: 'file' },
  ]);
  assert.deepEqual(body.locators, []);
});

test('N8: look-alike note text that is not the exact trailing block stays text and is redacted as text', () => {
  const typed = `[Files provided at the following paths:]\n1. .nassaj-uploads/inbox/a.txt\nand then I kept typing`;
  const segments = extractAttachments({ role: 'user', text: typed }, ctx);
  assert.equal(segments.length, 1);
  assert.ok('text' in segments[0]);
  const misnumbered = `x\n\n[Files provided at the following paths:]\n2. .nassaj-uploads/inbox/a.txt`;
  assert.equal(extractAttachments({ role: 'user', text: misnumbered }, ctx).length, 1);
  const assistantNote = `x\n\n[Files provided at the following paths:]\n1. .nassaj-uploads/inbox/a.txt`;
  assert.equal(extractAttachments({ role: 'assistant', text: assistantNote }, ctx).length, 1, 'notes are user-only');
});

test('H1: a secret path yields redacted/secret and no locator', () => {
  const body = sanitizeLiveRow({ role: 'user',
    text: 'x\n\n[Files provided at the following paths:]\n1. .nassaj-uploads/inbox/.env' }, ctx, counts());
  assert.deepEqual(body.parts.at(-1), { t: 'redacted', cat: 'secret' });
  assert.deepEqual(body.locators, []);
});

test('assistant image fences become inline images; captions are dropped; an unclosed fence fails closed', () => {
  const text = 'before\n```image\n/srv/project/out/chart.png\nA caption\n```\nafter\n```image\n/srv/project/b.png';
  const body = sanitizeLiveRow({ role: 'assistant', text }, ctx, counts());
  assert.deepEqual(body.parts, [{ t: 'text', text: 'before' }, { t: 'image' }, { t: 'text', text: 'after' }, { t: 'image' }]);
  assert.deepEqual(body.locators.map((l) => l.source), ['assistant-image', 'assistant-image']);
  const relative = sanitizeLiveRow({ role: 'assistant', text: '```image\nrelative.png\n```' }, ctx, counts());
  assert.deepEqual(relative.parts, [{ t: 'attachment-unavailable', kind: 'image' }]);
  const user = sanitizeLiveRow({ role: 'user', text: '```image\n/srv/project/b.png\n```' }, ctx, counts());
  assert.ok(!user.parts.some((part) => part.t === 'image'), 'user-typed fences are not attachments');
});

test('embedded raster images inline within the cap; other types, oversize and omitted ones are unavailable', () => {
  const huge = `data:image/png;base64,${'A'.repeat(2 * 1024 * 1024 + 4)}`;
  const body = sanitizeLiveRow({ role: 'user', text: 'see', images: [PNG, 'data:image/svg+xml;base64,PHN2Zz4=', huge],
    imagesOmitted: 2 }, ctx, counts());
  assert.deepEqual(body.parts, [{ t: 'text', text: 'see' }, { t: 'image' },
    ...Array(4).fill({ t: 'attachment-unavailable', kind: 'image' })]);
  assert.deepEqual(body.locators, [{ source: 'embedded-image', dataUri: PNG }]);
});

test('displayed names: basename only, controls and bidi overrides stripped, redaction collapses to "file", capped', () => {
  assert.equal(sanitizeAttachmentName('dir/re‮port\u0007.pdf', ctx, counts()), 'report.pdf');
  assert.equal(sanitizeAttachmentName(`ghp_${'Ab1'.repeat(12)}.txt`, ctx, counts()), 'file');
  assert.equal(sanitizeAttachmentName(`${'n'.repeat(200)}.txt`, ctx, counts()).length, 120);
  assert.equal(sanitizeAttachmentName('‎', ctx, counts()), 'file');
});

test('N2 policy (a): a file the projection-time check rejects, or any file without the check, mints no locator', () => {
  const text = 'x\n\n[Files provided at the following paths:]\n1. .nassaj-uploads/inbox/report.pdf';
  for (const context of [ctx, { ...ctx, isTextFile: () => false }]) {
    const body = sanitizeLiveRow({ role: 'user', text }, context, counts());
    assert.deepEqual(body.parts.at(-1), { t: 'attachment-unavailable', kind: 'file' });
    assert.deepEqual(body.locators, []);
  }
});

test('D9: normalized unavailable attachments become unavailable parts by kind, bounded', () => {
  const body = sanitizeLiveRow({ role: 'user', text: 'hello', attachmentsUnavailable: { image: 1, file: 2 } }, ctx, counts());
  assert.deepEqual(body.parts, [{ t: 'text', text: 'hello' }, { t: 'attachment-unavailable', kind: 'image' },
    { t: 'attachment-unavailable', kind: 'file' }, { t: 'attachment-unavailable', kind: 'file' }]);
  const flood = sanitizeLiveRow({ role: 'user', text: 'x', attachmentsUnavailable: { file: 10_000, image: -3 } }, ctx, counts());
  assert.equal(flood.parts.length, 1 + 64);
  const assistant = sanitizeLiveRow({ role: 'assistant', text: 'x', attachmentsUnavailable: { image: 1 } }, ctx, counts());
  assert.deepEqual(assistant.parts, [{ t: 'text', text: 'x' }], 'user rows only');
});
