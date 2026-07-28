/**
 * chat-websocket.kimi-agent-dispatch.test.ts — KM-5 (ADR-062 §4.2 KM-3, W5-A).
 *
 * Tests for the kimi-agent dispatch logic inside `dispatchProviderCommand`
 * (chat-websocket.service.ts, KM-3). This is the narrow "survived the
 * governance / disable wall and now routed to the right launcher" layer.
 *
 * THE CORE CONTRACT (KM-3 / §4.2, updated per ADR-062 re-enable of kimi):
 *   • `mode === 'agent'` + `spawnKimiAgent` injected → spawnKimiAgent is called
 *     (the governed native CLI path).
 *   • `mode === 'agent'` WITHOUT `spawnKimiAgent` → falls back to the vendor
 *     chat launcher spawnKimi. kimi is no longer in DISABLED_PROVIDERS (ADR-062),
 *     so with no native launcher wired the agent request degrades to the chat
 *     path rather than being refused; spawnKimiAgent is NOT invented.
 *   • No mode (chat turn) → spawnKimi (vendor-runtime), never spawnKimiAgent.
 *   • kimi CHAT stays on `spawnKimi` (vendor-runtime), never routed to
 *     `spawnKimiAgent`.
 *
 * Proves (all pure — module-mocked DB, no binary, no real WS):
 *  (A) agent + wired → spawnKimiAgent called with (command, options, writer).
 *  (B) agent + NOT wired → spawnKimi (chat) handles it, spawnKimiAgent untouched.
 *  (C) chat (no mode) → spawnKimi, never spawnKimiAgent.
 *  (D) spawnKimi never called when spawnKimiAgent handles the turn.
 *  (E) vendor-runtime stays intact: a kimi chat turn does NOT leak into
 *      spawnKimiAgent even when the launcher is wired.
 *
 * Runner:
 *   npx tsx --experimental-test-module-mocks --tsconfig server/tsconfig.json \
 *     --test server/modules/websocket/services/chat-websocket.kimi-agent-dispatch.test.ts
 */

import assert from 'node:assert/strict';
import test, { mock } from 'node:test';

import type { WebSocketWriter } from '@/modules/websocket/services/websocket-writer.service.js';

// ---------------------------------------------------------------------------
// Module mock — must be registered BEFORE importing the service under test.
// The database module is imported at module scope by the service (via namespace
// import to handle partial mocks gracefully — cf. chat-websocket.service.ts:8).
// ---------------------------------------------------------------------------
mock.module('@/modules/database/index.js', {
  namedExports: {
    projectsDb: {
      getProjectPath: () => null,
      isProjectVisibleToUser: () => true,
    },
    sessionsDb: {
      getSessionById: () => null,
    },
    userDb: {
      getUserById: () => null,
      getFirstUser: () => null,
    },
  },
});

const { dispatchProviderCommand, isOpenCodeCarrierEnabled } = await import(
  './chat-websocket.service.js'
);

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
    spawnGemini: spawn('gemini'),
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
    abortGeminiSession: () => false,
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
    { command: 'write tests', options: { mode: 'agent' } },
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
  const OPTIONS = { mode: 'agent', permissionMode: 'acceptEdits', model: 'kimi-k2.6' };

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
// (B) mode==='agent' WITHOUT spawnKimiAgent wired → chat-launcher fallback
// ---------------------------------------------------------------------------
test('(B) kimi mode=agent WITHOUT spawnKimiAgent wired → falls back to spawnKimi (chat)', async () => {
  const { writer, sent } = makeWriter();

  // No spawnKimiAgent in deps → kimiAgentRun=false. kimi is no longer globally
  // disabled (ADR-062), so the agent request degrades to the vendor chat
  // launcher spawnKimi instead of being refused. spawnKimiAgent must NOT be
  // invented, and no refusal message is sent.
  const { deps, calls } = makeDeps({});

  await dispatchProviderCommand(
    'kimi-command',
    { command: 'test', options: { mode: 'agent' } },
    writer,
    deps,
  );

  assert.deepEqual(
    calls,
    ['kimi-chat'],
    'the vendor chat launcher handles the agent request when no native launcher is wired',
  );
  assert.ok(!calls.includes('kimi-agent'), 'spawnKimiAgent must not be called when it is not wired');
  assert.deepEqual(sent, [], 'no refusal message — kimi is enabled');
});

// ---------------------------------------------------------------------------
// (C) No mode (chat turn) → vendor chat launcher spawnKimi
// ---------------------------------------------------------------------------
test('(C) kimi chat (no mode) → spawnKimi (chat), never spawnKimiAgent', async () => {
  const { writer, sent } = makeWriter();

  // spawnKimiAgent IS wired, but no mode=agent → kimiAgentRun=false (chat path).
  // kimi chat is enabled (ADR-062) → routes to spawnKimi, never a refusal and
  // never spawnKimiAgent.
  const { deps, calls } = makeDeps({
    spawnKimiAgent: async () => {
      throw new Error('spawnKimiAgent must not be called for a chat turn');
    },
  });

  await dispatchProviderCommand(
    'kimi-command',
    { command: 'hello', options: {} }, // no mode
    writer,
    deps,
  );

  assert.deepEqual(calls, ['kimi-chat'], 'chat turn routes to the vendor chat launcher');
  assert.ok(!calls.includes('kimi-agent'), 'spawnKimiAgent must not be called for chat');
  assert.deepEqual(sent, [], 'no refusal — kimi chat is enabled');
});

test('(C) kimi chat with explicit mode=chat → spawnKimi, no native launcher', async () => {
  const { writer, sent } = makeWriter();
  const { deps, calls } = makeDeps({
    spawnKimiAgent: async () => {},
  });

  await dispatchProviderCommand(
    'kimi-command',
    { command: 'hello', options: { mode: 'chat' } },
    writer,
    deps,
  );

  // mode=chat is NOT 'agent' → kimiAgentRun=false → vendor chat launcher.
  assert.deepEqual(calls, ['kimi-chat'], 'mode=chat routes to spawnKimi');
  assert.ok(!calls.includes('kimi-agent'), 'spawnKimiAgent must not run for mode=chat');
  assert.deepEqual(sent, [], 'no refusal — kimi chat is enabled');
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
    { command: 'do-work', options: { mode: 'agent' } },
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
// (E) Vendor-runtime stays intact: chat turn does not leak into spawnKimiAgent
// ---------------------------------------------------------------------------
test('(E) vendor-runtime isolation: chat turn never reaches spawnKimiAgent', async () => {
  // Even when spawnKimiAgent is wired, a chat-mode kimi turn must NOT end up in
  // spawnKimiAgent — it routes to the vendor chat launcher spawnKimi. This proves
  // the native-agent bypass is ONLY for agent mode.
  const { writer } = makeWriter();
  let kimiAgentHit = false;

  const { deps, calls } = makeDeps({
    spawnKimiAgent: async () => {
      kimiAgentHit = true;
    },
  });

  // Chat mode: kimi chat is enabled → routed to spawnKimi, spawnKimiAgent NEVER touched.
  await dispatchProviderCommand(
    'kimi-command',
    { command: 'tell me something', options: { mode: 'chat' } },
    writer,
    deps,
  );

  assert.equal(
    kimiAgentHit,
    false,
    'spawnKimiAgent must not be invoked for a chat-mode kimi turn',
  );
  // Confirm it routed to the vendor chat launcher (not silently dropped).
  assert.deepEqual(calls, ['kimi-chat'], 'chat-mode kimi routes to the vendor chat launcher');
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
      { command: 'work', options: { mode: 'agent' } },
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
