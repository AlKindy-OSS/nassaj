/** ADR-205 D7: strict window limiter (no overflow bucket), keyed slots and the guest guard order. */
import assert from 'node:assert/strict';
import test from 'node:test';

import { GUEST_LIMITS, createGuestGuards, createKeyedSlots, createStrictWindowLimiter } from './share-guest-guards.js';

test('strict limiter: counts per key, resets per window, never pools a new key into an overflow bucket', () => {
  let now = 0;
  const limiter = createStrictWindowLimiter({ limit: 2, windowMs: 1000, maxKeys: 2, now: () => now });
  assert.deepEqual(['a', 'a', 'a'].map((key) => limiter.hit(key)), ['ok', 'ok', 'limited']);
  assert.equal(limiter.retryAfterSec('a'), 1);
  assert.equal(limiter.hit('b'), 'ok');
  assert.equal(limiter.hit('c'), 'untracked', 'map full: not tracked, not pooled');
  assert.equal(limiter.hit('c'), 'untracked');
  now = 1000;
  assert.equal(limiter.hit('c'), 'ok', 'expired keys are evicted before refusing to track');
  assert.equal(limiter.hit('a'), 'ok', 'a and b expired and were evicted, so a starts a fresh window');
  assert.equal(limiter.size(), 2);
  assert.equal(limiter.hit('d'), 'untracked', 'c and a are live: a third live key is not tracked');
});

test('keyed slots: bounded per key, one-shot release, entries vanish at zero', () => {
  const slots = createKeyedSlots(2);
  const a = slots.tryAcquire('k');
  const b = slots.tryAcquire('k');
  assert.ok(a && b);
  assert.equal(slots.tryAcquire('k'), null);
  a!();
  a!();
  assert.equal(slots.count('k'), 1, 'double release is a no-op');
  b!();
  assert.equal(slots.count('k'), 0);
});

test('guest guards: failures 429 after 20 per bucket; admission order releases partial grants', () => {
  let now = 0;
  const guards = createGuestGuards({ now: () => now });
  const verdicts = Array.from({ length: 21 }, () => guards.failedVerification('203.0.113.7'));
  assert.equal(verdicts.filter(Boolean).length, 1, 'twenty failures per 10 minutes, then 429');
  assert.equal(guards.failedVerification('203.0.113.8'), false, 'another bucket is unaffected');
  now += GUEST_LIMITS.failures.windowMs;
  assert.equal(guards.failedVerification('203.0.113.7'), false, 'the window resets');

  const held = Array.from({ length: GUEST_LIMITS.globalSlots }, (_, i) => guards.admitReader(`share-${i}`, `ip-${i}`));
  assert.ok(held.every((admission) => 'release' in admission));
  const refused = guards.admitReader('share-new', 'ip-new');
  assert.deepEqual(refused, { refused: true, retryAfterSec: 1 }, 'global reader slots exhausted');
  assert.equal(guards.stats().globalReaders, GUEST_LIMITS.globalSlots, 'the refusal released its per-share and per-IP grants');
  held.forEach((admission) => 'release' in admission && admission.release());
  assert.equal(guards.stats().globalReaders, 0);
  const attachments = Array.from({ length: 5 }, (_, i) => guards.admitAttachment(`s${i}`));
  assert.equal(attachments.filter((admission) => 'refused' in admission).length, 1, 'global attachment pool of 4');
});
