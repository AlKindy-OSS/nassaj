/**
 * ADR-199 P4b wiring (T-1992): how the actual openai-codex.js caller drives the
 * per-run rollout tail. A recording stand-in replaces createCodexRunSubagentTail,
 * so the order of drain, completion frame and final stop is observed directly
 * on the real queryCodex body (no native process, DB or auth).
 *
 * Runner: node scripts/run-isolated-node-tests.mjs server <this file>
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { createCodexReceiptCallerFixture } from '../../../../../../tests/helpers/codex-receipt-caller-fixture.js';

type Log = string[];

/** Stand-in tail: logs each call; the drain resolves only after a delay to expose ordering. */
function recordingTail(log: Log, seen: { options?: any }) {
  return (options: any) => {
    seen.options = options;
    return {
      onThreadStarted(threadId: unknown) { log.push(`thread:${String(threadId)}`); },
      hidesCollab: () => false,
      async stop(stopOptions?: { drain?: boolean }) {
        log.push(`stop:${stopOptions?.drain === undefined ? 'final' : `drain=${stopOptions.drain}`}`);
        if (stopOptions?.drain) {
          await new Promise((resolve) => setTimeout(resolve, 20));
          log.push('drained');
        }
      },
    };
  };
}

function fixture(
  log: Log, seen: { options?: any }, events: (abort: () => void) => AsyncGenerator<any>,
  extraBindings: Record<string, unknown> = {},
) {
  const homes: unknown[] = [];
  let abort = () => {};
  class SDK {
    id = 'tail-thread'; startThread() { return this; } resumeThread() { return this; }
    async runStreamed() { return { events: events(() => abort()) }; }
  }
  const f = createCodexReceiptCallerFixture({ installedSdk: { Codex: SDK }, receiptBindings: {
    createCodexRunSubagentTail: recordingTail(log, seen),
    resolveCodexHomeForUser: (userId: unknown) => { homes.push(userId); return '/fixture-owner'; },
    ...extraBindings,
  } });
  abort = () => f.caller.abortCodexSession('tail-thread');
  const send = f.writer.send;
  f.writer.send = (frame: any) => { if (frame.kind === 'complete') log.push('complete'); send(frame); };
  return { f, homes };
}

test('completion waits for the drain; the final stop runs in finally; the gate follows the engine', async () => {
  const log: Log = [];
  const seen: { options?: any } = {};
  const { f, homes } = fixture(log, seen, async function* () {
    yield { type: 'thread.started', thread_id: 'tail-thread' };
    yield { type: 'turn.completed', usage: {} };
  });
  await f.run({ sessionId: null });
  assert.deepEqual(log, ['thread:tail-thread', 'stop:drain=true', 'drained', 'complete', 'stop:final']);
  assert.equal(seen.options.enabled, true, 'B-1616: an unknown engine (no catalog) fails toward visibility');
  homes.length = 0;
  seen.options.codexHome();
  assert.deepEqual(homes, [1], 'root resolved from the validated integer requester id');
});

// B-1616: features.multi_agent=false does not stop v2 models, so the tail runs on every
// v2 turn (children show in the progress bar), never on a v1 turn while the flag is off,
// and never on a model the catalog lists without an engine.
for (const [engine, enabled] of [['v2', true], ['unknown', true], ['v1', false], ['none', false]] as const) {
  test(`B-1616: the rollout tail is ${enabled ? 'enabled' : 'dormant'} on a ${engine} engine`, async () => {
    const seen: { options?: any } = {};
    const asked: unknown[][] = [];
    const logged: unknown[][] = [];
    const { f } = fixture([], seen, async function* () {
      yield { type: 'thread.started', thread_id: 'tail-thread' };
      yield { type: 'turn.completed', usage: {} };
    }, {
      resolveCodexMultiAgentEngine: async (...args: unknown[]) => { asked.push(args); return engine; },
      console: { warn() {}, error() {}, log: (...args: unknown[]) => { logged.push(args); } },
    });
    await f.run({ sessionId: null });
    assert.equal(seen.options.enabled, enabled);
    const lines = logged.filter(([message]) => message === '[Codex] multi-agent engine');
    assert.deepEqual(lines, [['[Codex] multi-agent engine',
      { engine, model: 'synthetic-model', childCap: null, tail: enabled }]], 'one line per launch, no path');
    assert.deepEqual(asked, [['/fixture-owner', 'synthetic-model']], 'engine of the run model in the requester home');
  });
}

test('a non-integer writer id never reaches the CODEX_HOME resolver', async () => {
  const log: Log = [];
  const seen: { options?: any } = {};
  const { f, homes } = fixture(log, seen, async function* () {
    yield { type: 'thread.started', thread_id: 'tail-thread' };
    yield { type: 'turn.completed', usage: {} };
  });
  f.writer.userId = '1' as any;
  await f.run({ sessionId: null });
  assert.deepEqual(homes, [null], 'the engine lookup resolves the same validated home');
  homes.length = 0;
  seen.options.codexHome();
  assert.deepEqual(homes, [null]);
});

test('a stream error skips the drain and still stops the tail in finally; no completion frame', async () => {
  const log: Log = [];
  const { f } = fixture(log, {}, async function* () {
    yield { type: 'thread.started', thread_id: 'tail-thread' };
    throw new Error('synthetic stream failure');
  });
  await f.run({ sessionId: null });
  assert.deepEqual(log, ['thread:tail-thread', 'stop:final']);
});

test('a cancelled run stops without draining and sends no completion frame', async () => {
  const log: Log = [];
  const { f } = fixture(log, {}, async function* (abort) {
    yield { type: 'thread.started', thread_id: 'tail-thread' };
    abort();
    yield { type: 'item.started', item: { id: 'i1', type: 'reasoning', text: '' } };
    yield { type: 'turn.completed', usage: {} };
  });
  await f.run({ sessionId: null });
  assert.deepEqual(log, ['thread:tail-thread', 'stop:drain=false', 'stop:final']);
});
