/**
 * ADR-227 / T-2098 qa item 2 — a Claude chat runs on a local server only at the
 * address where the member's last "test connection" succeeded. The test probes
 * the same way the spawn connects (the vetted IP literal, so a name-based vhost
 * fails here, not mid-chat), stores that address, and a later spawn whose vetted
 * address differs is refused with `address_changed` until the member re-tests.
 *
 * Sandboxed $HOME + throwaway DB; network calls are injected stubs.
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, beforeEach, describe, it } from 'node:test';

const sandbox = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 't2098-verified-'));
process.env.HOME = path.join(sandbox, 'home');
fs.mkdirSync(process.env.HOME, { recursive: true });
process.env.DATABASE_PATH = path.join(sandbox, 'db.sqlite');
process.env.NASSAJ_PROVIDER_SECRETS_KEY = crypto.randomBytes(32).toString('base64');

const db = await import('@/modules/database/index.js');
const { createLocalModelsService } = await import('./services/local-models.service.js');
const { applyClaudeLocalEngineEnv } = await import('@/services/isolation/apply-claude-local-engine-env.js');

await db.initializeDatabase();
after(() => { db.closeConnection(); fs.rmSync(sandbox, { recursive: true, force: true }); });
db.appConfigDb.set('local_models.enabled', 'true');
db.appConfigDb.set('local_models.consent_version', '1');
// A fresh owner per case: the service throttles each caller to 10 calls a minute.
let owner = 0;

type Answer = { address: string; family: 4 | 6 };
let answer: Answer;
let answerSet: string[] | null;
let fetched: string[];
let literalFails: boolean;

const service = createLocalModelsService({
  repository: db.localModelServersDb,
  config: db.appConfigDb,
  audit: { recordStrict: () => {} },
  fetchJson: async (url: string) => {
    fetched.push(url);
    if (literalFails && !url.includes('llama.lan')) throw new Error('vhost refused the bare IP');
    return { data: [{ id: 'gpt-oss-20b' }] };
  },
  probeAuth: async () => ({ status: 400 }),
  resolvePrivate: async (url: string) => ({ url: new URL(url), ...answer, addresses: answerSet ?? [answer.address] }),
  transaction: <T>(work: () => T): T => work(),
  secrets: { get: () => null, set: () => {}, remove: () => {}, has: () => false },
} as never);

const spawnDeps = () => ({
  enabled: () => true,
  runnable: () => true,
  listServers: (userId: number) => db.localModelServersDb.list(Number(userId)),
  getSecret: () => null,
  resolvePrivate: async () => answer,
  cliVersionProven: () => true,
});

let server: { id: string; providerId: string };
beforeEach(() => {
  owner = Number(db.userDb.createUser(`verified-${crypto.randomUUID().slice(0, 8)}`, 'hash', 'user').id);
  answer = { address: '192.168.8.137', family: 4 };
  answerSet = null;
  fetched = [];
  literalFails = false;
  server = service.save(owner, {
    name: `s-${crypto.randomUUID().slice(0, 8)}`, baseUrl: 'http://llama.lan:8080/v1', runtime: 'llamacpp',
    models: [{ id: 'gpt-oss-20b', contextWindow: 32768 }],
  });
});

const spawn = () => applyClaudeLocalEngineEnv({}, { userId: owner, requestedModel: `${server.providerId}/gpt-oss-20b` }, spawnDeps());
const verified = () => {
  const set = db.localModelServersDb.get(server.id, owner)?.verifiedAddresses ?? [];
  return set.length === 0 ? null : set.join(',');
};

describe('test connection records the address the spawn will use', () => {
  it('a server never tested is refused with address_changed', async () => {
    assert.equal(verified(), null);
    const verdict = await spawn();
    assert.equal(verdict.status === 'unavailable' && verdict.reason, 'address_changed');
  });

  it('the test probes the literal address and records it; the spawn then runs', async () => {
    const result = await service.catalog(owner, server.id, false);
    assert.equal(result.connected, true);
    assert.ok(fetched.includes('http://192.168.8.137:8080/v1/models'), `probed by literal: ${fetched.join(', ')}`);
    assert.equal(verified(), '192.168.8.137');
    assert.equal((await spawn()).status, 'applied');
  });

  it('the name now resolving elsewhere refuses the spawn until the member re-tests', async () => {
    await service.catalog(owner, server.id, false);
    answer = { address: '192.168.8.140', family: 4 };
    const verdict = await spawn();
    assert.equal(verdict.status === 'unavailable' && verdict.reason, 'address_changed');
    await service.catalog(owner, server.id, false);
    assert.equal(verified(), '192.168.8.140');
    assert.equal((await spawn()).status, 'applied');
  });

  it('a literal probe that fails (name-based vhost) records nothing and clears an earlier address', async () => {
    await service.catalog(owner, server.id, false);
    literalFails = true;
    const result = await service.catalog(owner, server.id, false);
    assert.equal(result.connected, true, 'the catalogue by name still works for other bodies');
    assert.equal(result.claudeAddressVerified, false);
    assert.equal(verified(), null);
  });

  it('editing the base URL forgets the verified address', async () => {
    await service.catalog(owner, server.id, false);
    service.save(owner, { baseUrl: 'http://llama2.lan:8080/v1' }, server.id);
    assert.equal(verified(), null);
  });

  it('every private answer of the test is accepted (round-robin names), nothing else', async () => {
    answerSet = ['192.168.8.137', '192.168.8.138'];
    await service.catalog(owner, server.id, false);
    assert.equal(verified(), '192.168.8.137,192.168.8.138');
    answer = { address: '192.168.8.138', family: 4 };
    assert.equal((await spawn()).status, 'applied', 'the second answer of the tested set');
    answer = { address: '192.168.8.139', family: 4 };
    const verdict = await spawn();
    assert.equal(verdict.status === 'unavailable' && verdict.reason, 'address_changed');
  });
});
