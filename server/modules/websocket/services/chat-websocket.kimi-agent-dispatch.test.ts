/**
 * chat-websocket.kimi-agent-dispatch.test.ts — KM-5 (ADR-062 §4.2 KM-3, W5-A).
 *
 * Tests for the kimi-agent dispatch logic inside `dispatchProviderCommand`
 * (chat-websocket.service.ts, KM-3). This is the narrow "survived the
 * governance / disable wall and now routed to the right launcher" layer.
 *
 * THE CORE CONTRACT (KM-3 / §4.2; kimi is back in DISABLED_PROVIDERS per the
 * owner decision of 2026-09-29, c4fe8f58c):
 *   • `mode === 'agent'` + `spawnKimiAgent` injected → spawnKimiAgent is called
 *     (the ADR-062 agent-run bypass of the disable wall, unchanged by that
 *     decision — the dormant native launcher mechanics stay covered here).
 *   • `mode === 'agent'` WITHOUT `spawnKimiAgent` → refused as disabled; no
 *     launcher runs and spawnKimiAgent is NOT invented.
 *   • No mode / mode=chat → refused as disabled; neither spawnKimi nor
 *     spawnKimiAgent runs.
 *
 * Proves (all pure — module-mocked DB, no binary, no real WS):
 *  (A) agent + wired → spawnKimiAgent called with (command, options, writer).
 *  (B) agent + NOT wired → refused, no launcher.
 *  (C) chat (no mode / mode=chat) → refused, no launcher.
 *  (D) spawnKimi never called when spawnKimiAgent handles the turn.
 *  (E) a refused kimi chat turn does NOT leak into spawnKimiAgent even when the
 *      launcher is wired.
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
    spawnHermes: spawn('hermes'),
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
    abortHermesSession: () => false,
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

/** Asserts the single not-started refusal the dispatch seam sends for a disabled provider. */
function assertRefusedAsDisabled(sent: SentPayload[], calls: string[]) {
  assert.deepEqual(calls, [], 'no launcher runs for a disabled provider');
  assert.equal(sent.length, 1, 'exactly one refusal frame');
  const [refusal] = sent as Array<SentPayload & { notStarted?: boolean }>;
  assert.equal(refusal.kind, 'complete');
  assert.equal(refusal.success, false);
  assert.equal(refusal.provider, 'kimi');
  assert.equal(refusal.notStarted, true, 'refused before a run starts');
  assert.match(String(refusal.error), /disabled on this deployment/);
}

// ---------------------------------------------------------------------------
// (A) mode==='agent' + spawnKimiAgent wired → spawnKimiAgent called
// ---------------------------------------------------------------------------
test('(A) kimi mode=agent with spawnKimiAgent wired → routes to spawnKimiAgent', async () => {
  const { writer } = makeWriter();
  let agentCalled = false;

  const { deps, calls } = makeDeps({
    spawnKimiAgent: async () => {
      agentCalled = true;
    },
  });

  await dispatchProviderCommand(
    'kimi-command',
    { command: 'write tests', options: { mode: 'agent', coordinationLevel: 'direct' } },
    writer,
    deps,
  );

  assert.ok(agentCalled, 'spawnKimiAgent must be called for mode=agent + wired launcher');
  assert.ok(calls.includes('kimi-agent'), 'kimi-agent must appear in the calls log');
  assert.ok(!calls.includes('kimi-chat'), 'spawnKimi (chat path) must NOT be called');
});

test('(A) spawnKimiAgent receives the correct command and options', async () => {
  const { writer } = makeWriter();
  const COMMAND = 'implement the feature';
  const OPTIONS = { mode: 'agent', permissionMode: 'acceptEdits', model: 'kimi-k2.6', coordinationLevel: 'direct' };

  let capturedCmd = '';
  let capturedOpts: unknown = null;

  const { deps } = makeDeps({
    spawnKimiAgent: async (cmd: string, opts: unknown) => {
      capturedCmd = cmd;
      capturedOpts = opts;
    },
  });

  await dispatchProviderCommand(
    'kimi-command',
    { command: COMMAND, options: OPTIONS },
    writer,
    deps,
  );

  assert.equal(capturedCmd, COMMAND, 'spawnKimiAgent must receive the original command');
  assert.deepEqual(
    (capturedOpts as typeof OPTIONS).mode,
    'agent',
    'spawnKimiAgent options must include mode:agent',
  );
});

// ---------------------------------------------------------------------------
// (B) mode==='agent' WITHOUT spawnKimiAgent wired → refused as disabled
// ---------------------------------------------------------------------------
test('(B) kimi mode=agent WITHOUT spawnKimiAgent wired → refused, no launcher', async () => {
  const { writer, sent } = makeWriter();

  // No spawnKimiAgent in deps → kimiAgentRun=false → no bypass. kimi is globally
  // disabled (2026-09-29), so the request is refused; it does not degrade to the
  // chat launcher and spawnKimiAgent is not invented.
  const { deps, calls } = makeDeps({});

  await dispatchProviderCommand(
    'kimi-command',
    { command: 'test', options: { mode: 'agent', coordinationLevel: 'direct' } },
    writer,
    deps,
  );

  assertRefusedAsDisabled(sent, calls);
});

