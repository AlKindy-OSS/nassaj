/**
 * T-1946 — API keys of SSO-linked members follow the owner's attestation
 * window (days since the last SSO sign-in), and suspending or deleting a
 * member removes every key they own. Real repository SQL on a throwaway
 * database; no mocks.
 */
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { mock } from 'node:test';
import { fileURLToPath } from 'node:url';

import Database from 'better-sqlite3';

import { closeConnection, getConnection } from '@/modules/database/connection.js';
import { initializeDatabase } from '@/modules/database/init-db.js';
import { writeDisabledRecordOn } from '@/modules/database/repositories/sso-oidc-config.js';
import { stopReconcileScheduler } from '@/modules/database/project-reconcile.service.js';
import { AgentReviewReadonlyAuthRepository } from '@/modules/database/repositories/agent-review-readonly-auth.db.js';
import {
  API_KEY_SSO_WINDOW_CONFIG_KEY,
  API_KEY_SSO_WINDOW_DEFAULT_DAYS,
  apiKeyCredentialState,
  apiKeySsoWindowDb,
  parseApiKeySsoWindowDays,
} from '@/modules/database/repositories/api-key-sso-window.js';
import { digestApiKey } from '@/modules/database/api-key-digest.js';
import { apiKeysDb } from '@/modules/database/repositories/api-keys.js';
import { userIdentitiesDb } from '@/modules/database/repositories/user-identities.js';
import { userDb } from '@/modules/database/repositories/users.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const ISSUER = 'https://idp.example';
const NOW = Date.UTC(2026, 9, 1, 12, 0, 0);

async function withIsolatedDatabase(run: () => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const directory = await mkdtemp(path.join(tmpdir(), 'api-key-sso-window-'));
  const databasePath = path.join(directory, 'auth.db');
  await writeFile(databasePath, '');
  closeConnection();
  process.env.DATABASE_PATH = databasePath;
  await initializeDatabase();
  stopReconcileScheduler();
  // ADR-194 S8 Q1: these tests pin the plain T-1946 window, which applies when SSO
  // is owner-disabled; the refusal while SSO is enforced but unavailable is in the
  // D1 matrices (sso-config.service and sso-credential-matrix tests).
  writeDisabledRecordOn(getConnection(), 'owner', Date.now());
  try {
    await run();
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previousDatabasePath;
    await rm(directory, { recursive: true, force: true });
  }
}

/** Creates a linked member attested at `attestedAt` (null = never) with one key. */
function linkedMemberWithKey(name: string, attestedAt: number | null, role: 'user' | 'admin' | 'owner' = 'user') {
  const user = userDb.createUser(name, 'hash', role);
  const linkId = userIdentitiesDb.link(user.id, ISSUER, `sub-${name}`);
  if (attestedAt !== null) userIdentitiesDb.markAttested(linkId, user.id, attestedAt);
  const key = apiKeysDb.createApiKey(user.id, 'automation');
  return { user, linkId, key };
}

/** Strict key-purge audit rows (T-1946 review M2), metadata parsed. */
function keyPurgeAudits(): { user_id: number | null; metadata: unknown }[] {
  return (getConnection().prepare(`SELECT user_id, metadata FROM audit_log
    WHERE action = 'api_keys_revoked' ORDER BY id`).all() as { user_id: number | null; metadata: string }[])
    .map((row) => ({ user_id: row.user_id, metadata: JSON.parse(row.metadata) }));
}

function reason(apiKey: string, nowMs = NOW): string {
  const resolution = apiKeysDb.resolveApiKey(apiKey, nowMs);
  return resolution.ok ? 'ok' : resolution.reason;
}

