import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import Database from 'better-sqlite3';

/* eslint-disable boundaries/dependencies -- migration conformance exercises the database owner. */
import { migrateConnectorProvisioning } from '../database/connector-provisioning.migration.js';
/* eslint-enable boundaries/dependencies */

import { CONNECTOR_PROVISIONING_SCHEMA_SQL, ConnectorProvisioningService } from './connector-provisioning.service.js';

const ORIGIN = { canonicalOrigin: 'https://nassaj.example.test', originRevision: 3,
  callbackUrl: 'https://nassaj.example.test/connectors/oauth/callback' };
const key = (suffix: string): string => `provisioning-${suffix}`;
const eligible = (database: Database.Database): void => {
  database.prepare(`INSERT INTO connector_provisioning_installation_eligibility
    (installation_id,eligible,created_at_ms) VALUES ('install-1',1,0)`).run();
};

test('provisioning migration is additive, empty, and idempotent', () => {
  const database = new Database(':memory:');
  try {
    migrateConnectorProvisioning(database, { newInstallationId: 'install-1', nowMs: 0 }); migrateConnectorProvisioning(database);
    assert.equal(database.prepare(`SELECT count(*) AS count FROM connector_provisioning_attempts`).get().count, 0);
    assert.equal(database.prepare(`SELECT count(*) AS count FROM connector_provisioning_locks`).get().count, 0);
    assert.equal(database.prepare(`SELECT count(*) AS count FROM connector_provisioning_installation_eligibility`).get().count, 1);
  } finally { database.close(); }
});

test('only the fresh-install bootstrap declaration grants provisioning eligibility', () => {
  const existing = new Database(':memory:'); const fresh = new Database(':memory:');
  try {
    migrateConnectorProvisioning(existing);
    migrateConnectorProvisioning(fresh, { newInstallationId: 'install-1', nowMs: 0 });
    assert.equal(existing.prepare(`SELECT count(*) AS count FROM connector_provisioning_installation_eligibility`).get().count, 0);
    assert.equal(fresh.prepare(`SELECT installation_id AS id FROM connector_provisioning_installation_eligibility`).get().id, 'install-1');
  } finally { existing.close(); fresh.close(); }
});

test('missing production channel is durable manual recovery and never registers DCR', async () => {
  const database = new Database(':memory:'); database.exec(CONNECTOR_PROVISIONING_SCHEMA_SQL); eligible(database);
  try {
    const service = new ConnectorProvisioningService(database, 'install-1', { resolve: () => ORIGIN } as never,
      effect => { effect(); return true; }, {}, () => 100, (() => { let index = 0; return () => `id-${++index}`; })());
    const first = await service.start('notion', key('missing-channel'));
    assert.equal(first.state, 'manual_recovery');
    assert.equal(first.reasonCode, 'CONNECTOR_PROVISIONING_TRUST_CHANNEL_UNAVAILABLE');
    assert.equal(database.prepare('SELECT count(*) AS count FROM connector_provisioning_attempts').get().count, 1);
    assert.deepEqual(await service.start('notion', key('missing-channel')), first);
  } finally { database.close(); }
});

test('verified origin, production channel and exact DCR receipt reach ready once', async () => {
  const database = new Database(':memory:'); database.exec(CONNECTOR_PROVISIONING_SCHEMA_SQL); eligible(database); let calls = 0;
  try {
    const service = new ConnectorProvisioningService(database, 'install-1', { resolve: () => ORIGIN } as never,
      effect => { effect(); return true; }, {
        trustChannel: { readCurrent: async () => ({ generation: 'generation-7', digest: 'pack-digest', dcrProviderIds: ['notion'], valid: true }) },
        originProofVerifier: { verify: async () => ({ evidenceDigest: 'origin-proof' }) },
        dcrRegistrar: { register: async input => { calls += 1;
          assert.equal(input.callbackUrl, ORIGIN.callbackUrl);
          assert.match(input.externalIdempotencyKey, /^[a-f0-9]{64}$/u);
          return { outcome: 'registered', receiptDigest: 'receipt-1' }; } },
      }, () => 100, (() => { let index = 0; return () => `id-${++index}`; })());
    const attempt = await service.start('notion', key('ready'));
    assert.equal(attempt.state, 'ready'); assert.equal(attempt.externalReceiptDigest, 'receipt-1');
    assert.equal(attempt.evidence.originProofDigest, 'origin-proof'); assert.equal(calls, 1);
    assert.deepEqual(await service.start('notion', key('ready')), attempt); assert.equal(calls, 1);
  } finally { database.close(); }
});

