import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import { request } from 'node:http';
import { gzipSync } from 'node:zlib';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';

import Database from 'better-sqlite3';
import express from 'express';
import jwt from 'jsonwebtoken';

import { mintMutationCsrfToken } from '../modules/account-wallet/index.js';
import { AgentReviewError, applyAgentReviewSchema, closeConnection, getConnection } from '../modules/database/index.js';
import { isAuthenticatedLaunchActorCurrent } from '../modules/execution-permissions/index.js';
import type { ReviewAccessSeams } from '../modules/providers/services/agent-review-http-authority.js';

import { createC4ReviewHttpStack } from './c4-review-request-boundaries.js';

const SECRET = 'synthetic-c4-jwt-secret-never-used-in-production';
const KEY = `ck_${'7'.repeat(64)}`; const DEVICE = 'synthetic-device-secret';
const GET = '/api/providers/sessions/s/agent-reviews'; const PATCH = `${GET}/agent-1`;
const command = { source: 'workflow', resultGeneration: 'a'.repeat(64), action: 'start_review', expectedRevision: 0, idempotencyKey: 'key-1' };
const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const sha = (value: string): string => createHash('sha256').update(value).digest('hex');
const token = (extra: object = {}, secret = SECRET): string => jwt.sign({ userId: 1, auth_gen: 1, pwd_iat: 100,
  exp: Math.floor(Date.now() / 1000) + 3600, ...extra }, secret, { algorithm: 'HS256' });
type Reply = { status: number; headers: Headers; body: any };
type Fixture = { db: Database.Database; second: () => Database.Database; origin: string;
  call: (headers: Record<string, string>, method?: string, url?: string, body?: unknown) => Promise<Reply>;
  capture: { run?: () => void } };

