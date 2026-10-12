/**
 * T-1906 / ADR-200 S7 — the Qwen credential audit lives in
 * providerSecretsService, so every write path (per-provider route →
 * providerCredentialsService, company fan-out → companyCredentialsService)
 * leaves EXACTLY ONE audit row per mutation, and no row ever carries the key.
 * A Token Plan key saves without consent and without an `sk-sp-` prefix; a
 * stored legacy Coding Plan record reports `legacy_profile` and deletes cleanly.
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { after, beforeEach, test } from 'node:test';

// B-1544: must stay the first app-side import; it sandboxes HOME, DATABASE_PATH and the
// harness roots before any app module reads them.
import { removeSandbox } from '@/modules/providers/tests/helpers/hermetic-sandbox.js';

process.env.NASSAJ_PROVIDER_SECRETS_KEY = crypto.randomBytes(32).toString('base64');

const { initializeDatabase, closeConnection, userDb, auditLogDb } = await import('@/modules/database/index.js');
const {
  _resetProviderSecretsServerKeyCache,
  setProviderKey,
} = await import('@/services/isolation/provider-secrets-store.js');
const { providerCredentialsService } = await import('./provider-credentials.service.js');
const { companyCredentialsService } = await import('./company-credentials.service.js');
const { providerSecretsService } = await import('./provider-secrets.service.js');

await initializeDatabase();
_resetProviderSecretsServerKeyCache();
const member = userDb.createUser('qwen-audit-member', 'hash', 'user');
// A Token Plan key: no vendor prefix (ADR-200 D3).
const KEY = ['tp', 'audit-secret-0123456789'].join('-');
const LEGACY_KEY = ['sk', 'sp-legacy-secret-0123456789'].join('-');

after(() => {
  closeConnection();
  removeSandbox();
});

let baseline = 0;
beforeEach(() => { baseline = auditLogDb.recent(1000).length; });

function newQwenRows() {
  return auditLogDb.recent(1000)
    .slice(0, auditLogDb.recent(1000).length - baseline)
    .filter((row) => String(row.action).startsWith('qwen_credential_'));
}

const qwenSlot = async () => (await companyCredentialsService.getStatus(member.id, 'alibaba-cloud'))
  .slots.find((slot) => slot.provider === 'qwen');

test('per-provider path: set and delete each write exactly one row, without the key', async () => {
  await providerCredentialsService.setKey(member.id, 'qwen', KEY, undefined, undefined, {
    ipAddress: '127.0.0.1', userAgent: 'test',
  });
  let rows = newQwenRows();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].action, 'qwen_credential_set');
  assert.ok(!JSON.stringify(rows[0]).includes(KEY));
  const metadata = JSON.parse(String(rows[0].metadata));
  assert.equal(metadata.plan, 'token_plan');
  assert.equal(metadata.region, 'international');
  assert.equal(metadata.consentVersion, undefined);

  baseline = auditLogDb.recent(1000).length;
  await providerCredentialsService.deleteKey(member.id, 'qwen');
  rows = newQwenRows();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].action, 'qwen_credential_deleted');
});

test('company path: a Token Plan key saves without sk-sp- or consent, one row, never the key', async () => {
  const result = await companyCredentialsService.setKey(member.id, 'alibaba-cloud', KEY, { isElevated: false });
  assert.equal(result.configured, true, JSON.stringify(result.slots));
  const rows = newQwenRows();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].action, 'qwen_credential_set');
  assert.ok(!JSON.stringify(rows[0]).includes(KEY));
  assert.deepEqual(providerSecretsService.getQwenProfile(member.id), {
    version: 1, plan: 'token_plan', region: 'international', key: KEY,
  });
  assert.equal(providerSecretsService.getQwenPlanStatus(member.id).status, 'ok');
  assert.equal((await qwenSlot())?.status, undefined, 'a Token Plan key carries no marker');
});

test('getQwenPlanStatus reports missing_key / ok / legacy_profile, never the key', async () => {
  await providerCredentialsService.deleteKey(member.id, 'qwen');
  assert.equal(providerSecretsService.getQwenPlanStatus(member.id).status, 'missing_key');
  await providerCredentialsService.setKey(member.id, 'qwen', KEY);
  const ok = providerSecretsService.getQwenPlanStatus(member.id);
  assert.equal(ok.status, 'ok');
  assert.ok(!JSON.stringify(ok).includes(KEY));
  setProviderKey(member.id, 'qwen', JSON.stringify({
    version: 1, plan: 'coding_plan', region: 'international', key: LEGACY_KEY,
  }));
  const legacy = providerSecretsService.getQwenPlanStatus(member.id);
  assert.equal(legacy.status, 'legacy_profile');
  assert.ok(!JSON.stringify(legacy).includes(LEGACY_KEY));
});

test('stored legacy coding_plan records show legacy_profile and their delete works', async () => {
  const legacyRecords = [
    JSON.stringify({ version: 1, plan: 'coding_plan', region: 'international', key: LEGACY_KEY }),
    JSON.stringify({ version: 1, plan: 'coding_plan', region: 'china', key: LEGACY_KEY }),
    JSON.stringify({ version: 1, plan: 'token_plan', region: 'china', key: KEY }),
    LEGACY_KEY, // first-wave bare key
  ];
  for (const record of legacyRecords) {
    setProviderKey(member.id, 'qwen', record);
    const slot = await qwenSlot();
    assert.equal(slot?.configured, true, 'a legacy record is never hidden');
    assert.equal(slot?.status, 'legacy_profile', record.slice(0, 40));
    assert.ok(!JSON.stringify(slot).includes(LEGACY_KEY));
    assert.equal((await providerCredentialsService.getStatus(member.id, 'qwen')).configured, true);

    baseline = auditLogDb.recent(1000).length;
    const removed = await companyCredentialsService.deleteKey(member.id, 'alibaba-cloud', { isElevated: false });
    assert.equal(removed.configured, false);
    assert.equal(newQwenRows()[0]?.action, 'qwen_credential_deleted');
    assert.equal((await qwenSlot())?.configured, false);
    assert.equal(providerSecretsService.getQwenProfile(member.id), null);
  }
});

test('re-saving over a legacy record replaces it with a Token Plan profile', async () => {
  setProviderKey(member.id, 'qwen', LEGACY_KEY);
  await companyCredentialsService.setKey(member.id, 'alibaba-cloud', KEY, { isElevated: false });
  assert.equal(providerSecretsService.getQwenProfile(member.id)?.plan, 'token_plan');
  assert.equal((await qwenSlot())?.status, undefined);
});
