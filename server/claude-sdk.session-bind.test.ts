/**
 * claude-sdk.session-bind.test.ts — T-1910 S2 (B-1202, qa I2).
 *
 * A new Claude chat binds its permission decision to the session id the CLI will use BEFORE the
 * CLI is spawned, so no tool can run while the decision names no session; the CLI must then speak
 * for exactly that id. Drives the production `queryClaudeSDK`; only the SDK query is a stand-in.
 *
 * Runner: node:test with --experimental-test-module-mocks (npm run test:server).
 */

// T-1873: harness CLIs resolve to sandbox stubs, never the host's installs.
import './shared/__tests__/stub-harness-binaries.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { mock, beforeEach, afterEach } from 'node:test';

type Payload = Record<string, unknown>;
type SdkOptions = Record<string, unknown> & {
  sessionId?: string;
  resume?: string;
  env?: Record<string, string>;
  canUseTool?: (tool: string, input: unknown, context: unknown) => Promise<Record<string, unknown>>;
};

const chatQueries: SdkOptions[] = [];
let speakAs: ((options: SdkOptions) => string) | null = null;

mock.module('@anthropic-ai/claude-agent-sdk', {
  namedExports: {
    query: ({ options }: { options: SdkOptions }) => {
      const isChat = typeof options?.canUseTool === 'function';
      if (isChat) chatQueries.push(options);
      return {
        async *[Symbol.asyncIterator]() {
          if (!isChat) return;
          const sid = speakAs ? speakAs(options) : (options.sessionId ?? options.resume ?? '');
          yield { type: 'system', subtype: 'init', session_id: sid };
          yield { type: 'result', subtype: 'success', is_error: false, result: 'done', session_id: sid };
        },
        interrupt: async () => {},
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
    resolveClaudeRunProfileOrThrow: async ({ baseEnv = process.env } = {}) => ({
      env: { ...baseEnv }, effectiveEngine: null, engineHosts: null, pin: {},
    }),
  },
});

const sdk = (await import('./claude-sdk.js')) as unknown as {
  queryClaudeSDK: (command: string, options: Record<string, unknown>, ws: unknown) => Promise<unknown>;
};

const DECISION_ID = '5d1c2b3a-0f9e-4d8c-b7a6-112233445566';
const RESUMED = '00001910-0000-4000-8000-000000000002';
let tmpConfigDir = '';
let tmpCwd = '';
let savedConfigDir: string | undefined;

function makeWs() {
  const sent: Payload[] = [];
  return { sent, send: (p: Payload) => { sent.push(p); }, userId: null, ws: { readyState: 1 } };
}

/** Gateway-shaped handle: the gate opens only when bindSession "commits". */
function bindingPermission(trace: string[], options: { bindCommits?: boolean } = {}) {
  let bound: string | null = null;
  return {
    decisionId: DECISION_ID,
    get boundSessionId() { return bound; },
    bindSession: (sid: string) => {
      trace.push('bind');
      if (options.bindCommits !== false) bound = sid;
    },
    isSessionBound: () => bound !== null,
    consume: () => { trace.push('consume'); },
    markStarted: () => { trace.push('started'); },
    attachChildIdentity: () => { trace.push('child'); },
    settle: (outcome: string) => { trace.push(`settle:${outcome}`); },
    notStarted: () => { trace.push('not-started'); },
  };
}

beforeEach(() => {
  chatQueries.length = 0;
  speakAs = null;
  savedConfigDir = process.env.CLAUDE_CONFIG_DIR;
  tmpConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), 't1910-cfg-'));
  process.env.CLAUDE_CONFIG_DIR = tmpConfigDir;
  tmpCwd = fs.mkdtempSync(path.join(os.tmpdir(), 't1910-cwd-'));
});

afterEach(() => {
  if (savedConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = savedConfigDir;
  for (const dir of [tmpConfigDir, tmpCwd]) fs.rmSync(dir, { recursive: true, force: true });
});

test('a new chat binds before consume/start and the CLI is launched on the bound session id', async () => {
  const trace: string[] = [];
  const permission = bindingPermission(trace);
  const ws = makeWs();
  await sdk.queryClaudeSDK('hello', { cwd: tmpCwd, permissionExecution: permission }, ws);

  assert.equal(chatQueries.length, 1);
  const options = chatQueries[0];
  assert.deepEqual(trace.slice(0, 3), ['bind', 'consume', 'started'], 'the bind CAS precedes the spawn');
  assert.match(options.sessionId ?? '', /^[0-9a-f-]{36}$/u);
  assert.equal(options.sessionId, permission.boundSessionId);
  assert.equal(options.resume, undefined);
  assert.equal(options.env?.CCUI_PROCESS_TAG, `pe-${DECISION_ID}`, 'durable run tag');
  const created = ws.sent.find((p) => p.kind === 'session_created');
  assert.equal(created?.sessionId, permission.boundSessionId);
  assert.equal(trace.at(-1), 'settle:succeeded');
});

test('a tool attempted while the decision names no session is refused', async () => {
  const trace: string[] = [];
  // A bind that never committed (simulates the ordering regressing): the gate must stay shut.
  await sdk.queryClaudeSDK('hello', {
    cwd: tmpCwd, permissionExecution: bindingPermission(trace, { bindCommits: false }),
  }, makeWs());
  const canUseTool = chatQueries[0]?.canUseTool;
  assert.ok(canUseTool);
  const verdict = await canUseTool('Bash', { command: 'true' }, { signal: new AbortController().signal });
  assert.equal(verdict.behavior, 'deny');
  assert.match(String(verdict.message), /bound to its session/u);
});

test('a CLI speaking for another session id stops the run and never reports it as created', async () => {
  const trace: string[] = [];
  speakAs = () => '99999999-9999-4999-8999-999999999999';
  const ws = makeWs();
  await sdk.queryClaudeSDK('hello', { cwd: tmpCwd, permissionExecution: bindingPermission(trace) }, ws);
  assert.equal(ws.sent.some((p) => p.kind === 'session_created'), false);
  assert.ok(ws.sent.some((p) => p.kind === 'error'));
  assert.equal(trace.at(-1), 'settle:reconciled_unknown', 'the bound session is fenced, not the user');
});

test('a new chat refuses a handle that cannot bind; a resume never binds', async () => {
  const trace: string[] = [];
  const { bindSession: _bind, isSessionBound: _bound, ...unbindable } = bindingPermission(trace);
  await assert.rejects(
    sdk.queryClaudeSDK('hello', { cwd: tmpCwd, permissionExecution: unbindable }, makeWs()),
    /PERMISSION_EXECUTION_HANDLE_INVALID/u,
  );
  assert.equal(chatQueries.length, 0, 'no CLI for an unbindable new chat');

  const resumeTrace: string[] = [];
  await sdk.queryClaudeSDK('hello', {
    sessionId: RESUMED, cwd: tmpCwd, permissionExecution: bindingPermission(resumeTrace),
  }, makeWs());
  assert.equal(resumeTrace.includes('bind'), false);
  assert.equal(chatQueries[0]?.sessionId, undefined);
  assert.equal(chatQueries[0]?.resume, RESUMED);
});
