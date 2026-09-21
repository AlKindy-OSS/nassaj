/**
 * Hermes process-lifecycle contract tests.
 *
 * The child-process module is replaced before importing the adapter: these tests
 * never execute the real `hermes` binary.
 */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import test, { after, mock } from 'node:test';

// Preserve transitive import exports without granting this fixture new process effects.
let unexpectedProcessCalls = 0;
const rejectUnexpectedProcess = () => {
  unexpectedProcessCalls++;
  assert.fail('unexpected process in provider fixture');
};
after(() => assert.equal(unexpectedProcessCalls, 0));

const url = (relativePath: string) => new URL(relativePath, import.meta.url).href;
const RUN_TIMEOUT_MS = 900_000;
const KILL_GRACE_MS = 8_000;

class FakeChild extends EventEmitter {
  pid = 4242;
  sessionId?: string;
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  signals: NodeJS.Signals[] = [];

  kill(signal: NodeJS.Signals = 'SIGTERM') {
    this.signals.push(signal);
    return true;
  }
}

const children: FakeChild[] = [];
let onAssistantAppend = () => {};
const recordedTiming: Array<{ sessionId: string; assistantMessageId: string; completedAt: string }> = [];
const recordedReplies: Array<{ sessionId: string; text: string; finalAnswer: boolean }> = [];
let failAssistantWrite = false;
const spawnFake = () => {
  const child = new FakeChild();
  children.push(child);
  return child;
};

mock.module('child_process', { namedExports: { execFileSync: rejectUnexpectedProcess, execFile: rejectUnexpectedProcess, spawnSync: rejectUnexpectedProcess, spawn: spawnFake } });
mock.module('cross-spawn', { defaultExport: spawnFake });
mock.module(url('./modules/providers/services/sessions.service.js'), {
  namedExports: { sessionsService: {} },
});
mock.module(url('./modules/providers/services/provider-auth.service.js'), {
  namedExports: { providerAuthService: { isProviderInstalled: async () => true } },
});
mock.module(url('./modules/providers/services/provider-models.service.js'), {
  namedExports: {
    providerModelsService: {
      resolveResumeModel: async (_provider: string, _sessionId: string, model: string) => model,
      seedSessionModel: async () => undefined,
    },
  },
});
// The spawn path records a participant and a message author alongside the
// session row (B-598) — a mock that omits either fails at IMPORT time with
// "does not provide an export named …", which reads like a missing export
// rather than a stale mock.
mock.module(url('./modules/database/index.js'), {
  namedExports: {
    sessionsDb: { createSession: () => undefined },
    participantsDb: { recordSpawn: () => undefined },
    messageAuthorsDb: { recordUserMessage: () => undefined },
    responseTurnMetricsDb: {
      recordCompleted: (input: { sessionId: string; assistantMessageId: string }) => {
        recordedTiming.push(input);
        return { status: 'inserted', metric: null };
      },
      sumSessionDuration: () => null,
    },
  },
});
mock.module(url('./services/isolation/resolve-provider-env.js'), {
  namedExports: { resolveProviderEnv: () => ({}) },
});
mock.module(url('./services/isolation/provider-cage-wiring.js'), {
  namedExports: { resolveCagedLaunch: ({ cmd, args }: { cmd: string; args: string[] }) => ({ cmd, args }) },
});
mock.module(url('./services/notification-orchestrator.js'), {
  namedExports: { notifyRunFailed: () => undefined, notifyRunStopped: () => undefined },
});
mock.module(url('./shared/utils.js'), {
  namedExports: {
    createNormalizedMessage: (payload: object) => payload,
    stampCoordinatorId: (payload: object) => payload,
  },
});
mock.module(url('./shared/cwd-check.js'), {
  namedExports: {
    checkCwdExists: async () => ({ ok: true }),
    buildCwdMissingPayload: () => ({}),
  },
});
mock.module(url('./shared/spawn-error.js'), {
  namedExports: { mapSpawnError: (error: Error) => ({ code: 'spawn_error', fallbackMessage: error.message }) },
});
mock.module(url('./services/provider-run-presence.js'), {
  namedExports: { beginProviderRun: () => ({ end: () => undefined, rekey: () => undefined }) },
});
// The nassaj-owned transcript (B-599) is stubbed rather than exercised: these
// are lifecycle tests, and letting the real module through would both write
// JSONL into the operator's home and drag `shared/utils.js` exports the mock
// above deliberately does not provide.
mock.module(url('./modules/providers/shared/vendor/vendor-transcript.js'), {
  namedExports: {
    appendVendorTranscriptTurn: async (_provider: string, sessionId: string, _project: string,
      role: string, text: string, metadata?: { finalAnswer?: boolean }) => {
      if (role === 'assistant') onAssistantAppend();
      if (role === 'assistant') recordedReplies.push({ sessionId, text, finalAnswer: metadata?.finalAnswer === true });
      return role === 'assistant' && failAssistantWrite ? null : `saved-${sessionId}-${role}`;
    },
    writeVendorTranscriptMeta: async () => undefined,
    vendorTranscriptPath: () => '/synthetic-hermes-transcript.jsonl',
  },
});
mock.module(url('./modules/providers/list/hermes/hermes-runtime.js'), {
  namedExports: { readHermesRuntimeConfig: async () => ({ provider: null }) },
});

