/**
 * claude-sdk.engine-carrier-survival.test.ts — tripwire: the Claude body keeps
 * running on the kimi / glm / deepseek ENGINES, and keeps offering
 * `delegate_to_vendor`, after those ids are retired and deleted as agent bodies.
 *
 * Drives the production `queryClaudeSDK` with only the Agent SDK module-mocked,
 * so each case observes exactly what the SDK `query` call was handed:
 *   - the spawn env points at the engine's Anthropic-compatible endpoint with
 *     the member's own key;
 *   - the vendor model id the user picked is what the request names;
 *   - with delegation allowed, the per-spawn MCP server exposing
 *     `delegate_to_vendor` is registered.
 *
 * No process is spawned and no request leaves the machine: `fetch` is replaced
 * by a recorder that refuses every call.
 *
 * Runner: node:test with --experimental-test-module-mocks
 * (`npm run test:server -- <this file>`). The SDK mock MUST be registered
 * before the module under test is imported.
 */

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { mock, beforeEach, afterEach, after } from 'node:test';

import { installFakeHarnessBinary } from './shared/__tests__/harness-binary-fixtures.js';

type SdkMessage = Record<string, unknown>;
type QueryArg = { prompt?: unknown; options?: Record<string, unknown> };
type CapturedTool = { name: string; handler: unknown };
/** Same envelope the real SDK returns (`type: 'sdk'` keeps the entry in-process). */
type CapturedMcpServer = { type: 'sdk'; name: string; instance: { tools: CapturedTool[] } };

let lastQueryArg: QueryArg | null = null;

mock.module('@anthropic-ai/claude-agent-sdk', {
  namedExports: {
    query: (arg: QueryArg) => {
      lastQueryArg = arg;
      const messages: SdkMessage[] = [
        { type: 'result', session_id: 'survival-run', subtype: 'success', is_error: false, result: 'ok' },
      ];
      return {
        async *[Symbol.asyncIterator]() {
          for (const message of messages) yield message;
        },
        interrupt: async () => {},
        supportedCommands: async () => [],
        supportedModels: async () => [],
      };
    },
    // Keep what the production builder registers, so the test can read it back.
    createSdkMcpServer: (config: { name: string; tools: CapturedTool[] }): CapturedMcpServer => ({
      type: 'sdk',
      name: config.name,
      instance: { tools: config.tools },
    }),
    tool: (name: string, _description: string, _schema: unknown, handler: unknown): CapturedTool => ({
      name,
      handler,
    }),
  },
});

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-carrier-survival-sdk-'));
const originalDatabasePath = process.env.DATABASE_PATH;
process.env.DATABASE_PATH = path.join(sandbox, 'auth.db');

const sdk = (await import('./claude-sdk.js')) as unknown as {
  queryClaudeSDK: (command: string, options: Record<string, unknown>, ws: unknown) => Promise<unknown>;
};
const database = await import('./modules/database/index.js');
await database.initializeDatabase();
const secrets = (await import('./services/isolation/provider-secrets-store.js')) as unknown as {
  setProviderKey: (userId: string, provider: string, key: string) => unknown;
  _resetProviderSecretsServerKeyCache: () => void;
};
const { PROVIDER_ANTHROPIC_ENDPOINT } = await import('./services/isolation/provider-anthropic-endpoints.js');

const member = database.userDb.createUser('survival-engine-member', 'hash', 'user');
const USER_ID = String(member.id);

const ENV_KEYS = [
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_AUTH_TOKEN',
  'API_TIMEOUT_MS',
  'CLAUDE_CONFIG_DIR',
  'NASSAJ_PROVIDER_CAGE',
  'NASSAJ_PROVIDER_SECRETS_KEY',
  'KIMI_API_KEY',
  'DEEPSEEK_API_KEY',
  'GLM_API_KEY',
] as const;

let savedEnv: Record<string, string | undefined> = {};
let sandboxHome = '';
let projectDir = '';
let originalHomedir: () => string;
let originalFetch: typeof fetch;
let refusedRequests: string[] = [];

