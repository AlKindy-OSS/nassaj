/**
 * provider-sharing-retired.test — ADR-152 amendment 1 (T-2083, B-1741).
 *
 * The install-wide `provider_sharing` policy is retired: isolation is a code
 * constant, and another user's credential is reachable only through a grant its
 * owner made (ADR-152). This file holds the owner-term acceptance tests of §6
 * (AT1, AT4, AT5) plus the two structural guards of §3.1:
 *
 *   - a resolver sweep over every KNOWN_PROVIDERS entry: a member without a
 *     credential or grant never receives the operator's HOME / CONFIG_DIR, even
 *     when the retired policy row still says `shared` in the database;
 *   - a static guard: the retired policy API cannot reappear anywhere in
 *     server/, shared/ or src/ outside the retirement modules.
 *
 * Every §6 case is a real assertion here (batch C closed the last todos: the
 * credential gate, the inert install-wide key and the grant-route mirror).
 *
 * Runner: node:test. Sandboxed $HOME + throwaway DB opened before any import.
 */

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

import Database from 'better-sqlite3';
import express from 'express';

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'nassaj-sharing-retired-test-'));
const ORIGINAL_HOME = process.env.HOME;
const ORIGINAL_DB = process.env.DATABASE_PATH;
const ORIGINAL_SECRETS_KEY = process.env.NASSAJ_PROVIDER_SECRETS_KEY;
const operatorHome = path.join(sandbox, 'home');
fs.mkdirSync(operatorHome, { recursive: true });
process.env.HOME = operatorHome;
process.env.DATABASE_PATH = path.join(sandbox, 'test-db.sqlite');
process.env.NASSAJ_PROVIDER_SECRETS_KEY = crypto.randomBytes(32).toString('base64');
assert.equal(os.homedir(), operatorHome);

const { initializeDatabase, closeConnection, appConfigDb, auditLogDb, credentialGrantsDb, userDb } = await import('@/modules/database/index.js');
const { KNOWN_PROVIDERS } = await import('./known-providers.js');
const { resolveProviderEnv } = await import('./resolve-provider-env.js');
const { _resetProviderSecretsServerKeyCache, setSharedVendorKey } = await import('./provider-secrets-store.js');
const { assertCredentialLinked, resolveModelRunEnv } = await import('./credential-gate.js');
const { applyClaudeEngineProviderEnv } = await import('./apply-claude-engine-provider-env.js');
const { resolveVendorCatalogKey } = await import('@/modules/providers/shared/vendor/vendor-catalog-key.js');
const { presentGrantedStatus } = await import('@/modules/providers/services/provider-auth.service.js');
const { default: adminRouter } = await import('@/routes/admin.js');
const { default: credentialGrantsRouter } = await import('@/routes/credential-grants.js');
const { retireProviderSharing } = await import('@/modules/database/provider-sharing-retirement.migration.js');
const { pruneAuditLog, RETAINED_AUDIT_ACTIONS } = await import('@/modules/database/migrations.js');

await initializeDatabase();

after(() => {
  closeConnection();
  if (ORIGINAL_HOME === undefined) delete process.env.HOME; else process.env.HOME = ORIGINAL_HOME;
  if (ORIGINAL_DB === undefined) delete process.env.DATABASE_PATH; else process.env.DATABASE_PATH = ORIGINAL_DB;
  if (ORIGINAL_SECRETS_KEY === undefined) delete process.env.NASSAJ_PROVIDER_SECRETS_KEY;
  else process.env.NASSAJ_PROVIDER_SECRETS_KEY = ORIGINAL_SECRETS_KEY;
  _resetProviderSecretsServerKeyCache();
  fs.rmSync(sandbox, { recursive: true, force: true });
});

/** The retired policy as a deployed node stored it, plus every other provider: all shared. */
const STALE_SHARED_POLICY = JSON.stringify(Object.fromEntries(KNOWN_PROVIDERS.map((p: string) => [p, 'shared'])));

