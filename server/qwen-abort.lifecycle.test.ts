import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { after, mock, test } from 'node:test';
let unexpectedProcessCalls = 0;
const rejectUnexpectedProcess = () => {
  unexpectedProcessCalls++;
  assert.fail('unexpected process in provider fixture');
};
after(() => assert.equal(unexpectedProcessCalls, 0));
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
let timing = 0;
let onAppend = () => {};
let completedAt: string | undefined;
const written: any[] = [];
const named = (url: string, exports: Record<string, unknown>) => mock.module(url, { namedExports: exports });
named('node:child_process', { execFileSync: rejectUnexpectedProcess, execFile: rejectUnexpectedProcess, spawnSync: rejectUnexpectedProcess, spawn: () => { childGeneration = generation; child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => true; return child; } });
named('./modules/database/index.js', { sessionsDb: { createSession() { } }, participantsDb: { recordSpawn() { } }, messageAuthorsDb: { recordUserMessage() { } } });
named('./modules/providers/list/qwen/qwen-execution-contract.js', { qwenExecutionContract: { issueGesture: () => '', authorizeSpawn() { } } });
named('./modules/providers/services/provider-models.service.js', { providerModelsService: { resolveResumeModel: async () => 'fixture', seedSessionModel: async () => { } } });
named('./modules/providers/services/turn-timing.service.js', { createTurnTimer: () => ({ markModelActivity() { }, startedAt: () => new Date().toISOString() }), settleTurnTiming: (value: any) => { completedAt = value.completedAt; timing++; return {}; } });
named('./modules/providers/services/provider-auth.service.js', { providerAuthService: { isProviderInstalled: async () => true } });
named('./modules/providers/services/provider-secrets.service.js', { providerSecretsService: { getStatus: () => ({ configured: true }), getQwenProfile: () => ({ plan: 'coding_plan', region: 'international', key: 'fixture' }) } });
named('./modules/providers/list/qwen/qwen.provider.js', { qwenModelsForPlan: () => ({ OPTIONS: [{ value: 'fixture' }], DEFAULT: 'fixture' }) });
named('./modules/providers/shared/vendor/vendor-transcript.js', { appendVendorTranscriptTurn: async (...args: any[]) => { written.push(args); onAppend(); return 'persisted-id'; }, vendorTranscriptPath: () => '/fixture', writeVendorTranscriptMeta: async () => { } });
named('./services/isolation/resolve-provider-env.js', { resolveProviderEnv: () => ({}) });
named('./services/isolation/provider-cage-wiring.js', { resolveCagedLaunch: (value: unknown) => value });
named('./services/isolation/sanitize-vendor-agent-env.js', { sanitizeVendorAgentEnv: (value: unknown) => value });
named('./services/provider-run-presence.js', { beginProviderRun: () => ({ end() { } }) });
named('./services/notification-orchestrator.js', { notifyRunFailed() { }, notifyRunStopped() { } });
named('./shared/cwd-check.js', { checkCwdExists: async () => ({ ok: true }), buildCwdMissingPayload: () => ({}) });
named('./shared/utils.js', { createNormalizedMessage: (value: unknown) => value, stampCoordinatorId: (value: unknown) => value });
const { spawnQwen, abortQwenSession } = await import('./qwen-cli.js');
for (const mode of ['abort', 'signal', 'success'])
    test(`actual Qwen lifecycle ${mode} then close zero`, async (t) => {
        t.mock.timers.enable({apis: ['Date']});
        const endedAt = '2026-09-05T12:00:00.000Z';
        t.mock.timers.setTime(Date.parse(endedAt));
        onAppend = () => t.mock.timers.tick(5000);
        t.after(() => { onAppend = () => {}; });
        child = null;
        generation++;
        timing = 0;
        written.length = 0;
        const sent: any[] = [];
        const run = spawnQwen('fixture', { sessionId: 'fixture-session', cwd: process.cwd() }, { userId: 7, send: (message: any) => sent.push(message) });
        const started = process.hrtime.bigint();
        // Real sleeps, not setImmediate spins: threadpool fs callbacks need wall time.
        while ((!child || childGeneration !== generation) && elapsedMs(started) < DEADLINE_MS)
            await new Promise(resolve => setTimeout(resolve, 1));
        assert.ok(child && childGeneration === generation, `spawn was not called within ${DEADLINE_MS}ms: ${JSON.stringify(sent)}`);
        child.stdout.write(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'partial response' }] } }) + '\n');
        if (mode === 'abort')
            assert.equal(abortQwenSession('fixture-session'), true);
        t.mock.timers.setTime(Date.parse(endedAt));
        child.emit('close', 0, mode === 'signal' ? 'SIGTERM' : null);
        await withDeadline(run, `spawnQwen(${mode}) to settle`);
        const assistant = written.find(args => args[3] === 'assistant');
        assert.ok(assistant);
        assert.equal(assistant[4], 'partial response');
        assert.equal(assistant[5].finalAnswer, mode === 'success');
        assert.equal(timing, mode === 'success' ? 1 : 0);
        if (mode === 'success') assert.equal(completedAt, endedAt);
        assert.equal(sent.find(message => message.kind === 'complete').success, mode === 'success');
    });
test('B-1078: a busy Qwen session echoes only the rejected send\'s clientMsgId', async () => {
    child = null;
    generation++;
    const sent: any[] = [];
    const run = spawnQwen('fixture', { sessionId: 'busy-session', cwd: process.cwd() }, { userId: 7, send: (message: any) => sent.push(message) });
    const started = process.hrtime.bigint();
    while ((!child || childGeneration !== generation) && elapsedMs(started) < DEADLINE_MS)
        await new Promise(resolve => setTimeout(resolve, 1));
    assert.ok(child && childGeneration === generation, 'first run spawned');
    const rejected: any[] = [];
    await spawnQwen('second', { sessionId: 'busy-session', clientMsgId: 'cmid_rejected' }, { userId: 7, send: (message: any) => rejected.push(message) });
    const plain: any[] = [];
    await spawnQwen('third', { sessionId: 'busy-session' }, { userId: 7, send: (message: any) => plain.push(message) });
    assert.deepEqual(rejected.filter(m => m.code === 'session_busy').map(m => m.clientMsgId), ['cmid_rejected']);
    assert.equal('clientMsgId' in plain.find(m => m.code === 'session_busy'), false, 'nothing invented without a clientMsgId');
    assert.equal(sent.some(m => m.code === 'session_busy'), false, 'the running turn is not told it is busy');
    child.emit('close', 0, null);
    await withDeadline(run, 'busy-session first run to settle');
});
