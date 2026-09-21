import assert from 'node:assert/strict';
import fs from 'node:fs';
import { IncomingMessage, ServerResponse } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test, { after, before } from 'node:test';
import { Writable } from 'node:stream';

import express from 'express';

import {
  closeConnection,
  getConnection,
  initializeDatabase,
  userDb,
} from '@/modules/database/index.js';
import { AppError } from '@/shared/utils.js';

import referenceMaterialsRouter from './reference-materials.routes.js';

type TestUser = { id: number; role: string };

let currentUser: TestUser | null = null;
let app: express.Express;
let dbDir = '';
let sandboxHome = '';
let originalHome: string | undefined;
let memberUser: TestUser;
let ownerUser: TestUser;

async function call(
  method: string,
  urlPath: string,
  user: TestUser | null,
  body?: unknown,
): Promise<{ status: number; json: Record<string, unknown> }> {
  currentUser = user;
  const rawBody = body === undefined ? null : JSON.stringify(body);
  const chunks: Buffer[] = [];
  const requestSocket = new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    },
  }) as Writable & { remoteAddress?: string };
  requestSocket.remoteAddress = '127.0.0.1';
  // Express installs IncomingMessage's prototype. Its constructor must also run:
  // newer Node versions keep abort bookkeeping in private symbol fields.
  const req = new IncomingMessage(requestSocket as never) as express.Request;
  req._read = function read() {
    this.push(rawBody);
    this.push(null);
  };
  req.method = method;
  req.url = urlPath;
  req.headers = rawBody === null
    ? {}
    : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(rawBody).toString() };

  const res = new ServerResponse(req);
  const socket = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      callback();
    },
  });
  Object.assign(socket, {
    writable: true,
    cork() {},
    uncork() {},
    destroySoon() {},
  });
  res.assignSocket(socket as never);

  await new Promise<void>((resolve, reject) => {
    res.on('finish', resolve);
    app.handle(req, res as express.Response, reject);
  });

  const responseBody = Buffer.concat(chunks).toString('utf8');
  const start = responseBody.indexOf('\r\n\r\n');
  const jsonText = start >= 0 ? responseBody.slice(start + 4) : responseBody;
  const json = JSON.parse(jsonText || '{}') as Record<string, unknown>;
  return { status: res.statusCode, json };
}

const memoryFile = (): string => path.join(sandboxHome, '.claude', 'memory', 'MEMORY.md');

before(async () => {
  closeConnection();
  dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'refs-routes-db-'));
  sandboxHome = fs.mkdtempSync(path.join(os.tmpdir(), 'refs-routes-home-'));
  originalHome = process.env.HOME;
  process.env.HOME = sandboxHome;
  process.env.DATABASE_PATH = path.join(dbDir, 'a.db');
  delete process.env.VITE_IS_PLATFORM;
  await initializeDatabase();

  fs.mkdirSync(path.dirname(memoryFile()), { recursive: true });
  fs.writeFileSync(memoryFile(), '# baseline memory\n', 'utf8');

  memberUser = userDb.createUser('refs_member', 'hash', 'user') as TestUser;
  ownerUser = { ...(userDb.createUser('refs_owner', 'hash', 'user') as TestUser), role: 'owner' };

  app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { user: TestUser | null }).user = currentUser;
    next();
  });
  app.use('/api/references', referenceMaterialsRouter);
  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (err instanceof AppError) {
      res.status(err.statusCode).json({ success: false, error: { code: err.code, message: err.message } });
      return;
    }
    res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message: String(err) } });
  });
});

after(async () => {
  closeConnection();
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  fs.rmSync(dbDir, { recursive: true, force: true });
  fs.rmSync(sandboxHome, { recursive: true, force: true });
});

async function firstMemoryId(user: TestUser): Promise<string> {
  const response = await call('GET', '/api/references/memory', user);
  assert.equal(response.status, 200);
  const data = response.json.data as { canManage: boolean; entries: Array<{ id: string }> };
  assert.equal(data.canManage, user.role === 'owner');
  assert.ok(data.entries.length > 0);
  return data.entries[0].id;
}

test('member read succeeds and reports read-only capability', async () => {
  const id = await firstMemoryId(memberUser);
  const response = await call('GET', `/api/references/memory/${id}`, memberUser);
  assert.equal(response.status, 200);
  const item = (response.json.data as { item: { content: string; affectedScope: string; canEdit: boolean } }).item;
  assert.equal(item.content, '# baseline memory\n');
  assert.equal(item.affectedScope, 'all_members');
  assert.equal(item.canEdit, false);
});

test('member write is rejected', async () => {
  const id = await firstMemoryId(memberUser);
  const response = await call('PUT', `/api/references/memory/${id}`, memberUser, {
    content: '# denied\n',
  });
  assert.equal(response.status, 403);
  assert.equal(fs.readFileSync(memoryFile(), 'utf8'), '# baseline memory\n');
});