/** The operator's own trees, as a server process inherits them. */
const OPERATOR_ENV: NodeJS.ProcessEnv = Object.freeze({
  PATH: '/usr/bin',
  HOME: operatorHome,
  CLAUDE_CONFIG_DIR: path.join(operatorHome, '.claude'),
  CODEX_HOME: path.join(operatorHome, '.codex'),
  KIMI_CODE_HOME: path.join(operatorHome, '.kimi'),
  XDG_DATA_HOME: path.join(operatorHome, '.local', 'share'),
  XDG_CONFIG_HOME: path.join(operatorHome, '.config'),
  XDG_CACHE_HOME: path.join(operatorHome, '.cache'),
  XDG_STATE_HOME: path.join(operatorHome, '.local', 'state'),
});

/**
 * The credential knob(s) each provider reads, per mode. A provider added to
 * KNOWN_PROVIDERS without an entry here fails the sweep (fail closed): its
 * isolation must be stated before it ships. Hosted vendors read a key value,
 * not a tree (kimi's native agent CLI and its tree knob were removed, ADR-229).
 */
const CREDENTIAL_KNOBS: Record<string, { chat: string[]; agent: string[] }> = {
  claude: { chat: ['CLAUDE_CONFIG_DIR'], agent: ['CLAUDE_CONFIG_DIR'] },
  codex: { chat: ['CODEX_HOME'], agent: ['CODEX_HOME'] },
  agy: { chat: ['HOME'], agent: ['HOME'] },
  cursor: { chat: ['HOME'], agent: ['HOME'] },
  qwen: { chat: ['HOME'], agent: ['HOME'] },
  opencode: { chat: ['XDG_DATA_HOME', 'XDG_CONFIG_HOME'], agent: ['XDG_DATA_HOME', 'XDG_CONFIG_HOME'] },
  kimi: { chat: [], agent: [] },
  deepseek: { chat: [], agent: [] },
  glm: { chat: [], agent: [] },
  // T-2086: dsh keys every path off HOME (its launcher derives DSH_HOME from it).
  dsh: { chat: ['HOME'], agent: ['HOME'] },
};

/** Operator credential locations no member env may point into. */
const OPERATOR_CREDENTIAL_ROOTS = [
  OPERATOR_ENV.CLAUDE_CONFIG_DIR, OPERATOR_ENV.CODEX_HOME, OPERATOR_ENV.KIMI_CODE_HOME,
  OPERATOR_ENV.XDG_DATA_HOME, OPERATOR_ENV.XDG_CONFIG_HOME,
  path.join(operatorHome, '.gemini'), path.join(operatorHome, '.cursor'), path.join(operatorHome, '.qwen'),
] as string[];

const isInside = (child: string, parent: string) => child === parent || child.startsWith(`${parent}${path.sep}`);
const memberRoot = (id: number) => path.join(operatorHome, '.nassaj-users', String(id));

/**
 * Asserts `env` (built for member `id`, provider `provider`) carries no
 * operator credential location: every knob the provider reads sits in the
 * member's own tree, and no value anywhere in the env names an operator
 * credential root.
 */
function assertMemberOwnTree(env: NodeJS.ProcessEnv, id: number, provider: string, mode: 'chat' | 'agent'): void {
  const label = `${provider}/${mode}/member ${id}`;
  for (const knob of CREDENTIAL_KNOBS[provider][mode]) {
    const value = env[knob];
    assert.ok(typeof value === 'string' && isInside(value, memberRoot(id)), `${label}: ${knob}=${value} is not the member's tree`);
  }
  const usedKnobs = new Set(CREDENTIAL_KNOBS[provider][mode]);
  for (const [name, value] of Object.entries(env)) {
    if (typeof value !== 'string' || usedKnobs.has(name)) continue;
    // A knob this provider never reads may keep the inherited value (claude
    // ignores XDG_*); only the knobs it reads decide whose credential it uses.
    if (name in OPERATOR_ENV) continue;
    for (const root of OPERATOR_CREDENTIAL_ROOTS) {
      assert.ok(!isInside(value, root), `${label}: ${name}=${value} points into operator ${root}`);
    }
  }
}

