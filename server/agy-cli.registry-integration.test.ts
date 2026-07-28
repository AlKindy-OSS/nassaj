// PHASE-SR-0 REAL integration test (ADR-021 / qa-critic veto gate, commit 423f2b8).
//
// WHAT THIS COVERS THAT THE EXISTING TESTS DO NOT
// -----------------------------------------------
// * session-registry.test.ts drives the SessionRegistry primitives DIRECTLY
//   (reg.open / reg.rekey / reg.attach), never the production ordering inside
//   spawnAntigravity.
// * chat-websocket.attach.test.ts injects a local replay DOUBLE and a stubbed
//   `attachAntigravitySession`, so the real chain is never touched.
//
// This test runs the REAL `spawnAntigravity` against the REAL `agySessionRegistry`
// with the flag SESSION_REGISTRY_agy ENABLED, stubbing ONLY the process boundary
// (child_process.spawn) and the genuine side-effect collaborators (sessionManager,
// database, notifications, project-registry). Everything that the veto is about —
// connectionId open → record → rekey → registryKey open → safeSend(record) →
// close → setActive(false), the differential attach, the clean-buffer drop, and
// LRU eviction — executes the production code path unmodified.
//
// The mocks are registered via node:test module mocks (the test runner is invoked
// with --experimental-test-module-mocks) BEFORE the dynamic import of agy-cli.js,
// so the SUT links against them.

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import os from 'node:os';
import path from 'node:path';
import { mkdtempSync } from 'node:fs';
import test, { mock, before, beforeEach, after } from 'node:test';

// ---------------------------------------------------------------------------
// Process-boundary double: a fake child process whose stdout/stderr/close the
// test drives deterministically. This is the ONLY seam stubbed at the OS edge.
// ---------------------------------------------------------------------------
class FakeChildProcess extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  killed = false;
  kill() {
    this.killed = true;
    return true;
  }
  // Drive a stream_delta chunk through the real stdout 'data' handler.
  emitStdout(text: string) {
    this.stdout.emit('data', Buffer.from(text, 'utf8'));
  }
  // Drive the terminal close through the real 'close' handler.
  emitClose(code = 0) {
    this.emit('close', code);
  }
}

// A deferred the spawn mock resolves the instant child_process.spawn() is invoked.
// The test awaits that deferred instead of polling a tick budget, so it is immune
// to CPU contention from concurrent test files (the cause of a full-suite-only
// flake under --test-concurrency before this was introduced).
let spawnSignal: { promise: Promise<FakeChildProcess>; resolve: (c: FakeChildProcess) => void };
function armSpawnSignal() {
  let resolve!: (c: FakeChildProcess) => void;
  const promise = new Promise<FakeChildProcess>((r) => { resolve = r; });
  spawnSignal = { promise, resolve };
}
const spawnCalls: { bin: string; args: string[] }[] = [];

// ---------------------------------------------------------------------------
// Side-effect collaborator doubles. These are the genuine IO boundaries
// (DB writes, OS notifications, in-process project binding, the chat-history
// session store). The registry, createNormalizedMessage, isolation env resolver
// and ALL B-N5/B-N7/drop/evict logic remain the REAL implementations.
// ---------------------------------------------------------------------------
const sessionStore = new Map<string, any>();
const dbRows = new Map<string, any>();

let HOME_DIR = '';

let spawnAntigravity: typeof import('./agy-cli.js').spawnAntigravity;
let attachAntigravitySession: typeof import('./agy-cli.js').attachAntigravitySession;
let isAntigravitySessionActive: typeof import('./agy-cli.js').isAntigravitySessionActive;
let agySessionRegistry: typeof import('./agy-cli.js').agySessionRegistry;

