/**
 * agy adapter side of the declared session handover: the spawn key is adopted
 * and the brain UUID announced ONLY after the isolation layer accepts, in the
 * order verdict -> adopt -> emit with nothing awaited in between (qa M3), and
 * never for a revoked run, a refused request or a missing seam.
 */
// T-1873: harness CLIs resolve to sandbox stubs, never the host's installs.
import './shared/__tests__/stub-harness-binaries.js';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { after, mock, test } from 'node:test';

const root = await fs.mkdtemp(path.join(process.env.TMPDIR!, 'agy-handover-adapter-'));
after(() => fs.rm(root, { recursive: true, force: true }));
mock.method(os, 'homedir', () => root);
const brainRoot = path.join(root, '.gemini', 'antigravity-cli', 'brain');

const events: string[] = [];
let child: (EventEmitter & Record<string, unknown>) | null = null;
const named = (url: string, exports: Record<string, unknown>) => mock.module(url, { namedExports: exports });
const refuse = () => assert.fail('unexpected process in provider fixture');
named('child_process', {
  execFileSync: refuse, execFile: refuse, spawnSync: refuse,
  spawn: () => {
    child = new EventEmitter() as EventEmitter & Record<string, unknown>;
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => true;
    return child;
  },
});
mock.module('./sessionManager.js', {
  defaultExport: { getSession: () => null, createSession() {}, saveSession() {}, addMessage() {} },
});
named('./modules/database/index.js', {
  sessionsDb: {
    getSessionById: () => null,
    createSession: (id: string) => { events.push(`create:${id}`); },
    adoptRuntimeSessionId: (from: string, to: string) => { events.push(`adopt:${from}->${to}`); return true; },
  },
  participantsDb: { recordSpawn() {} },
  messageAuthorsDb: { recordUserMessage() {} },
  providerRunFailuresDb: { getFailure: () => null, clearFailure() {}, recordFailure() {}, setFailure() {} },
});
named('./modules/providers/services/provider-models.service.js', {
  providerModelsService: { resolveResumeModel: async () => null, seedSessionModel: async () => {}, getChangedActiveModel: () => null },
});
named('./modules/providers/services/turn-timing.service.js', {
  createTurnTimer: () => ({ markModelActivity() {}, startedAt: () => new Date().toISOString() }),
  settleTurnTiming: () => ({}),
});
named('./modules/providers/services/provider-auth.service.js', { providerAuthService: { isProviderInstalled: async () => true } });
named('./modules/session-workspaces/index.js', { logicalProjectPathForWorkspace: (value: string) => value });
named('./services/isolation/resolve-provider-env.js', { resolveProviderEnv: () => ({ HOME: root }) });
named('./services/isolation/provider-cage-wiring.js', { resolveCagedLaunch: (value: unknown) => value });
named('./services/isolation/sanitize-vendor-agent-env.js', { sanitizeVendorAgentEnv: (value: unknown) => value });
named('./services/provider-run-presence.js', { beginProviderRun: () => ({ end() {}, rekey() {} }) });
named('./services/notification-orchestrator.js', { notifyRunFailed() {}, notifyRunStopped() {} });
named('./shared/cwd-check.js', { checkCwdExists: async () => ({ ok: true }), buildCwdMissingPayload: () => ({}) });
named('./services/isolation/provision-user-dirs.js', { userConfigDir: () => root });
named('./services/provider-sharing.js', { isProviderIsolated: () => false });
named('./modules/providers/list/antigravity/antigravity-project-registry.js', {
  registerAntigravityProjectPath() {}, clearAntigravityProjectPath() {},
});
const { spawnAntigravity } = await import('./agy-cli.js');

type Ws = Record<string, unknown> & { sent: Record<string, unknown>[] };