describe('§3.1 resolver sweep over KNOWN_PROVIDERS', () => {
  before(() => appConfigDb.set('provider_sharing', STALE_SHARED_POLICY));

  it('every known provider declares its credential knob in this sweep', () => {
    assert.deepEqual([...KNOWN_PROVIDERS].sort(), Object.keys(CREDENTIAL_KNOBS).sort());
  });

  it('a member with no credential and no grant never gets the operator tree, stored `shared` or not', () => {
    const member = userDb.createUser('sweep-member', 'hash', 'user');
    for (const provider of KNOWN_PROVIDERS as string[]) {
      for (const mode of ['chat', 'agent'] as const) {
        for (const honorGrants of [true, false]) {
          const env = resolveProviderEnv(member.id, provider, { ...OPERATOR_ENV }, mode, { honorGrants });
          assertMemberOwnTree(env, member.id, provider, mode);
        }
      }
    }
  });

  it('an admin or owner is isolated exactly like a member', () => {
    for (const role of ['admin', 'owner']) {
      const user = userDb.createUser(`sweep-${role}`, 'hash', role);
      for (const provider of KNOWN_PROVIDERS as string[]) {
        assertMemberOwnTree(resolveProviderEnv(user.id, provider, { ...OPERATOR_ENV }), user.id, provider, 'chat');
      }
    }
  });
});

describe('AT1 — a member with no credential and no grant is refused', () => {
  before(() => appConfigDb.set('provider_sharing', STALE_SHARED_POLICY));

  it('no environment pointing at the operator tree is built (claude, codex, agy, cursor, opencode, kimi, deepseek, glm)', () => {
    const ebtehal = userDb.createUser('ebtehal-at1', 'hash', 'user');
    for (const provider of ['claude', 'codex', 'agy', 'cursor', 'opencode', 'kimi', 'deepseek', 'glm']) {
      assertMemberOwnTree(resolveProviderEnv(ebtehal.id, provider, { ...OPERATOR_ENV }), ebtehal.id, provider, 'chat');
    }
  });

  it('refused with CREDENTIAL_NOT_LINKED (Arabic message, link_own + request_share) on every harness; nothing is built', () => {
    const ebtehal = userDb.createUser('ebtehal-at1-gate', 'hash', 'user');
    const harnesses: Array<[string, string, string]> = [
      ['claude', 'claude', 'agents/claude'], ['codex', 'codex', 'agents/codex'],
      ['agy', 'antigravity', 'agents/antigravity'], ['cursor', 'cursor', 'agents/cursor'],
      ['opencode', 'opencode', 'agents/opencode'], ['kimi', 'kimi', 'agents/kimi'],
      ['deepseek', 'deepseek', 'agents/deepseek'], ['glm', 'glm', 'agents/glm'],
    ];
    for (const [provider, uiProvider, anchor] of harnesses) {
      for (const mode of ['chat', 'agent'] as const) {
        let caught: any = null;
        try {
          resolveModelRunEnv(ebtehal.id, provider as never, { ...OPERATOR_ENV }, mode);
        } catch (error) {
          caught = error;
        }
        assert.ok(caught, `${provider}/${mode} was not refused`);
        assert.equal(caught.code, 'CREDENTIAL_NOT_LINKED', provider);
        assert.equal(caught.statusCode, 409, provider);
        assert.deepEqual(
          { ...caught.details, messageAr: undefined },
          { code: 'CREDENTIAL_NOT_LINKED', provider: uiProvider, reason: 'not_linked',
            actions: ['link_own', 'request_share'], settingsAnchor: anchor, messageAr: undefined },
          provider,
        );
        assert.match(caught.details.messageAr, /[؀-ۿ]/, `${provider}: Arabic message`);
      }
    }
    // The gate ran before the resolver: not even her own tree was provisioned.
    assert.equal(fs.existsSync(memberRoot(ebtehal.id)), false, 'no environment was built');
  });
});

