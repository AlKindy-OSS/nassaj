/**
 * ADR-219 P2 (qa م-4, round 2 #3a): resolveToolApproval records an answer to a
 * prompt ONLY when the prompt belongs to a relay delivery turn, and records a
 * stranger's (refused) answer with admitted:false. Drives the real registrar
 * and resolver; the record lands in the real audit_log of the isolated DB.
 */
import './shared/__tests__/stub-harness-binaries.js';
import assert from 'node:assert/strict';
import test, { before, mock } from 'node:test';

mock.module('@anthropic-ai/claude-agent-sdk', {
  namedExports: { query: () => { throw new Error('not used'); }, createSdkMcpServer: () => ({}), tool: () => ({}) },
});

const { getConnection, initializeDatabase, userDb } = await import('@/modules/database/index.js');
const sdk = (await import('./claude-sdk.js')) as unknown as Record<string, any>;

let OWNER = 0;
let STRANGER = 0;

before(async () => {
  assert.ok(process.env.DATABASE_PATH, 'use the isolated node test runner');
  await initializeDatabase();
  // Real members: audit rows reference users (a decision always comes from a signed-in member).
  OWNER = (userDb.createUser('prompt_owner', 'unused-hash', 'user') as { id: number }).id;
  STRANGER = (userDb.createUser('prompt_stranger', 'unused-hash', 'user') as { id: number }).id;
});

function decisions(sessionId: string): Array<Record<string, unknown>> {
  return (getConnection().prepare("SELECT user_id AS userId, metadata FROM audit_log WHERE action = 'peer_relay_prompt_decided'")
    .all() as Array<{ userId: number | null; metadata: string }>)
    .map((row) => ({ userId: row.userId, ...JSON.parse(row.metadata) }))
    .filter((row) => row.sessionId === sessionId);
}

function pending(requestId: string, sessionId: string) {
  return sdk.waitForToolApproval(requestId, {
    timeoutMs: 5_000, metadata: { _sessionId: sessionId, _ownerUserId: OWNER, _toolName: 'Write', _input: { file_path: 'x' } },
  });
}

test('an answer to a prompt of an ordinary (non-relay) turn is not recorded', async () => {
  const decision = pending('ord-1', 'ordinary-session');
  assert.equal(sdk.resolveToolApproval('ord-1', { allow: true, requesterUserId: OWNER, requesterAuthKind: 'session' }).resolved, true);
  await decision;
  assert.deepEqual(decisions('ordinary-session'), []);
});

test('in a relay delivery turn: a stranger is recorded admitted:false; the owner admitted:true with the kind', async () => {
  sdk.markPeerDeliverySessionForTests('relay-session', true);
  try {
    const decision = pending('relay-1', 'relay-session');
    assert.equal(sdk.resolveToolApproval('relay-1', { allow: true, requesterUserId: STRANGER, requesterAuthKind: 'session' }).resolved, false);
    assert.equal(sdk.resolveToolApproval('relay-1', { allow: true, requesterUserId: OWNER, requesterAuthKind: 'device_session' }).resolved, true);
    await decision;
    const rows = decisions('relay-session');
    assert.deepEqual(rows.map(({ userId, requestId, toolName, admitted, allow, requesterAuthKind, requesterIsOwner }) =>
      ({ userId, requestId, toolName, admitted, allow, requesterAuthKind, requesterIsOwner })), [
      { userId: STRANGER, requestId: 'relay-1', toolName: 'Write', admitted: false, allow: false, requesterAuthKind: 'session',
        requesterIsOwner: false },
      { userId: OWNER, requestId: 'relay-1', toolName: 'Write', admitted: true, allow: true, requesterAuthKind: 'device_session',
        requesterIsOwner: true },
    ]);
  } finally {
    sdk.markPeerDeliverySessionForTests('relay-session', false);
  }
});
