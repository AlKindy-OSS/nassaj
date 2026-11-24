/**
 * claude-sdk.abort-turn-key.test.ts — T-2093 (ADR-TURN-SCOPED-CONTROL).
 *
 * A stop names the turn its sender saw (`expectedTurnKey` = the clientMsgId that
 * started the run). `abortClaudeSDKSession` compares it with the run's recorded
 * key BEFORE its first await, so:
 *   - a named session running ANOTHER turn is `staleTarget` (nothing interrupted);
 *   - an EMPTY id picks the run on this connection with that key, never merely
 *     the newest one (two runs on one tab socket);
 *   - an old client (no key) keeps the legacy behaviour.
 *
 * Sessions go through the exported production seam `addSession` (which builds
 * the per-socket index), as in claude-sdk.abort-crosskill.test.ts; only the SDK
 * query handle is a stand-in.
 *
 * Runner: node:test with --experimental-test-module-mocks.
 */

import assert from 'node:assert/strict';
import test, { afterEach, mock } from 'node:test';

mock.module('@anthropic-ai/claude-agent-sdk', {
  namedExports: {
    query: () => ({
      async *[Symbol.asyncIterator]() {
        // no messages
      },
      interrupt: async () => {},
      supportedCommands: async () => [],
      supportedModels: async () => [],
    }),
    createSdkMcpServer: () => ({}),
    tool: () => ({}),
  },
});

type AbortResult = { aborted: boolean; reason: string; sessionId: string | null; staleTarget?: boolean };

const sdk = (await import('./claude-sdk.js')) as unknown as {
  addSession: (...args: unknown[]) => void;
  removeSession: (sessionId: string) => void;
  abortClaudeSDKSession: (sessionId: string, rawWs?: unknown, expectedTurnKey?: string | null) => Promise<AbortResult>;
};

const FIRST_SID = '00000011-0000-4000-8000-000000000011';
const SECOND_SID = '00000012-0000-4000-8000-000000000012';
const rawSocket = { readyState: 1, send() {} };
const writer = { ws: rawSocket, isWebSocketWriter: true, send() {} };
const interrupted: string[] = [];

function handleFor(sessionId: string) {
  return { interrupt: async () => { interrupted.push(sessionId); } };
}

/** addSession's positional seam, with the run's turnKey as the last argument. */
function addRun(sessionId: string, turnKey: string | null): void {
  sdk.addSession(sessionId, handleFor(sessionId), [], null, writer, null, null, null, null, null, null, turnKey);
}

afterEach(() => {
  interrupted.length = 0;
  sdk.removeSession(FIRST_SID);
  sdk.removeSession(SECOND_SID);
});

test('a named session running another turn is stale: nothing is interrupted', async () => {
  addRun(FIRST_SID, 'turn-2');
  const result = await sdk.abortClaudeSDKSession(FIRST_SID, rawSocket, 'turn-1');
  assert.equal(result.aborted, false);
  assert.equal(result.staleTarget, true);
  assert.deepEqual(interrupted, []);
});

test('a named session running the named turn is interrupted', async () => {
  addRun(FIRST_SID, 'turn-1');
  const result = await sdk.abortClaudeSDKSession(FIRST_SID, rawSocket, 'turn-1');
  assert.equal(result.aborted, true);
  assert.deepEqual(interrupted, [FIRST_SID]);
});

test('the key comparison happens before the first await (same tick as the call)', () => {
  addRun(FIRST_SID, 'turn-2');
  const pending = sdk.abortClaudeSDKSession(FIRST_SID, rawSocket, 'turn-1');
  // Replace the run synchronously right after the call: a check deferred past an
  // await would now see the matching key and interrupt the new run.
  sdk.removeSession(FIRST_SID);
  addRun(FIRST_SID, 'turn-1');
  return pending.then((result) => {
    assert.equal(result.staleTarget, true);
    assert.deepEqual(interrupted, []);
  });
});

test('empty id with two runs on the connection: only the run with the key is interrupted', async () => {
  addRun(FIRST_SID, 'turn-a');
  addRun(SECOND_SID, 'turn-b'); // the NEWEST run on the socket
  const result = await sdk.abortClaudeSDKSession('', rawSocket, 'turn-a');
  assert.equal(result.aborted, true);
  assert.equal(result.sessionId, FIRST_SID);
  assert.deepEqual(interrupted, [FIRST_SID]);
});

test('empty id with a key no run on this connection carries: nothing is interrupted', async () => {
  addRun(FIRST_SID, 'turn-a');
  const result = await sdk.abortClaudeSDKSession('', rawSocket, 'turn-unknown');
  assert.equal(result.aborted, false);
  assert.equal(result.sessionId, null);
  assert.deepEqual(interrupted, []);
});

test('old client (no key): empty id still falls back to the newest run on the connection', async () => {
  addRun(FIRST_SID, 'turn-a');
  addRun(SECOND_SID, 'turn-b');
  const result = await sdk.abortClaudeSDKSession('', rawSocket);
  assert.equal(result.sessionId, SECOND_SID);
  assert.deepEqual(interrupted, [SECOND_SID]);
});

test('a run recorded without a key (e.g. /api/agent) keeps the legacy named stop', async () => {
  addRun(FIRST_SID, null);
  const result = await sdk.abortClaudeSDKSession(FIRST_SID, rawSocket, 'turn-1');
  assert.equal(result.aborted, true);
  assert.deepEqual(interrupted, [FIRST_SID]);
});
