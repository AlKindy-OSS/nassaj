/**
 * T-1939 slice 4: JIT decisions (username derivation, tenant restriction, cap), the
 * SSO-only password sentinel, and the one-transaction createSsoUser write on a
 * real, isolated SQLite database.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { getConnection } from '@/modules/database/connection.js';
import { initializeDatabase } from '@/modules/database/init-db.js';
import { stopReconcileScheduler } from '@/modules/database/project-reconcile.service.js';
import { userIdentitiesDb } from '@/modules/database/repositories/user-identities.js';
import { userDb } from '@/modules/database/repositories/users.js';

import { clearSsoConfig, writeSsoRow } from './__tests__/sso-config-fixture.js';
import {
  fixtureRowFields,
  FOREIGN_ROLES_CLAIM,
  NESTED_ROLES_CLAIM,
  PROVIDER_FIXTURES,
} from './__tests__/sso-provider-claims.js';
import {
  deriveUsername,
  planJitProvision,
  PROVISION_CAP_PER_HOUR,
  provisionCapReached,
  provisionSsoUser,
  resetProvisionCap,
} from './oidc-jit-provision.js';
import { hashPassword, needsRehash, verifyPassword } from './password.service.js';
import { resetSsoConfigCacheForTests } from './sso-config.service.js';
import { SSO_ONLY_PASSWORD_HASH } from './sso-only-password.js';
import { isReservedUsername, isUsernameAvailable } from './username-policy.js';

const ISSUER = 'https://issuer.example';

await initializeDatabase();
stopReconcileScheduler();

// ---------------------------------------------------------------------------
// Username derivation (qa M4)
// ---------------------------------------------------------------------------

test('deriveUsername: local part, lower-case, [a-z0-9_] only, trimmed to 32', () => {
  assert.equal(deriveUsername('Sara.Ali@idp.example', 's'), 'sara_ali');
  assert.equal(deriveUsername('omar-k', 's'), 'omar_k');
  assert.equal(deriveUsername('Ab.c@d@e', 's'), 'ab_c', 'split at the first @');
  assert.equal(deriveUsername('x'.repeat(80), 's'), 'x'.repeat(32));
  assert.equal(deriveUsername('ali محمد', 's'), 'ali_____');
  assert.equal(deriveUsername('bob😀', 's'), 'bob_', 'one underscore per code point, not per UTF-16 unit');
});

test('deriveUsername: short, empty, missing or letterless names fall back to user_<base32>', () => {
  const fallback = deriveUsername(undefined, 'subject-1');
  assert.match(fallback, /^user_[a-z2-7]{8}$/);
  assert.equal(deriveUsername('ab', 'subject-1'), fallback, 'stable per subject');
  assert.equal(deriveUsername('@idp.example', 'subject-1'), fallback);
  assert.equal(deriveUsername('محمد', 'subject-1'), fallback, 'all-Arabic name');
  assert.equal(deriveUsername('😀😀😀', 'subject-1'), fallback, 'all-emoji name');
  assert.equal(deriveUsername(42, 'subject-1'), fallback);
  assert.notEqual(deriveUsername(undefined, 'subject-2'), fallback);
});

test('deriveUsername: known sha256/base32 vector for the fallback', () => {
  // sha256('abc') = ba7816bf8f...; RFC 4648 base32 of those 5 bytes = 'xj4bnp4p'.
  assert.equal(deriveUsername('', 'abc'), 'user_xj4bnp4p');
});

// ---------------------------------------------------------------------------
// Configuration and plan
// ---------------------------------------------------------------------------

type JitSetup = { sso?: 'on' | 'off'; jit?: boolean; fields?: Record<string, unknown> };

const NESTED = PROVIDER_FIXTURES.nestedGrants;

/**
 * Runs `body` with a real active SSO row (ADR-194 D3) whose jit_enabled follows
 * `jit` (default on) and whose mapping defaults to the nested-grant fixture
 * (`role_grant_scope`, allowed scope `org-a`), or with no row (`sso: 'off'`).
 */
function withJitEnv(setup: JitSetup, body: () => void) {
  resetSsoConfigCacheForTests();
  if (setup.sso === 'off') clearSsoConfig(getConnection());
  else {
    writeSsoRow(getConnection(), fixtureRowFields(NESTED, {
      jit_enabled: setup.jit === false ? 0 : 1, ...setup.fields,
    }) as never);
  }
  try {
    body();
  } finally {
    clearSsoConfig(getConnection());
    resetSsoConfigCacheForTests();
  }
}

const plan = (claims: Record<string, unknown>) => planJitProvision({
  claims: { preferred_username: 'lina', ...claims }, subject: 's', nowMs: Date.now(),
}).outcome;