before(async () => {
  // Real, empty brain dir on a temp HOME so listBrainIds()/brainExists() do real
  // (but inert) filesystem reads — a fresh conversation is correctly detected and
  // no resume path is taken.
  HOME_DIR = mkdtempSync(path.join(os.tmpdir(), 'agy-reg-it-'));
  process.env.HOME = HOME_DIR;
  // Enable the registry: this is the whole point — the REAL gated path runs.
  process.env.SESSION_REGISTRY_agy = '1';

  // agy-cli.js imports from 'child_process' (no node: prefix). tsx resolves the
  // bare and node:-prefixed specifiers to the SAME module, so mocking one spelling
  // covers both; mocking both throws "already mocked".
  mock.module('child_process', {
    namedExports: {
      spawn: (bin: string, args: string[]) => {
        spawnCalls.push({ bin, args });
        const child = new FakeChildProcess();
        spawnSignal?.resolve(child);
        return child as unknown as ReturnType<typeof import('node:child_process').spawn>;
      },
    },
  });

  // sessionManager: minimal in-memory chat-history store (true side effect).
  const fakeSessionManager = {
    getSession: (id: string) => sessionStore.get(id) ?? null,
    createSession: (id: string, _cwd: string) => {
      if (!sessionStore.has(id)) sessionStore.set(id, { id, messages: [] });
    },
    saveSession: () => {},
    addMessage: (id: string, role: string, content: string) => {
      const s = sessionStore.get(id);
      if (s) s.messages.push({ role, content });
    },
  };
  mock.module('./sessionManager.js', {
    defaultExport: fakeSessionManager,
    namedExports: { ready: Promise.resolve() },
  });

  // database: mock ONLY the two leaf repositories agy-cli writes through, so the
  // real barrel (`./modules/database/index.js`) re-exports these doubles while
  // every OTHER consumer's import (appConfigDb / auditLogDb / userDb, used by the
  // REAL provider-sharing + isolation modules we deliberately keep live) stays
  // intact. getConnection() is lazy (per-method), so importing the real barrel
  // never opens sqlite as long as those real repos are never invoked — and they
  // are not on the null-userId (shared) path the ws double drives.
  mock.module('@/modules/database/repositories/participants.db.js', {
    namedExports: { participantsDb: { recordSpawn: () => {} } },
  });
  mock.module('@/modules/database/repositories/sessions.db.js', {
    namedExports: {
      sessionsDb: {
        getSessionById: (id: string) => dbRows.get(id) ?? null,
        createSession: (id: string, provider: string, cwd: string) => {
          dbRows.set(id, { session_id: id, provider, cwd, jsonl_path: null });
        },
      },
    },
  });

  // project-registry: in-process binding only — no persistence to assert here.
  mock.module('./modules/providers/list/antigravity/antigravity-project-registry.js', {
    namedExports: {
      registerAntigravityProjectPath: () => {},
      clearAntigravityProjectPath: () => {},
    },
  });

  // notifications: OS push side effect — inert in tests.
  mock.module('./services/notification-orchestrator.js', {
    namedExports: {
      notifyRunStopped: () => {},
      notifyRunFailed: () => {},
    },
  });

  const mod = await import('./agy-cli.js');
  spawnAntigravity = mod.spawnAntigravity;
  attachAntigravitySession = mod.attachAntigravitySession;
  isAntigravitySessionActive = mod.isAntigravitySessionActive;
  agySessionRegistry = mod.agySessionRegistry;
});

after(() => {
  delete process.env.SESSION_REGISTRY_agy;
});

beforeEach(() => {
  sessionStore.clear();
  dbRows.clear();
  spawnCalls.length = 0;
  // Clear any registry entries left by a prior test so keys never collide.
  for (const key of [...agySessionRegistry.entries.keys()]) {
    agySessionRegistry.drop(key);
  }
});

// A WebSocketWriter-like double: spawnAntigravity reads ws.ws (raw socket) for the
// connectionId, ws.userId for isolation (left undefined → shared, no IO), and
// ws.send for live forwarding. We capture forwarded payloads to prove the live
// path AND the buffered path agree.
function makeWs() {
  const raw = {}; // a fresh raw socket → a fresh connectionId each ws
  const forwarded: any[] = [];
  return {
    ws: raw,
    forwarded,
    send(msg: any) {
      forwarded.push(msg);
    },
  };
}

