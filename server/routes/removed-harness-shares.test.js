/**
 * ADR-229, stage S0 (acceptance first): share links of a conversation that
 * belongs to a removed harness (kimi, qwen, hermes).
 *
 *   - A valid link answers 410 `provider_removed` — on the live guest routes
 *     (share-view.js) and on the legacy snapshot reader (session-shares.js) —
 *     and only AFTER the token verified: no transcript, no projection read.
 *   - A wrong token answers exactly what a wrong token answers today for any
 *     share, so the 410 never discloses that a hidden share exists.
 *   - No new link can be created for such a conversation.
 *   - A cursor conversation keeps sharing normally.
 *
 * Tests marked `[guard]` pass today and must keep passing; the others fail
 * today because the hidden conversation is still served or shared.
 *
 * Harness: the same in-memory share table and injected policy as
 * share-view.test.js and session-shares.test.js.
 *
 * Runner:
 *   TMPDIR=/var/tmp bash scripts/run-without-core.sh node scripts/run-isolated-node-tests.mjs server \
 *     server/routes/removed-harness-shares.test.js
 */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import test, { before } from 'node:test';
import { gzipSync } from 'node:zlib';

import Database from 'better-sqlite3';
import express from 'express';
import jwt from 'jsonwebtoken';

import { initializeDatabase } from '../modules/database/index.js';
import { createSessionSharesStore, migrateSessionShares } from '../modules/database/session-shares.js';
import { createDocumentShareVerifier } from '../services/document-share-auth.js';
import { createShareId, createShareToken, hashShareToken } from '../services/share-capability.js';

import { createSessionShareManagementMount, createSessionShareManagementRouter, createSessionSharePublicHandler } from './session-shares.js';
import { createShareViewHandler } from './share-view.js';

const ORIGIN = 'https://nassaj.example';
const SECRET = 'synthetic-test-secret-adr229-shares-only-123456789';
const DAY = 24 * 60 * 60 * 1000;
const OWNER = 3;
const HIDDEN = ['kimi', 'qwen', 'hermes'];
const PAGE = { v: 2, revision: 'r'.repeat(43), running: false, stale: false, moreBefore: false, moreAfter: false,
  retryAfterMs: 3000, messages: [] };

// The management verifier's SSO attestation check reads the (unconfigured) SSO state.
before(async () => { await initializeDatabase(); });

const sessionIdOf = (provider) => `adr229-${provider}`;

function createWorld() {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE projects (project_id TEXT PRIMARY KEY, project_path TEXT, isArchived INTEGER)');
  db.prepare('INSERT INTO projects VALUES (?,?,0)').run('p1', '/work/p1');
  migrateSessionShares(db);
  const sessions = new Map();
  for (const provider of [...HIDDEN, 'cursor', 'claude']) {
    const id = sessionIdOf(provider);
    sessions.set(id, { session_id: id, project_path: '/work/p1', provider, custom_name: `${provider} plan` });
  }
  const users = new Map([[OWNER, { id: OWNER, username: 'sara', role: 'user', status: 'active', password_changed_at: 0,
    authorization_generation: 1 }]]);
  const world = { db, users, sessions, store: createSessionSharesStore(db) };
  world.policy = {
    getSession: (id) => sessions.get(id) ?? null,
    resolveOwner: (id) => (sessions.has(id) ? OWNER : null),
    findProject: (projectPath) => (projectPath === '/work/p1' ? { project_id: 'p1', isArchived: false } : null),
    getActiveUser: (id) => users.get(id) ?? null,
    getUserName: (id) => users.get(id)?.username ?? null,
    isSessionReadable: (sessionId, _path, userId) => sessions.has(sessionId) && userId === OWNER,
  };
  return world;
}

/** Inserts a live or legacy snapshot share row for `sessionId`. */
function seed(world, sessionId, mode = 'live') {
  const id = createShareId();
  const token = createShareToken();
  const now = Date.now();
  const row = { id, session_id: sessionId, project_id: 'p1', owner_user_id: OWNER, token_hash: hashShareToken(token),
    created_by: OWNER, created_at: new Date(now).toISOString(), expires_at: new Date(now + 7 * DAY).toISOString() };
  if (mode === 'live') {
    assert.equal(world.store.insertLiveWithinCaps({ ...row, ref_key: randomBytes(32) }), true);
  } else {
    const json = JSON.stringify({ v: 1, title: 'Plan', providerLabel: 'Assistant', toolCount: 0,
      messages: [{ role: 'user', author: 'owner', parts: [{ t: 'text', text: 'hidden transcript text' }] }] });
    assert.equal(world.store.insertWithinCaps({ ...row, snapshot: gzipSync(json), snapshot_sha256: 'a'.repeat(64),
      up_to_message_id: 'm1', message_count: 1, redaction_counts: '{}' }), true);
  }
  return { id, token };
}