describe('AT4 — no admin can make another person\'s credential usable', () => {
  let server: Server;
  let baseUrl = '';
  let currentUser: { id: number; role: string } | null = null;

  before(async () => {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as express.Request & { user?: unknown }).user = currentUser ?? undefined;
      next();
    });
    app.use('/api/admin', adminRouter);
    await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  after(() => new Promise<void>((resolve) => server.close(() => resolve())));

  const call = async (method: 'GET' | 'PUT', user: { id: number; role: string }, body?: unknown) => {
    currentUser = user;
    const res = await fetch(`${baseUrl}/api/admin/provider-sharing`, {
      method,
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() as Record<string, any> };
  };

  const auditCount = () => auditLogDb.recent(1000).length;

  for (const method of ['GET', 'PUT'] as const) {
    it(`${method} /api/admin/provider-sharing returns 410 for owner and admin, writes nothing, audits nothing`, async () => {
      appConfigDb.delete('provider_sharing');
      for (const role of ['owner', 'admin']) {
        const before = auditCount();
        const { status, body } = await call(method, { id: 1, role }, method === 'PUT' ? { claude: 'shared' } : undefined);
        assert.equal(status, 410);
        assert.equal(body.error.code, 'PROVIDER_SHARING_RETIRED');
        assert.equal(body.error.replacement, '/api/credential-grants');
        assert.ok(typeof body.error.message === 'string' && body.error.message.length > 0);
        assert.ok(typeof body.error.messageAr === 'string' && /[؀-ۿ]/.test(body.error.messageAr));
        assert.equal(auditCount(), before, `${method} as ${role} wrote an audit row`);
      }
      assert.equal(appConfigDb.get('provider_sharing'), null, `${method} wrote the retired policy`);
    });
  }

  it('a member still gets 403 (the handlers stay behind requireRole)', async () => {
    const { status } = await call('PUT', { id: 2, role: 'user' }, { claude: 'shared' });
    assert.equal(status, 403);
  });

  it('`provider_sharing` set to {"claude":"shared"} by SQL still leaves Ebtehal on her own tree', () => {
    appConfigDb.set('provider_sharing', '{"claude":"shared"}');
    const ebtehal = userDb.createUser('ebtehal-at4', 'hash', 'user');
    assertMemberOwnTree(resolveProviderEnv(ebtehal.id, 'claude', { ...OPERATOR_ENV }), ebtehal.id, 'claude', 'chat');
  });

  it('grant routes cannot name another owner: the grant is always the caller\'s own', async () => {
    const app = express();
    app.use(express.json());
    let caller: { id: number; role: string } | null = null;
    app.use((req, _res, next) => { (req as express.Request & { user?: unknown }).user = caller ?? undefined; next(); });
    app.use('/api/credential-grants', credentialGrantsRouter);
    const grantsServer: Server = await new Promise((resolve) => { const s2 = app.listen(0, '127.0.0.1', () => resolve(s2)); });
    const url = `http://127.0.0.1:${(grantsServer.address() as AddressInfo).port}/api/credential-grants`;
    try {
      const owner = userDb.createUser('at4-grant-owner', 'hash', 'owner');
      const admin = userDb.createUser('at4-grant-admin', 'hash', 'admin');
      const ebtehal = userDb.createUser('ebtehal-at4-grant', 'hash', 'user');
      // An admin tries to grant the OWNER's claude to Ebtehal by naming him.
      caller = { id: admin.id, role: 'admin' };
      const put = await fetch(`${url}/claude/grantees`, {
        method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ userIds: [ebtehal.id], ownerUserId: owner.id, owner: owner.id }),
      });
      assert.equal(put.status, 200);
      assert.deepEqual(credentialGrantsDb.listByOwner(owner.id), [], 'nothing was granted from the owner');
      assert.deepEqual(credentialGrantsDb.listByOwner(admin.id).map((r: any) => r.granteeUserId), [ebtehal.id],
        'the only grant made is the caller\'s own');
      // Ebtehal cannot pick an owner who never offered a grant.
      caller = { id: ebtehal.id, role: 'user' };
      const use = await fetch(`${url}/claude/use`, {
        method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ownerUserId: owner.id }),
      });
      assert.equal(use.status, 404);
      // The admin's grant does not make the owner's credential reachable either.
      assert.throws(() => assertCredentialLinked({ actor: ebtehal.id, provider: 'claude' }),
        (error: any) => error.code === 'CREDENTIAL_NOT_LINKED' && error.details.reason === 'grantor_not_linked'
          && error.details.grantorUsername === 'at4-grant-admin');
    } finally {
      await new Promise<void>((resolve) => grantsServer.close(() => resolve()));
    }
  });

  it('an install-wide vendor key on disk still refuses her (§3.8, D1)', () => {
    const ebtehal = userDb.createUser('ebtehal-at4-orgkey', 'hash', 'user');
    for (const slot of ['kimi', 'deepseek', 'glm'] as const) {
      setSharedVendorKey(slot, `sk-install-wide-${slot}`);
      assert.throws(() => assertCredentialLinked({ actor: ebtehal.id, provider: slot }), { code: 'CREDENTIAL_NOT_LINKED' }, slot);
      const env = resolveProviderEnv(ebtehal.id, slot, { ...OPERATOR_ENV }, 'agent');
      for (const value of Object.values(env)) assert.notEqual(value, `sk-install-wide-${slot}`, `${slot}: key reached the env`);
      assert.equal(resolveVendorCatalogKey(ebtehal.id, slot), null, `${slot}: catalog key`);
      assert.equal(resolveVendorCatalogKey(null, slot), null, `${slot}: anonymous catalog key`);
    }
    for (const engine of ['kimi', 'glm']) {
      const engineEnv: NodeJS.ProcessEnv = {};
      assert.deepEqual(applyClaudeEngineProviderEnv(engineEnv, ebtehal.id, engine),
        { status: 'unavailable', provider: engine, reason: 'missing_key' });
      assert.equal(engineEnv.ANTHROPIC_AUTH_TOKEN, undefined);
      assert.throws(() => assertCredentialLinked({ actor: ebtehal.id, provider: 'claude', engine }),
        { code: 'CREDENTIAL_NOT_LINKED' }, `claude on the ${engine} engine`);
    }
  });
  it('a resolver called with null throws CREDENTIAL_ACTOR_REQUIRED and builds nothing (§3.4)', () => {
    for (const provider of KNOWN_PROVIDERS as string[]) {
      assert.throws(() => resolveProviderEnv(null as never, provider, { ...OPERATOR_ENV }), { code: 'CREDENTIAL_ACTOR_REQUIRED' });
    }
  });
  it('an inherited CLAUDE_CODE_OAUTH_TOKEN or OPENAI_API_KEY reaches no child (§3.5)', () => {
    const ebtehal = userDb.createUser('ebtehal-at4-strip', 'hash', 'user');
    const inheritedEnv = { ...OPERATOR_ENV, CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-operator', OPENAI_API_KEY: 'sk-operator' };
    for (const provider of KNOWN_PROVIDERS as string[]) {
      const env = resolveProviderEnv(ebtehal.id, provider, { ...inheritedEnv });
      assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, undefined, provider);
      assert.equal(env.OPENAI_API_KEY, undefined, provider);
    }
  });
});