// Run spawnAntigravity, then drive the fake process to completion. Returns once
// the spawn promise resolves (i.e. after the real 'close' handler ran).
async function runSpawn(
  command: string,
  opts: Record<string, unknown>,
  ws: ReturnType<typeof makeWs>,
  drive: (child: FakeChildProcess) => void,
) {
  const cwd = (opts.cwd as string) || HOME_DIR;
  // Arm a fresh deferred BEFORE the call so the spawn mock resolves it the instant
  // child_process.spawn() runs, regardless of how long spawnAntigravity's pre-spawn
  // awaits (listBrainIds / buildInstructionsPrefix) take under load. Awaiting the
  // deferred — not a fixed tick budget — is what makes this deterministic in the
  // concurrent full suite.
  armSpawnSignal();
  const promise = spawnAntigravity(command, { ...opts, cwd }, ws as any);
  const child = await spawnSignal.promise;
  drive(child);
  return promise;
}

// ===========================================================================
// 1. REAL rekey with no loss / no duplication (qa-critic gate #1).
//    Drives the PRODUCTION ordering inside spawnAntigravity:
//      connectionIdFor(ws) → open(connectionId) → resolve finalSessionId →
//      rekey(connectionId, sessionId) → open(registryKey=sessionId) →
//      safeSend(record under registryKey).
//    NOTE (finding, see FINDINGS at the bottom): in this flow finalSessionId is
//    resolved SYNCHRONOUSLY before any stdout, so the connectionId entry is still
//    EMPTY when rekey() fires — the whole transcript is recorded under the
//    sessionId. This test therefore proves the real spawn path produces the full
//    run under the sessionId with no loss / no duplicate, and that the temporary
//    connectionId slot is handed over (not duplicated). The complementary
//    "populated-preamble survives rekey" property — the buffer-before-sessionId
//    case the B-N5 comment anticipates — is proven directly against the SAME real
//    agySessionRegistry instance in test 1b, because no public spawn entry point
//    records under the connectionId before rekey.
// ===========================================================================
test('REAL rekey: a stream_delta buffered under connectionId surfaces under sessionId via real attach, once', async () => {
  const ws = makeWs();
  // Fresh session (no sessionId) → spawnAntigravity mints one and rekeys the
  // connectionId buffer onto it. We capture the minted id from session_created.
  await runSpawn('hello', { projectPath: HOME_DIR }, ws, (child) => {
    // First stdout chunk: for a NEW session this triggers session_created AND the
    // first stream_delta — both recorded under the registry key. The
    // session_created is emitted under registryKey (already rekeyed to sessionId
    // by the time stdout fires, since rekey happens before the spawn Promise's
    // stdout handler runs).
    child.emitStdout('PART-ONE ');
    child.emitStdout('PART-TWO');
    child.emitClose(0);
  });

  // Recover the minted sessionId from the forwarded session_created envelope.
  const created = ws.forwarded.find((m) => m.kind === 'session_created');
  assert.ok(created, 'session_created was forwarded');
  const sid = created.newSessionId as string;
  assert.ok(sid && sid.startsWith('agy_'), 'a fresh agy sessionId was minted');

  // The connectionId is now empty/gone; the buffer lives under the sessionId.
  // Differential attach from 0 over the REAL registry must replay every buffered
  // payload exactly once, in order: session_created, two stream_deltas, complete.
  const replayed: any[] = [];
  const highest = attachAntigravitySession(sid, 0, (p: any) => replayed.push(p));

  const kinds = replayed.map((p) => p.kind);
  assert.deepEqual(
    kinds,
    ['session_created', 'stream_delta', 'stream_delta', 'complete'],
    'real buffer holds the full run under the sessionId, in order',
  );
  // No duplication: each seq appears once; highest equals buffer length.
  assert.equal(highest, replayed.length);
  const deltas = replayed.filter((p) => p.kind === 'stream_delta').map((p) => p.content);
  assert.deepEqual(deltas, ['PART-ONE ', 'PART-TWO'], 'no payload lost across the rekey');

  // The temporary connectionId key is gone — no duplicate slot left behind.
  const connId = (ws.ws as any).__agyConnectionId;
  assert.ok(connId, 'a connectionId was minted on the raw socket');
  assert.notEqual(connId, sid);
  assert.equal(agySessionRegistry.entries.has(connId), false, 'connectionId slot handed over, not duplicated');
  assert.equal(agySessionRegistry.entries.has(sid), true, 'buffer now lives under the sessionId');
});

