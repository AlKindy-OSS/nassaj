/**
 * ADR-205 stage 3: the guest routes of live read links over an in-memory
 * share table and an injected projection. Covers the D1 authorization order,
 * the D7 guards (failure buckets that never block a valid token, IPv6 /64
 * bucketing, per-share concurrency before global slots), the 10 s deadline
 * (N7), headers, CORS, fall-through shapes and liveness.
 */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import Database from 'better-sqlite3';
import cors from 'cors';
import express from 'express';

import { createSessionSharesStore, migrateSessionShares } from '../modules/database/session-shares.js';
import { LiveProjectionError } from '../services/session-share-live-errors.js';
import { createShareId, createShareToken, hashShareToken } from '../services/share-capability.js';
import { GUEST_LIMITS, createGuestGuards } from '../services/share-guest-guards.js';

import { GUEST_DEADLINE_MS, createShareViewHandler, parseShareViewRequest } from './share-view.js';

const ORIGIN = 'https://nassaj.example';
const DAY = 24 * 60 * 60 * 1000;
const CURSOR = `${'k'.repeat(22)}.${'m'.repeat(22)}`;
const REF = `${'k'.repeat(22)}.0.${'r'.repeat(32)}`;
const PAGE = { v: 2, revision: 'r'.repeat(43), running: false, stale: false, moreBefore: false, moreAfter: false,
  retryAfterMs: 3000, messages: [{ k: 'k'.repeat(22), c: CURSOR, role: 'user', author: 'owner', parts: [{ t: 'text', text: 'hi' }] }] };

function createWorld() {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE projects (project_id TEXT PRIMARY KEY, project_path TEXT, isArchived INTEGER)');
  db.prepare('INSERT INTO projects VALUES (?,?,0)').run('p1', '/work/p1');
  migrateSessionShares(db);
  const world = {
    db, store: createSessionSharesStore(db),
    sessions: new Map([['s1', { session_id: 's1', project_path: '/work/p1', provider: 'claude', custom_name: 'Plan /work/p1/x' }]]),
    owners: new Map([['s1', 3]]),
    users: new Map([[3, { id: 3, role: 'user', status: 'active' }]]),
    readable: new Set(['s1:3']),
  };
  world.policy = {
    getSession: (id) => world.sessions.get(id) ?? null,
    resolveOwner: (id) => world.owners.get(id) ?? null,
    findProject: (projectPath) => (projectPath === '/work/p1' ? { project_id: 'p1', isArchived: false } : null),
    getActiveUser: (id) => world.users.get(id) ?? null,
    isSessionReadable: (sessionId, _path, userId) => world.readable.has(`${sessionId}:${userId}`),
  };
  return world;
}

/** Inserts a share row; live by default. @returns {{ id: string, token: string }} */
function seed(world, { mode = 'live', expiresInMs = 7 * DAY } = {}) {
  const id = createShareId();
  const token = createShareToken();
  const now = new Date().toISOString();
  const row = { id, session_id: 's1', project_id: 'p1', owner_user_id: 3, token_hash: hashShareToken(token), created_by: 3,
    created_at: now, expires_at: new Date(Date.now() + expiresInMs).toISOString() };
  if (mode === 'live') world.store.insertLiveWithinCaps({ ...row, ref_key: randomBytes(32) });
  else world.store.insertWithinCaps({ ...row, snapshot: Buffer.from('x'), snapshot_sha256: 'a'.repeat(64),
    up_to_message_id: 'm', message_count: 1, redaction_counts: '{}' });
  return { id, token };
}

/** A projection stand-in recording calls; `gate` holds reads open. */
function fakeProjection() {
  const state = { calls: [], gate: null, error: null, attachment: null };
  return {
    state,
    readMessages: async (request) => {
      state.calls.push(request);
      if (state.gate) await state.gate;
      if (state.error) throw state.error;
      return PAGE;
    },
    resolveAttachment: async (request) => {
      state.calls.push(request);
      if (state.gate) await state.gate;
      return state.attachment;
    },
  };
}

