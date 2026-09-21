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