// ===========================================================================
// 1b. REAL rekey of a POPULATED preamble (qa-critic gate #1, completion).
//     Exercises the exact B-N5 hand-over the production comment anticipates — a
//     payload buffered under the temporary connectionId BEFORE the sessionId is
//     known must surface under the sessionId after rekey, exactly once, with the
//     seq counter intact — against the SAME real agySessionRegistry instance the
//     production path uses (mod-level singleton, flag ON). This is the property
//     spawnAntigravity cannot itself produce because it resolves the sessionId
//     before any record; it is nonetheless a real registry invariant the production
//     rekey call relies on, so it is proven against the live instance, not a double.
// ===========================================================================
test('REAL rekey (populated preamble): a payload recorded under connectionId before the sessionId surfaces under it after rekey, once', () => {
  const reg = agySessionRegistry;
  assert.equal(reg.enabled, true, 'flag ON — the gated path is live');
  const conn = 'agy-conn-preamble-test';
  const sid = 'agy_preamble_session';

  // Emitted BEFORE the real sessionId exists — keyed by the temporary connectionId,
  // exactly as safeSend(record) would do if a payload arrived in that window.
  reg.open(conn);
  assert.equal(reg.record(conn, { kind: 'stream_delta', content: 'pre-A' }), 1);
  assert.equal(reg.record(conn, { kind: 'stream_delta', content: 'pre-B' }), 2);

  // sessionId arrives → the production rekey hand-over.
  reg.rekey(conn, sid);
  reg.open(sid);
  reg.record(sid, { kind: 'stream_delta', content: 'post-C' });

  const replayed: string[] = [];
  const highest = attachAntigravitySession(sid, 0, (p: any) => replayed.push(p.content));
  assert.deepEqual(replayed, ['pre-A', 'pre-B', 'post-C'], 'preamble + post all present, in order, once each');
  assert.equal(highest, 3, 'seq counter preserved across rekey — no reset, no duplicate');
  // Old connectionId slot is gone (handed over, not copied).
  assert.equal(reg.entries.has(conn), false);
  assert.equal(attachAntigravitySession(conn, 0, () => {}), 0, 'no residual buffer under the connectionId');
  reg.drop(sid);
});

// ===========================================================================
// 2. REAL differential attach: attachAntigravitySession(sid, lastSeq) returns
//    only seq > lastSeq from the REAL buffer (qa-critic gate #2).
// ===========================================================================
test('REAL differential attach: only payloads with seq > lastSeq are replayed from the live buffer', async () => {
  const ws = makeWs();
  await runSpawn('go', { projectPath: HOME_DIR }, ws, (child) => {
    child.emitStdout('A');
    child.emitStdout('B');
    child.emitStdout('C');
    child.emitClose(0);
  });

  const sid = ws.forwarded.find((m) => m.kind === 'session_created')!.newSessionId as string;

  // Full replay establishes the seq line: session_created(1) A(2) B(3) C(4) complete(5).
  const full: any[] = [];
  const fullHigh = attachAntigravitySession(sid, 0, (p: any) => full.push(p));
  assert.equal(full.length, 5);
  assert.equal(fullHigh, 5);

  // A client that already saw up to seq 3 must receive ONLY seq 4 and 5.
  const tail: any[] = [];
  const tailHigh = attachAntigravitySession(sid, 3, (p: any) => tail.push(p));
  assert.deepEqual(tail.map((p) => p.kind), ['stream_delta', 'complete'], 'only seq>3 replayed');
  assert.equal((tail[0] as any).content, 'C', 'the seq=4 payload is the C delta');
  assert.equal(tailHigh, 5);

  // Re-attaching from the high-water mark yields nothing (no duplication).
  const empty: any[] = [];
  const stillHigh = attachAntigravitySession(sid, tailHigh, (p: any) => empty.push(p));
  assert.deepEqual(empty, []);
  assert.equal(stillHigh, 5);
});

