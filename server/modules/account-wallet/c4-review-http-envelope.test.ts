import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';

import Database from 'better-sqlite3';
import express from 'express';

import { AgentReviewRepository, applyAgentReviewSchema } from '../database/index.js';

import { c4ReviewInvocation, denyC4ReviewResponse, enrollC4ReviewResponse, matchC4ReviewRequest } from './c4-review-http-envelope.js';

const command = { sessionId: 's', source: 'workflow' as const, agentId: 'agent-1', resultGeneration: 'a'.repeat(64),
  action: 'start_review' as const, expectedRevision: 0, idempotencyKey: 'key-1' };
const endpoint = '/api/providers/sessions/s/agent-reviews/agent-1';
const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
type Scenario = 'pre_begin' | 'callback_rollback' | 'rollback_failed' | 'begin_failed' | 'commit_before' | 'commit_after' | 'committed' | 'mapping_failed' | 'replay';

async function transactionWire(t: TestContext, scenario: Scenario): Promise<{ body: unknown; receipts: number }> {
  const artifacts = path.join(ROOT, '.artifacts'); await fs.mkdir(artifacts, { recursive: true });
  const directory = await fs.mkdtemp(path.join(artifacts, 'c4-envelope-')); const db = new Database(path.join(directory, 'fixture.db'));
  db.transaction(() => applyAgentReviewSchema(db)).immediate();
  db.exec("CREATE TABLE session_participants(session_id TEXT,user_id INTEGER,role TEXT,attribution TEXT); INSERT INTO session_participants VALUES ('s',1,'owner','spawn')");
  db.prepare('INSERT INTO agent_review_results VALUES (?,?,?,?,?,?,?,?,?,?)').run('s', 'workflow', 'agent-1', command.resultGeneration,
    'b'.repeat(64), 1, 'c'.repeat(64), 'd'.repeat(64), 'e'.repeat(64), '2026-09-24T00:00:00.000Z');
  db.prepare("INSERT INTO agent_review_states VALUES (?,?,?,?,'awaiting_review',0,NULL,NULL,NULL)").run('s', 'workflow', 'agent-1', command.resultGeneration);
  db.prepare('INSERT INTO agent_review_current VALUES (?,?,?,?,?,?,0,?)').run('s', 'workflow', 'agent-1', command.resultGeneration, 'b'.repeat(64), 1, '2026-09-24T00:00:00.000Z');
  const repo = new AgentReviewRepository(db, { actorUserId: 1, assertCurrent: () => {
    if (scenario === 'callback_rollback' || scenario === 'rollback_failed') throw new Error('primary-secret');
    return true;
  } });
  if (scenario === 'replay') repo.transition(command);
  const execute = db.exec.bind(db); let commits = 0;
  t.mock.method(db, 'exec', (sql: string) => {
    if (sql === 'BEGIN IMMEDIATE' && scenario === 'begin_failed') throw Object.assign(new Error('busy-secret'), { code: 'SQLITE_BUSY' });
    if (sql === 'ROLLBACK' && scenario === 'rollback_failed') throw new Error('cleanup-secret');
    if (sql === 'COMMIT') {
      commits++;
      if (scenario === 'commit_before') throw new Error('commit-secret');
      if (scenario === 'commit_after') { execute(sql); throw new Error('commit-secret'); }
    }
    return execute(sql);
  });
  const app = express();
  app.patch(endpoint, (req, res) => {
    let current = true; const principal = Object.freeze({ userId: 1, authorizationGeneration: 1 });
    (req as unknown as { authenticatedPrincipal: object }).authenticatedPrincipal = principal;
    enrollC4ReviewResponse(req, res, { db, principal, currentIdentity: () => current, currentProject: () => true });
    try {
      if (scenario === 'pre_begin') throw new Error('preflight-secret');
      repo.transition(command, c4ReviewInvocation(req, res));
      if (scenario === 'mapping_failed') throw new Error('mapping-secret');
    } catch (error) {
      if (scenario === 'rollback_failed') assert.equal((error as Error).message, 'primary-secret');
    }
    current = false;
    // Legacy flags and handler effect claims have no power over the enrolled serializer.
    Object.assign(req, { identityDisclosureRejected: true, identityTransitionCommitted: true });
    res.locals.reviewCommitted = false;
    res.json({ error: { code: 'identity_changed', notStarted: true }, secret: 'payload-marker' });
  });
  const server = app.listen(0, '127.0.0.1'); await new Promise<void>(resolve => server.once('listening', resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}${endpoint}`, { method: 'PATCH' });
    assert.equal(response.status, 409); assert.equal(response.headers.get('cache-control'), 'no-store');
    const body = await response.json(); assert.equal(JSON.stringify(body).includes('secret'), false);
    if (scenario === 'callback_rollback' || scenario === 'rollback_failed') assert.equal(commits, 0);
    if (scenario !== 'pre_begin' && scenario !== 'begin_failed' && !scenario.includes('rollback')) assert.equal(commits, 1);
    const receipts = (db.prepare('SELECT COUNT(*) AS n FROM agent_review_receipts').get() as { n: number }).n;
    return { body, receipts };
  } finally {
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    t.mock.restoreAll(); if (db.inTransaction) execute('ROLLBACK'); db.close(); await fs.rm(directory, { recursive: true, force: true });
  }
}

for (const scenario of ['pre_begin', 'callback_rollback', 'rollback_failed', 'begin_failed', 'commit_before', 'commit_after', 'committed', 'mapping_failed', 'replay'] as const) {
  test(`C4-A17 owned transaction ${scenario} has exact final wire evidence`, async t => {
    const outcome = await transactionWire(t, scenario);
    const state = scenario === 'pre_begin' ? 'not_started'
      : ['callback_rollback', 'committed', 'mapping_failed', 'replay'].includes(scenario) ? 'settled' : 'outcome_unknown';
    assert.deepEqual(outcome.body, { error: { code: 'identity_changed', notStarted: scenario === 'pre_begin', effectState: state } });
    assert.equal(outcome.receipts, ['committed', 'mapping_failed', 'replay', 'commit_after'].includes(scenario) ? 1 : 0);
  });
}

test('canonical matcher rejects alternate spellings, method widening and malformed segments', () => {
  assert.deepEqual(matchC4ReviewRequest({ method: 'PATCH', originalUrl: endpoint }), { sessionId: 's', agentId: 'agent-1' });
  for (const originalUrl of [endpoint + '/', endpoint.replace('providers', 'Providers'), endpoint.replace('/s/', '/%73/'), endpoint.replace('/s/', '/%ff/')]) {
    assert.equal(matchC4ReviewRequest({ method: 'PATCH', originalUrl }), null);
  }
  assert.equal(matchC4ReviewRequest({ method: 'OPTIONS', originalUrl: endpoint }), null);
});

test('GET send/json suppress payloads, thrown freshness and principal replacement; project denial loses to identity', async () => {
  const db = new Database(':memory:'); const app = express();
  app.get('/api/providers/sessions/s/agent-reviews', (req, res) => {
    const principal = Object.freeze({ userId: 1 });
    (req as unknown as { authenticatedPrincipal: object }).authenticatedPrincipal = principal;
    let current = true;
    enrollC4ReviewResponse(req, res, { db, principal, currentIdentity: () => {
      if (req.query.mode === 'throw') throw new Error('secret'); return current;
    }, currentProject: () => false });
    assert.throws(() => c4ReviewInvocation({ ...req } as express.Request, res), /enrollment_required/);
    if (req.query.mode === 'replace') (req as unknown as { authenticatedPrincipal: object }).authenticatedPrincipal = { ...principal };
    if (req.query.mode !== 'project') current = false;
    if (req.query.mode === 'json') res.json({ secret: 'marker' });
    else if (req.query.mode === 'send') res.send('secret-marker');
    else denyC4ReviewResponse(req, res, 'project_access_changed');
  });
  const server = app.listen(0, '127.0.0.1'); await new Promise<void>(resolve => server.once('listening', resolve));
  try {
    const before = db.prepare('SELECT total_changes() AS n').get();
    for (const mode of ['json', 'send', 'throw', 'replace', 'project']) {
      const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/providers/sessions/s/agent-reviews?mode=${mode}`);
      assert.deepEqual(await response.json(), { error: { code: mode === 'project' ? 'project_access_changed' : 'identity_changed', notStarted: true, effectState: 'not_started' } });
    }
    assert.deepEqual(db.prepare('SELECT total_changes() AS n').get(), before);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); db.close(); }
});


