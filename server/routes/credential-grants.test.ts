/**
 * credential-grants.test — user-to-user credential delegation (T-1675 / ADR-152).
 *
 * Proves the one seam that matters: with a grant in place, `resolveProviderEnv`
 * builds the grantee's spawn environment for the OWNER's credential of that
 * provider ONLY — a dedicated dir for claude/codex, the owner's key for vendors,
 * and a GRANT HOME (own tree + the granted dir linked) for HOME-steered ones —
 * and that revoking, declining, disabling the owner, or `honorGrants:false`
 * puts the grantee back on their own tree with no cache in between. Also pins
 * the wire contract of the self-scoped routes.
 *
 * Bootstrap mirrors resolve-provider-env.test.ts: sandboxed $HOME + throwaway DB
 * opened before importing any project module. Runner: node:test.
 */

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

import express from 'express';

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'nassaj-credential-grants-test-'));
const ORIGINAL_HOME = process.env.HOME;
const ORIGINAL_DB = process.env.DATABASE_PATH;
const ORIGINAL_SECRETS_KEY = process.env.NASSAJ_PROVIDER_SECRETS_KEY;
const sandboxHome = path.join(sandbox, 'home');
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.HOME = sandboxHome;
process.env.DATABASE_PATH = path.join(sandbox, 'test-db.sqlite');
process.env.NASSAJ_PROVIDER_SECRETS_KEY = crypto.randomBytes(32).toString('base64');
assert.equal(os.homedir(), sandboxHome);

const { initializeDatabase, closeConnection, userDb, credentialGrantsDb } = await import('@/modules/database/index.js');
const { setProviderSharingConfig, _resetProviderSharingCache, KNOWN_PROVIDERS } = await import('@/services/provider-sharing.js');
const { resolveProviderEnv } = await import('@/services/isolation/resolve-provider-env.js');
const { resolveCredentialPrincipal, GRANTABLE_PROVIDERS, GRANTABLE_UNITS } = await import('@/services/isolation/credential-principal.js');
const { userConfigDir } = await import('@/services/isolation/provision-user-dirs.js');
const { setProviderKey, _resetProviderSecretsServerKeyCache } = await import('@/services/isolation/provider-secrets-store.js');
const { default: grantsRouter } = await import('./credential-grants.js');

await initializeDatabase();
_resetProviderSharingCache();
setProviderSharingConfig({ claude: 'isolated', codex: 'isolated', kimi: 'isolated', agy: 'isolated', opencode: 'isolated' });

const owner = userDb.createUser('owner-a', 'hash', 'user');
const grantee = userDb.createUser('grantee-b', 'hash', 'user');
const third = userDb.createUser('third-c', 'hash', 'user');

after(() => {
  closeConnection();
  if (ORIGINAL_HOME === undefined) delete process.env.HOME; else process.env.HOME = ORIGINAL_HOME;
  if (ORIGINAL_DB === undefined) delete process.env.DATABASE_PATH; else process.env.DATABASE_PATH = ORIGINAL_DB;
  if (ORIGINAL_SECRETS_KEY === undefined) delete process.env.NASSAJ_PROVIDER_SECRETS_KEY;
  else process.env.NASSAJ_PROVIDER_SECRETS_KEY = ORIGINAL_SECRETS_KEY;
  _resetProviderSecretsServerKeyCache();
  fs.rmSync(sandbox, { recursive: true, force: true });
});

const claudeDirOf = (id: number) => userConfigDir(id, '.claude');
const claudeHome = (id: number) => resolveProviderEnv(id, 'claude', {}).CLAUDE_CONFIG_DIR;

