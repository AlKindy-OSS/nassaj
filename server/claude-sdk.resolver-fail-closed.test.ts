/**
 * ADR-152 A1 §3.4 (T-2083, BE-8) — no `{ ...process.env }` fallback on a resolver
 * error. The three sites that used to fall back to the operator's environment
 * (the built-in commands probe, the /btw fork, the Claude model-catalog probe)
 * must refuse instead and spawn NOTHING. The resolver is made to throw; the SDK
 * `query` is a counter.
 *
 * Runner: node:test with --experimental-test-module-mocks.
 */
import './shared/__tests__/stub-harness-binaries.js';
import assert from 'node:assert/strict';
import test, { mock, beforeEach } from 'node:test';

let queryCalls = 0;
mock.module('@anthropic-ai/claude-agent-sdk', {
  namedExports: {
    query: () => {
      queryCalls += 1;
      return {
        async *[Symbol.asyncIterator]() { /* nothing */ },
        interrupt: async () => {},
        close: () => {},
        supportedCommands: async () => [{ name: 'leak', description: 'operator env reached a child' }],
        supportedModels: async () => [{ value: 'leak', displayName: 'leak' }],
      };
    },
    createSdkMcpServer: () => ({}),
    tool: () => ({}),
  },
});

const realResolver = await import('./services/isolation/resolve-provider-env.js');
let resolverCalls = 0;
mock.module(new URL('./services/isolation/resolve-provider-env.js', import.meta.url).href, {
  namedExports: {
    ...realResolver,
    resolveProviderEnv: () => {
      resolverCalls += 1;
      throw Object.assign(new Error('injected resolver failure'), { code: 'CREDENTIAL_ACTOR_REQUIRED', statusCode: 500 });
    },
  },
});
mock.module(new URL('./modules/execution-permissions/runtime-catalog.js', import.meta.url).href, {
  namedExports: {
    runAuthorizedProviderCatalog: async (_p: string, _u: unknown, _pr: unknown, run: () => Promise<unknown>) => run(),
  },
});

const sdk = (await import('./claude-sdk.js')) as unknown as {
  getClaudeBuiltInCommands: (context: Record<string, unknown>) => Promise<unknown>;
  spawnClaudeSideQuery: (params: Record<string, unknown>, callbacks: Record<string, unknown>) => Promise<void>;
};
const { getClaudeModelCatalog, __resetClaudeCatalogCircuit } = await import(
  './modules/providers/list/claude/claude-catalog.client.js'
);

beforeEach(() => {
  queryCalls = 0;
  resolverCalls = 0;
  __resetClaudeCatalogCircuit();
});

test('built-in commands probe: a resolver error answers null and spawns nothing', async () => {
  assert.equal(await sdk.getClaudeBuiltInCommands({ userId: 7, cwd: process.cwd() }), null);
  assert.ok(resolverCalls >= 1, 'the resolver was consulted');
  assert.equal(queryCalls, 0, 'no Claude child was spawned on a fallback env');
});

test('/btw fork: a resolver error is reported to the caller and spawns nothing', async () => {
  const errors: string[] = [];
  const messages: string[] = [];
  let started = false;
  await sdk.spawnClaudeSideQuery(
    { sessionId: 'live-1', question: 'what?', upToMessageId: 'm-1', userId: 7, cwd: process.cwd() },
    { onError: (code: string, message: string) => { errors.push(code); messages.push(message); }, onStarted: () => { started = true; } },
  );
  assert.deepEqual(errors, ['sdk_error']);
  assert.equal(resolverCalls, 1, 'refused at the first resolution, with no fallback env carried on');
  assert.deepEqual(messages, ['This question needs a signed-in member.'], 'the refusal is the resolver\'s, not a later failure');
  assert.equal(started, false);
  assert.equal(queryCalls, 0, 'no fork ran on the operator environment');
});

test('model catalog probe: a resolver error degrades to the fallback catalog and spawns nothing', async () => {
  const catalog = await getClaudeModelCatalog(7);
  assert.ok(resolverCalls >= 1);
  assert.equal(queryCalls, 0);
  assert.equal(JSON.stringify(catalog).includes('leak'), false, 'no live catalog from an operator-env probe');
});