test('window boundary: exactly N days is accepted, one ms over is refused', async () => {
  await withIsolatedDatabase(() => {
    const exact = linkedMemberWithKey('exact', NOW - API_KEY_SSO_WINDOW_DEFAULT_DAYS * DAY_MS);
    const over = linkedMemberWithKey('over', NOW - API_KEY_SSO_WINDOW_DEFAULT_DAYS * DAY_MS - 1);
    assert.equal(apiKeySsoWindowDb.getDays(), 7, 'default window is 7 days');
    assert.equal(reason(exact.key.apiKey), 'ok');
    assert.equal(reason(over.key.apiKey), 'sso_attestation_expired');
  });
});

test('an expired key is refused without being deleted or stamped as used', async () => {
  await withIsolatedDatabase(() => {
    const member = linkedMemberWithKey('stale', NOW - 30 * DAY_MS);
    assert.equal(reason(member.key.apiKey), 'sso_attestation_expired');
    const [row] = apiKeysDb.getApiKeys(member.user.id);
    assert.equal(row?.is_active, 1, 'key row survives expiry');
    assert.equal(row?.last_used, null, 'a refused key is not stamped as used');
  });
});

test('a linked member that never attested fails closed', async () => {
  await withIsolatedDatabase(() => {
    const member = linkedMemberWithKey('never', null);
    assert.equal(reason(member.key.apiKey), 'sso_attestation_expired');
  });
});

test('changing N takes effect on the very next check', async () => {
  await withIsolatedDatabase(() => {
    const member = linkedMemberWithKey('tenday', NOW - 10 * DAY_MS);
    assert.equal(reason(member.key.apiKey), 'sso_attestation_expired');
    apiKeySsoWindowDb.setDays(14);
    assert.equal(reason(member.key.apiKey), 'ok');
    apiKeySsoWindowDb.setDays(10);
    assert.equal(reason(member.key.apiKey), 'ok', '10 days exactly');
    apiKeySsoWindowDb.setDays(9);
    assert.equal(reason(member.key.apiKey), 'sso_attestation_expired');
  });
});

test('unlinked members and the owner are not governed', async () => {
  await withIsolatedDatabase(() => {
    const local = userDb.createUser('local-member', 'hash', 'user');
    const localKey = apiKeysDb.createApiKey(local.id, 'local');
    const owner = linkedMemberWithKey('owner', null, 'owner');
    apiKeySsoWindowDb.setDays(1);
    assert.equal(reason(localKey.apiKey, NOW + 400 * DAY_MS), 'ok', 'unlinked member');
    assert.equal(reason(owner.key.apiKey, NOW + 400 * DAY_MS), 'ok', 'linked owner never attested');
  });
});

test('the next SSO sign-in revives the key', async () => {
  await withIsolatedDatabase(() => {
    const member = linkedMemberWithKey('revive', NOW - 8 * DAY_MS);
    assert.equal(reason(member.key.apiKey), 'sso_attestation_expired');
    userIdentitiesDb.markAttested(member.linkId, member.user.id, NOW - 1000);
    const resolution = apiKeysDb.resolveApiKey(member.key.apiKey, NOW);
    assert.equal(resolution.ok, true);
    assert.equal(resolution.ok && resolution.user.id, member.user.id);
    assert.notEqual(apiKeysDb.getApiKeys(member.user.id)[0]?.last_used, null);
  });
});

test('in-flight revalidation and the review surface apply the same window', async () => {
  await withIsolatedDatabase(() => {
    getConnection().prepare("INSERT INTO app_config (key, value) VALUES ('external_api.enabled', '1')").run();
    const member = linkedMemberWithKey('inflight', Date.now() - 1000);
    const resolved = apiKeysDb.resolveApiKey(member.key.apiKey);
    assert.equal(resolved.ok, true);
    const user = resolved.ok ? resolved.user : null;
    const current = () => apiKeysDb.isAuthenticationPrincipalCurrent(
      user!.api_key_id, user!.id, user!.authorization_generation,
    );
    const review = new AgentReviewReadonlyAuthRepository(getConnection());
    const reviewUser = review.key(member.key.apiKey);
    assert.ok(reviewUser);
    assert.equal(current(), true);
    assert.equal(review.current(member.user.id, reviewUser.authorization_generation,
      reviewUser.password_changed_at, reviewUser), true);

    userIdentitiesDb.markAttested(member.linkId, member.user.id, Date.now() - 8 * DAY_MS);
    assert.equal(current(), false);
    assert.equal(review.key(member.key.apiKey), null);
    assert.equal(review.current(member.user.id, reviewUser.authorization_generation,
      reviewUser.password_changed_at, reviewUser), false);
  });
});

