// Regression test for the UTF-8 chunk-boundary corruption bug.
//
// SYMPTOM: agy streams plain-text Arabic on stdout. A multibyte char (an Arabic
// letter is 2 bytes in UTF-8) can straddle a Node stdout chunk boundary. The
// previous code decoded each Buffer chunk independently via `chunk.toString()`,
// so the split sequence was decoded as two halves → each half became U+FFFD (�)
// and the user saw e.g. «الو��ول» instead of «الوصول».
//
// THE FIX (agy-cli.js): decode stdout through a per-spawn StringDecoder('utf8'),
// which holds the incomplete trailing bytes and prepends them to the next chunk,
// emitting each character only once it is whole. Any genuinely truncated tail is
// flushed on close.
//
// This test drives the REAL spawnAntigravity stdout handler (only the process
// boundary and side-effect collaborators are stubbed) with a Buffer that is split
// in the MIDDLE of the Arabic letter «ص» (U+0635 = 0xD8 0xB5), and asserts the
// reassembled stream contains the exact word with NO replacement character.

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import os from 'node:os';
import path from 'node:path';
import { mkdtempSync } from 'node:fs';
import test, { mock, before, after, beforeEach } from 'node:test';

class FakeChildProcess extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  killed = false;
  // CLI args captured at spawn so tests can assert on --conversation / the
  // injected instructions prefix.
  spawnArgs: string[] = [];
  kill() {
    this.killed = true;
    return true;
  }
  // Emit a raw Buffer slice exactly as the OS would deliver a stdout chunk.
  emitChunk(buf: Buffer) {
    this.stdout.emit('data', buf);
  }
  emitClose(code = 0) {
    this.emit('close', code);
  }
}

let spawnSignal: { promise: Promise<FakeChildProcess>; resolve: (c: FakeChildProcess) => void };
function armSpawnSignal() {
  let resolve!: (c: FakeChildProcess) => void;
  const promise = new Promise<FakeChildProcess>((r) => { resolve = r; });
  spawnSignal = { promise, resolve };
}

const sessionStore = new Map<string, any>();
const dbRows = new Map<string, any>();
let HOME_DIR = '';

let spawnAntigravity: typeof import('./agy-cli.js').spawnAntigravity;

