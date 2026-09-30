/**
 * T-1906 — the Qwen credential audit lives in providerSecretsService, so every
 * write path (per-provider route → providerCredentialsService, company fan-out
 * → companyCredentialsService) leaves EXACTLY ONE audit row per mutation, and
 * no row ever carries the key.
 */
// FIRST import — HOME becomes a /var/tmp sandbox before anything reads it.
import '@/shared/__tests__/sandbox-home.js';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { after, beforeEach, test } from 'node:test';

const sandbox = fs.mkdtempSync(path.join(fs.realpathSync('/var/tmp'), 'nassaj-qwen-audit-'));
process.env.DATABASE_PATH = path.join(sandbox, 'auth.db');
process.env.NASSAJ_PROVIDER_SECRETS_KEY = crypto.randomBytes(32).toString('base64');

const { initializeDatabase, closeConnection, userDb, auditLogDb } = await import('@/modules/database/index.js');
const { _resetProviderSecretsServerKeyCache } = await import('@/services/isolation/provider-secrets-store.js');
const { providerCredentialsService } = await import('./provider-credentials.service.js');
const { companyCredentialsService } = await import('./company-credentials.service.js');
const { providerSecretsService, QWEN_CONSENT_VERSION } = await import('./provider-secrets.service.js');
const CONSENT = { consentVersion: QWEN_CONSENT_VERSION };

await initializeDatabase();
_resetProviderSecretsServerKeyCache();
const member = userDb.createUser('qwen-audit-member', 'hash', 'user');
const KEY = ['sk', 'sp-audit-secret-0123456789'].join('-');

after(() => {
  closeConnection();
  fs.rmSync(sandbox, { recursive: true, force: true });
});

let baseline = 0;
beforeEach(() => { baseline = auditLogDb.recent(1000).length; });

function newQwenRows() {
  return auditLogDb.recent(1000)
    .slice(0, auditLogDb.recent(1000).length - baseline)
    .filter((row) => String(row.action).startsWith('qwen_credential_'));
}

test('per-provider path without consent is a 400, stores nothing and writes no row', async () => {
  for (const context of [undefined, { ipAddress: '127.0.0.1' }, { consentVersion: null }, { consentVersion: 'old' }]) {
    await assert.rejects(
      providerCredentialsService.setKey(member.id, 'qwen', KEY, undefined, undefined, undefined, context),
      (error: { statusCode?: number; code?: string; details?: { consentVersion?: string } }) =>
        error.statusCode === 400 && error.code === 'CONSENT_REQUIRED'
        && error.details?.consentVersion === QWEN_CONSENT_VERSION,
    );
  }
  assert.equal(newQwenRows().length, 0);
  assert.equal((await providerCredentialsService.getStatus(member.id, 'qwen')).configured, false);
});

test('per-provider path: set and delete each write exactly one row, without the key', async () => {
  await providerCredentialsService.setKey(member.id, 'qwen', KEY, undefined, undefined, undefined, {
    ipAddress: '127.0.0.1', userAgent: 'test', ...CONSENT,
  });
  let rows = newQwenRows();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].action, 'qwen_credential_set');
  assert.ok(!JSON.stringify(rows[0]).includes(KEY));
  assert.equal(JSON.parse(String(rows[0].metadata)).consentVersion, QWEN_CONSENT_VERSION);

  baseline = auditLogDb.recent(1000).length;
  await providerCredentialsService.deleteKey(member.id, 'qwen');
  rows = newQwenRows();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].action, 'qwen_credential_deleted');
});

test('company path: one row carrying the consent version, never the key', async () => {
  const result = await companyCredentialsService.setKey(member.id, 'alibaba-cloud', KEY, {
    isElevated: false, consent: true,
  });
  assert.equal(result.configured, true, JSON.stringify(result.slots));
  const rows = newQwenRows();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].action, 'qwen_credential_set');
  assert.ok(!JSON.stringify(rows[0]).includes(KEY));
  assert.equal(JSON.parse(String(rows[0].metadata)).consentVersion, 'qwen-plan-personal-use/2026-09-28');
});

test('company path without consent writes no row and stores nothing', async () => {
  await providerCredentialsService.deleteKey(member.id, 'qwen');
  baseline = auditLogDb.recent(1000).length;
  await assert.rejects(companyCredentialsService.setKey(member.id, 'alibaba-cloud', KEY, { isElevated: false }));
  assert.equal(newQwenRows().length, 0);
  assert.equal((await providerCredentialsService.getStatus(member.id, 'qwen')).configured, false);
});

test('getQwenPlanStatus reports missing_key / ok / incompatible_profile, never the key', async () => {
  await providerCredentialsService.deleteKey(member.id, 'qwen');
  assert.equal(providerSecretsService.getQwenPlanStatus(member.id).status, 'missing_key');
  await providerCredentialsService.setKey(member.id, 'qwen', KEY, undefined, undefined, undefined, CONSENT);
  const ok = providerSecretsService.getQwenPlanStatus(member.id);
  assert.equal(ok.status, 'ok');
  assert.ok(!JSON.stringify(ok).includes(KEY));
  await providerCredentialsService.setKey(member.id, 'qwen', KEY, undefined, { plan: 'coding_plan', region: 'china' }, undefined, CONSENT);
  assert.equal(providerSecretsService.getQwenPlanStatus(member.id).status, 'incompatible_profile');
  await providerCredentialsService.setKey(member.id, 'qwen', 'tp-token-plan-key-0123456789', undefined, { plan: 'token_plan' }, undefined, CONSENT);
  assert.equal(providerSecretsService.getQwenPlanStatus(member.id).status, 'incompatible_profile');
});

test('company status marks the alibaba-cloud qwen slot incompatible_profile for token_plan or china', async () => {
  const qwenSlot = async () => (await companyCredentialsService.getStatus(member.id, 'alibaba-cloud'))
    .slots.find((slot) => slot.provider === 'qwen');
  await providerCredentialsService.deleteKey(member.id, 'qwen');
  assert.equal((await qwenSlot())?.status, undefined, 'no key → no marker');
  await providerCredentialsService.setKey(member.id, 'qwen', KEY, undefined, undefined, undefined, CONSENT);
  assert.equal((await qwenSlot())?.status, undefined, 'compatible key → no marker');
  await providerCredentialsService.setKey(member.id, 'qwen', KEY, undefined, { plan: 'coding_plan', region: 'china' }, undefined, CONSENT);
  assert.equal((await qwenSlot())?.status, 'incompatible_profile');
  await providerCredentialsService.setKey(member.id, 'qwen', 'tp-token-plan-key-0123456789', undefined, { plan: 'token_plan' }, undefined, CONSENT);
  const slot = await qwenSlot();
  assert.equal(slot?.status, 'incompatible_profile');
  assert.ok(!JSON.stringify(slot).includes('tp-token-plan-key'));
});