const hermes = await import('./hermes-cli.js');

after(() => mock.restoreAll());

function writer() {
  const sent: Record<string, unknown>[] = [];
  return {
    sent,
    ws: {
      userId: 7,
      send: (payload: Record<string, unknown>) => sent.push(payload),
    },
  };
}

async function start(sessionId: string) {
  const output = writer();
  const run = hermes.spawnHermes('answer', { sessionId }, output.ws);
  await new Promise<void>((resolve) => setImmediate(resolve));
  return { ...output, run, child: children.at(-1)! };
}

test('timeout sends one error, escalates SIGTERM to SIGKILL, and clears its timers on close', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const groupSignals: Array<[number, NodeJS.Signals]> = [];
  t.mock.method(process, 'kill', (pid: number, signal: NodeJS.Signals) => {
    groupSignals.push([pid, signal]);
    return true;
  });
  const { child, run, sent } = await start('hermes-timeout');

  t.mock.timers.tick(RUN_TIMEOUT_MS);
  assert.deepEqual(groupSignals, [[-child.pid, 'SIGTERM']]);
  const timeoutErrors = sent.filter((message) => message.kind === 'error');
  assert.equal(timeoutErrors.length, 1);
  assert.equal(timeoutErrors[0].code, 'timeout');
  assert.match(String(timeoutErrors[0].content), /HERMES_RUN_TIMEOUT_MS|900|timeout/i);

  t.mock.timers.tick(KILL_GRACE_MS);
  assert.deepEqual(groupSignals, [[-child.pid, 'SIGTERM'], [-child.pid, 'SIGKILL']]);
  assert.equal(sent.filter((message) => message.kind === 'error').length, 1, 'timeout is surfaced once');

  child.emit('close', null);
  await assert.rejects(run, /terminated|timed out|timeout/i);
  const signalCount = groupSignals.length;
  t.mock.timers.tick(24 * 60 * 60 * 1000);
  assert.equal(groupSignals.length, signalCount, 'terminal cleanup removes pending timers');
});

test('natural completion resolves without timeout signals and removes the active session', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const { child, run, sent } = await start('hermes-complete');

  child.stdout.write('done\n');
  child.emit('close', 0);
  await run;

  assert.deepEqual(child.signals, []);
  assert.equal(hermes.isHermesSessionActive('hermes-complete'), false);
  assert.deepEqual(sent.filter((message) => message.kind === 'complete').map((message) => message.exitCode), [0]);
  assert.equal(recordedTiming.find((row) => row.sessionId === 'hermes-complete')?.assistantMessageId,
    'saved-hermes-complete-assistant');
  t.mock.timers.tick(24 * 60 * 60 * 1000);
  assert.deepEqual(child.signals, [], 'completion clears timeout and escalation timers');
});

test('partial stdout then timeout and close zero preserves text without final marker or timing', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  t.mock.method(process, 'kill', () => true);
  const { child, run, sent } = await start('hermes-timeout-zero');
  child.stdout.write('partial reply\n');
  t.mock.timers.tick(RUN_TIMEOUT_MS);
  child.emit('close', 0);
  await assert.rejects(run, /timed out/);
  assert.deepEqual(recordedReplies.find((row) => row.sessionId === 'hermes-timeout-zero'), {
    sessionId: 'hermes-timeout-zero', text: 'partial reply', finalAnswer: false,
  });
  assert.equal(recordedTiming.some((row) => row.sessionId === 'hermes-timeout-zero'), false);
  const complete = sent.find((message) => message.kind === 'complete');
  assert.equal(complete?.success, false);
  assert.notEqual(complete?.exitCode, 0);
});

