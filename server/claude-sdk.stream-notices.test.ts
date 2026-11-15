/**
 * claude-sdk.stream-notices.test.ts — T-2113: the production `queryClaudeSDK`
 * loop forwards hook health, lost transcript writes and an ending sign-in.
 *
 * Only the Agent SDK is mocked; the scripted messages use the 0.3.325 shapes
 * (see claude-stream-notices.test.ts for their sources).
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

type SdkMessage = Record<string, unknown>;
type Payload = Record<string, unknown>;

let scriptedMessages: SdkMessage[] = [];

mock.module('@anthropic-ai/claude-agent-sdk', {
  namedExports: {
    query: () => {
      const messages = scriptedMessages;
      return {
        async *[Symbol.asyncIterator]() {
          for (const m of messages) yield m;
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

{
  const memberDb = await import('@/modules/database/index.js');
  await memberDb.initializeDatabase();
  if (!memberDb.userDb.getUserById(1)) memberDb.userDb.createUser('member-1', 'hash', 'user');
}
const sdk = (await import('./claude-sdk.js')) as unknown as {
  queryClaudeSDK: (command: string, options: Record<string, unknown>, ws: unknown) => Promise<unknown>;
};

const ENV_KEYS = ['CLAUDE_CONFIG_DIR', 'SESSION_REGISTRY_claude'] as const;
let savedEnv: Record<string, string | undefined> = {};
let tmpConfigDir = '';
let tmpCwd = '';

/** A `WebSocketWriter`-shaped writer that records broadcast and owner-only frames apart. */
function makeWs(socketUserId: number | null = 1) {
  const sent: Payload[] = [];
  const ownerOnly: Payload[] = [];
  const mirrored: Payload[] = [];
  return {
    sent, ownerOnly, mirrored,
    send: (p: Payload) => { sent.push(p); },
    sendViewerFrames: (primary: Payload, mirror: Payload, sessionId: string | null) => {
      ownerOnly.push(primary);
      if (sessionId) mirrored.push(mirror);
    },
    userId: 1,
    ws: { readyState: 1, userId: socketUserId },
  };
}

let sidCounter = 0;
const nextSid = () => `t2113-session-${++sidCounter}-0000-4000-8000-000000000000`;
const init = (sid: string): SdkMessage => ({ type: 'system', subtype: 'init', session_id: sid });
const notices = (rows: Payload[], code: string) => rows.filter(p => p.kind === 'notice' && p.noticeCode === code);

beforeEach(() => {
  scriptedMessages = [];
  savedEnv = {};
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  process.env.SESSION_REGISTRY_claude = '1';
  tmpConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), 't2113-cfg-'));
  process.env.CLAUDE_CONFIG_DIR = tmpConfigDir;
  tmpCwd = fs.mkdtempSync(path.join(os.tmpdir(), 't2113-cwd-'));
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k] as string;
  }
  for (const dir of [tmpConfigDir, tmpCwd]) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

test('hook heartbeats reach the client as one running-checks status', async () => {
  const sid = nextSid();
  const ws = makeWs();
  const beat = (n: number) => ({ type: 'tool_progress', tool_use_id: 'hook-1', tool_name: 'PreToolUse',
    parent_tool_use_id: null, elapsed_time_seconds: n, uuid: `b${n}`, session_id: sid });
  scriptedMessages = [init(sid), beat(1), beat(2), beat(3),
    { type: 'assistant', uuid: 'a1', message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] } },
    { type: 'result', subtype: 'success', is_error: false }];

  await sdk.queryClaudeSDK('hi', { sessionId: sid, cwd: tmpCwd }, ws);

  const statuses = ws.sent.filter(p => p.kind === 'status' && typeof p.text === 'string'
    && !['token_budget', 'process_state'].includes(p.text));
  assert.deepEqual(statuses.map(p => p.text), ['Running checks', 'Working']);
});