test('planJitProvision: every gate, in order (role_grant_scope)', () => {
  const memberFromA = { [NESTED_ROLES_CLAIM]: { member: { 'org-a': 'a' } } };
  withJitEnv({ jit: false }, () => assert.equal(plan(memberFromA), 'disabled'));
  withJitEnv({ sso: 'off' }, () => assert.equal(plan(memberFromA), 'disabled'));
  withJitEnv({ fields: { tenant_mode: 'none', tenant_values_json: '[]' } }, () => {
    assert.equal(plan(memberFromA), 'disabled', 'JIT with no tenant restriction is an invalid row');
  });
  withJitEnv({}, () => {
    assert.equal(plan({}), 'no_role');
    assert.equal(plan({ [NESTED_ROLES_CLAIM]: { owner: { 'org-a': 'a' } } }), 'no_role');
    assert.equal(plan({ [FOREIGN_ROLES_CLAIM]: { member: { 'org-a': 'a' } } }), 'no_role');
    assert.equal(plan({ [NESTED_ROLES_CLAIM]: { member: { 'org-b': 'b' } } }), 'tenant_not_allowed');
    assert.equal(plan({ [NESTED_ROLES_CLAIM]: ['member'] }), 'tenant_not_allowed', 'unprovable scope grants nothing');
    const huge = Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`o${i}`, 'd']));
    assert.equal(plan({ [NESTED_ROLES_CLAIM]: { member: huge } }), 'claim_too_large');
    assert.deepEqual(planJitProvision({ claims: { preferred_username: 'lina', ...memberFromA },
      subject: 's', nowMs: Date.now() }), { outcome: 'ready', role: 'user', username: 'lina' });
  });
});

test('planJitProvision: claim tenant mode across provider shapes', () => {
  for (const name of ['realmRoles', 'appRoles', 'groups'] as const) {
    const fixture = PROVIDER_FIXTURES[name];
    withJitEnv({ fields: fixtureRowFields(fixture, { jit_enabled: 1 }) }, () => {
      const outcome = planJitProvision({ claims: fixture.claims, subject: name, nowMs: Date.now() });
      assert.equal(outcome.outcome, 'ready', name);
      assert.equal((outcome as { role: string }).role, fixture.expectedRole, name);
    });
  }
  const groups = PROVIDER_FIXTURES.groups;
  withJitEnv({ fields: fixtureRowFields(groups, { jit_enabled: 1 }) }, () => {
    assert.equal(plan({ ...groups.claims, org_id: 'o-other' }), 'tenant_not_allowed');
  });
  withJitEnv({ fields: fixtureRowFields(groups, {
    jit_enabled: 1, tenant_claim_path: 'email', tenant_values_json: '["a@x.example"]',
  }) }, () => {
    assert.equal(plan({ groups: ['nassaj-users'], email: 'a@x.example' }), 'email_unverified');
    assert.equal(plan({ groups: ['nassaj-users'], email: 'a@x.example', email_verified: true }), 'ready');
  });
  withJitEnv({ fields: fixtureRowFields(PROVIDER_FIXTURES.hostedDomainNoRoles, { jit_enabled: 1 }) }, () => {
    assert.equal(plan(PROVIDER_FIXTURES.hostedDomainNoRoles.claims), 'no_role', 'no role claim, no account');
  });
});

// ---------------------------------------------------------------------------
// Username policy (shared by self-rename, invites and JIT)
// ---------------------------------------------------------------------------

test('isReservedUsername covers the reserved names case-insensitively and only them', () => {
  for (const name of ['owner', 'ADMIN', 'Administrator', 'root', 'superuser', 'system', 'nassaj',
    'api', 'support', 'guest', 'User', 'null', 'undefined']) {
    assert.equal(isReservedUsername(name), true, name);
  }
  for (const name of ['sara', 'admin1', 'users', '', 42, null, undefined]) {
    assert.equal(isReservedUsername(name), false, String(name));
  }
});

test('isUsernameAvailable: case-insensitive over any status, excluding the caller', () => {
  const holder = userDb.createUser('Policy_Holder', 'hash', 'user');
  userDb.setStatus(holder.id, 'disabled');
  assert.equal(isUsernameAvailable('policy_holder'), false);
  assert.equal(isUsernameAvailable('POLICY_HOLDER'), false);
  assert.equal(isUsernameAvailable('policy_holder', { excludeUserId: holder.id }), true, 'own case change');
  assert.equal(isUsernameAvailable('policy_free'), true);
  assert.equal(isUsernameAvailable('Guest'), false, 'reserved');
});

test('the database refuses a case-only duplicate username (idx_users_username_lower)', () => {
  userDb.createUser('Index_Probe', 'hash', 'user');
  assert.throws(() => userDb.createUser('index_probe', 'hash', 'user'),
    (error: { code?: string }) => error.code === 'SQLITE_CONSTRAINT_UNIQUE');
});

