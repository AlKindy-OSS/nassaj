import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';

import {
  bindConsumedAgentSsePrincipal,
  consumeAgentSseTicket,
  getAgentSseTicketSnapshotForTests,
  mintAgentSseTicket,
  resetAgentSseTicketsForTests,
} from './agent-sse-ticket.service.js';

const TARGET = '/api/agent/';
const ACTOR = {
  role: 'user', authorizationGeneration: 3, authenticationCredentialId: 'api-key:11',
};

beforeEach(resetAgentSseTicketsForTests);

test('stores only a digest and never the raw SSE ticket', () => {
  const minted = mintAgentSseTicket({ userId: 7, ...ACTOR, path: TARGET, now: 1_000 });
  const snapshot = getAgentSseTicketSnapshotForTests();

  assert.equal(snapshot.length, 1);
  assert.match(snapshot[0].digest, /^[a-f0-9]{64}$/);
  assert.ok(!JSON.stringify(snapshot).includes(minted.ticket));
});

test('an SSE ticket is one-shot and rejects replay', () => {
  const minted = mintAgentSseTicket({ userId: 7, ...ACTOR, path: TARGET, now: 1_000 });
  assert.deepEqual(
    consumeAgentSseTicket(minted.ticket, { path: TARGET, userId: 7, now: 1_001 }),
    { ok: true, userId: 7, ...ACTOR },
  );
  assert.deepEqual(
    consumeAgentSseTicket(minted.ticket, { path: TARGET, userId: 7, now: 1_002 }),
    { ok: false, code: 'invalid' },
  );
});

test('a consumed ticket never adopts a newer API-key generation', () => {
  const minted = mintAgentSseTicket({ userId: 7, ...ACTOR, path: TARGET, now: 1_000 });
  const consumed = consumeAgentSseTicket(minted.ticket, { path: TARGET, now: 1_001 });
  const exact = {
    id: 7, role: ACTOR.role, authenticationKind: 'ck',
    authorizationGeneration: ACTOR.authorizationGeneration,
    authenticationCredentialId: ACTOR.authenticationCredentialId,
  };

  assert.deepEqual(bindConsumedAgentSsePrincipal(consumed, exact), exact);
  assert.equal(Object.isFrozen(bindConsumedAgentSsePrincipal(consumed)), true);
  assert.equal(bindConsumedAgentSsePrincipal(consumed, {
    ...exact, authorizationGeneration: ACTOR.authorizationGeneration + 2,
  }), null);
});

test('an expired SSE ticket is rejected', () => {
  const minted = mintAgentSseTicket({ userId: 7, ...ACTOR, path: TARGET, ttlMs: 10, now: 1_000 });
  assert.deepEqual(
    consumeAgentSseTicket(minted.ticket, { path: TARGET, userId: 7, now: 1_010 }),
    { ok: false, code: 'expired' },
  );
});

test('a ticket cannot be used as another authenticated user', () => {
  const minted = mintAgentSseTicket({ userId: 7, ...ACTOR, path: TARGET, now: 1_000 });
  assert.deepEqual(
    consumeAgentSseTicket(minted.ticket, { path: TARGET, userId: 8, now: 1_001 }),
    { ok: false, code: 'wrong_user' },
  );
});

test('a ticket is bound to the HTTP method and route', () => {
  const minted = mintAgentSseTicket({ userId: 7, ...ACTOR, path: TARGET, now: 1_000 });
  assert.deepEqual(
    consumeAgentSseTicket(minted.ticket, { path: '/api/agent/other', method: 'GET', now: 1_001 }),
    { ok: false, code: 'wrong_target' },
  );
});