test('window parsing accepts only whole days 1..365; a corrupt stored value uses the minimum', async () => {
  for (const valid of [1, 7, 365]) assert.equal(parseApiKeySsoWindowDays(valid), valid);
  for (const invalid of [0, -1, 366, 7.5, '7', null, undefined, true, Number.NaN, Infinity]) {
    assert.equal(parseApiKeySsoWindowDays(invalid), null, String(invalid));
  }
  await withIsolatedDatabase(() => {
    assert.throws(() => apiKeySsoWindowDb.setDays(0), RangeError);
    getConnection().prepare('INSERT INTO app_config (key, value) VALUES (?, ?)')
      .run(API_KEY_SSO_WINDOW_CONFIG_KEY, 'forever');
    assert.equal(apiKeySsoWindowDb.getDays(), 1);
  });
});

test('suspending a member deletes all their API keys; re-enabling restores none', async () => {
  await withIsolatedDatabase(() => {
    const member = userDb.createUser('suspended', 'hash', 'user');
    const other = userDb.createUser('bystander', 'hash', 'user');
    const key = apiKeysDb.createApiKey(member.id, 'one');
    const disabled = apiKeysDb.createApiKey(member.id, 'two');
    apiKeysDb.toggleApiKey(member.id, Number(disabled.id), false);
    apiKeysDb.createApiKey(other.id, 'kept');

    assert.equal(userDb.setStatus(member.id, 'disabled'), 2, 'returns the deleted count');
    assert.equal(apiKeysDb.getApiKeys(member.id).length, 0, 'active and inactive keys are gone');
    assert.equal(apiKeysDb.getApiKeys(other.id).length, 1, 'other members keep theirs');
    assert.deepEqual(keyPurgeAudits(), [
      { user_id: member.id, metadata: { trigger: 'user_disabled', targetUserId: member.id, count: 2 } },
    ]);

    assert.equal(userDb.setStatus(member.id, 'active'), 0);
    assert.equal(apiKeysDb.getApiKeys(member.id).length, 0);
    assert.equal(reason(key.apiKey), 'invalid');
    assert.equal(userDb.setStatus(member.id, 'disabled'), 0);
    assert.equal(keyPurgeAudits().length, 1, 'an empty purge is not audited');
  });
});

test('deleting a member deletes all their API keys', async () => {
  await withIsolatedDatabase(() => {
    const member = userDb.createUser('deleted', 'hash', 'user');
    const key = apiKeysDb.createApiKey(member.id, 'one');
    apiKeysDb.createApiKey(member.id, 'two');
    assert.equal(userDb.deleteUser(member.id), true);
    const remaining = getConnection().prepare('SELECT COUNT(*) AS n FROM api_keys WHERE user_id = ?')
      .get(member.id) as { n: number };
    assert.equal(remaining.n, 0);
    assert.equal(reason(key.apiKey), 'invalid');
    assert.deepEqual(keyPurgeAudits(), [
      { user_id: null, metadata: { trigger: 'user_deleted', targetUserId: member.id, count: 2 } },
    ]);
  });
});

/** Captures fixed-code warnings written by the window module while `run` executes. */
function capturedWarnings(run: () => void): string[] {
  const codes: string[] = [];
  const write = mock.method(process.stderr, 'write', (chunk: unknown) => {
    try {
      const parsed = JSON.parse(String(chunk)) as { scope?: string; code?: string };
      if (parsed.scope === 'api_keys' && parsed.code) codes.push(parsed.code);
    } catch { /* not ours */ }
    return true;
  });
  try { run(); } finally { write.mock.restore(); }
  return codes;
}

