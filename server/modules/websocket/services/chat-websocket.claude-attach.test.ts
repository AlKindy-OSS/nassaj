// ADR-041 (B-80) integration test. Drives the real `handleChatConnection`
// dispatcher to prove the CLAUDE check-session-status path performs read-only
// differential replay (seq > lastSeq) WITHOUT swapping the writer and WITHOUT
// aborting the live run — honouring the documented `if(!isActive)` no-swap veto
// (regression 56d67f3 must stay fixed). Mirrors chat-websocket.attach.test.ts,
// retargeted from antigravity to claude (attachClaudeSDKSession +
// isClaudeSDKSessionActive on a separate SESSION_REGISTRY_claude-gated registry).

import assert from 'node:assert/strict';
import test from 'node:test';

import { handleChatConnection } from './chat-websocket.service.js';

// Inline replay double mirroring the SessionRegistry attach contract (seq>lastSeq,
// read-only). The real registry internals are covered by session-registry.test.ts;
// this integration test verifies only the service dispatch (no swap / no abort /
// differential pass-through), so it stays inside the websocket module boundary.
// `enabled` models the SESSION_REGISTRY_claude flag: when false, attach is a no-op
// returning lastSeq and records nothing, exactly like the real registry.
function makeReplayDouble({ enabled = true }: { enabled?: boolean } = {}) {
  const items: { seq: number; payload: unknown }[] = [];
  let active = false;
  return {
    open() {
      if (!enabled) return;
      active = true;
    },
    record(payload: unknown) {
      if (!enabled) return null;
      const seq = items.length + 1;
      items.push({ seq, payload });
      return seq;
    },
    setActive(value: boolean) {
      if (!enabled) return;
      active = value;
    },
    isActive() {
      if (!enabled) return false;
      return active;
    },
    attach(lastSeq: number, send: (p: unknown) => void) {
      // Real attach returns null when disabled; the production
      // attachClaudeSDKSession wrapper then coerces to lastSeq.
      if (!enabled) return lastSeq;
      let highest = lastSeq;
      for (const it of items) {
        if (it.seq > lastSeq) {
          send(it.payload);
          if (it.seq > highest) highest = it.seq;
        }
      }
      return highest;
    },
    get size() {
      return items.length;
    },
  };
}

const WS_OPEN_STATE = 1;

// Minimal raw-socket double matching the surface handleChatConnection touches.
function makeFakeWs() {
  const sent: any[] = [];
  const listeners: Record<string, ((arg: unknown) => void)[]> = {};
  return {
    readyState: WS_OPEN_STATE,
    sent,
    send(data: string) {
      sent.push(JSON.parse(data));
    },
    on(event: string, cb: (arg: unknown) => void) {
      (listeners[event] ||= []).push(cb);
    },
    emit(event: string, arg: unknown) {
      (listeners[event] || []).forEach((cb) => cb(arg));
    },
  };
}

// Build a full deps object; any function that must NOT be called on this path
// fails the test loudly if invoked.
function makeDeps(overrides: Record<string, unknown>) {
  const forbidden = (name: string) => () => {
    assert.fail(`${name} must not be called on the claude attach path`);
  };
  return {
    queryClaudeSDK: async () => {},
    spawnCursor: async () => {},
    queryCodex: async () => {},
    spawnGemini: async () => {},
    spawnAntigravity: async () => {},
    spawnOpenCode: async () => {},
    getSessionProvider: () => null,
    abortClaudeSDKSession: forbidden('abortClaudeSDKSession'),
    abortCursorSession: () => false,
    abortCodexSession: () => false,
    abortGeminiSession: () => false,
    abortAntigravitySession: () => false,
    abortOpenCodeSession: () => false,
    resolveToolApproval: () => {},
    isClaudeSDKSessionActive: () => true,
    isCursorSessionActive: () => false,
    isCodexSessionActive: () => false,
    isGeminiSessionActive: () => false,
    isAntigravitySessionActive: () => false,
    isOpenCodeSessionActive: () => false,
    // Default: a swap on the claude path is forbidden — the active-stream replay
    // path must NEVER swap. Tests that exercise the idle (legacy) path override
    // this with a recording stub.
    reconnectSessionWriter: forbidden('reconnectSessionWriter'),
    attachAntigravitySession: () => 0,
    attachClaudeSDKSession: () => 0,
    getPendingApprovalsForSession: () => [],
    getActiveClaudeSDKSessions: () => [],
    getActiveCursorSessions: () => [],
    getActiveCodexSessions: () => [],
    getActiveGeminiSessions: () => [],
    getActiveAntigravitySessions: () => [],
    getActiveOpenCodeSessions: () => [],
    ...overrides,
  } as unknown as Parameters<typeof handleChatConnection>[2];
}