async function fixture(t, options = {}) {
  const world = createWorld();
  const projection = options.projection ?? fakeProjection();
  const loaded = [];
  const app = express();
  app.use(createShareViewHandler({ getStore: () => world.store, policy: world.policy, publicOrigin: ORIGIN, projection,
    loadAttachment: options.loadAttachment ?? (async (locator) => { loaded.push(locator); return options.payload; }),
    home: () => '/home/operator', guards: options.guards, deadlineMs: options.deadlineMs }));
  app.use(cors({ origin: (_origin, callback) => callback(null, false) }));
  app.use((_req, res) => res.status(418).json({ fellThrough: true }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    world.db.close();
  });
  const get = (path, token, ip = '198.51.100.1', headers = {}) => fetch(`${base}/api/share-view/${path}`, {
    headers: { ...(token ? { 'X-Share-Token': token } : {}), 'cf-connecting-ip': ip, ...headers } });
  return { ...world, base, projection, loaded, get };
}

test('path and query shapes: only exact shapes are claimed; everything else falls through', async (t) => {
  const id = 'a'.repeat(32);
  assert.deepEqual(parseShareViewRequest(`/api/share-view/${id}/meta`, {}), { id, endpoint: 'meta', ref: undefined });
  assert.deepEqual(parseShareViewRequest(`/api/share-view/${id}/messages`, { before: CURSOR }),
    { id, endpoint: 'messages', query: { before: CURSOR } });
  assert.equal(parseShareViewRequest(`/api/share-view/${id}/attachments/${REF}`, {}).ref, REF);
  for (const [path, query] of [[`/api/share-view/${id.toUpperCase()}/meta`, {}], [`/api/share-view/${id}x/meta`, {}],
    [`/api/share-view/${id}/meta/`, {}], [`/api/share-view/${id}/other`, {}], [`/api/share-view/${id}/meta`, { token: 'x' }],
    [`/api/share-view/${id}/messages`, { before: 'bad' }], [`/api/share-view/${id}/messages`, { before: CURSOR, after: CURSOR }],
    [`/api/share-view/${id}/messages`, { since: 'r'.repeat(43) }], [`/api/share-view/${id}/messages`, { after: [CURSOR] }],
    [`/api/share-view/${id}/messages`, { offset: '0' }], [`/api/share-view/${id}/attachments/../../etc`, {}],
    [`/api/share-view/${id}/attachments/${REF}x`, {}], ['/api/share-view', {}]]) {
    assert.equal(parseShareViewRequest(path, query), null, `${path} ${JSON.stringify(query)}`);
  }
  assert.deepEqual(parseShareViewRequest(`/api/share-view/${id}/messages`, { after: CURSOR }).query,
    { after: CURSOR });
  const f = await fixture(t);
  const { token } = seed(f);
  for (const path of [`${id}/meta?token=${token}`, `${'z'.repeat(32)}/meta`, `${id}/messages?limit=10`]) {
    assert.equal((await f.get(path, token)).status, 418, `${path} falls through to the normal stack`);
  }
  const post = await fetch(`${f.base}/api/share-view/${id}/meta`, { method: 'POST', headers: { 'X-Share-Token': token } });
  assert.equal(post.status, 418, 'other methods are never claimed');
});

test('a live share answers meta and messages with guest headers and wildcard CORS', async (t) => {
  const f = await fixture(t);
  const { id, token } = seed(f);
  const meta = await f.get(`${id}/meta`, token);
  assert.equal(meta.status, 200);
  const body = await meta.json();
  assert.deepEqual([body.v, body.mode, body.providerLabel], [2, 'live', 'Claude']);
  assert.ok(!body.title.includes('/work/p1'), 'the title is sanitized with the project context');
  assert.equal(body.expiresAt, f.store.get(id).expires_at);
  for (const [name, value] of [['cache-control', 'no-store'], ['x-content-type-options', 'nosniff'],
    ['referrer-policy', 'no-referrer'], ['x-robots-tag', 'noindex, nofollow, noarchive'], ['access-control-allow-origin', '*'],
    ['access-control-allow-methods', 'GET'], ['access-control-allow-headers', 'X-Share-Token']]) {
    assert.equal(meta.headers.get(name), value, name);
  }
  assert.equal(meta.headers.get('access-control-allow-credentials'), null);
  assert.equal(meta.headers.get('set-cookie'), null);
  const page = await f.get(`${id}/messages?before=${CURSOR}`, token);
  assert.deepEqual(await page.json(), PAGE);
  const call = f.projection.state.calls.at(-1);
  assert.deepEqual([call.sessionId, call.ownerUserId, call.before, call.after, call.share.shareId], ['s1', 3, CURSOR, undefined, id]);
  assert.deepEqual(Buffer.from(call.share.refKey), Buffer.from(f.store.get(id).ref_key));
  const preflight = await fetch(`${f.base}/api/share-view/${id}/messages`, { method: 'OPTIONS',
    headers: { Origin: 'null', 'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Headers': 'x-share-token' } });
  assert.deepEqual([preflight.status, preflight.headers.get('access-control-allow-origin')], [204, '*']);
});

