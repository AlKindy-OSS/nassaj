/**
 * ADR-173 P8 (browser acceptance) bugs B1-B3, against the production
 * `queryClaudeSDK` with a real WebSocketWriter and real session mirrors; only the
 * Agent SDK is mocked (it records the prompt message the CLI would write).
 *
 *   B1: `user_turn.messageUuid` is the uuid of the prompt the CLI writes into the
 *       transcript, so a viewer replaces the live bubble with the synced row.
 *   B2: a send refused as session_busy answers the sender alone.
 *   B3: the creator's own turn is announced too, once another viewer is present.
 */
import './shared/__tests__/stub-harness-binaries.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test, { afterEach, beforeEach, mock } from 'node:test';

type Frame = Record<string, unknown>;

const prompts: Frame[] = [];
let scripted: Frame[] = [];
let held: Promise<void> = Promise.resolve();
let release: () => void = () => {};

mock.module('@anthropic-ai/claude-agent-sdk', {
  namedExports: {
    query: ({ prompt }: { prompt: AsyncIterable<Frame> }) => {
      const messages = scripted;
      const wait = held;
      // The CLI reads the first prompt message right away and writes it with its uuid.
      const first = prompt[Symbol.asyncIterator]().next().then(({ value }) => { if (value) prompts.push(value); });
      return {
        async *[Symbol.asyncIterator]() {
          await first;
          for (const message of messages) yield message;
          await wait;
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
  const db = await import('@/modules/database/index.js');
  await db.initializeDatabase();
  for (const [id, name] of [[1, 'creator-1'], [2, 'member-2']] as const) {
    if (!db.userDb.getUserById(id)) db.userDb.createUser(name, 'hash', 'user');
  }
}
const sdk = (await import('./claude-sdk.js')) as unknown as {
  queryClaudeSDK: (command: string, options: Frame, ws: unknown) => Promise<unknown>;
};
const { WebSocketWriter, addSessionMirror, removeSessionMirrorsForSocket } =
  await import('./modules/websocket/services/websocket-writer.service.js');

type FakeSocket = { readyState: number; userId: number; frames: Frame[]; send(frame: string): void };
const socket = (userId: number): FakeSocket => ({
  readyState: 1, userId, frames: [], send(frame) { this.frames.push(JSON.parse(frame) as Frame); },
});
const ofKind = (s: FakeSocket, kind: string) => s.frames.filter((f) => f.kind === kind);

let tmp = '';
let counter = 0;
const nextSid = () => `p8-viewer-${++counter}-0000-4000-8000-000000000000`;
const opened: FakeSocket[] = [];

function viewer(sessionId: string, userId: number): FakeSocket {
  const s = socket(userId);
  addSessionMirror(sessionId, s as never);
  opened.push(s);
  return s;
}

beforeEach(() => {
  prompts.length = 0;
  scripted = [];
  held = Promise.resolve();
  release = () => {};
  tmp = fs.mkdtempSync(path.join('/var/tmp', 'p8-viewer-'));
  process.env.CLAUDE_CONFIG_DIR = path.join(tmp, 'cfg');
  process.env.SESSION_REGISTRY_claude = '1';
});

afterEach(() => {
  release();
  for (const s of opened.splice(0)) removeSessionMirrorsForSocket(s as never);
  delete process.env.CLAUDE_CONFIG_DIR;
  delete process.env.SESSION_REGISTRY_claude;
  delete process.env.NASSAJ_SHARED_SESSION_WRITING;
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('B3+B1: the creator\'s own turn reaches the other viewer as user_turn with the transcript uuid', async () => {
  const sid = nextSid();
  const creator = socket(1);
  const member = viewer(sid, 2);
  scripted = [{ type: 'system', subtype: 'init', session_id: sid }];
  await sdk.queryClaudeSDK('creator asks', { sessionId: sid, cwd: tmp, clientMsgId: 'cmid-creator-1' },
    new WebSocketWriter(creator as never, 1));

  const turns = ofKind(member, 'user_turn');
  assert.equal(turns.length, 1, `member frames: ${JSON.stringify(member.frames.map((f) => f.kind))}`);
  assert.equal(turns[0].authorUserId, 1);
  assert.equal(turns[0].authorName, 'creator-1');
  assert.equal(turns[0].clientMsgId, 'cmid-creator-1');
  assert.equal(turns[0].content, 'creator asks');
  assert.equal(prompts.length, 1);
  assert.match(String(prompts[0].uuid), /^[0-9a-f-]{36}$/u, 'the prompt carries a native uuid');
  assert.equal(turns[0].messageUuid, prompts[0].uuid, 'B1: same id as the transcript row');
});

test('B3: a conversation nobody else watches gets no user_turn', async () => {
  const sid = nextSid();
  const creator = socket(1);
  addSessionMirror(sid, creator as never); // the sender's own view is not another viewer
  opened.push(creator);
  scripted = [{ type: 'system', subtype: 'init', session_id: sid }];
  await sdk.queryClaudeSDK('alone', { sessionId: sid, cwd: tmp }, new WebSocketWriter(creator as never, 1));
  assert.equal(ofKind(creator, 'user_turn').length, 0);
});

test('B3: flag 0 keeps today\'s behaviour (no user_turn for the creator\'s turn)', async () => {
  process.env.NASSAJ_SHARED_SESSION_WRITING = '0';
  const sid = nextSid();
  const member = viewer(sid, 2);
  scripted = [{ type: 'system', subtype: 'init', session_id: sid }];
  await sdk.queryClaudeSDK('flag off', { sessionId: sid, cwd: tmp }, new WebSocketWriter(socket(1) as never, 1));
  assert.equal(ofKind(member, 'user_turn').length, 0);
});

test('B2: the sender\'s session_busy never reaches the other viewer', { timeout: 20000 }, async () => {
  const sid = nextSid();
  const creator = socket(1);
  const member = viewer(sid, 2);
  held = new Promise<void>((resolve) => { release = resolve; });
  scripted = [{ type: 'system', subtype: 'init', session_id: sid }];
  const running = sdk.queryClaudeSDK('first', { sessionId: sid, cwd: tmp }, new WebSocketWriter(creator as never, 1));
  await new Promise((resolve) => setTimeout(resolve, 50));
  held = Promise.resolve();
  scripted = [];
  try {
    // The creator's second tab sends while his own turn runs: the older SEC-DUP-RUN refusal.
    const secondTab = socket(1);
    await sdk.queryClaudeSDK('second', { sessionId: sid, cwd: tmp, clientMsgId: 'cmid-busy' },
      new WebSocketWriter(secondTab as never, 1));
    // The member sends too: the ADR-173 launch-claim refusal.
    const memberSend = socket(2);
    await sdk.queryClaudeSDK('member', { sessionId: sid, cwd: tmp, clientMsgId: 'cmid-member' },
      new WebSocketWriter(memberSend as never, 2));

    assert.equal(secondTab.frames.filter((f) => f.code === 'session_busy').length, 1, 'the refusal happened');
    assert.equal(memberSend.frames.filter((f) => f.code === 'session_busy').length, 1, 'the refusal happened');
    assert.deepEqual(member.frames.filter((f) => f.code === 'session_busy'), [], 'the viewer reads no foreign refusal');
    assert.deepEqual(creator.frames.filter((f) => f.code === 'session_busy'), [], 'the running starter neither');
  } finally {
    release();
    await running.catch(() => undefined);
  }
});
