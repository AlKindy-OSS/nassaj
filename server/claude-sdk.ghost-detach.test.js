// ADR-042 (B-80c): ghost-session DETACH (not abort) unit tests.
//
// Covers the test plan in docs/decisions/042-claude-ghost-session-detach-b80c.md:
//   (a) a session with no listener past the grace period → detached AND excluded
//       from the drain-blocking set, while STILL present in the display set.
//   (b) a live mirror (or live primary socket) → never detached.
//   (c) the flag OFF → ghostDetachEnabled() false (sweep never auto-starts; the
//       drain in index.js keeps using getActiveClaudeSDKSessions()).
//   (d) detach calls NO abort/interrupt/close/kill on the SDK query — the
//       generator is left to complete and write jsonl.
//   + listener-recovery resets the grace clock, and timer teardown on empty.
//
// The sweep is driven with an explicit `now` so the grace window is exercised
// deterministically without real timers. Sessions are injected through the real
// addSession/removeSession production paths (faithful, not a synthetic backdoor).

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  addSession,
  removeSession,
  getSession,
  sweepGhostSessions,
  getActiveClaudeSDKSessions,
  getDrainBlockingClaudeSessions,
  ghostDetachEnabled,
} from './claude-sdk.js';
import {
  addSessionMirror,
} from './modules/websocket/services/websocket-writer.service.js';

const WS_OPEN = 1;
const WS_CLOSED = 3;
const GRACE_MS = 180000; // matches GHOST_DETACH_GRACE_MS default in claude-sdk.js.

// Fake WebSocketWriter exposing only what the sweep reads: isPrimarySocketAlive().
function fakeWriter(socketOpen) {
  return {
    isPrimarySocketAlive() {
      return socketOpen;
    },
  };
}

// Fake SDK query instance whose abort surfaces are spied on. The sweep must
// NEVER touch any of these (detach ≠ abort).
function fakeQueryInstance() {
  const calls = { interrupt: 0, close: 0, kill: 0, return: 0, throw: 0 };
  return {
    calls,
    interrupt() { calls.interrupt += 1; },
    close() { calls.close += 1; },
    kill() { calls.kill += 1; },
    return() { calls.return += 1; },
    throw() { calls.throw += 1; },
  };
}

// Register a session via the real production path, then return its handle.
// runTag omitted ⇒ no process-monitor registration / no real child spawned.
function registerSession(sid, { socketOpen }) {
  const qi = fakeQueryInstance();
  addSession(sid, qi, [], null, fakeWriter(socketOpen));
  return { qi, session: getSession(sid) };
}

function makeMirror(readyState) {
  return { readyState, send() {} };
}

// ── (a) no listener past grace → detached + excluded from drain, kept in display ──
test('ADR-042(a): a no-listener session is detached after grace and excluded from the drain set', () => {
  const sid = 'ghost-a';
  const { session } = registerSession(sid, { socketOpen: false }); // primary dead, no mirror
  try {
    const t0 = 1_000_000;
    // First sweep: no listener → starts the grace clock, NOT yet detached.
    sweepGhostSessions(t0);
    assert.equal(session.detached, false, 'must not detach before grace elapses');
    assert.equal(session.noListenerSince, t0, 'grace clock started');
    assert.ok(getDrainBlockingClaudeSessions().includes(sid), 'still drain-blocking pre-grace');

    // Sweep again just before grace fully elapses → still not detached.
    sweepGhostSessions(t0 + GRACE_MS - 1);
    assert.equal(session.detached, false, 'still not detached one ms before grace');

    // Sweep at/after grace → detached.
    sweepGhostSessions(t0 + GRACE_MS);
    assert.equal(session.detached, true, 'detached at grace boundary');

    // Excluded from the DRAIN-blocking set, but STILL in the DISPLAY set.
    assert.ok(!getDrainBlockingClaudeSessions().includes(sid), 'detached ⇒ not drain-blocking');
    assert.ok(getActiveClaudeSDKSessions().includes(sid), 'detached ⇒ still active for display');
  } finally {
    removeSession(sid);
  }
});

// ── (b) live listener → never detached (mirror alive) ──
test('ADR-042(b): a session with a LIVE MIRROR is never detached, even past grace', () => {
  const sid = 'ghost-b-mirror';
  const { session } = registerSession(sid, { socketOpen: false }); // primary dead…
  addSessionMirror(sid, makeMirror(WS_OPEN)); // …but a live mirror exists
  try {
    const t0 = 2_000_000;
    sweepGhostSessions(t0);
    sweepGhostSessions(t0 + GRACE_MS + 99999);
    assert.equal(session.noListenerSince, null, 'a live mirror keeps the grace clock null');
    assert.equal(session.detached, false, 'never detached while a mirror is live');
    assert.ok(getDrainBlockingClaudeSessions().includes(sid), 'remains drain-blocking');
  } finally {
    removeSession(sid);
  }
});

// ── (b') live primary socket → never detached ──
test('ADR-042(b′): a session with a LIVE PRIMARY socket is never detached', () => {
  const sid = 'ghost-b-primary';
  const { session } = registerSession(sid, { socketOpen: true }); // primary alive
  try {
    const t0 = 3_000_000;
    sweepGhostSessions(t0);
    sweepGhostSessions(t0 + GRACE_MS + 50000);
    assert.equal(session.detached, false, 'live primary ⇒ never detached');
    assert.equal(session.noListenerSince, null, 'live primary keeps grace clock null');
  } finally {
    removeSession(sid);
  }
});