test('hook_no_verdict and hook failure warnings reach the chat as notices', async () => {
  const sid = nextSid();
  const ws = makeWs();
  scriptedMessages = [init(sid),
    { type: 'system', subtype: 'informational', level: 'warning', tag: 'hook_no_verdict',
      content: "A hook didn't answer in time, so it didn't check this action.",
      hook_no_verdict: { hook_event: 'PreToolUse', tool_use_id: 't1', timed_out: true }, uuid: 'i1', session_id: sid },
    { type: 'system', subtype: 'informational', level: 'warning', tag: 'hook_callback_failed',
      content: 'PreToolUse: Hook callback cb failed: x. Its answer was treated as empty.', uuid: 'i2', session_id: sid },
    { type: 'result', subtype: 'success', is_error: false }];

  await sdk.queryClaudeSDK('hi', { sessionId: sid, cwd: tmpCwd }, ws);

  assert.equal(notices(ws.sent, 'hook_no_verdict').length, 1);
  assert.equal(notices(ws.sent, 'hook_no_verdict')[0].noticeReason, 'timed_out');
  const [shared] = notices(ws.sent, 'hook_failed');
  assert.ok(shared, 'generic line broadcast');
  assert.doesNotMatch(String(shared.content), /callback cb failed/, 'no server detail in the broadcast');
  const [detail] = notices(ws.ownerOnly, 'hook_failed');
  assert.match(String(detail?.content), /callback cb failed/, 'owner gets the detail');
  assert.equal(detail.audienceUserId, 1);
  assert.equal(ws.mirrored.length, 0, 'detail never mirrored');
});

test('owner-only frames are dropped when the socket is not the run owner', async () => {
  const sid = nextSid();
  const ws = makeWs(2);
  const soon = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  scriptedMessages = [init(sid),
    { type: 'system', subtype: 'informational', level: 'warning', tag: 'hook_callback_failed',
      content: 'PreToolUse: Hook callback cb failed: x.', uuid: 'i3', session_id: sid },
    { type: 'result', subtype: 'success', is_error: false, credential_expires_at: soon }];

  await sdk.queryClaudeSDK('hi', { sessionId: sid, cwd: tmpCwd }, ws);

  assert.equal(ws.ownerOnly.length, 0, 'nothing owner-only reached another user');
  assert.equal(notices(ws.sent, 'hook_failed').length, 1, 'the generic line still arrives');
});

test('session_writes_lost after the result reaches the chat as an error notice', async () => {
  const sid = nextSid();
  const ws = makeWs();
  scriptedMessages = [init(sid), { type: 'result', subtype: 'success', is_error: false },
    { type: 'system', subtype: 'session_writes_lost', error_code: 'EDQUOT', lost: ['transcript'],
      transcript_session_ids: [sid], uuid: 'l1', session_id: sid }];

  await sdk.queryClaudeSDK('hi', { sessionId: sid, cwd: tmpCwd }, ws);

  const [lost] = notices(ws.sent, 'session_writes_lost');
  assert.ok(lost, 'notice forwarded');
  assert.equal(lost.noticeLevel, 'error');
  assert.equal(lost.noticeReason, 'EDQUOT');
});

test('an ending sign-in warns only the run owner socket, never the mirrors', async () => {
  const sid = nextSid();
  const ws = makeWs();
  const soon = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  scriptedMessages = [init(sid), { type: 'result', subtype: 'success', is_error: false, credential_expires_at: soon }];

  await sdk.queryClaudeSDK('hi', { sessionId: sid, cwd: tmpCwd }, ws);

  assert.equal(notices(ws.sent, 'credential_expiring').length, 0, 'not broadcast or buffered');
  assert.equal(ws.mirrored.length, 0, 'no mirror copy');
  const [warn] = notices(ws.ownerOnly, 'credential_expiring');
  assert.ok(warn, 'owner warned');
  assert.equal(warn.credentialExpiresAt, soon);
  assert.equal(warn.audienceUserId, 1);
});
