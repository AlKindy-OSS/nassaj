import assert from 'node:assert/strict';
import test from 'node:test';

import { WebSocketWriter } from './websocket-writer.service.js';
import {
  abortProjectRunsForRevokedWriter,
  abortRunsForRevokedWriter,
  isIdentityRevocationClose,
} from './chat-websocket.service.js';
import { closeWebSocketForIdentityRevocation } from './websocket-server.service.js';

const PROVIDERS = [
  'claude', 'cursor', 'codex', 'antigravity', 'opencode', 'hermes',
  'kimi', 'deepseek', 'glm', 'qwen',
] as const;

function harness(current = true) {
  const calls: string[] = [];
  const rawWs = { readyState: 1 };
  const writer = {
    ws: rawWs,
    userId: 17,
    revoked: false,
    revokeRunOutput(expected: unknown) {
      if (expected !== this.ws) return false;
      this.revoked = true;
      return true;
    },
  } as unknown as WebSocketWriter;
  const runs = PROVIDERS.map((provider) => ({ sessionId: `run-${provider}`, provider, token: {} }));
  const dependencies = {
    getProviderRunsOwnedByWriter: () => runs,
    isProviderRunOwnershipCurrent: () => current,
    abortClaudeSDKSession: async (id: string) => { calls.push(`claude:${id}`); return true; },
    abortCursorSession: (id: string) => (calls.push(`cursor:${id}`), true),
    abortCodexSession: (id: string) => (calls.push(`codex:${id}`), true),
    abortAntigravitySession: (id: string) => (calls.push(`antigravity:${id}`), true),
    abortOpenCodeSession: (id: string) => (calls.push(`opencode:${id}`), true),
    abortHermesSession: (id: string) => (calls.push(`hermes:${id}`), true),
    abortKimiSession: (id: string) => (calls.push(`kimi:${id}`), true),
    abortDeepSeekSession: (id: string) => (calls.push(`deepseek:${id}`), true),
    abortGlmSession: (id: string) => (calls.push(`glm:${id}`), true),
    abortQwenSession: (id: string) => (calls.push(`qwen:${id}`), true),
  };
  return { calls, rawWs, writer, dependencies };
}

test('revoked writer aborts every owned provider bridge and fences output first', async () => {
  const context = harness();
  abortRunsForRevokedWriter(context.writer, context.rawWs as never, context.dependencies as never);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal((context.writer as never as { revoked: boolean }).revoked, true);
  assert.deepEqual(context.calls.sort(), PROVIDERS.map((provider) => {
    return `${provider}:run-${provider}`;
  }).sort());
});

test('current writer ownership reaches the Cursor and OpenCode abort bridges', () => {
  const context = harness();
  context.dependencies.getProviderRunsOwnedByWriter = () => [
    { sessionId: 'cursor-owned', provider: 'cursor', token: {} },
    { sessionId: 'opencode-owned', provider: 'opencode', token: {} },
  ];
  abortRunsForRevokedWriter(context.writer, context.rawWs as never, context.dependencies as never);
  assert.deepEqual(context.calls, ['cursor:cursor-owned', 'opencode:opencode-owned']);
});

test('project revocation aborts only selected writer-owned runs before transport close', () => {
  const rawWs = { readyState: 1, send: () => undefined };
  const writer = new WebSocketWriter(rawWs as never, 17);
  writer.bindRevocableRun('affected', 'opencode');
  writer.bindRevocableRun('unrelated', 'cursor');
  const calls: string[] = [];
  const count = abortProjectRunsForRevokedWriter(writer, rawWs as never, {
    abortOpenCodeSession: (id: string) => (calls.push(`opencode:${id}`), true),
    abortCursorSession: (id: string) => (calls.push(`cursor:${id}`), true),
  } as never, ['affected']);
  assert.equal(count, 1);
  assert.deepEqual(calls, ['opencode:affected']);
  assert.equal(writer.isRunOutputRevoked('affected'), true);
  assert.equal(writer.isRunOutputRevoked('unrelated'), false);
});

test('viewer and stale replacement tokens cannot abort provider work', () => {
  const viewer = harness();
  viewer.dependencies.getProviderRunsOwnedByWriter = () => [];
  abortRunsForRevokedWriter(viewer.writer, viewer.rawWs as never, viewer.dependencies as never);
  assert.deepEqual(viewer.calls, []);

  const stale = harness(false);
  abortRunsForRevokedWriter(stale.writer, stale.rawWs as never, stale.dependencies as never);
  assert.deepEqual(stale.calls, []);
  assert.equal((stale.writer as never as { revoked: boolean }).revoked, false);
});

test('supervised run ownership cancels through the supervisor without monitor registration', () => {
  const rawWs = { readyState: 1, send: () => undefined };
  const writer = new WebSocketWriter(rawWs as never, 29);
  writer.bindRevocableRun('supervised-kimi', 'kimi');
  const cancelled: unknown[] = [];
  abortRunsForRevokedWriter(writer, rawWs as never, {
    hostedTurnSupervisor: {
      cancel: (input: unknown) => (cancelled.push(input), true),
    },
  } as never);
  assert.deepEqual(cancelled, [{ provider: 'kimi', sessionId: 'supervised-kimi', userId: 29 }]);
  assert.equal(writer.isRunOutputRevoked(), true);
});

test('ordinary network and tab closes are not identity revocations', () => {
  assert.equal(isIdentityRevocationClose(1000, Buffer.from('normal')), false);
  assert.equal(isIdentityRevocationClose(1006, Buffer.alloc(0)), false);
  assert.equal(isIdentityRevocationClose(4401, Buffer.from('different_reason')), false);
  assert.equal(isIdentityRevocationClose(4401, Buffer.from('identity_revoked')), true);
});

test('trusted registry callback aborts before close even if peer later reports 1006', () => {
  const order: string[] = [];
  const socket = {
    abortIdentityRevokedRuns: () => order.push('abort'),
    close: (code: number, reason: string) => order.push(`close:${code}:${reason}`),
  };
  closeWebSocketForIdentityRevocation(socket as never);
  assert.deepEqual(order, ['abort', 'close:4401:identity_revoked']);
  assert.equal(isIdentityRevocationClose(1006, Buffer.alloc(0)), false);
});
