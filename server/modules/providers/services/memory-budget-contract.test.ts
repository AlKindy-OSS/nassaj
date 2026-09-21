/** C1 admission/parser contracts. All state and bytes are synthetic and local. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { HISTORY_LIMITS, HistoryBudgetError, HistoryReadLease, historyAdmission } from './history-budget.service.js';

const descriptor = { user: 'memory-budget-user', session: 'memory-budget-session', provider: 'claude' };

test('memory budget exposes the reviewed bounded interim envelope', () => {
  assert.equal(HISTORY_LIMITS.sourceBytes, 128 * 1024 * 1024);
  assert.equal(HISTORY_LIMITS.recordBytes, 1024 * 1024);
  assert.equal(HISTORY_LIMITS.responseBytes, 32 * 1024 * 1024);
  assert.equal(HISTORY_LIMITS.jobBytes, 256 * 1024 * 1024);
  assert.equal(HISTORY_LIMITS.queue, 8);
  assert.ok(Object.isFrozen(HISTORY_LIMITS));
});

test('memory budget rejects byte overflow before increasing its admitted charge', async () => {
  const lease = new HistoryReadLease(new AbortController().signal, { sourceBytes: 128 });
  try {
    lease.charge('sourceBytes', 128);
    assert.throws(() => lease.charge('sourceBytes', 1), { code: 'HISTORY_BUDGET_EXCEEDED', statusCode: 413 });
  } finally { await lease.close(); }
});

for (const [name, text, limits] of [
  ['record bytes', JSON.stringify('x'.repeat(128)), { recordBytes: 64 }],
  ['dense structure', JSON.stringify(Array.from({ length: 100 }, () => ({}))), { tokens: 20 }],
  ['nested depth', '{"a":{"b":{"c":{"d":1}}}}', { depth: 3 }],
] as const) test(`memory budget rejects ${name} before native parsing`, async () => {
  const lease = new HistoryReadLease(new AbortController().signal, limits);
  try { assert.throws(() => lease.parse(text), { code: 'HISTORY_BUDGET_EXCEEDED', statusCode: 413 }); }
  finally { await lease.close(); }
});

test('memory budget preserves Arabic and escapes in admitted JSON and distinguishes invalid syntax', async () => {
  const lease = new HistoryReadLease(new AbortController().signal);
  try {
    const expected = { text: 'العربية 🧵\n"\\', nested: [null, true, 3] };
    assert.deepEqual(lease.parse(JSON.stringify(expected)), expected);
    assert.throws(() => lease.parse('{"complete":true,}'), { code: 'HISTORY_SOURCE_INVALID', statusCode: 422 });
  } finally { await lease.close(); }
});

test('memory budget rejects already cancelled construction before allocating work', () => {
  const controller = new AbortController(); controller.abort();
  assert.throws(() => new HistoryReadLease(controller.signal), { code: 'HISTORY_ABORTED' });
});

test('memory budget execution deadline fails with a typed timeout', async () => {
  const expired = new HistoryReadLease(new AbortController().signal, { executionMs: 100 });
  try {
    await new Promise(resolve => setTimeout(resolve, 110));
    assert.throws(() => expired.check(), { code: 'HISTORY_TIMEOUT', statusCode: 504 });
  } finally { await expired.close(); }
});

test('memory budget refuses oversized owned DTO instead of returning it beyond its lease', async () => {
  const lease = new HistoryReadLease(new AbortController().signal, { retainedBytes: 128 });
  try { assert.throws(() => lease.reserveDto({ messages: [{ content: 'x'.repeat(1024) }] }), { code: 'HISTORY_BUDGET_EXCEEDED' }); }
  finally { await lease.close(); }
});

test('memory admission keeps one reader and eight waiters and rejects overflow as retryable busy', async () => {
  const active = new AbortController(), waiters: AbortController[] = [];
  const release = await historyAdmission.acquire(descriptor, active.signal);
  const pending: Promise<unknown>[] = [];
  try {
    for (let index = 0; index < 8; index++) {
      const controller = new AbortController(); waiters.push(controller);
      pending.push(historyAdmission.acquire({ ...descriptor, session: `waiter-${index}` }, controller.signal).then(
        unlock => { unlock(); throw new Error('cancelled waiter must not acquire'); }, error => error,
      ));
    }
    assert.equal(historyAdmission.active, 1); assert.equal(historyAdmission.queued, 8);
    await assert.rejects(historyAdmission.acquire(descriptor, new AbortController().signal), { code: 'HISTORY_BUSY', statusCode: 503 });
    waiters[0].abort(); await pending[0];
    assert.equal(historyAdmission.active, 1, 'another subscriber cancellation does not cancel the active reader');
    assert.equal(historyAdmission.queued, 7);
  } finally {
    waiters.forEach(controller => controller.abort()); await Promise.all(pending); release();
    assert.equal(historyAdmission.active, 0); assert.equal(historyAdmission.queued, 0);
  }
});

test('memory failure codes preserve status metadata without source paths', () => {
  const error = new HistoryBudgetError('HISTORY_SOURCE_UNAVAILABLE');
  assert.equal(error.code, 'HISTORY_SOURCE_UNAVAILABLE'); assert.equal(error.statusCode, 409);
  assert.ok(!error.message.includes('/home/'));
});
