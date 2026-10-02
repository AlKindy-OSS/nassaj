/**
 * chat-websocket.engine-carrier-survival.test.ts — tripwire: a Claude turn that
 * runs on a vendor ENGINE must keep reaching the Claude SDK query path when the
 * kimi / glm / deepseek agent BODIES are retired and deleted.
 *
 * The engine path always travels as `claude-command` with `options.engineProvider`
 * (the client never sends `<id>-command` for it). Retiring a body refuses the
 * `<id>-command` types and persisted rows of that body; it must never refuse, or
 * re-route, a `claude-command` whose engine stamp names the same id.
 *
 * The payload below is the shape the composer builds for the Claude provider.
 * Pure: module-mocked DB, no binary, no real WS.
 *
 * RUNNER: node:test (`npm run test:server -- <this file>`).
 */

import assert from 'node:assert/strict';
import test, { mock } from 'node:test';

import type { WebSocketWriter } from '@/modules/websocket/services/websocket-writer.service.js';

import { reviewEnvelopeDatabaseLinkStubs } from '../../../../tests/helpers/review-envelope-link-stubs.js';

import { createPermissionTestWorkspaceModule, dispatchAuthorizedProviderCommand } from './chat-websocket.permission-test-helper.js';

/**
 * Persisted session rows keyed by session id, in the column shape of the
 * `sessions` table: the body lives in `provider`, the engine in `engine_provider`.
 */
type SessionRow = {
  session_id: string;
  provider: string;
  project_path: string;
  engine_provider: string | null;
  engine_provider_source: string | null;
};
const sessionRows = new Map<string, SessionRow>();

mock.module('@/modules/database/index.js', {
  namedExports: {
    ...reviewEnvelopeDatabaseLinkStubs(),
    projectsDb: {
      getProjectPath: () => ({ project_id: 'test-project' }),
      isProjectVisibleToUser: () => true,
    },
    sessionsDb: {
      getSessionById: (sessionId: string) => sessionRows.get(sessionId) ?? null,
    },
    sessionWorkspaceModesDb: {
      markOverlay: () => undefined,
      readLegacyEligibility: () => null,
    },
    userDb: {
      getUserById: () => null,
      getFirstUser: () => null,
    },
  },
});
mock.module('@/modules/session-workspaces/index.js', { namedExports: createPermissionTestWorkspaceModule() });

const { dispatchProviderCommand: rawDispatchProviderCommand } = await import('./chat-websocket.service.js');
const dispatchProviderCommand = dispatchAuthorizedProviderCommand.bind(null, rawDispatchProviderCommand as never);

type SentPayload = { kind?: string; success?: boolean; error?: string; code?: string };

function makeWriter() {
  const sent: SentPayload[] = [];
  const writer = {
    send: (payload: unknown) => {
      sent.push(payload as SentPayload);
    },
  } as unknown as WebSocketWriter;
  return { writer, sent };
}

/**
 * Every launcher a dispatch could pick. The body launchers are listed so a
 * wrong route is observed as a call, not as a missing dependency.
 */
function makeDeps() {
  const spawnLog: { name: string; command: string; opts: Record<string, unknown> }[] = [];
  const spawn =
    (name: string) =>
    async (command: string, opts: unknown) => {
      spawnLog.push({ name, command, opts: (opts ?? {}) as Record<string, unknown> });
    };

  const dependencies = {
    queryClaudeSDK: spawn('claude'),
    queryCodex: spawn('codex'),
    spawnAntigravity: spawn('antigravity'),
    spawnOpenCode: spawn('opencode'),
    spawnCursor: spawn('cursor'),
    spawnHermes: spawn('hermes'),
    spawnQwen: spawn('qwen'),
    spawnKimi: spawn('kimi'),
    spawnKimiAgent: spawn('kimi-agent'),
    spawnDeepSeek: spawn('deepseek'),
    spawnGlm: spawn('glm'),
    getSessionProvider: (sessionId: string) => sessionRows.get(sessionId)?.provider ?? null,
  } as unknown as Parameters<typeof dispatchProviderCommand>[3];

  return { dependencies, spawnLog };
}

/** Vendor model id the picker offers for each engine (the embedded fallback ids). */
const ENGINE_MODEL = { glm: 'glm-5.2', kimi: 'kimi-k2.6', deepseek: 'deepseek-v4-pro' } as const;

/** The options object the composer sends for the Claude provider on an engine. */
function claudeEngineOptions(engine: keyof typeof ENGINE_MODEL, overrides: Record<string, unknown> = {}) {
  const projectPath = process.cwd();
  return {
    projectPath,
    cwd: projectPath,
    sessionId: null,
    resume: false,
    toolsSettings: { allowedTools: [], disallowedTools: [], skipPermissions: false },
    permissionMode: 'default',
    model: ENGINE_MODEL[engine],
    sessionSummary: null,
    images: [],
    engineProvider: engine,
    ...overrides,
  };
}

for (const engine of ['glm', 'kimi', 'deepseek'] as const) {
  test(`a new claude-command stamped ${engine} reaches the Claude SDK with its engine intact`, async () => {
    const { writer, sent } = makeWriter();
    const { dependencies, spawnLog } = makeDeps();

    await dispatchProviderCommand(
      'claude-command',
      { command: 'hello engine', options: claudeEngineOptions(engine) },
      writer,
      dependencies,
    );

    assert.deepEqual(spawnLog.map((entry) => entry.name), ['claude'], 'only the Claude SDK takes the turn');
    assert.equal(spawnLog[0]?.command, 'hello engine');
    assert.equal(spawnLog[0]?.opts.engineProvider, engine, 'the engine stamp must reach the SDK call');
    assert.equal(spawnLog[0]?.opts.model, ENGINE_MODEL[engine], 'the vendor model id is passed through');
    assert.deepEqual(sent, [], 'no refusal frame for an engine turn');
  });

  test(`resuming a Claude session stamped ${engine} still reaches the Claude SDK`, async () => {
    const sessionId = `survival-${engine}-0000-4000-8000-000000000001`;
    sessionRows.set(sessionId, {
      session_id: sessionId,
      provider: 'claude',
      project_path: process.cwd(),
      engine_provider: engine,
      engine_provider_source: 'server_verdict',
    });
    const { writer, sent } = makeWriter();
    const { dependencies, spawnLog } = makeDeps();

    await dispatchProviderCommand(
      'claude-command',
      {
        command: 'continue',
        sessionId,
        options: claudeEngineOptions(engine, { sessionId, resume: true }),
      },
      writer,
      dependencies,
    );

    assert.deepEqual(sent, [], 'no refusal frame for a resumed engine turn');
    assert.deepEqual(spawnLog.map((entry) => entry.name), ['claude']);
    assert.equal(spawnLog[0]?.opts.engineProvider, engine);
  });
}

test('vendor delegation requested from the Claude settings reaches the Claude SDK call', async () => {
  const { writer, sent } = makeWriter();
  const { dependencies, spawnLog } = makeDeps();

  await dispatchProviderCommand(
    'claude-command',
    {
      command: 'ask another model',
      options: {
        ...claudeEngineOptions('glm'),
        engineProvider: undefined,
        model: 'sonnet',
        allowVendorDelegation: true,
      },
    },
    writer,
    dependencies,
  );

  assert.deepEqual(spawnLog.map((entry) => entry.name), ['claude']);
  assert.equal(spawnLog[0]?.opts.allowVendorDelegation, true);
  assert.deepEqual(sent, []);
});