describe('§3.9 status — a grantee sees the grantor\'s username, never an email', () => {
  it('replaces the grantor\'s email with their username; an own credential keeps its email', () => {
    const owner = userDb.createUser('status-grantor', 'hash', 'owner');
    const ebtehal = userDb.createUser('ebtehal-status', 'hash', 'user');
    credentialGrantsDb.grant(owner.id, ebtehal.id, 'claude');
    const grantorStatus = {
      installed: true, provider: 'claude' as const, authenticated: true,
      email: 'owner@example.com', method: 'credentials_file',
    };
    const shown = presentGrantedStatus(grantorStatus, ebtehal.id, 'claude');
    assert.equal(shown.email, null);
    assert.deepEqual(shown.grantedBy, { userId: owner.id, username: 'status-grantor' });
    assert.ok(!JSON.stringify(shown).includes('owner@example.com'), 'the email leaked');
    // Own credential: unchanged.
    assert.deepEqual(presentGrantedStatus(grantorStatus, owner.id, 'claude'), { ...grantorStatus, grantedBy: null });
    // No member: nothing about anyone.
    assert.equal(presentGrantedStatus(grantorStatus, null, 'claude').email, null);
    credentialGrantsDb.revoke(owner.id, ebtehal.id, 'claude');
  });
});

