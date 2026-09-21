import assert from 'node:assert/strict';
import test from 'node:test';
import { HISTORY_TRANSFER_LIMITS, HistoryTransferLedger, historyAdmission } from './history-budget.service.js';

const statistics = { includedMessages: 2, includedBytes: 100, omittedMessages: 0 };
const knownZero = () => ({ used: 0, total: 0, inputTokens: 0, outputTokens: 0, totalReported: true, breakdown: { input: 0, output: 0 } });

test('transfer pool admits four branch owners and rejects overflow without changing capacity', () => {
  const ledger = new HistoryTransferLedger(), owners = Array.from({ length: 4 }, () => ledger.acquire('branch'));
  assert.equal(ledger.stats().chargedBytes, 32 * 1048576);
  assert.throws(() => ledger.acquire('usage'), { code: 'HISTORY_BUSY' });
  assert.equal(ledger.stats().handles, 4);
  for (const owner of owners) { owner.release(); owner.release(); }
  assert.deepEqual(ledger.stats(), { chargedBytes: 0, handles: 0, stuck: 0 });
});

test('transfer handle count bounds small usage reservations independently of byte capacity', () => {
  const ledger = new HistoryTransferLedger(), owners = Array.from({ length: 256 }, () => ledger.acquire('usage'));
  assert.equal(ledger.stats().chargedBytes, 256 * 4096);
  assert.throws(() => ledger.acquire('usage'), { code: 'HISTORY_BUSY' });
  owners.forEach(owner => owner.release()); assert.equal(ledger.stats().handles, 0);
});

test('failed branch commit holds provisional ownership until its caller releases it', () => {
  const ledger = new HistoryTransferLedger(), owner = ledger.acquire('branch');
  assert.throws(() => owner.commitBranch('x'.repeat(HISTORY_TRANSFER_LIMITS.promptBytes + 1), statistics), { code: 'HISTORY_BUDGET_EXCEEDED' });
  assert.equal(owner.state, 'provisional'); assert.equal(ledger.stats().chargedBytes, 8 * 1048576);
  owner.release(); assert.equal(ledger.stats().chargedBytes, 0);
});

test('branch transfer accepts an exact UTF8 boundary and copies only declared statistics', () => {
  const ledger = new HistoryTransferLedger(), owner = ledger.acquire('branch');
  const unit = 'ع🧵', repeats = Math.floor(HISTORY_TRANSFER_LIMITS.promptBytes / Buffer.byteLength(unit));
  const prompt = unit.repeat(repeats) + 'x'.repeat(HISTORY_TRANSFER_LIMITS.promptBytes - repeats * Buffer.byteLength(unit));
  const source = { ...statistics, history: ['must not escape'] };
  try {
    const result = owner.commitBranch(prompt, source); source.includedBytes = 999;
    assert.equal(Buffer.byteLength(result.input), HISTORY_TRANSFER_LIMITS.promptBytes);
    assert.equal(result.input, prompt); assert.equal(result.includedBytes, 100); assert.ok(Object.isFrozen(result));
    assert.deepEqual(Object.keys(result).sort(), ['includedBytes', 'includedMessages', 'input', 'omittedMessages']);
    assert.throws(() => owner.commitBranch('second', statistics), { code: 'HISTORY_SOURCE_INVALID' });
  } finally { owner.release(); }
});

test('usage transfer preserves proved zero while missing usage remains unknown', () => {
  const ledger = new HistoryTransferLedger(), zero = ledger.acquire('usage'), missing = ledger.acquire('usage');
  try {
    const value = zero.commitUsage(knownZero());
    assert.equal(value!.used, 0); assert.equal(value!.totalReported, true); assert.equal(missing.commitUsage(null), null);
    assert.ok(Object.isFrozen(value)); assert.ok(Object.isFrozen(value!.breakdown));
  } finally { zero.release(); missing.release(); }
});