test('a corrupt stored window is logged once with a fixed code and no value', async () => {
  await withIsolatedDatabase(() => {
    apiKeySsoWindowDb.setDays(5);
    assert.equal(apiKeySsoWindowDb.getDays(), 5, 'a valid read re-arms the warning');
    getConnection().prepare('UPDATE app_config SET value = ? WHERE key = ?')
      .run('9999', API_KEY_SSO_WINDOW_CONFIG_KEY);
    const codes = capturedWarnings(() => {
      assert.equal(apiKeySsoWindowDb.getDays(), 1);
      assert.equal(apiKeySsoWindowDb.getDays(), 1);
    });
    assert.deepEqual(codes, ['api_key_sso_window_corrupt']);
  });
});

test('admins are governed and the newest of several links decides', async () => {
  await withIsolatedDatabase(() => {
    const admin = linkedMemberWithKey('stale-admin', NOW - 8 * DAY_MS, 'admin');
    assert.equal(reason(admin.key.apiKey), 'sso_attestation_expired');

    const multi = linkedMemberWithKey('multi', NOW - 30 * DAY_MS);
    const second = userIdentitiesDb.link(multi.user.id, 'https://second.example', 'sub-multi');
    userIdentitiesDb.markAttested(second, multi.user.id, NOW - DAY_MS);
    assert.equal(reason(multi.key.apiKey), 'ok', 'MAX over links: one fresh link suffices');
    userIdentitiesDb.markAttested(second, multi.user.id, NOW - 9 * DAY_MS);
    assert.equal(reason(multi.key.apiKey), 'sso_attestation_expired', 'all links stale');
  });
});

test('suspension is atomic: a failed key purge leaves status, keys and audit unchanged', async () => {
  await withIsolatedDatabase(() => {
    const member = userDb.createUser('atomic', 'hash', 'user');
    const key = apiKeysDb.createApiKey(member.id, 'kept');
    getConnection().exec(`CREATE TRIGGER t1946_block_purge BEFORE DELETE ON api_keys
      BEGIN SELECT RAISE(ABORT, 'purge blocked'); END`);
    assert.throws(() => userDb.setStatus(member.id, 'disabled'), /purge blocked/);
    assert.equal(userDb.getRawById(member.id)?.status, 'active');
    assert.equal(reason(key.apiKey), 'ok');
    assert.deepEqual(keyPurgeAudits(), []);
  });
});

/** Every key check the server has, for one key, reduced to ok / refusal reason. */
function allKeyChecks(apiKey: string, nowMs: number) {
  const db = getConnection();
  const row = db.prepare('SELECT ak.id, ak.user_id, u.authorization_generation AS gen FROM api_keys ak '
    + 'JOIN users u ON u.id = ak.user_id WHERE ak.key_digest = ?').get(digestApiKey(apiKey)) as
    { id: number; user_id: number; gen: number };
  const review = new AgentReviewReadonlyAuthRepository(db);
  return {
    resolve: reason(apiKey, nowMs),
    state: apiKeyCredentialState(db, { apiKeyId: row.id, userId: row.user_id, nowMs })
      .replace('current', 'ok'),
    principal: apiKeysDb.authenticationPrincipalState(row.id, row.user_id, row.gen)
      .replace('current', 'ok'),
    review: review.key(apiKey) ? 'ok' : 'refused',
  };
}

