/**
 * T-1854 (qa H1c) — hermes: a run fence revoked at any await point of the
 * launch (checkCwdExists ~202 is the last) either prevents the spawn, or the
 * spawned process is registered (activeHermesProcesses ~479) in the same
 * synchronous block, so abortHermesSession succeeds right after spawn.
 */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import test, { after, mock } from 'node:test';

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

const url = (relativePath: string) => new URL(relativePath, import.meta.url).href;
let currentWriter: ProbeWriter = createProbeWriter();
let child: EventEmitter | null = null;
const observation: { current: SpawnObservation | null } = { current: null };
let abortRun: (sessionId: string) => boolean = () => false;

// No pid: the group-kill path must never signal a real process group here.
const spawnFake = () => {
  const created = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: () => true,
  });
  child = created;
  observeSpawn(currentWriter, (sessionId) => abortRun(sessionId), observation);
  return created;
};
mock.module('child_process', {
  namedExports: {
    execFileSync: rejectUnexpectedProcess, execFile: rejectUnexpectedProcess, spawnSync: rejectUnexpectedProcess,
    spawn: spawnFake,
  },
});
mock.module('cross-spawn', { defaultExport: spawnFake });
mock.module(url('./modules/providers/services/sessions.service.js'), { namedExports: { sessionsService: {} } });
mock.module(url('./modules/providers/services/provider-auth.service.js'), {
  namedExports: { providerAuthService: { isProviderInstalled: () => io(true) } },
});
mock.module(url('./modules/providers/services/provider-models.service.js'), {
  namedExports: {
    providerModelsService: {
      resolveResumeModel: (_provider: string, _sessionId: string, model: string) => io(model),
      seedSessionModel: () => io(undefined),
    },
  },
});
mock.module(url('./modules/database/index.js'), {
  namedExports: {
    sessionsDb: { createSession: () => undefined },
    participantsDb: { recordSpawn: () => undefined },
    messageAuthorsDb: { recordUserMessage: () => undefined },
    responseTurnMetricsDb: {
      recordCompleted: () => ({ status: 'inserted', metric: null }), sumSessionDuration: () => null,
    },
  },
});
mock.module(url('./services/isolation/resolve-provider-env.js'), { namedExports: { resolveProviderEnv: () => ({}) } });
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
  namedExports: { checkCwdExists: () => io({ ok: true }), buildCwdMissingPayload: () => ({}) },
});
mock.module(url('./shared/spawn-error.js'), {
  namedExports: { mapSpawnError: (error: Error) => ({ code: 'spawn_error', fallbackMessage: error.message }) },
});
mock.module(url('./services/provider-run-presence.js'), {
  namedExports: { beginProviderRun: () => ({ end: () => undefined, rekey: () => undefined }) },
});
mock.module(url('./modules/providers/shared/vendor/vendor-transcript.js'), {
  namedExports: {
    appendVendorTranscriptTurn: () => io('saved'),
    writeVendorTranscriptMeta: () => io(undefined),
    vendorTranscriptPath: () => '/synthetic-hermes-transcript.jsonl',
  },
});
mock.module(url('./modules/providers/list/hermes/hermes-runtime.js'), {
  namedExports: { readHermesRuntimeConfig: () => io({ provider: null }) },
});

const hermes = await import('./hermes-cli.js');
abortRun = hermes.abortHermesSession;
after(() => mock.restoreAll());

const launch = (writer: ProbeWriter) => {
  currentWriter = writer;
  return hermes.spawnHermes('answer', { cwd: process.cwd() }, writer as never);
};
const settle = () => child?.emit('close', null, 'SIGTERM');

test('qa H1c hermes: revocation at every await point never leaves an unabortable spawn', async () => {
  const outcome = await sweepRevocationAcrossLaunch({ launch, observation, settle });
  assert.ok(outcome.revokedBeforeSpawn >= 1, 'at least one pre-spawn await point was exercised');
});

test('qa H1b hermes: a fence already revoked at launch never spawns', async () => {
  await launchAlreadyRevoked({ launch, observation, settle });
});