describe('AT5 — migration retire_provider_sharing_v1 is idempotent (§3.2)', () => {
  /** A scratch database with only the tables the migration and prune touch. */
  function scratchDb(): import('better-sqlite3').Database {
    const db = new Database(path.join(sandbox, `at5-${crypto.randomBytes(4).toString('hex')}.sqlite`));
    db.exec(`CREATE TABLE app_config (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT, role TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active', is_active INTEGER NOT NULL DEFAULT 1);
      CREATE TABLE audit_log (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, action TEXT NOT NULL,
        metadata TEXT, ip_address TEXT, user_agent TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP);
      INSERT INTO users (id, username, role) VALUES (1, 'owner', 'owner'), (6, 'ebtehal', 'user'), (7, 'admin', 'admin');
      INSERT INTO users (id, username, role, status, is_active) VALUES (8, 'gone', 'user', 'disabled', 0);`);
    return db;
  }
  const RAW = '{"claude":"shared","agy":"shared","codex":"isolated","opencode":"shared"}';
  const seedPolicy = (db: import('better-sqlite3').Database) =>
    db.prepare("INSERT INTO app_config (key, value) VALUES ('provider_sharing', ?)").run(RAW);
  const snapshot = (db: import('better-sqlite3').Database) =>
    db.prepare('SELECT * FROM provider_sharing_retirement').all() as Array<Record<string, unknown>>;
  const retiredAudits = (db: import('better-sqlite3').Database) =>
    db.prepare("SELECT * FROM audit_log WHERE action = 'provider_sharing_retired'").all() as Array<Record<string, unknown>>;
  const storedPolicy = (db: import('better-sqlite3').Database) =>
    (db.prepare("SELECT value FROM app_config WHERE key = 'provider_sharing'").get() as { value: string } | undefined)?.value;

  it('a database holding provider_sharing gets one snapshot row, one strict audit row, and loses the key', () => {
    const db = scratchDb();
    seedPolicy(db);
    assert.equal(retireProviderSharing(db, { orgKeyProviders: () => ['kimi'] }), 'retired');
    const [row] = snapshot(db);
    assert.equal(snapshot(db).length, 1);
    assert.equal(row.id, 1);
    assert.equal(row.raw_policy, RAW, 'the stored text, verbatim');
    assert.deepEqual(JSON.parse(String(row.shared_providers)), ['claude', 'agy', 'opencode']);
    assert.deepEqual(JSON.parse(String(row.org_key_providers)), ['kimi']);
    assert.deepEqual(JSON.parse(String(row.members_at_retirement)), [6, 7], 'active non-owner members');
    assert.equal(row.notice_acknowledged_at, null);
    assert.equal(row.notice_acknowledged_by, null);
    const audits = retiredAudits(db);
    assert.equal(audits.length, 1);
    assert.equal(audits[0].user_id, null);
    assert.deepEqual(JSON.parse(String(audits[0].metadata)), {
      rawPolicy: RAW, sharedProviders: ['claude', 'agy', 'opencode'], orgKeyProviders: ['kimi'], memberCount: 2,
    });
    assert.equal(storedPolicy(db), undefined, 'the key is gone');
    db.close();
  });

  it('a second boot changes nothing', () => {
    const db = scratchDb();
    seedPolicy(db);
    retireProviderSharing(db, { orgKeyProviders: () => [] });
    seedPolicy(db); // a restored pre-upgrade row must not create a second snapshot
    assert.equal(retireProviderSharing(db, { orgKeyProviders: () => ['glm'] }), 'already_retired');
    assert.equal(snapshot(db).length, 1);
    assert.equal(retiredAudits(db).length, 1);
    assert.deepEqual(JSON.parse(String(snapshot(db)[0].org_key_providers)), []);
    db.close();
  });

  it('a database without the key and without install-wide keys gets nothing', () => {
    const db = scratchDb();
    assert.equal(retireProviderSharing(db, { orgKeyProviders: () => [] }), 'nothing_to_retire');
    assert.equal(snapshot(db).length, 0);
    assert.equal(retiredAudits(db).length, 0);
    db.close();
  });

  it('an install-wide key with no stored policy is still recorded; an unreadable key store records "unknown"', () => {
    const keyed = scratchDb();
    assert.equal(retireProviderSharing(keyed, { orgKeyProviders: () => ['deepseek'] }), 'retired');
    assert.equal(snapshot(keyed)[0].raw_policy, null);
    keyed.close();
    const unreadable = scratchDb();
    seedPolicy(unreadable);
    const result = retireProviderSharing(unreadable, { orgKeyProviders: () => { throw new Error('EACCES'); } });
    assert.equal(result, 'retired', 'a failed presence check never blocks retirement or boot');
    assert.equal(snapshot(unreadable)[0].org_key_providers, 'unknown');
    unreadable.close();
  });

  it('a forced strict-audit failure rolls back, boot continues with members refused, the next boot completes it', () => {
    const db = scratchDb();
    seedPolicy(db);
    const failing = () => { throw new Error('audit storage down'); };
    assert.equal(retireProviderSharing(db, { orgKeyProviders: () => [], audit: failing }), 'failed', 'never throws');
    assert.equal(snapshot(db).length, 0, 'the snapshot row rolled back');
    assert.equal(storedPolicy(db), RAW, 'the key is kept for the retry');
    // Members stay refused meanwhile: no runtime reader consults the key.
    const member = userDb.createUser('at5-member', 'hash', 'user');
    assertMemberOwnTree(resolveProviderEnv(member.id, 'claude', { ...OPERATOR_ENV }), member.id, 'claude', 'chat');

    assert.equal(retireProviderSharing(db, { orgKeyProviders: () => [] }), 'retired', 'the next boot completes it');
    assert.equal(snapshot(db).length, 1);
    assert.equal(retiredAudits(db).length, 1);
    assert.equal(storedPolicy(db), undefined);
    db.close();
  });

  it('runs on the caller\'s own connection: inside an open transaction it defers instead of opening another', () => {
    const db = scratchDb();
    seedPolicy(db);
    db.exec('BEGIN');
    assert.equal(retireProviderSharing(db, { orgKeyProviders: () => [] }), 'deferred');
    db.exec('ROLLBACK');
    assert.equal(storedPolicy(db), RAW);
    db.close();
  });

  it('audit rows of the retained actions older than 90 days survive the prune', () => {
    const db = scratchDb();
    const insert = db.prepare("INSERT INTO audit_log (action, created_at) VALUES (?, datetime('now', '-200 days'))");
    for (const action of [...RETAINED_AUDIT_ACTIONS, 'login_success', 'mcp_server_upsert']) insert.run(action);
    pruneAuditLog(db);
    const left = (db.prepare('SELECT action FROM audit_log').all() as Array<{ action: string }>).map((r) => r.action).sort();
    assert.deepEqual(left, [...RETAINED_AUDIT_ACTIONS].sort());
    for (const action of ['provider_sharing_retired', 'admin_provider_sharing_update', 'provider_sharing_notice_acknowledged',
      'credential_grant_created', 'credential_grant_revoked', 'credential_grant_declined', 'credential_grant_accepted']) {
      assert.ok(RETAINED_AUDIT_ACTIONS.includes(action), action);
    }
    db.close();
  });
});