test('parity: authentication, revalidation, launch predicate and review agree (T-1946 M3)', async () => {
  await withIsolatedDatabase(() => {
    getConnection().prepare("INSERT INTO app_config (key, value) VALUES ('external_api.enabled', '1')").run();
    const now = Date.now();
    const local = userDb.createUser('parity-local', 'hash', 'user');
    const cases = {
      owner: linkedMemberWithKey('parity-owner', null, 'owner').key.apiKey,
      local: apiKeysDb.createApiKey(local.id, 'local').apiKey,
      fresh: linkedMemberWithKey('parity-fresh', now - DAY_MS).key.apiKey,
      stale: linkedMemberWithKey('parity-stale', now - 8 * DAY_MS).key.apiKey,
      never: linkedMemberWithKey('parity-never', null).key.apiKey,
      admin: linkedMemberWithKey('parity-admin', now - 8 * DAY_MS, 'admin').key.apiKey,
    };
    const expected: Record<keyof typeof cases, string> = {
      owner: 'ok', local: 'ok', fresh: 'ok',
      stale: 'sso_attestation_expired', never: 'sso_attestation_expired', admin: 'sso_attestation_expired',
    };
    for (const [name, apiKey] of Object.entries(cases) as [keyof typeof cases, string][]) {
      const checks = allKeyChecks(apiKey, now);
      const want = expected[name];
      assert.deepEqual(checks, { resolve: want, state: want, principal: want,
        review: want === 'ok' ? 'ok' : 'refused' }, name);
    }
  });
});

test('parity guard: no server module checks API key activity outside the shared predicate', () => {
  const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
  const allowed = new Set([
    'modules/database/repositories/api-keys.ts',
    'modules/database/repositories/api-key-sso-window.ts',
    'modules/database/repositories/agent-review-readonly-auth.db.ts',
  ]);
  const offenders: string[] = [];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory)) {
      if (entry === 'node_modules' || entry === 'dist' || entry.startsWith('.')) continue;
      const full = path.join(directory, entry);
      if (statSync(full).isDirectory()) { walk(full); continue; }
      if (!/\.(ts|js|mjs)$/.test(entry) || /\.test\.|fixture/.test(entry)) continue;
      const relative = path.relative(serverRoot, full).split(path.sep).join('/');
      if (relative.startsWith('scripts/') || /migration|schema/.test(relative)) continue;
      const source = readFileSync(full, 'utf8');
      if (/FROM\s+api_keys\b[\s\S]{0,200}?is_active\s*=\s*1/.test(source) && !allowed.has(relative)) {
        offenders.push(relative);
      }
    }
  };
  walk(serverRoot);
  assert.deepEqual(offenders, [], 'route the check through apiKeyCredentialState');
  for (const file of ['modules/execution-permissions/execution-gateway.service.ts',
    'modules/database/repositories/engine-restamp-authority.ts']) {
    assert.match(readFileSync(path.join(serverRoot, file), 'utf8'), /apiKeyCredentialState\(/, file);
  }
});

test('a schema without last_attested_at never throws; linked members fail closed', async () => {
  await withIsolatedDatabase(() => {
    getConnection().prepare("INSERT INTO app_config (key, value) VALUES ('external_api.enabled', '1')").run();
    const owner = linkedMemberWithKey('nocol-owner', null, 'owner');
    const local = userDb.createUser('nocol-local', 'hash', 'user');
    const localKey = apiKeysDb.createApiKey(local.id, 'local');
    const member = linkedMemberWithKey('nocol-member', NOW - DAY_MS);
    assert.equal(reason(member.key.apiKey), 'ok', 'detected with the column first');

    const codes = capturedWarnings(() => {
      getConnection().exec('ALTER TABLE user_identities DROP COLUMN last_attested_at');
      assert.equal(reason(owner.key.apiKey), 'ok', 'owner keys keep working');
      assert.equal(reason(localKey.apiKey), 'ok', 'unlinked member keys keep working');
      assert.equal(reason(member.key.apiKey), 'sso_attestation_expired', 'schema change re-detected');
      const memberRow = apiKeysDb.getApiKeys(member.user.id)[0]!;
      assert.equal(apiKeysDb.isAuthenticationPrincipalCurrent(memberRow.id, member.user.id,
        userDb.getRawById(member.user.id)!.authorization_generation), false);
      const review = new AgentReviewReadonlyAuthRepository(getConnection());
      assert.ok(review.key(owner.key.apiKey));
      assert.equal(review.key(member.key.apiKey), null);
    });
    assert.deepEqual(codes, ['api_key_sso_attestation_column_missing'], 'logged once per schema version');
  });
});

