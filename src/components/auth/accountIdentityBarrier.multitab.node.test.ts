import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { createContext, runInContext } from 'node:vm';
import { BroadcastChannel } from 'node:worker_threads';

import { JSDOM } from 'jsdom';
import ts from 'typescript';

type Barrier = typeof import('./accountIdentityBarrier');

// Separate JS realms emulate independent tabs running the unchanged module.
// Native BroadcastChannel is exercised; only browser storage delivery is modeled.
const compiled = ts.transpileModule(readFileSync(new URL('./accountIdentityBarrier.ts', import.meta.url), 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;

function tabs(useBroadcast: boolean, count = 2, initialBarrier?: string) {
  const windows = Array.from({ length: count }, () => new JSDOM('', { url: 'https://wallet.example.test' }));
  const channels: BroadcastChannel[] = [];
  const stored = new Map<string, string>();
  if (initialBarrier !== undefined) stored.set('nassaj_identity_barrier_v1', initialBarrier);
  class TrackedChannel extends BroadcastChannel {
    constructor(name: string) { super(name); channels.push(this); }
  }
  const barriers = windows.map((dom, index) => {
    const exports = {};
    const context = createContext({
      exports, AbortController, AbortSignal, DOMException,
      BroadcastChannel: useBroadcast ? TrackedChannel : undefined,
      window: dom.window, CustomEvent: dom.window.CustomEvent, Event: dom.window.Event,
      localStorage: {
        getItem: (key: string) => stored.get(key) ?? null,
        setItem: (key: string, value: string) => {
          if (stored.get(key) === value) return;
          stored.set(key, value);
          if (useBroadcast) return;
          for (const [otherIndex, tab] of windows.entries()) {
            if (otherIndex === index) continue;
            const other = tab.window;
            queueMicrotask(() => other.dispatchEvent(new other.StorageEvent('storage', { key, newValue: value })));
          }
        },
        removeItem: (key: string) => { stored.delete(key); },
      },
    });
    runInContext(compiled, context);
    return exports as Barrier;
  });
  return {
    barriers,
    stored,
    close() { for (const channel of channels) channel.close(); for (const dom of windows) dom.window.close(); },
  };
}

test('fresh boot is stable only when the persisted barrier key is absent', () => {
  const fixture = tabs(false, 1);
  try {
    assert.equal(fixture.barriers[0].getIdentityBarrierSnapshot().phase, 'stable');
  } finally { fixture.close(); }
});

for (const invalid of ['', '{', JSON.stringify({
  phase: 'committed', version: `${'z'.repeat(10_000)}:hostile`, reason: 'switch',
})]) {
  test('fresh boot fences corrupt or oversized persisted identity state until reconciliation', () => {
    const fixture = tabs(false, 1, invalid);
    const barrier = fixture.barriers[0];
    try {
      const snapshot = barrier.getIdentityBarrierSnapshot();
      assert.equal(snapshot.phase, 'committed');
      assert.equal(snapshot.reason, 'identity_reconciliation_retry');
      assert.ok(snapshot.version.length <= 160);
      assert.throws(() => barrier.identityRequestSignal(), { name: 'AbortError' });
      barrier.stabilizeIdentityBarrier(snapshot.version);
      assert.equal(barrier.getIdentityBarrierSnapshot().phase, 'stable');
      assert.equal(fixture.stored.get('nassaj_identity_barrier_v1'), invalid);
      assert.equal(barrier.identityRequestSignal().aborted, false);
    } finally { fixture.close(); }
  });
}

test('successful corrupt-record reconciliation never deletes a global or newer foreign fence', () => {
  const fixture = tabs(false, 1, '{');
  const barrier = fixture.barriers[0];
  try {
    const snapshot = barrier.getIdentityBarrierSnapshot();
    const foreign = JSON.stringify({
      phase: 'committed', version: `${(Date.now() + 10_000).toString(36)}:foreign`, reason: 'switch',
    });
    fixture.stored.set('nassaj_identity_barrier_v1', foreign);
    barrier.stabilizeIdentityBarrier(snapshot.version);
    assert.equal(fixture.stored.get('nassaj_identity_barrier_v1'), foreign);
  } finally { fixture.close(); }
});

function untilPhase(barrier: Barrier, phase: string): Promise<void> {
  if (barrier.getIdentityBarrierSnapshot().phase === phase) return Promise.resolve();
  return new Promise((resolve) => {
    const unsubscribe = barrier.subscribeIdentityBarrier(() => {
      if (barrier.getIdentityBarrierSnapshot().phase !== phase) return;
      unsubscribe(); resolve();
    });
  });
}

for (const broadcast of [true, false]) {
  test(`three tabs keep fast, slow and failed reconciliation local via ${broadcast ? 'BroadcastChannel' : 'storage'}`, { timeout: 3000 }, async () => {
    const fixture = tabs(broadcast, 3);
    const [fast, slow, failed] = fixture.barriers;
    try {
      const started = [untilPhase(slow, 'changing'), untilPhase(failed, 'changing')];
      const version = fast.beginIdentityTransition('switch');
      await Promise.all(started);
      const committed = [untilPhase(slow, 'committed'), untilPhase(failed, 'committed')];
      fast.commitIdentityTransition(version, 'switch');
      await Promise.all(committed);
      fast.stabilizeIdentityBarrier(version);
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(slow.getIdentityBarrierSnapshot().phase, 'committed');
      assert.equal(failed.getIdentityBarrierSnapshot().phase, 'committed');
      failed.lockIdentityBarrier(version, 'cleanup_failed');
      slow.stabilizeIdentityBarrier(version);
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(fast.identityRequestSignal().aborted, false);
      assert.equal(slow.identityRequestSignal().aborted, false);
      assert.throws(() => failed.identityRequestSignal(), { name: 'AbortError' });
      assert.equal(failed.getIdentityBarrierSnapshot().phase, 'locked');
    } finally { fixture.close(); }
  });

  test(`cross-tab ${broadcast ? 'native BroadcastChannel' : 'storage fallback'} releases only an uncommitted cancellation`, { timeout: 3000 }, async () => {
    const fixture = tabs(broadcast);
    const [first, second] = fixture.barriers;
    try {
      const remoteChanging = untilPhase(second, 'changing');
      const version = first.beginIdentityTransition('add');
      await remoteChanging;
      const remoteStable = untilPhase(second, 'stable');
      first.cancelIdentityTransition(version);
      await remoteStable;
      assert.equal(first.getIdentityBarrierSnapshot().phase, 'stable');
      assert.equal(second.getIdentityBarrierSnapshot().phase, 'stable');
    } finally { fixture.close(); }
  });

  test(`cross-tab ${broadcast ? 'native BroadcastChannel' : 'storage fallback'} fences requests through reconciliation`, { timeout: 3000 }, async () => {
    const fixture = tabs(broadcast);
    const [first, second] = fixture.barriers;
    try {
      const oldRequest = second.identityRequestSignal();
      const remoteChanging = untilPhase(second, 'changing');
      const version = first.beginIdentityTransition('switch');
      await remoteChanging;
      assert.equal(oldRequest.aborted, true);
      assert.throws(() => second.identityRequestSignal(), { name: 'AbortError' });
      const remoteCommitted = untilPhase(second, 'committed');
      first.commitIdentityTransition(version, 'active_identity_conflict');
      await remoteCommitted;
      assert.throws(() => second.identityRequestSignal(), { name: 'AbortError' });
      // Each tab owns its reconciliation result. The fast tab may become usable
      // while the slow tab is still fenced, and the slow tab may then fail
      // closed without either result crossing the transport.
      first.stabilizeIdentityBarrier(version);
      assert.equal(first.getIdentityBarrierSnapshot().phase, 'stable');
      assert.equal(second.getIdentityBarrierSnapshot().phase, 'committed');
      assert.equal(first.identityRequestSignal().aborted, false);
      second.lockIdentityBarrier(version, 'cleanup_failed');
      assert.equal(second.getIdentityBarrierSnapshot().phase, 'locked');
      assert.equal(first.getIdentityBarrierSnapshot().phase, 'stable');
      assert.equal(first.identityRequestSignal().aborted, false);
      assert.throws(() => second.identityRequestSignal(), { name: 'AbortError' });
    } finally { fixture.close(); }
  });
}
