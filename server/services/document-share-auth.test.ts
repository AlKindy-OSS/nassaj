/**
 * T-1939 slice 3 (qa veto): the document-share verifier is mounted outside
 * authenticateToken, so it must itself refuse a stale authorization generation
 * and a linked member whose SSO attestation aged out. The database module is
 * mocked for the attestation summary; the router, store and verifier are real.
 */
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import test, { beforeEach, mock } from 'node:test';
import { pathToFileURL } from 'node:url';

import Database from 'better-sqlite3';
import express from 'express';
import jwt from 'jsonwebtoken';

import { createSsoConfigDouble } from './__tests__/sso-config-double.js';

const url = (spec: string) => pathToFileURL(path.resolve(import.meta.dirname, spec)).href;
const HOUR_MS = 60 * 60 * 1000;
const secret = 'synthetic-test-secret-document-share-attestation-0001';

type Summary = { linkCount: number; latestAttestedAt: number | null };
const summaries = new Map<number, Summary>();
const revokedRows: Array<{ sid: string; expires_at: number }> = [];
const sso = createSsoConfigDouble();
mock.module(url('./sso-config.service.js'), { namedExports: sso.exports });
mock.module(url('../modules/database/index.js'), {
  namedExports: {
    userIdentitiesDb: {
      attestationSummary: (userId: number) => summaries.get(userId) ?? { linkCount: 0, latestAttestedAt: null },
    },
    userDb: { getUserById: () => undefined },
    // T-2035 round 3: device sign-outs in force (sid -> expires_at).
    revokedTokenSidsDb: {
      isRevoked: (sid: string, nowMs: number) => revokedRows.some((row) => row.sid === sid && row.expires_at > nowMs),
      revoke: () => {},
    },
  },
});

const { createDocumentShareVerifier } = await import('./document-share-auth.js');
const { legacyTokenSid } = await import('../modules/account-wallet/token-session.js');
const { createDocumentSharesRouter } = await import('../routes/document-shares.js');
const { createDocumentSharesStore, migrateDocumentShares } = await import('../modules/database/document-shares.js');


type User = { id: number; role: string; status: string; password_changed_at: number; authorization_generation: number };
const users = new Map<number, User>();
beforeEach(() => {
  sso.setActive(true);
  sso.state.maxAgeHours = 12;
  users.clear();
  for (const [id, role] of [[1, 'owner'], [2, 'user']] as const) {
    users.set(id, { id, role, status: 'active', password_changed_at: 0, authorization_generation: 1 });
  }
  summaries.clear();
  summaries.set(1, { linkCount: 1, latestAttestedAt: null });
  summaries.set(2, { linkCount: 1, latestAttestedAt: Date.now() });
});

const bearer = (userId: number, authGen: number | null = 1) => `Bearer ${jwt.sign(
  { userId, pwd_iat: 0, ...(authGen === null ? {} : { auth_gen: authGen }) }, secret, { expiresIn: '1h' },
)}`;

async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const base = await fs.mkdtemp(path.join('/var/tmp', 'document-share-attestation-test-'));
  const root = path.join(base, 'project');
  await fs.mkdir(path.join(root, 'docs'), { recursive: true });
  await fs.writeFile(path.join(root, 'docs', 'note.txt'), 'shared');
  const db = new Database(':memory:');
  db.exec('CREATE TABLE projects (project_id TEXT PRIMARY KEY, project_path TEXT, isArchived INTEGER)');
  db.prepare('INSERT INTO projects VALUES (?,?,0)').run('p1', root);
  migrateDocumentShares(db);
  const store = createDocumentSharesStore(db);
  const verifyUser = createDocumentShareVerifier({ getUserById: (id: number) => users.get(id) }, secret);
  const app = express();
  app.use(express.json());
  app.use('/api', createDocumentSharesRouter({
    getStore: () => store, verifyUser, isMember: () => true, publicOrigin: 'https://nassaj.example',
  }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const address = server.address() as { port: number };
  const origin = `http://127.0.0.1:${address.port}`;
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    db.close();
    await fs.rm(base, { recursive: true, force: true });
  });
  const created = await fetch(`${origin}/api/projects/p1/document-shares`, {
    method: 'POST',
    headers: { Authorization: bearer(1), 'Content-Type': 'application/json' },
    body: JSON.stringify({ relativePath: 'docs/note.txt', audience: 'members' }),
  });
  assert.equal(created.status, 201, await created.clone().text());
  const { share } = await created.json() as { share: { id: string } };
  const get = (authorization: string) => fetch(`${origin}/api/document-shares/${share.id}`, {
    headers: { Authorization: authorization },
  });
  return { get, verifyUser };
}

