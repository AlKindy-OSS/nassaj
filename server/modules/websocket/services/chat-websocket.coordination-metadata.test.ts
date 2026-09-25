import assert from 'node:assert/strict';
import test, { mock } from 'node:test';

import type { WebSocketWriter } from '@/modules/websocket/services/websocket-writer.service.js';

import { reviewEnvelopeDatabaseLinkStubs } from '../../../../tests/helpers/review-envelope-link-stubs.js';

import { createPermissionTestWorkspaceModule, dispatchAuthorizedProviderCommand } from './chat-websocket.permission-test-helper.js';

const claims: unknown[] = [];
const writes: string[] = [];
let metadataWritesThrow = false;
let bindingSucceeds = true;
let claimResult:
  | { action: 'dispatch' }
  | { action: 'fingerprint_mismatch' }
  | { action: 'ambiguous_started' }
  | { action: 'replay_verdict'; verdict: Record<string, unknown> } = { action: 'dispatch' };
mock.module('@/modules/database/index.js', {
  namedExports: {
    ...reviewEnvelopeDatabaseLinkStubs(),
    projectsDb: {
      getProjectPath: () => ({ project_id: 'test-project' }),
      isProjectVisibleToUser: () => true,
      isProjectWritableByUser: () => true,
    },
    sessionsDb: { getSessionById: () => ({
      session_id: 's1', provider: 'claude', project_path: process.cwd(),
    }) },
    participantsDb: { isParticipant: () => true },
    sessionWorkspaceModesDb: {
      readLegacyEligibility: () => ({ eligible: true }),
      markOverlay: () => undefined,
    },
    sessionOutcomesDb: {},
    userDb: { getUserById: () => null, getFirstUser: () => null },
    messageCoordinationDb: {
      claim: (row: unknown) => { claims.push(row); return claimResult; },
      bindSession: () => bindingSucceeds,
      markStarted: () => {
        writes.push("started");
        if (metadataWritesThrow) throw new Error('no such column: lifecycle_status');
      },
      recordVerdict: () => {
        writes.push("verdict");
        if (metadataWritesThrow) throw new Error('no such column: verdict_json');
      },
    },
  },
});
mock.module('@/modules/session-workspaces/index.js', { namedExports: createPermissionTestWorkspaceModule() });

const { dispatchProviderCommand: rawDispatchProviderCommand } = await import('./chat-websocket.service.js');
const dispatchProviderCommand = dispatchAuthorizedProviderCommand.bind(null, rawDispatchProviderCommand as never);

test('live frames carry immutable coordination and resumed turn is persisted once', async () => {
  claims.length = 0;
  claimResult = { action: 'dispatch' };
  const sent: Array<Record<string, unknown>> = [];
  const writer = { send: (payload: Record<string, unknown>) => sent.push(payload) } as unknown as WebSocketWriter;
  let launcherOptions: Record<string, unknown> | undefined;
  const dependencies = {
    queryClaudeSDK: async (_command: string, options: unknown, runWriter: WebSocketWriter) => {
      launcherOptions = options as Record<string, unknown>;
      runWriter.send({ kind: 'text', role: 'user', content: 'hello', sessionId: 's1' } as never);
    },
    spawnCursor: async () => {}, queryCodex: async () => {}, spawnGemini: async () => {},
    spawnAntigravity: async () => {}, spawnHermes: async () => {}, spawnKimi: async () => {},
    spawnDeepSeek: async () => {}, spawnGlm: async () => {}, spawnOpenCode: async () => {},
    getSessionProvider: () => 'claude', getActiveClaudeSDKSessions: () => [],
  } as never;

  await dispatchProviderCommand('claude-command', {
    command: 'hello', options: { sessionId: 's1', clientMsgId: 'c1', coordinationLevel: 'delegate_review' },
  } as never, writer, dependencies, '7');

  assert.equal(Object.isFrozen(launcherOptions), true);
  assert.equal(sent[0].coordinationLevel, 'delegate_review');
  assert.deepEqual(claims, [{
    sessionId: 's1', clientMsgId: 'c1', userId: 7, provider: 'claude',
    canonicalContent: 'hello', coordinationLevel: 'delegate_review',
  }]);
});

test('ambiguous started and fingerprint mismatch are rejected before launcher', async () => {
  let launches = 0;
  const sent: Array<Record<string, unknown>> = [];
  const writer = { send: (payload: Record<string, unknown>) => sent.push(payload) } as unknown as WebSocketWriter;
  const dependencies = {
    queryClaudeSDK: async () => { launches += 1; },
    spawnCursor: async () => {}, queryCodex: async () => {}, spawnGemini: async () => {},
    spawnAntigravity: async () => {}, spawnHermes: async () => {}, spawnKimi: async () => {},
    spawnDeepSeek: async () => {}, spawnGlm: async () => {}, spawnOpenCode: async () => {},
    getSessionProvider: () => 'claude', getActiveClaudeSDKSessions: () => [],
  } as never;
  for (const action of ['ambiguous_started', 'fingerprint_mismatch'] as const) {
    claimResult = { action };
    await dispatchProviderCommand('claude-command', {
      command: 'hello', options: { sessionId: 's1', clientMsgId: 'same-id' },
    } as never, writer, dependencies, 7);
  }
  assert.equal(launches, 0);
  assert.deepEqual(sent.map((payload) => payload.code), [
    'client_msg_id_already_started', 'client_msg_id_fingerprint_mismatch',
  ]);
  assert.ok(sent.every((payload) => !Object.hasOwn(payload, 'notStarted')),
    'ambiguous/mismatch rejection must not claim the original turn never started');
  assert.ok(sent.every((payload) => payload.sameClientMsgIdRetryable === false));
});

