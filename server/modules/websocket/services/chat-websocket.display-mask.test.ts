/**
 * ADR-210 (T-2036): the realtime side channels mask like the live writer.
 * Drives the real `handleChatConnection` dispatcher: attach-replay to a
 * reconnecting socket, and the pending-permissions listing (run owner keeps
 * raw input, every other viewer gets it masked).
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test, { after } from 'node:test';

import { initializeDatabase, sessionsDb } from '@/modules/database/index.js';
// eslint-disable-next-line boundaries/no-unknown -- ADR-210 test seam of the display masking leaf service.
import { configureDisplayMaskForTests } from '@/services/display-secret-mask.js';

// eslint-disable-next-line boundaries/no-unknown -- the real replay ring (ADR-041), exercised end to end.
import { SessionRegistry } from '../../../session-registry.js';

import { handleChatConnection, withClientMsgIdEcho } from './chat-websocket.service.js';
import { WebSocketWriter } from './websocket-writer.service.js';

await initializeDatabase();
const PROJECT_PATH = fs.mkdtempSync('/var/tmp/chat-display-mask-project-');
after(() => {
  fs.rmSync(PROJECT_PATH, { recursive: true, force: true });
  configureDisplayMaskForTests(null);
});
configureDisplayMaskForTests({ env: () => undefined, readSetting: () => null, serviceLiterals: () => [], allUserIds: () => [] });

const SK = 'sk-' + 'ant-api03-ZyXwVuTsRqPoNmLkJiHgFeDc';

function makeFakeWs() {
  const sent: any[] = [];
  const listeners: Record<string, ((arg: unknown) => void)[]> = {};
  return {
    readyState: 1,
    sent,
    raw: [] as string[],
    send(data: string) { this.raw.push(data); sent.push(JSON.parse(data)); },
    on(event: string, cb: (arg: unknown) => void) { (listeners[event] ||= []).push(cb); },
    emit(event: string, arg: unknown) { (listeners[event] || []).forEach((cb) => cb(arg)); },
  };
}

function makeDeps(overrides: Record<string, unknown>) {
  return {
    queryClaudeSDK: async () => {}, spawnCursor: async () => {}, queryCodex: async () => {},
    spawnAntigravity: async () => {}, spawnOpenCode: async () => {}, getSessionProvider: () => null,
    abortClaudeSDKSession: () => false, abortCursorSession: () => false, abortCodexSession: () => false,
    abortAntigravitySession: () => false, abortOpenCodeSession: () => false, resolveToolApproval: () => {},
    isClaudeSDKSessionActive: () => true, isCursorSessionActive: () => false, isCodexSessionActive: () => false,
    isAntigravitySessionActive: () => false, isOpenCodeSessionActive: () => false,
    reconnectSessionWriter: () => false, isPrimarySocketAlive: () => true,
    attachAntigravitySession: () => 0, attachClaudeSDKSession: () => 0,
    getPendingApprovalsForSession: () => [],
    getActiveClaudeSDKSessions: () => [], getActiveCursorSessions: () => [], getActiveCodexSessions: () => [],
    getActiveAntigravitySessions: () => [], getActiveOpenCodeSessions: () => [],
    ...overrides,
  } as unknown as Parameters<typeof handleChatConnection>[2];
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

/** A live run as agy-cli's safeSend drives it: record (seq stamped on the original), then send. */
function liveRun(registry: InstanceType<typeof SessionRegistry>, sessionId: string, userId: number) {
  const runSocket = makeFakeWs();
  const writer = new WebSocketWriter(runSocket as never, userId);
  registry.open(sessionId);
  let counter = 0;
  return (kind: string, content?: string) => {
    const payload: Record<string, unknown> = { id: `${sessionId}-${counter += 1}`, kind, sessionId, provider: 'antigravity', content };
    const seq = registry.record(sessionId, payload);
    if (seq !== null && seq !== undefined) payload.sequence = seq;
    writer.send(payload);
  };
}

/** A viewer joining mid-stream through check-session-status; returns the socket. */
async function joinMidStream(
  registry: InstanceType<typeof SessionRegistry>, sessionId: string, provider: 'antigravity' | 'claude', lastSeq = 0,
) {
  const viewer = makeFakeWs();
  const attach = (_sid: string, lastSeq: number, send: (p: unknown) => void) => registry.attach(sessionId, lastSeq, send);
  handleChatConnection(viewer as never, { user: { id: 2 } } as never, makeDeps(
    provider === 'claude' ? { attachClaudeSDKSession: attach } : { attachAntigravitySession: attach, isAntigravitySessionActive: () => true },
  ));
  viewer.emit('message', JSON.stringify({ type: 'check-session-status', provider, sessionId, lastSeq }));
  await settle();
  return viewer;
}

const viewerText = (viewer: ReturnType<typeof makeFakeWs>) =>
  viewer.sent.filter((m) => m.kind === 'stream_delta').map((m) => m.content).join('');

