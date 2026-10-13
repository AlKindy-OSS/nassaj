import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import http from 'node:http';
import test, { before } from 'node:test';
import { gzipSync } from 'node:zlib';

import cors from 'cors';
import Database from 'better-sqlite3';
import express from 'express';
import jwt from 'jsonwebtoken';

import {
  SESSION_SHARE_CAPS, createSessionSharesStore, migrateSessionShares, onSessionSharesRevoked, revokeSharesByProject,
  revokeSharesBySession, revokeSharesByUser,
} from '../modules/database/session-shares.js';
import { initializeDatabase } from '../modules/database/index.js';
import { createDocumentShareVerifier } from '../services/document-share-auth.js';
import { createShareId, createShareToken, hashShareToken } from '../services/share-capability.js';
import { evaluateLiveness, evaluateReadLiveness } from '../services/session-share-policy.js';
import { startSessionShareSweeper, sweepSessionShares } from '../services/session-share-sweeper.js';

import {
  createSessionShareManagementMount, createSessionShareManagementRouter, createSessionSharePublicHandler,
  isSessionShareManagementPath,
} from './session-shares.js';

const secret = 'synthetic-test-secret-session-shares-only-123456789';
const ORIGIN = 'https://nassaj.example';
const DAY = 24 * 60 * 60 * 1000;

// The verifier's SSO attestation check reads the (unconfigured) SSO state.
before(async () => { await initializeDatabase(); });

/** A legacy (T-1970) snapshot blob: what existing snapshot rows hold until retirement. */
function snapshotBlob(ids = ['m1', 'm2']) {
  const snapshot = { v: 1, title: 'Plan', providerLabel: 'Assistant', toolCount: 0,
    messages: ids.map((id) => ({ role: 'user', author: 'owner', parts: [{ t: 'text', text: id }] })) };
  const json = JSON.stringify(snapshot);
  return { blob: gzipSync(json), sha256: createHash('sha256').update(json).digest('hex') };
}

function createWorld() {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE projects (project_id TEXT PRIMARY KEY, project_path TEXT, isArchived INTEGER)');
  db.prepare('INSERT INTO projects VALUES (?,?,0)').run('p1', '/work/p1');
  migrateSessionShares(db);
  const users = new Map([
    [1, { id: 1, username: 'owner', role: 'owner', status: 'active', password_changed_at: 0, authorization_generation: 1 }],
    [2, { id: 2, username: 'admin', role: 'admin', status: 'active', password_changed_at: 0, authorization_generation: 1 }],
    [3, { id: 3, username: 'sara', role: 'user', status: 'active', password_changed_at: 0, authorization_generation: 1 }],
    [4, { id: 4, username: 'member', role: 'user', status: 'active', password_changed_at: 0, authorization_generation: 1 }],
    [5, { id: 5, username: 'other', role: 'user', status: 'active', password_changed_at: 0, authorization_generation: 1 }],
  ]);
  const world = {
    db, users, store: createSessionSharesStore(db),
    sessions: new Map([['s1', { session_id: 's1', project_path: '/work/p1', provider: 'claude', custom_name: 'Plan' }],
      ['s-orphan', { session_id: 's-orphan', project_path: '/nowhere', provider: 'claude' }]]),
    owners: new Map([['s1', 3], ['s-orphan', 3]]),
    readable: new Set(['s1:3', 's1:4', 's-orphan:3']),
  };
  world.policy = {
    getSession: (id) => world.sessions.get(id) ?? null,
    resolveOwner: (id) => world.owners.get(id) ?? null,
    findProject: (projectPath) => {
      const row = db.prepare('SELECT project_id, isArchived FROM projects WHERE project_path = ?').get(projectPath);
      return row ? { project_id: row.project_id, isArchived: Boolean(row.isArchived) } : null;
    },
    getActiveUser: (id) => { const user = users.get(id); return user && user.status === 'active' ? user : null; },
    getUserName: (id) => users.get(id)?.username ?? null,
    isSessionReadable: (sessionId, _path, userId) => world.readable.has(`${sessionId}:${userId}`),
  };
  return world;
}

