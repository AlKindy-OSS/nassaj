/**
 * chat-websocket.kimi-agent-dispatch.test.ts — KM-5 (ADR-062 §4.2 KM-3), T-1953.
 *
 * The kimi BODY is retired (ADR-192). This file used to prove the ADR-062
 * agent-run bypass — `mode === 'agent'` with `spawnKimiAgent` wired reached the
 * native launcher past the disable wall. That bypass sits AFTER the retired-body
 * refusal in `dispatchProviderCommand`, so it can no longer be reached; the
 * native launcher stays in the tree as dormant code until it is deleted.
 *
 * THE CONTRACT NOW: every `kimi-command` — agent or chat, launcher wired or
 * not, carrier flag on or off — gets the single typed `provider_removed`
 * refusal before a run starts, and no launcher of any kind is called. (The kimi
 * ENGINE is a different axis: it travels as `claude-command` and is pinned by
 * chat-websocket.engine-carrier-survival.test.ts.)
 *
 * Pure: module-mocked DB, no binary, no real WS.
 *
 * Runner:
 *   npx tsx --experimental-test-module-mocks --tsconfig server/tsconfig.json \
 *     --test server/modules/websocket/services/chat-websocket.kimi-agent-dispatch.test.ts
 */

import assert from 'node:assert/strict';
import test, { mock } from 'node:test';

import type { WebSocketWriter } from '@/modules/websocket/services/websocket-writer.service.js';

import { reviewEnvelopeDatabaseLinkStubs } from '../../../../tests/helpers/review-envelope-link-stubs.js';

import { createPermissionTestWorkspaceModule, dispatchAuthorizedProviderCommand } from './chat-websocket.permission-test-helper.js';

// ---------------------------------------------------------------------------
// Module mock — must be registered BEFORE importing the service under test.
// The database module is imported at module scope by the service (via namespace
// import to handle partial mocks gracefully — cf. chat-websocket.service.ts:8).
// ---------------------------------------------------------------------------
mock.module('@/modules/database/index.js', {
  namedExports: {
    ...reviewEnvelopeDatabaseLinkStubs(),
    projectsDb: {
      getProjectPath: () => ({ project_id: 'test-project' }),
      isProjectVisibleToUser: () => true,
    },
    sessionsDb: {
      getSessionById: () => null,
    },
    sessionWorkspaceModesDb: { markOverlay: () => undefined },
    userDb: {
      getUserById: () => null,
      getFirstUser: () => null,
    },
  },
});
mock.module('@/modules/session-workspaces/index.js', { namedExports: createPermissionTestWorkspaceModule() });

const { dispatchProviderCommand: rawDispatchProviderCommand, isOpenCodeCarrierEnabled } = await import(
  './chat-websocket.service.js'
);
const dispatchProviderCommand = dispatchAuthorizedProviderCommand.bind(null, rawDispatchProviderCommand as never);

// ---------------------------------------------------------------------------
// Harness helpers
// ---------------------------------------------------------------------------

type SentPayload = {
  kind?: string;
  success?: boolean;
  error?: string;
  provider?: string;
};

function makeWriter() {
  const sent: SentPayload[] = [];
  const writer = {
    send: (payload: unknown) => {
      sent.push(payload as SentPayload);
    },
  } as unknown as WebSocketWriter;
  return { writer, sent };
}

/** Builds a minimal ChatWebSocketDependencies object. `spawnKimiAgent` is optional. */
function makeDeps(overrides: {
  spawnKimiAgent?: (cmd: string, opts: unknown, writer: WebSocketWriter) => Promise<void>;
  sessionProvider?: Record<string, string>;
}) {
  const calls: string[] = [];
  const spawnLog: { name: string; cmd: string; opts: unknown }[] = [];

  const spawn =
    (name: string) =>
    async (cmd: string, opts: unknown) => {
      calls.push(name);
      spawnLog.push({ name, cmd, opts });
    };

  const deps = {
    queryClaudeSDK: spawn('claude'),
    spawnCursor: spawn('cursor'),
    queryCodex: spawn('codex'),
    spawnAntigravity: spawn('antigravity'),
    spawnOpenCode: spawn('opencode'),
    spawnKimi: spawn('kimi-chat'),
    spawnDeepSeek: spawn('deepseek'),
    spawnGlm: spawn('glm'),
    getSessionProvider: (sessionId: string) =>
      (overrides.sessionProvider ?? {})[sessionId] ?? null,
    abortClaudeSDKSession: async () => false,
    abortCursorSession: () => false,
    abortCodexSession: () => false,
    abortAntigravitySession: () => false,
    abortOpenCodeSession: () => false,
    abortKimiSession: () => false,
    abortDeepSeekSession: () => false,
    abortGlmSession: () => false,
    resolveToolApproval: async () => {},
    spawnClaudeSideQuery: async () => {},
  } as unknown as Parameters<typeof dispatchProviderCommand>[3];

  if (typeof overrides.spawnKimiAgent === 'function') {
    (deps as Record<string, unknown>).spawnKimiAgent = async (
      cmd: string,
      opts: unknown,
      w: WebSocketWriter,
    ) => {
      calls.push('kimi-agent');
      spawnLog.push({ name: 'kimi-agent', cmd, opts });
      return overrides.spawnKimiAgent!(cmd, opts, w);
    };
  }

  return { deps, calls, spawnLog };
}