test('a reconnecting socket never receives a raw secret from replay', async () => {
  const sessionId = 'display-mask-replay';
  sessionsDb.createSession(sessionId, 'claude', PROJECT_PATH);
  // The live run: payloads go through a real writer (the chokepoint) and into the ring.
  const ring: Array<{ seq: number; payload: Record<string, unknown> }> = [];
  const runSocket = makeFakeWs();
  const runWriter = new WebSocketWriter(runSocket as never, 1);
  const live = ['Use key sk-', 'ant-api03-ZyXwVu', 'TsRqPoNmLkJiHgFeDc', ' now.\n'];
  live.forEach((content, index) => {
    const payload = { kind: 'stream_delta', sessionId, provider: 'claude', content, sequence: index + 1 };
    ring.push({ seq: index + 1, payload });
    runWriter.send(payload);
  });
  const toolUse = { kind: 'tool_use', sessionId, provider: 'claude', toolName: 'Bash', toolInput: { command: `echo ${SK}` }, sequence: 5 };
  ring.push({ seq: 5, payload: toolUse });
  runWriter.send(toolUse);
  const unrecorded = { kind: 'text', role: 'assistant', provider: 'claude', content: `final ${SK}`, sequence: 6 };
  ring.push({ seq: 6, payload: unrecorded });

  const viewer = makeFakeWs();
  handleChatConnection(viewer as never, { user: { id: 2 } } as never, makeDeps({
    attachClaudeSDKSession: (_sid: string, lastSeq: number, send: (p: unknown) => void) => {
      for (const item of ring) if (item.seq > lastSeq) send(item.payload);
      return ring.length;
    },
  }));
  viewer.emit('message', JSON.stringify({ type: 'check-session-status', provider: 'claude', sessionId, lastSeq: 0 }));
  await settle();
  const replayed = viewer.raw.join('\n');
  for (const fragment of ['ZyXwVu', 'TsRqPoNm', 'ant-api03']) assert.ok(!replayed.includes(fragment), fragment);
  const text = viewer.sent.filter((m) => m.kind === 'stream_delta').map((m) => m.content).join('');
  assert.equal(text, 'Use key [masked:anthropic-openai-key] now.\n', 'replay equals what live viewers saw');
  assert.equal(viewer.sent.find((m) => m.kind === 'text')?.content, 'final [masked:anthropic-openai-key]');
});

test('C1: replay through the clientMsgId echo wrapper never leaks the key qa reproduced', async () => {
  const sessionId = 'display-mask-c1';
  sessionsDb.createSession(sessionId, 'claude', PROJECT_PATH);
  const ring: Array<Record<string, unknown>> = [];
  const runSocket = makeFakeWs();
  // The live path wraps the writer: every model-activity frame is sent as a COPY with the echo.
  const echoed = withClientMsgIdEcho(new WebSocketWriter(runSocket as never, 1), { type: 'claude-command', options: { clientMsgId: 'cm-1' } } as never);
  ['Your key is sk-ant-api03-Ab1C', 'd2Ef3Gh4Ij5Kl6Mn7Op8Qr9St0Uv now'].forEach((content, index) => {
    const payload = { id: `c1-${index}`, kind: 'stream_delta', sessionId, provider: 'claude', content, sequence: index + 1 };
    ring.push(payload); // bufferThenSend: the ring keeps the original, sequence stamped first
    echoed.send(payload);
  });
  const end = { id: 'c1-end', kind: 'stream_end', sessionId, provider: 'claude', sequence: 3 };
  ring.push(end);
  echoed.send(end);
  const viewer = makeFakeWs();
  handleChatConnection(viewer as never, { user: { id: 2 } } as never, makeDeps({
    attachClaudeSDKSession: (_sid: string, lastSeq: number, send: (p: unknown) => void) => {
      for (const payload of ring) if ((payload.sequence as number) > lastSeq) send(payload);
      return ring.length;
    },
  }));
  viewer.emit('message', JSON.stringify({ type: 'check-session-status', provider: 'claude', sessionId, lastSeq: 0 }));
  await settle();
  const replayed = viewer.raw.join('\n');
  for (const fragment of ['api03', 'Ab1C', 'd2Ef3Gh4', 'St0Uv']) assert.ok(!replayed.includes(fragment), fragment);
  const live = runSocket.sent.filter((m) => m.kind === 'stream_delta').map((m) => m.content).join('');
  const text = viewer.sent.filter((m) => m.kind === 'stream_delta').map((m) => m.content).join('');
  assert.equal(text, 'Your key is [masked:anthropic-openai-key] now');
  assert.equal(text, live, 'the replay is what live viewers saw');
});

