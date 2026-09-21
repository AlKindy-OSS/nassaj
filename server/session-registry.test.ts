// PHASE-SR-0 test gate (ADR-021). Covers the three mandatory tests against the
// SessionRegistry seam that backs B-N5 / B-N7 / B-N-ATTACH for agy.

import assert from 'node:assert/strict';
import test from 'node:test';

import { SessionRegistry, RingBuffer, MAX_LIVE_SESSIONS } from './session-registry.js';

const FLAG = 'SESSION_REGISTRY_test';

function withFlag<T>(value: boolean, fn: () => T): T {
  const prev = process.env[FLAG];
  process.env[FLAG] = value ? '1' : '0';
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env[FLAG];
    else process.env[FLAG] = prev;
  }
}

// ---------------------------------------------------------------------------
// B-N5 — rekey: a message buffered before sessionId survives the rekey, with no
// loss and no duplication; rekey onto an existing sessionId never interleaves two
// runs into a corrupt stream.
// ---------------------------------------------------------------------------

test('B-N5 rekey: payload buffered under connectionId moves to sessionId without loss or duplication', () => {
  withFlag(true, () => {
    const reg = new SessionRegistry(FLAG);
    const conn = 'conn-1';
    const sid = 'session-1';

    // Emitted BEFORE the real sessionId is known — keyed by connectionId.
    reg.open(conn);
    const seq1 = reg.record(conn, { kind: 'stream_delta', content: 'pre-A' });
    const seq2 = reg.record(conn, { kind: 'stream_delta', content: 'pre-B' });
    assert.equal(seq1, 1);
    assert.equal(seq2, 2);

    // sessionId arrives -> rekey.
    reg.rekey(conn, sid);

    // A payload emitted after rekey, addressed by sessionId.
    reg.record(sid, { kind: 'stream_delta', content: 'post-C' });

    // Differential replay from scratch must see ALL three, in order, once each.
    const replayed: any[] = [];
    const highest = reg.attach(sid, 0, (p: any) => replayed.push(p));

    assert.deepEqual(replayed.map((p: any) => p.content), ['pre-A', 'pre-B', 'post-C']);
    assert.equal(highest, 3);
    // Old key is gone — no duplicate slot.
    assert.equal(reg.attach(conn, 0, () => {}), null);
  });
});

test('B-N5 rekey: onto an existing populated key throws (no silent merge of two runs)', () => {
  withFlag(true, () => {
    const reg = new SessionRegistry(FLAG);
    const conn = 'conn-2';
    const sid = 'session-2';

    // The production caller always clears a prior same-sessionId entry (drop +
    // open) BEFORE rekeying a fresh connectionId onto it (B-N-RESUME clean
    // buffer). A live target here means two distinct runs are racing one
    // sessionId, so rekey must REFUSE rather than corrupt the stream by merging.
    reg.record(sid, { kind: 'stream_delta', content: 'existing-1' });
    reg.record(conn, { kind: 'stream_delta', content: 'temp-1' });

    assert.throws(() => reg.rekey(conn, sid), /rekey collision/);

    // Neither side was mutated by the refused rekey: both keys intact.
    const target: string[] = [];
    reg.attach(sid, 0, (p: any) => target.push(p.content));
    assert.deepEqual(target, ['existing-1']);
    const temp: string[] = [];
    reg.attach(conn, 0, (p: any) => temp.push(p.content));
    assert.deepEqual(temp, ['temp-1']);
  });
});

// ---------------------------------------------------------------------------
// B-N7 — single source of truth: start/end flips one `active` flag that both
// the attach lookup and (future) drain read.
// ---------------------------------------------------------------------------

test('B-N7 single source: open/setActive is the one active flag read everywhere', () => {
  withFlag(true, () => {
    const reg = new SessionRegistry(FLAG);
    const sid = 'session-3';

    assert.equal(reg.isActive(sid), false, 'unknown session is inactive');

    reg.open(sid); // spawn
    assert.equal(reg.isActive(sid), true, 'active after open');

    reg.setActive(sid, false); // terminal (close/error)
    assert.equal(reg.isActive(sid), false, 'inactive after terminal');

    // The same flag survives rekey so attach + drain never diverge.
    const conn = 'conn-3';
    reg.open(conn);
    assert.equal(reg.isActive(conn), true);
    reg.rekey(conn, 'session-3b');
    assert.equal(reg.isActive('session-3b'), true, 'active flag carried through rekey');
    assert.equal(reg.isActive(conn), false, 'old key no longer active');
  });
});

// ---------------------------------------------------------------------------
// B-N-ATTACH — differential replay: only seq > lastSeq, no duplicate, no gap,
// and attach is strictly read-only (no swap/abort hooks exist on the registry).
// ---------------------------------------------------------------------------

