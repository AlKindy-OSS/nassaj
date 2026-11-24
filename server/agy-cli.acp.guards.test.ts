/**
 * T-2094 guard parity and behaviour of the agy ACP path (NASSAJ_AGY_ACP on).
 * Real fake-agent children; `spawn` and the isolation helpers are wrapped to
 * record what the launcher asked for.
 */
import assert from 'node:assert/strict';
import * as realChildProcess from 'node:child_process';
import { chmodSync, cpSync, utimesSync, writeFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, afterEach, mock, test } from 'node:test';

import { installFakeHarnessBinary } from './shared/__tests__/harness-binary-fixtures.js';

const root = await fs.mkdtemp(path.join(process.env.TMPDIR ?? '/var/tmp', 'agy-acp-guards-'));
after(() => fs.rm(root, { recursive: true, force: true }));
mock.method(os, 'homedir', () => root);
const agentScript = path.resolve(import.meta.dirname, 'modules/providers/shared/acp/__tests__/fake-acp-agent.mjs');
const agyBin = installFakeHarnessBinary(root, 'antigravity');
writeFileSync(agyBin, `#!/bin/sh\nexec '${process.execPath}' '${agentScript}' "$@"\n`);
chmodSync(agyBin, 0o755);
process.env.NASSAJ_AGY_ACP = '1';

const memberHome = (userId: number) => path.join(root, `u${userId}`);
for (const id of [7, 8, 9, 11, 12, 13, 14, 15]) await fs.mkdir(memberHome(id), { recursive: true });
const spawns: Array<{ cmd: string; args: string[]; env: any }> = [];
const cageCalls: any[] = [];
let envRefusal: Error | null = null;
let presenceThrows = false;
const sessions = new Map<string, any>();
const grants = new Map<number, number>();
const rows = new Map<string, any>();
const named = (url: string, exports: Record<string, unknown>) => mock.module(url, { namedExports: exports });
named('child_process', {
  ...realChildProcess,
  spawn: (cmd: string, args: string[], opts: any) => {
    spawns.push({ cmd, args, env: opts?.env });
    return realChildProcess.spawn(cmd, args, opts);
  },
});
mock.module('./sessionManager.js', { defaultExport: {
  getSession: (id: string) => sessions.get(id) ?? null,
  createSession: (id: string) => sessions.set(id, { id }),
  saveSession() {}, addMessage() {},
} });
named('./modules/database/index.js', {
  sessionsDb: {
    getSessionById: (id: string) => rows.get(id) ?? null,
    recordDiscoveredSession: (row: any) => rows.set(row.sessionId, { session_id: row.sessionId, provider: 'antigravity', jsonl_path: row.jsonlPath }),
    adoptRuntimeSessionId() {},
  },
  participantsDb: { recordSpawn() {} },
  // Grants a test can flip: grantee -> the owner it currently runs on.
  credentialGrantsDb: {
    listUsableForGrantee: (granteeId: number) => (grants.has(granteeId) ? [{ ownerUserId: grants.get(granteeId) }] : []),
  },
  messageAuthorsDb: { recordUserMessage() {} },
  providerRunFailuresDb: { getFailure: () => null, clearFailure() {}, recordFailure() {}, setFailure() {} },
});
named('./modules/providers/services/provider-models.service.js', { providerModelsService: {
  getProviderModels: async () => ({ models: { OPTIONS: [] } }), getChangedActiveModel: async () => null,
} });
named('./services/isolation/resolve-provider-env.js', {
  resolveProviderEnv: (userId: number) => {
    if (envRefusal) throw envRefusal;
    const fake = Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith('FAKE_ACP_')));
    // As the real resolver: under a grant, HOME is the owner's tree.
    return { ...fake, HOME: memberHome(grants.get(userId) ?? userId), PATH: process.env.PATH ?? '' };
  },
});
named('./services/isolation/provider-cage-wiring.js', {
  resolveCagedLaunch: (spec: any) => { cageCalls.push(spec); return { cmd: spec.cmd, args: spec.args }; },
});
named('./services/provider-run-presence.js', {
  beginProviderRun: ({ launchReservation }: any) => {
    if (presenceThrows) throw new Error('presence registry failed');
    return { end() { launchReservation?.(); }, rekey() {}, setPid() {} };
  },
});
named('./services/notification-orchestrator.js', { notifyRunFailed() {}, notifyRunStopped() {} });
named('./services/isolation/provision-user-dirs.js', { userConfigDir: (userId: number) => memberHome(userId) });
named('./modules/providers/services/turn-timing.service.js', {
  createTurnTimer: () => ({ markModelActivity() {}, startedAt: () => new Date().toISOString() }),
  settleTurnTiming: (value: any) => ({ assistantMessageId: value.assistantMessageId }),
});
named('./modules/providers/services/provider-auth.service.js', { providerAuthService: { isProviderInstalled: async () => true } });
named('./modules/session-workspaces/index.js', { logicalProjectPathForWorkspace: (value: string) => value });
named('./services/isolation/sanitize-vendor-agent-env.js', { sanitizeVendorAgentEnv: (value: unknown) => value });
named('./shared/cwd-check.js', { checkCwdExists: async () => ({ ok: true }), buildCwdMissingPayload: () => ({}) });
named('./modules/providers/list/antigravity/antigravity-project-registry.js', {
  registerAntigravityProjectPath() {}, clearAntigravityProjectPath() {},
});