test('uncertain DCR result is retained for manual recovery and cannot be replayed', async () => {
  const database = new Database(':memory:'); database.exec(CONNECTOR_PROVISIONING_SCHEMA_SQL); eligible(database); let calls = 0;
  try {
    const service = new ConnectorProvisioningService(database, 'install-1', { resolve: () => ORIGIN } as never,
      effect => { effect(); return true; }, {
        trustChannel: { readCurrent: async () => ({ generation: 'generation-7', digest: 'pack-digest', dcrProviderIds: ['notion'], valid: true }) },
        originProofVerifier: { verify: async () => ({ evidenceDigest: 'origin-proof' }) },
        dcrRegistrar: { register: async () => { calls += 1; return { outcome: 'uncertain' as const }; } },
      }, () => 100, (() => { let index = 0; return () => `id-${++index}`; })());
    const first = await service.start('notion', key('uncertain'));
    assert.equal(first.state, 'manual_recovery'); assert.equal(first.reasonCode, 'CONNECTOR_PROVISIONING_DCR_UNCERTAIN');
    assert.equal(first.evidence.dcrPossibleEffect, 'reported_uncertain');
    await service.start('notion', key('uncertain')); assert.equal(calls, 1);
  } finally { database.close(); }
});

test('Google and Canva remain excluded before any persistence write', async () => {
  const database = new Database(':memory:'); database.exec(CONNECTOR_PROVISIONING_SCHEMA_SQL); eligible(database);
  try {
    const service = new ConnectorProvisioningService(database, 'install-1', { resolve: () => ORIGIN } as never,
      effect => { effect(); return true; });
    await assert.rejects(service.start('google-workspace', key('google')), /provider_excluded/u);
    await assert.rejects(service.start('canva', key('canva')), /provider_excluded/u);
    assert.equal(database.prepare('SELECT count(*) AS count FROM connector_provisioning_attempts').get().count, 0);
  } finally { database.close(); }
});

test('existing installations are rejected before an attempt is persisted', async () => {
  const database = new Database(':memory:'); database.exec(CONNECTOR_PROVISIONING_SCHEMA_SQL);
  try {
    const service = new ConnectorProvisioningService(database, 'install-1', { resolve: () => ORIGIN } as never,
      effect => { effect(); return true; });
    await assert.rejects(service.start('notion', key('legacy')), /existing_installation/u);
    assert.equal(database.prepare('SELECT count(*) AS count FROM connector_provisioning_attempts').get().count, 0);
  } finally { database.close(); }
});

test('one idempotency key cannot be rebound to another provider', async () => {
  const database = new Database(':memory:'); database.exec(CONNECTOR_PROVISIONING_SCHEMA_SQL); eligible(database);
  try {
    const service = new ConnectorProvisioningService(database, 'install-1', { resolve: () => ORIGIN } as never,
      effect => { effect(); return true; });
    await service.start('notion', key('binding'));
    await assert.rejects(service.start('sentry', key('binding')), /idempotency_conflict/u);
  } finally { database.close(); }
});

test('a revoked or expired trust pack fails closed before origin proof or DCR', async () => {
  const database = new Database(':memory:'); database.exec(CONNECTOR_PROVISIONING_SCHEMA_SQL); eligible(database); let proofs = 0; let registrations = 0;
  try {
    const service = new ConnectorProvisioningService(database, 'install-1', { resolve: () => ORIGIN } as never,
      effect => { effect(); return true; }, {
        trustChannel: { readCurrent: async () => ({ generation: 'revoked-8', digest: 'revoked-digest', dcrProviderIds: ['notion'], valid: false }) },
        originProofVerifier: { verify: async () => { proofs += 1; return { evidenceDigest: 'proof' }; } },
        dcrRegistrar: { register: async () => { registrations += 1; return { outcome: 'registered' as const, receiptDigest: 'receipt' }; } },
      });
    const attempt = await service.start('notion', key('revoked-pack'));
    assert.equal(attempt.state, 'manual_recovery');
    assert.equal(attempt.reasonCode, 'CONNECTOR_PROVISIONING_DCR_NOT_CERTIFIED');
    assert.equal(proofs, 0); assert.equal(registrations, 0);
  } finally { database.close(); }
});

