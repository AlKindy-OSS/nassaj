import assert from 'node:assert/strict';
import test from 'node:test';

import {
  isRoleDowngrade,
  revocationForRoleChange,
  revocationForStatusChange,
} from '@/modules/account-wallet/index.js';
// eslint-disable-next-line boundaries/no-unknown -- the provider error observer is a production writer proxy.
import { observeProviderErrors } from '@/shared/provider-terminal-proof.js';
import { unwrapWriter } from '@/shared/writer-target.js';

import { WebSocketWriter } from './websocket-writer.service.js';
import {
  abortProviderRun,
  isIdentityRevocationClose,
} from './chat-websocket.service.js';
import { closeWebSocketForIdentityRevocation } from './websocket-server.service.js';
import { listUserOwnedRuns } from './user-run-revocation.service.js';
import { transparentWriterWith, transparentWriterWithSend } from './writer-proxy.js';

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

test('T-1854 (qa M4): abortProviderRun aborts only the run this writer owns, and reports it', async () => {
  const rawWs = { readyState: 1, send: () => undefined };
  const writer = new WebSocketWriter(rawWs as never, 17);
  writer.bindRevocableRun('affected', 'opencode');
  writer.bindRevocableRun('unrelated', 'cursor');
  const calls: string[] = [];
  const dependencies = {
    abortOpenCodeSession: (id: string) => (calls.push(`opencode:${id}`), true),
    abortCursorSession: (id: string) => (calls.push(`cursor:${id}`), true),
  };
  assert.equal(abortProviderRun(writer, dependencies as never, 'affected'), true);
  assert.deepEqual(calls, ['opencode:affected'], 'the unrelated run on the same socket is untouched');
  assert.equal(writer.isRunOutputRevoked(), false, 'a per-run abort never fences the whole socket');
  assert.equal(abortProviderRun(writer, dependencies as never, 'not-registered-yet'), false,
    'nothing owned yet = retry later');

  const foreign = harness(false);
  foreign.dependencies.getProviderRunsOwnedByWriter = () => [{ sessionId: 'x', provider: 'cursor', token: {} }];
  assert.equal(abortProviderRun(foreign.writer, foreign.dependencies as never, 'x'), false,
    'a registration this writer does not own (stale token) is never aborted');
  assert.deepEqual(foreign.calls, []);

  const claude = harness();
  claude.dependencies.getProviderRunsOwnedByWriter = () => [{ sessionId: 'c', provider: 'claude', token: {} }];
  claude.dependencies.abortClaudeSDKSession = async () => ({ aborted: true, reason: 'ok', sessionId: 'c' }) as never;
  assert.equal(await abortProviderRun(claude.writer, claude.dependencies as never, 'c'), true);
  claude.dependencies.abortClaudeSDKSession = async () => ({ aborted: false, reason: 'gone', sessionId: null }) as never;
  assert.equal(await abortProviderRun(claude.writer, claude.dependencies as never, 'c'), false);
});

test('B-1327: unwrapWriter sees through every production writer proxy stack', () => {
  const rawWs = { readyState: 1, send: () => undefined };
  const writer = new WebSocketWriter(rawWs as never, 17);
  const coordination = transparentWriterWithSend(writer, () => undefined);
  const fenced = transparentWriterWith(coordination, { get runFenceRevoked() { return false; } });
  const observed = observeProviderErrors(fenced, () => undefined);
  assert.equal(unwrapWriter(observed), writer);
  assert.equal(unwrapWriter(writer), writer, 'a raw writer is returned unchanged');
  assert.equal(unwrapWriter(null), null);
  assert.equal(observed.userId, 17, 'the proxy still forwards the JWT user id');
});

test('B-1327: supervised runs are listed per user even after their socket moved on', () => {
  const writer = new WebSocketWriter({ readyState: 1, send: () => undefined } as never, 41);
  const other = new WebSocketWriter({ readyState: 1, send: () => undefined } as never, 42);
  const token = writer.bindRevocableRun('sup-41', 'kimi');
  other.bindRevocableRun('sup-42', 'kimi');
  writer.updateWebSocket({ readyState: 3, send: () => undefined } as never);
  const runs = listUserOwnedRuns(41, {} as never);
  assert.deepEqual(runs.map((run) => run.sessionId), ['sup-41']);
  assert.equal(runs[0].isCurrent(), true);
  writer.releaseRevocableRun('sup-41', token);
  assert.equal(runs[0].isCurrent(), false, 'a released generation is never aborted');
  assert.deepEqual(listUserOwnedRuns(41, {} as never), []);
});

test('B-1327: role ordering owner > admin > user; unknown targets fail closed', () => {
  assert.equal(isRoleDowngrade('admin', 'user'), true);
  assert.equal(isRoleDowngrade('owner', 'admin'), true);
  assert.equal(isRoleDowngrade('owner', 'user'), true);
  assert.equal(isRoleDowngrade('user', 'admin'), false);
  assert.equal(isRoleDowngrade('admin', 'owner'), false);
  assert.equal(isRoleDowngrade('user', 'user'), false);
  assert.equal(isRoleDowngrade('user', 'mystery'), true);
});

test('B-1327: revocation policy — who stops turns and who loses shells/terminals', () => {
  assert.deepEqual(revocationForRoleChange('admin', 'user'),
    { abortReason: 'role_changed', endInteractiveSessions: true });
  assert.deepEqual(revocationForRoleChange('owner', 'admin'),
    { abortReason: 'role_changed', endInteractiveSessions: false }, 'admin keeps shell/terminal rights');
  assert.deepEqual(revocationForRoleChange('user', 'admin'), { abortReason: null, endInteractiveSessions: false });
  assert.deepEqual(revocationForStatusChange('disabled'),
    { abortReason: 'account_disabled', endInteractiveSessions: true });
  assert.deepEqual(revocationForStatusChange('active'), { abortReason: null, endInteractiveSessions: false });
});

test('ordinary network and tab closes are not identity revocations', () => {
  assert.equal(isIdentityRevocationClose(1000, Buffer.from('normal')), false);
  assert.equal(isIdentityRevocationClose(1006, Buffer.alloc(0)), false);
  assert.equal(isIdentityRevocationClose(4401, Buffer.from('different_reason')), false);
  assert.equal(isIdentityRevocationClose(4401, Buffer.from('identity_revoked')), true);
});

test('B-1327: the registry callback only closes — it never cancels provider work', () => {
  const order: string[] = [];
  const socket = {
    abortIdentityRevokedRuns: () => order.push('abort'),
    close: (code: number, reason: string) => order.push(`close:${code}:${reason}`),
  };
  closeWebSocketForIdentityRevocation(socket as never);
  assert.deepEqual(order, ['close:4401:identity_revoked']);
});
