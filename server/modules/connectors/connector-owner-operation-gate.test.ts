import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import Database from 'better-sqlite3';
import type express from 'express';

import { authorizedOwnerOperation, consumeAuthorizedOwnerOperation, createConnectorOwnerOperationGate } from './connector-owner-operation-gate.js';
import { connectorPolicyV2ClaimsLegacyPaths, executeConnectorPolicyV2SynchronousWrite,
  initializeConnectorPolicyV2SubstrateOnly } from './connector-substrate-only.production.js';

test('fresh import keeps explicit legacy mode, but initialization failure permanently claims the fenced mode', () => {
  let writes = 0;
  assert.equal(connectorPolicyV2ClaimsLegacyPaths(), false);
  assert.equal(executeConnectorPolicyV2SynchronousWrite(() => ++writes), 1);
  const csrf = 'c'.repeat(64);
  const repository = {
    readOwnerAuthSession: () => ({ sessionId: 'session', csrfTokenHash: createHash('sha256').update(csrf).digest('hex'), authTime: 1, expiresAt: 90000 }),
    issueOwnerOperation: () => { writes++; return { sessionId: 'session', authTime: 1, expiresAt: 90000 }; },
    consumeOwnerOperation: () => { writes++; return true; },
  };
  const req = { user: { id: 7, role: 'owner' }, headers: { cookie: `nassaj_connector_recent_auth=${'a'.repeat(64)}` },
    get: (name: string) => name === 'origin' ? 'https://example.test' : csrf } as unknown as express.Request;
  const response = { locals: {}, status() { return this; }, json() { return this; } } as unknown as express.Response;
  const gate = createConnectorOwnerOperationGate({ repository, installationId: 'installation', canonicalOrigin: 'https://example.test', operation: 'upsert_byo', now: () => 10 });
  gate(req, response, () => {});
  const authority = authorizedOwnerOperation(response);
  const before = writes;
  const database = new Database(':memory:');
  try {
    // Fail before installationId resolution, the former false-legacy ambiguity.
    assert.equal(initializeConnectorPolicyV2SubstrateOnly(database, '/unused-authority').ready, false);
    assert.equal(connectorPolicyV2ClaimsLegacyPaths(), true);
    assert.throws(() => executeConnectorPolicyV2SynchronousWrite(() => ++writes), /lifecycle_write_unavailable/);
    assert.throws(() => gate(req, response, () => {}), /lifecycle_write_unavailable/);
    assert.throws(() => consumeAuthorizedOwnerOperation(authority, 'upsert_byo', {
      repository, installationId: 'installation', now: () => 10,
    }), /lifecycle_write_unavailable/);
    assert.equal(writes, before);
    // Authentication/Origin/CSRF still reject before requesting any write authority.
    let rejected = 0;
    const deniedResponse = { locals: {}, status: (status: number) => { assert.equal(status, 403); rejected++; return { json() {} }; } } as unknown as express.Response;
    gate({ ...req, get: () => 'wrong-origin' } as unknown as express.Request, deniedResponse, () => assert.fail('must not admit'));
    gate({ ...req, get: (name: string) => name === 'origin' ? 'https://example.test' : 'wrong-csrf' } as unknown as express.Request, deniedResponse, () => assert.fail('must not admit'));
    assert.equal(rejected, 2);
    assert.equal(writes, before);
  } finally { database.close(); }
});
