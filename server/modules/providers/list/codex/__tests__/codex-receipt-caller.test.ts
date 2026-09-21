import assert from 'node:assert/strict';
import test from 'node:test';

import { attachCodexCompletionProof, readCodexCompletionProof } from '@/shared/utils.js';

import { createCodexReceiptCallerFixture } from '../../../../../../tests/helpers/codex-receipt-caller-fixture.js';

test('actual new caller reserves minted ID before session_created, rejects collision, and only owner releases it', async () => {
  let release!: () => void, entered!: () => void, runs = 0;
  const gate = new Promise<void>(r => { release = r; });
  const started = new Promise<void>(r => { entered = r; });
  class SDK {
    id = 'minted-thread'; startThread() { return this; } resumeThread() { return this; }
    async runStreamed() {
      runs++;
      return { events: (async function* () {
        yield { type: 'thread.started', thread_id: 'minted-thread' };
        entered(); await gate;
        yield { type: 'turn.completed', usage: {} };
      })() };
    }
  }
  const f = createCodexReceiptCallerFixture({ installedSdk: { Codex: SDK } });
  let nested: Promise<void> | undefined;
  f.writer.send = (frame: any) => {
    f.frames.push(frame);
    if (frame.kind === 'session_created') nested = f.run({ sessionId: 'minted-thread' });
  };
  const first = f.run({ sessionId: null });
  await started; await nested;
  assert.equal(runs, 1); assert.ok(f.frames.some(frame => frame.code === 'session_busy'));
  await f.run({ sessionId: null }); // same minted ID from a second SDK is a collision
  assert.equal(runs, 2);
  await f.run({ sessionId: 'minted-thread' });
  assert.equal(runs, 2, 'colliding invocation cannot release the original reservation');
  release(); await first;
  await f.run({ sessionId: 'minted-thread' });
  assert.equal(runs, 3, 'reservation releases after the owning iterator completes');
});

test('actual resumed caller captures pre-effect window and transports successful proof to persistence seam', async () => {
  const order: string[] = [];
  const proof = { version: 'codex_user_v1', userMessageId: 'native', turnId: 'turn', payloadSha256: 'a'.repeat(64) };
  class SDK {
    id = 'parent'; startThread() { return this; } resumeThread() { return this; }
    async runStreamed() { order.push('effect'); return { events: (async function* () { yield { type: 'turn.completed', usage: {} }; })() }; }
  }
  const f = createCodexReceiptCallerFixture({ installedSdk: { Codex: SDK }, receiptBindings: {
    captureCodexReceiptWindow: async (_id: string, mode: string) => { order.push(mode); return { mode }; },
    codexReceiptPayloadHash: () => 'a'.repeat(64), attachCodexCompletionProof,
    resolveCodexUserProof: async (_id: string, window: any, isNew: boolean) => { assert.equal(window.mode, 'resume'); assert.equal(isNew, false); return proof; },
  } });
  await f.run({ clientMsgId: 'client' });
  assert.deepEqual(order, ['resume', 'effect']);
  const complete = f.frames.find(frame => frame.kind === 'complete');
  assert.deepEqual(readCodexCompletionProof(complete), proof);
  assert.equal(JSON.stringify(complete).includes('codexUserProof'), false);
  assert.equal(readCodexCompletionProof({ ...complete }), undefined);
});