// ===========================================================================
// 3. REAL B-N7: close → setActive(false) is observable through the REAL
//    isAntigravitySessionActive (flag ON → it reads the registry, NOT the legacy
//    activeSessions map) (qa-critic gate #3).
// ===========================================================================
test('REAL B-N7: isAntigravitySessionActive flips from true during the run to false after close', async () => {
  const ws = makeWs();
  let activeMidRun: boolean | null = null;
  let sidMidRun: string | null = null;

  await runSpawn('work', { projectPath: HOME_DIR }, ws, (child) => {
    // Mid-run: after the first chunk the session is open and ACTIVE in the real
    // registry. Capture the active flag through the production accessor.
    child.emitStdout('chunk');
    sidMidRun = ws.forwarded.find((m) => m.kind === 'session_created')?.newSessionId ?? null;
    if (sidMidRun) activeMidRun = isAntigravitySessionActive(sidMidRun);
    child.emitClose(0);
  });

  assert.equal(activeMidRun, true, 'session reported active during the run via the real registry');
  const sid = sidMidRun!;
  // After close, the real close handler called setActive(registryKey,false).
  assert.equal(
    isAntigravitySessionActive(sid),
    false,
    'close flipped the single source of truth to inactive',
  );
  // And the flag-ON branch is the one being exercised (not the legacy map).
  assert.equal(agySessionRegistry.enabled, true, 'the gated path is the one under test');
});

// ===========================================================================
// 4. EVICTION GAP (edge raised by the critique): a buffer driven PAST capacity,
//    then attached with a lastSeq OLDER than the lowest retained seq. Documents
//    the intended behavior: replay starts from the lowest RETAINED seq (no
//    duplication of already-seen), and the evicted-but-unseen span is a SILENT
//    LOSS — there is no gap signal. This asserts the contract so a future change
//    that alters it fails loudly.
// ===========================================================================
test('EVICTION GAP: attach with lastSeq below the retained floor replays from the floor (silent loss of evicted span)', async () => {
  // Force a tiny ring so eviction is reachable without 2000 chunks. The real
  // agySessionRegistry uses DEFAULT_RING_CAPACITY (2000); to exercise eviction
  // deterministically we drive a private session entry through the SAME real
  // registry but shrink its buffer capacity to 3 after open, mirroring the ring
  // behavior the production code relies on. (We do NOT touch production code.)
  const ws = makeWs();
  await runSpawn('seed', { projectPath: HOME_DIR }, ws, (child) => {
    child.emitStdout('x'); // create session + first delta
    child.emitClose(0);
  });
  const sid = ws.forwarded.find((m) => m.kind === 'session_created')!.newSessionId as string;
  const entry = agySessionRegistry.entries.get(sid)!;
  // Shrink the ring and overfill it to force eviction of the earliest payloads.
  entry.buffer.capacity = 3;
  entry.buffer.items.length = 0; // start clean for a deterministic seq window
  entry.buffer.seq = 0;
  for (let i = 1; i <= 6; i += 1) entry.buffer.push({ kind: 'stream_delta', content: `m${i}` });
  // Capacity 3 → only seq 4,5,6 retained; seq counter still at 6.
  assert.equal(entry.buffer.lastSeq, 6);
  assert.deepEqual(entry.buffer.items.map((it: any) => it.seq), [4, 5, 6]);

  // A client reports lastSeq=2 — but seq 3 was evicted. Differential attach can
  // only replay what survives: seq 4,5,6. The seq=3 payload is GONE.
  const replayed: any[] = [];
  const highest = attachAntigravitySession(sid, 2, (p: any) => replayed.push(p));
  assert.deepEqual(
    replayed.map((p) => p.content),
    ['m4', 'm5', 'm6'],
    'replay starts from the lowest retained seq — never re-sends seq<=2, never invents the evicted seq=3',
  );
  assert.equal(highest, 6);
  // DOCUMENTED CONTRACT: seq=3 is a SILENT LOSS. No gap marker is emitted; the
  // returned high-water mark (6) does not reveal that seq 3 was skipped. A
  // reconnecting client that depends on contiguity cannot detect the hole from
  // attach alone. This is acceptable under ADR-021 because the buffer is bounded
  // and a fresh client uses lastSeq=0 (full retained replay); it is asserted here
  // so any future move to a gap-signalling contract trips this test.
  assert.equal(
    replayed.some((p) => p.content === 'm3'),
    false,
    'evicted span is silently absent — no synthetic backfill',
  );
});