test('a changed origin after proof blocks callback registration', async () => {
  const database = new Database(':memory:'); database.exec(CONNECTOR_PROVISIONING_SCHEMA_SQL); eligible(database); let registrations = 0; let resolves = 0;
  try {
    const service = new ConnectorProvisioningService(database, 'install-1', {
      resolve: () => ++resolves === 1 ? ORIGIN : { ...ORIGIN, canonicalOrigin: 'https://changed.example.test', originRevision: 4 },
    } as never, effect => { effect(); return true; }, {
      trustChannel: { readCurrent: async () => ({ generation: 'generation-7', digest: 'pack-digest', dcrProviderIds: ['notion'], valid: true }) },
      originProofVerifier: { verify: async () => ({ evidenceDigest: 'origin-proof' }) },
      dcrRegistrar: { register: async () => { registrations += 1; return { outcome: 'registered' as const, receiptDigest: 'receipt' }; } },
    });
    const attempt = await service.start('notion', key('origin-changed'));
    assert.equal(attempt.state, 'blocked'); assert.equal(attempt.reasonCode, 'CONNECTOR_PROVISIONING_ORIGIN_CHANGED');
    assert.equal(registrations, 0);
  } finally { database.close(); }
});

test('a trust generation rotated during proof blocks DCR and retains the verified generation', async () => {
  const database = new Database(':memory:'); database.exec(CONNECTOR_PROVISIONING_SCHEMA_SQL); eligible(database); let reads = 0; let registrations = 0;
  try {
    const service = new ConnectorProvisioningService(database, 'install-1', { resolve: () => ORIGIN } as never,
      effect => { effect(); return true; }, {
        trustChannel: { readCurrent: async () => ({ generation: ++reads === 1 ? 'generation-7' : 'generation-8', digest: 'pack-digest', dcrProviderIds: ['notion'], valid: true }) },
        originProofVerifier: { verify: async () => ({ evidenceDigest: 'origin-proof' }) },
        dcrRegistrar: { register: async () => { registrations += 1; return { outcome: 'registered' as const, receiptDigest: 'receipt' }; } },
      });
    const attempt = await service.start('notion', key('trust-rotated'));
    assert.equal(attempt.state, 'blocked'); assert.equal(attempt.reasonCode, 'CONNECTOR_PROVISIONING_TRUST_CHANGED');
    assert.equal(attempt.trustGeneration, 'generation-7'); assert.equal(registrations, 0);
  } finally { database.close(); }
});

test('a stale trust-generation CAS conflict prevents DCR instead of accepting stale evidence', async () => {
  const database = new Database(':memory:'); database.exec(CONNECTOR_PROVISIONING_SCHEMA_SQL); eligible(database); let registrations = 0;
  try {
    const service = new ConnectorProvisioningService(database, 'install-1', { resolve: () => ORIGIN } as never,
      effect => { effect(); return true; }, {
        trustChannel: { readCurrent: async () => ({ generation: 'generation-7', digest: 'pack-digest', dcrProviderIds: ['notion'], valid: true }) },
        originProofVerifier: { verify: async () => {
          database.prepare("UPDATE connector_provisioning_attempts SET trust_generation='generation-rotated' WHERE installation_id='install-1'").run();
          return { evidenceDigest: 'origin-proof' };
        } },
        dcrRegistrar: { register: async () => { registrations += 1; return { outcome: 'registered' as const, receiptDigest: 'receipt' }; } },
      });
    await assert.rejects(service.start('notion', key('stale-cas')), /connector_provisioning_cas_conflict/u);
    assert.equal(registrations, 0);
  } finally { database.close(); }
});