test('opaque invocation rejects forged tags, GET mutation and cross-connection use before any BEGIN', async t => {
  const db = new Database(':memory:'); const other = new Database(':memory:');
  const repo = new AgentReviewRepository(db, { actorUserId: 1, assertCurrent: () => true });
  assert.throws(() => repo.transition(command, {} as never), /untrusted_provenance/);
  assert.throws(() => repo.transition(command, Object.freeze({ state: 'settled' }) as never), /untrusted_provenance/);
  const app = express();
  app.get('/api/providers/sessions/s/agent-reviews', (req, res) => {
    const principal = Object.freeze({ userId: 1 });
    (req as unknown as { authenticatedPrincipal: object }).authenticatedPrincipal = principal;
    enrollC4ReviewResponse(req, res, { db, principal, currentIdentity: () => false, currentProject: () => true });
    const invocation = c4ReviewInvocation(req, res);
    assert.throws(() => repo.transition(command, invocation), /untrusted_provenance/);
    assert.throws(() => new AgentReviewRepository(other, { actorUserId: 1, assertCurrent: () => true }).transition(command, invocation), /untrusted_provenance/);
    res.json({ secret: 'must-not-disclose' });
  });
  const server = app.listen(0, '127.0.0.1'); await new Promise<void>(resolve => server.once('listening', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); db.close(); other.close(); });
  const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/providers/sessions/s/agent-reviews`);
  assert.deepEqual(await response.json(), { error: { code: 'identity_changed', notStarted: true, effectState: 'not_started' } });
});

test('source inventory restricts enrollment/evidence producers and excludes C4 stream bypasses', async () => {
  const server = path.join(ROOT, 'server');
  const sites: Record<string, string[]> = {
    createReviewTransactionInvocation: ['modules/database/index.ts', 'modules/database/repositories/agent-review-transaction-evidence.ts', 'modules/account-wallet/c4-review-http-envelope.ts'],
    runReviewOwnedTransaction: ['modules/database/repositories/agent-review-transaction-evidence.ts', 'modules/database/repositories/agent-review-lifecycle.db.ts'],
    enrollC4ReviewResponse: ['modules/account-wallet/index.ts', 'modules/account-wallet/c4-review-http-envelope.ts', 'modules/providers/agent-review-auth-composition.ts'],
  };
  const files = (await fs.readdir(server, { recursive: true })).filter(file => /\.(?:ts|js)$/.test(file) && !file.includes('.test.') && !file.endsWith('.d.ts'));
  for (const file of files) {
    const source = await fs.readFile(path.join(server, file), 'utf8');
    for (const [symbol, allowed] of Object.entries(sites)) if (source.includes(symbol)) assert.ok(allowed.includes(file), `${symbol}: unauthorized site ${file}`);
    if (file.includes('agent-review') && !file.includes('/database/')) assert.doesNotMatch(source, /\.(?:sendFile|write|pipe|end)\s*\(/);
  }
});