// ===========================================================================
// 5. RESUME clean-buffer (edge raised by the critique): a SECOND spawn for the
//    SAME sessionId after the first run closed must NOT replay the first run's
//    transcript. Proves the production drop-then-open on the sessionId path.
// ===========================================================================
test('RESUME clean buffer: a second run on the same sessionId does not replay the first run transcript', async () => {
  const ws1 = makeWs();
  // Run 1 (fresh) → mint sessionId, buffer a transcript, then close.
  await runSpawn('first', { projectPath: HOME_DIR }, ws1, (child) => {
    child.emitStdout('RUN1-ALPHA');
    child.emitStdout('RUN1-BETA');
    child.emitClose(0);
  });
  const sid = ws1.forwarded.find((m) => m.kind === 'session_created')!.newSessionId as string;

  // Sanity: run 1's transcript is in the buffer and the session is inactive.
  const afterRun1: string[] = [];
  attachAntigravitySession(sid, 0, (p: any) => {
    if (p.kind === 'stream_delta') afterRun1.push(p.content);
  });
  assert.deepEqual(afterRun1, ['RUN1-ALPHA', 'RUN1-BETA']);
  assert.equal(isAntigravitySessionActive(sid), false, 'run 1 terminal');

  // Resume the same sessionId, but point its persisted brain at a folder that
  // does NOT exist on disk (temp HOME is empty). The stale-resume guard must emit
  // conversation_not_found and return WITHOUT spawning a second process — never a
  // silent fresh start. The buffer under sid is left untouched (no inheritance
  // bug surfaces because no run-2 stream is produced).
  dbRows.set(sid, {
    session_id: sid,
    provider: 'antigravity',
    cwd: HOME_DIR,
    jsonl_path: path.join(HOME_DIR, '.gemini', 'antigravity-cli', 'brain', 'vanished-brain', '.system_generated', 'logs', 'transcript.jsonl'),
  });

  const ws2 = makeWs();
  const result = await spawnAntigravity('second', { sessionId: sid, cwd: HOME_DIR }, ws2 as any);
  assert.equal(spawnCalls.length, 1, 'no second agy process spawned for a vanished-brain resume');
  assert.equal((result as any).sessionId, sid);
  const notFound = ws2.forwarded.find((m) => m.kind === 'error' && m.code === 'conversation_not_found');
  assert.ok(notFound, 'vanished-brain resume surfaces conversation_not_found, not a silent fresh start');
  assert.equal(ws2.forwarded.some((m) => m.kind === 'stream_delta'), false, 'no stream replayed on the not-found path');
});

// ===========================================================================
// 5b. RESUME clean-buffer with a REAL second spawn: recreate the brain folder so
//     the resume path spawns, and assert the second run's buffer starts clean
//     (drop-then-open on the sessionId) — the first transcript is gone.
// ===========================================================================
test('RESUME clean buffer (real second spawn): drop-then-open clears the prior transcript', async () => {
  const fsmod = await import('node:fs');
  const ws1 = makeWs();
  await runSpawn('first', { projectPath: HOME_DIR }, ws1, (child) => {
    child.emitStdout('OLD-1');
    child.emitStdout('OLD-2');
    child.emitClose(0);
  });
  const sid = ws1.forwarded.find((m) => m.kind === 'session_created')!.newSessionId as string;

  // Make the resume path believe the brain is alive: point the DB row at a brain
  // folder that exists on disk under the temp HOME, and create that folder.
  const brainUUID = 'brain-resume-real';
  const brainPath = path.join(HOME_DIR, '.gemini', 'antigravity-cli', 'brain', brainUUID);
  fsmod.mkdirSync(brainPath, { recursive: true });
  dbRows.set(sid, {
    session_id: sid,
    provider: 'antigravity',
    cwd: HOME_DIR,
    jsonl_path: path.join(brainPath, '.system_generated', 'logs', 'transcript.jsonl'),
  });
  // sessionManager has no cliSessionId after the synthetic restart, so the resume
  // resolves the brain from the DB row above.

  const ws2 = makeWs();
  await runSpawn('second', { sessionId: sid, cwd: HOME_DIR }, ws2, (child) => {
    child.emitStdout('NEW-1');
    child.emitClose(0);
  });

  // A real second process was spawned with --conversation pointing at the brain.
  assert.equal(spawnCalls.length, 2, 'resume spawned a real second process');
  const resumeArgs = spawnCalls[1].args;
  assert.ok(resumeArgs.includes('--conversation'), 'resume passes --conversation');
  assert.ok(resumeArgs.includes(brainUUID), 'resume targets the recreated brain');

  // The buffer under sid now reflects ONLY run 2 (drop-then-open cleared run 1).
  const replayed: string[] = [];
  attachAntigravitySession(sid, 0, (p: any) => {
    if (p.kind === 'stream_delta') replayed.push(p.content);
  });
  assert.deepEqual(replayed, ['NEW-1'], 'second run buffer is clean — no OLD-1/OLD-2 replay');
  assert.equal(replayed.includes('OLD-1'), false);
  assert.equal(replayed.includes('OLD-2'), false);
});