test('uniform 404: no, malformed, wrong or foreign token; revoked, expired, dead and owner-unreadable shares', async (t) => {
  const f = await fixture(t);
  const { id, token } = seed(f);
  const other = seed(f);
  const bodies = new Set();
  const expect404 = async (path, presented, label) => {
    const response = await f.get(path, presented, `203.0.113.${bodies.size + 1}`);
    assert.equal(response.status, 404, label);
    bodies.add(await response.text());
  };
  await expect404(`${id}/messages`, null, 'no token');
  await expect404(`${id}/messages`, 'short', 'malformed token');
  await expect404(`${id}/messages`, 'W'.repeat(43), 'wrong token');
  await expect404(`${id}/messages`, other.token, 'token of another share');
  await expect404(`${'e'.repeat(32)}/messages`, token, 'unknown id');
  f.readable.delete('s1:3');
  await expect404(`${id}/meta`, token, 'owner_unreadable');
  f.readable.add('s1:3');
  f.sessions.get('s1').isArchived = 1;
  await expect404(`${id}/messages`, token, 'session archived');
  f.sessions.get('s1').isArchived = 0;
  f.store.revoke(other.id, 'manual');
  await expect404(`${other.id}/messages`, other.token, 'revoked');
  const expired = seed(f, { expiresInMs: -1000 });
  await expect404(`${expired.id}/messages`, expired.token, 'expired');
  assert.deepEqual([...bodies], ['{"error":{"code":"SHARE_UNAVAILABLE"}}']);
  assert.equal(f.projection.state.calls.length, 0, 'no refused request reached the projection');
});

test('D6: a legacy snapshot row reports only its mode on meta and is refused on data endpoints', async (t) => {
  const f = await fixture(t);
  const { id, token } = seed(f, { mode: 'snapshot' });
  assert.deepEqual(await (await f.get(`${id}/meta`, token)).json(), { v: 2, mode: 'snapshot' });
  assert.equal((await f.get(`${id}/messages`, token)).status, 404);
  assert.equal((await f.get(`${id}/attachments/${REF}`, token)).status, 404);
  const live = seed(f);
  f.db.prepare('UPDATE session_shares SET ref_key = NULL WHERE id = ?').run(live.id);
  assert.equal((await f.get(`${live.id}/messages`, live.token)).status, 404, 'a live row without its ref key is dead');
});

test('condition 6: with the unverified map full and the attacker /64 at 429, a valid token is served', async (t) => {
  const limits = { ...GUEST_LIMITS, unverified: { ...GUEST_LIMITS.unverified, maxKeys: 4 } };
  const f = await fixture(t, { guards: createGuestGuards({ limits }) });
  const { id, token } = seed(f);
  for (let index = 0; index < 4; index += 1) {
    assert.equal((await f.get(`${id}/messages`, 'W'.repeat(43), `2001:db8:1${index}::1`)).status, 404);
  }
  const attacker = [];
  for (let index = 0; index < 25; index += 1) {
    attacker.push((await f.get(`${id}/messages`, 'W'.repeat(43), `2001:db8:0:0:${index.toString(16)}::9`)).status);
  }
  assert.equal(attacker.filter((status) => status === 404).length, 20, 'rotating inside one /64 shares one failure bucket');
  assert.equal(attacker.at(-1), 429);
  const untracked = await f.get(`${id}/messages`, 'W'.repeat(43), '198.51.100.200');
  assert.equal(untracked.status, 404, 'map full: a new attacker key is not tracked and gets the uniform 404, not 429');
  for (const ip of ['2001:db8:0:0:ffff::1', '198.51.100.200', '203.0.113.50']) {
    assert.equal((await f.get(`${id}/messages`, token, ip)).status, 200, `valid token from ${ip} is served`);
  }
});

