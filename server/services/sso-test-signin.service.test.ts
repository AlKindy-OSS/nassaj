/**
 * ADR-194 D8 test sign-in evidence (T-1962 S3): the display result is
 * one-time, owner-bound and short-lived; the apply proof is passed only when a
 * role mapped and the tenant restriction held, and survives reads.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test, { beforeEach } from 'node:test';

const { initializeDatabase } = await import('@/modules/database/init-db.js');
const { stopReconcileScheduler } = await import('@/modules/database/project-reconcile.service.js');
const { getConnection } = await import('@/modules/database/connection.js');
const { userDb } = await import('@/modules/database/index.js');
const { hasPassedSsoApplyProofOn, SSO_TEST_RESULT_TTL_MS, SSO_APPLY_PROOF_TTL_MS } =
  await import('@/modules/database/repositories/sso-test-evidence.js');
const { validSsoRow } = await import('./__tests__/sso-config-fixture.js');
const signIn = await import('./sso-test-signin.service.js');
await initializeDatabase();
stopReconcileScheduler();

const db = getConnection();
const HASH = 'd'.repeat(64);
const owner = userDb.createUser('ev_owner', 'hash', 'owner');
const otherOwner = userDb.createUser('ev_owner_two', 'hash', 'owner');
const entry = { purpose: 'test', ownerUserId: owner.id, configHash: HASH, draftVersion: 4 } as const;
const draft = validSsoRow({ slot: 'draft' });
const now = Math.floor(Date.now() / 1000);

beforeEach(() => {
  db.exec('DELETE FROM sso_test_results; DELETE FROM sso_apply_proofs;');
});

const proofPassed = () => hasPassedSsoApplyProofOn(db, {
  ownerUserId: owner.id, configHash: HASH, draftVersion: 4, kind: 'sign_in', nowMs: Date.now(),
});

test('evaluateTestClaims: role, tenant, auth_time facts and shape flags', () => {
  const ok = signIn.evaluateTestClaims({ sub: 's', roles: ['admin', 'member'], org: 'org-1', auth_time: now }, draft, Date.now());
  assert.equal(ok.passed, true);
  assert.equal(ok.result.mappedRole, 'admin');
  assert.equal(ok.result.tenantOk, true);
  assert.deepEqual(ok.result.tenantClaimValue, ['org-1']);
  assert.equal(ok.result.authTimePresent, true);
  assert.equal(ok.result.authTimeFresh, true);
  assert.deepEqual(ok.shapeFlags, { roleClaimObjectOfObjects: false, authTimePresent: true, authTimeFresh: true });

  const tenant = signIn.evaluateTestClaims({ roles: ['member'], org: 'org-2', auth_time: now - 3600 }, draft, Date.now());
  assert.equal(tenant.passed, false);
  assert.equal(tenant.result.mappedRole, 'user', 'the role maps, the tenant does not');
  assert.equal(tenant.result.tenantOk, false);
  assert.deepEqual(tenant.result.diagnostics, ['tenant_not_allowed']);
  assert.equal(tenant.result.authTimeFresh, false);

  const big = signIn.evaluateTestClaims({ roles: Array.from({ length: 65 }, (_v, i) => `r${i}`) }, draft, Date.now());
  assert.deepEqual(big.result.roleClaimValue, { tooLarge: true });
  assert.deepEqual(big.result.diagnostics, ['claim_too_large']);

  const incomplete = signIn.evaluateTestClaims({ sub: 's', groups: ['x'] }, { ...draft, role_claim_path: '' }, Date.now());
  assert.equal(incomplete.passed, false);
  assert.deepEqual(incomplete.result.claimNames, ['sub', 'groups'], 'claim names help the owner find the path');
  assert.deepEqual(incomplete.result.diagnostics, ['mapping_incomplete']);
});

test('completeTestSignIn: display row + passed proof; one-time, owner-bound read', () => {
  const { resultId, passed } = signIn.completeTestSignIn(entry, { roles: ['member'], org: 'org-1' }, { draftRow: draft });
  assert.equal(passed, true);
  assert.match(resultId, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(signIn.readTestResult(resultId, otherOwner.id), null, 'another owner reads nothing');
  assert.equal(signIn.readTestResult(resultId, owner.id)?.mappedRole, 'user');
  assert.equal(signIn.readTestResult(resultId, owner.id), null, 'deleted on read');
  assert.equal(proofPassed(), true, 'the proof is not deleted on read');
  assert.equal(signIn.readTestResult('not-an-id', owner.id), null);
  assert.throws(() => signIn.completeTestSignIn({ ...entry, purpose: 'login' } as never, {}, { draftRow: draft }),
    /sso_test_entry_required/, 'a login entry can never complete a test');
});

test('a failed mapping is a non-passed proof; a failure without claims writes no proof', () => {
  signIn.completeTestSignIn(entry, { roles: ['nobody'], org: 'org-1' }, { draftRow: draft });
  assert.equal(proofPassed(), false);
  const { resultId } = signIn.recordTestFailure(entry, { diagnostic: 'provider_denied', oauthError: 'access_denied' });
  const result = signIn.readTestResult(resultId, owner.id);
  assert.deepEqual(result.diagnostics, ['provider_denied']);
  assert.equal(result.oauthError, 'access_denied');
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM sso_apply_proofs').get() as { n: number }).n, 1);
  const unsafe = signIn.recordTestFailure(entry, { diagnostic: 'Has Spaces <x>' });
  assert.deepEqual(signIn.readTestResult(unsafe.resultId, owner.id).diagnostics, [], 'only fixed codes are kept');
});

test('display results expire after 5 minutes, proofs after 24 hours; the sweep never throws', () => {
  const start = Date.now();
  const { resultId } = signIn.completeTestSignIn(entry, { roles: ['member'], org: 'org-1' }, { draftRow: draft, nowMs: start });
  assert.equal(signIn.readTestResult(resultId, owner.id, start + SSO_TEST_RESULT_TTL_MS + 1), null);
  assert.equal(hasPassedSsoApplyProofOn(db, {
    ownerUserId: owner.id, configHash: HASH, draftVersion: 4, kind: 'sign_in', nowMs: start + SSO_APPLY_PROOF_TTL_MS + 1,
  }), false);
  assert.equal(signIn.sweepTestEvidence(start + SSO_APPLY_PROOF_TTL_MS + 1), true);
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM sso_apply_proofs').get() as { n: number }).n, 0);
});

test('isolation: the module imports nothing from the session, provisioning, linking or grant paths', () => {
  const source = fs.readFileSync(new URL('./sso-test-signin.service.js', import.meta.url), 'utf8');
  const imports = [...source.matchAll(/from '([^']+)'/g)].map((match) => match[1]);
  assert.deepEqual(imports.sort(), [
    '../modules/database/connection.js',
    '../modules/database/repositories/audit-log.js',
    '../modules/database/repositories/sso-test-evidence.js',
    './sso-claim-path.js',
    './sso-role-mapping.js',
    'node:crypto',
  ]);
});