// ===========================================================================
// 6. Non-numeric / missing / negative lastSeq through the REAL attach path:
//    must neither crash nor duplicate (edge raised by the critique).
// ===========================================================================
test('REAL attach with malformed lastSeq (NaN / undefined / negative / string) never crashes or duplicates', async () => {
  const ws = makeWs();
  await runSpawn('edge', { projectPath: HOME_DIR }, ws, (child) => {
    child.emitStdout('one');
    child.emitStdout('two');
    child.emitClose(0);
  });
  const sid = ws.forwarded.find((m) => m.kind === 'session_created')!.newSessionId as string;

  // Establish the full seq line length once.
  const full: any[] = [];
  attachAntigravitySession(sid, 0, (p: any) => full.push(p));
  const fullLen = full.length; // session_created + 2 deltas + complete = 4

  for (const bad of [NaN, undefined as any, -5, 'abc' as any, null as any, Infinity, -Infinity]) {
    const got: any[] = [];
    let ret: number | undefined;
    assert.doesNotThrow(() => {
      ret = attachAntigravitySession(sid, bad as any, (p: any) => got.push(p));
    }, `attach must not throw for lastSeq=${String(bad)}`);

    // RingBuffer.since() treats any non-finite or <=0 floor as "from the start":
    // a full, in-order, non-duplicated replay. A finite positive value would
    // filter; none of these are finite-positive, so all yield the full buffer.
    assert.equal(got.length, fullLen, `lastSeq=${String(bad)} replays the full retained buffer once`);
    // Returned high-water mark is the real top seq (never a duplicate or NaN leak
    // into the protocol): finite, equal to the buffer length.
    assert.ok(Number.isFinite(ret), `returned highest is finite for lastSeq=${String(bad)}`);
    assert.equal(ret, fullLen);
    // No duplication within a single replay: seq kinds are unique-ordered.
    const seqKinds = got.map((p) => p.kind);
    assert.deepEqual(
      seqKinds,
      ['session_created', 'stream_delta', 'stream_delta', 'complete'],
      `no duplicate payload for lastSeq=${String(bad)}`,
    );
  }
});

// ===========================================================================
// FINDINGS (for the coordinator / qa-critic) — NOT defects, design notes the
// real chain surfaced; left in-file so they ride with the tests that prove them:
//
//  (A) spawnAntigravity resolves finalSessionId SYNCHRONOUSLY (before any stdout),
//      so the temporary connectionId entry is EMPTY when rekey() fires in the
//      normal flow. The "payload buffered under connectionId then rekeyed" case is
//      a registry invariant the code relies on but never itself produces; proven
//      against the live registry in test 1b rather than via spawn.
//
//  (B) Eviction loss is SILENT. attach() returning the high-water mark gives a
//      reconnecting client no way to detect that an interior seq was evicted
//      (test 4). Acceptable under ADR-021 (bounded buffer; fresh clients use
//      lastSeq=0 for a full retained replay), but if a future requirement needs
//      contiguity guarantees, attach must grow a gap/oldest-retained signal.
// ===========================================================================