async function fixture(t: TestContext, run: (value: Fixture) => Promise<void>): Promise<void> {
  const artifacts = path.join(ROOT, '.artifacts'); await fs.mkdir(artifacts, { recursive: true });
  const directory = await fs.mkdtemp(path.join(artifacts, 'c4-real-auth-')); const filename = path.join(directory, 'fixture.db');
  const previous = { db: process.env.DATABASE_PATH, secret: process.env.JWT_SECRET, api: process.env.API_KEY, origin: process.env.APP_ORIGIN, tmp: process.env.TMPDIR };
  const descriptor = fsSync.openSync(filename,
    fsSync.constants.O_CREAT | fsSync.constants.O_EXCL | fsSync.constants.O_WRONLY | fsSync.constants.O_NOFOLLOW, 0o600);
  fsSync.closeSync(descriptor);
  const file = fsSync.lstatSync(filename);
  assert.equal(file.isFile(), true); assert.equal(file.nlink, 1); assert.equal(file.mode & 0o777, 0o600);
  closeConnection(); const initial = new Database(filename); initial.exec('CREATE TABLE app_config(key TEXT PRIMARY KEY,value)'); initial.close();
  process.env.TMPDIR = artifacts;
  process.env.DATABASE_PATH = filename; process.env.JWT_SECRET = SECRET; delete process.env.API_KEY; delete process.env.APP_ORIGIN;
  t.mock.method(fsSync, 'copyFileSync', () => { throw new Error('legacy DB copy forbidden in C4 fixtures'); });
  const db = getConnection(); db.pragma('busy_timeout=0'); db.transaction(() => applyAgentReviewSchema(db)).immediate();
  db.exec(`CREATE TABLE users(id INTEGER PRIMARY KEY,username TEXT,role TEXT,is_active INTEGER,status TEXT,
    authorization_generation INTEGER,password_changed_at INTEGER,must_change_password INTEGER,avatar_url TEXT);
    INSERT INTO users VALUES (1,'synthetic','user',1,'active',1,100,0,NULL);
    CREATE TABLE api_keys(id INTEGER PRIMARY KEY,user_id INTEGER,key_digest TEXT,is_active INTEGER,last_used TEXT);
    CREATE TABLE device_sessions(id TEXT PRIMARY KEY,secret_hash TEXT,active_slot_id TEXT,generation INTEGER,revoked_at INTEGER,expires_at INTEGER);
    CREATE TABLE device_account_slots(id TEXT PRIMARY KEY,device_session_id TEXT,user_id INTEGER,revoked_at INTEGER,password_stamp INTEGER,last_used_at INTEGER);
    CREATE TABLE session_participants(session_id TEXT,user_id INTEGER,role TEXT,attribution TEXT);
    INSERT INTO session_participants VALUES ('s',1,'owner','spawn');
    INSERT INTO app_config VALUES ('external_api.enabled','1');`);
  db.prepare('INSERT INTO api_keys VALUES (7,1,?,1,NULL)').run(`sha256:${sha(KEY)}`);
  db.prepare('INSERT INTO device_sessions VALUES (?,?,?,1,NULL,?)').run('device', sha(DEVICE), 'slot', Date.now() + 3600000);
  db.prepare('INSERT INTO device_account_slots VALUES (?,?,1,NULL,100,0)').run('slot', 'device');
  db.prepare('INSERT INTO agent_review_results VALUES (?,?,?,?,?,?,?,?,?,?)').run('s','workflow','agent-1',command.resultGeneration,
    'b'.repeat(64),1,'c'.repeat(64),'d'.repeat(64),'e'.repeat(64),'2026-09-24T00:00:00.000Z');
  db.prepare("INSERT INTO agent_review_states VALUES ('s','workflow','agent-1',?,'awaiting_review',0,NULL,NULL,NULL)").run(command.resultGeneration);
  db.prepare("INSERT INTO agent_review_current VALUES ('s','workflow','agent-1',?,?,1,0,'2026-09-24T00:00:00.000Z')").run(command.resultGeneration,'b'.repeat(64));
  const capture: { run?: () => void } = {};
  const seams: ReviewAccessSeams = { connection: () => db, actorCurrent: isAuthenticatedLaunchActorCurrent,
    session: session => { if (session !== 's') throw new AgentReviewError('session_not_found'); return { provider: 'claude', project_path: '/synthetic' }; },
    capture: () => { capture.run?.(); return null; }, current: () => true };
  // Real existing installation-key middleware; importing it is bootstrap, outside measured requests.
  const { validateApiKey } = await import('./auth.js');
  const stack = createC4ReviewHttpStack({ db, jwtSecret: SECRET, deviceEnabled: true, accessSeams: seams });
  const app = express(); app.use(stack.beforeGlobal); app.use(stack.globalParsers); app.use(validateApiKey);
  app.use(stack.authenticatedRoutes);
  app.use((_req, res) => res.status(404).json({ fallback: true }));
  const server = app.listen(0, '127.0.0.1'); await new Promise<void>(resolve => server.once('listening', resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try { await run({ db, origin, capture, second: () => new Database(filename, { timeout: 0 }), call: async (headers, method = 'GET', url = GET, body) => {
    const response = await fetch(origin + url, { method, headers: { 'Content-Type': 'application/json', ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, headers: response.headers, body: await response.json() };
  } }); }
  finally {
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); closeConnection(); t.mock.restoreAll();
    for (const [key, value] of Object.entries({ DATABASE_PATH: previous.db, JWT_SECRET: previous.secret, API_KEY: previous.api, APP_ORIGIN: previous.origin, TMPDIR: previous.tmp })) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await fs.rm(directory, { recursive: true, force: true });
  }
}

const jwtHeader = (): Record<string, string> => ({ Authorization: `Bearer ${token()}` });
const keyHeader = { Authorization: `Bearer ${KEY}` };
const cookie = { Cookie: `__Host-nassaj_device=${DEVICE}` };
const changes = (db: Database.Database): unknown => db.prepare('SELECT total_changes() AS n').get();
const receipts = (db: Database.Database): number => (db.prepare('SELECT COUNT(*) AS n FROM agent_review_receipts').get() as { n: number }).n;

test('real JWT before/after half-life, near expiry and rejected tokens never refresh, audit or write on GET', async t => fixture(t, async ({ db, call }) => {
  const now = Math.floor(Date.now() / 1000);
  for (const [index, signed] of [token(), token({ iat: now - 7200, exp: now + 3600 }), token({ exp: now + 2 }),
    token({ exp: now - 1 }), token({}, 'different-signing-secret'), token({ auth_gen: 2 }), token({ pwd_iat: 99 }),
    token({ userId: 2 }), token({ purpose: 'password_change' })].entries()) {
    const before = changes(db); const reply = await call({ Authorization: `Bearer ${signed}` });
    assert.equal(reply.status, index < 3 ? 200 : 401); assert.equal(reply.headers.get('x-refreshed-token'), null);
    assert.deepEqual(changes(db), before);
  }
  db.prepare('UPDATE users SET must_change_password=1').run();
  const before = changes(db); assert.equal((await call(jwtHeader())).status, 401); assert.deepEqual(changes(db), before);
}));

test('real CK lookup and device read-only eligibility preserve whole DB and key/slot timestamps', async t => fixture(t, async ({ db, call }) => {
  for (const [index, headers] of [keyHeader, cookie, { Authorization: `Bearer ck_${'0'.repeat(64)}` }].entries()) {
    const before = changes(db); const reply = await call(headers); assert.equal(reply.status, index < 2 ? 200 : 401); assert.deepEqual(changes(db), before);
  }
  assert.deepEqual(db.prepare('SELECT last_used FROM api_keys').get(), { last_used: null });
  assert.deepEqual(db.prepare('SELECT last_used_at FROM device_account_slots').get(), { last_used_at: 0 });
  db.prepare('UPDATE api_keys SET is_active=0').run();
  const before = changes(db); assert.equal((await call(keyHeader)).status, 401); assert.deepEqual(changes(db), before);
}));

test('installation key is separate from personal Bearer CK, with no fallback for mixed or query credentials', async t => fixture(t, async ({ db, call }) => {
  process.env.API_KEY = 'installation-only';
  const before = changes(db);
  assert.equal((await call(keyHeader)).status, 401);
  assert.equal((await call({ ...keyHeader, 'x-api-key': 'installation-only' })).status, 200);
  assert.equal((await call({ 'x-api-key': 'installation-only' })).status, 401);
  assert.equal((await call({ ...cookie, ...keyHeader, 'x-api-key': 'installation-only' })).status, 400);
  assert.equal((await call({ ...jwtHeader(), 'x-api-key': 'installation-only' }, 'GET', `${GET}?token=anything`)).status, 400);
  assert.deepEqual(changes(db), before);
}));

test('real device Origin and method/path/generation CSRF bind PATCH; valid token alone performs one transition', async t => fixture(t, async ({ db, call, origin }) => {
  const csrf = mintMutationCsrfToken(SECRET, 'device:device:slot:1', 'PATCH', PATCH)!.csrfToken;
  for (const headers of [cookie, { ...cookie, Origin: 'https://wrong.invalid', 'x-csrf-token': csrf },
    { ...cookie, Origin: origin, 'x-csrf-token': mintMutationCsrfToken(SECRET, 'device:device:slot:2', 'PATCH', PATCH)!.csrfToken }]) {
    assert.equal((await call(headers, 'PATCH', PATCH, command)).status, 403); assert.equal(receipts(db), 0);
  }
  assert.equal((await call({ ...cookie, Origin: origin, 'x-csrf-token': csrf }, 'PATCH', PATCH, command)).status, 200);
  assert.equal(receipts(db), 1);
}));

for (const replay of [false, true]) {
  test(`CK gate switched off by real second connection before BEGIN blocks ${replay ? 'receipt replay' : 'new transition'}`, async t => fixture(t, async ({ db, second, call, capture }) => {
    if (replay) assert.equal((await call(keyHeader, 'PATCH', PATCH, command)).status, 200);
    const other = second(); const execute = db.exec.bind(db); let intercepted = false;
    t.mock.method(db, 'exec', (sql: string) => {
      if (sql === 'BEGIN IMMEDIATE') { intercepted = true; other.prepare("UPDATE app_config SET value='0' WHERE key='external_api.enabled'").run(); }
      return execute(sql);
    });
    try {
      const before = receipts(db); const reply = await call(keyHeader, 'PATCH', PATCH, command);
      assert.equal(intercepted, true); assert.equal(reply.status, 409);
      assert.deepEqual(reply.body, { error: { code: 'identity_changed', notStarted: false, effectState: 'settled' } });
      assert.equal(receipts(db), before);
    } finally { other.close(); capture.run = undefined; }
  }));
}

test('CK literal gate denies missing, numeric and noncanonical values without identity writes', async t => fixture(t, async ({ db, call }) => {
  for (const value of [0, 1, null, '0', '01', 'true']) {
    db.prepare("UPDATE app_config SET value=? WHERE key='external_api.enabled'").run(value);
    const before = changes(db); assert.equal((await call(keyHeader)).status, 401); assert.deepEqual(changes(db), before);
  }
  db.prepare("DELETE FROM app_config WHERE key='external_api.enabled'").run();
  const before = changes(db); assert.equal((await call(keyHeader)).status, 401); assert.deepEqual(changes(db), before);
}));

test('identity revocation after auth capture before BEGIN gives fixed not_started and zero receipts', async t => fixture(t, async ({ db, call, capture }) => {
  capture.run = () => queueMicrotask(() => db.prepare('UPDATE users SET authorization_generation=2').run());
  const reply = await call(jwtHeader(), 'PATCH', PATCH, command);
  assert.deepEqual(reply.body, { error: { code: 'identity_changed', notStarted: true, effectState: 'not_started' } });
  assert.equal(receipts(db), 0);
}));

test('actual committed PATCH and exact replay revoked after COMMIT are fixed settled before Promise disclosure', async t => fixture(t, async ({ db, call }) => {
  assert.equal((await call(keyHeader, 'PATCH', PATCH, command)).status, 200);
  const execute = db.exec.bind(db);
  t.mock.method(db, 'exec', (sql: string) => {
    const result = execute(sql);
    if (sql === 'COMMIT') db.prepare("UPDATE app_config SET value='0' WHERE key='external_api.enabled'").run();
    return result;
  });
  const reply = await call(keyHeader, 'PATCH', PATCH, command);
  assert.deepEqual(reply.body, { error: { code: 'identity_changed', notStarted: false, effectState: 'settled' } });
  assert.equal(receipts(db), 1);
}));


for (const kind of ['jwt', 'device', 'ck']) {
  test(`real ${kind} late GET revocation at json boundary never discloses payload`, async t => fixture(t, async ({ db, call }) => {
    const original = express.response.json; let raceWrites = 0;
    t.mock.method(express.response, 'json', function (this: express.Response, body: unknown) {
      if (body && typeof body === 'object' && Object.hasOwn(body, 'sessionId')) {
        db.prepare('UPDATE users SET authorization_generation=2').run(); raceWrites++;
      }
      return original.call(this, body);
    });
    const before = (changes(db) as { n: number }).n;
    const reply = await call(kind === 'jwt' ? jwtHeader() : kind === 'device' ? cookie : keyHeader);
    assert.deepEqual(reply.body, { error: { code: 'identity_changed', notStarted: true, effectState: 'not_started' } });
    assert.equal(raceWrites, 1); assert.equal((changes(db) as { n: number }).n - before, raceWrites,
      'only the separately attributed race setup write occurs; no auth/read/review writes');
    assert.equal(receipts(db), 0);
  }));
}

for (const replay of [false, true]) {
  for (const boundary of ['BEGIN IMMEDIATE', 'COMMIT']) {
    test(`CK same-row digest rotation at ${boundary} suppresses ${replay ? 'replay' : 'fresh transition'}`, async t => fixture(t, async ({ db, second, call }) => {
      if (replay) assert.equal((await call(keyHeader, 'PATCH', PATCH, command)).status, 200);
      const other = second(); const execute = db.exec.bind(db); let rotated = false;
      const replacementDigest = `sha256:${sha(`ck_${'8'.repeat(64)}`)}`;
      const rotate = (): void => { other.prepare('UPDATE api_keys SET key_digest=? WHERE id=7').run(replacementDigest); rotated = true; };
      t.mock.method(db, 'exec', (sql: string) => {
        if (sql === boundary && boundary === 'BEGIN IMMEDIATE') rotate();
        const result = execute(sql);
        if (sql === boundary && boundary === 'COMMIT') rotate();
        return result;
      });
      try {
        const before = receipts(db); const reply = await call(keyHeader, 'PATCH', PATCH, command);
        assert.equal(rotated, true); assert.equal(reply.status, 409);
        assert.deepEqual(reply.body, { error: { code: 'identity_changed', notStarted: false, effectState: 'settled' } });
        assert.equal(receipts(db), before + (boundary === 'COMMIT' && !replay ? 1 : 0));
        assert.equal(JSON.stringify(reply.body).includes(replacementDigest), false);
        assert.equal(JSON.stringify(reply.body).includes(KEY), false);
      } finally { other.close(); }
    }));
  }
}

async function rawCall(origin: string, method: string, url: string, headers: Record<string, string>, chunks: (string | Buffer)[] = []): Promise<{ status: number; body: string; retry?: string }> {
  return new Promise((resolve, reject) => {
    const req = request(origin + url, { method, headers }, res => {
      let body = ''; res.on('data', chunk => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode!, body, retry: res.headers['retry-after'] }));
    });
    req.on('error', reject); for (const chunk of chunks) req.write(chunk); req.end();
  });
}

test('production stack enforces exact byte boundary including chunked bodies before global parsers/auth', async t => fixture(t, async ({ db, origin }) => {
  const body = JSON.stringify(command); const headers = { ...keyHeader, 'Content-Type': 'application/json' };
  const bounded = body.padEnd(65_536, ' ');
  const accepted = await rawCall(origin, 'PATCH', PATCH, { ...headers, 'Content-Length': '65536' }, [bounded]);
  assert.equal(accepted.status, 200); assert.equal(receipts(db), 1);
  for (const chunked of [false, true]) {
    const before = changes(db);
    const reply = await rawCall(origin, 'PATCH', PATCH, { ...headers, ...(chunked ? { 'Transfer-Encoding': 'chunked' } : { 'Content-Length': '65537' }) }, [bounded, ' ']);
    assert.equal(reply.status, 413); assert.deepEqual(changes(db), before);
  }
}));

test('production parser media, encoding, GET body, malformed JSON and canonical path boundaries', async t => fixture(t, async ({ db, origin }) => {
  const cases: Array<[string, string, Record<string, string>, string | Buffer, number]> = [
    ['PATCH', PATCH, { 'Content-Type': 'application/json' }, '{', 400],
    ['PATCH', PATCH, { 'Content-Type': 'application/json' }, '', 400],
    ['PATCH', PATCH, { 'Content-Type': 'application/json' }, 'null', 400],
    ['PATCH', PATCH, { 'Content-Type': 'application/json' }, '[]', 400],
    ['PATCH', PATCH, { 'Content-Type': 'application/x-www-form-urlencoded' }, 'action=start_review', 415],
    ['PATCH', PATCH, { 'Content-Type': 'text/plain' }, '{}', 415],
    ['PATCH', PATCH, { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip' }, gzipSync('{}'), 415],
    ['GET', GET, { 'Content-Type': 'application/json' }, '{}', 400],
    ['PATCH', PATCH + '/', { 'Content-Type': 'application/json' }, '{}', 404],
    ['PATCH', PATCH.replace('sessions', 'Sessions'), { 'Content-Type': 'application/json' }, '{}', 404],
    ['PATCH', PATCH.replace('/s/', '/%73/'), { 'Content-Type': 'application/json' }, '{}', 404],
    ['POST', PATCH, { 'Content-Type': 'application/json' }, '{}', 404],
    ['OPTIONS', GET, {}, '', 404],
  ];
  const before = changes(db);
  for (const [method, url, headers, body, expected] of cases) {
    const reply = await rawCall(origin, method, url, { ...keyHeader, ...headers, 'Content-Length': String(Buffer.byteLength(body)) }, [body]);
    assert.equal(reply.status, expected, `${method} ${url} ${JSON.stringify(headers)}`);
  }
  assert.deepEqual(changes(db), before); assert.equal(receipts(db), 0);
}));

test('pre-parser IP quota rejects request121 before JSON or credential lookup with Retry-After', async t => fixture(t, async ({ db, origin }) => {
  const before = changes(db);
  for (let i = 0; i < 120; i++) assert.equal((await rawCall(origin, 'GET', GET, {})).status, 401);
  const reply = await rawCall(origin, 'PATCH', PATCH, { 'Content-Type': 'application/json', 'Content-Length': '1' }, ['{']);
  assert.equal(reply.status, 429); assert.ok(Number(reply.retry) > 0); assert.deepEqual(changes(db), before);
}));

for (const method of ['GET', 'PATCH']) {
  test(`authenticated ${method} quota aggregates JWT and two CKs for same user across IPs`, async t => fixture(t, async ({ db, origin }) => {
    const otherKey = `ck_${'9'.repeat(64)}`;
    db.prepare('INSERT INTO api_keys VALUES (8,1,?,1,NULL)').run(`sha256:${sha(otherKey)}`);
    const max = method === 'GET' ? 120 : 30; const before = changes(db);
    for (let i = 0; i <= max; i++) {
      const credentials = [keyHeader, jwtHeader(), { Authorization: `Bearer ${otherKey}` }][i % 3];
      const body = JSON.stringify(command);
      const reply = await rawCall(origin, method, method === 'GET' ? GET : PATCH,
        { ...credentials, 'cf-connecting-ip': `192.0.2.${i % 2 + 1}`, ...(method === 'PATCH' ? { 'Content-Type': 'application/json', 'Content-Length': String(body.length) } : {}) }, method === 'PATCH' ? [body] : []);
      assert.equal(reply.status, i < max ? 200 : 429);
      if (i === max) assert.ok(Number(reply.retry) > 0);
    }
    if (method === 'GET') assert.deepEqual(changes(db), before);
    assert.equal(receipts(db), method === 'GET' ? 0 : 1);
  }));
}

test('both actual global parsers skip canonical C4 and retain non-C4 parsing', async t => {
  const json = express.json; const urlencoded = express.urlencoded; let jsonCalls = 0; let formCalls = 0;
  t.mock.method(express, 'json', (options: Parameters<typeof json>[0]) => {
    const parser = json(options);
    return ((req, res, next) => { if (options?.limit === '1mb') jsonCalls++; parser(req, res, next); }) as express.RequestHandler;
  });
  t.mock.method(express, 'urlencoded', (options: Parameters<typeof urlencoded>[0]) => {
    const parser = urlencoded(options);
    return ((req, res, next) => { formCalls++; parser(req, res, next); }) as express.RequestHandler;
  });
  await fixture(t, async ({ call, origin }) => {
    assert.equal((await call(keyHeader)).status, 200);
    assert.equal((await call(keyHeader, 'PATCH', PATCH, command)).status, 200);
    assert.equal(jsonCalls, 0); assert.equal(formCalls, 0);
    assert.equal((await rawCall(origin, 'PATCH', PATCH + '/', { 'Content-Type': 'application/x-www-form-urlencoded' }, ['x=1'])).status, 404);
    assert.equal(jsonCalls, 1); assert.equal(formCalls, 1);
  });
});

for (const replay of [false, true]) {
  test(`CK enabled under BEGIN lock prevents B gate commit until A ends (${replay ? 'replay' : 'fresh'})`, async t => fixture(t, async ({ db, second, call }) => {
    if (replay) assert.equal((await call(keyHeader, 'PATCH', PATCH, command)).status, 200);
    const other = second(); const execute = db.exec.bind(db); let locked = false; let disabled = false;
    t.mock.method(db, 'exec', (sql: string) => {
      const result = execute(sql);
      if (sql === 'BEGIN IMMEDIATE') {
        assert.equal(db.inTransaction, true);
        assert.throws(() => other.prepare("UPDATE app_config SET value='0' WHERE key='external_api.enabled'").run(), { code: 'SQLITE_BUSY' });
        locked = true;
      }
      if (sql === 'COMMIT') { other.prepare("UPDATE app_config SET value='0' WHERE key='external_api.enabled'").run(); disabled = true; }
      return result;
    });
    try {
      const reply = await call(keyHeader, 'PATCH', PATCH, command);
      assert.equal(locked, true); assert.equal(disabled, true); assert.equal(receipts(db), 1);
      assert.deepEqual(reply.body, { error: { code: 'identity_changed', notStarted: false, effectState: 'settled' } });
    } finally { other.close(); }
  }));
}

test('device CSRF rejects wrong method/path and slot generation switch before BEGIN', async t => fixture(t, async ({ db, call, origin, capture }) => {
  for (const [method, url] of [['POST', PATCH], ['PATCH', PATCH + '-other']]) {
    const csrf = mintMutationCsrfToken(SECRET, 'device:device:slot:1', method, url)!.csrfToken;
    assert.equal((await call({ ...cookie, Origin: origin, 'x-csrf-token': csrf }, 'PATCH', PATCH, command)).status, 403);
    assert.equal(receipts(db), 0);
  }
  const csrf = mintMutationCsrfToken(SECRET, 'device:device:slot:1', 'PATCH', PATCH)!.csrfToken;
  capture.run = () => queueMicrotask(() => db.prepare('UPDATE device_sessions SET generation=2').run());
  const reply = await call({ ...cookie, Origin: origin, 'x-csrf-token': csrf }, 'PATCH', PATCH, command);
  assert.deepEqual(reply.body, { error: { code: 'identity_changed', notStarted: true, effectState: 'not_started' } });
  assert.equal(receipts(db), 0);
}));
