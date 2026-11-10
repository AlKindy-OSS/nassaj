/**
 * B-1744 (T-2083, ADR-152 A1 owner principle): balance and quota reads run on
 * the requesting member's own key, or a key granted to them under ADR-152 —
 * never on a credential in the server's environment (KIMI_API_KEY,
 * GLM_API_KEY, …) and never on the operator's own CLI login. With neither,
 * the answer is "not linked" (null) and NO outbound call is made.
 *
 * Runner: node:test. Sandboxed $HOME + throwaway DB opened before any import.
 */

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, beforeEach, test } from 'node:test';

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'nassaj-b1744-'));
const ORIGINAL = {
  HOME: process.env.HOME,
  DATABASE_PATH: process.env.DATABASE_PATH,
  NASSAJ_PROVIDER_SECRETS_KEY: process.env.NASSAJ_PROVIDER_SECRETS_KEY,
  KIMI_API_KEY: process.env.KIMI_API_KEY,
  GLM_API_KEY: process.env.GLM_API_KEY,
  MOONSHOT_API_KEY: process.env.MOONSHOT_API_KEY,
  ZAI_API_KEY: process.env.ZAI_API_KEY,
};
const home = path.join(sandbox, 'home');
fs.mkdirSync(home, { recursive: true });
process.env.HOME = home;
process.env.DATABASE_PATH = path.join(sandbox, 'db.sqlite');
process.env.NASSAJ_PROVIDER_SECRETS_KEY = crypto.randomBytes(32).toString('base64');

const { initializeDatabase, closeConnection, credentialGrantsDb, userDb } = await import('@/modules/database/index.js');
const { setProviderKey, _resetProviderSecretsServerKeyCache } = await import('@/services/isolation/provider-secrets-store.js');
const { providerBalanceService } = await import('@/modules/providers/services/usage/provider-balance.service.js');
const { providerQuotaService } = await import('@/modules/providers/services/usage/provider-quota.service.js');

await initializeDatabase();

after(() => {
  closeConnection();
  for (const [key, value] of Object.entries(ORIGINAL)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  _resetProviderSecretsServerKeyCache();
  fs.rmSync(sandbox, { recursive: true, force: true });
});

const HOST_KEYS = { KIMI_API_KEY: 'sk-operator-kimi', GLM_API_KEY: 'sk-operator-glm', MOONSHOT_API_KEY: 'sk-operator-moonshot', ZAI_API_KEY: 'sk-operator-zai' };

beforeEach(() => {
  Object.assign(process.env, HOST_KEYS);
  providerBalanceService.__resetCache();
  providerQuotaService.__resetCache();
});

/** A fetch that records every outbound call and the credential it carried. */
function recordingFetch(body: unknown) {
  const calls: Array<{ url: string; auth: string }> = [];
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({ url: String(url), auth: headers.Authorization ?? '' });
    return { ok: true, status: 200, text: async () => JSON.stringify(body) } as unknown as Response;
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const BALANCE_BODY = { code: 0, data: { available_balance: 3, cash_balance: 3, voucher_balance: 0 } };
const QUOTA_BODY = { data: { limits: [{ type: 'TOKENS_LIMIT', percentage: 10, nextResetTime: 1 }] } };

let seq = 0;
const member = (role = 'user') => userDb.createUser(`b1744-${role}-${(seq += 1)}`, 'hash', role);

test('balance: a member with no key and no grant is "not linked" — the operator env key is never spent', async () => {
  const ebtehal = member();
  const { impl, calls } = recordingFetch(BALANCE_BODY);
  const result = await providerBalanceService.getBalance('moonshot', ebtehal.id, { fetchImpl: impl });
  assert.equal(result, null);
  assert.deepEqual(calls, [], 'no outbound call without the member\'s own or granted key');
});

test('quota: a member with no key and no grant is "not linked" — GLM_API_KEY is never spent', async () => {
  const ebtehal = member();
  const { impl, calls } = recordingFetch(QUOTA_BODY);
  const result = await providerQuotaService.getWindows('glm', ebtehal.id, { fetchImpl: impl });
  assert.equal(result, null);
  assert.deepEqual(calls, []);
});

test('balance and quota run on the member\'s OWN key even when a host key is set', async () => {
  const user = member();
  setProviderKey(user.id, 'kimi', 'sk-own-kimi');
  setProviderKey(user.id, 'glm', 'sk-own-glm');
  const balance = recordingFetch(BALANCE_BODY);
  assert.ok(await providerBalanceService.getBalance('moonshot', user.id, { fetchImpl: balance.impl }));
  assert.deepEqual(balance.calls.map((c) => c.auth), ['Bearer sk-own-kimi']);
  const quota = recordingFetch(QUOTA_BODY);
  assert.ok(await providerQuotaService.getWindows('glm', user.id, { fetchImpl: quota.impl }));
  assert.deepEqual(quota.calls.map((c) => c.auth), ['sk-own-glm']);
});

test('a grantee reads on the grantor\'s key (ADR-152); after revocation, "not linked" and no call', async () => {
  const owner = member('owner');
  const grantee = member();
  setProviderKey(owner.id, 'glm', 'sk-grantor-glm');
  credentialGrantsDb.grant(owner.id, grantee.id, 'glm');
  const granted = recordingFetch(QUOTA_BODY);
  assert.ok(await providerQuotaService.getWindows('glm', grantee.id, { fetchImpl: granted.impl }));
  assert.deepEqual(granted.calls.map((c) => c.auth), ['sk-grantor-glm']);

  credentialGrantsDb.revoke(owner.id, grantee.id, 'glm');
  providerQuotaService.__resetCache();
  const revoked = recordingFetch(QUOTA_BODY);
  assert.equal(await providerQuotaService.getWindows('glm', grantee.id, { fetchImpl: revoked.impl }), null);
  assert.deepEqual(revoked.calls, []);
});

test('no member at all: "not linked", no call, and the operator\'s own kimi login is never read', async () => {
  const kimiDir = path.join(home, '.kimi-code', 'credentials');
  fs.mkdirSync(kimiDir, { recursive: true });
  fs.writeFileSync(path.join(kimiDir, 'kimi-code.json'),
    JSON.stringify({ access_token: 'operator-kimi-oauth', expires_at: Math.floor(Date.now() / 1000) + 3600 }));
  for (const [read, vendor] of [
    [(f: typeof fetch) => providerBalanceService.getBalance('moonshot', null, { fetchImpl: f }), 'moonshot'],
    [(f: typeof fetch) => providerQuotaService.getWindows('glm', null, { fetchImpl: f }), 'glm'],
    [(f: typeof fetch) => providerQuotaService.getWindows('kimi', null, { fetchImpl: f }), 'kimi'],
  ] as const) {
    const { impl, calls } = recordingFetch(vendor === 'moonshot' ? BALANCE_BODY : QUOTA_BODY);
    assert.equal(await read(impl), null, vendor);
    assert.deepEqual(calls, [], `${vendor}: no outbound call for a caller with no member`);
  }
});

test('static: neither service reads a provider credential from process.env', () => {
  const dir = path.dirname(new URL(import.meta.url).pathname);
  for (const file of ['provider-balance.service.ts', 'provider-quota.service.ts']) {
    const source = fs.readFileSync(path.join(dir, file), 'utf8')
      .split('\n').filter((line) => !/^\s*(\/\/|\*)/.test(line)).join('\n');
    assert.doesNotMatch(source, /process\.env\.[A-Z_]*(API_KEY|TOKEN)/, file);
    assert.doesNotMatch(source, /process\.env\[/, file);
  }
});