/** Builds the compatible-forward schema fixture (user_identities has no attestation stamp). */
function forwardFixtureDatabase(): Database.Database {
  const fixtureUrl = new URL('../../../scripts/fixtures/compatible-forward-schema-v1.json', import.meta.url);
  const fixture = JSON.parse(readFileSync(fixtureUrl, 'utf8')) as { objects: { type: string; sql: string }[] };
  const db = new Database(':memory:');
  for (const type of ['table', 'index', 'view', 'trigger']) {
    for (const object of fixture.objects.filter((item) => item.type === type)) db.exec(object.sql);
  }
  return db;
}

test('the compatible-forward schema keeps owner and local keys working', () => {
  const db = forwardFixtureDatabase();
  try {
    const columns = db.prepare('PRAGMA table_info(user_identities)').all() as { name: string }[];
    assert.equal(columns.some((column) => column.name === 'last_attested_at'), false, 'fixture premise');
    db.prepare("INSERT INTO app_config (key, value) VALUES ('external_api.enabled', '1')").run();
    const addUser = (id: number, role: string) => db.prepare(`INSERT INTO users
      (id, username, password_hash, role, password_changed_at) VALUES (?, ?, 'hash', ?, 0)`)
      .run(id, `forward-${id}`, role);
    const addKey = (id: number, userId: number) => {
      const secret = `ck_${String(id).repeat(64).slice(0, 64)}`;
      db.prepare(`INSERT INTO api_keys (id, user_id, key_name, key_digest, key_prefix)
        VALUES (?, ?, 'k', ?, ?)`).run(id, userId, digestApiKey(secret), secret.slice(0, 10));
      return secret;
    };
    addUser(1, 'owner'); addUser(2, 'user'); addUser(3, 'user');
    const keys = { owner: addKey(1, 1), local: addKey(2, 2), linked: addKey(3, 3) };
    db.prepare("INSERT INTO user_identities (user_id, issuer, subject) VALUES (1, 'i', 'o'), (3, 'i', 'm')").run();

    const codes = capturedWarnings(() => {
      assert.equal(apiKeyCredentialState(db, { apiKeyId: 1, userId: 1 }), 'current');
      assert.equal(apiKeyCredentialState(db, { apiKeyId: 2, userId: 2 }), 'current');
      assert.equal(apiKeyCredentialState(db, { apiKeyId: 3, userId: 3 }), 'sso_attestation_expired');
      const review = new AgentReviewReadonlyAuthRepository(db);
      assert.ok(review.key(keys.owner));
      assert.ok(review.key(keys.local));
      assert.equal(review.key(keys.linked), null);
    });
    assert.deepEqual(codes, ['api_key_sso_attestation_column_missing']);
  } finally {
    db.close();
  }
});

test('a schema without user_identities or app_config treats every account as unlinked', () => {
  const db = new Database(':memory:');
  try {
    db.exec(`CREATE TABLE users (id INTEGER PRIMARY KEY, role TEXT, status TEXT, is_active INTEGER,
        authorization_generation INTEGER);
      CREATE TABLE api_keys (id INTEGER PRIMARY KEY, user_id INTEGER, is_active INTEGER);
      INSERT INTO users VALUES (4, 'user', 'active', 1, 1);
      INSERT INTO api_keys VALUES (9, 4, 1);`);
    assert.equal(apiKeyCredentialState(db, { apiKeyId: 9, userId: 4, authorizationGeneration: 1 }), 'current');
    assert.equal(apiKeyCredentialState(db, { apiKeyId: 9, userId: 4, authorizationGeneration: 2 }), 'invalid');
    assert.equal(apiKeyCredentialState(db, { apiKeyId: 0, userId: 4 }), 'invalid');
  } finally {
    db.close();
  }
});
