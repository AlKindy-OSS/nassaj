/**
 * T-1854 (qa H1c) — agy: a run fence revoked at any await point of the launch
 * either prevents the spawn, or the spawned process is already registered so
 * abortAntigravitySession succeeds right after spawn (setSessionId ~751,
 * spawn ~890 and activeSessions.set ~909 are one synchronous block).
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
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
const root = await fs.mkdtemp(path.join(process.env.TMPDIR ?? os.tmpdir(), 'agy-run-fence-'));
after(() => fs.rm(root, { recursive: true, force: true }));
mock.method(os, 'homedir', () => root);

let currentWriter: ProbeWriter = createProbeWriter();
let child: (EventEmitter & Record<string, unknown>) | null = null;
const observation: { current: SpawnObservation | null } = { current: null };
let abortRun: (sessionId: string) => boolean = () => false;

const named = (url: string, exports: Record<string, unknown>) => mock.module(url, { namedExports: exports });
named('child_process', {
  execFileSync: rejectUnexpectedProcess, execFile: rejectUnexpectedProcess, spawnSync: rejectUnexpectedProcess,
  spawn: () => {
    const created = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(), kill: () => true,
    });
    child = created;
    observeSpawn(currentWriter, (sessionId) => abortRun(sessionId), observation);
    return created;
  },
});
mock.module('./sessionManager.js', {
  defaultExport: { getSession: () => null, createSession() {}, saveSession() {}, addMessage() {} },
});
named('./modules/database/index.js', {
  sessionsDb: { getSessionById: () => null, createSession() {} },
  participantsDb: { recordSpawn() {} },
  messageAuthorsDb: { recordUserMessage() {} },
  providerRunFailuresDb: { getFailure: () => null, clearFailure() {}, recordFailure() {}, setFailure() {} },
});
named('./modules/providers/services/provider-models.service.js', {
  providerModelsService: {
    resolveResumeModel: () => io('fixture'), seedSessionModel: () => io(undefined), getChangedActiveModel: () => null,
  },
});
named('./modules/providers/services/turn-timing.service.js', {
  createTurnTimer: () => ({ markModelActivity() {}, startedAt: () => new Date().toISOString() }),
  settleTurnTiming: () => ({}),
});
named('./modules/providers/services/provider-auth.service.js', { providerAuthService: { isProviderInstalled: () => io(true) } });
named('./modules/session-workspaces/index.js', { logicalProjectPathForWorkspace: (value: string) => value });
named('./services/isolation/resolve-provider-env.js', { resolveProviderEnv: () => ({ HOME: root }) });
named('./services/isolation/provider-cage-wiring.js', { resolveCagedLaunch: (value: unknown) => value });
named('./services/isolation/sanitize-vendor-agent-env.js', { sanitizeVendorAgentEnv: (value: unknown) => value });
named('./services/provider-run-presence.js', { beginProviderRun: () => ({ end() {}, rekey() {} }) });
named('./services/notification-orchestrator.js', { notifyRunFailed() {}, notifyRunStopped() {} });
named('./shared/cwd-check.js', { checkCwdExists: () => io({ ok: true }), buildCwdMissingPayload: () => ({}) });
named('./services/isolation/provision-user-dirs.js', { userConfigDir: () => root });
named('./services/provider-sharing.js', { isProviderIsolated: () => false });
named('./modules/providers/list/antigravity/antigravity-project-registry.js', {
  registerAntigravityProjectPath() {}, clearAntigravityProjectPath() {},
});
const { spawnAntigravity, abortAntigravitySession } = await import('./agy-cli.js');
abortRun = abortAntigravitySession;

test('qa H1c agy: revocation at every await point never leaves an unabortable spawn', async () => {
  const outcome = await sweepRevocationAcrossLaunch({
    launch: (writer) => {
      currentWriter = writer;
      return spawnAntigravity('question', { cwd: root }, writer);
    },
    observation,
    settle: () => child?.emit('close', null, 'SIGTERM'),
  });
  assert.ok(outcome.revokedBeforeSpawn >= 1, 'at least one pre-spawn await point was exercised');
});

test('qa H1b agy: a fence already revoked at launch never spawns', async () => {
  await launchAlreadyRevoked({
    launch: (writer) => {
      currentWriter = writer;
      return spawnAntigravity('question', { cwd: root }, writer);
    },
    observation,
    settle: () => child?.emit('close', null, 'SIGTERM'),
  });
});