test('competing attempts for one provider are lock-blocked until the active DCR resolves', async () => {
  const database = new Database(':memory:'); database.exec(CONNECTOR_PROVISIONING_SCHEMA_SQL); eligible(database);
  let registrations = 0; let releaseRegistration: ((value: { outcome: 'registered'; receiptDigest: string }) => void)|undefined;
  const registration = new Promise<{ outcome: 'registered'; receiptDigest: string }>(resolve => { releaseRegistration = resolve; });
  try {
    const service = new ConnectorProvisioningService(database, 'install-1', { resolve: () => ORIGIN } as never,
      effect => { effect(); return true; }, {
        trustChannel: { readCurrent: async () => ({ generation: 'generation-7', digest: 'pack-digest', dcrProviderIds: ['notion'], valid: true }) },
        originProofVerifier: { verify: async () => ({ evidenceDigest: 'origin-proof' }) },
        dcrRegistrar: { register: async () => { registrations += 1; return registration; } },
      });
    const first = service.start('notion', key('race-first'));
    while (registrations === 0) await new Promise(resolve => setImmediate(resolve));
    const contender = await service.start('notion', key('race-second'));
    assert.equal(contender.state, 'blocked'); assert.equal(contender.reasonCode, 'CONNECTOR_PROVISIONING_LOCKED');
    const replayWhileLeased = await service.start('notion', key('race-first'));
    assert.equal(replayWhileLeased.state, 'registering_dcr');
    assert.equal(registrations, 1);
    releaseRegistration!({ outcome: 'registered', receiptDigest: 'receipt-race' });
    assert.equal((await first).state, 'ready');
  } finally { database.close(); }
});

test('request idempotency retains its nonce and does not repeat an uncertain external effect', async () => {
  const database = new Database(':memory:'); database.exec(CONNECTOR_PROVISIONING_SCHEMA_SQL); eligible(database); let registrations = 0;
  try {
    const service = new ConnectorProvisioningService(database, 'install-1', { resolve: () => ORIGIN } as never,
      effect => { effect(); return true; }, {
        trustChannel: { readCurrent: async () => ({ generation: 'generation-7', digest: 'pack-digest', dcrProviderIds: ['notion'], valid: true }) },
        originProofVerifier: { verify: async () => ({ evidenceDigest: 'origin-proof' }) },
        dcrRegistrar: { register: async () => { registrations += 1; throw new Error('transport disconnected'); } },
      }, () => 100, (() => { let index = 0; return () => `nonce-${++index}`; })());
    const first = await service.start('notion', key('nonce-idempotent'));
    const second = await service.start('notion', key('nonce-idempotent'));
    assert.equal(first.state, 'manual_recovery'); assert.equal(first.reasonCode, 'CONNECTOR_PROVISIONING_DCR_UNCERTAIN');
    assert.equal(second.nonceHash, first.nonceHash); assert.equal(registrations, 1);
    assert.doesNotMatch(JSON.stringify(first), /nonce-2/u);
  } finally { database.close(); }
});

test('a DCR receipt is persisted before a post-effect origin change enters manual recovery', async () => {
  const database = new Database(':memory:'); database.exec(CONNECTOR_PROVISIONING_SCHEMA_SQL); eligible(database); let resolves = 0; let registrations = 0;
  try {
    const service = new ConnectorProvisioningService(database, 'install-1', { resolve: () => ++resolves < 3 ? ORIGIN
      : { ...ORIGIN, canonicalOrigin: 'https://changed.example.test', originRevision: 4 } } as never,
    effect => { effect(); return true; }, {
      trustChannel: { readCurrent: async () => ({ generation: 'generation-7', digest: 'pack-digest', dcrProviderIds: ['notion'], valid: true }) },
      originProofVerifier: { verify: async () => ({ evidenceDigest: 'origin-proof' }) },
      dcrRegistrar: { register: async () => { registrations += 1; return { outcome: 'registered' as const, receiptDigest: 'receipt-post-effect' }; } },
    });
    const attempt = await service.start('notion', key('receipt-before-check'));
    assert.equal(attempt.state, 'manual_recovery');
    assert.equal(attempt.reasonCode, 'CONNECTOR_PROVISIONING_ORIGIN_CHANGED_AFTER_DCR');
    assert.equal(attempt.externalReceiptDigest, 'receipt-post-effect');
    assert.equal((await service.start('notion', key('receipt-before-check'))).state, 'manual_recovery');
    assert.equal(registrations, 1);
  } finally { database.close(); }
});