async function freshRun(ws: Ws, options: Record<string, unknown>, beforeClose?: () => void) {
  events.length = 0;
  child = null;
  const run = spawnAntigravity('hi', { cwd: root, ...options }, ws);
  for (let waited = 0; !child && waited < 5000; waited += 5) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.ok(child, 'agy was spawned');
  const brainId = randomUUID();
  await fs.mkdir(path.join(brainRoot, brainId, '.system_generated', 'logs'), { recursive: true });
  (child.stdout as PassThrough).write('ok');
  await new Promise((resolve) => setTimeout(resolve, 20));
  beforeClose?.();
  child.emit('close', 0, null);
  await run;
  const created = ws.sent.filter((frame) => frame.kind === 'session_created');
  return { brainId, created, spawnKey: String(created[0]?.newSessionId) };
}

function writer(extra: Record<string, unknown> = {}): Ws {
  const ws: Ws = { userId: 7, sent: [], ...extra } as Ws;
  ws.send = (frame: Record<string, unknown>) => {
    if (frame.kind === 'session_created') events.push(`emit:${frame.newSessionId}`);
    ws.sent.push(frame);
  };
  return ws;
}

test('accepted: verdict, then adopt, then ONE announcement carrying parentSessionId', async () => {
  const requests: unknown[] = [];
  const ws = writer({
    requestSessionHandover: (request: unknown) => {
      requests.push(request);
      events.push('verdict');
      return { accepted: true, reason: 'accepted' };
    },
  });
  const { brainId, created, spawnKey } = await freshRun(ws, { nassajWorkspaceIsolation: 'overlay' });
  assert.equal(requests.length, 1);
  const request = requests[0] as { from: string; to: string; spawnStartedAtMs: number };
  assert.equal(request.from, spawnKey);
  assert.equal(request.to, brainId);
  assert.ok(Number.isFinite(request.spawnStartedAtMs));
  const tail = events.slice(events.indexOf('verdict') - 1);
  assert.deepEqual(tail, [`create:${brainId}`, 'verdict', `adopt:${spawnKey}->${brainId}`, `emit:${brainId}`]);
  assert.equal(created.length, 2);
  assert.equal(created[1].parentSessionId, spawnKey);
});

test('rejected: no adopt and no announcement', async () => {
  const ws = writer({ requestSessionHandover: () => ({ accepted: false, reason: 'nope' }) });
  const { created } = await freshRun(ws, { nassajWorkspaceIsolation: 'overlay' });
  assert.equal(events.some((event) => event.startsWith('adopt:')), false);
  assert.equal(created.length, 1);
});

test('a workspace-bound launch without the seam, a throwing seam or a deferred verdict fails closed', async () => {
  for (const extra of [
    {},
    { requestSessionHandover: () => { throw new Error('boom'); } },
    { requestSessionHandover: () => Promise.resolve({ accepted: true }) },
    { requestSessionHandover: () => ({ accepted: 'yes' }) },
  ]) {
    const ws = writer(extra);
    const { created } = await freshRun(ws, { nassajWorkspaceIsolation: 'legacy_shared' });
    assert.equal(events.some((event) => event.startsWith('adopt:')), false);
    assert.equal(created.length, 1);
  }
});

test('a run whose fence was revoked before close never requests, adopts or announces', async () => {
  let revoked = false;
  let asked = false;
  const ws = writer({ requestSessionHandover: () => { asked = true; return { accepted: true }; } });
  Object.defineProperty(ws, 'runFenceRevoked', { get: () => revoked });
  const { created } = await freshRun(ws, { nassajWorkspaceIsolation: 'overlay' }, () => { revoked = true; });
  assert.equal(asked, false);
  assert.equal(events.some((event) => event.startsWith('adopt:')), false);
  assert.equal(created.length, 1);
});

test('a launch with no workspace binding keeps the pre-isolation swap', async () => {
  let asked = false;
  const ws = writer({ requestSessionHandover: () => { asked = true; return { accepted: false }; } });
  const { brainId, created, spawnKey } = await freshRun(ws, {});
  assert.equal(asked, false, 'nothing to rebind, so nothing to ask');
  assert.ok(events.includes(`adopt:${spawnKey}->${brainId}`));
  assert.equal(created[1]?.newSessionId, brainId);
});