test('pending-permissions-response: the run owner keeps raw input, every other viewer gets it masked', async () => {
  const sessionId = 'display-mask-pending';
  sessionsDb.createSession(sessionId, 'claude', PROJECT_PATH);
  const pending = [
    { requestId: 'r-own', toolName: 'AskUserQuestion', ownerUserId: 1, input: { question: `key ${SK}?` }, sessionId },
    { requestId: 'r-other', toolName: 'Bash', ownerUserId: 3, input: { command: `echo ${SK}` }, sessionId },
  ];
  const deps = makeDeps({ getPendingApprovalsForSession: () => pending });
  const owner = makeFakeWs();
  const mirror = makeFakeWs();
  handleChatConnection(mirror as never, { user: { id: 2 } } as never, deps);
  mirror.emit('message', JSON.stringify({ type: 'check-session-status', provider: 'claude', sessionId, lastSeq: 0 }));
  await settle();
  handleChatConnection(owner as never, { user: { id: 1 } } as never, deps);
  owner.emit('message', JSON.stringify({ type: 'get-pending-permissions', sessionId }));
  await settle();

  const ownView = owner.sent.find((m) => m.type === 'pending-permissions-response');
  assert.ok(ownView, 'the requester gets the listing');
  assert.equal(ownView.data[0].input.question, `key ${SK}?`, 'own run: raw (edited input executes verbatim)');
  assert.ok(!JSON.stringify(ownView.data[1]).includes(SK), 'another run: masked even for this requester');
  assert.ok(ownView.data.every((entry: Record<string, unknown>) => !('ownerUserId' in entry)), 'owner id never sent');
  const mirrorView = mirror.sent.find((m) => m.type === 'pending-permissions-response');
  assert.ok(mirrorView, 'mirrors still receive the listing');
  assert.ok(!mirror.raw.join('').includes(SK), 'a mirror never sees a raw secret');
});

test('H2: a mid-stream agy joiner never sees a raw key prefix (seq stamped, live tail not flushed twice)', async () => {
  process.env.SESSION_REGISTRY_agy = '1';
  const registry = new SessionRegistry('SESSION_REGISTRY_agy');
  const sessionId = 'display-mask-h2-agy';
  sessionsDb.createSession(sessionId, 'antigravity', PROJECT_PATH);
  const send = liveRun(registry, sessionId, 1);
  send('stream_delta', 'the token is ghp_Ab1Ab1');
  send('stream_delta', 'Ab1A');
  const viewer = await joinMidStream(registry, sessionId, 'antigravity');
  send('stream_delta', 'b1Ab1Ab1Ab1Ab1Ab1Ab1Ab1Ab1 ok\n');
  send('stream_end');
  assert.equal(viewerText(viewer), 'the token is [masked:github-token] ok\n');
  assert.ok(!viewer.raw.join('').includes('ghp_Ab1'), 'no raw prefix');
});

test('H2: a Claude joiner whose recorded views were evicted still never sees a raw prefix or a duplicate', async () => {
  process.env.SESSION_REGISTRY_claude = '1';
  const registry = new SessionRegistry('SESSION_REGISTRY_claude');
  const sessionId = 'display-mask-h2-claude';
  sessionsDb.createSession(sessionId, 'claude', PROJECT_PATH);
  const send = liveRun(registry, sessionId, 1);
  send('stream_delta', 'the token is ghp_Ab1Ab1');
  send('stream_delta', 'Ab1A');
  // 300 other sessions write views after it: this session's recorded views are evicted.
  const filler = new WebSocketWriter(makeFakeWs() as never, 1);
  for (let index = 0; index < 300; index += 1) {
    filler.send({ id: `f${index}`, kind: 'text', sessionId: `filler-${index}`, content: 'x', sequence: 1 });
  }
  const viewer = await joinMidStream(registry, sessionId, 'claude');
  send('stream_delta', 'b1Ab1Ab1Ab1Ab1Ab1Ab1Ab1Ab1 ok\n');
  send('stream_end');
  assert.ok(!viewer.raw.join('').includes('ghp_Ab1'), 'no raw prefix');
  assert.equal(viewerText(viewer), 'the token is [masked:github-token] ok\n', 'no duplicated tail');
});

for (const provider of ['antigravity', 'claude'] as const) {
  test(`stale floor (${provider}): a client back mid next turn with lastSeq=500 gets the current turn, masked`, async () => {
    const flag = provider === 'claude' ? 'SESSION_REGISTRY_claude' : 'SESSION_REGISTRY_agy';
    process.env[flag] = '1';
    const registry = new SessionRegistry(flag);
    const sessionId = `display-mask-stale-${provider}`;
    sessionsDb.createSession(sessionId, provider, PROJECT_PATH);
    const firstTurn = liveRun(registry, sessionId, 1);
    for (let index = 0; index < 500; index += 1) firstTurn('stream_delta', `w${index} `);
    firstTurn('stream_end');
    registry.drop(sessionId); // terminal drop: the next turn re-creates the entry, counter back at 1
    const secondTurn = liveRun(registry, sessionId, 1);
    secondTurn('stream_delta', `next turn key ${'sk-'}ant-api03-AbCd`);
    secondTurn('stream_delta', 'EfGhIjKlMnOpQrStUvWx and ');
    const viewer = await joinMidStream(registry, sessionId, provider, 501);
    secondTurn('stream_delta', 'more\n');
    secondTurn('stream_end');
    assert.equal(viewerText(viewer), 'next turn key [masked:anthropic-openai-key] and more\n');
    assert.ok(!viewer.raw.join('').includes('api03'), 'replayed through the masking sink');
  });
}
