/** ADR-205 N1/H7/C1: message identities, per-share message keys, cursors and attachment refs. */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  createMessageIdentityAssigner, messageKey, mintAttachmentRef, mintCursor, verifyAttachmentRef, verifyCursor,
} from './session-share-live-keys.js';

const share = { shareId: 'a'.repeat(32), refKey: randomBytes(32) };
const other = { shareId: 'b'.repeat(32), refKey: randomBytes(32) };

test('identities depend on content and per-(role, text) ordinal only, and survive appends', () => {
  const first = createMessageIdentityAssigner('s1');
  const a = [first('user', 'hi'), first('assistant', 'hi'), first('user', 'hi'), first('user', 'bye')];
  const second = createMessageIdentityAssigner('s1');
  const b = [second('user', 'hi'), second('assistant', 'hi'), second('user', 'hi'), second('user', 'bye'), second('user', 'new')];
  assert.deepEqual(b.slice(0, 4), a);
  assert.equal(new Set(a).size, 4, 'repeated identical rows get distinct identities');
  assert.notEqual(createMessageIdentityAssigner('s2')('user', 'hi'), a[0], 'bound to the session');
});

test('message keys are per share, so two shares of one session cannot correlate messages', () => {
  const sid = createMessageIdentityAssigner('s1')('user', 'hi');
  assert.match(messageKey(share, sid), /^[A-Za-z0-9_-]{22}$/);
  assert.notEqual(messageKey(share, sid), messageKey(other, sid));
});

test('a cursor verifies only for the share that minted it', () => {
  const k = messageKey(share, 'sid');
  const cursor = mintCursor(share, k);
  assert.match(cursor, /^[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{22}$/);
  assert.equal(verifyCursor(share, cursor), k);
  assert.equal(verifyCursor(other, cursor), null, 'wrong share');
  assert.equal(verifyCursor({ ...share, refKey: randomBytes(32) }, cursor), null, 'rotated or revoked key');
  const forged = `${k}.${'A'.repeat(22)}`;
  assert.equal(verifyCursor(share, forged), null, 'MAC forgery');
  assert.equal(verifyCursor(share, 'not-a-cursor'), null, 'shape');
});

test('an attachment ref carries only the key, the index and a MAC', () => {
  const k = messageKey(share, 'sid');
  const ref = mintAttachmentRef(share, k, 3);
  assert.match(ref, /^[A-Za-z0-9_-]{22}\.[0-9]{1,2}\.[A-Za-z0-9_-]{32}$/);
  assert.deepEqual(verifyAttachmentRef(share, ref), { k, index: 3 });
  assert.equal(verifyAttachmentRef(other, ref), null);
  assert.equal(verifyAttachmentRef(share, ref.replace('.3.', '.4.')), null, 'index is covered by the MAC');
  assert.equal(verifyAttachmentRef(share, 'x'), null);
  for (const leak of ['/', 'home', 'chat-images']) assert.ok(!ref.includes(leak));
});

test('D4: MAC comparison is constant-time, and a wrong-length MAC is refused instead of throwing', () => {
  const source = readFileSync(new URL('./session-share-live-keys.ts', import.meta.url), 'utf8');
  assert.match(source, /timingSafeEqual\(a, b\)/, 'MACs are compared with timingSafeEqual');
  assert.doesNotMatch(source, /(?:expected|actual|mac)\s*[!=]==\s*(?:expected|actual|mac)\b/, 'no plain string comparison of MACs');
  const k = messageKey(share, 'sid');
  const ref = mintAttachmentRef(share, k, 1);
  assert.equal(verifyAttachmentRef(share, ref.slice(0, -1)), null, 'short MAC');
  assert.equal(verifyAttachmentRef(share, `${ref}A`), null, 'long MAC');
  assert.equal(verifyCursor(share, `${k}.${'\u0661'.repeat(22)}`), null, 'non-ASCII MAC');
});