test('attach-replay differential: only seq > lastSeq, no duplicate, no gap', () => {
  withFlag(true, () => {
    const reg = new SessionRegistry(FLAG);
    const sid = 'session-4';

    reg.open(sid);
    for (let i = 1; i <= 5; i += 1) {
      reg.record(sid, { kind: 'stream_delta', content: `m${i}` });
    }

    // Client already saw up to seq 3 -> must receive only 4 and 5.
    const replayed: string[] = [];
    const highest = reg.attach(sid, 3, (p: any) => replayed.push(p.content));
    assert.deepEqual(replayed, ['m4', 'm5'], 'no duplicate of already-seen, no gap');
    assert.equal(highest, 5);

    // Replaying again from the new high-water mark yields nothing (no duplication).
    const second: string[] = [];
    const stillHighest = reg.attach(sid, highest, (p: any) => second.push(p));
    assert.deepEqual(second, []);
    assert.equal(stillHighest, 5);

    // attach does not mutate the buffer (still re-readable from 0).
    const full: string[] = [];
    reg.attach(sid, 0, (p: any) => full.push(p.content));
    assert.deepEqual(full, ['m1', 'm2', 'm3', 'm4', 'm5']);
  });
});

test('attach-replay differential: live session stays active across attach (no abort/swap)', () => {
  withFlag(true, () => {
    const reg = new SessionRegistry(FLAG);
    const sid = 'session-5';
    reg.open(sid);
    reg.record(sid, { kind: 'stream_delta', content: 'a' });

    assert.equal(reg.isActive(sid), true, 'active before attach');
    reg.attach(sid, 0, () => {});
    // Read-only: the active flag is untouched by attach (no abort), and the
    // registry exposes no writer-swap surface at all.
    assert.equal(reg.isActive(sid), true, 'still active after attach — no abort');
    assert.equal((reg as any).reconnectSessionWriter, undefined);
    assert.equal((reg as any).swap, undefined);

    // A subsequent live payload after attach continues the SAME seq line — the
    // attach did not fork or reset the stream.
    const seq = reg.record(sid, { kind: 'stream_delta', content: 'b' });
    assert.equal(seq, 2);
  });
});

// ---------------------------------------------------------------------------
// Coexistence: flag OFF == no-op (legacy behavior preserved).
// ---------------------------------------------------------------------------

test('flag off: every registry method is an inert no-op', () => {
  withFlag(false, () => {
    const reg = new SessionRegistry(FLAG);
    assert.equal(reg.enabled, false);
    assert.equal(reg.open('k'), null);
    assert.equal(reg.record('k', { x: 1 }), null);
    assert.equal(reg.isActive('k'), false);
    reg.setActive('k', true);
    assert.equal(reg.isActive('k'), false);
    assert.equal(reg.attach('k', 0, () => assert.fail('must not replay')), null);
    assert.equal(reg.lastSeq('k'), 0);
  });
});

// ---------------------------------------------------------------------------
// RingBuffer invariants (eviction must not corrupt differential replay).
// ---------------------------------------------------------------------------

test('RingBuffer: monotonic seq survives eviction; since() never replays evicted-but-seen', () => {
  const rb = new RingBuffer(3);
  for (let i = 1; i <= 5; i += 1) rb.push({ n: i });
  // Capacity 3 -> only the last three retained, but seq keeps climbing.
  assert.equal(rb.lastSeq, 5);
  assert.deepEqual(rb.since(0).map((it) => it.seq), [3, 4, 5]);
  assert.deepEqual(rb.since(4).map((it) => it.seq), [5]);
  assert.deepEqual(rb.since(5), []);
});

// ---------------------------------------------------------------------------
// B-N-DROP — drop() removes an entry; a subsequent open() re-initialises a fresh
// empty entry (the registry primitive the agy-cli post-close TTL drop builds on).
// ---------------------------------------------------------------------------

test('B-N-DROP: drop removes the entry; open after drop starts a fresh seq line', () => {
  withFlag(true, () => {
    const reg = new SessionRegistry(FLAG);
    const sid = 'session-drop';

    reg.open(sid);
    reg.record(sid, { kind: 'stream_delta', content: 'old-1' });
    reg.record(sid, { kind: 'stream_delta', content: 'old-2' });
    assert.equal(reg.lastSeq(sid), 2);

    reg.drop(sid);
    // After drop the session is unknown: no replay, inactive, seq reset.
    assert.equal(reg.attach(sid, 0, () => assert.fail('dropped entry must not replay')), null);
    assert.equal(reg.isActive(sid), false);
    assert.equal(reg.lastSeq(sid), 0);

    // A fresh run reopens a clean entry whose seq starts at 0 again.
    reg.open(sid);
    const seq = reg.record(sid, { kind: 'stream_delta', content: 'new-1' });
    assert.equal(seq, 1, 'seq line restarts after drop+open');
    const replayed: string[] = [];
    reg.attach(sid, 0, (p: any) => replayed.push(p.content));
    assert.deepEqual(replayed, ['new-1'], 'no old payload survives drop');
  });
});

// ---------------------------------------------------------------------------
// B-N-RESUME (registry contract): drop + open is exactly the clean-buffer reset
// the agy-cli resume path performs, and a fresh entry never carries a prior run's
// transcript even when replayed with lastSeq absent/0.
// ---------------------------------------------------------------------------