test('D7: per-share concurrency (4) is charged before per-IP and global slots; refusals carry Retry-After', async (t) => {
  const projection = fakeProjection();
  let open;
  projection.state.gate = new Promise((resolve) => { open = resolve; });
  const f = await fixture(t, { projection });
  const shareA = seed(f);
  const shareB = seed(f);
  const held = Array.from({ length: 4 }, (_, index) => f.get(`${shareA.id}/messages`, shareA.token, `198.51.100.${10 + index}`));
  await new Promise((resolve) => setTimeout(resolve, 50));
  const fifth = await f.get(`${shareA.id}/messages`, shareA.token, '198.51.100.30');
  assert.deepEqual([fifth.status, fifth.headers.get('retry-after')], [429, '1']);
  assert.deepEqual(await fifth.json(), { error: { code: 'RATE_LIMITED' } });
  const twoFromOneIp = [f.get(`${shareB.id}/messages`, shareB.token, '198.51.100.40'),
    f.get(`${shareB.id}/messages`, shareB.token, '198.51.100.40')];
  await new Promise((resolve) => setTimeout(resolve, 50));
  const third = await f.get(`${shareB.id}/messages`, shareB.token, '198.51.100.40');
  assert.equal(third.status, 429, 'per-IP slots: an IP already holding two readers is refused');
  const otherIp = f.get(`${shareB.id}/messages`, shareB.token, '198.51.100.99');
  open();
  assert.deepEqual((await Promise.all([...held, ...twoFromOneIp, otherIp])).map((r) => r.status), Array(7).fill(200));
  assert.equal((await f.get(`${shareA.id}/messages`, shareA.token, '198.51.100.30')).status, 200, 'slots are released');
});

test('D7: the per-share request bucket answers 429 with the window Retry-After', async (t) => {
  const limits = { ...GUEST_LIMITS, perShare: { ...GUEST_LIMITS.perShare, limit: 3 } };
  const f = await fixture(t, { guards: createGuestGuards({ limits }) });
  const { id, token } = seed(f);
  const statuses = [];
  for (let index = 0; index < 4; index += 1) statuses.push((await f.get(`${id}/meta`, token, `198.51.100.${index}`)).status);
  assert.deepEqual(statuses.slice(0, 3), [200, 200, 200]);
  const limited = await f.get(`${id}/meta`, token, '198.51.100.9');
  assert.equal(limited.status, 429);
  assert.ok(Number(limited.headers.get('retry-after')) >= 1);
});

test('projection errors map to guest answers; nothing is a 500', async (t) => {
  const projection = fakeProjection();
  const f = await fixture(t, { projection });
  const { id, token } = seed(f);
  const cases = [
    [new LiveProjectionError('HISTORY_UNAVAILABLE', 4200), 503, { error: { code: 'HISTORY_UNAVAILABLE', retryAfterMs: 4200 } }, '5'],
    [new LiveProjectionError('CURSOR_STALE'), 409, { error: { code: 'CURSOR_STALE' } }, null],
    [Object.assign(new Error('gone'), { statusCode: 404, code: 'SESSION_NOT_FOUND' }), 404, { error: { code: 'SHARE_UNAVAILABLE' } }, null],
    [new TypeError('boom'), 503, { error: { code: 'HISTORY_UNAVAILABLE', retryAfterMs: 3000 } }, '3'],
  ];
  for (const [error, status, body, retryAfter] of cases) {
    projection.state.error = error;
    const response = await f.get(`${id}/messages`, token);
    assert.equal(response.status, status, error.message);
    assert.deepEqual(await response.json(), body);
    assert.equal(response.headers.get('retry-after'), retryAfter);
  }
});

test('N7: a request that reaches the deadline answers 503 with retryAfterMs, never 500, and frees its slot', async (t) => {
  const projection = fakeProjection();
  projection.state.gate = new Promise(() => {});
  const f = await fixture(t, { projection, deadlineMs: 60 });
  const { id, token } = seed(f);
  const started = Date.now();
  const response = await f.get(`${id}/messages`, token);
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: { code: 'HISTORY_UNAVAILABLE', retryAfterMs: 3000 } });
  assert.ok(Date.now() - started < 2000);
  const call = projection.state.calls.at(-1);
  assert.equal(call.signal.aborted, true, 'the projection read is aborted at the deadline');
  const slow = await f.get(`${id}/attachments/${REF}`, token);
  assert.equal(slow.status, 503, 'attachments obey the same deadline');
  assert.equal(GUEST_DEADLINE_MS, 10_000);
});