test('owner write succeeds and records audit_log', async () => {
  const id = await firstMemoryId(ownerUser);
  const response = await call('PUT', `/api/references/memory/${id}`, ownerUser, {
    content: '# owner update\n',
  });
  assert.equal(response.status, 200, JSON.stringify(response.json));
  assert.equal(fs.readFileSync(memoryFile(), 'utf8'), '# owner update\n');

  const rows = getConnection()
    .prepare('SELECT action, metadata FROM audit_log WHERE action = ?')
    .all('reference_material_updated') as Array<{ action: string; metadata: string }>;
  assert.equal(rows.length, 1);
  const metadata = JSON.parse(rows[0].metadata) as { affectedScope: string };
  assert.equal(metadata.affectedScope, 'all_members');
});

test('client-supplied path is rejected and cannot aim the write outside the root', async () => {
  const id = await firstMemoryId(ownerUser);
  const outside = path.join(sandboxHome, 'outside.md');
  fs.writeFileSync(outside, 'outside\n', 'utf8');

  const response = await call('PUT', `/api/references/memory/${id}`, ownerUser, {
    path: outside,
    content: '# should not land outside\n',
  });
  assert.equal(response.status, 400);
  assert.equal(fs.readFileSync(outside, 'utf8'), 'outside\n');
});

test('a symlinked material is never exposed as readable content', async () => {
  const outside = path.join(sandboxHome, 'outside-secret.md');
  const linked = path.join(sandboxHome, '.claude', 'memory', 'linked.md');
  fs.writeFileSync(outside, 'do not expose\n', 'utf8');
  fs.symlinkSync(outside, linked);

  const response = await call('GET', '/api/references/memory?pageSize=100', memberUser);
  assert.equal(response.status, 200);
  const entries = (response.json.data as { entries: Array<{ title: string }> }).entries;
  assert.equal(entries.some((entry) => entry.title === 'linked.md'), false);
});

test('a governed Antigravity instruction link is readable only through its declared core target', async () => {
  const originalHomedir = os.homedir;
  (os as unknown as { homedir: () => string }).homedir = () => sandboxHome;
  try {
    const source = path.join(sandboxHome, 'nassaj-core', 'GEMINI.md');
    const channel = path.join(sandboxHome, '.gemini', 'GEMINI.md');
    fs.mkdirSync(path.dirname(source), { recursive: true });
    fs.mkdirSync(path.dirname(channel), { recursive: true });
    fs.writeFileSync(source, '# governed antigravity\n', 'utf8');
    fs.symlinkSync(source, channel);

    const listed = await call('GET', '/api/references/instructions?pageSize=100', null);
    assert.equal(listed.status, 200, JSON.stringify(listed.json));
    const entries = (listed.json.data as {
      entries: Array<{ id: string; provider: string; metadata?: { channelId?: string } }>;
    }).entries;
    const agyHome = entries.find((entry) => (
      entry.provider === 'antigravity' && entry.metadata?.channelId === 'agy-home'
    ));
    assert.ok(agyHome, 'the governed agy-home channel must be listed');

    const read = await call('GET', `/api/references/instructions/${agyHome.id}`, null);
    assert.equal(read.status, 200, JSON.stringify(read.json));
    const item = (read.json.data as { item: { content: string | null } }).item;
    assert.equal(item.content, '# governed antigravity\n', JSON.stringify(agyHome));
  } finally {
    (os as unknown as { homedir: () => string }).homedir = originalHomedir;
  }
});

test('concurrent creates are atomic no-clobber', async () => {
  const [first, second] = await Promise.all([
    call('POST', '/api/references/memory', ownerUser, { name: 'race', content: 'first' }),
    call('POST', '/api/references/memory', ownerUser, { name: 'race', content: 'second' }),
  ]);
  assert.deepEqual([first.status, second.status].sort(), [201, 409]);
  const written = fs.readFileSync(path.join(sandboxHome, '.claude', 'memory', 'race.md'), 'utf8');
  assert.ok(written === 'first\n' || written === 'second\n');
});

test('unsupported create is rejected before an audit success or intent is recorded', async () => {
  const beforeCount = (getConnection()
    .prepare("SELECT COUNT(*) AS count FROM audit_log WHERE action LIKE 'reference_material_%'")
    .get() as { count: number }).count;
  const response = await call('POST', '/api/references/agents', ownerUser, {
    name: 'not-supported',
    content: '# no write',
  });
  assert.equal(response.status, 400);
  const afterCount = (getConnection()
    .prepare("SELECT COUNT(*) AS count FROM audit_log WHERE action LIKE 'reference_material_%'")
    .get() as { count: number }).count;
  assert.equal(afterCount, beforeCount);
});

test('platform mode rejects writes even for an owner', async () => {
  process.env.VITE_IS_PLATFORM = 'true';
  try {
    const response = await call('POST', '/api/references/memory', ownerUser, {
      name: 'platform-denied',
      content: 'denied',
    });
    assert.equal(response.status, 403);
    assert.equal(fs.existsSync(path.join(sandboxHome, '.claude', 'memory', 'platform-denied.md')), false);
  } finally {
    delete process.env.VITE_IS_PLATFORM;
  }
});