const { spawnAntigravity, abortAntigravitySession, isAntigravitySessionActive } = await import('./agy-cli.js');
const runner = await import('./modules/providers/list/antigravity/agy-acp-runner.js');
const { agyAcpPool } = runner;
const { hasLiveHarnessLaunch } = await import('./modules/providers/harness-update/spawn-admission.js');
const { acquireHarnessLease, releaseHarnessLease } = await import('./modules/providers/harness-update/lease.js');
const warm = await import('./services/isolation/warm-credential-processes.js');
after(() => agyAcpPool.shutdown());
afterEach(() => { process.env.NASSAJ_AGY_ACP = '1'; envRefusal = null; });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const acpSpawns = () => spawns.filter((s) => s.args[0] === 'acp' && !s.args.includes('--help'));
const turnSpawns = () => acpSpawns().filter((s) => s.args.includes('--add-dir'));

function writer(userId = 7) {
  const sent: any[] = [];
  return { userId, sent, runFenceRevoked: false, send: (m: any) => sent.push(m), setSessionId() {} };
}
const textOf = (sent: any[]) => sent.filter((m) => m.kind === 'stream_delta').map((m) => m.content).join('');
const completeOf = (sent: any[]) => sent.find((m) => m.kind === 'complete');
const brainOf = (sent: any[]) => sent.filter((m) => m.kind === 'session_created').at(-1)?.newSessionId;