test('the provision cap is process-wide and rolls over after an hour', () => {
  resetProvisionCap();
  const start = 1_000_000;
  for (let index = 0; index < PROVISION_CAP_PER_HOUR; index += 1) {
    assert.equal(provisionCapReached(start), false);
    const result = provisionSsoUser({
      username: `cap_user_${index}`, role: 'user', issuer: ISSUER, subject: `cap-${index}`, nowMs: start,
    });
    assert.equal(result.created, true);
  }
  assert.equal(provisionCapReached(start + 59 * 60_000), true);
  assert.equal(provisionCapReached(start + 60 * 60_000), false);
  resetProvisionCap();
});

// ---------------------------------------------------------------------------
// createSsoUser (one transaction)
// ---------------------------------------------------------------------------

test('createSsoUser writes the account, link and stamp together', () => {
  const result = userDb.createSsoUser({
    username: 'tx_user', passwordHash: SSO_ONLY_PASSWORD_HASH, role: 'admin', issuer: ISSUER,
    subject: 'tx-subject', attestedAtMs: 1234, isReservedUsername,
  });
  assert.equal(result.created, true);
  if (!result.created) return;
  assert.equal(userDb.getRawById(result.user.id)?.role, 'admin');
  const link = userIdentitiesDb.findByIssuerAndSubject(ISSUER, 'tx-subject');
  assert.equal(link?.id, result.identityId);
  assert.equal(link?.last_attested_at, 1234);
});

test('createSsoUser rolls the account back when the subject is already linked', () => {
  const holder = userDb.createUser('subject_holder', 'hash', 'user');
  userIdentitiesDb.link(holder.id, ISSUER, 'taken-subject');
  const count = () => (getConnection().prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n;
  const before = count();
  assert.throws(() => userDb.createSsoUser({
    username: 'rollback_user', passwordHash: SSO_ONLY_PASSWORD_HASH, role: 'user', issuer: ISSUER,
    subject: 'taken-subject', attestedAtMs: 1, isReservedUsername,
  }), (error: { code?: string }) => String(error.code).startsWith('SQLITE_CONSTRAINT'));
  assert.equal(count(), before, 'no orphan account without its link');
  assert.equal(userDb.getUserByUsername('rollback_user'), undefined);
});

test('createSsoUser refuses a case-insensitive clash (any status) and reserved names', () => {
  const existing = userDb.createUser('MixedCase', 'hash', 'user');
  userDb.setStatus(existing.id, 'disabled');
  const attempt = (username: string) => userDb.createSsoUser({
    username, passwordHash: SSO_ONLY_PASSWORD_HASH, role: 'user', issuer: ISSUER,
    subject: `clash-${username}`, attestedAtMs: 1, isReservedUsername,
  });
  assert.deepEqual(attempt('mixedcase'), { created: false, reason: 'username_taken' });
  assert.deepEqual(attempt('support'), { created: false, reason: 'username_taken' });
  assert.equal(userIdentitiesDb.findByIssuerAndSubject(ISSUER, 'clash-mixedcase'), undefined);
});

test('createSsoUser never creates an owner', () => {
  assert.throws(() => userDb.createSsoUser({
    username: 'would_be_owner', passwordHash: SSO_ONLY_PASSWORD_HASH, role: 'owner' as never, issuer: ISSUER,
    subject: 'owner-subject', attestedAtMs: 1, isReservedUsername,
  }), /invalid_sso_role/);
});

// ---------------------------------------------------------------------------
// SSO-only password sentinel
// ---------------------------------------------------------------------------

test('the SSO-only sentinel never verifies and is never rehashed', async () => {
  for (const candidate of ['', 'password', SSO_ONLY_PASSWORD_HASH, '!sso-only:v1', 'x'.repeat(1024)]) {
    assert.equal(await verifyPassword(SSO_ONLY_PASSWORD_HASH, candidate), false);
  }
  assert.equal(needsRehash(SSO_ONLY_PASSWORD_HASH), false);
  assert.equal(needsRehash('$2b$10$legacy'), true, 'legacy hashes still upgrade');
});

test('the sentinel costs a real argon2id verification (timing path unchanged)', async () => {
  const realHash = await hashPassword('the-real-password');
  const time = async (hash: string) => {
    const started = process.hrtime.bigint();
    for (let index = 0; index < 3; index += 1) await verifyPassword(hash, 'wrong-password');
    return Number(process.hrtime.bigint() - started);
  };
  await time(realHash);
  const real = await time(realHash);
  const sentinel = await time(SSO_ONLY_PASSWORD_HASH);
  const malformed = await time('not-a-hash');
  assert.ok(sentinel > real * 0.5, `sentinel ${sentinel}ns vs real ${real}ns`);
  assert.ok(sentinel > malformed * 5, 'far slower than the malformed-hash fast path');
});
