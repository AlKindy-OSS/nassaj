/**
 * claude-sdk.compaction-model.test.ts — T-2087 (ADR-223 §3), QA HIGH-3.
 *
 * Drives the real runClaudeSDKQuery (through queryClaudeSDK) with only the
 * Agent SDK and the run-profile resolver mocked, over a real sessions row, a
 * real pinned Haiku re-pick and a transcript on disk (the anonymized fixture, its
 * model set to Sonnet 5 at 238,894 input tokens). It observes the `model` the
 * SDK query is actually handed:
 *   - `/compact` → the model that last served the conversation, with the 1M
 *     tag the transcript drops restored (the 200k variant cannot hold it);
 *   - a normal turn → the session's pin, unchanged.
 */

// T-1873: harness CLIs resolve to sandbox stubs, never the host's installs.
import './shared/__tests__/stub-harness-binaries.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test, { after, mock } from 'node:test';

const queryArgs: Array<{ options?: Record<string, unknown> }> = [];

mock.module('@anthropic-ai/claude-agent-sdk', {
  namedExports: {
    query: (arg: { options?: Record<string, unknown> }) => {
      queryArgs.push(arg);
      return {
        async *[Symbol.asyncIterator]() {
          yield { type: 'result', subtype: 'success', is_error: false, session_id: SESSION_ID, result: 'ok' };
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
    resolveClaudeRunProfileOrThrow: async (input: Record<string, unknown>) => ({
      env: { ...((input.baseEnv as NodeJS.ProcessEnv | undefined) ?? {}) },
      effectiveEngine: null,
      engineHosts: null,
      pin: { storedEngine: 'claude' },
    }),
  },
});

const SESSION_ID = '3f2a9c1e-7b4d-4e8a-9c2f-1a2b3c4d5e6f';
const root = fs.mkdtempSync('/var/tmp/t2087-compaction-');
const configDir = path.join(root, 'claude-config');
const projectDir = path.join(root, 'project');
const transcriptPath = path.join(configDir, 'projects', '-project', `${SESSION_ID}.jsonl`);
fs.mkdirSync(path.dirname(transcriptPath), { recursive: true });
fs.mkdirSync(projectDir);
const fixture = fs.readFileSync(
  path.join(import.meta.dirname, 'modules/context-guard/__fixtures__/claude-tail.jsonl'), 'utf8',
);
fs.writeFileSync(transcriptPath, fixture.replaceAll('SESSION_ID', SESSION_ID).replaceAll('claude-opus-5-5', 'claude-sonnet-5'));

const oldConfig = process.env.CLAUDE_CONFIG_DIR;
process.env.CLAUDE_CONFIG_DIR = configDir;

const database = await import('@/modules/database/index.js');
await database.initializeDatabase();
if (!database.userDb.getUserById(1)) database.userDb.createUser('member-1', 'hash', 'user');
database.sessionsDb.createSession(SESSION_ID, 'claude', projectDir, undefined, undefined, undefined, transcriptPath);
const { writeProviderSessionActiveModelChange } = await import('@/shared/utils.js');
await writeProviderSessionActiveModelChange('claude', { sessionId: SESSION_ID, model: 'haiku' });

const sdk = await import('./claude-sdk.js') as unknown as {
  queryClaudeSDK: (prompt: string, options: Record<string, unknown>, ws: unknown) => Promise<unknown>;
};

after(() => {
  database.closeConnection();
  if (oldConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = oldConfig;
  fs.rmSync(root, { recursive: true, force: true });
});

function writer() {
  return { sent: [] as unknown[], userId: 1, ws: { readyState: 1 }, send(payload: unknown) { this.sent.push(payload); } };
}

async function modelHandedToSdk(command: string, options: Record<string, unknown> = {}): Promise<unknown> {
  queryArgs.length = 0;
  await sdk.queryClaudeSDK(command, { sessionId: SESSION_ID, cwd: projectDir, ...options }, writer());
  const resumed = queryArgs.filter((arg) => arg.options?.resume === SESSION_ID);
  assert.equal(resumed.length, 1, `${command}: exactly one resumed SDK query`);
  return resumed[0].options?.model;
}

test('/compact runs on the model that last served the conversation, 1M tag restored', async () => {
  assert.equal(await modelHandedToSdk('/compact'), 'claude-sonnet-5[1m]');
  assert.equal(await modelHandedToSdk('/compact keep the API notes', { compactionModel: 'haiku' }),
    'claude-sonnet-5[1m]', 'a client-sent compactionModel is never read');
});

test('a normal turn keeps the pinned model', async () => {
  assert.equal(await modelHandedToSdk('continue'), 'haiku');
});