before(async () => {
  HOME_DIR = mkdtempSync(path.join(os.tmpdir(), 'agy-utf8-'));
  process.env.HOME = HOME_DIR;
  // The instructions prefix is only built when there is something to inject, and
  // the response-language rule is configuration now (NASSAJ_RESPONSE_LANGUAGE) —
  // an unset value injects no <instructions> block at all. Pin it BEFORE importing
  // agy-cli, which reads it once at module load.
  process.env.NASSAJ_RESPONSE_LANGUAGE = 'formal Arabic (العربية الفصحى)';

  mock.module('child_process', {
    namedExports: {
      spawn: (_cmd: string, args: string[]) => {
        const child = new FakeChildProcess();
        child.spawnArgs = Array.isArray(args) ? args : [];
        spawnSignal?.resolve(child);
        return child as unknown as ReturnType<typeof import('node:child_process').spawn>;
      },
    },
  });

  const fakeSessionManager = {
    getSession: (id: string) => sessionStore.get(id) ?? null,
    createSession: (id: string) => {
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
  mock.module('./modules/providers/list/antigravity/antigravity-project-registry.js', {
    namedExports: {
      registerAntigravityProjectPath: () => {},
      clearAntigravityProjectPath: () => {},
    },
  });
  mock.module('./services/notification-orchestrator.js', {
    namedExports: {
      notifyRunStopped: () => {},
      notifyRunFailed: () => {},
    },
  });

  const mod = await import('./agy-cli.js');
  spawnAntigravity = mod.spawnAntigravity;
});

after(() => {
  delete process.env.SESSION_REGISTRY_agy;
});

beforeEach(() => {
  sessionStore.clear();
  dbRows.clear();
});

function makeWs() {
  const raw = {};
  const forwarded: any[] = [];
  return {
    ws: raw,
    forwarded,
    send(msg: any) {
      forwarded.push(msg);
    },
  };
}

async function runSpawn(
  command: string,
  ws: ReturnType<typeof makeWs>,
  drive: (child: FakeChildProcess) => void,
) {
  armSpawnSignal();
  const promise = spawnAntigravity(command, { projectPath: HOME_DIR, cwd: HOME_DIR }, ws as any);
  const child = await spawnSignal.promise;
  drive(child);
  return promise;
}

const REPLACEMENT = '�'; // U+FFFD, the � character

test('Arabic char split across stdout chunks reassembles without � (regression)', async () => {
  const word = 'الوصول'; // "access" — the letter «ص» is the corruption site in the report
  const full = Buffer.from(word, 'utf8');

  // Find the byte offset of «ص» (U+0635 → 0xD8 0xB5) and split BETWEEN its bytes.
  const sadFirstByte = full.indexOf(0xd8, full.indexOf(Buffer.from('ص', 'utf8')));
  const splitAt = sadFirstByte + 1; // after the lead byte, before the trail byte
  const chunkA = full.subarray(0, splitAt);
  const chunkB = full.subarray(splitAt);

  // Sanity: decoding each half independently (the OLD behaviour) DOES corrupt —
  // this proves the test actually exercises a real cross-boundary split.
  assert.ok(
    (chunkA.toString('utf8') + chunkB.toString('utf8')).includes(REPLACEMENT),
    'precondition: a naive per-chunk toString() would corrupt this split',
  );

  const ws = makeWs();
  await runSpawn('مرحبا', ws, (child) => {
    child.emitChunk(chunkA);
    child.emitChunk(chunkB);
    child.emitClose(0);
  });

  const deltas = ws.forwarded
    .filter((m) => m.kind === 'stream_delta')
    .map((m) => m.content)
    .join('');

  assert.ok(!deltas.includes(REPLACEMENT), `stream must not contain � — got: ${JSON.stringify(deltas)}`);
  assert.equal(deltas, word, 'the Arabic word is reassembled intact across the chunk boundary');
});

test('multiple Arabic chars each split across boundaries still decode cleanly', async () => {
  const sentence = 'لا يمكن الوصول إلى الصفحة';
  const full = Buffer.from(sentence, 'utf8');

  // Split into single-byte chunks: every multibyte char straddles boundaries.
  const ws = makeWs();
  await runSpawn('اختبار', ws, (child) => {
    for (let i = 0; i < full.length; i += 1) {
      child.emitChunk(full.subarray(i, i + 1));
    }
    child.emitClose(0);
  });

  const deltas = ws.forwarded
    .filter((m) => m.kind === 'stream_delta')
    .map((m) => m.content)
    .join('');

  assert.ok(!deltas.includes(REPLACEMENT), 'no replacement char even with byte-by-byte chunks');
  assert.equal(deltas, sentence, 'the full Arabic sentence is reassembled intact');
});

// Regression test for the resume-replay bug: in `-p --conversation` mode agy
// replays the conversation's PREVIOUS planner output on stdout before (or
// instead of) the new turn's reply. The adapter must surface only the steps
// appended to the brain transcript by THIS run, never the stdout replay.
test('resumed conversation surfaces only the new transcript reply, not the stdout replay', async () => {
  const { mkdir, writeFile, appendFile } = await import('node:fs/promises');

  const brainUUID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  const logsDir = path.join(
    HOME_DIR, '.gemini', 'antigravity-cli', 'brain', brainUUID, '.system_generated', 'logs',
  );
  await mkdir(logsDir, { recursive: true });
  const transcriptPath = path.join(logsDir, 'transcript.jsonl');

  const OLD_ANSWER = 'هذا هو الردّ القديم من الدور السابق';
  const NEW_ANSWER = 'هذا هو الردّ الجديد على الرسالة الحالية';

  // Prior turns: a USER_INPUT with NO <instructions> prefix (conversation born
  // outside the UI) and the previous planner reply.
  await writeFile(transcriptPath, [
    JSON.stringify({ step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', content: 'سؤال قديم' }),
    JSON.stringify({ step_index: 1, source: 'MODEL', type: 'PLANNER_RESPONSE', content: OLD_ANSWER }),
    '',
  ].join('\n'), 'utf8');

  const sessionId = 'agy_resume_test_1';
  sessionStore.set(sessionId, { id: sessionId, cliSessionId: brainUUID, messages: [] });

  const ws = makeWs();
  armSpawnSignal();
  const promise = spawnAntigravity(
    'سؤال جديد',
    { sessionId, projectPath: HOME_DIR, cwd: HOME_DIR },
    ws as any,
  );
  const child = await spawnSignal.promise;

  // agy resumes by id and gets the instructions prefix injected exactly because
  // the pre-existing transcript never carried one.
  assert.ok(child.spawnArgs.includes('--conversation'), 'resume passes --conversation');
  assert.ok(child.spawnArgs.includes(brainUUID), 'resume targets the stored brain UUID');
  assert.ok(
    child.spawnArgs.some((a) => a.includes('<instructions>')),
    'instructions prefix is injected for an IDE-born conversation without one',
  );

  // stdout replays the OLD answer (the bug under test) and then the new one.
  child.emitChunk(Buffer.from(`${OLD_ANSWER}\n${NEW_ANSWER}\n`, 'utf8'));
  // agy appends the new turn to the transcript before exiting.
  await appendFile(transcriptPath, `${JSON.stringify({
    step_index: 2, source: 'MODEL', type: 'PLANNER_RESPONSE', content: NEW_ANSWER,
  })}\n`, 'utf8');
  child.emitClose(0);
  await promise;

  const deltas = ws.forwarded.filter((m: any) => m.kind === 'stream_delta').map((m: any) => m.content);
  assert.equal(deltas.length, 1, 'exactly one reconciled delta is emitted at close');
  assert.equal(deltas[0], NEW_ANSWER, 'the delta is the transcript-derived new reply');
  assert.ok(!deltas.join('').includes(OLD_ANSWER), 'the stdout replay of the old reply is suppressed');

  const stored = sessionStore.get(sessionId).messages.filter((m: any) => m.role === 'assistant');
  assert.equal(stored.length, 1);
  assert.equal(stored[0].content, NEW_ANSWER, 'history stores the new reply only');
});
