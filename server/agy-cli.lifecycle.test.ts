import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
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
let child: any;
// CI hardening: `child` must be awaited on a wall clock, not on a fixed number of
// event-loop turns. spawnAntigravity performs ~10 real fs awaits (readdir/stat/
// readFile/mkdir/lock) before it reaches spawn(); on a loaded CI runner those do not
// complete within a bounded tick budget, the assert fires, and the abandoned run then
// hands its child to a later test whose own run never settles -> the suite hangs forever.
const DEADLINE_MS = Number(process.env.NASSAJ_TEST_DEADLINE_MS || 30000);
// Bind the wall clock before any t.mock.timers call: a mocked setTimeout would turn every
// deadline below into an infinite wait (release run 34028358559 hung 88 minutes here).
const realSetTimeout = setTimeout;
const realClearTimeout = clearTimeout;
// process.hrtime is immune to t.mock.timers.enable({ apis: ['Date'] }) used below.
const elapsedMs = (start: bigint) => Number(process.hrtime.bigint() - start) / 1e6;
const withDeadline = async <T>(promise: Promise<T>, label: string): Promise<T> => {
  let timer: NodeJS.Timeout | undefined;
  const guard = new Promise<never>((_, reject) => {
    timer = realSetTimeout(() => reject(new Error(`timed out after ${DEADLINE_MS}ms waiting for ${label}`)), DEADLINE_MS);
  });
  try { return await Promise.race([promise, guard]); } finally { realClearTimeout(timer); }
};
let generation = 0;
let childGeneration = -1;
const timings: any[] = [];
const saved: any[] = [];
let sid = '';
let transcript = '';
const named = (url: string, exports: Record<string, unknown>) => mock.module(url, { namedExports: exports });
named('child_process', { execFileSync: rejectUnexpectedProcess, execFile: rejectUnexpectedProcess, spawnSync: rejectUnexpectedProcess, spawn: () => { childGeneration = generation; child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough(); child.kill = () => true; return child; } });
mock.module('./sessionManager.js', { defaultExport: { getSession: () => ({ cliSessionId: sid }), createSession() { }, saveSession() { }, addMessage: (...args: any[]) => saved.push(args) } });
named('./modules/database/index.js', { sessionsDb: { getSessionById: () => transcript ? ({ jsonl_path: transcript }) : null, createSession() { } }, participantsDb: { recordSpawn() { } }, messageAuthorsDb: { recordUserMessage() { } }, providerRunFailuresDb: { getFailure: () => null, clearFailure() { }, recordFailure() { }, setFailure() { } } });
named('./modules/providers/services/provider-models.service.js', { providerModelsService: { resolveResumeModel: async () => 'fixture', seedSessionModel: async () => { }, getChangedActiveModel: () => null } });
named('./modules/providers/services/turn-timing.service.js', { createTurnTimer: () => ({ markModelActivity() { }, startedAt: () => new Date().toISOString() }), settleTurnTiming: (value: any) => { timings.push(value); return { assistantMessageId: value.assistantMessageId }; } });
named('./modules/providers/services/provider-auth.service.js', { providerAuthService: { isProviderInstalled: async () => true } });
named('./modules/session-workspaces/index.js', { logicalProjectPathForWorkspace: (value: string) => value });
named('./services/isolation/resolve-provider-env.js', { resolveProviderEnv: () => ({ HOME: root }) });
named('./services/isolation/provider-cage-wiring.js', { resolveCagedLaunch: (value: unknown) => value });
named('./services/isolation/sanitize-vendor-agent-env.js', { sanitizeVendorAgentEnv: (value: unknown) => value });
named('./services/provider-run-presence.js', { beginProviderRun: () => ({ end() { }, rekey() { } }) });
named('./services/notification-orchestrator.js', { notifyRunFailed() { }, notifyRunStopped() { } });
named('./shared/cwd-check.js', { checkCwdExists: async () => ({ ok: true }), buildCwdMissingPayload: () => ({}) });
async function awaitChild(sent: any[]) {
  const start = process.hrtime.bigint();
  // Real sleeps, not setImmediate spins: threadpool fs callbacks need wall time to land.
  while ((!child || childGeneration !== generation) && elapsedMs(start) < DEADLINE_MS) {
    await new Promise(resolve => realSetTimeout(resolve, 1));
  }
  assert.ok(child && childGeneration === generation, `spawn was not called within ${DEADLINE_MS}ms: ${JSON.stringify(sent)}`);
}
named('./services/isolation/provision-user-dirs.js', { userConfigDir: () => root });
named('./services/provider-sharing.js', { isProviderIsolated: () => false });
named('./modules/providers/list/antigravity/antigravity-project-registry.js', { registerAntigravityProjectPath() { }, clearAntigravityProjectPath() { } });
const { spawnAntigravity, abortAntigravitySession } = await import('./agy-cli.js');
const { AntigravitySessionsProvider } = await import('./modules/providers/list/antigravity/antigravity-sessions.provider.js');
for (const mode of ['success', 'abort', 'signal', 'error']) test(`AGY actual runner/native transcript/history: ${mode}`, async (t) => {
  t.mock.timers.enable({ apis: ['Date'] });
  const endedAt = '2026-09-05T12:00:00.000Z';
  t.mock.timers.setTime(Date.parse(endedAt));
  sid = `agy-${mode}`; child = null; generation++; timings.length = 0; saved.length = 0;
  transcript = path.join(root, '.gemini/antigravity-cli/brain', sid, '.system_generated/logs/transcript.jsonl');
  await fs.mkdir(path.dirname(transcript), { recursive: true });
  const baseline = JSON.stringify({ step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', content: '<instructions>fixture</instructions>' }) + '\n';
  await fs.writeFile(transcript, baseline);
  const sent: any[] = [];
  const run = spawnAntigravity('question', { sessionId: sid, cwd: root }, { userId: 7, send: (m: any) => sent.push(m) }).then(value => value, error => error);
  await awaitChild(sent);
  await fs.appendFile(transcript, JSON.stringify({ step_index: 1, source: 'MODEL', type: 'PLANNER_RESPONSE', status: mode === 'success' ? 'DONE' : 'RUNNING', content: 'answer' }) + '\n');
  child.stdout.write('answer');
  if (mode === 'abort') assert.equal(abortAntigravitySession(sid), true);
  if (mode === 'error') child.stderr.write('Error: fixture failure\n');
  const read = fs.readFile.bind(fs);
  t.mock.method(fs, 'readFile', ((...args: any[]) => { t.mock.timers.tick(5000); return (read as any)(...args); }) as any);
  child.emit('close', 0, mode === 'signal' ? 'SIGTERM' : null);
  await withDeadline(run, `spawnAntigravity(${mode}) to settle`);
  assert.ok(saved.some(args => args[1] === 'assistant' && args[2] === 'answer'));
  assert.equal(timings.length, mode === 'success' ? 1 : 0);
  const history = await withDeadline(new AntigravitySessionsProvider().fetchHistory(sid), `fetchHistory(${sid})`);
  assert.ok(history.messages.some(m => m.content === 'answer'));
  if (mode === 'success') {
    assert.equal(timings[0].completedAt, endedAt, 'native history I/O is not model duration');
    assert.equal(history.messages.find(m => m.content === 'answer')?.id, timings[0].assistantMessageId);
    assert.equal(sent.find(m => m.kind === 'complete').assistantMessageId, timings[0].assistantMessageId);
  } else {
    assert.equal(history.messages.some(m => m.isFinalAnswer), false);
    assert.equal(sent.find(m => m.kind === 'complete').assistantMessageId, undefined);
  }
  assert.equal(sent.find(m => m.kind === 'complete').exitCode, mode === 'success' ? 0 : 1);
});
