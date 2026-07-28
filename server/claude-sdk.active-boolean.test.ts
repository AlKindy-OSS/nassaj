/**
 * claude-sdk.active-boolean.test.ts — ج1 step 1: `isClaudeSDKSessionActive` must
 * encode the truth as a BOOLEAN in every branch.
 *
 * THE DEFECT THIS PINS
 * --------------------
 * The body was `session && session.status === 'active'`, which returns the
 * session object's falsy value — `undefined` — for an unknown id. Every
 * truthiness consumer coped, but the one consumer that SERIALIZES the value (the
 * websocket `session-status` frame) shipped `isProcessing: undefined`, and
 * `JSON.stringify` DROPS undefined values: the client received a frame with no
 * `isProcessing` key at all. On a live log that is 415 undefined answers against
 * 202 true ones, i.e. the field was absent far more often than present, and the
 * client could not tell "idle" from "unknown field".
 *
 * WHY THESE ARE NOT SYNTHETIC FIXTURES
 * ------------------------------------
 * Nothing here is a hand-built stand-in for the session map. The sessions are
 * registered and torn down through the EXPORTED production seams `addSession` /
 * `removeSession` / `getSession` (documented in claude-sdk.js as exactly that:
 * "the real production paths — using them keeps the unit tests faithful"), and
 * the aborted-status case mutates `session.status = 'aborted'` exactly as
 * `abortClaudeSDKSession` does. Only the Agent SDK itself is mocked, because a
 * real child process is irrelevant to the encoding of the return value.
 *
 * Runner: node:test with --experimental-test-module-mocks.
 */

import assert from 'node:assert/strict';
import test, { mock, afterEach } from 'node:test';

// The SDK is never invoked here; the mock only lets claude-sdk.js's import graph
// (including vendor-delegate-mcp.js) instantiate without a real Claude install.
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

const sdk = (await import('./claude-sdk.js')) as unknown as {
  isClaudeSDKSessionActive: (sessionId: string) => boolean;
  addSession: (
    sessionId: string,
    queryInstance: unknown,
    tempImagePaths?: string[],
    tempDir?: string | null,
    writer?: unknown,
    runTag?: string | null,
    projectPath?: string | null,
    runToken?: string | null
  ) => void;
  removeSession: (sessionId: string, expectedRunToken?: string | null) => void;
  getSession: (sessionId: string) => { status: string; detached?: boolean } | undefined;
};

// Real-shaped ids: a claude session id is the SDK's uuid v4 (this one is copied
// from the live sessions table of this install).
const KNOWN_SID = '2048b532-3b2a-4e32-b57c-4af1a5a6f9e7';
const UNKNOWN_SID = '00000000-0000-4000-8000-000000000000';

/** Minimal stand-in for the SDK query handle addSession stores; never called. */
const queryInstance = { interrupt: async () => {} };

afterEach(() => {
  sdk.removeSession(KNOWN_SID);
});

test('unknown session id → strict false (never undefined)', () => {
  const result = sdk.isClaudeSDKSessionActive(UNKNOWN_SID);
  assert.strictEqual(result, false);
  assert.strictEqual(typeof result, 'boolean');
});

test('registered session (status=active) → strict true', () => {
  sdk.addSession(KNOWN_SID, queryInstance);
  const result = sdk.isClaudeSDKSessionActive(KNOWN_SID);
  assert.strictEqual(result, true);
  assert.strictEqual(typeof result, 'boolean');
});

test('registered but aborted (the status abortClaudeSDKSession writes) → strict false', () => {
  sdk.addSession(KNOWN_SID, queryInstance);
  const session = sdk.getSession(KNOWN_SID);
  assert.ok(session, 'production addSession seam registered the session');
  session.status = 'aborted';

  const result = sdk.isClaudeSDKSessionActive(KNOWN_SID);
  assert.strictEqual(result, false);
  assert.strictEqual(typeof result, 'boolean');
});

test('detached ghost keeps status=active → still reported active (display semantics)', () => {
  // ADR-042 (B-80c): a detached session is subtracted from the DRAIN count only
  // (getDrainBlockingClaudeSessions); claude-sdk.js states it "is still active
  // for display (UI / get-active-sessions / WS-DIAG)". This test pins that split
  // so a future change cannot silently make the REST/WS display answer diverge.
  sdk.addSession(KNOWN_SID, queryInstance);
  const session = sdk.getSession(KNOWN_SID);
  assert.ok(session);
  session.detached = true;

  assert.strictEqual(sdk.isClaudeSDKSessionActive(KNOWN_SID), true);
});

test('empty session id → strict false', () => {
  assert.strictEqual(sdk.isClaudeSDKSessionActive(''), false);
});

test('the serialized frame keeps the isProcessing key for an idle session', () => {
  // The actual regression: JSON.stringify drops undefined values, so the old
  // `undefined` return deleted the field from the session-status frame.
  const frame = {
    type: 'session-status',
    sessionId: UNKNOWN_SID,
    provider: 'claude',
    isProcessing: sdk.isClaudeSDKSessionActive(UNKNOWN_SID),
  };

  const wire = JSON.stringify(frame);
  assert.ok(wire.includes('"isProcessing":false'), `field dropped from the wire: ${wire}`);
  assert.strictEqual(
    Object.prototype.hasOwnProperty.call(JSON.parse(wire), 'isProcessing'),
    true
  );
});