async function fixture(t) {
  const world = createWorld();
  const projectionCalls = [];
  const projection = {
    readMessages: async (request) => { projectionCalls.push(request); return PAGE; },
    resolveAttachment: async (request) => { projectionCalls.push(request); return null; },
  };
  const app = express();
  app.use(createShareViewHandler({ getStore: () => world.store, policy: world.policy, publicOrigin: ORIGIN, projection,
    loadAttachment: async () => null, home: () => '/home/operator' }));
  app.use(createSessionSharePublicHandler({ getStore: () => world.store, policy: world.policy, publicOrigin: ORIGIN }));
  const management = createSessionShareManagementRouter({ getStore: () => world.store, policy: world.policy,
    verifyUser: createDocumentShareVerifier({ getUserById: (id) => world.users.get(id) }, SECRET), publicOrigin: ORIGIN,
    deviceCookieName: '__Host-nassaj_device', deviceCookiesEnabled: () => false });
  app.use('/api', createSessionShareManagementMount(management));
  app.use((_req, res) => res.status(418).json({ fellThrough: true }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    world.db.close();
  });
  let ip = 0;
  /** Each guest call comes from its own address, so a wrong token never trips the per-IP failure bucket. */
  const guest = async (urlPath, token) => {
    ip += 1;
    const response = await fetch(`${base}${urlPath}`, {
      headers: { 'X-Share-Token': token, 'cf-connecting-ip': `198.51.100.${ip}`, 'Accept-Encoding': 'identity' } });
    return { status: response.status, text: await response.text() };
  };
  const createLink = async (sessionId) => {
    const authorization = `Bearer ${jwt.sign({ userId: OWNER, pwd_iat: 0, auth_gen: 1 }, SECRET, { expiresIn: '1h' })}`;
    const response = await fetch(`${base}/api/sessions/${sessionId}/shares`, { method: 'POST',
      headers: { Authorization: authorization, 'Content-Type': 'application/json' }, body: '{}' });
    return { status: response.status, text: await response.text() };
  };
  return { world, projectionCalls, guest, createLink };
}

const wrongToken = () => createShareToken();
const errorCode = (text) => { try { return JSON.parse(text)?.error?.code; } catch { return undefined; } };

function assertProviderRemoved(response, label) {
  assert.equal(response.status, 410, `${label}: 410, got ${response.status} ${response.text}`);
  assert.equal(errorCode(response.text), 'provider_removed', `${label}: ${response.text}`);
  assert.equal(response.text.includes('hidden transcript text'), false, `${label}: no transcript served`);
}

for (const provider of HIDDEN) {
  test(`${provider}: a valid live link answers 410 provider_removed on meta and messages, without a projection read`,
    async (t) => {
      const f = await fixture(t);
      const { id, token } = seed(f.world, sessionIdOf(provider));
      assertProviderRemoved(await f.guest(`/api/share-view/${id}/meta`, token), 'meta');
      assertProviderRemoved(await f.guest(`/api/share-view/${id}/messages`, token), 'messages');
      assert.equal(f.projectionCalls.length, 0, 'the transcript projection is never read');
    });

  test(`${provider}: a valid legacy snapshot link answers 410 provider_removed`, async (t) => {
    const f = await fixture(t);
    const { id, token } = seed(f.world, sessionIdOf(provider), 'snapshot');
    assertProviderRemoved(await f.guest(`/api/session-shares/${id}`, token), 'snapshot');
  });

  test(`[guard] ${provider}: a wrong token answers exactly what any wrong token answers (no existence leak)`,
    async (t) => {
      const f = await fixture(t);
      const hiddenLive = seed(f.world, sessionIdOf(provider));
      const controlLive = seed(f.world, sessionIdOf('claude'));
      const hiddenSnapshot = seed(f.world, sessionIdOf(provider), 'snapshot');
      const controlSnapshot = seed(f.world, sessionIdOf('claude'), 'snapshot');
      for (const endpoint of ['meta', 'messages']) {
        const hidden = await f.guest(`/api/share-view/${hiddenLive.id}/${endpoint}`, wrongToken());
        const control = await f.guest(`/api/share-view/${controlLive.id}/${endpoint}`, wrongToken());
        assert.deepEqual(hidden, control, `live ${endpoint}`);
        assert.notEqual(hidden.status, 410);
      }
      const hidden = await f.guest(`/api/session-shares/${hiddenSnapshot.id}`, wrongToken());
      const control = await f.guest(`/api/session-shares/${controlSnapshot.id}`, wrongToken());
      assert.deepEqual(hidden, control, 'snapshot');
      assert.notEqual(hidden.status, 410);
    });

  test(`${provider}: a new share link cannot be created`, async (t) => {
    const f = await fixture(t);
    const response = await f.createLink(sessionIdOf(provider));
    assert.notEqual(response.status, 201, `refused, got ${response.status} ${response.text}`);
    assert.equal(errorCode(response.text), 'provider_removed', response.text);
    assert.equal(f.world.store.countActiveLive(sessionIdOf(provider), new Date().toISOString()), 0, 'no row written');
  });
}

test('[guard] a cursor conversation still shares: link created, meta served', async (t) => {
  const f = await fixture(t);
  const created = await f.createLink(sessionIdOf('cursor'));
  assert.equal(created.status, 201, created.text);
  const { id, token } = seed(f.world, sessionIdOf('cursor'));
  const meta = await f.guest(`/api/share-view/${id}/meta`, token);
  assert.equal(meta.status, 200, meta.text);
});