describe('resolveCredentialPrincipal + resolveProviderEnv', () => {
  it('base state: no grant ⇒ own tree', () => {
    assert.equal(claudeHome(grantee.id), claudeDirOf(grantee.id));
    assert.equal(resolveCredentialPrincipal(grantee.id, 'claude').grantedBy, null);
  });

  it('a grant moves the grantee onto the owner tree on the very next spawn', () => {
    credentialGrantsDb.grant(owner.id, grantee.id, 'claude');
    assert.equal(claudeHome(grantee.id), claudeDirOf(owner.id));
    assert.equal(resolveCredentialPrincipal(grantee.id, 'claude').grantedBy, owner.id);
    // The owner is untouched, and so is every other provider of the grantee.
    assert.equal(claudeHome(owner.id), claudeDirOf(owner.id));
    assert.equal(resolveProviderEnv(grantee.id, 'codex', {}).CODEX_HOME, userConfigDir(grantee.id, '.codex'));
  });

  it('honorGrants:false (terminals, home enumeration) ignores the grant', () => {
    assert.equal(
      resolveProviderEnv(grantee.id, 'claude', {}, 'chat', { honorGrants: false }).CLAUDE_CONFIG_DIR,
      claudeDirOf(grantee.id),
    );
  });

  it('declining returns the grantee to their own tree; accepting restores', () => {
    credentialGrantsDb.setDeclined(owner.id, grantee.id, 'claude', true);
    assert.equal(claudeHome(grantee.id), claudeDirOf(grantee.id));
    credentialGrantsDb.setDeclined(owner.id, grantee.id, 'claude', false);
    assert.equal(claudeHome(grantee.id), claudeDirOf(owner.id));
  });

  it('no chaining: a grantee who re-shares hands out THEIR tree, not the owner’s', () => {
    credentialGrantsDb.grant(grantee.id, third.id, 'claude');
    assert.equal(claudeHome(third.id), claudeDirOf(grantee.id));
    credentialGrantsDb.revoke(grantee.id, third.id, 'claude');
  });

  it('several grants: the oldest usable one wins; declining it falls through to the next', () => {
    credentialGrantsDb.grant(third.id, grantee.id, 'claude');
    assert.equal(claudeHome(grantee.id), claudeDirOf(owner.id));
    credentialGrantsDb.setDeclined(owner.id, grantee.id, 'claude', true);
    assert.equal(claudeHome(grantee.id), claudeDirOf(third.id));
    credentialGrantsDb.revoke(third.id, grantee.id, 'claude');
    credentialGrantsDb.setDeclined(owner.id, grantee.id, 'claude', false);
    assert.equal(claudeHome(grantee.id), claudeDirOf(owner.id));
  });

  it('a disabled owner stops sharing on the next spawn even after a warm read (no cache)', () => {
    assert.equal(claudeHome(grantee.id), claudeDirOf(owner.id)); // warm
    userDb.setStatus(owner.id, 'disabled');
    assert.equal(claudeHome(grantee.id), claudeDirOf(grantee.id));
    userDb.setStatus(owner.id, 'active');
    assert.equal(claudeHome(grantee.id), claudeDirOf(owner.id));
  });

  it('a deleted owner takes the grant with them (FK cascade, no cache)', () => {
    const doomed = userDb.createUser('doomed-d', 'hash', 'user');
    credentialGrantsDb.grant(doomed.id, third.id, 'codex');
    assert.equal(resolveProviderEnv(third.id, 'codex', {}).CODEX_HOME, userConfigDir(doomed.id, '.codex'));
    userDb.deleteUser(doomed.id);
    assert.equal(resolveProviderEnv(third.id, 'codex', {}).CODEX_HOME, userConfigDir(third.id, '.codex'));
  });

  it('revoking ends it for the grantee', () => {
    credentialGrantsDb.revoke(owner.id, grantee.id, 'claude');
    assert.equal(claudeHome(grantee.id), claudeDirOf(grantee.id));
  });

  it('HOME-steered provider: a grant home links ONLY the granted dir to the owner', () => {
    // Give both trees a full shape and the owner an agy credential dir.
    resolveProviderEnv(owner.id, 'agy', {});
    resolveProviderEnv(grantee.id, 'agy', {});
    fs.mkdirSync(path.join(userConfigDir(owner.id, '.gemini')), { recursive: true });
    fs.mkdirSync(path.join(userConfigDir(owner.id, '.hermes')), { recursive: true });
    fs.mkdirSync(path.join(userConfigDir(grantee.id, '.hermes')), { recursive: true });

    credentialGrantsDb.grant(owner.id, grantee.id, 'gemini');
    const home = resolveProviderEnv(grantee.id, 'agy', {}).HOME!;
    assert.notEqual(home, userConfigDir(owner.id, ''), 'never the owner root');
    assert.equal(home, userConfigDir(grantee.id, path.join('.grants', String(owner.id))));
    // The granted dir goes to the owner…
    assert.equal(fs.readlinkSync(path.join(home, '.gemini')), userConfigDir(owner.id, '.gemini'));
    // …everything else stays the grantee's own.
    assert.equal(fs.readlinkSync(path.join(home, '.claude')), userConfigDir(grantee.id, '.claude'));
    assert.equal(fs.readlinkSync(path.join(home, '.codex')), userConfigDir(grantee.id, '.codex'));
    assert.equal(fs.readlinkSync(path.join(home, '.hermes')), userConfigDir(grantee.id, '.hermes'));
    assert.equal(fs.readlinkSync(path.join(home, '.qwen')), userConfigDir(grantee.id, '.qwen'));
    assert.ok(!fs.existsSync(path.join(home, '.grants')), 'the grant dir is not mirrored into itself');
    assert.equal(resolveCredentialPrincipal(grantee.id, 'agy').grantedBy, owner.id);
    // The owner's own spawn is unaffected.
    assert.equal(resolveProviderEnv(owner.id, 'agy', {}).HOME, userConfigDir(owner.id, ''));

    // Revocation: the link flips back to the grantee's own dir on the next spawn.
    credentialGrantsDb.revoke(owner.id, grantee.id, 'gemini');
    assert.equal(resolveProviderEnv(grantee.id, 'agy', {}).HOME, userConfigDir(grantee.id, ''));
    // And a later grant of a different provider rebuilds the composite without gemini.
    credentialGrantsDb.grant(owner.id, grantee.id, 'hermes');
    const home2 = resolveProviderEnv(grantee.id, 'hermes', {}).HOME!;
    assert.equal(fs.readlinkSync(path.join(home2, '.hermes')), userConfigDir(owner.id, '.hermes'));
    assert.equal(fs.readlinkSync(path.join(home2, '.gemini')), userConfigDir(grantee.id, '.gemini'));
    credentialGrantsDb.revoke(owner.id, grantee.id, 'hermes');
    // With no grants left, the next own-credential spawn sweeps the grant home.
    resolveProviderEnv(grantee.id, 'hermes', {});
    assert.ok(!fs.existsSync(home2), 'orphaned grant home is swept');
  });

  it('opencode: only the data home follows the owner; config/cache/state stay own', () => {
    fs.mkdirSync(userConfigDir(owner.id, '.local/share/opencode'), { recursive: true });
    credentialGrantsDb.grant(owner.id, grantee.id, 'opencode');
    const env = resolveProviderEnv(grantee.id, 'opencode', {});
    const dataHome = env.XDG_DATA_HOME!;
    assert.equal(fs.readlinkSync(path.join(dataHome, 'opencode')), userConfigDir(owner.id, '.local/share/opencode'));
    assert.equal(env.XDG_CONFIG_HOME, userConfigDir(grantee.id, '.config'));
    assert.equal(env.XDG_CACHE_HOME, userConfigDir(grantee.id, '.cache'));
    assert.equal(env.XDG_STATE_HOME, userConfigDir(grantee.id, '.local/state'));
    credentialGrantsDb.revoke(owner.id, grantee.id, 'opencode');
  });

  it('api-key providers delegate the OWNER’s stored key', () => {
    _resetProviderSecretsServerKeyCache();
    setProviderKey(owner.id, 'kimi', 'sk-owner-kimi');
    credentialGrantsDb.grant(owner.id, grantee.id, 'kimi');
    assert.equal(resolveProviderEnv(grantee.id, 'kimi', { PATH: '/usr/bin' }).KIMI_API_KEY, 'sk-owner-kimi');
    credentialGrantsDb.revoke(owner.id, grantee.id, 'kimi');
    assert.equal(resolveProviderEnv(grantee.id, 'kimi', { PATH: '/usr/bin' }).KIMI_API_KEY, undefined);
  });

  it('every known provider is grantable (owner decision 2026-09-10 includes qwen); self-grant is refused', () => {
    assert.deepEqual([...GRANTABLE_PROVIDERS].sort(), [...KNOWN_PROVIDERS].sort());
    assert.throws(() => credentialGrantsDb.grant(owner.id, owner.id, 'claude'), /distinct/);
    credentialGrantsDb.grant(owner.id, grantee.id, 'qwen');
    const home = resolveProviderEnv(grantee.id, 'qwen', {}).HOME!;
    assert.equal(home, userConfigDir(grantee.id, path.join('.grants', String(owner.id))));
    credentialGrantsDb.revoke(owner.id, grantee.id, 'qwen');
  });
});