test('explicit abort then close zero cannot mark its partial answer successful', async (t) => {
  t.mock.method(process, 'kill', () => true);
  const { child, run } = await start('hermes-abort-zero');
  child.stdout.write('partial reply\n');
  assert.equal(hermes.abortHermesSession('hermes-abort-zero'), true);
  child.emit('close', 0);
  await assert.rejects(run, /terminated/);
  assert.equal(recordedReplies.find((row) => row.sessionId === 'hermes-abort-zero')?.finalAnswer, false);
  assert.equal(recordedTiming.some((row) => row.sessionId === 'hermes-abort-zero'), false);
});

test('a child error followed by close zero keeps its saved partial response non-final', async () => {
  const { child, run } = await start('hermes-error-zero');
  child.stdout.write('partial reply\n');
  const rejected = assert.rejects(run, /synthetic child error/);
  child.emit('error', new Error('synthetic child error'));
  child.emit('close', 0);
  await rejected;
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(recordedReplies.find((row) => row.sessionId === 'hermes-error-zero')?.finalAnswer, false);
  assert.equal(recordedTiming.some((row) => row.sessionId === 'hermes-error-zero'), false);
});

test('a failed assistant transcript append keeps completion visible but does not settle an unjoinable metric', async () => {
  failAssistantWrite = true;
  try {
    const { child, run, sent } = await start('hermes-recording-failed');
    child.stdout.write('answer still visible\n');
    child.emit('close', 0);
    await run;
    assert.equal(sent.some((message) => message.kind === 'complete'), true);
    assert.equal(recordedTiming.some((row) => row.sessionId === 'hermes-recording-failed'), false);
  } finally { failAssistantWrite = false; }
});

test('heartbeat exposes raw elapsed milliseconds and keeps a precise human fallback', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
  const { child, run, sent } = await start('hermes-heartbeat-duration');

  t.mock.timers.tick(30_000);
  const heartbeat = sent.find((message) => String(message.text).startsWith('Hermes is still working'));
  assert.ok(heartbeat, 'first silent-run heartbeat is emitted');
  assert.equal(heartbeat.elapsedMs, 30_000);
  assert.match(String(heartbeat.text), /30\.0s elapsed$/);

  child.emit('close', 0);
  await run;
});

test('formatHermesElapsed preserves days and fractional seconds without inventing calendar units', () => {
  assert.equal(hermes.formatHermesElapsed(333), '333ms');
  assert.equal(hermes.formatHermesElapsed(1_999), '1.9s');
  assert.equal(hermes.formatHermesElapsed(125_000), '2m 5.0s');
  assert.equal(hermes.formatHermesElapsed(93_784_500), '1d 2h 3m 4.5s');
});

test('a concurrent run for the same session is rejected as session_busy without spawning', async () => {
  const first = await start('hermes-busy');
  const second = writer();
  const spawnCount = children.length;

  await hermes.spawnHermes('second answer', { sessionId: 'hermes-busy' }, second.ws);

  assert.equal(children.length, spawnCount, 'busy rejection must not spawn another child');
  assert.equal(second.sent.filter((message) => message.code === 'session_busy').length, 1);

  // B-1078: the frame reaches every mirror, so it must name the rejected send.
  const third = writer();
  await hermes.spawnHermes('third answer', { sessionId: 'hermes-busy', clientMsgId: 'cmid_rejected' }, third.ws);
  const busy = third.sent.filter((message) => message.code === 'session_busy');
  assert.equal(busy.length, 1);
  assert.equal(busy[0].clientMsgId, 'cmid_rejected');
  assert.equal('clientMsgId' in second.sent.find((message) => message.code === 'session_busy'), false,
    'no clientMsgId is invented when the send carried none');

  first.child.emit('close', 0);
  await first.run;
});


test('Hermes completion time excludes transcript append latency', async (t) => {
  t.mock.timers.enable({ apis: ['Date'] });
  const completedAt = '2026-09-05T12:00:00.000Z';
  t.mock.timers.setTime(Date.parse(completedAt));
  onAssistantAppend = () => t.mock.timers.tick(5000);
  try {
    const { child, run } = await start('hermes-append-latency');
    child.stdout.write('answer\n');
    child.emit('close', 0);
    await run;
    assert.equal(recordedTiming.find(row => row.sessionId === 'hermes-append-latency')?.completedAt, completedAt);
  } finally { onAssistantAppend = () => {}; }
});