test('linked member: fresh passes; unstamped or 12:01h-old attestation → 401', async (t) => {
  const f = await fixture(t);
  assert.equal((await f.get(bearer(2))).status, 200, 'fresh member');
  summaries.set(2, { linkCount: 1, latestAttestedAt: null });
  assert.equal((await f.get(bearer(2))).status, 401, 'never stamped');
  summaries.set(2, { linkCount: 1, latestAttestedAt: Date.now() - (12 * HOUR_MS + 60_000) });
  assert.equal((await f.get(bearer(2))).status, 401, 'stamp 12:01h old');
  summaries.set(2, { linkCount: 1, latestAttestedAt: Date.now() - 11 * HOUR_MS });
  assert.equal((await f.get(bearer(2))).status, 200, 'inside the window');
});

test('the owner is never governed by attestation, even when linked and unstamped', async (t) => {
  const f = await fixture(t);
  assert.equal((await f.get(bearer(1))).status, 200);
});

test('a missing or mismatched auth_gen is refused', async (t) => {
  const f = await fixture(t);
  assert.equal((await f.get(bearer(2, 2))).status, 401, 'token from an older generation');
  assert.equal((await f.get(bearer(2, null))).status, 401, 'no generation claim');
  users.get(2)!.authorization_generation = 2;
  assert.equal((await f.get(bearer(2, 1))).status, 401, 'generation bumped after issue');
  assert.equal((await f.get(bearer(2, 2))).status, 200, 'current generation');
});

test('T-2035: a token from an older sign-out epoch is refused (qa probe tok_ep 0 vs epoch 3)', async (t) => {
  const f = await fixture(t);
  const signed = (tokEp?: number) => `Bearer ${jwt.sign(
    { userId: 2, pwd_iat: 0, auth_gen: 1, ...(tokEp === undefined ? {} : { tok_ep: tokEp }) },
    secret, { expiresIn: '1h' },
  )}`;
  assert.equal((await f.get(signed())).status, 200, 'legacy token at epoch 0');
  (users.get(2) as User & { token_epoch?: number }).token_epoch = 3;
  assert.equal((await f.get(signed(0))).status, 401, 'tok_ep 0 after three sign-outs');
  assert.equal((await f.get(signed())).status, 401, 'legacy token after a sign-out');
  assert.equal(f.verifyUser(signed(2)), null);
  assert.equal((await f.get(signed(3))).status, 200, 'current epoch');
});

test('T-2035 round 3: a token whose device signed out (revoked sid) is refused', async (t) => {
  const f = await fixture(t);
  const signed = (sid: string) => `Bearer ${jwt.sign({ userId: 2, pwd_iat: 0, auth_gen: 1, sid }, secret, { expiresIn: '1h' })}`;
  const revoked = 'revokedSid000000000000';
  const live = 'liveDeviceSid000000000';
  revokedRows.length = 0;
  revokedRows.push({ sid: revoked, expires_at: Date.now() + 3_600_000 });
  try {
    assert.equal((await f.get(signed(revoked))).status, 401, 'signed-out device');
    assert.equal(f.verifyUser(signed(revoked)), null);
    assert.equal((await f.get(signed(live))).status, 200, 'another device of the same user');
    assert.equal((await f.get(signed('bad sid'))).status, 401, 'a malformed sid is refused');
    // H1: a pre-release token (no sid) is judged under the sid derived from it.
    const legacy = jwt.sign({ userId: 2, pwd_iat: 0, auth_gen: 1 }, secret, { expiresIn: '1h' });
    assert.equal((await f.get(`Bearer ${legacy}`)).status, 200);
    revokedRows.push({ sid: legacyTokenSid(legacy), expires_at: Date.now() + 3_600_000 });
    assert.equal((await f.get(`Bearer ${legacy}`)).status, 401, 'signed-out pre-release token');
  } finally {
    revokedRows.length = 0;
  }
});

test('SSO policy off: attestation is not consulted, other checks unchanged', async (t) => {
  sso.setActive(false);
  const f = await fixture(t);
  summaries.set(2, { linkCount: 1, latestAttestedAt: null });
  assert.equal((await f.get(bearer(2))).status, 200);
  assert.equal(f.verifyUser(bearer(2, 3)), null, 'generation still enforced');
});