beforeEach(() => {
  lastQueryArg = null;
  refusedRequests = [];

  savedEnv = {};
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }

  sandboxHome = fs.mkdtempSync(path.join(sandbox, 'home-'));
  projectDir = fs.mkdtempSync(path.join(sandbox, 'project-'));
  process.env.CLAUDE_CONFIG_DIR = path.join(sandboxHome, '.claude');
  fs.mkdirSync(process.env.CLAUDE_CONFIG_DIR, { recursive: true });
  originalHomedir = os.homedir;
  (os as unknown as { homedir: () => string }).homedir = () => sandboxHome;
  installFakeHarnessBinary(sandboxHome, 'claude');
  process.env.NASSAJ_PROVIDER_SECRETS_KEY = crypto.randomBytes(32).toString('base64');
  secrets._resetProviderSecretsServerKeyCache();

  originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: unknown) => {
    refusedRequests.push(String(input instanceof Request ? input.url : input));
    throw new Error('network is disabled in this test');
  }) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  (os as unknown as { homedir: () => string }).homedir = originalHomedir;
  for (const key of ENV_KEYS) {
    const value = savedEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  secrets._resetProviderSecretsServerKeyCache();
  for (const dir of [sandboxHome, projectDir]) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

after(() => {
  database.closeConnection();
  if (originalDatabasePath === undefined) delete process.env.DATABASE_PATH;
  else process.env.DATABASE_PATH = originalDatabasePath;
  fs.rmSync(sandbox, { recursive: true, force: true });
});

type Payload = Record<string, unknown>;

function makeWs() {
  const sent: Payload[] = [];
  return {
    sent,
    send: (payload: Payload) => { sent.push(payload); },
    userId: member.id,
    ws: { readyState: 1 },
  };
}

/** Vendor model id the picker offers for each engine (the embedded fallback ids). */
const ENGINE_MODEL = { glm: 'glm-5.2', kimi: 'kimi-k2.6', deepseek: 'deepseek-v4-pro' } as const;

/** The options the composer sends for a new Claude conversation on an engine. */
function claudeTurnOptions(overrides: Record<string, unknown>) {
  return {
    projectPath: projectDir,
    cwd: projectDir,
    resume: false,
    toolsSettings: { allowedTools: [], disallowedTools: [], skipPermissions: false },
    permissionMode: 'default',
    sessionSummary: null,
    images: [],
    ...overrides,
  };
}

const errorsOf = (rows: Payload[]) => rows.filter((row) => row.kind === 'error');

for (const engine of ['glm', 'kimi', 'deepseek'] as const) {
  test(`a Claude turn on the ${engine} engine is handed to the SDK pointed at that engine`, async () => {
    secrets.setProviderKey(USER_ID, engine, `sk-${engine}-member-key`);
    const ws = makeWs();

    await sdk.queryClaudeSDK(
      'hello engine',
      claudeTurnOptions({ model: ENGINE_MODEL[engine], engineProvider: engine }),
      ws,
    );

    assert.deepEqual(errorsOf(ws.sent), [], 'an engine turn with a stored key must not error');
    assert.ok(lastQueryArg, 'the SDK query was constructed');
    const options = lastQueryArg!.options ?? {};
    const env = (options.env ?? {}) as Record<string, string>;
    assert.equal(env.ANTHROPIC_BASE_URL, PROVIDER_ANTHROPIC_ENDPOINT[engine]);
    assert.equal(env.ANTHROPIC_AUTH_TOKEN, `sk-${engine}-member-key`);
    assert.equal(options.model, ENGINE_MODEL[engine], 'the vendor model id is what the request names');
    assert.equal(
      refusedRequests.some((url) => url.includes('api.anthropic.com')),
      false,
      'nothing about an engine turn may target official Anthropic',
    );
  });

  test(`a Claude turn pinned to ${engine} with no key never reaches the SDK`, async () => {
    const ws = makeWs();

    await sdk.queryClaudeSDK(
      'hello engine',
      claudeTurnOptions({ model: ENGINE_MODEL[engine], engineProvider: engine }),
      ws,
    );

    assert.equal(lastQueryArg, null, 'a keyless engine must not silently run on official Anthropic');
    assert.equal(errorsOf(ws.sent).length > 0, true, 'the refusal is visible to the user');
  });
}

test('the Claude body registers delegate_to_vendor when delegation is allowed', async () => {
  const ws = makeWs();

  await sdk.queryClaudeSDK(
    'ask another model',
    claudeTurnOptions({ model: 'sonnet', allowVendorDelegation: true }),
    ws,
  );

  assert.deepEqual(errorsOf(ws.sent), []);
  assert.ok(lastQueryArg, 'the SDK query was constructed');
  const servers = (lastQueryArg!.options?.mcpServers ?? {}) as Record<string, CapturedMcpServer>;
  const delegate = servers['vendor-delegate'];
  assert.ok(delegate, 'the vendor-delegate MCP server must be registered for the Claude body');
  assert.deepEqual(delegate.instance.tools.map((entry) => entry.name), ['delegate_to_vendor']);
  assert.equal(typeof delegate.instance.tools[0].handler, 'function');
});

test('the Claude body does not register delegate_to_vendor by default', async () => {
  const ws = makeWs();

  await sdk.queryClaudeSDK('plain turn', claudeTurnOptions({ model: 'sonnet' }), ws);

  assert.ok(lastQueryArg, 'the SDK query was constructed');
  const servers = (lastQueryArg!.options?.mcpServers ?? {}) as Record<string, unknown>;
  assert.equal('vendor-delegate' in servers, false);
});
