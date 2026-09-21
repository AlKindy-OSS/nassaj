/**
 * governance-preferences.routes.test — the WIRE CONTRACT of the per-engine
 * governance switch (owner decision 2026-08-08), pinned at the route.
 *
 * WHY A SEPARATE FILE FROM THE SERVICE TEST. The service test proves the switch
 * does the right thing to the disk; this one proves the client is told the right
 * thing about it. The frontend was built against this contract in parallel, so
 * the exact paths, the exact body shape and the exact field names are load-
 * bearing: a rename here is a broken screen there, and nothing else in the
 * system would notice. Every assertion below is on the literal wire shape.
 *
 *   GET  /api/governance/preferences            → { channels: [...] }
 *   PUT  /api/governance/preferences/:provider  → the channel, re-read from disk
 *
 * It also pins the two authorization rules that only exist at this layer:
 *   - the role gate is IN-HANDLER, so `/PREFERENCES/CODEX` cannot slip past it
 *     (Express routing is case-insensitive — the reason provider.routes.ts
 *     places its own skill/MCP gates in the handler too);
 *   - a refused request writes NOTHING: not a row, not a file.
 *
 * HOME is redirected to a sandbox for the whole file — every governance path is
 * derived from it, and a test that wrote into the real tree would strip live
 * members' governance.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after, before } from 'node:test';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

import express from 'express';

import {
  closeConnection,
  getConnection,
  initializeDatabase,
  userDb,
} from '@/modules/database/index.js';
import { setProviderSharingConfig } from '@/services/provider-sharing.js';
import { provisionUserDirs, invalidateProvisioned } from '@/services/isolation/provision-user-dirs.js';
import { AppError } from '@/shared/utils.js';

import governanceRouter from './governance-preferences.routes.js';

type TestUser = { id: number; role: string };
type Channel = {
  provider: string;
  mode: string;
  canManage: boolean;
  enforcement: string;
  reason?: string;
};

let currentUser: TestUser | null = null;
let server: Server;
let baseUrl = '';
let dbDir = '';
let sandboxHome = '';
let originalHome: string | undefined;
let memberUser: TestUser;
let ownerUser: TestUser;
let adminUser: TestUser;

async function call(
  method: string,
  urlPath: string,
  user: TestUser | null,
  body?: unknown,
): Promise<{ status: number; json: Record<string, unknown> }> {
  currentUser = user;
  const response = await fetch(`${baseUrl}${urlPath}`, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: response.status, json };
}

const codexAgents = (userId: number): string =>
  path.join(sandboxHome, '.nassaj-users', String(userId), '.codex', 'AGENTS.md');

const exemptionRows = (): { user_id: number; provider: string }[] =>
  getConnection().prepare('SELECT user_id, provider FROM governance_exemptions').all() as {
    user_id: number;
    provider: string;
  }[];

const entryExists = (target: string): boolean => {
  try {
    fs.lstatSync(target);
    return true;
  } catch {
    return false;
  }
};

before(async () => {
  closeConnection();
  dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gov-pref-routes-db-'));
  sandboxHome = fs.mkdtempSync(path.join(os.tmpdir(), 'gov-pref-routes-home-'));
  originalHome = process.env.HOME;
  process.env.HOME = sandboxHome;
  process.env.DATABASE_PATH = path.join(dbDir, 'db.sqlite');
  delete process.env.XDG_CONFIG_HOME;
  delete process.env.VITE_IS_PLATFORM;
  await initializeDatabase();

  // Seeded from the REAL operator source when present: synthetic fixtures give
  // false confidence (2026-06-28 lesson), and this material is what the copies
  // are fingerprinted against.
  fs.mkdirSync(path.join(sandboxHome, '.claude'), { recursive: true });
  let neutral: string;
  try {
    neutral = fs.readFileSync(path.join(String(originalHome), '.claude', 'AGENTS.md'), 'utf8');
  } catch {
    neutral = '<!-- GENERATED — DO NOT EDIT -->\n# AGENTS.md — دليل وكلاء نسّاج\n';
  }
  fs.writeFileSync(path.join(sandboxHome, '.claude', 'AGENTS.md'), neutral);
  fs.writeFileSync(path.join(sandboxHome, '.claude', 'CLAUDE.md'), neutral);
  fs.writeFileSync(path.join(sandboxHome, '.claude', 'NASSAJ.md'), neutral);
  fs.mkdirSync(path.join(sandboxHome, '.gemini'), { recursive: true });
  fs.writeFileSync(path.join(sandboxHome, '.gemini', 'GEMINI.md'), neutral);

  memberUser = userDb.createUser('gov_pref_member', 'hash', 'user') as TestUser;
  ownerUser = { ...(userDb.createUser('gov_pref_owner', 'hash', 'user') as TestUser), role: 'owner' };
  adminUser = { ...(userDb.createUser('gov_pref_admin', 'hash', 'user') as TestUser), role: 'admin' };

  setProviderSharingConfig({ codex: 'isolated', opencode: 'isolated', claude: 'isolated', agy: 'isolated' });
  for (const user of [memberUser, ownerUser, adminUser]) {
    invalidateProvisioned(user.id);
    provisionUserDirs(user.id);
  }

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { user: TestUser | null }).user = currentUser;
    next();
  });
  app.use('/api/governance', governanceRouter);
  app.use(
    (err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      if (err instanceof AppError) {
        res.status(err.statusCode).json({ error: err.message, code: err.code });
        return;
      }
      res.status(500).json({ error: String(err) });
    },
  );

  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  closeConnection();
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  fs.rmSync(dbDir, { recursive: true, force: true });
  fs.rmSync(sandboxHome, { recursive: true, force: true });
});

test('GET /preferences returns { channels } with the exact contract fields', async () => {
  const response = await call('GET', '/api/governance/preferences', memberUser);
  assert.equal(response.status, 200);

  const channels = response.json.channels as Channel[];
  assert.ok(Array.isArray(channels), 'the body must be { channels: [...] }, not an envelope');
  assert.deepEqual(
    channels.map((channel) => channel.provider),
    ['codex', 'opencode', 'kimi', 'antigravity', 'claude'],
  );

  for (const channel of channels) {
    assert.ok(['governed', 'exempt'].includes(channel.mode), 'mode is a two-value enum');
    assert.equal(typeof channel.canManage, 'boolean');
    assert.ok(
      ['fail-closed', 'best-effort', 'none'].includes(channel.enforcement),
      `enforcement must be one of the three contract values, got ${channel.enforcement}`,
    );
  }
  // The three fail-closed engines are declared as such — the switch has to tell a
  // member whether flipping it changes whether a launch is BLOCKED.
  const byProvider = new Map(channels.map((channel) => [channel.provider, channel]));
  assert.equal(byProvider.get('codex')?.enforcement, 'fail-closed');
  assert.equal(byProvider.get('opencode')?.enforcement, 'fail-closed');
  assert.equal(byProvider.get('kimi')?.enforcement, 'fail-closed');
  assert.equal(byProvider.get('antigravity')?.enforcement, 'best-effort');
  assert.equal(byProvider.get('claude')?.enforcement, 'none');
});

test('the read is open to a member, and canManage tracks the role', async () => {
  const member = (await call('GET', '/api/governance/preferences', memberUser))
    .json.channels as Channel[];
  assert.ok(member.every((channel) => channel.canManage === false), 'a member only watches');

  for (const elevated of [ownerUser, adminUser]) {
    const channels = (await call('GET', '/api/governance/preferences', elevated))
      .json.channels as Channel[];
    assert.ok(
      channels.every((channel) => channel.canManage),
      `${elevated.role} must be able to flip every channel`,
    );
  }
});

test('PUT exempt (admin) removes the file and answers with the re-read channel', async () => {
  const target = codexAgents(adminUser.id);
  assert.ok(entryExists(target), 'baseline: the admin tree is governed');

  const response = await call('PUT', '/api/governance/preferences/codex', adminUser, {
    mode: 'exempt',
  });
  assert.equal(response.status, 200);
  assert.equal(response.json.provider, 'codex');
  assert.equal(response.json.mode, 'exempt');
  assert.equal(response.json.canManage, true);
  assert.equal(response.json.enforcement, 'fail-closed');
  assert.equal(entryExists(target), false, 'the answer must reflect a real removal');

  // And the GET agrees — one truth, two answers.
  const channels = (await call('GET', '/api/governance/preferences', adminUser))
    .json.channels as Channel[];
  assert.equal(channels.find((channel) => channel.provider === 'codex')?.mode, 'exempt');

  // Put it back so later cases start from a governed tree.
  const restored = await call('PUT', '/api/governance/preferences/codex', adminUser, {
    mode: 'governed',
  });
  assert.equal(restored.json.mode, 'governed');
  assert.ok(entryExists(target), 're-binding must re-establish the material');
});

test('PUT exempt is refused for a member — no row, no file touched', async () => {
  const target = codexAgents(memberUser.id);
  const before = exemptionRows().length;

  const response = await call('PUT', '/api/governance/preferences/codex', memberUser, {
    mode: 'exempt',
  });
  assert.equal(response.status, 403);
  assert.equal(response.json.code, 'GOVERNANCE_MODE_FORBIDDEN');
  assert.ok(entryExists(target), 'a refused request must not remove anything');
  assert.equal(exemptionRows().length, before, 'a refused request must not record a row');
});

test('the role gate survives case-mangled paths (Express routing is case-insensitive)', async () => {
  const target = codexAgents(memberUser.id);
  const before = exemptionRows().length;

  const response = await call('PUT', '/api/governance/PREFERENCES/CODEX', memberUser, {
    mode: 'exempt',
  });
  // Whatever the router does with the casing, the ANSWER may never be a
  // successful exemption for a member: the gate reads req.user.role, not a path.
  assert.notEqual(response.status, 200);
  assert.ok(entryExists(target));
  assert.equal(exemptionRows().length, before);
});

test('a member may always bind themselves back under governance', async () => {
  // Seeded by an elevated actor's decision (the only way a member gets a row).
  getConnection()
    .prepare('INSERT INTO governance_exemptions (user_id, provider, granted_by, expires_at) VALUES (?, ?, ?, ?)')
    .run(memberUser.id, 'kimi', ownerUser.id, new Date(Date.now() + 60_000).toISOString());

  const response = await call('PUT', '/api/governance/preferences/kimi', memberUser, {
    mode: 'governed',
  });
  assert.equal(response.status, 200, 'binding yourself must never require elevation');
  assert.equal(response.json.mode, 'governed');
  assert.equal(
    exemptionRows().filter((row) => row.user_id === memberUser.id && row.provider === 'kimi').length,
    0,
  );
});

test('an unknown engine and an invalid mode are refused, and change nothing', async () => {
  const before = exemptionRows().length;

  const unknown = await call('PUT', '/api/governance/preferences/hermes', ownerUser, {
    mode: 'exempt',
  });
  assert.equal(unknown.status, 400);
  assert.equal(unknown.json.code, 'GOVERNANCE_CHANNEL_UNKNOWN');

  for (const body of [{ mode: 'off' }, { mode: true }, {}, { enabled: false }]) {
    const bad = await call('PUT', '/api/governance/preferences/codex', ownerUser, body);
    assert.equal(bad.status, 400, `body ${JSON.stringify(body)} must be refused`);
    assert.equal(bad.json.code, 'GOVERNANCE_MODE_INVALID');
  }
  assert.equal(exemptionRows().length, before);
});

test('an unidentified caller can neither read a manageable switch nor write', async () => {
  const channels = (await call('GET', '/api/governance/preferences', null))
    .json.channels as Channel[];
  assert.ok(
    channels.every((channel) => channel.canManage === false),
    'no identity ⇒ no switch',
  );

  const write = await call('PUT', '/api/governance/preferences/codex', null, { mode: 'exempt' });
  assert.equal(write.status, 403);
});

test('the audit row is written by the request path, naming user, engine and actor', async () => {
  await call('PUT', '/api/governance/preferences/opencode', ownerUser, { mode: 'exempt' });

  const row = getConnection()
    .prepare(
      `SELECT user_id, metadata FROM audit_log
        WHERE action = 'governance_exemption_granted' ORDER BY id DESC LIMIT 1`,
    )
    .get() as { user_id: number; metadata: string };

  assert.equal(row.user_id, ownerUser.id);
  const metadata = JSON.parse(row.metadata) as Record<string, unknown>;
  assert.equal(metadata.provider, 'opencode');
  assert.equal(metadata.role, 'owner');
  assert.equal(metadata.enforcement, 'fail-closed');
  assert.equal(metadata.resultMode, 'exempt');
  assert.equal(typeof metadata.expiresAt, 'string');
  assert.equal('paths' in metadata, false, 'audit metadata must not expose host paths');
});
