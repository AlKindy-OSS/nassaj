import assert from 'node:assert/strict';
import { after, beforeEach, mock, test } from 'node:test';
import { mkdtemp, mkdir, writeFile, rm, readFile, appendFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const root = await mkdtemp(path.join(os.tmpdir(), 'native-fork-'));
const projectPath = path.join(root, 'project');
const codexHome = path.join(root, 'codex');
await mkdir(projectPath); await mkdir(path.join(codexHome, 'sessions'), { recursive: true });
after(() => rm(root, { recursive: true, force: true }));
const principal = { id: 7, role: 'user', authenticationKind: 'session', authorizationGeneration: 1 };
const rows = new Map<string, any>();
let authorized = true;
let registrationFails = false;
let rpcCalls = 0;
let runtimeChecks = 0;
let spawnCalls = 0;
let scenario = 'success';
let releaseRpc: (() => void) | undefined;
let requestNumber = 0;
const transcript = (id: string, later = false) => [
  { type: 'session_meta', payload: { id, cwd: projectPath } },
  { type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn-1' } },
  { type: 'response_item', payload: { type: 'message', role: 'assistant', phase: 'final_answer', id: 'msg_final',
    content: [{ type: 'output_text', text: 'Completed' }], internal_chat_message_metadata_passthrough: { turn_id: 'turn-1' } } },
  { type: 'event_msg', payload: { type: 'task_complete', turn_id: 'turn-1' } },
  ...(later ? [{ type: 'event_msg', payload: { type: 'task_started', turn_id: 'later-turn' } }] : []),
].map(row => JSON.stringify(row)).join('\n') + '\n';
const file = (id: string) => path.join(codexHome, 'sessions', `${id}.jsonl`);
const row = (id: string) => ({ session_id: id, provider: 'codex', project_path: projectPath, jsonl_path: file(id) });
mock.module('@/modules/database/index.js', { namedExports: {
  sessionsDb: { getSessionById: (id: string) => rows.get(id), updateSessionCustomName() {} },
  participantsDb: { isParticipant: (_id: string, user: number) => authorized && user === 7,
    recordSpawn() { spawnCalls++; } },
} });
mock.module('../sessions.service.js', { namedExports: {
  assertSessionAccessible: (id: string, user: number) => {
    if (!authorized || user !== 7 || !rows.has(id)) throw new Error('denied');
    return rows.get(id);
  },
} });
mock.module('@/modules/providers/services/session-synchronizer.service.js', { namedExports: {
  sessionSynchronizerService: { synchronizeProviderFile: async (_provider: string, filename: string) => {
    if (registrationFails) throw new Error('index failed');
    if (scenario === 'append-target') await appendFile(filename, JSON.stringify({ type: 'event_msg', payload: { type: 'task_started', turn_id: 'injected' } }) + '\n');
    const header = JSON.parse((await readFile(filename, 'utf8')).split('\n')[0]);
    rows.set(header.payload.id, row(header.payload.id));
  } },
} });
mock.module('@/modules/providers/services/sessions-watcher.service.js', { namedExports: { notifySessionMetadataChanged() {} } });
mock.module('../../../../services/isolation/resolve-provider-env.js', { namedExports: {
  resolveProviderEnv: () => ({ CODEX_HOME: codexHome }),
} });
mock.module('../../../../services/codex-app-server.js', { namedExports: {
  assertCodexMessageForkRuntimeReady: () => { runtimeChecks++; return { executablePath: '/native/pinned' }; },
  callCodexAppServer: async (source: string, user: number, method: string, params: any, options: any) => {
    assert.equal(user, 7); assert.equal(method, 'thread/fork');
    assert.deepEqual(params, { lastTurnId: 'turn-1', ephemeral: false, excludeTurns: true, threadSource: 'user' });
    assert.equal(options.experimentalApi, true); assert.equal(options.authenticatedPrincipal, principal);
    await options.beforeRequest(); options.onRequestSent(); rpcCalls++;
    if (scenario === 'pending') await new Promise<void>(resolve => { releaseRpc = resolve; });
    if (scenario === 'lost') throw new Error('response lost after mutation');
    const id = `fork-${source}`;
    await writeFile(file(id), transcript(id, scenario === 'later-target'));
    if (scenario === 'revoked') authorized = false;
    return { thread: { id, path: file(id), cwd: projectPath, forkedFromId: source, ephemeral: false } };
  },
} });
const { forkSessionAtMessage } = await import('../session-fork.service.js');
let source: string;
let params: any;
beforeEach(async () => {
  source = `source-${++requestNumber}`;
  rows.clear(); rows.set(source, row(source));
  await writeFile(file(source), transcript(source, true));
  authorized = true; registrationFails = false; rpcCalls = 0; runtimeChecks = 0; spawnCalls = 0;
  scenario = 'success'; releaseRpc = undefined;
  params = { sessionId: source, upToMessageId: 'msg_final', userId: 7, requestId: `operation-${requestNumber}`, authenticatedPrincipal: principal };
});

test('indexes one exact native final fork and leaves source bytes unchanged', async () => {
  const before = await readFile(file(source));
  const result = await forkSessionAtMessage(params);
  assert.equal(result.sessionId, `fork-${source}`);
  assert.equal(rpcCalls, 1); assert.equal(spawnCalls, 1);
  assert.deepEqual(await readFile(file(source)), before);
});

test('authorization and canonical principal binding precede runtime/file inspection', async () => {
  authorized = false;
  await assert.rejects(forkSessionAtMessage(params), { code: 'session_not_found' });
  authorized = true;
  await assert.rejects(forkSessionAtMessage({ ...params, authenticatedPrincipal: { ...principal, id: 8 } }), { code: 'session_not_found' });
  assert.equal(runtimeChecks, 0); assert.equal(rpcCalls, 0);
});

test('concurrent exact clicks coalesce only after each caller is authorized', async () => {
  scenario = 'pending';
  const first = forkSessionAtMessage(params);
  while (!releaseRpc) await new Promise(resolve => setImmediate(resolve));
  const second = forkSessionAtMessage({ ...params, requestId: 'other-click' });
  await assert.rejects(forkSessionAtMessage({ ...params, userId: 8, authenticatedPrincipal: { ...principal, id: 8 } }));
  releaseRpc!();
  assert.deepEqual(await first, await second);
  assert.equal(rpcCalls, 1);
});

test('lost mutation result remains unknown and same request never forks again', async () => {
  scenario = 'lost';
  await assert.rejects(forkSessionAtMessage(params), { code: 'outcome_unknown' });
  await assert.rejects(forkSessionAtMessage(params), { code: 'outcome_unknown' });
  assert.equal(rpcCalls, 1);
});

test('post-mutation target cutoff validation failure is unknown, never safely retryable', async () => {
  scenario = 'later-target';
  await assert.rejects(forkSessionAtMessage(params), { code: 'outcome_unknown' });
  await assert.rejects(forkSessionAtMessage(params), { code: 'outcome_unknown' });
  assert.equal(rpcCalls, 1); assert.equal(spawnCalls, 0);
});

test('known target failure retries registration only and source authorization is rechecked', async () => {
  registrationFails = true;
  await assert.rejects(forkSessionAtMessage(params), { code: 'registration_failed', forkedSessionId: `fork-${source}` });
  authorized = false;
  await assert.rejects(forkSessionAtMessage(params), { code: 'session_not_found' });
  authorized = true; registrationFails = false;
  const result = await forkSessionAtMessage(params);
  assert.equal(result.sessionId, `fork-${source}`); assert.equal(rpcCalls, 1);
});

test('revocation after native creation never returns or registers the target', async () => {
  scenario = 'revoked';
  await assert.rejects(forkSessionAtMessage(params), { code: 'session_not_found' });
  assert.equal(spawnCalls, 0); assert.equal(rpcCalls, 1);
});

test('operation identity cannot be reused to move the cutoff', async () => {
  await forkSessionAtMessage(params);
  await assert.rejects(forkSessionAtMessage({ ...params, upToMessageId: 'different' }), { code: 'unsupported_cutoff' });
  assert.equal(rpcCalls, 1);
});


test('appending a target turn during registration never grants participant access or success', async () => {
  scenario = 'append-target';
  await assert.rejects(forkSessionAtMessage(params), { code: 'registration_failed' });
  assert.equal(spawnCalls, 0);
  await assert.rejects(forkSessionAtMessage(params), { code: 'registration_failed' });
  assert.equal(rpcCalls, 1);
});


test('registration-only retry never creates a fork without retained evidence, including a fresh module', async () => {
    const retry = { ...params, retryRegistrationOnly: true, expectedForkedSessionId: `fork-${source}` };
    await assert.rejects(forkSessionAtMessage(retry), { code: 'registration_evidence_expired' });
    const reloaded = await import(`../session-fork.service.js?reload=${Date.now()}`);
    await assert.rejects(reloaded.forkSessionAtMessage(retry), { code: 'registration_evidence_expired' });
    assert.equal(rpcCalls, 0);
});
test('registration-only retry matches retained target and denies TTL expiry without another RPC', async () => {
    registrationFails = true;
    await assert.rejects(forkSessionAtMessage(params), { code: 'registration_failed' });
    const retry = { ...params, retryRegistrationOnly: true, expectedForkedSessionId: `fork-${source}` };
    await assert.rejects(forkSessionAtMessage({ ...retry, expectedForkedSessionId: 'wrong-target' }), { code: 'registration_evidence_expired' });
    registrationFails = false;
    assert.equal((await forkSessionAtMessage(retry)).sessionId, `fork-${source}`);
    const now = Date.now;
    mock.method(Date, 'now', () => now() + 11 * 60000);
    try {
        await assert.rejects(forkSessionAtMessage(retry), { code: 'registration_evidence_expired' });
    }
    finally {
        Date.now = now;
    }
    assert.equal(rpcCalls, 1);
});
test('registration-only A cannot replace or delete the pending creation flight B', async () => {
    registrationFails = true;
    await assert.rejects(forkSessionAtMessage(params), { code: 'registration_failed' });
    registrationFails = false;
    scenario = 'pending';
    const second = forkSessionAtMessage({ ...params, requestId: 'flight-b' });
    while (!releaseRpc)
        await new Promise(resolve => setImmediate(resolve));
    await forkSessionAtMessage({ ...params, retryRegistrationOnly: true, expectedForkedSessionId: `fork-${source}` });
    const third = forkSessionAtMessage({ ...params, requestId: 'flight-c' });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(rpcCalls, 2);
    releaseRpc!();
    assert.deepEqual(await second, await third);
    assert.equal(rpcCalls, 2);
});
test('registration-only Claude request cannot enter native creation', async () => {
    rows.set(source, { ...row(source), provider: 'claude' });
    await assert.rejects(forkSessionAtMessage({ ...params, retryRegistrationOnly: true, expectedForkedSessionId: 'known-target' }), { code: 'registration_evidence_expired' });
    assert.equal(rpcCalls, 0);
    assert.equal(spawnCalls, 0);
});
