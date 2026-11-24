/**
 * T-2094 acceptance (owner's terms): with NASSAJ_AGY_ACP on, a resumed agy
 * conversation shows ONLY the new reply, once — even though the agent replays
 * the whole history on resume/load, and even after the agent process died
 * between the turns (a server restart).
 *
 * Real child processes: the agy binary is a wrapper around a fake ACP agent
 * (shared/acp/__tests__/fake-acp-agent.mjs) that replays history on BOTH
 * session/resume and session/load.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { writeFileSync, chmodSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, mock, test } from 'node:test';

import { installFakeHarnessBinary } from './shared/__tests__/harness-binary-fixtures.js';

const root = await fs.mkdtemp(path.join(process.env.TMPDIR ?? '/var/tmp', 'agy-acp-accept-'));
after(() => fs.rm(root, { recursive: true, force: true }));
mock.method(os, 'homedir', () => root);
const agentScript = path.resolve(import.meta.dirname, 'modules/providers/shared/acp/__tests__/fake-acp-agent.mjs');
const agyBin = installFakeHarnessBinary(root, 'antigravity');
writeFileSync(agyBin, `#!/bin/sh\nexec '${process.execPath}' '${agentScript}' "$@"\n`);
chmodSync(agyBin, 0o755);
process.env.NASSAJ_AGY_ACP = '1';

const sessions = new Map<string, any>();
const rows = new Map<string, any>();
const named = (url: string, exports: Record<string, unknown>) => mock.module(url, { namedExports: exports });
mock.module('./sessionManager.js', { defaultExport: {
  getSession: (id: string) => sessions.get(id) ?? null,
  createSession: (id: string) => sessions.set(id, { id }),
  saveSession() {},
  addMessage() {},
} });
named('./modules/database/index.js', {
  sessionsDb: {
    getSessionById: (id: string) => rows.get(id) ?? null,
    recordDiscoveredSession: (row: any) => rows.set(row.sessionId, {
      session_id: row.sessionId, provider: row.provider, jsonl_path: row.jsonlPath,
    }),
    adoptRuntimeSessionId() {},
  },
  participantsDb: { recordSpawn() {} },
  messageAuthorsDb: { recordUserMessage() {} },
  providerRunFailuresDb: { getFailure: () => null, clearFailure() {}, recordFailure() {}, setFailure() {} },
});
named('./modules/providers/services/provider-models.service.js', { providerModelsService: {
  getProviderModels: async () => ({ models: { OPTIONS: [] } }), getChangedActiveModel: async () => null,
} });
named('./services/isolation/resolve-provider-env.js', {
  resolveProviderEnv: () => ({
    ...Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith('FAKE_ACP_'))),
    HOME: root,
    PATH: process.env.PATH ?? '',
  }),
});
named('./services/isolation/provider-cage-wiring.js', { resolveCagedLaunch: (value: unknown) => value });
named('./services/provider-run-presence.js', {
  beginProviderRun: ({ launchReservation }: any) => ({ end() { launchReservation?.(); }, rekey() {}, setPid() {} }),
});
named('./services/notification-orchestrator.js', { notifyRunFailed() {}, notifyRunStopped() {} });
named('./modules/providers/services/turn-timing.service.js', {
  createTurnTimer: () => ({ markModelActivity() {}, startedAt: () => new Date().toISOString() }),
  settleTurnTiming: (value: any) => ({ assistantMessageId: value.assistantMessageId }),
});
named('./modules/providers/services/provider-auth.service.js', { providerAuthService: { isProviderInstalled: async () => true } });
named('./modules/session-workspaces/index.js', { logicalProjectPathForWorkspace: (value: string) => value });
named('./services/isolation/sanitize-vendor-agent-env.js', { sanitizeVendorAgentEnv: (value: unknown) => value });
named('./shared/cwd-check.js', { checkCwdExists: async () => ({ ok: true }), buildCwdMissingPayload: () => ({}) });
named('./services/isolation/provision-user-dirs.js', { userConfigDir: () => root });
named('./modules/providers/list/antigravity/antigravity-project-registry.js', {
  registerAntigravityProjectPath() {}, clearAntigravityProjectPath() {},
});

const { spawnAntigravity } = await import('./agy-cli.js');
const { agyAcpPool } = await import('./modules/providers/list/antigravity/agy-acp-runner.js');
after(() => agyAcpPool.shutdown());

/** Runs one turn and returns what the client saw. */
async function turn(command: string, sessionId?: string) {
  const sent: any[] = [];
  const writer = { userId: 7, send: (m: any) => sent.push(m), setSessionId() {} };
  const result = await spawnAntigravity(command, { sessionId, cwd: root }, writer);
  const text = sent.filter((m) => m.kind === 'stream_delta').map((m) => m.content).join('');
  const complete = sent.find((m) => m.kind === 'complete');
  const created = sent.filter((m) => m.kind === 'session_created').at(-1);
  return { sent, text, complete, created, result };
}

async function fixtureLog() {
  const raw = await fs.readFile(path.join(root, '.fake-acp.log'), 'utf8').catch(() => '');
  return raw.split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

async function killAgentProcesses() {
  for (const pid of new Set((await fixtureLog()).filter((e) => e.event === 'spawn').map((e) => e.pid))) {
    try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
  }
  const deadline = Date.now() + 5000;
  while (agyAcpPool.size() > 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
  assert.equal(agyAcpPool.size(), 0, 'the pool notices the dead process');
}

for (const restart of [false, true]) {
  test(`ACP: turn 2 shows only reply 2, once (process ${restart ? 'killed' : 'kept'} between turns)`, async () => {
    const first = await turn('hello');
    assert.equal(first.complete?.exitCode, 0, JSON.stringify(first.sent));
    assert.equal(first.text, 'reply 1');
    const brain = first.created?.newSessionId;
    assert.match(brain, /^[0-9a-f-]{36}$/, 'the client is handed the brain UUID');
    if (restart) await killAgentProcesses();
    const second = await turn('again', brain);
    assert.equal(second.complete?.exitCode, 0, JSON.stringify(second.sent));
    assert.equal(second.text, 'reply 2', 'no history replay, the reply once');
    const resumed = (await fixtureLog()).filter((e) => e.event === 'resume' && e.sessionId === brain);
    assert.equal(resumed.length, restart ? 1 : 0, 'a restart resumes (and the agent replays history)');
  });
}

test('ACP: session/load fallback (resume unsupported) still shows only the new reply', async () => {
  const first = await turn('hello');
  const brain = first.created?.newSessionId;
  await killAgentProcesses();
  process.env.FAKE_ACP_NO_RESUME = '1';
  try {
    const second = await turn('again', brain);
    assert.equal(second.text, 'reply 2');
    assert.equal((await fixtureLog()).filter((e) => e.event === 'load' && e.sessionId === brain).length, 1);
  } finally {
    delete process.env.FAKE_ACP_NO_RESUME;
  }
});