// Wire a replay double into the deps so attachClaudeSDKSession/isClaudeSDKSessionActive
// read the same instance — the single-source-of-truth contract the production
// code relies on.
function depsForRegistry(
  reg: ReturnType<typeof makeReplayDouble>,
  extra: Record<string, unknown> = {},
) {
  return makeDeps({
    isClaudeSDKSessionActive: () => reg.isActive(),
    attachClaudeSDKSession: (_s: string, lastSeq: number, send: (p: unknown) => void) =>
      reg.attach(lastSeq, send),
    ...extra,
  });
}

function sendCheckStatus(
  ws: ReturnType<typeof makeFakeWs>,
  sessionId: string,
  lastSeq?: number,
) {
  ws.emit(
    'message',
    JSON.stringify({
      type: 'check-session-status',
      provider: 'claude',
      sessionId,
      ...(lastSeq === undefined ? {} : { lastSeq }),
    }),
  );
}

// (1) Disconnect mid text-stream → reconnect with lastSeq → only the delta is
// replayed, no duplication; the run is never swapped or aborted.
test('ADR-041: mid text-stream reconnect replays only seq>lastSeq, no swap/abort/dup', () => {
  const reg = makeReplayDouble();
  const sid = 'claude-live-text';
  reg.open();
  for (let i = 1; i <= 5; i += 1) {
    reg.record({ kind: 'stream_delta', content: `t${i}`, provider: 'claude', sequence: i });
  }

  const ws = makeFakeWs();
  handleChatConnection(ws as any, { user: { id: 1 } } as any, depsForRegistry(reg));

  // Client last saw seq 3 (the socket died after t3 reached it).
  sendCheckStatus(ws, sid, 3);

  const replayed = ws.sent.filter((m: any) => m.kind === 'stream_delta');
  assert.deepEqual(
    replayed.map((m: any) => m.content),
    ['t4', 't5'],
    'only seq>lastSeq replayed — no duplicate (t1..t3 withheld), no gap',
  );

  const status = ws.sent.find((m: any) => m.type === 'session-status');
  assert.ok(status, 'session-status still returned');
  assert.equal(status.isProcessing, true, 'live session reported active');
  // forbidden() stubs for reconnectSessionWriter / abortClaudeSDKSession would
  // have thrown if the path called them.
  assert.equal(reg.isActive(), true, 'session left active (never aborted)');
});

// (2) Disconnect in the middle of a tool_use → the buffered tool_use/tool_result
// pair after lastSeq is replayed in order, still no swap.
test('ADR-041: reconnect mid tool_use replays the unseen tool_use + tool_result in order', () => {
  const reg = makeReplayDouble();
  const sid = 'claude-live-tool';
  reg.open();
  reg.record({ kind: 'stream_delta', content: 'before', provider: 'claude', sequence: 1 });
  reg.record({ kind: 'tool_use', toolName: 'Bash', toolId: 'tu1', provider: 'claude', sequence: 2 });
  reg.record({ kind: 'tool_result', toolId: 'tu1', provider: 'claude', sequence: 3 });
  reg.record({ kind: 'stream_delta', content: 'after', provider: 'claude', sequence: 4 });

  const ws = makeFakeWs();
  handleChatConnection(ws as any, { user: { id: 7 } } as any, depsForRegistry(reg));

  // Client saw only seq 1 (the text before the tool call) before disconnecting.
  sendCheckStatus(ws, sid, 1);

  const kinds = ws.sent
    .filter((m: any) => ['stream_delta', 'tool_use', 'tool_result'].includes(m.kind))
    .map((m: any) => m.kind);
  assert.deepEqual(
    kinds,
    ['tool_use', 'tool_result', 'stream_delta'],
    'unseen tool_use, its result, and the trailing delta replayed oldest-first',
  );
  // 'before' (seq 1) must NOT be replayed.
  assert.equal(
    ws.sent.some((m: any) => m.content === 'before'),
    false,
    'already-seen payload (seq<=lastSeq) not replayed',
  );
  assert.equal(reg.isActive(), true, 'still active mid tool_use — never aborted/swapped');
});