describe('§3.1 static guard — the retired policy API cannot return', () => {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
  const SELF = path.relative(repoRoot, fileURLToPath(import.meta.url));
  /**
   * Files allowed to name the retired policy: this guard (it names the policy
   * to prove its absence), the retirement migration (§3.2), and the one-time
   * retirement notice (§3.10), which must live at exactly this path.
   */
  const ALLOWED = new Set<string>([
    SELF,
    'server/modules/database/provider-sharing-retirement.migration.ts',
    'server/modules/providers/services/provider-sharing-retirement-notice.service.ts',
  ]);
  const RETIRED = /\b(?:getProviderSharingConfig|setProviderSharingConfig|validateProviderSharingConfig|isProviderIsolated|provider_sharing)\b/;
  const SKIP_DIRS = new Set(['node_modules', 'dist', 'dist-server', '.git']);

  /** Recursively lists source files under `dir` (repo-relative). */
  function sourceFiles(dir: string): string[] {
    const out: string[] = [];
    for (const entry of fs.readdirSync(path.join(repoRoot, dir), { withFileTypes: true })) {
      const rel = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) out.push(...sourceFiles(rel));
      } else if (/\.(?:[cm]?[jt]s|tsx|jsx)$/.test(entry.name)) {
        out.push(rel);
      }
    }
    return out;
  }

  it('the policy module is gone', () => {
    assert.equal(fs.existsSync(path.join(repoRoot, 'server/services/provider-sharing.js')), false);
  });

  it('no file in server/, shared/ or src/ names the retired policy API', () => {
    const offenders: string[] = [];
    for (const top of ['server', 'shared', 'src']) {
      for (const file of sourceFiles(top)) {
        if (ALLOWED.has(file)) continue;
        const lines = fs.readFileSync(path.join(repoRoot, file), 'utf8').split('\n');
        lines.forEach((line, i) => { if (RETIRED.test(line)) offenders.push(`${file}:${i + 1}`); });
      }
    }
    assert.deepEqual(offenders, [], `retired provider_sharing API still referenced:\n${offenders.join('\n')}`);
  });
});