async function newConversation(userId = 7, text = 'hello') {
  const w = writer(userId);
  await spawnAntigravity(text, { cwd: root }, w);
  return { w, brain: brainOf(w.sent) };
}
async function waitFor(pred: () => boolean, label: string, ms = 8000) {
  const end = Date.now() + ms;
  while (!pred() && Date.now() < end) await sleep(10);
  assert.ok(pred(), `timed out: ${label}`);
}
async function fixtureLog(userId = 7) {
  const raw = await fs.readFile(path.join(memberHome(userId), '.fake-acp.log'), 'utf8').catch(() => '');
  return raw.split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

test('guard parity: caged launch with the ACP argv, per-member HOME, launch reserved only during the turn', async () => {
  const before = cageCalls.length;
  const { w, brain } = await newConversation();
  assert.equal(completeOf(w.sent)?.exitCode, 0, JSON.stringify(w.sent));
  const turnCage = cageCalls.slice(before).find((c) => c.args.includes('--add-dir'));
  assert.deepEqual(turnCage.args, ['acp', '--dangerously-skip-permissions', '--disable-telemetry', '--add-dir', root]);
  assert.equal(turnCage.provider, 'agy');
  assert.equal(turnCage.userId, 7);
  assert.equal(turnSpawns().at(-1)?.env.HOME, memberHome(7));
  assert.equal(hasLiveHarnessLaunch(['antigravity']), false, 'an idle pooled process holds no reservation');
  assert.equal(isAntigravitySessionActive(brain), false, 'active only during a turn');
  assert.equal(agyAcpPool.size() >= 1, true);
});

test('ADR-152 A1: no member, no ACP launch, no probe, no pool key', async () => {
  const count = spawns.length;
  const w = writer();
  (w as any).userId = null;
  await assert.rejects(spawnAntigravity('x', { cwd: root }, w));
  assert.equal(spawns.length, count, 'nothing spawned for a missing member');
  await assert.rejects(runner.prepareAgyAcpLaunch({ userId: null, cwd: root, brainUUID: null }));
  assert.throws(() => runner.agyAcpPoolKey(null, 'b'));
  assert.throws(() => runner.agyAcpPoolKey(undefined, 'b'));
});

test('env-guard refusal: no spawn, an error frame, the run rejects', async () => {
  envRefusal = Object.assign(new Error('Provider "agy" is not covered'), { code: 'PROVIDER_ISOLATION_UNAVAILABLE' });
  const count = spawns.length;
  const w = writer();
  await assert.rejects(spawnAntigravity('x', { cwd: root }, w), /not covered/);
  assert.equal(spawns.length, count);
  assert.ok(w.sent.some((m) => m.kind === 'error'));
});

test('update in progress: drain kills the idle process, the turn is refused, nothing spawns', async () => {
  const { brain } = await newConversation();
  const pid = agyAcpPool.get(runner.agyAcpPoolKey(7, brain))?.handle.pid;
  assert.ok(pid);
  acquireHarnessLease('antigravity', 'job-guards');
  try {
    assert.equal(agyAcpPool.get(runner.agyAcpPoolKey(7, brain)), null, 'drained under the lease');
    const count = spawns.length;
    const w = writer();
    await spawnAntigravity('again', { sessionId: brain, cwd: root }, w);
    assert.equal(completeOf(w.sent)?.code, 'harness_updating');
    assert.equal(spawns.length, count);
  } finally {
    releaseHarnessLease('antigravity', 'job-guards');
  }
});

test('run fence revoked before the launch: no spawn and no prompt', async () => {
  const count = spawns.length;
  const w = writer();
  w.runFenceRevoked = true;
  const result = await spawnAntigravity('x', { cwd: root }, w);
  assert.equal(result?.code, 1);
  assert.equal(spawns.length, count);
});

test('run fence revoked mid-stream: forwarding stops and session/cancel is sent', async () => {
  const { brain } = await newConversation();
  const w = writer();
  const run = spawnAntigravity('#hang', { sessionId: brain, cwd: root }, w);
  await waitFor(() => w.sent.some((m) => m.kind === 'stream_delta'), 'first chunk');
  assert.equal(isAntigravitySessionActive(brain), true, 'active during the turn');
  w.runFenceRevoked = true;
  const forwarded = w.sent.filter((m) => m.kind === 'stream_delta').length;
  const result = await run;
  assert.equal(result.code, 1);
  assert.equal(w.sent.filter((m) => m.kind === 'stream_delta').length, forwarded, 'nothing forwarded after revoke');
  assert.ok((await fixtureLog()).some((e) => e.event === 'cancel' && e.sessionId === brain), 'session/cancel sent');
});

test('busy conversation: one project-standard session_busy error frame, no complete', async () => {
  const { brain } = await newConversation();
  const first = writer();
  const run = spawnAntigravity('#hang', { sessionId: brain, cwd: root }, first);
  await waitFor(() => isAntigravitySessionActive(brain), 'first turn active');
  const second = writer();
  const result = await spawnAntigravity('again', { sessionId: brain, cwd: root, clientMsgId: 'cm-1' }, second);
  assert.equal(result?.code, 1);
  assert.equal(second.sent.length, 1, JSON.stringify(second.sent));
  const [frame] = second.sent;
  assert.equal(frame.kind, 'error');
  assert.equal(frame.code, 'session_busy');
  assert.equal(frame.sessionId, brain);
  assert.equal(frame.provider, 'antigravity');
  assert.equal(frame.clientMsgId, 'cm-1');
  abortAntigravitySession(brain);
  await run;
});

test('a throw after admission releases the launch and drops the pooled process (keep:false)', async () => {
  const { brain } = await newConversation();
  const key = runner.agyAcpPoolKey(7, brain);
  assert.ok(agyAcpPool.get(key));
  presenceThrows = true;
  try {
    const w = writer();
    await assert.rejects(spawnAntigravity('again', { sessionId: brain, cwd: root }, w), /presence registry failed/);
    assert.equal(hasLiveHarnessLaunch(['antigravity']), false, 'launch reservation released');
    assert.equal(agyAcpPool.get(key), null, 'pool entry released with keep:false');
    assert.equal(isAntigravitySessionActive(brain), false, 'not left active');
    assert.ok(w.sent.some((m) => m.kind === 'error'), 'the client is told');
  } finally {
    presenceThrows = false;
  }
});

test('owner decision: permission requests are auto-allowed (allow_always)', async () => {
  const { w } = await newConversation(7, 'go #permission');
  assert.equal(textOf(w.sent), 'reply 1 perm=opt-always');
});

test('interaction_ questions are not auto-allowed: cancelled', async () => {
  const { w } = await newConversation(7, 'go #interaction');
  assert.equal(textOf(w.sent), 'reply 1 ask=cancelled');
});

test('abort: session/cancel then complete exit 1; the healthy process stays pooled', async () => {
  const { brain } = await newConversation();
  const w = writer();
  const run = spawnAntigravity('#hang', { sessionId: brain, cwd: root }, w);
  await waitFor(() => isAntigravitySessionActive(brain), 'turn active');
  await waitFor(() => w.sent.some((m) => m.kind === 'stream_delta'), 'first chunk');
  assert.equal(abortAntigravitySession(brain), true);
  const result = await run;
  assert.equal(result.code, 1);
  assert.equal(completeOf(w.sent)?.exitCode, 1);
  assert.ok(agyAcpPool.get(runner.agyAcpPoolKey(7, brain)), 'a cleanly cancelled process is kept');
});

test('cancel-timer race: an old abort timer never kills the next turn of the same process', async () => {
  const { brain } = await newConversation();
  const key = runner.agyAcpPoolKey(7, brain);
  const w1 = writer();
  const first = spawnAntigravity('#hang', { sessionId: brain, cwd: root }, w1);
  await waitFor(() => w1.sent.some((m) => m.kind === 'stream_delta'), 'first chunk');
  abortAntigravitySession(brain);
  await first; // cancelled cleanly; its 5 s kill timer is still pending
  const pid = agyAcpPool.get(key)?.handle.pid;
  const w2 = writer();
  const second = spawnAntigravity('#hang', { sessionId: brain, cwd: root }, w2);
  await waitFor(() => isAntigravitySessionActive(brain), 'second turn active');
  await sleep(5600);
  assert.equal(agyAcpPool.get(key)?.handle.pid, pid, 'the next turn survives the stale timer');
  assert.equal(isAntigravitySessionActive(brain), true);
  abortAntigravitySession(brain);
  assert.equal((await second).code, 1);
});

test('abort of an agent that ignores cancel: killed after the 5 s wait', async () => {
  const { brain } = await newConversation();
  const w = writer();
  const run = spawnAntigravity('#deaf', { sessionId: brain, cwd: root }, w);
  await waitFor(() => w.sent.some((m) => m.kind === 'stream_delta'), 'first chunk');
  abortAntigravitySession(brain);
  const result = await run;
  assert.equal(result.code, 1);
  assert.equal(agyAcpPool.get(runner.agyAcpPoolKey(7, brain)), null, 'killed');
});

test('crash mid-turn: error + complete(1); the next message respawns and resumes', async () => {
  const { brain } = await newConversation();
  const w = writer();
  await spawnAntigravity('#crash', { sessionId: brain, cwd: root }, w);
  assert.equal(completeOf(w.sent)?.exitCode, 1);
  assert.ok(w.sent.some((m) => m.kind === 'error'));
  const count = turnSpawns().length;
  const w2 = writer();
  await spawnAntigravity('after crash', { sessionId: brain, cwd: root }, w2);
  assert.equal(completeOf(w2.sent)?.exitCode, 0);
  assert.equal(textOf(w2.sent), 'reply 2');
  assert.equal(turnSpawns().length, count + 1);
});

test('QA: an over-long ndjson line fails the turn and kills the process; the server lives on', async () => {
  const { brain } = await newConversation();
  const w = writer();
  await spawnAntigravity('#overflow', { sessionId: brain, cwd: root }, w);
  assert.equal(completeOf(w.sent)?.exitCode, 1);
  assert.match(w.sent.find((m) => m.kind === 'error')?.content ?? '', /line limit/);
  assert.equal(agyAcpPool.get(runner.agyAcpPoolKey(7, brain)), null);
});

test('stderr Error: lines and JSON-RPC errors become the error frame (B-394)', async () => {
  const { brain } = await newConversation();
  const w = writer();
  await spawnAntigravity('#fail', { sessionId: brain, cwd: root }, w);
  assert.equal(completeOf(w.sent)?.exitCode, 1);
  const error = w.sent.find((m) => m.kind === 'error');
  assert.match(error.content, /quota|fixture failure/);
});

test('isolation: two members on the same session id get different processes with different HOME', async () => {
  const { brain } = await newConversation(7);
  cpSync(path.join(memberHome(7), '.gemini'), path.join(memberHome(8), '.gemini'), { recursive: true });
  const w = writer(8);
  await spawnAntigravity('member 8', { sessionId: brain, cwd: root }, w);
  assert.equal(completeOf(w.sent)?.exitCode, 0, JSON.stringify(w.sent));
  const a = agyAcpPool.get(runner.agyAcpPoolKey(7, brain));
  const b = agyAcpPool.get(runner.agyAcpPoolKey(8, brain));
  assert.ok(a && b);
  assert.notEqual(a.handle.pid, b.handle.pid);
  assert.equal((await fixtureLog(8)).find((e) => e.event === 'spawn' && e.pid === b.handle.pid)?.home, memberHome(8));
});

test('QA 3: a binary change (new mtime) changes the fingerprint: kill + respawn + resume', async () => {
  const { brain } = await newConversation();
  const first = agyAcpPool.get(runner.agyAcpPoolKey(7, brain))?.handle.pid;
  const later = new Date(Date.now() + 60_000);
  utimesSync(agyBin, later, later);
  const w = writer();
  await spawnAntigravity('again', { sessionId: brain, cwd: root }, w);
  assert.equal(textOf(w.sent), 'reply 2');
  const second = agyAcpPool.get(runner.agyAcpPoolKey(7, brain))?.handle.pid;
  assert.notEqual(second, first);
});

/** Empties the pool and waits until every warm registration is gone. */
async function emptyPool() {
  agyAcpPool.shutdown();
  await waitFor(() => warm.countWarmCredentialProcessesForTests() === 0, 'warm registry empty');
}

test('ADR-152 A1 §3.5: a pooled process is a warm credential process; revoking the grant kills it', async () => {
  await emptyPool();
  grants.set(9, 7);
  try {
    const before = 0;
    const { brain } = await newConversation(9);
    const entry = agyAcpPool.get(runner.agyAcpPoolKey(9, brain));
    assert.ok(entry);
    assert.equal(warm.countWarmCredentialProcessesForTests(), before + 1, 'registered');
    assert.equal(warm.terminateStaleWarmProcesses({ userId: 9, unit: 'agy' }), 0, 'same principal: kept');
    grants.delete(9); // revoked, declined, or the owner disabled: no usable grant
    assert.equal(warm.terminateStaleWarmProcesses({ userId: 9 }), 1);
    assert.equal(agyAcpPool.get(runner.agyAcpPoolKey(9, brain)), null);
    await waitFor(() => entry.dead === true, 'process exited');
    assert.equal(warm.countWarmCredentialProcessesForTests(), before, 'unregistered');
  } finally {
    grants.delete(9);
  }
});

test('qa r2 #1: the admission gate unit (agy) reaches the pooled process when the owner changes', async () => {
  await emptyPool();
  grants.set(14, 7);
  try {
    const { brain } = await newConversation(14);
    const entry = agyAcpPool.get(runner.agyAcpPoolKey(14, brain));
    assert.ok(entry);
    grants.set(14, 8); // the credential owner changed (old owner disabled, another grant chosen)
    // Exactly what credential-gate.js runs at the next admission of an agy turn.
    assert.equal(warm.terminateStaleWarmProcesses({ userId: 14, unit: 'agy' }), 1);
    assert.equal(agyAcpPool.get(runner.agyAcpPoolKey(14, brain)), null, 'idle process killed now');
    await waitFor(() => entry.dead === true, 'process exited');
  } finally {
    grants.delete(14);
  }
});

test('qa r2 #3: a revoke during a live turn names the reason in the error frame', async () => {
  await emptyPool();
  grants.set(15, 7);
  try {
    const { brain } = await newConversation(15);
    const w = writer(15);
    const run = spawnAntigravity('#hang', { sessionId: brain, cwd: root }, w);
    await waitFor(() => w.sent.some((m) => m.kind === 'stream_delta'), 'first chunk');
    grants.delete(15);
    assert.equal(warm.terminateStaleWarmProcesses({ userId: 15, unit: 'agy' }), 1);
    const result = await run;
    assert.equal(result.code, 1);
    const error = w.sent.find((m) => m.kind === 'error');
    assert.match(error?.content ?? '', /credential-principal-changed/);
    assert.doesNotMatch(error?.content ?? '', /exited unexpectedly/);
  } finally {
    grants.delete(15);
  }
});

test('a pooled process that exits on its own is unregistered from the warm registry', async () => {
  await emptyPool();
  const before = 0;
  const { brain } = await newConversation(8);
  assert.equal(warm.countWarmCredentialProcessesForTests(), before + 1);
  agyAcpPool.killKey(runner.agyAcpPoolKey(8, brain), 'test');
  await waitFor(() => warm.countWarmCredentialProcessesForTests() === before, 'unregistered on exit');
});

test('QA 5: a -p run (flag turned off) kills the pooled process of that conversation first', async () => {
  const { brain } = await newConversation();
  assert.ok(agyAcpPool.get(runner.agyAcpPoolKey(7, brain)));
  process.env.NASSAJ_AGY_ACP = '0';
  const w = writer();
  await spawnAntigravity('print mode', { sessionId: brain, cwd: root }, w);
  assert.equal(agyAcpPool.get(runner.agyAcpPoolKey(7, brain)), null);
  assert.equal(spawns.at(-1)?.args[0], '-p');
});

test('QA 4: member cap reached with nothing idle → this turn falls back to -p', async (t) => {
  agyAcpPool.shutdown();
  // The global cap follows free memory; pin it so this checks the 3-per-member cap alone.
  runner._setAgyAcpCapacityForTests(() => 12);
  t.after(() => runner._setAgyAcpCapacityForTests(null));
  const hanging: Array<{ brain: string; run: Promise<any> }> = [];
  for (let i = 0; i < 3; i += 1) {
    const { brain } = await newConversation(11);
    const w = writer(11);
    hanging.push({ brain, run: spawnAntigravity('#hang', { sessionId: brain, cwd: root }, w) });
    await waitFor(() => isAntigravitySessionActive(brain), 'hang active');
  }
  const count = spawns.length;
  const w = writer(11);
  await spawnAntigravity('one more', { cwd: root }, w);
  assert.equal(spawns.slice(count).find((s) => s.args[0] === '-p') !== undefined, true, 'fell back to -p');
  for (const h of hanging) abortAntigravitySession(h.brain);
  await Promise.all(hanging.map((h) => h.run));
});

test('capability probe: a binary answering protocol 2 sends the turn to -p, quickly', async () => {
  const later = new Date(Date.now() + 120_000);
  utimesSync(agyBin, later, later);
  process.env.FAKE_ACP_PROTOCOL = '2';
  try {
    agyAcpPool.shutdown();
    const started = Date.now();
    const count = spawns.length;
    const w = writer();
    await spawnAntigravity('probe me', { cwd: root }, w);
    assert.ok(spawns.slice(count).some((s) => s.args[0] === '-p'), 'fell back to -p');
    assert.equal(agyAcpPool.size(), 0, 'no pooled process for an incapable binary');
    assert.ok(Date.now() - started < 10_000, 'the probe does not wait out a timeout');
  } finally {
    delete process.env.FAKE_ACP_PROTOCOL;
    const fresh = new Date(Date.now() + 180_000);
    utimesSync(agyBin, fresh, fresh);
  }
});

test('auth required: authenticate once with the HOME credential method; none present → error, no authenticate', async () => {
  process.env.FAKE_ACP_REQUIRE_AUTH = '1';
  try {
    const tokenDir = path.join(memberHome(12), '.gemini', 'antigravity-cli');
    await fs.mkdir(tokenDir, { recursive: true });
    await fs.writeFile(path.join(tokenDir, 'antigravity-oauth-token'), '{}');
    const ok = await newConversation(12);
    assert.equal(completeOf(ok.w.sent)?.exitCode, 0, JSON.stringify(ok.w.sent));
    assert.deepEqual((await fixtureLog(12)).filter((e) => e.event === 'authenticate').map((e) => e.methodId), ['oauth-personal']);
    const none = await newConversation(13);
    assert.equal(completeOf(none.w.sent)?.exitCode, 1);
    assert.equal(none.w.sent.find((m) => m.kind === 'error')?.code, 'authentication_required');
    assert.equal((await fixtureLog(13)).filter((e) => e.event === 'authenticate').length, 0);
  } finally {
    delete process.env.FAKE_ACP_REQUIRE_AUTH;
  }
});

test('shutdown kills every pooled process', async () => {
  await newConversation();
  assert.ok(agyAcpPool.size() > 0);
  runner.shutdownAgyAcp();
  assert.equal(agyAcpPool.size(), 0);
});