test('an expired lease cannot permit another DCR for the provider while the first call is pending', async () => {
  const database = new Database(':memory:'); database.exec(CONNECTOR_PROVISIONING_SCHEMA_SQL); eligible(database);
  let nowMs = 100; let registrations = 0; let release: ((value: { outcome: 'registered'; receiptDigest: string }) => void)|undefined;
  const pending = new Promise<{ outcome: 'registered'; receiptDigest: string }>(resolve => { release = resolve; });
  try {
    const service = new ConnectorProvisioningService(database, 'install-1', { resolve: () => ORIGIN } as never,
      effect => { effect(); return true; }, {
        trustChannel: { readCurrent: async () => ({ generation: 'generation-7', digest: 'pack-digest', dcrProviderIds: ['notion'], valid: true }) },
        originProofVerifier: { verify: async () => ({ evidenceDigest: 'origin-proof' }) },
        dcrRegistrar: { register: async () => { registrations += 1; return pending; } },
      }, () => nowMs);
    const first = service.start('notion', key('ttl-first'));
    while (registrations === 0) await new Promise(resolve => setImmediate(resolve));
    nowMs += 30_001;
    const afterTtl = await service.start('notion', key('ttl-second'));
    assert.equal(afterTtl.state, 'manual_recovery');
    assert.equal(afterTtl.reasonCode, 'CONNECTOR_PROVISIONING_DCR_RECONCILIATION_REQUIRED');
    assert.equal(registrations, 1);
    release!({ outcome: 'registered', receiptDigest: 'receipt-first' });
    assert.equal((await first).state, 'ready');
    assert.equal(database.prepare(`SELECT state FROM connector_provisioning_provider_effects
      WHERE installation_id='install-1' AND provider_id='notion'`).get().state, 'dcr_registered');
  } finally { database.close(); }
});

test('a DCR receipt is retained when trust changes after the external effect, without replay', async () => {
  const database = new Database(':memory:'); database.exec(CONNECTOR_PROVISIONING_SCHEMA_SQL); eligible(database); let reads = 0; let registrations = 0;
  try {
    const service = new ConnectorProvisioningService(database, 'install-1', { resolve: () => ORIGIN } as never,
      effect => { effect(); return true; }, {
        trustChannel: { readCurrent: async () => ({ generation: ++reads < 3 ? 'generation-7' : 'generation-8',
          digest: 'pack-digest', dcrProviderIds: ['notion'], valid: true }) },
        originProofVerifier: { verify: async () => ({ evidenceDigest: 'origin-proof' }) },
        dcrRegistrar: { register: async () => { registrations += 1; return { outcome: 'registered' as const, receiptDigest: 'receipt-trust-change' }; } },
      });
    const first = await service.start('notion', key('trust-after-effect'));
    assert.equal(first.state, 'manual_recovery');
    assert.equal(first.reasonCode, 'CONNECTOR_PROVISIONING_TRUST_CHANGED_AFTER_DCR');
    assert.equal(first.externalReceiptDigest, 'receipt-trust-change');
    assert.equal((await service.start('notion', key('trust-after-effect'))).state, 'manual_recovery');
    assert.equal(registrations, 1);
  } finally { database.close(); }
});

test('an expired DCR lease becomes manual recovery and never starts a second registration', async () => {
  const database = new Database(':memory:'); database.exec(CONNECTOR_PROVISIONING_SCHEMA_SQL); eligible(database); let registrations = 0;
  const idempotencyKey = key('expired-lease'); const provisioningId = 'provisioning-expired'; const nonceHash = 'a'.repeat(64);
  try {
    database.prepare(`INSERT INTO connector_provisioning_attempts
      (provisioning_id,installation_id,provider_id,request_key_hash,nonce_hash,state,created_at_ms,updated_at_ms)
      VALUES (?,?,?,?,?,'registering_dcr',?,?)`).run(provisioningId, 'install-1', 'notion',
      createHash('sha256').update(idempotencyKey).digest('hex'), nonceHash, 1, 1);
    database.prepare(`INSERT INTO connector_provisioning_locks
      (installation_id,provider_id,provisioning_id,owner_token_hash,expires_at_ms) VALUES (?,?,?,?,?)`)
      .run('install-1', 'notion', provisioningId, 'owner-token', 99);
    const service = new ConnectorProvisioningService(database, 'install-1', { resolve: () => ORIGIN } as never,
      effect => { effect(); return true; }, {
        dcrRegistrar: { register: async () => { registrations += 1; return { outcome: 'registered' as const, receiptDigest: 'unexpected' }; } },
      }, () => 100);
    const attempt = await service.start('notion', idempotencyKey);
    assert.equal(attempt.state, 'manual_recovery');
    assert.equal(attempt.reasonCode, 'CONNECTOR_PROVISIONING_DCR_EFFECT_UNRESOLVED');
    assert.equal(registrations, 0);
  } finally { database.close(); }
});