test('attachments: images and redacted text files are served with sandbox CSP; gone and oversized refs are typed', async (t) => {
  const projection = fakeProjection();
  const png = Buffer.from('89504e470d0a1a0a0000', 'hex');
  const payload = { ok: true, kind: 'image', contentType: 'image/png', bytes: png };
  const f = await fixture(t, { projection, payload });
  const { id, token } = seed(f);
  projection.state.attachment = { locator: { source: 'chat-image', bucket: 'b', name: 'n' }, projectRoot: '/work/p1', home: '/h' };
  const image = await f.get(`${id}/attachments/${REF}`, token);
  assert.equal(image.status, 200);
  assert.deepEqual(Buffer.from(await image.arrayBuffer()), png);
  for (const [name, value] of [['content-type', 'image/png'], ['x-content-type-options', 'nosniff'],
    ['content-security-policy', "default-src 'none'; sandbox"], ['cache-control', 'no-store']]) {
    assert.equal(image.headers.get(name), value, name);
  }
  assert.deepEqual(f.loaded.at(-1), { source: 'chat-image', bucket: 'b', name: 'n' });
  Object.assign(payload, { kind: 'file', name: "notes (v2)'s.txt", bytes: Buffer.from('redacted text') });
  const file = await f.get(`${id}/attachments/${REF}`, token);
  assert.equal(file.headers.get('content-type'), 'application/octet-stream');
  assert.equal(file.headers.get('content-disposition'), "attachment; filename*=UTF-8''notes%20%28v2%29%27s.txt");
  Object.assign(payload, { ok: false, reason: 'too_large' });
  assert.deepEqual([(await f.get(`${id}/attachments/${REF}`, token)).status], [413]);
  Object.assign(payload, { ok: false, reason: 'gone' });
  const gone = await f.get(`${id}/attachments/${REF}`, token);
  assert.deepEqual([gone.status, await gone.json()], [404, { error: { code: 'ATTACHMENT_GONE' } }]);
  projection.state.attachment = null;
  assert.equal((await f.get(`${id}/attachments/${REF}`, token)).status, 404, 'a stale or forged ref is ATTACHMENT_GONE');
  assert.equal(projection.state.calls.at(-1).ref, REF);
});

test('attachments use their own pool: per share 2, independent of reader slots', async (t) => {
  const projection = fakeProjection();
  let open;
  projection.state.gate = new Promise((resolve) => { open = resolve; });
  projection.state.attachment = null;
  const f = await fixture(t, { projection });
  const { id, token } = seed(f);
  const held = [f.get(`${id}/attachments/${REF}`, token, '198.51.100.1'), f.get(`${id}/attachments/${REF}`, token, '198.51.100.2')];
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal((await f.get(`${id}/attachments/${REF}`, token, '198.51.100.3')).status, 429, 'third attachment of one share');
  const reader = f.get(`${id}/messages`, token, '198.51.100.4');
  open();
  assert.equal((await reader).status, 200, 'message readers are not blocked by attachment slots');
  await Promise.all(held);
});

test('the guest principal is never a user: no req.user, cookie or Authorization is consulted', async (t) => {
  const f = await fixture(t);
  const { id, token } = seed(f);
  const withCredentials = await f.get(`${id}/messages`, null, '198.51.100.1',
    { Authorization: 'Bearer anything', Cookie: '__Host-nassaj_device=abc; sid=x' });
  assert.equal(withCredentials.status, 404, 'credentials are no substitute for the share token');
  assert.equal((await f.get(`${id}/messages`, token, '198.51.100.1', { Authorization: 'Bearer garbage' })).status, 200);
});

test('D9: the guest route and the shared guest modules name no provider', () => {
  // 'cursor' is also the paging term, so that provider counts only as a quoted id.
  const providers = /\b(claude|codex|opencode|antigravity|agy|kimi|glm|deepseek|qwen|hermes|gemini)\b|['"`]cursor['"`]/i;
  for (const file of ['routes/share-view.js', 'services/share-guest-access.js', 'services/share-guest-guards.ts',
    'services/session-share-live-serve.ts', 'services/session-share-live-files.ts']) {
    const source = fs.readFileSync(path.join(import.meta.dirname, '..', file), 'utf8');
    assert.equal(providers.test(source), false, `${file} names a provider`);
  }
});