// ── (d) detach performs NO abort/interrupt/close/kill on the SDK query ──
test('ADR-042(d): detaching never aborts the run (no interrupt/close/kill/return/throw)', () => {
  const sid = 'ghost-d';
  const { qi, session } = registerSession(sid, { socketOpen: false });
  try {
    const t0 = 4_000_000;
    sweepGhostSessions(t0);
    sweepGhostSessions(t0 + GRACE_MS);
    assert.equal(session.detached, true, 'precondition: it did detach');
    // The crux of ADR-042: detach ≠ abort. The generator is left running.
    assert.deepEqual(qi.calls, { interrupt: 0, close: 0, kill: 0, return: 0, throw: 0 },
      'sweep must not call any abort surface on the query instance');
    // The query instance is still the session's live instance (not torn down).
    assert.equal(session.instance, qi, 'instance reference is untouched');
  } finally {
    removeSession(sid);
  }
});

// ── listener recovery resets the grace clock (no detach) ──
test('ADR-042: a returning listener resets the grace clock and prevents detach', () => {
  const sid = 'ghost-recover';
  const { session } = registerSession(sid, { socketOpen: false });
  try {
    const t0 = 5_000_000;
    sweepGhostSessions(t0); // no listener → clock starts
    assert.equal(session.noListenerSince, t0);

    // A mirror comes back before grace elapses.
    addSessionMirror(sid, makeMirror(WS_OPEN));
    sweepGhostSessions(t0 + 60000); // within grace, listener present again
    assert.equal(session.noListenerSince, null, 'clock reset on listener recovery');
    assert.equal(session.lastListenerSeenAt, t0 + 60000, 'lastListenerSeenAt refreshed');

    // Even sweeping far past the original grace window: not detached.
    sweepGhostSessions(t0 + GRACE_MS + 60001);
    assert.equal(session.detached, false, 'recovered session is never detached');
  } finally {
    removeSession(sid);
  }
});

// ── once detached, a session stays skipped (idempotent, no re-processing) ──
test('ADR-042: an already-detached session is skipped on subsequent sweeps', () => {
  const sid = 'ghost-idempotent';
  const { qi, session } = registerSession(sid, { socketOpen: false });
  try {
    const t0 = 6_000_000;
    sweepGhostSessions(t0);
    sweepGhostSessions(t0 + GRACE_MS);
    assert.equal(session.detached, true);
    // Further sweeps are a no-op for it (still no abort, still detached).
    sweepGhostSessions(t0 + GRACE_MS + 999999);
    assert.equal(session.detached, true);
    assert.deepEqual(qi.calls, { interrupt: 0, close: 0, kill: 0, return: 0, throw: 0 });
  } finally {
    removeSession(sid);
  }
});

// ── (c) the flag is OFF by default → ghostDetachEnabled() is false ──
test('ADR-042(c): CLAUDE_GHOST_DETACH defaults OFF (ghostDetachEnabled() === false)', () => {
  const prev = process.env.CLAUDE_GHOST_DETACH;
  delete process.env.CLAUDE_GHOST_DETACH;
  try {
    assert.equal(ghostDetachEnabled(), false, 'unset ⇒ disabled');
    process.env.CLAUDE_GHOST_DETACH = 'false';
    assert.equal(ghostDetachEnabled(), false, "'false' ⇒ disabled");
    process.env.CLAUDE_GHOST_DETACH = '0';
    assert.equal(ghostDetachEnabled(), false, "'0' ⇒ disabled");
    process.env.CLAUDE_GHOST_DETACH = 'maybe';
    assert.equal(ghostDetachEnabled(), false, 'unrecognised ⇒ disabled');
    // And the enabling values flip it on (so the gate is real, not stuck off).
    for (const on of ['1', 'true', 'yes', 'on', ' ON ', 'TRUE']) {
      process.env.CLAUDE_GHOST_DETACH = on;
      assert.equal(ghostDetachEnabled(), true, `'${on}' ⇒ enabled`);
    }
  } finally {
    if (prev === undefined) delete process.env.CLAUDE_GHOST_DETACH;
    else process.env.CLAUDE_GHOST_DETACH = prev;
  }
});

// ── (c) when the flag is OFF, the drain count source equals the active set ──
// Mirrors index.js: claude = (ghostDetachEnabled() ? drainBlocking : active).length
test('ADR-042(c): flag OFF ⇒ the index.js drain expression equals getActiveClaudeSDKSessions()', () => {
  const sid = 'ghost-flagoff';
  const prev = process.env.CLAUDE_GHOST_DETACH;
  delete process.env.CLAUDE_GHOST_DETACH;
  const { session } = registerSession(sid, { socketOpen: false });
  try {
    // Force the session detached to prove the OFF branch ignores `detached`.
    session.detached = true;
    const drainCount = (ghostDetachEnabled()
      ? getDrainBlockingClaudeSessions()
      : getActiveClaudeSDKSessions()).length;
    assert.equal(ghostDetachEnabled(), false);
    assert.equal(drainCount, getActiveClaudeSDKSessions().length,
      'OFF branch counts every active session (detached included)');
    assert.ok(getActiveClaudeSDKSessions().includes(sid));
  } finally {
    removeSession(sid);
    if (prev === undefined) delete process.env.CLAUDE_GHOST_DETACH;
    else process.env.CLAUDE_GHOST_DETACH = prev;
  }
});

// ── sweep on an empty map is a safe no-op (timer teardown path) ──
test('ADR-042: sweepGhostSessions on an empty activeSessions is a no-op', () => {
  // No sessions registered in this test's scope; the production sweep just
  // returns (and stops the timer). Must not throw.
  assert.doesNotThrow(() => sweepGhostSessions(Date.now()));
});
