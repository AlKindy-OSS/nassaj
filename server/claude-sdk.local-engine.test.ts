/**
 * ADR-227 / T-2098 stage 3a — the live Claude run on a local-engine profile:
 * the client's RAW model id reaches the run profile, the query runs the local
 * server's own model id (never the transcript's or the Claude fallback), and the
 * local pin is recorded strictly — a pin that does not settle stops the run.
 * Owner option B (2026-11-10): a local chat resolves its permission mode exactly
 * like a non-local chat with the same settings.
 */
// T-1873: harness CLIs resolve to sandbox stubs, never the host's installs.
import './shared/__tests__/stub-harness-binaries.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test, { after, mock } from 'node:test';

const LOCAL_MODEL = 'nassaj_local_0b9c6a3e6f1e4c419a4e2f1b9e0c7d11/gpt-oss-20b';
const LOCAL_PIN = `local:0b9c6a3e-6f1e-4c41-9a4e-2f1b9e0c7d11:1:${'a'.repeat(32)}`;

let queryArgs: Array<Record<string, unknown>> = [];
let profileInput: Record<string, unknown> | null = null;
let nextSessionId = 'local-session-1';
let localProfile = true;

mock.module('@anthropic-ai/claude-agent-sdk', {
  namedExports: {
    query: (arg: Record<string, unknown>) => {
      queryArgs.push(arg);
      const sessionId = nextSessionId;
      return {
        async *[Symbol.asyncIterator]() {
          yield { type: 'system', subtype: 'init', session_id: sessionId };
          yield { type: 'result', subtype: 'success', is_error: false, session_id: sessionId, result: 'ok' };
        },
        interrupt: async () => undefined,
        supportedCommands: async () => [],
        supportedModels: async () => [],
      };
    },
    createSdkMcpServer: () => ({}),
    tool: () => ({}),
  },
});

mock.module('./services/isolation/resolve-claude-run-profile.js', {
  namedExports: {
    resolveClaudeRunProfileOrThrow: async (input: Record<string, unknown>) => {
      profileInput = input;
      if (!localProfile) {
        return { env: { ...((input.baseEnv as NodeJS.ProcessEnv | undefined) ?? {}) }, effectiveEngine: null,
          engineHosts: new Set(), engineOrigins: null, local: null, pin: { storedEngine: null },
          credential: { principalId: 1, grantedBy: null, unit: 'claude', ownOnly: false } };
      }
      return {
        env: { ...((input.baseEnv as NodeJS.ProcessEnv | undefined) ?? {}), ANTHROPIC_BASE_URL: 'http://127.0.0.1:18080' },
        effectiveEngine: LOCAL_PIN,
        engineHosts: new Set(),
        engineOrigins: new Set(['http://127.0.0.1:18080']),
        local: { pin: LOCAL_PIN, model: 'gpt-oss-20b', serverId: '0b9c6a3e-6f1e-4c41-9a4e-2f1b9e0c7d11', ownerId: 1 },
        pin: { storedEngine: null },
        credential: { principalId: 1, grantedBy: null, unit: 'local', ownOnly: true },
      };
    },
  },
});

const database = await import('@/modules/database/index.js');
await database.initializeDatabase();
if (!database.userDb.getUserById(1)) database.userDb.createUser('member-1', 'hash', 'user');
// B-1373 refuses protected roots as project roots and the release preflight checks
// the tree out under ~/.nassaj-release-work, so the checkout cwd would leave no
// sessions row (and no pin) there. The project lives beside the isolated DB.
const projectDir = fs.mkdtempSync(path.join(path.dirname(database.getDatabasePath()), 'local-engine-project-'));
after(() => fs.rmSync(projectDir, { recursive: true, force: true }));
const sdk = await import('./claude-sdk.js') as unknown as {
  queryClaudeSDK: (prompt: string, options: Record<string, unknown>, ws: unknown) => Promise<unknown>;
};

function writer() {
  const sent: Record<string, unknown>[] = [];
  return { sent, userId: 1, ws: { readyState: 1 }, send: (payload: Record<string, unknown>) => sent.push(payload) };
}

async function withConfigDir(run: () => Promise<void>): Promise<void> {
  const configDir = fs.mkdtempSync('/var/tmp/t2098-sdk-local-');
  const oldConfig = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = configDir;
  try {
    await run();
  } finally {
    if (oldConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = oldConfig;
    fs.rmSync(configDir, { recursive: true, force: true });
  }
}

test('a new chat on a local model runs the server model id and pins the session to that server', async () => {
  await withConfigDir(async () => {
    queryArgs = [];
    nextSessionId = 'local-session-1';
    await sdk.queryClaudeSDK('hello', { cwd: projectDir, model: LOCAL_MODEL }, writer());
    assert.equal(profileInput?.requestedModel, LOCAL_MODEL, 'the raw client id, before Claude-catalog coercion');
    assert.equal(queryArgs.length, 1);
    assert.equal((queryArgs[0].options as Record<string, unknown>).model, 'gpt-oss-20b');
    assert.equal(database.sessionsDb.getSessionEnginePin('local-session-1')?.engine, LOCAL_PIN);
  });
});

test('a local pin that does not settle stops the run with a typed error', async () => {
  await withConfigDir(async () => {
    nextSessionId = 'local-session-2';
    const original = database.sessionsDb.setSessionEnginePin;
    database.sessionsDb.setSessionEnginePin = (() => ({ outcome: 'kept', engine: 'anthropic' })) as typeof original;
    const socket = writer();
    try {
      await sdk.queryClaudeSDK('hello', { cwd: projectDir, model: LOCAL_MODEL }, socket);
    } finally {
      database.sessionsDb.setSessionEnginePin = original;
    }
    const frames = JSON.stringify(socket.sent);
    assert.match(frames, /local model server pin of this chat could not be recorded/u);
    assert.ok(!socket.sent.some((frame) => frame.kind === 'complete' && frame.success === true), 'no successful completion');
  });
});

test('option B: a local chat gets the same permission mode as a non-local chat with the same settings', async () => {
  const modeOf = async (local: boolean, permissionMode: string | undefined, sessionId: string) => {
    localProfile = local;
    nextSessionId = sessionId;
    queryArgs = [];
    try {
      await sdk.queryClaudeSDK('hello', {
        cwd: projectDir, ...(local ? { model: LOCAL_MODEL } : {}), ...(permissionMode ? { permissionMode } : {}),
      }, writer());
    } finally {
      localProfile = true;
    }
    const options = queryArgs[0].options as Record<string, unknown>;
    return { mode: options.permissionMode, skip: options.allowDangerouslySkipPermissions ?? null };
  };
  await withConfigDir(async () => {
    for (const [index, mode] of [undefined, 'bypassPermissions', 'default', 'acceptEdits', 'plan'].entries()) {
      const local = await modeOf(true, mode, `parity-local-${index}`);
      const plain = await modeOf(false, mode, `parity-plain-${index}`);
      assert.deepEqual(local, plain, `mode ${String(mode)}`);
    }
  });
});