test('B-N-RESUME: a clean (drop+open) entry replays only the current run from 0', () => {
  withFlag(true, () => {
    const reg = new SessionRegistry(FLAG);
    const sid = 'session-resume';

    // Run 1 terminates (active=false) with a buffered transcript.
    reg.open(sid);
    reg.record(sid, { kind: 'stream_delta', content: 'run1-a' });
    reg.record(sid, { kind: 'stream_delta', content: 'run1-b' });
    reg.setActive(sid, false);

    // Resume: the caller clears the stale inactive entry then reopens.
    assert.equal(reg.isActive(sid), false);
    reg.drop(sid);
    reg.open(sid);
    reg.record(sid, { kind: 'stream_delta', content: 'run2-a' });

    // lastSeq absent/0 = "replay current run from its start" — bounded to run 2,
    // never run 1's transcript (clean buffer does not cross the run boundary).
    const replayed: string[] = [];
    reg.attach(sid, 0, (p: any) => replayed.push(p.content));
    assert.deepEqual(replayed, ['run2-a']);
  });
});

// ---------------------------------------------------------------------------
// B-N-EVICT — live-session cap: the LRU INACTIVE entry is evicted first; an
// all-active registry is never trimmed (evicting a live session breaks attach).
// ---------------------------------------------------------------------------

test('B-N-EVICT: exceeding the cap evicts the least-recently-used INACTIVE entry', () => {
  withFlag(true, () => {
    const reg = new SessionRegistry(FLAG, { maxEntries: 3 });

    // Fill to cap: s0 (inactive, oldest), s1 (inactive), s2 (active).
    reg.open('s0'); reg.setActive('s0', false);
    reg.open('s1'); reg.setActive('s1', false);
    reg.open('s2'); // stays active
    assert.equal(reg.entries.size, 3);

    // Inserting s3 must evict the LRU inactive entry = s0 (touched first).
    reg.open('s3');
    assert.equal(reg.entries.size, 3);
    assert.equal(reg.entries.has('s0'), false, 'LRU inactive s0 evicted');
    assert.equal(reg.entries.has('s1'), true);
    assert.equal(reg.entries.has('s2'), true, 'active session never evicted');
    assert.equal(reg.entries.has('s3'), true);
  });
});

test('B-N-EVICT: recency is bumped on touch — a re-recorded inactive entry survives over an older one', () => {
  withFlag(true, () => {
    const reg = new SessionRegistry(FLAG, { maxEntries: 2 });

    reg.open('a'); reg.setActive('a', false); // oldest touch
    reg.open('b'); reg.setActive('b', false);
    // Touch 'a' again so 'b' becomes the least-recently-used inactive entry.
    reg.record('a', { kind: 'stream_delta', content: 'x' });

    reg.open('c'); // forces an eviction
    assert.equal(reg.entries.has('b'), false, 'now-LRU b evicted');
    assert.equal(reg.entries.has('a'), true, 'recently-touched a survives');
    assert.equal(reg.entries.has('c'), true);
  });
});

test('B-N-EVICT: an all-active registry at cap evicts nothing (live sessions protected)', () => {
  withFlag(true, () => {
    const reg = new SessionRegistry(FLAG, { maxEntries: 2 });
    reg.open('live-1'); // active
    reg.open('live-2'); // active
    // Cap reached, both active: insertion must NOT evict a live session. The map
    // is allowed to exceed the cap rather than break a concurrent attach/drain.
    reg.open('live-3');
    assert.equal(reg.entries.has('live-1'), true);
    assert.equal(reg.entries.has('live-2'), true);
    assert.equal(reg.entries.has('live-3'), true);
    assert.equal(reg.entries.size, 3, 'no live session dropped; cap exceeded instead');
  });
});

test('B-N-EVICT: default cap constant is exported and applied', () => {
  withFlag(true, () => {
    assert.equal(typeof MAX_LIVE_SESSIONS, 'number');
    const reg = new SessionRegistry(FLAG);
    assert.equal(reg.maxEntries, MAX_LIVE_SESSIONS);
  });
});

// ---------------------------------------------------------------------------
// B-N7 single source (flag on/off): isActive is the lone authority. There is no
// second active surface inside the registry to diverge from.
// ---------------------------------------------------------------------------

test('B-N7 single source: isActive reflects open/setActive when the flag is ON', () => {
  withFlag(true, () => {
    const reg = new SessionRegistry(FLAG);
    const sid = 'session-bn7-on';
    assert.equal(reg.isActive(sid), false);
    reg.open(sid);
    assert.equal(reg.isActive(sid), true, 'one flag flips active on open');
    reg.setActive(sid, false);
    assert.equal(reg.isActive(sid), false, 'same flag flips inactive on terminal');
  });
});

test('B-N7 single source: with the flag OFF the registry is inert (legacy map is the only authority)', () => {
  withFlag(false, () => {
    const reg = new SessionRegistry(FLAG);
    // Disabled: the registry never reports active, so the agy-cli caller falls
    // through to its legacy activeSessions map — byte-for-byte the old behavior.
    reg.open('k');
    assert.equal(reg.isActive('k'), false, 'disabled registry is never the authority');
  });
});