/** Asserts the single not-started refusal the dispatch seam sends for the retired kimi body. */
function assertRefusedAsRemoved(sent: SentPayload[], calls: string[]) {
  assert.deepEqual(calls, [], 'no launcher runs for a retired body');
  assert.equal(sent.length, 1, 'exactly one refusal frame');
  const [refusal] = sent as Array<SentPayload & { notStarted?: boolean; code?: string }>;
  assert.equal(refusal.kind, 'complete');
  assert.equal(refusal.success, false);
  assert.equal(refusal.provider, 'kimi');
  assert.equal(refusal.notStarted, true, 'refused before a run starts');
  assert.equal(refusal.code, 'provider_removed');
}

const WIRED = { spawnKimiAgent: async () => {} };

const KIMI_TURNS: ReadonlyArray<[string, Parameters<typeof makeDeps>[0], Record<string, unknown>]> = [
  ['(A) mode=agent with spawnKimiAgent wired', WIRED, { mode: 'agent', coordinationLevel: 'direct' }],
  ['(A) mode=agent with full agent options', WIRED,
    { mode: 'agent', permissionMode: 'acceptEdits', model: 'kimi-k2.6', coordinationLevel: 'direct' }],
  ['(B) mode=agent WITHOUT spawnKimiAgent wired', {}, { mode: 'agent', coordinationLevel: 'direct' }],
  ['(C) chat with no mode', WIRED, { coordinationLevel: 'direct' }],
  ['(C) chat with explicit mode=chat', WIRED, { mode: 'chat', coordinationLevel: 'direct' }],
];

for (const [label, overrides, options] of KIMI_TURNS) {
  test(`${label} → provider_removed, no launcher`, async () => {
    const { writer, sent } = makeWriter();
    const { deps, calls } = makeDeps(overrides);

    await dispatchProviderCommand('kimi-command', { command: 'work', options }, writer, deps);

    assertRefusedAsRemoved(sent, calls);
  });
}

test('(D) resuming a session persisted under kimi in agent mode is refused the same way', async () => {
  const { writer, sent } = makeWriter();
  const { deps, calls } = makeDeps({ ...WIRED, sessionProvider: { 'kimi-session-1': 'kimi' } });

  await dispatchProviderCommand(
    'kimi-command',
    { command: 'continue', options: { sessionId: 'kimi-session-1', mode: 'agent', coordinationLevel: 'direct' } },
    writer,
    deps,
  );

  assertRefusedAsRemoved(sent, calls);
});

// ---------------------------------------------------------------------------
// Bonus: isOpenCodeCarrierEnabled is exported for unit tests (GLM carrier flag)
// ---------------------------------------------------------------------------
test('isOpenCodeCarrierEnabled: OFF by default, ON with truthy values', () => {
  // OFF
  assert.equal(isOpenCodeCarrierEnabled({}), false, 'must be OFF when flag absent');
  assert.equal(
    isOpenCodeCarrierEnabled({ NASSAJ_OPENCODE_CARRIER: 'false' }),
    false,
  );
  assert.equal(
    isOpenCodeCarrierEnabled({ NASSAJ_OPENCODE_CARRIER: '0' }),
    false,
  );

  // ON
  for (const truthy of ['true', '1', 'yes', 'on']) {
    assert.equal(
      isOpenCodeCarrierEnabled({ NASSAJ_OPENCODE_CARRIER: truthy }),
      true,
      `'${truthy}' must enable the carrier`,
    );
  }
});

test('(E) an armed GLM carrier flag does not route a kimi agent turn to OpenCode', async () => {
  const savedCarrier = process.env.NASSAJ_OPENCODE_CARRIER;
  process.env.NASSAJ_OPENCODE_CARRIER = '1';
  try {
    const { writer, sent } = makeWriter();
    const { deps, calls } = makeDeps(WIRED);

    await dispatchProviderCommand(
      'kimi-command',
      { command: 'work', options: { mode: 'agent', coordinationLevel: 'direct' } },
      writer,
      deps,
    );

    assertRefusedAsRemoved(sent, calls);
  } finally {
    if (savedCarrier === undefined) delete process.env.NASSAJ_OPENCODE_CARRIER;
    else process.env.NASSAJ_OPENCODE_CARRIER = savedCarrier;
  }
});