describe('routes /api/credential-grants — self-scoped wire contract', () => {
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
    app.use('/api/credential-grants', grantsRouter);
    app.use((error: Error & { statusCode?: number; code?: string }, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      res.status(error.statusCode ?? 500).json({ error: error.message, code: error.code });
    });
    await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  after(() => new Promise<void>((resolve) => server.close(() => resolve())));

  const call = async (method: string, url: string, user: { id: number; role: string } | null, body?: unknown) => {
    currentUser = user;
    const res = await fetch(`${baseUrl}/api/credential-grants${url}`, {
      method,
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, json: await res.json() as Record<string, any> };
  };
  const asOwner = { id: owner.id, role: 'user' };
  const asGrantee = { id: grantee.id, role: 'user' };

  it('GET lists grantable providers and the other active members', async () => {
    const { status, json } = await call('GET', '/', asOwner);
    assert.equal(status, 200);
    assert.deepEqual(json.data.providers, [...GRANTABLE_UNITS]);
    assert.ok(!json.data.providers.includes('agy'), 'agy is folded into the gemini unit');
    assert.ok(!json.data.members.some((m: { id: number }) => m.id === owner.id));
    assert.ok(json.data.members.some((m: { id: number; username: string }) => m.id === grantee.id && m.username === 'grantee-b'));
  });

  it('PUT grantees replaces the set; the grantee sees it in use; either side can end it', async () => {
    let r = await call('PUT', '/codex/grantees', asOwner, { userIds: [grantee.id, third.id] });
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.data.given.map((g: { userId: number }) => g.userId).sort(), [grantee.id, third.id].sort());

    r = await call('GET', '/', asGrantee);
    const received = r.json.data.received.find((g: { provider: string }) => g.provider === 'codex');
    assert.equal(received.ownerUserId, owner.id);
    assert.equal(received.ownerUsername, 'owner-a');
    assert.equal(received.inUse, true);
    assert.equal(resolveProviderEnv(grantee.id, 'codex', {}).CODEX_HOME, userConfigDir(owner.id, '.codex'));

    // Grantee switches back to their own credential.
    r = await call('PUT', '/codex/use', asGrantee, { ownerUserId: null });
    assert.equal(r.json.data.received.find((g: { provider: string }) => g.provider === 'codex').declined, true);
    assert.equal(resolveProviderEnv(grantee.id, 'codex', {}).CODEX_HOME, userConfigDir(grantee.id, '.codex'));
    // ...and the owner sees the answer.
    r = await call('GET', '/', asOwner);
    assert.equal(r.json.data.given.find((g: { userId: number }) => g.userId === grantee.id).declined, true);

    // Grantee picks it up again, then the owner shrinks the set.
    await call('PUT', '/codex/use', asGrantee, { ownerUserId: owner.id });
    assert.equal(resolveProviderEnv(grantee.id, 'codex', {}).CODEX_HOME, userConfigDir(owner.id, '.codex'));
    r = await call('PUT', '/codex/grantees', asOwner, { userIds: [third.id] });
    assert.deepEqual(r.json.data.given.map((g: { userId: number }) => g.userId), [third.id]);
    assert.equal(resolveProviderEnv(grantee.id, 'codex', {}).CODEX_HOME, userConfigDir(grantee.id, '.codex'));
    r = await call('DELETE', `/codex/grantees/${third.id}`, asOwner);
    assert.deepEqual(r.json.data.given, []);
  });

  it('an agy grant addressed by its storage unit is in use for the grantee', async () => {
    let r = await call('PUT', '/gemini/grantees', asOwner, { userIds: [grantee.id] });
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.data.given.map((g: { provider: string }) => g.provider), ['gemini']);

    r = await call('GET', '/', asGrantee);
    const received = r.json.data.received.find((g: { provider: string }) => g.provider === 'gemini');
    assert.equal(received.ownerUserId, owner.id);
    // inUse comes from resolveCredentialPrincipal(caller, 'gemini'): it only holds
    // because isGrantableKey accepts the unit key as well as the provider key.
    assert.equal(received.inUse, true);
    assert.equal(resolveProviderEnv(grantee.id, 'agy', {}).HOME,
      userConfigDir(grantee.id, path.join('.grants', String(owner.id))));

    r = await call('DELETE', `/gemini/grantees/${grantee.id}`, asOwner);
    assert.deepEqual(r.json.data.given, []);
  });

  it('refuses self, unknown or disabled members, unknown providers, and conjured acceptance', async () => {
    assert.equal((await call('PUT', '/claude/grantees', asOwner, { userIds: [owner.id] })).status, 400);
    assert.equal((await call('PUT', '/claude/grantees', asOwner, { userIds: [999] })).status, 400);
    userDb.setStatus(third.id, 'disabled');
    assert.equal((await call('PUT', '/claude/grantees', asOwner, { userIds: [third.id] })).status, 400);
    userDb.setStatus(third.id, 'active');
    assert.equal((await call('PUT', '/sakana/grantees', asOwner, { userIds: [grantee.id] })).status, 400);
    // agy is accepted and stored as the gemini unit.
    let r = await call('PUT', '/agy/grantees', asOwner, { userIds: [grantee.id] });
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.data.given.map((g: { provider: string }) => g.provider), ['gemini']);
    await call('DELETE', `/gemini/grantees/${grantee.id}`, asOwner);
    assert.equal((await call('PUT', '/claude/use', asGrantee, { ownerUserId: owner.id })).status, 404);
    assert.equal((await call('GET', '/', null)).status, 401);
    // A refused set leaves nothing behind.
    assert.deepEqual((await call('GET', '/', asOwner)).json.data.given, []);
  });
});
