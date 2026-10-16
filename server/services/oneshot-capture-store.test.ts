/**
 * oneshot-capture-store tests (T-2037): ANSI stripping, `\r` folding, the
 * 64 KiB tail ring, per-user bounds, TTL, ownership, and capture masking that
 * holds even with the display-masking flag OFF (qa critical-3).
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { configureDisplayMaskForTests, isDisplayMaskingEnabled } from '@/services/display-secret-mask.js';
import {
  createOneShotCaptureStore,
  maskCaptureText,
  maskClippedCaptureText,
  ONESHOT_CAPTURE_RING_BYTES,
} from '@/services/oneshot-capture-store.js';

const KNOWN_SECRET = 'zq9-known-literal-value-7731';

test.after(() => configureDisplayMaskForTests(null));

function maskingOff(): void {
  configureDisplayMaskForTests({
    env: () => '0',
    readSetting: () => 'false',
    serviceLiterals: () => [KNOWN_SECRET],
    allUserIds: () => [],
    vendorLiterals: () => [],
    sharedVendorLiterals: () => [],
  });
}

test('masking is unconditional: the flag is off yet values are masked', () => {
  maskingOff();
  assert.equal(isDisplayMaskingEnabled(), false);
  const githubToken = ['ghp', 'abcdefghijklmnopqrstuvwxyz0123456789'].join('_');
  const masked = maskCaptureText(`value=${KNOWN_SECRET}\nGITHUB_TOKEN=${githubToken}\n`);
  assert.equal(masked.includes(KNOWN_SECRET), false);
  assert.equal(masked.includes(githubToken), false);
  assert.match(masked, /\[masked:/);
});

test('clipped masking drops the partial first line (or first token)', () => {
  maskingOff();
  assert.equal(maskClippedCaptureText('tail-of-secret\nok line\n', true), 'ok line\n');
  assert.equal(maskClippedCaptureText('partialtoken rest', true), 'rest');
  assert.equal(maskClippedCaptureText('onlyonetoken', true), '');
  assert.equal(maskClippedCaptureText('whole\n', false), 'whole\n');
});

test('strips ANSI (also split across chunks) and folds carriage-return progress', () => {
  const store = createOneShotCaptureStore();
  store.begin(1, 'r');
  store.append(1, 'r', '\x1b[32mgreen\x1b[0m\r\n');
  store.append(1, 'r', 'progress 10%\rprogress 50%\rprogress 100%\r');
  store.append(1, 'r', '\ndone \x1b[3');
  store.append(1, 'r', '1mred\x1b]0;title\x07!\x07\n');
  assert.deepEqual(store.get(1, 'r'), {
    text: 'green\nprogress 100%\ndone red!\n',
    truncated: false,
    exitCode: null,
    finished: false,
  });
  store.finish(1, 'r', 0);
  store.append(1, 'r', 'ignored after finish');
  assert.equal(store.get(1, 'r')?.exitCode, 0);
  assert.equal(store.get(1, 'r')?.finished, true);
  assert.equal(store.get(1, 'r')?.text.includes('ignored'), false);
});

test('a carriage return split across chunks folds the same as in one chunk', () => {
  const store = createOneShotCaptureStore();
  store.begin(1, 'split');
  for (const chunk of ['a\r', '\nb\r', 'c\r', '', 'd\n', 'tail']) store.append(1, 'split', chunk);
  assert.equal(store.get(1, 'split')?.text, 'a\nd\ntail');
  store.begin(1, 'whole');
  store.append(1, 'whole', 'a\r\nb\rc\rd\ntail');
  assert.equal(store.get(1, 'whole')?.text, 'a\nd\ntail');
});

test('keeps a 64 KiB tail and reports truncated', () => {
  const store = createOneShotCaptureStore();
  store.begin(1, 'big');
  for (let i = 0; i < 2000; i += 1) store.append(1, 'big', `line ${i} ${'x'.repeat(60)}\n`);
  const capture = store.get(1, 'big');
  assert.ok(capture);
  assert.equal(capture.truncated, true);
  assert.ok(Buffer.byteLength(capture.text) <= ONESHOT_CAPTURE_RING_BYTES);
  assert.ok(capture.text.endsWith(`line 1999 ${'x'.repeat(60)}\n`));

  store.begin(1, 'oneline');
  store.append(1, 'oneline', 'ب'.repeat(ONESHOT_CAPTURE_RING_BYTES));
  const wide = store.get(1, 'oneline');
  assert.equal(wide?.truncated, true);
  assert.ok(Buffer.byteLength(wide!.text) <= ONESHOT_CAPTURE_RING_BYTES);
  assert.equal(wide!.text.includes('�'), false, 'never splits a code point');
});

test('owner-only: another user cannot read a capture', () => {
  const store = createOneShotCaptureStore();
  store.begin(1, 'r');
  store.append(1, 'r', 'secret output\n');
  assert.equal(store.get(2, 'r'), null);
  assert.equal(store.get(1, 'other'), null);
  store.append(2, 'r', 'ignored');
  store.dropUser(1);
  assert.equal(store.get(1, 'r'), null);
});

test('finished captures expire after the TTL; live ones do not', () => {
  let clock = 0;
  const store = createOneShotCaptureStore({ ttlMs: 1000, now: () => clock });
  store.begin(1, 'done');
  store.begin(1, 'live');
  store.finish(1, 'done', 2);
  clock = 999;
  assert.equal(store.get(1, 'done')?.exitCode, 2);
  clock = 1000;
  assert.equal(store.get(1, 'done'), null);
  assert.ok(store.get(1, 'live'));
});

test('keeps at most 5 finished captures per user (oldest evicted)', () => {
  let clock = 0;
  const store = createOneShotCaptureStore({ now: () => clock });
  for (let i = 0; i < 7; i += 1) {
    clock += 1;
    store.begin(1, `r${i}`);
    store.finish(1, `r${i}`, i);
  }
  assert.equal(store.get(1, 'r0'), null);
  assert.equal(store.get(1, 'r1'), null);
  for (let i = 2; i < 7; i += 1) assert.equal(store.get(1, `r${i}`)?.exitCode, i);
  store.finish(1, 'r6', 99);
  assert.equal(store.get(1, 'r6')?.exitCode, 6, 'finish is idempotent');
  store.reset();
  assert.equal(store.get(1, 'r6'), null);
});
