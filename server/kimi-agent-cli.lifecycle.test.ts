import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { after, mock, test } from 'node:test';

// Preserve transitive import exports without granting this fixture new process effects.
let unexpectedProcessCalls = 0;
const rejectUnexpectedProcess = () => {
  unexpectedProcessCalls++;
  assert.fail('unexpected process in provider fixture');
};
after(() => assert.equal(unexpectedProcessCalls, 0));
const root = await fs.mkdtemp(path.join(process.env.TMPDIR!, 'runner-history-'));
after(() => fs.rm(root, { recursive: true, force: true }));
mock.method(os, 'homedir', () => root);
// Pre-create an empty fixture so lazy connection imports cannot copy legacy data.
process.env.DATABASE_PATH = path.join(root, 'synthetic-auth.db');
await fs.writeFile(process.env.DATABASE_PATH, '', { flag: 'wx', mode: 0o600 });
let legacyCopyAttempts = 0;
mock.method(fsSync, 'copyFileSync', () => { legacyCopyAttempts++; assert.fail('legacy database copy is forbidden in this fixture'); });
after(() => assert.equal(legacyCopyAttempts, 0));
let child: any;
// CI hardening: wait for `child` on a wall clock, not on a fixed number of event-loop
// turns. The runner performs real fs awaits before it reaches spawn(); on a loaded CI
// runner those do not complete within a bounded tick budget, the assert fires, and the
// abandoned run then hands its child to a later test whose own run never settles.
const DEADLINE_MS = Number(process.env.NASSAJ_TEST_DEADLINE_MS || 30000);
// process.hrtime is immune to t.mock.timers.enable({ apis: ['Date'] }) used below.
const elapsedMs = (start: bigint) => Number(process.hrtime.bigint() - start) / 1e6;
const withDeadline = async <T>(promise: Promise<T>, label: string): Promise<T> => {
  let timer: NodeJS.Timeout | undefined;
  const guard = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${DEADLINE_MS}ms waiting for ${label}`)), DEADLINE_MS);
  });
  try { return await Promise.race([promise, guard]); } finally { clearTimeout(timer); }
};
let generation = 0;
let childGeneration = -1;
const timings: any[] = [];
const saved: any[] = [];
const participants: string[] = [];
const terminalNotifications: any[] = [];
let presenceEnds = 0;
const persistenceResults: unknown[] = [];
const persistenceAttempts: any[] = [];
const appendFailures: unknown[] = [];
let sid = '';
let transcript = '';
const named = (url: string, exports: Record<string, unknown>) => mock.module(url, { namedExports: exports });
named('child_process', { execFileSync: rejectUnexpectedProcess, execFile: rejectUnexpectedProcess, spawnSync: rejectUnexpectedProcess, spawn: () => { childGeneration = generation; child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough(); child.kill = () => true; return child; } });
mock.module('./sessionManager.js', { defaultExport: { getSession: () => ({ cliSessionId: sid }), createSession() { }, saveSession() { }, addMessage: (...args: any[]) => saved.push(args) } });
named('./modules/database/index.js', { sessionsDb: { getSessionById: () => transcript ? ({ jsonl_path: transcript }) : null, createSession() { } }, participantsDb: { recordSpawn: (sessionId: string) => participants.push(sessionId) }, messageAuthorsDb: { recordUserMessage() { } }, providerRunFailuresDb: { getFailure: () => null, clearFailure() { }, recordFailure() { }, setFailure() { } } });
named('./modules/providers/services/provider-models.service.js', { providerModelsService: { resolveResumeModel: async () => 'fixture', seedSessionModel: async () => { }, getChangedActiveModel: () => null } });
named('./modules/providers/services/turn-timing.service.js', { createTurnTimer: () => ({ markModelActivity() { }, startedAt: () => new Date().toISOString() }), settleTurnTiming: (value: any) => { timings.push(value); return { assistantMessageId: value.assistantMessageId }; } });
named('./modules/providers/services/provider-auth.service.js', { providerAuthService: { isProviderInstalled: async () => true } });
named('./modules/session-workspaces/index.js', { logicalProjectPathForWorkspace: (value: string) => value });
named('./services/isolation/resolve-provider-env.js', { resolveProviderEnv: () => ({ HOME: root }) });
named('./services/isolation/provider-cage-wiring.js', { resolveCagedLaunch: (value: unknown) => value });
named('./services/isolation/sanitize-vendor-agent-env.js', { sanitizeVendorAgentEnv: (value: unknown) => value });
named('./services/provider-run-presence.js', { beginProviderRun: () => ({ end() { presenceEnds++; }, rekey() { } }) });
named('./services/notification-orchestrator.js', { notifyRunFailed: (value: any) => terminalNotifications.push({ ...value, failed: true }), notifyRunStopped: (value: any) => terminalNotifications.push(value) });
named('./shared/cwd-check.js', { checkCwdExists: async () => ({ ok: true }), buildCwdMissingPayload: () => ({}) });
async function awaitChild(sent: any[]) {
  const started = process.hrtime.bigint();
  // Real sleeps, not setImmediate spins: threadpool fs callbacks need wall time.
  while ((!child || childGeneration !== generation) && elapsedMs(started) < DEADLINE_MS) {
    await new Promise(resolve => setTimeout(resolve, 1));
  }
  assert.ok(child && childGeneration === generation, `spawn was not called within ${DEADLINE_MS}ms: ${JSON.stringify(sent)}`);
}
named('./services/isolation/vendor-binary-integrity.js', { verifyVendorBinaryDigest() { }, VendorBinaryIntegrityError: class extends Error { } });
named('./services/isolation/vendor-cli-governance.js', { ensureVendorCliGovernance() { }, VendorGovernanceMissingError: class extends Error { }, GOVERNANCE_MISSING_CODE: 'missing' });
named('./services/isolation/vendor-cli-permissions.js', { mapPermissionModeToVendorFlags: () => ({ flags: [] }) });
named('./services/isolation/codex-governance-material.js', { neutralGovernanceSource: () => '' });
named('./services/isolation/governance-exemption.js', { isGovernanceExempt: () => false });
named('./services/isolation/provision-user-dirs.js', { KIMI_HOME_SUBDIR: '.kimi' });
// Call-through observation: the production helper and append guard both execute.
const { persistKimiTranscriptFinal: realPersistKimiTranscriptFinal } = await import('./shared/kimi-transcript-final.js');
named('./shared/kimi-transcript-final.js', {
  persistKimiTranscriptFinal: async (turn: any, append: any) => {
    const result = await realPersistKimiTranscriptFinal(turn, async (event: any, id: string) => {
      persistenceAttempts.push(event);
      try { return await append(event, id); } catch (error) { appendFailures.push(error); throw error; }
    });
    persistenceResults.push(result);
    return result;
  },
});
const { spawnKimiAgent, abortKimiAgentSession } = await import('./kimi-agent-cli.js');
const { VendorSessionsProvider } = await import('./modules/providers/shared/vendor/vendor-sessions.provider.js');
for (const mode of ['success', 'abort', 'signal', 'error', 'timeout']) test(`Kimi actual runner and writer/history: ${mode}`, async (t) => {
  t.mock.timers.enable({ apis: ['Date'] });
  const endedAt = '2026-09-05T12:00:00.000Z';
  t.mock.timers.setTime(Date.parse(endedAt));
  const append = fs.appendFile.bind(fs);
  t.mock.method(fs, 'appendFile', ((...args: any[]) => { t.mock.timers.tick(5000); return (append as any)(...args); }) as any);
  sid = `kimi-${mode}`; child = null; generation++; timings.length = 0; saved.length = 0;
  const sent: any[] = [];
  let timeout: (() => void) | undefined;
  const nativeTimeout = globalThis.setTimeout;
  const timerMock = mock.method(globalThis, 'setTimeout', ((callback: () => void, ms: number, ...args: any[]) => {
    if (ms === 120000) { timeout = callback; return nativeTimeout(() => { }, ms); }
    return nativeTimeout(callback, ms, ...args);
  }) as any);
  try {
    const run = spawnKimiAgent('question', { sessionId: sid, cwd: root }, { userId: 7, send: (m: any) => sent.push(m) }).then(() => null, error => error);
    await awaitChild(sent);
    const emit = (row: any) => child.stdout.write(JSON.stringify(row) + '\n');
    emit({ type: 'tool_use', id: 't1', name: 'Read', input: {} });
    emit({ type: 'tool_result', tool_id: 't1', output: 'fixture' });
    emit({ type: 'assistant', content: 'answer' });
    if (mode === 'abort') assert.equal(abortKimiAgentSession(sid), true);
    if (mode === 'error') emit({ type: 'error', message: 'fixture failure' });
    if (mode === 'timeout') { assert.ok(timeout); timeout(); }
    child.emit('close', 0, mode === 'signal' ? 'SIGTERM' : null);
    await withDeadline(run, `spawnKimiAgent(${mode}) to settle`);
    const result = await withDeadline(new VendorSessionsProvider({ provider: 'kimi' }).fetchHistory(sid, { projectPath: root }), `fetchHistory(${sid})`);
    assert.ok(result.messages.some(m => m.content === 'answer'));
    assert.ok(result.messages.some(m => m.kind === 'tool_use'));
    assert.equal(timings.length, mode === 'success' ? 1 : 0);
    const finals = result.messages.filter(m => m.isFinalAnswer);
    assert.equal(finals.length, mode === 'success' ? 1 : 0);
    if (mode === 'success') {
      assert.equal(timings[0].completedAt, endedAt, 'writer latency is not model duration');
      assert.equal(finals[0].id, timings[0].assistantMessageId);
      assert.equal(sent.find(m => m.kind === 'complete').assistantMessageId, finals[0].id);
    }
    assert.equal(sent.find(m => m.kind === 'complete').exitCode, mode === 'success' ? 0 : 1);
  } finally { timerMock.mock.restore(); }
});

test('revocation while transcript metadata is pending blocks final persistence and participation', async (t) => {
  sid = ''; child = null; generation++; saved.length = 0; participants.length = 0;
  let revoked = false;
  let enterMeta!: () => void;
  const metaEntered = new Promise<void>((resolve) => { enterMeta = resolve; });
  let releaseMeta!: () => void;
  const metaRelease = new Promise<void>((resolve) => { releaseMeta = resolve; });
  const originalAppend = fs.appendFile.bind(fs);
  t.mock.method(fs, 'appendFile', (async (...args: any[]) => {
    if (String(args[1]).includes('"type":"meta"')) {
      enterMeta();
      await metaRelease;
    }
    return (originalAppend as any)(...args);
  }) as any);
  const sent: any[] = [];
  const run = spawnKimiAgent('question', { cwd: root }, {
    userId: 7,
    send: (message: any) => sent.push(message),
    isRunOutputRevoked: () => revoked,
  }).then(() => null, error => error);
  await awaitChild(sent);
  child.stdout.write(`${JSON.stringify({ type: 'assistant', content: 'late answer' })}\n`);
  child.emit('close', 0, null);
  await withDeadline(metaEntered, 'Kimi metadata write to begin');
  revoked = true;
  releaseMeta();
  assert.equal(await withDeadline(run, 'revoked Kimi run to settle'), null);
  assert.deepEqual(participants, []);
  assert.deepEqual(saved, []);
  const finalSessionId = String(sent.find((message) => message.kind === 'complete')?.sessionId || '');
  const history = await new VendorSessionsProvider({ provider: 'kimi' })
    .fetchHistory(finalSessionId, { projectPath: root });
  assert.equal(history.messages.some((message) => message.content === 'late answer'), false);
});

test('late Kimi init after revocation has no session or participant effects', async () => {
  sid = ''; child = null; generation++; saved.length = 0; participants.length = 0;
  let revoked = false;
  const sent: any[] = [];
  const run = spawnKimiAgent('question', { cwd: root }, {
    userId: 7,
    send: (message: any) => sent.push(message),
    isRunOutputRevoked: () => revoked,
  }).then(() => null, error => error);
  await awaitChild(sent);
  revoked = true;
  child.stdout.write(`${JSON.stringify({ type: 'init', session_id: 'late-revoked-session' })}\n`);
  child.emit('close', 0, null);
  assert.equal(await withDeadline(run, 'late-init Kimi run to settle'), null);
  assert.deepEqual(participants, []);
  assert.deepEqual(saved, []);
  assert.equal(sent.some((message) => message.kind === 'session_created'), false);
});


test('revocation after the first transcript append stops remaining messages and still settles the run', async (t) => {
  // Arrange: keep both the real persistence loop and the runner's append guard.
  sid = 'kimi-revoked-between-appends'; child = null; generation++;
  timings.length = 0; persistenceResults.length = 0; persistenceAttempts.length = 0; appendFailures.length = 0;
  terminalNotifications.length = 0; presenceEnds = 0;
  let revoked = false;
  let transcriptPath = '';
  const persisted: any[] = [];
  const unhandled: unknown[] = [];
  const onUnhandled = (error: unknown) => unhandled.push(error);
  process.on('unhandledRejection', onUnhandled);
  t.after(() => process.off('unhandledRejection', onUnhandled));
  const originalAppend = fs.appendFile.bind(fs);
  t.mock.method(fs, 'appendFile', (async (...args: any[]) => {
    const result = await (originalAppend as any)(...args);
    const event = JSON.parse(String(args[1]));
    if (event.type === 'message') {
      transcriptPath = String(args[0]);
      persisted.push(event);
      // The first write has really completed before the next guarded append.
      revoked = true;
    }
    return result;
  }) as any);
  const sent: any[] = [];
  const run = spawnKimiAgent('question', { sessionId: sid, cwd: root }, {
    userId: 7, send: (message: any) => sent.push(message),
    isRunOutputRevoked: () => revoked,
  });
  // Act: queue multiple transcript messages, then revoke between their writes.
  await awaitChild(sent);
  const emit = (row: any) => child.stdout.write(`${JSON.stringify(row)}\n`);
  emit({ type: 'tool_use', id: 'revoked-tool', name: 'Read', input: {} });
  emit({ type: 'tool_result', tool_id: 'revoked-tool', output: 'must not persist' });
  emit({ type: 'assistant', content: 'must not become a final answer' });
  child.emit('close', 0, null);
  assert.equal(await withDeadline(run, 'Kimi append-revocation run to settle'), undefined);
  await new Promise<void>((resolve) => setImmediate(resolve));
  // Assert: first append succeeded; the next reached the real guard and threw.
  assert.equal(persisted.length, 1);
  assert.equal(persistenceAttempts.length, 2);
  assert.deepEqual(persistenceResults, [null]);
  assert.equal(appendFailures.length, 1);
  assert.ok(appendFailures[0] instanceof Error);
  assert.equal(appendFailures[0].message, 'identity revoked');
  const diskRows = (await fs.readFile(transcriptPath, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(diskRows.filter(row => row.type === 'message'), persisted);
  assert.equal(diskRows.some(row => row.message?.isFinalAnswer), false);
  assert.equal(JSON.stringify(diskRows).includes('must not'), false);
  assert.deepEqual(timings, []);
  assert.equal(presenceEnds, 1);
  assert.equal(terminalNotifications.length, 1);
  assert.equal(terminalNotifications[0].stopReason, 'completed');
  assert.equal(terminalNotifications[0].sessionId, sid);
  const completed = sent.filter(message => message.kind === 'complete');
  assert.equal(completed.length, 1);
  assert.equal(completed[0].assistantMessageId, undefined);
  assert.deepEqual(unhandled, []);
});