async function fixture(t, options = {}) {
  const world = createWorld();
  const audit = [];
  const dropped = [];
  const verifyUser = options.verifyUser ?? createDocumentShareVerifier({ getUserById: (id) => world.users.get(id) }, secret);
  const clock = { now: options.now ?? Date.now() };
  const app = express();
  app.use(createSessionSharePublicHandler({ getStore: () => world.store, policy: world.policy,
    publicOrigin: 'publicOrigin' in options ? options.publicOrigin : ORIGIN, now: () => clock.now,
    recordView: (id, count, at) => world.store.addViews(id, count, at) }));
  app.use(cors({ origin: (_origin, callback) => callback(null, false) }));
  if (options.identity) app.use(options.identity);
  // Through the same mount server/index.js uses, so every route below proves the mount admits it.
  const management = createSessionShareManagementRouter({ getStore: () => world.store, policy: world.policy, verifyUser,
    audit: (...args) => audit.push(args), dropProjection: (sessionId) => dropped.push(sessionId),
    publicOrigin: 'publicOrigin' in options ? options.publicOrigin : ORIGIN,
    now: () => clock.now, deviceCookieName: '__Host-nassaj_device', deviceCookiesEnabled: () => options.deviceCookies === true });
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
  const bearer = (id, claims = {}) => ({ Authorization: `Bearer ${jwt.sign({ userId: id, pwd_iat: 0, auth_gen: 1, ...claims }, secret, { expiresIn: '1h' })}` });
  const post = (url, userId, body, headers = {}) => fetch(base + url, { method: 'POST',
    headers: { ...(userId ? bearer(userId) : {}), 'Content-Type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body) });
  const preview = async (userId = 3, sessionId = 's1', body = {}) => {
    const response = await post(`/api/sessions/${sessionId}/shares/preview`, userId, body);
    return { status: response.status, body: await response.json() };
  };
  /** Live link through the management route (ADR-205). */
  const createLive = async (userId = 3, body = {}, sessionId = 's1') => {
    const response = await post(`/api/sessions/${sessionId}/shares`, userId, body);
    return { status: response.status, body: await response.json().catch(() => null) };
  };
  /**
   * A legacy snapshot row as T-1970 wrote it (new snapshot links can no longer
   * be created; existing rows stay readable until they expire).
   */
  const create = async (createdBy = 3, { expiryMs = 30 * DAY, sessionId = 's1' } = {}) => {
    const token = createShareToken();
    const id = createShareId();
    const { blob, sha256 } = snapshotBlob();
    const nowMs = clock.now;
    assert.equal(world.store.insertWithinCaps({ id, session_id: sessionId, project_id: 'p1', owner_user_id: 3,
      token_hash: hashShareToken(token), created_by: createdBy, created_at: new Date(nowMs).toISOString(),
      expires_at: new Date(nowMs + expiryMs).toISOString(), snapshot: blob, snapshot_sha256: sha256, up_to_message_id: 'm2',
      message_count: 2, redaction_counts: '{}' }, new Date(nowMs).toISOString()), true);
    return { status: 201, body: { share: { id }, shareUrl: `${ORIGIN}/s/${id}#token=${token}` } };
  };
  const read = (id, token, headers = {}) => fetch(`${base}/api/session-shares/${id}`, {
    headers: { ...(token ? { 'X-Share-Token': token } : {}), ...headers } });
  const tokenOf = (body) => body.shareUrl.split('#token=')[1];
  return { ...world, base, audit, dropped, clock, bearer, post, preview, create, createLive, read, tokenOf };
}

test('M9 permission matrix: only the strict session owner creates a live link', async (t) => {
  const f = await fixture(t);
  const owner = await f.createLive(3);
  assert.equal(owner.status, 201, JSON.stringify(owner.body));
  assert.match(owner.body.shareUrl, /^https:\/\/nassaj\.example\/s\/[a-f0-9]{32}#token=[A-Za-z0-9_-]{43}$/);
  for (const [userId, name] of [[1, 'platform owner'], [2, 'admin'], [4, 'writer member'], [5, 'outsider']]) {
    const refused = await f.createLive(userId);
    assert.equal(refused.status, 403, name);
    assert.equal(refused.body.error.code, 'OWNER_ONLY', name);
  }
  assert.equal((await f.post('/api/sessions/s1/shares', null, {})).status, 401);
  const stale = await f.post('/api/sessions/s1/shares', null, {}, f.bearer(3, { auth_gen: 0 }));
  assert.equal(stale.status, 401, 'stale authorization generation');
  assert.equal((await f.createLive(3, {}, 'nope')).status, 404);
  const orphan = await f.createLive(3, {}, 's-orphan');
  assert.equal(orphan.status, 422);
  assert.equal(orphan.body.error.code, 'SESSION_PROJECT_UNREGISTERED');
  f.readable.delete('s1:3');
  assert.equal((await f.createLive(3)).status, 403, 'an owner who cannot read the session cannot share it');
  assert.equal(JSON.stringify(f.audit).includes(f.tokenOf(owner.body)), false, 'token never audited');
  assert.deepEqual(f.audit.find(([action]) => action === 'session_share_created')[2],
    { shareId: owner.body.share.id, sessionId: 's1', expiry: '7d', mode: 'live' });
});

test('without the bridge a device cookie, platform principal or ambient identity never authenticates', async (t) => {
  const f = await fixture(t, { deviceCookies: true, identity: (req, _res, next) => {
    req.user = { id: 1, role: 'owner', authenticationKind: 'platform_unverified' };
    next();
  } });
  const cookieOnly = await f.post('/api/sessions/s1/shares/preview', null, {}, { Cookie: '__Host-nassaj_device=abc' });
  assert.equal(cookieOnly.status, 401, 'device cookie without Bearer (MULTI_ACCOUNT_SWITCHING)');
  const both = await f.post('/api/sessions/s1/shares/preview', 3, {}, { Cookie: '__Host-nassaj_device=abc' });
  assert.equal(both.status, 400);
  assert.equal((await f.post('/api/sessions/s1/shares/preview', null, {})).status, 401,
    'IS_PLATFORM-style req.user without Bearer is ignored');
  const g = await fixture(t, { verifyUser: () => ({ id: 1, role: 'owner', authenticationKind: 'platform_unverified' }) });
  assert.equal((await g.post('/api/sessions/s1/shares/preview', 1, {})).status, 401);
});

test('a bridged device identity authenticates only while current and not forced to rotate', async (t) => {
  const state = { current: true, principal: true, mustChange: 0 };
  const f = await fixture(t, { deviceCookies: true, identity: (req, _res, next) => {
    req.user = { id: 3, role: 'user', authenticationKind: 'device_session', must_change_password: state.mustChange };
    if (state.principal) req.devicePrincipal = { deviceSessionId: 'd', slotId: 's', generation: 1, userId: 3 };
    req.assertCurrentIdentity = () => state.current;
    next();
  } });
  const mine = () => fetch(`${f.base}/api/session-shares/mine`);
  assert.equal((await mine()).status, 200, 'the device user resolved by authenticateToken is accepted');
  state.current = false;
  assert.equal((await mine()).status, 401, 'a revoked or switched device is refused');
  state.current = true;
  state.mustChange = 1;
  assert.equal((await mine()).status, 401, 'forced password rotation is refused like the Bearer verifier');
  state.mustChange = 0;
  state.principal = false;
  assert.equal((await mine()).status, 401, 'a device kind without the server-resolved principal is not an identity');
});

test('live create: expiry keys (7d default), strict body, placeholders, no secret fields', async (t) => {
  const now = Date.parse('2026-10-04T00:00:00.000Z');
  const f = await fixture(t, { now });
  const status = async (body) => (await f.post('/api/sessions/s1/shares', 3, body)).status;
  for (const bad of [{ expiry: 'never' }, { expiry: '2027-01-01T00:00:00Z' }, { expiresAt: '2027-01-01T00:00:00Z' },
    { expiry: 7 }, { expiry: '7d', extra: 1 }, { upToMessageId: 'm2' }]) {
    assert.equal(await status(bad), 400, JSON.stringify(bad));
  }
  const textBody = await fetch(`${f.base}/api/sessions/s1/shares`, { method: 'POST',
    headers: { ...f.bearer(3), 'Content-Type': 'text/plain' }, body: 'x' });
  assert.equal(textBody.status, 415);
  const made = await f.createLive(3);
  assert.equal(made.status, 201);
  const share = made.body.share;
  assert.equal(share.expiresAt, new Date(now + 7 * DAY).toISOString(), 'default expiry is seven days');
  assert.deepEqual([share.mode, share.upToMessageId, share.messageCount, share.redactionCounts], ['live', null, null, null]);
  for (const key of ['token_hash', 'tokenHash', 'ref_key', 'refKey', 'snapshot']) assert.equal(key in share, false, key);
  const row = f.store.get(share.id);
  assert.deepEqual([row.mode, row.snapshot, row.snapshot_sha256, row.up_to_message_id, row.message_count,
    row.redaction_counts], ['live', null, '', '', 0, '{}']);
  assert.equal(Buffer.from(row.ref_key).length, 32);
  for (const [expiry, days] of [['24h', 1], ['30d', 30], ['90d', 90]]) {
    const other = await f.createLive(3, { expiry });
    assert.equal(other.body.share.expiresAt, new Date(now + days * DAY).toISOString(), expiry);
  }
  assert.notDeepEqual(Buffer.from(f.store.get(share.id).ref_key), Buffer.from(f.store.get(
    (await f.createLive(3)).body.share.id).ref_key), 'one random ref key per link');
});

test('D6 retirement: preview answers 410 and builds nothing; management is rate limited per IP bucket', async (t) => {
  const f = await fixture(t);
  const retired = await f.preview(3);
  assert.deepEqual([retired.status, retired.body.error.code], [410, 'SNAPSHOT_SHARES_RETIRED']);
  const statuses = [];
  for (let index = 0; index < 120; index += 1) statuses.push((await fetch(`${f.base}/api/session-shares/mine`, { headers: f.bearer(3) })).status);
  assert.equal(statuses.filter((status) => status === 200).length, 119, 'the preview above used one of 120');
  assert.equal((await fetch(`${f.base}/api/session-shares/mine`, { headers: f.bearer(3) })).status, 429);
});

test('sharing is unavailable without a valid public origin', async (t) => {
  const f = await fixture(t, { publicOrigin: undefined });
  const response = await f.createLive(3);
  assert.equal(response.status, 503);
  assert.equal(response.body.error.code, 'SHARING_NOT_CONFIGURED');
});

test('active caps hold inside the INSERT across interleaved connections', async () => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const path = await import('node:path');
  const directory = mkdtempSync(path.join('/var/tmp', 'session-share-caps-'));
  try {
    const file = path.join(directory, 'db.sqlite');
    const a = new Database(file);
    a.exec('CREATE TABLE projects (project_id TEXT PRIMARY KEY, project_path TEXT, isArchived INTEGER)');
    a.prepare("INSERT INTO projects VALUES ('p1','/p',0)").run();
    migrateSessionShares(a);
    const b = new Database(file);
    const stores = [createSessionSharesStore(a), createSessionSharesStore(b)];
    const row = (index, sessionId, creator) => ({ id: `id${index}`, session_id: sessionId, project_id: 'p1', owner_user_id: 3,
      token_hash: 'f'.repeat(64), created_by: creator, created_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + DAY).toISOString(), snapshot: Buffer.from('x'), snapshot_sha256: 'a'.repeat(64),
      up_to_message_id: 'm', message_count: 1, redaction_counts: '{}' });
    const results = await Promise.all(Array.from({ length: 30 }, (_, index) =>
      Promise.resolve().then(() => stores[index % 2].insertWithinCaps(row(index, 's1', index % 3 + 10)))));
    assert.equal(results.filter(Boolean).length, SESSION_SHARE_CAPS.perSession);
    let accepted = 0;
    for (let index = 100; index < 160; index += 1) {
      if (stores[index % 2].insertWithinCaps(row(index, `s${index}`, 7))) accepted += 1;
    }
    assert.equal(accepted, SESSION_SHARE_CAPS.perCreator);
    const live = (index) => ({ id: `live${index}`, session_id: 's-live', project_id: 'p1', owner_user_id: 3,
      token_hash: 'f'.repeat(64), created_by: 20 + index, created_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + DAY).toISOString(), ref_key: Buffer.alloc(32, index) });
    const liveResults = Array.from({ length: 25 }, (_, index) => stores[index % 2].insertLiveWithinCaps(live(index)));
    assert.equal(liveResults.filter(Boolean).length, SESSION_SHARE_CAPS.perSession, 'live rows share the per-session cap');
    assert.equal(stores[0].countActiveLive('s-live'), SESSION_SHARE_CAPS.perSession);
    a.close();
    b.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('public read: uniform 404 matrix and identical failure responses', async (t) => {
  const f = await fixture(t);
  const created = await f.create(3);
  const id = created.body.share.id;
  const token = f.tokenOf(created.body);
  const failures = [
    ['short id', 'abc', token], ['upper-case id', id.toUpperCase(), token], ['no token', id, null],
    ['malformed token', id, 'x'.repeat(10)], ['unknown id', 'a'.repeat(32), token],
    ['wrong token', id, 'A'.repeat(43)],
  ];
  const bodies = new Set();
  for (const [name, shareId, shareToken] of failures) {
    const response = await f.read(shareId, shareToken);
    assert.equal(response.status, 404, name);
    assert.equal(response.headers.get('access-control-allow-origin'), '*', name);
    bodies.add(await response.text());
  }
  assert.deepEqual([...bodies], ['{"error":{"code":"SHARE_UNAVAILABLE"}}']);
  const ok = await f.read(id, token);
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get('cache-control'), 'no-store');
  assert.equal(ok.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(ok.headers.get('referrer-policy'), 'no-referrer');
  assert.match(ok.headers.get('x-robots-tag'), /noindex/);
  assert.equal(ok.headers.get('access-control-allow-credentials'), null);
  assert.equal((await ok.json()).messages.length, 2);
  f.clock.now += 31 * DAY;
  assert.equal((await f.read(id, token)).status, 404, 'expired');
  f.clock.now -= 31 * DAY;
  const live = await f.createLive(3);
  const liveRead = await f.read(live.body.share.id, f.tokenOf(live.body));
  assert.deepEqual([liveRead.status, await liveRead.text()], [404, '{"error":{"code":"SHARE_UNAVAILABLE"}}'],
    'live rows are read through /api/share-view only');
});

test('public read is a 404 when the public origin is unset', async (t) => {
  const f = await fixture(t, { publicOrigin: undefined });
  const token = createShareToken();
  const id = createShareId();
  f.store.insertWithinCaps({ id, session_id: 's1', project_id: 'p1', owner_user_id: 3, token_hash: hashShareToken(token),
    created_by: 3, created_at: new Date().toISOString(), expires_at: new Date(Date.now() + DAY).toISOString(),
    snapshot: gzipSync('{}'), snapshot_sha256: 'a'.repeat(64), up_to_message_id: 'm1', message_count: 1, redaction_counts: '{}' });
  assert.equal((await f.read(id, token)).status, 404);
});

test('CORS: opaque-origin preflight is answered before the allow-list cors()', async (t) => {
  const f = await fixture(t);
  const response = await fetch(`${f.base}/api/session-shares/${'a'.repeat(32)}`, { method: 'OPTIONS',
    headers: { Origin: 'null', 'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Headers': 'x-share-token' } });
  assert.equal(response.status, 204);
  assert.equal(response.headers.get('access-control-allow-origin'), '*');
  assert.equal(response.headers.get('access-control-allow-headers'), 'X-Share-Token');
  assert.equal(response.headers.get('access-control-allow-methods'), 'GET');
  assert.equal(response.headers.get('access-control-allow-credentials'), null);
  const mine = await fetch(`${f.base}/api/session-shares/mine`, { headers: f.bearer(3) });
  assert.equal(mine.status, 200, '"mine" is a management path, not a share id');
});

function rawGet(base, pathname, headers) {
  return new Promise((resolve, reject) => {
    http.get(base + pathname, { headers }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    }).on('error', reject);
  });
}

test('gzip passthrough of the stored blob, gunzip for clients without gzip', async (t) => {
  const f = await fixture(t);
  const created = await f.create(3);
  const id = created.body.share.id;
  const token = f.tokenOf(created.body);
  const stored = f.store.get(id).snapshot;
  const zipped = await rawGet(f.base, `/api/session-shares/${id}`, { 'X-Share-Token': token, 'Accept-Encoding': 'gzip' });
  assert.equal(zipped.status, 200);
  assert.equal(zipped.headers['content-encoding'], 'gzip');
  assert.match(zipped.headers['content-type'], /^application\/json/);
  assert.deepEqual(zipped.body, Buffer.from(stored));
  const plain = await rawGet(f.base, `/api/session-shares/${id}`, { 'X-Share-Token': token, 'Accept-Encoding': 'identity' });
  assert.equal(plain.headers['content-encoding'], undefined);
  assert.equal(JSON.parse(plain.body.toString('utf8')).v, 1);
});

test('legacy reader D1 order: failures charge the IP bucket only, and a valid token is never refused', async (t) => {
  const f = await fixture(t);
  const created = await f.create(3);
  const id = created.body.share.id;
  const token = f.tokenOf(created.body);
  const statuses = [];
  for (let index = 0; index < 21; index += 1) statuses.push((await f.read('a'.repeat(32), 'A'.repeat(43))).status);
  assert.equal(statuses.filter((status) => status === 404).length, 20);
  assert.equal(statuses[20], 429, 'twenty-first failed verification from one bucket');
  const ok = await f.read(id, token);
  assert.equal(ok.status, 200, 'the same IP with a valid token is served');
  const malformed = await f.read(id, 'x'.repeat(10));
  assert.equal(malformed.status, 404, 'a malformed token is refused uncharged');
});

test('liveness matrix: every death cause refuses the read', async (t) => {
  const causes = [
    ['revoked', (f, id) => f.store.revoke(id, 'manual')],
    ['session row missing', (f) => f.sessions.delete('s1')],
    ['session archived', (f) => { f.sessions.get('s1').isArchived = 1; }],
    ['creator disabled', (f) => { f.users.get(3).status = 'disabled'; }],
    ['creator lost read access', (f) => f.readable.delete('s1:3')],
    ['owner changed', (f) => f.owners.set('s1', 5)],
    ['owner unresolvable', (f) => f.owners.delete('s1')],
    ['project archived', (f) => f.db.prepare("UPDATE projects SET isArchived=1 WHERE project_id='p1'").run()],
    ['project unregistered', (f) => f.db.prepare("UPDATE projects SET project_path='/moved' WHERE project_id='p1'").run()],
  ];
  for (const [name, kill] of causes) {
    const f = await fixture(t);
    const created = await f.create(3);
    const id = created.body.share.id;
    const token = f.tokenOf(created.body);
    assert.equal((await f.read(id, token)).status, 200, name);
    kill(f, id);
    assert.equal((await f.read(id, token)).status, 404, name);
  }
  // An admin's share survives the owner losing nothing, and dies when the admin is demoted.
  const f = await fixture(t);
  const admin = await f.create(2);
  f.readable.delete('s1:2');
  assert.equal((await f.read(admin.body.share.id, f.tokenOf(admin.body))).status, 200, 'admins do not need the read gate');
  f.users.get(2).role = 'user';
  assert.equal((await f.read(admin.body.share.id, f.tokenOf(admin.body))).status, 404, 'demoted admin');
  const g = await fixture(t);
  const pinned = await g.create(2);
  g.readable.delete('s1:3');
  assert.equal((await g.read(pinned.body.share.id, g.tokenOf(pinned.body))).status, 404, 'owner_unreadable');
});

test('sweeper: definitive causes revoke at once, a missing session only after two sweeps', async (t) => {
  const f = await fixture(t);
  const keep = (await f.create(3)).body.share.id;
  const missing = (await f.create(3)).body.share.id;
  const expired = (await f.create(3, { expiryMs: DAY })).body.share.id;
  f.db.prepare("UPDATE session_shares SET session_id='s-gone' WHERE id=?").run(missing);
  f.owners.set('s-gone', 3);
  f.readable.add('s-gone:3');
  const later = Date.now() + 2 * DAY;
  assert.deepEqual(sweepSessionShares(f.store, f.policy, later), { revoked: 1, missed: 1, alive: 1 });
  const expiredRow = f.store.get(expired);
  assert.equal(expiredRow.revoke_reason, 'expired');
  assert.equal(expiredRow.snapshot, null);
  assert.equal(f.store.get(missing).revoked_at, null, 'first miss only counts');
  assert.equal(f.store.get(missing).sweep_miss_count, 1);
  // The row comes back (JSONL rewrite): the strike resets.
  f.sessions.set('s-gone', { session_id: 's-gone', project_path: '/work/p1' });
  sweepSessionShares(f.store, f.policy, later);
  assert.equal(f.store.get(missing).sweep_miss_count, 0);
  f.sessions.delete('s-gone');
  sweepSessionShares(f.store, f.policy, later);
  sweepSessionShares(f.store, f.policy, later);
  assert.equal(f.store.get(missing).revoke_reason, 'session_gone');
  assert.equal(f.store.get(missing).snapshot, null);
  f.users.get(3).status = 'disabled';
  sweepSessionShares(f.store, f.policy, later);
  assert.equal(f.store.get(keep).revoke_reason, 'creator_inactive');
  // A revoked row that still holds a blob (legacy/partial write) is cleaned.
  f.db.prepare("UPDATE session_shares SET snapshot=x'00' WHERE id=?").run(keep);
  sweepSessionShares(f.store, f.policy, later);
  assert.equal(f.store.get(keep).snapshot, null);
});

test('revoke, lists and ownership visibility', async (t) => {
  const f = await fixture(t);
  const byAdmin = await f.create(2);
  const byOwner = await f.create(3);
  const list = async (userId) => (await (await fetch(`${f.base}/api/sessions/s1/shares`, { headers: f.bearer(userId) })).json()).shares;
  assert.equal((await list(3)).length, 2, 'session owner sees shares made by others');
  assert.equal((await list(4)).length, 0, 'a session member (even with write) sees only their own (none)');
  assert.equal((await list(5)).length, 0, 'unrelated user sees only their own (none)');
  const mine = await (await fetch(`${f.base}/api/session-shares/mine`, { headers: f.bearer(3) })).json();
  assert.deepEqual(mine.shares.map((share) => share.id).sort(), [byAdmin.body.share.id, byOwner.body.share.id].sort());
  assert.equal(JSON.stringify(mine).includes('token_hash'), false);
  const revoke = (id, userId) => f.post(`/api/session-shares/${id}/revoke`, userId);
  assert.equal((await revoke(byAdmin.body.share.id, 5)).status, 404, 'unrelated user');
  assert.equal((await revoke('zz', 3)).status, 404);
  assert.equal((await revoke(byAdmin.body.share.id, 3)).status, 204, 'session owner revokes the admin\'s share');
  assert.equal(f.store.get(byAdmin.body.share.id).snapshot, null);
  assert.equal((await f.read(byAdmin.body.share.id, f.tokenOf(byAdmin.body))).status, 404);
  assert.equal((await revoke(byOwner.body.share.id, 4)).status, 404, 'a session member cannot revoke');
  assert.equal((await revoke(byOwner.body.share.id, 1)).status, 204, 'platform owner revokes');
  assert.ok(f.audit.some(([action]) => action === 'session_share_revoked'));
  assert.deepEqual(f.dropped, [], 'snapshot revokes never touch the live projection');
  const first = await f.createLive(3);
  const second = await f.createLive(3);
  assert.equal((await revoke(first.body.share.id, 2)).status, 204, 'an admin may revoke a live link (M9 keeps revoke open)');
  assert.deepEqual(f.dropped, [], 'another live link of the session is still active');
  assert.equal(f.store.get(first.body.share.id).ref_key, null, 'revoke nulls the ref key');
  assert.equal((await revoke(second.body.share.id, 3)).status, 204);
  assert.deepEqual(f.dropped, ['s1'], 'the last live revoke drops the projection');
});

test('revocation hooks null blobs by session, project and user', async (t) => {
  const f = await fixture(t);
  const ids = [];
  for (let index = 0; index < 3; index += 1) ids.push((await f.create(3)).body.share.id);
  assert.equal(revokeSharesBySession(f.db, 's1', 'session_archived'), 3);
  assert.equal(revokeSharesBySession(f.db, 's1', 'again'), 0, 'idempotent once blobs are gone');
  assert.equal(f.store.get(ids[0]).revoke_reason, 'session_archived');
  const g = await fixture(t);
  g.db.prepare("INSERT INTO projects VALUES ('p2','/work/p2',0)").run();
  const id = (await g.create(2)).body.share.id;
  assert.equal(revokeSharesByProject(g.db, 'p1', 'project_archived'), 1);
  assert.equal(g.store.get(id).snapshot, null);
  const h = await fixture(t);
  const adminShare = (await h.create(2)).body.share.id;
  assert.equal(revokeSharesByUser(h.db, 3, 'user_deleted'), 1, 'owner deletion revokes shares of their sessions');
  assert.equal(h.store.get(adminShare).revoke_reason, 'user_deleted');
  const empty = new Database(':memory:');
  assert.equal(revokeSharesBySession(empty, 's1', 'x'), 0, 'no table, no error');
  empty.close();
  const heard = [];
  const stopA = onSessionSharesRevoked(() => { throw new Error('listener failure'); });
  const stopB = onSessionSharesRevoked((sessionId) => heard.push(sessionId));
  assert.equal(revokeSharesBySession(h.db, 's1', 'session_deleted'), 0, 'a throwing listener never breaks the revoke');
  stopA();
  stopB();
  revokeSharesBySession(h.db, 's1', 'session_deleted');
  assert.deepEqual(heard, ['s1'], 'archive/delete notify listeners (live projection drop); unregister works');
});

test('evaluateLiveness reports the ordered reason', () => {
  const world = createWorld();
  const row = { id: 'x', session_id: 's1', project_id: 'p1', owner_user_id: 3, created_by: 3,
    expires_at: new Date(Date.now() + DAY).toISOString(), revoked_at: null };
  assert.equal(evaluateLiveness(row, world.policy, Date.now()), null);
  assert.equal(evaluateLiveness({ ...row, expires_at: 'bad' }, world.policy, Date.now()), 'expired');
  world.sessions.get('s1').isArchived = 1;
  assert.equal(evaluateLiveness(row, world.policy, Date.now()), 'session_archived');
  world.sessions.get('s1').isArchived = 0;
  assert.equal(evaluateLiveness({ ...row, created_by: 99 }, world.policy, Date.now()), 'creator_inactive');
  assert.equal(evaluateLiveness({ ...row, created_by: 5 }, world.policy, Date.now()), 'creator_unentitled');
  assert.equal(evaluateLiveness({ ...row, project_id: 'other' }, world.policy, Date.now()), 'project_gone');
  assert.equal(evaluateReadLiveness(row, world.policy, Date.now()), null);
  world.readable.delete('s1:3');
  assert.equal(evaluateReadLiveness({ ...row, created_by: 2 }, world.policy, Date.now()), 'owner_unreadable');
  world.db.close();
});

test('sweeper runs at boot under the writer lease and survives a refused lease', async () => {
  const world = createWorld();
  const logs = [];
  let calls = 0;
  const stop = startSessionShareSweeper({ getStore: () => world.store, policy: world.policy, log: (entry) => logs.push(entry),
    intervalMs: 60_000, withWriter: async (operation) => {
      calls += 1;
      if (calls === 1) throw Object.assign(new Error('busy'), { code: 'update_lock_contended' });
      return operation();
    } });
  await new Promise((resolve) => setImmediate(resolve));
  stop();
  assert.equal(calls, 1, 'boot sweep attempted immediately');
  assert.deepEqual(logs, [{ level: 'warn', scope: 'session-share-sweeper', code: 'update_lock_contended' }]);
  world.db.close();
});

test('eligibility matrix mirrors the live create rule (M9)', async (t) => {
  const f = await fixture(t);
  const eligibility = async (userId, sessionId = 's1', headers = undefined) => {
    const response = await fetch(`${f.base}/api/sessions/${sessionId}/shares/eligibility`,
      { headers: headers ?? (userId ? f.bearer(userId) : {}) });
    return { status: response.status, body: await response.json(), cache: response.headers.get('cache-control') };
  };
  const yes = { canShare: true, canManage: true };
  const no = { canShare: false, canManage: false };
  const owner = await eligibility(3);
  assert.deepEqual([owner.status, owner.body, owner.cache], [200, yes, 'no-store'], 'strict session owner');
  const manageOnly = { canShare: false, canManage: true };
  assert.deepEqual((await eligibility(1)).body, manageOnly, 'platform owner manages but cannot create (M9)');
  assert.deepEqual((await eligibility(2)).body, manageOnly, 'admin manages but cannot create (M9)');
  assert.deepEqual((await eligibility(4)).body, no, 'session member (read or write) neither shares nor manages');
  assert.deepEqual((await eligibility(5)).body, no, 'non-participant');
  assert.deepEqual((await eligibility(3, 's-orphan')).body, { canShare: false, canManage: true },
    'unregistered project: owner cannot share');
  for (const userId of [1, 3, 5]) {
    assert.deepEqual((await eligibility(userId, 'nope')).body, no, 'unknown session is no oracle, even for owner');
  }
  assert.deepEqual((await eligibility(1, 'bad%20id')).body, no, 'malformed id');
  assert.equal((await eligibility(null)).status, 401, 'no Bearer');
  const g = await fixture(t, { verifyUser: () => ({ id: 1, role: 'owner', authenticationKind: 'platform_unverified' }) });
  assert.equal((await fetch(`${g.base}/api/sessions/s1/shares/eligibility`, { headers: g.bearer(1) })).status, 401,
    'platform_unverified');
});

test('D5 status: active live links for readers of the session, zero for everyone else', async (t) => {
  const f = await fixture(t);
  const status = async (userId, sessionId = 's1') => {
    const response = await fetch(`${f.base}/api/sessions/${sessionId}/shares/status`, { headers: userId ? f.bearer(userId) : {} });
    return { status: response.status, body: await response.json() };
  };
  assert.deepEqual(await status(4), { status: 200, body: { activeLiveLinks: 0 } });
  await f.create(3);
  assert.deepEqual((await status(4)).body, { activeLiveLinks: 0 }, 'snapshot rows are not live links');
  const live = await f.createLive(3);
  await f.createLive(3, { expiry: '24h' });
  assert.deepEqual((await status(4)).body, { activeLiveLinks: 2 }, 'a reading member sees the notice');
  assert.deepEqual((await status(3)).body, { activeLiveLinks: 2 });
  for (const [userId, sessionId, name] of [[5, 's1', 'non-reader'], [2, 's1', 'admin without read'], [3, 'nope', 'unknown'],
    [3, 'bad%20id', 'malformed']]) {
    assert.deepEqual((await status(userId, sessionId)).body, { activeLiveLinks: 0 }, name);
  }
  assert.equal((await status(null)).status, 401);
  await f.post(`/api/session-shares/${live.body.share.id}/revoke`, 3);
  assert.deepEqual((await status(4)).body, { activeLiveLinks: 1 });
  f.clock.now += 2 * DAY;
  assert.deepEqual((await status(4)).body, { activeLiveLinks: 0 }, 'expired links do not count');
});

test('list items carry session title and creator name, never secrets', async (t) => {
  const f = await fixture(t);
  const own = await f.create(3);
  const byAdmin = await f.create(2);
  assert.equal(byAdmin.status, 201);
  const secrets = [f.tokenOf(own.body), f.tokenOf(byAdmin.body)];
  const get = async (path, userId) => {
    const response = await fetch(f.base + path, { headers: f.bearer(userId) });
    const text = await response.text();
    for (const token of secrets) assert.equal(text.includes(token), false, 'token never listed');
    for (const share of JSON.parse(text).shares) {
      for (const key of ['token', 'tokenHash', 'token_hash', 'snapshot', 'snapshotSha256', 'snapshot_sha256']) {
        assert.equal(key in share, false, key);
      }
    }
    return JSON.parse(text).shares;
  };
  const live = await f.createLive(3);
  const liveItem = (await get('/api/sessions/s1/shares', 3)).find((item) => item.id === live.body.share.id);
  assert.deepEqual([liveItem.mode, liveItem.messageCount, liveItem.redactionCounts], ['live', null, null]);
  assert.equal(JSON.stringify(liveItem).includes('ref_key'), false);
  await f.post(`/api/session-shares/${live.body.share.id}/revoke`, 3);
  f.db.prepare('DELETE FROM session_shares WHERE id = ?').run(live.body.share.id);
  const bySession = await get('/api/sessions/s1/shares', 3);
  assert.ok(bySession.every((item) => item.mode === 'snapshot'), 'legacy rows read mode snapshot');
  assert.deepEqual(bySession.map((s) => [s.sessionTitle, s.createdByName, s.createdBySelf]).sort(),
    [['Plan', 'admin', false], ['Plan', 'sara', true]]);
  const mine = await get('/api/session-shares/mine', 2);
  assert.deepEqual(mine.map((s) => [s.sessionTitle, s.createdByName, s.createdBySelf]), [['Plan', 'admin', true]]);
  // A creator who lost access to the session keeps the row but not the live title.
  f.users.get(2).role = 'user';
  const lost = await get('/api/session-shares/mine', 2);
  assert.deepEqual(lost.map((s) => [s.sessionTitle, s.createdByName]), [[null, 'admin']]);
  f.users.get(2).role = 'admin';
  f.sessions.get('s1').custom_name = '   ';
  assert.equal((await get('/api/sessions/s1/shares', 3))[0].sessionTitle, null, 'blank title is null');
});

const MANAGEMENT_PATHS = Object.freeze({
  preview: '/sessions/s1/shares/preview',
  'create/list': '/sessions/s1/shares',
  eligibility: '/sessions/s1/shares/eligibility',
  status: '/sessions/s1/shares/status',
  mine: '/session-shares/mine',
  revoke: `/session-shares/${'a'.repeat(32)}/revoke`,
});

test('management path predicate admits every management route and nothing else', () => {
  for (const [name, path] of Object.entries(MANAGEMENT_PATHS)) assert.equal(isSessionShareManagementPath(path), true, name);
  for (const path of ['/sessions/s1', '/sessions/s1/messages', '/sessions/s1/shares/other', '/sessions/s1/shares/',
    '/sessions/s1/shares/preview/x', '/sessions//shares', '/sessions/a/b/shares', '/session-shares/abc',
    '/session-shares/mine/x', '/session-shares//revoke', '/api/sessions/s1/shares', '/projects/p/document-shares',
    '/sessions/s1/shares/eligibilityx', '/sessions/s1/shares/statusx', '/sessions/s1/shares/status/x', undefined, null]) {
    assert.equal(isSessionShareManagementPath(path), false, String(path));
  }
});

test('the app mount dispatches every management route and passes other paths on', async (t) => {
  const dispatched = [];
  const mount = createSessionShareManagementMount((req, _res, _next) => dispatched.push(req.path));
  let passed = 0;
  for (const path of [...Object.values(MANAGEMENT_PATHS), '/sessions/s1/messages']) mount({ path }, {}, () => { passed += 1; });
  assert.deepEqual(dispatched, Object.values(MANAGEMENT_PATHS));
  assert.equal(passed, 1);
  // End to end through the real router: every route answers from the router, never the fallthrough.
  const f = await fixture(t);
  const calls = [['POST', MANAGEMENT_PATHS.preview, {}], ['POST', MANAGEMENT_PATHS['create/list'], {}],
    ['GET', MANAGEMENT_PATHS['create/list']], ['GET', MANAGEMENT_PATHS.eligibility], ['GET', MANAGEMENT_PATHS.status],
    ['GET', MANAGEMENT_PATHS.mine],
    ['POST', MANAGEMENT_PATHS.revoke, {}]];
  for (const [method, path, body] of calls) {
    const response = await fetch(`${f.base}/api${path}`, { method, headers: { ...f.bearer(3), 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body) });
    assert.notEqual(response.status, 418, `${method} ${path}`);
    assert.equal(response.headers.get('cache-control'), 'no-store', `${method} ${path} answered by the router`);
  }
  // server/index.js must use this mount rather than its own path list.
  const { readFileSync } = await import('node:fs');
  const indexSource = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
  assert.match(indexSource, /app\.use\('\/api', createSessionShareManagementMount\(/);
  assert.equal(/\\\/shares\(\?:/.test(indexSource), false, 'no private copy of the management path list');
});

test('the mount runs the device bridge before management routes only', () => {
  const seen = [];
  const mount = createSessionShareManagementMount((req) => seen.push(`dispatch:${req.path}`),
    (req, _res, next) => { seen.push(`bridge:${req.path}`); next(); });
  mount({ path: MANAGEMENT_PATHS.mine }, {}, () => seen.push('next'));
  mount({ path: '/sessions/s1/messages' }, {}, () => seen.push('next'));
  assert.deepEqual(seen, [`bridge:${MANAGEMENT_PATHS.mine}`, `dispatch:${MANAGEMENT_PATHS.mine}`, 'next']);
  const refused = [];
  createSessionShareManagementMount(() => refused.push('dispatch'), () => refused.push('bridge answered'))(
    { path: MANAGEMENT_PATHS.mine }, {}, () => refused.push('next'));
  assert.deepEqual(refused, ['bridge answered'], 'a bridge refusal never reaches the router');
});

test('legacy reader slots: per-share concurrency 4 after verification, destroyed at the deadline, freed once', async () => {
  const world = createWorld();
  const token = createShareToken();
  const id = createShareId();
  const { blob, sha256 } = snapshotBlob();
  world.store.insertWithinCaps({ id, session_id: 's1', project_id: 'p1', owner_user_id: 3, token_hash: hashShareToken(token),
    created_by: 3, created_at: new Date().toISOString(), expires_at: new Date(Date.now() + DAY).toISOString(), snapshot: blob,
    snapshot_sha256: sha256, up_to_message_id: 'm2', message_count: 2, redaction_counts: '{}' });
  const handler = createSessionSharePublicHandler({ getStore: () => world.store, policy: world.policy, publicOrigin: ORIGIN,
    readTimeoutMs: 20 });
  const responses = [];
  const fakeResponse = () => {
    const res = { statusCode: 200, headers: {}, listeners: {}, headersSent: false, destroyed: false };
    Object.assign(res, {
      set(values, value) { Object.assign(this.headers, typeof values === 'string' ? { [values]: value } : values); return this; },
      type() { return this; },
      status(code) { this.statusCode = code; return this; },
      json(body) { this.body = body; return this; },
      end() { return this; },
      once(event, listener) { this.listeners[event] = listener; return this; },
      destroy() { this.destroyed = true; this.listeners.close?.(); },
    });
    responses.push(res);
    return res;
  };
  const request = (index, presented = token) => handler({ method: 'GET', path: `/api/session-shares/${id}`, headers: {},
    socket: { remoteAddress: `10.9.0.${index}` }, get: (name) => (name === 'X-Share-Token' ? presented : undefined),
    acceptsEncodings: () => 'gzip' }, fakeResponse(), () => {});
  for (let index = 0; index < 5; index += 1) request(index);
  assert.equal(handler.activeReaders(), 4);
  assert.deepEqual(responses.map((res) => res.statusCode), [200, 200, 200, 200, 429], 'fifth concurrent reader of one share');
  assert.equal(responses[4].headers['Retry-After'], '1');
  for (let index = 0; index < 30; index += 1) request(100 + index, 'A'.repeat(43));
  assert.equal(handler.activeReaders(), 4, 'failed verifications never take a slot');
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(responses.slice(0, 4).every((res) => res.destroyed), true, 'held readers destroyed');
  assert.equal(handler.activeReaders(), 0);
  for (const res of responses.slice(0, 4)) { res.listeners.finish?.(); res.listeners.error?.(); res.listeners.close?.(); }
  assert.equal(handler.activeReaders(), 0, 'late close/finish/error never double-release');
  request(20);
  assert.equal(responses.at(-1).statusCode, 200, 'a freed slot admits the next reader');
  assert.equal(handler.activeReaders(), 1);
  responses.at(-1).listeners.finish();
  assert.equal(handler.activeReaders(), 0);
  world.db.close();
});

test('sweeper covers more than one batch: every expired row first, then all others by cursor', () => {
  const world = createWorld();
  const insert = world.db.prepare(`INSERT INTO session_shares (id, session_id, project_id, owner_user_id, token_hash,
    created_by, created_at, expires_at, snapshot, snapshot_sha256, up_to_message_id, message_count, redaction_counts)
    VALUES (?, 's1', 'p1', 3, 'h', ?, ?, ?, x'00', 'x', 'm1', 1, '{}')`);
  const now = Date.now();
  const iso = (ms) => new Date(ms).toISOString();
  const pad = (index) => String(index).padStart(4, '0');
  world.db.transaction(() => {
    for (let index = 0; index < 700; index += 1) insert.run(`exp-${pad(index)}`, 3, iso(now - 10 * DAY + index), iso(now - DAY));
    for (let index = 0; index < 600; index += 1) insert.run(`live-${pad(index)}`, 3, iso(now - DAY + index), iso(now + DAY));
    // Newest by created_at and last by id: starved by the old 500-row created_at window.
    for (let index = 0; index < 5; index += 1) insert.run(`zz-dead-${index}`, 5, iso(now + index), iso(now + DAY));
  })();
  assert.deepEqual(sweepSessionShares(world.store, world.policy, now), { revoked: 705, missed: 0, alive: 600 });
  const count = (sql) => world.db.prepare(`SELECT COUNT(*) AS n FROM session_shares WHERE ${sql}`).get().n;
  assert.equal(count("revoke_reason = 'expired' AND snapshot IS NULL"), 700);
  assert.equal(count("id LIKE 'zz-dead-%' AND revoke_reason = 'creator_unentitled' AND snapshot IS NULL"), 5);
  assert.equal(count('revoked_at IS NULL AND snapshot IS NOT NULL'), 600);
  world.db.close();
});
