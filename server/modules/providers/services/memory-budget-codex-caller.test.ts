import assert from 'node:assert/strict';
import test from 'node:test';

import { createCodexCallerFixture as fixture } from '../../../../tests/helpers/memory-c0-current-source-codex-fixture.js';

import * as budget from './history-budget.service.js';

for (const phase of ['governance', 'source-auth', 'history-read', 'history-close', 'model', 'baseline']) {
  test(`actual Codex caller releases ownership after ${phase} failure`, async () => {
    const f = fixture({ failure: phase });
    if (['source-auth', 'history-read', 'history-close', 'model'].includes(phase)) await assert.rejects(f.run(), new RegExp(`synthetic ${phase}`));
    else await f.run();
    assert.equal(f.ledger.stats().chargedBytes, 0); assert.equal(budget.historyAdmission.active, 0);
    assert.equal(f.state.sdkCalls, phase === 'baseline' ? 1 : 0);
  });
}

test('actual Codex caller image preparation failure releases the detached branch', async () => {
  const f = fixture(); await f.run({ images: [{ data: 'data:image/png;base64,YQ==' }] });
  assert.equal(f.state.sdkCalls, 0); assert.equal(f.ledger.stats().chargedBytes, 0);
});

test('actual Codex entry preserves busy failure metadata before an SDK effect', async () => {
  const f = fixture(), occupied = Array.from({ length: 4 }, () => f.ledger.acquire('branch'));
  let notStarted = 0;
  try {
    await f.run({ clientMsgId: 'fixture-client-id', permissionExecution: {
      consume() {}, markStarted() {}, settle() {}, notStarted() { notStarted++; },
    } });
    assert.equal(f.state.sdkCalls, 0); assert.equal(notStarted, 1);
    const frame = f.frames.find(value => value.code === 'HISTORY_BUSY');
    assert.equal(frame?.clientMsgId, 'fixture-client-id'); assert.equal(frame?.retryAfter, 1);
    assert.equal(budget.historyAdmission.active, 0);
  } finally { occupied.forEach(owner => owner.release()); }
});

// b72b50449 fences markStarted before the SDK effect, so a failing start never reaches runStreamed.
test('actual Codex caller permission start failure refuses before any SDK effect and releases input', async () => {
  const f = fixture(); await f.run({ permissionExecution: { consume() {}, markStarted() { throw new Error('synthetic mark'); }, settle() {}, notStarted() {} } });
  assert.equal(f.state.sdkCalls, 0); assert.equal(f.state.nextCalls, 0); assert.equal(f.state.returns, 0);
  assert.equal(f.state.inputHeld, false); assert.equal(f.ledger.stats().chargedBytes, 0);
});

for (const phase of ['runStreamed', 'iterator-acquire']) test(`actual Codex caller quarantines ambiguous ${phase} failure`, async () => {
  const f = fixture({ failure: phase }); await f.run();
  assert.equal(f.ledger.stats().stuck, 1); assert.equal(f.ledger.stats().chargedBytes, 8 * 1048576);
  assert.equal(budget.historyAdmission.active, 0);
});

test('actual Codex caller rekeys a completed branch without acquiring another transfer handle', async () => {
  const f = fixture(); await f.run();
  assert.equal(f.state.chargeAtSdk, 8 * 1048576); assert.equal(f.state.rekeys, 1);
  assert.equal(f.ledger.stats().handles, 0); assert.equal(f.state.inputHeld, false);
});

for (const returnMode of ['done', 'throw', 'hang']) test(`actual Codex caller abort owns input until ${returnMode} return is resolved`, async () => {
  const f = fixture({ stalled: true, returnMode }); const running = f.run();
  await f.blocked; assert.equal(f.state.inputHeld, true); assert.equal(budget.historyAdmission.active, 0);
  assert.equal(f.caller.abortCodexSession('child'), true); await running;
  assert.equal(f.state.returns, 1);
  assert.equal(f.ledger.stats().stuck, returnMode === 'done' ? 0 : 1);
  assert.equal(f.ledger.stats().chargedBytes, returnMode === 'done' ? 0 : 8 * 1048576);
  if (returnMode === 'hang') assert.equal(f.state.requestedTimeout, 10000, 'fake scheduler accelerates only the declared production cleanup deadline');
});

test('actual Codex caller keeps usage unknown after post-consumer cleanup failure', async () => {
  const f = fixture({ branch: false, failure: 'history-close' }); await f.run();
  assert.equal(f.state.sdkCalls, 1); assert.equal(f.state.chargeAtSdk, 0);
  assert.equal(f.ledger.stats().handles, 0); assert.equal(budget.historyAdmission.active, 0);
});

test('actual Codex entry returns a rejected Promise for an accessor failure before its first await', async () => {
  const f = fixture(); let returned: Promise<void> | undefined;
  assert.doesNotThrow(() => { returned = f.caller.queryCodex('input', { get clientMsgId() { throw new Error('synthetic accessor'); } }, f.writer); });
  assert.ok(returned instanceof Promise); await assert.rejects(returned!, /synthetic accessor/);
  assert.equal(f.state.sdkCalls, 0); assert.equal(f.ledger.stats().chargedBytes, 0);
});

test('actual Codex busy path returns a Promise and keeps its lock through asynchronous SDK cleanup', async () => {
  const f = fixture({ stalled: true, returnMode: 'controlled' }), running = f.run();
  try {
    await f.blocked; assert.equal(f.caller.abortCodexSession('child'), true);
    for (let turns = 0; turns < 20 && f.state.returns === 0; turns++) await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.state.returns, 1); assert.equal(f.ledger.stats().chargedBytes, 8 * 1048576);
    const busy = f.run(); assert.ok(busy instanceof Promise); await busy;
    assert.equal(f.frames.at(-1)?.code, 'session_busy'); assert.equal(f.state.sdkCalls, 1);
  } finally { f.releaseReturn(); await running; }
  assert.equal(f.ledger.stats().chargedBytes, 0);
});