// ---------------------------------------------------------------------------
// (C) No mode (chat turn) → refused as disabled
// ---------------------------------------------------------------------------
test('(C) kimi chat (no mode) → refused, never spawnKimi or spawnKimiAgent', async () => {
  const { writer, sent } = makeWriter();

  // spawnKimiAgent IS wired, but no mode=agent → kimiAgentRun=false (chat path).
  // kimi is disabled → refused; neither launcher runs.
  const { deps, calls } = makeDeps({
    spawnKimiAgent: async () => {
      throw new Error('spawnKimiAgent must not be called for a chat turn');
    },
  });

  await dispatchProviderCommand(
    'kimi-command',
    { command: 'hello', options: { coordinationLevel: 'direct' } }, // no mode
    writer,
    deps,
  );

  assertRefusedAsDisabled(sent, calls);
});

test('(C) kimi chat with explicit mode=chat → refused, no launcher', async () => {
  const { writer, sent } = makeWriter();
  const { deps, calls } = makeDeps({
    spawnKimiAgent: async () => {},
  });

  await dispatchProviderCommand(
    'kimi-command',
    { command: 'hello', options: { mode: 'chat', coordinationLevel: 'direct' } },
    writer,
    deps,
  );

  // mode=chat is NOT 'agent' → kimiAgentRun=false → the disable wall refuses it.
  assertRefusedAsDisabled(sent, calls);
});

// ---------------------------------------------------------------------------
// (D) spawnKimi (vendor-runtime) never called when spawnKimiAgent handles the turn
// ---------------------------------------------------------------------------
test('(D) spawnKimi is NOT called when spawnKimiAgent handles the agent turn', async () => {
  const { writer } = makeWriter();
  const { deps, calls } = makeDeps({
    spawnKimiAgent: async () => {},
  });

  await dispatchProviderCommand(
    'kimi-command',
    { command: 'do-work', options: { mode: 'agent', coordinationLevel: 'direct' } },
    writer,
    deps,
  );

  assert.ok(calls.includes('kimi-agent'), 'kimi-agent must be called');
  assert.ok(
    !calls.includes('kimi-chat'),
    'spawnKimi (chat path) must NOT be called when spawnKimiAgent is wired + mode=agent',
  );
});

// ---------------------------------------------------------------------------
// (E) A refused chat turn does not leak into spawnKimiAgent
// ---------------------------------------------------------------------------
test('(E) vendor-runtime isolation: chat turn never reaches spawnKimiAgent', async () => {
  // Even when spawnKimiAgent is wired, a chat-mode kimi turn must NOT end up in
  // spawnKimiAgent — it is refused as disabled. This proves the native-agent
  // bypass is ONLY for agent mode.
  const { writer, sent } = makeWriter();
  let kimiAgentHit = false;

  const { deps, calls } = makeDeps({
    spawnKimiAgent: async () => {
      kimiAgentHit = true;
    },
  });

  // Chat mode: kimi is disabled → refused, spawnKimiAgent NEVER touched.
  await dispatchProviderCommand(
    'kimi-command',
    { command: 'tell me something', options: { mode: 'chat', coordinationLevel: 'direct' } },
    writer,
    deps,
  );

  assert.equal(
    kimiAgentHit,
    false,
    'spawnKimiAgent must not be invoked for a chat-mode kimi turn',
  );
  // Confirm it was refused explicitly (not silently dropped).
  assertRefusedAsDisabled(sent, calls);
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

// Verify kimi agent bypass does NOT enable the GLM carrier.
test('kimi agent run does not enable GLM carrier (independent flags)', async () => {
  // When kimi agent mode is dispatched and the GLM carrier flag is OFF,
  // the GLM path must not be activated. They are independent bypass conditions.
  const { writer } = makeWriter();
  let opencodeHit = false;
  let kimiAgentHit = false;

  // Ensure GLM carrier flag is OFF in env.
  const savedCarrier = process.env.NASSAJ_OPENCODE_CARRIER;
  delete process.env.NASSAJ_OPENCODE_CARRIER;

  try {
    const { deps } = makeDeps({
      spawnKimiAgent: async () => {
        kimiAgentHit = true;
      },
    });

    // Override spawnOpenCode to detect if it is ever called.
    (deps as Record<string, unknown>).spawnOpenCode = async () => {
      opencodeHit = true;
    };

    await dispatchProviderCommand(
      'kimi-command',
      { command: 'work', options: { mode: 'agent', coordinationLevel: 'direct' } },
      writer,
      deps,
    );

    assert.equal(kimiAgentHit, true, 'kimi agent must run');
    assert.equal(opencodeHit, false, 'GLM/opencode must not run when only kimi agent is dispatched');
  } finally {
    if (savedCarrier === undefined) delete process.env.NASSAJ_OPENCODE_CARRIER;
    else process.env.NASSAJ_OPENCODE_CARRIER = savedCarrier;
  }
});