test('usage transfer ignores unknown getters and copies allowlisted nested data', () => {
  const ledger = new HistoryTransferLedger(), owner = ledger.acquire('usage');
  let evaluated = 0;
  const source = { ...knownZero(), get history() { evaluated++; throw new Error('must not evaluate'); } };
  try {
    const result = owner.commitUsage(source); source.breakdown.input = 50;
    assert.equal(evaluated, 0); assert.equal(result!.breakdown.input, 0); assert.ok(!('history' in result!));
  } finally { owner.release(); }
});

for (const variant of ['getter', 'proxy', 'prototype', 'nan', 'negative', 'nested-getter'] as const) {
  test(`usage transfer refuses ${variant} without retaining arbitrary provider data`, () => {
    const ledger = new HistoryTransferLedger(), owner = ledger.acquire('usage'); let evaluated = 0;
    let value: any = knownZero();
    if (variant === 'getter') Object.defineProperty(value, 'used', { get() { evaluated++; return 0; } });
    if (variant === 'proxy') value = new Proxy(value, { getOwnPropertyDescriptor() { evaluated++; throw new Error('proxy trap'); } });
    if (variant === 'prototype') Object.setPrototypeOf(value, { arbitrary: true });
    if (variant === 'nan') value.used = NaN;
    if (variant === 'negative') value.used = -1;
    if (variant === 'nested-getter') Object.defineProperty(value.breakdown, 'input', { get() { evaluated++; return 0; } });
    try { assert.throws(() => owner.commitUsage(value), { code: 'HISTORY_SOURCE_INVALID' }); assert.equal(evaluated, 0); }
    finally { owner.release(); }
  });
}

test('a stuck transfer retains its capacity but never occupies the history reader admission slot', async () => {
  const ledger = new HistoryTransferLedger(), owner = ledger.acquire('branch');
  owner.commitBranch('stalled SDK input', statistics); owner.markStuck(); owner.release();
  assert.deepEqual(ledger.stats(), { chargedBytes: 8 * 1048576, handles: 1, stuck: 1 });
  assert.throws(() => owner.commitBranch('reuse', statistics), { code: 'HISTORY_SOURCE_INVALID' });
  const release = await historyAdmission.acquire({ user: 'other', session: 'other-history', provider: 'codex' }, new AbortController().signal);
  release(); assert.equal(historyAdmission.active, 0);
  // This test-local ledger is deliberately quarantined; no singleton or SDK reference survives.
});

test('usage transfer preserves nullable context and copies provenance without retaining provider objects', () => {
  const ledger = new HistoryTransferLedger(), owner = ledger.acquire('usage');
  const contextSnapshot = { version: 1, provider: 'codex', sessionId: 'session-a', modelId: 'model-a',
    usedTokens: null, windowTokens: null, usageKind: 'unknown', source: 'codex.turn.completed',
    observedAt: null, nativeCompactTokens: null, proposedCompactTokens: null, newSessionTokens: null };
  try {
    const result = owner.commitUsage({ ...knownZero(), used: null, total: null, totalReported: false,
      inputTokens: null, outputTokens: null, breakdown: { input: null, output: null }, contextSnapshot });
    contextSnapshot.modelId = 'model-b';
    assert.equal(result?.contextSnapshot?.modelId, 'model-a');
    assert.equal(result?.used, null);
    assert.equal(result?.total, null);
    assert.ok(Object.isFrozen(result?.contextSnapshot));
  } finally { owner.release(); }
});

test('usage transfer rejects accessor-based native provenance without reading it', () => {
  const ledger = new HistoryTransferLedger(), owner = ledger.acquire('usage');
  let evaluated = false;
  try {
    assert.throws(() => owner.commitUsage({ ...knownZero(), contextSnapshot: {
      get version() { evaluated = true; return 1; },
    } }), { code: 'HISTORY_SOURCE_INVALID' });
    assert.equal(evaluated, false);
  } finally { owner.release(); }
});
