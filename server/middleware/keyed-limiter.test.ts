/**
 * Keyed fixed-window limiter (ADR-194 D8 refund): hit counts before the
 * expensive verification; refund returns one attempt only inside the live
 * window and never below zero or onto an absent or expired key.
 */
import assert from 'node:assert/strict';
import test, { mock } from 'node:test';

import { createKeyedLimiter } from './keyed-limiter.js';

test('hit caps at max per window; a refund frees exactly one slot', () => {
  const limiter = createKeyedLimiter({ windowMs: 60_000, max: 2 });
  assert.equal(limiter.hit('k').allowed, true);
  assert.equal(limiter.hit('k').allowed, true);
  const refused = limiter.hit('k');
  assert.equal(refused.allowed, false);
  assert.ok(refused.retryAfterSeconds > 0);
  limiter.refund('k');
  assert.equal(limiter.hit('k').allowed, true, 'one slot back');
  assert.equal(limiter.hit('k').allowed, false);
  assert.equal(limiter.hit('other').allowed, true, 'keys are independent');
});

test('refund never goes below zero and never pre-credits an absent or expired key', () => {
  const now = mock.method(Date, 'now', () => 1_000);
  try {
    const limiter = createKeyedLimiter({ windowMs: 1_000, max: 1 });
    limiter.refund('absent');
    assert.equal(limiter.hit('absent').allowed, true);
    assert.equal(limiter.hit('absent').allowed, false, 'the earlier refund credited nothing');
    limiter.refund('absent');
    limiter.refund('absent');
    assert.equal(limiter.hit('absent').allowed, true, 'count floored at zero, so one attempt');
    assert.equal(limiter.hit('absent').allowed, false);
    now.mock.mockImplementation(() => 5_000);
    limiter.refund('absent');
    assert.equal(limiter.hit('absent').allowed, true, 'a new window starts at one');
    assert.equal(limiter.hit('absent').allowed, false, 'the expired-window refund was ignored');
  } finally {
    now.mock.restore();
  }
});
