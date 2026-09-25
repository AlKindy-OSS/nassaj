/**
 * T-1854 (qa H1c) — qwen: a run fence revoked at any await point of the
 * launch (session_created ~255, awaits ~252/287/292) either prevents the
 * spawn, or the process is registered (activeQwenProcesses ~344) in the same
 * synchronous block, so abortQwenSession succeeds right after spawn.
 */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { after, mock, test } from 'node:test';

import {
  createProbeWriter,
  io,
  launchAlreadyRevoked,
  observeSpawn,
  sweepRevocationAcrossLaunch,
  type ProbeWriter,
  type SpawnObservation,
} from './run-fence-sweep.test-helper.js';

let unexpectedProcessCalls = 0;
const rejectUnexpectedProcess = () => {
  unexpectedProcessCalls += 1;
  assert.fail('unexpected process in provider fixture');
};
after(() => assert.equal(unexpectedProcessCalls, 0));

let currentWriter: ProbeWriter = createProbeWriter();
let child: EventEmitter | null = null;
const observation: { current: SpawnObservation | null } = { current: null };
let abortRun: (sessionId: string) => boolean = () => false;

const named = (url: string, exports: Record<string, unknown>) => mock.module(url, { namedExports: exports });
// No pid: the group-kill path must never signal a real process group here.
named('node:child_process', {
  execFileSync: rejectUnexpectedProcess, execFile: rejectUnexpectedProcess, spawnSync: rejectUnexpectedProcess,
  spawn: () => {
    const created = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(), stderr: new PassThrough(), kill: () => true,
    });
    child = created;
    observeSpawn(currentWriter, (sessionId) => abortRun(sessionId), observation);
    return created;
  },
});
named('./modules/database/index.js', {
  sessionsDb: { createSession() {} }, participantsDb: { recordSpawn() {} }, messageAuthorsDb: { recordUserMessage() {} },
});
named('./modules/providers/list/qwen/qwen-execution-contract.js', {
  qwenExecutionContract: { issueGesture: () => '', authorizeSpawn() {} },
});
named('./modules/providers/services/provider-models.service.js', {
  providerModelsService: { resolveResumeModel: () => io('fixture'), seedSessionModel: () => io(undefined) },
});
named('./modules/providers/services/turn-timing.service.js', {
  createTurnTimer: () => ({ markModelActivity() {}, startedAt: () => new Date().toISOString() }),
  settleTurnTiming: () => ({}),
});
named('./modules/providers/services/provider-auth.service.js', { providerAuthService: { isProviderInstalled: () => io(true) } });
named('./modules/providers/services/provider-secrets.service.js', {
  providerSecretsService: {
    getStatus: () => ({ configured: true }),
    getQwenProfile: () => ({ plan: 'coding_plan', region: 'international', key: 'fixture' }),
  },
});
named('./modules/providers/list/qwen/qwen.provider.js', {
  qwenModelsForPlan: () => ({ OPTIONS: [{ value: 'fixture' }], DEFAULT: 'fixture' }),
});
named('./modules/providers/shared/vendor/vendor-transcript.js', {
  appendVendorTranscriptTurn: () => io('persisted-id'),
  vendorTranscriptPath: () => '/fixture',
  writeVendorTranscriptMeta: () => io(undefined),
});
named('./services/isolation/resolve-provider-env.js', { resolveProviderEnv: () => ({}) });
named('./services/isolation/provider-cage-wiring.js', { resolveCagedLaunch: (value: unknown) => value });
named('./services/isolation/sanitize-vendor-agent-env.js', { sanitizeVendorAgentEnv: (value: unknown) => value });
named('./services/provider-run-presence.js', { beginProviderRun: () => ({ end() {} }) });
named('./services/notification-orchestrator.js', { notifyRunFailed() {}, notifyRunStopped() {} });
named('./shared/cwd-check.js', { checkCwdExists: () => io({ ok: true }), buildCwdMissingPayload: () => ({}) });
named('./shared/utils.js', {
  createNormalizedMessage: (value: unknown) => value, stampCoordinatorId: (value: unknown) => value,
});
const { spawnQwen, abortQwenSession } = await import('./qwen-cli.js');
abortRun = abortQwenSession;

const launch = (writer: ProbeWriter) => {
  currentWriter = writer;
  return spawnQwen('fixture', { cwd: process.cwd() }, writer as never);
};
const settle = () => child?.emit('close', null, 'SIGINT');

test('qa H1c qwen: revocation at every await point never leaves an unabortable spawn', async () => {
  const outcome = await sweepRevocationAcrossLaunch({ launch, observation, settle });
  assert.ok(outcome.revokedBeforeSpawn >= 1, 'at least one pre-spawn await point was exercised');
});

test('qa H1b qwen: a fence already revoked at launch never spawns', async () => {
  await launchAlreadyRevoked({ launch, observation, settle });
});
