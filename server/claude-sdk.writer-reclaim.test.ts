/**
 * B-1666 #4 — a run's writer may be reclaimed only by its owner's own socket.
 *
 * Registered through the production seams `addSession` / `removeSession` with a
 * REAL WebSocketWriter, so `reconnectSessionWriter` runs exactly as the
 * check-session-status handler calls it. A different member's socket is
 * refused (it keeps the masked stream through its mirror); the owner's page
 * refresh still reclaims; a socket without a user id fails closed.
 *
 * Runner: node:test with --experimental-test-module-mocks.
 */

import assert from 'node:assert/strict';
import test, { afterEach, mock } from 'node:test';

mock.module('@anthropic-ai/claude-agent-sdk', {
  namedExports: {
    query: () => ({
      async *[Symbol.asyncIterator]() { /* never invoked */ },
      interrupt: async () => {},
      supportedCommands: async () => [],
      supportedModels: async () => [],
    }),
    createSdkMcpServer: () => ({}),
    tool: () => ({}),
  },
});

type Socket = { userId: number | null; readyState: number; frames: string[]; send: (s: string) => void };

const sdk = (await import('./claude-sdk.js')) as unknown as {
  addSession: (sessionId: string, queryInstance: unknown, tempImagePaths?: string[],
    tempDir?: string | null, writer?: unknown) => void;
  removeSession: (sessionId: string) => void;
  reconnectSessionWriter: (sessionId: string, socket: unknown) => boolean;
};
const { WebSocketWriter, addSessionMirror, removeSessionMirrorsForSocket } =
  await import('./modules/websocket/services/websocket-writer.service.js');

// One id per test: removeSession opens a grace window that refuses any swap.
let sequence = 0;
let SID = '';
const OWNER = 7;
const MEMBER = 8;

function socket(userId: number | null, readyState = 1): Socket {
  const frames: string[] = [];
  return { userId, readyState, frames, send: (s: string) => { frames.push(s); } };
}

function arm() {
  sequence += 1;
  SID = `writer-reclaim-${sequence}`;
  const original = socket(OWNER, 3); // the owner's socket died: an orphaned writer
  const writer = new WebSocketWriter(original as never, OWNER);
  sdk.addSession(SID, { interrupt: async () => {} }, [], null, writer);
  return { writer, original };
}

const logs: string[] = [];
const originalLog = console.log;
console.log = (...args: unknown[]) => { logs.push(args.map(String).join(' ')); };

afterEach(() => {
  sdk.removeSession(SID);
  logs.length = 0;
});

test('another member cannot adopt the orphaned writer', () => {
  const { writer, original } = arm();
  const member = socket(MEMBER);

  assert.equal(sdk.reconnectSessionWriter(SID, member), false);
  assert.equal(writer.ws, original, 'the writer still holds the owner socket');
  assert.ok(logs.some((line) => line.includes('reason=different-user')));

  // The member still follows the run through its read-only mirror.
  addSessionMirror(SID, member as never);
  writer.send({ kind: 'text', role: 'assistant', sessionId: SID, content: 'still streaming' });
  assert.ok(member.frames.some((frame) => frame.includes('still streaming')));
  removeSessionMirrorsForSocket(member as never);
});

test("the owner's page refresh still reclaims the writer", () => {
  const { writer } = arm();
  const refreshed = socket(OWNER);

  assert.equal(sdk.reconnectSessionWriter(SID, refreshed), true);
  assert.equal(writer.ws, refreshed);
});

test('a socket without a user id fails closed', () => {
  const { writer, original } = arm();

  assert.equal(sdk.reconnectSessionWriter(SID, socket(null)), false);
  assert.equal(writer.ws, original);
  assert.ok(logs.some((line) => line.includes('reason=different-user')));
});

test.after(() => { console.log = originalLog; });