// (3) Multiple mirrors: two independent reconnecting sockets each get only their
// own delta relative to their own lastSeq; neither swaps the writer.
test('ADR-041: multiple mirrors each receive their own differential slice', () => {
  const reg = makeReplayDouble();
  const sid = 'claude-live-multi';
  reg.open();
  for (let i = 1; i <= 4; i += 1) {
    reg.record({ kind: 'stream_delta', content: `m${i}`, provider: 'claude', sequence: i });
  }

  // Mirror A reconnects having seen seq 1.
  const wsA = makeFakeWs();
  handleChatConnection(wsA as any, { user: { id: 1 } } as any, depsForRegistry(reg));
  sendCheckStatus(wsA, sid, 1);

  // Mirror B reconnects having seen seq 3.
  const wsB = makeFakeWs();
  handleChatConnection(wsB as any, { user: { id: 2 } } as any, depsForRegistry(reg));
  sendCheckStatus(wsB, sid, 3);

  assert.deepEqual(
    wsA.sent.filter((m: any) => m.kind === 'stream_delta').map((m: any) => m.content),
    ['m2', 'm3', 'm4'],
    'mirror A gets seq>1',
  );
  assert.deepEqual(
    wsB.sent.filter((m: any) => m.kind === 'stream_delta').map((m: any) => m.content),
    ['m4'],
    'mirror B gets seq>3',
  );
  assert.equal(reg.isActive(), true, 'shared live session untouched by either mirror');
});

// (4) Regression guard: an IDLE claude session (isActive=false) still takes the
// LEGACY path and swaps the writer via reconnectSessionWriter. The active-stream
// replay change must not have altered idle behaviour.
test('ADR-041: idle claude still swaps the writer (legacy path unchanged)', () => {
  let swapped = false;
  const reg = makeReplayDouble();
  // Session known to the registry but terminal/inactive.
  const sid = 'claude-idle';
  reg.open();
  reg.record({ kind: 'stream_delta', content: 'done', provider: 'claude', sequence: 1 });
  reg.setActive(false);

  const ws = makeFakeWs();
  const deps = depsForRegistry(reg, {
    reconnectSessionWriter: (s: string) => {
      assert.equal(s, sid);
      swapped = true;
      return true;
    },
  });

  handleChatConnection(ws as any, { user: { id: 1 } } as any, deps);
  sendCheckStatus(ws, sid, 0);

  assert.equal(swapped, true, 'idle claude path still calls reconnectSessionWriter (no regression)');
  const status = ws.sent.find((m: any) => m.type === 'session-status');
  assert.equal(status.isProcessing, false, 'idle session reported not processing');
});

// (5) Flag OFF: the registry is disabled → attach is a no-op (nothing replayed)
// and no `sequence` is ever stamped. The active session still reports processing
// and is still NOT swapped (veto holds independent of the flag).
test('ADR-041: SESSION_REGISTRY_claude off → no replay, no sequence, no swap', () => {
  const reg = makeReplayDouble({ enabled: false });
  const sid = 'claude-flag-off';
  // open()/record() are no-ops while disabled; the live run is still active per
  // the legacy isClaudeSDKSessionActive (which we force true to model an active
  // run whose registry is simply not engaged).
  reg.open();
  reg.record({ kind: 'stream_delta', content: 'x1', provider: 'claude' });

  const ws = makeFakeWs();
  const deps = depsForRegistry(reg, {
    // Active run, but the registry flag is off — model the legacy active state.
    isClaudeSDKSessionActive: () => true,
  });

  handleChatConnection(ws as any, { user: { id: 1 } } as any, deps);
  sendCheckStatus(ws, sid, 0);

  assert.equal(
    ws.sent.some((m: any) => m.kind === 'stream_delta'),
    false,
    'flag off → attach replays nothing',
  );
  assert.equal(
    ws.sent.some((m: any) => typeof m.sequence === 'number'),
    false,
    'flag off → no payload carries a sequence',
  );
  const status = ws.sent.find((m: any) => m.type === 'session-status');
  assert.ok(status, 'session-status still returned with flag off');
  assert.equal(status.isProcessing, true, 'active run still reported processing');
  // reconnectSessionWriter is forbidden() here (active run) — if the off-path had
  // wrongly attempted a swap on an active session it would have thrown.
});