test('B-726/B-727: legacy coordination sidecar failure cannot swallow terminal frames', async () => {
  claims.length = 0;
  claimResult = { action: 'dispatch' };
  metadataWritesThrow = true;
  const sent: Array<Record<string, unknown>> = [];
  const writer = { send: (payload: Record<string, unknown>) => sent.push(payload) } as unknown as WebSocketWriter;
  const dependencies = {
    queryClaudeSDK: async (_command: string, _options: unknown, runWriter: WebSocketWriter) => {
      runWriter.send({ kind: 'text', role: 'assistant', content: 'done', sessionId: 's1' } as never);
      runWriter.send({ kind: 'complete', success: true, exitCode: 0, sessionId: 's1' } as never);
    },
    spawnCursor: async () => {}, queryCodex: async () => {}, spawnGemini: async () => {},
    spawnAntigravity: async () => {}, spawnHermes: async () => {}, spawnKimi: async () => {},
    spawnDeepSeek: async () => {}, spawnGlm: async () => {}, spawnOpenCode: async () => {},
    getSessionProvider: () => 'claude', getActiveClaudeSDKSessions: () => [],
  } as never;

  try {
    await dispatchProviderCommand('claude-command', {
      command: 'hello', options: { sessionId: 's1', clientMsgId: 'legacy-db' },
    } as never, writer, dependencies, 7);
  } finally {
    metadataWritesThrow = false;
  }

  assert.deepEqual(sent.map(({ kind }) => kind), ['text', 'complete']);
  assert.equal(sent[1].success, true);
  assert.equal(sent[1].sameClientMsgIdRetryable, false);
});

test('a conflicting explicit turn identity cannot overwrite another ingress receipt', async () => {
  claims.length = 0;
  claimResult = { action: 'dispatch' };
  metadataWritesThrow = false;
  writes.length = 0;
  const sent: Array<Record<string, unknown>> = [];
  const writer = { send: (payload: Record<string, unknown>) => sent.push(payload) } as unknown as WebSocketWriter;
  const dependencies = {
    queryClaudeSDK: async (_command: string, _options: unknown, runWriter: WebSocketWriter) => {
      runWriter.send({ kind: 'text', role: 'assistant', content: 'done', sessionId: 's1', clientMsgId: 'another-turn' } as never);
      runWriter.send({ kind: 'complete', success: true, exitCode: 0, sessionId: 's1', clientMsgId: 'another-turn' } as never);
    },
    spawnCursor: async () => {}, queryCodex: async () => {}, spawnGemini: async () => {},
    spawnAntigravity: async () => {}, spawnHermes: async () => {}, spawnKimi: async () => {},
    spawnDeepSeek: async () => {}, spawnGlm: async () => {}, spawnOpenCode: async () => {},
    getSessionProvider: () => 'claude', getActiveClaudeSDKSessions: () => [],
  } as never;

  try {
    await dispatchProviderCommand('claude-command', {
      command: 'hello', options: { sessionId: 's1', clientMsgId: 'legacy-db' },
    } as never, writer, dependencies, 7);
  } finally {
    metadataWritesThrow = false;
  }

  assert.deepEqual(sent.map(({ kind }) => kind), ['text', 'complete']);
  assert.equal(sent[1].success, true);
  assert.deepEqual(writes, []);
  assert.equal(sent[1].sameClientMsgIdRetryable, false);
});


test('normalized Claude frames cannot grant acceptance, including synthetic auth text', async () => {
  claimResult = { action: 'dispatch' };
  for (const [binding, frame, expected] of [
    [true, { kind: 'session_created', sessionId: 's1' }, []],
    [false, { kind: 'text', role: 'assistant', sessionId: 's1' }, []],
    [true, { kind: 'text', role: 'assistant', sessionId: 's1', provider: 'codex' }, []],
    [true, { kind: 'text', role: 'assistant', sessionId: 'other' }, []],
    [true, { kind: 'text', role: 'assistant', sessionId: 's1', actualSessionId: 'other' }, []],
    [true, { kind: 'text', role: 'user', sessionId: 's1' }, []],
    [true, { kind: 'text', role: 'assistant', sessionId: 's1' }, []],
    [true, { kind: 'text', role: 'assistant', sessionId: 's1', content: 'Not logged in', model: '<synthetic>' }, []],
  ] as const) {
    writes.length = 0;
    bindingSucceeds = binding;
    const sent: unknown[] = [];
    const dependencies = {
      queryClaudeSDK: async (_command: string, _options: unknown, runWriter: WebSocketWriter) => { runWriter.send(frame as never); },
      spawnCursor: async () => {}, queryCodex: async () => {}, spawnGemini: async () => {},
      spawnAntigravity: async () => {}, spawnHermes: async () => {}, spawnKimi: async () => {},
      spawnDeepSeek: async () => {}, spawnGlm: async () => {}, spawnOpenCode: async () => {},
      getSessionProvider: () => 'claude', getActiveClaudeSDKSessions: () => [],
    } as never;
    try {
      await dispatchProviderCommand('claude-command', {
        command: 'hello', options: { sessionId: 's1', clientMsgId: 'acceptance-scope' },
      } as never, { send: (event: unknown) => sent.push(event) } as WebSocketWriter, dependencies, 7);
      assert.deepEqual(writes, expected, JSON.stringify({ binding, frame }));
      assert.equal(sent.length, 1, 'sidecar cannot swallow transport');
    } finally { bindingSucceeds = true; }
  }
});
