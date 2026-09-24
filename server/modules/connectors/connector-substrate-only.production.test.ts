import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync,
  writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import test from 'node:test';
import { Worker } from 'node:worker_threads';

import Database from 'better-sqlite3';
import express from 'express';

/* eslint-disable boundaries/dependencies -- integration test exercises real migration and persistence owners. */
import { migrateConnectorAuthSchema } from '../database/connector-auth.migration.js';
import {
  CONNECTOR_POLICY_V2_SUBSTRATE_TABLES,
  initialConnectorPolicyV2SubstrateState,
  migrateConnectorPolicyV2Substrate,
} from '../database/connector-policy-v2.migration.js';
import { createConnectorAuthDb } from '../database/repositories/connector-auth.db.js';
/* eslint-enable boundaries/dependencies */

import { createConnectorOwnerAuthSessionAdapter,
  recordConnectorOwnerAuthentication } from './connector-owner-auth-session.js';
import { CONNECTOR_GLOBAL_PACK_DOMAIN, connectorGlobalPackDigest,
  connectorGlobalPackSignedBytes } from './connector-global-certification-pack.js';
import { connectorJcs } from './connector-jcs.js';
import { CONNECTOR_LOCAL_ACTIVATION_DOMAIN, connectorLocalActivationDigest,
  parseConnectorLocalActivationRecord } from './connector-local-activation.js';
import { openOrCreateConnectorRuntimeAuthorityRoot } from './connector-runtime-authority-root.js';
import { ConnectorPolicyOperation } from './connector-policy-v2.js';
import { CONNECTOR_RUNTIME_MANIFEST } from './connector-runtime-manifest.js';
import { ConnectorSetupStore } from './connector-setup-store.js';
import {
  assertConnectorProviderEffectEnabled,
  connectorPolicyV2SubstrateRoutes,
  connectorPolicyV2OwnerSetupRoutes,
  executeConnectorPolicyV2LifecycleWrite,
  initializeConnectorPolicyV2SubstrateOnly,
  inspectExistingConnectorPolicyV2Substrate,
  resolveConnectorRuntimeInstallationOrigin,
  runConnectorPolicyV2GuardedBootstrap,
} from './connector-substrate-only.production.js';
import { connectorRuntimeActivationMac, ConnectorRuntimeWriteGate, reinstallConnectorRuntimeFence } from './connector-runtime-fence.js';
import { connectorTrustBundleDigest, type ConnectorTrustBundle } from './connector-trust-bundle.js';

const NOW = Date.parse('2026-08-27T02:00:00.000Z');

test('production effect gate opens only the exact signed certified and locally activated triple', () => {
  const f = databaseFixture(); const directory = mkdtempSync('/var/tmp/nassaj-dynamic-activation-');
  const path = join(directory, 'authority.json'); const nowMs = Date.now();
  try {
    assert.equal(initializeConnectorPolicyV2SubstrateOnly(f.database, path).ready, true);
    const authority = openOrCreateConnectorRuntimeAuthorityRoot(path).authority;
    const setup = new ConnectorSetupStore(f.database, false);
    const keys = generateKeyPairSync('ed25519');
    const trust: ConnectorTrustBundle = { schemaVersion: 1, revision: 1, distributionIssuerId: 'test-issuer',
      revokedKeyIds: [], roots: [{ issuerId: 'test-issuer', keyId: 'root-1', algorithm: 'Ed25519',
        publicKeyPem: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
        validFrom: new Date(nowMs - 60_000).toISOString(), validUntil: new Date(nowMs + 86_400_000).toISOString(),
        source: 'distribution' }] };
    const pack = { schemaVersion: 1 as const, domain: CONNECTOR_GLOBAL_PACK_DOMAIN,
      issuerId: 'test-issuer', channel: 'stable' as const, sequence: 1,
      issuedAt: new Date(nowMs - 1_000).toISOString(), expiresAt: new Date(nowMs + 86_400_000).toISOString(),
      minimumRuntimeFloor: 1, maximumPolicySchemaVersion: 2, ...CONNECTOR_RUNTIME_MANIFEST,
      certifications: [{ providerId: 'github', serviceId: 'github',
        operation: ConnectorPolicyOperation.ProfileConfigure, authMethod: 'api_key' as const,
        shapeRevision: 1, shapeDigest: 's'.repeat(43), contractRevision: 1,
        contractDigest: 'd'.repeat(43), status: 'certified' as const }], signingKeyId: 'root-1' };
    const envelope = { pack, signature: sign(null, connectorGlobalPackSignedBytes(pack),
      keys.privateKey).toString('base64url') };
    const digest = connectorGlobalPackDigest(pack).toString('base64url');
    const state = JSON.parse((f.database.prepare(`SELECT state_json AS json FROM connector_policy_v2_state`)
      .get() as { json: string }).json) as { policyEpoch: number; writerEpoch: number; originRevision: number };
    const record = parseConnectorLocalActivationRecord({ schemaVersion: 1,
      domain: CONNECTOR_LOCAL_ACTIVATION_DOMAIN, installationId: f.installationId, recordRevision: 1,
      policyEpoch: state.policyEpoch, writerEpoch: state.writerEpoch, originRevision: state.originRevision,
      globalPackIssuerId: pack.issuerId, globalPackChannel: pack.channel, globalPackSequence: pack.sequence,
      globalPackDigest: digest, trustBundleRevision: 1, issuedAt: new Date(nowMs).toISOString(),
      issuedByUserId: 7, activations: [{ providerId: 'github', serviceId: 'github',
        operation: ConnectorPolicyOperation.ProfileConfigure, enabled: true, profileRevision: null }] });
    assert.ok(record);
    assert.equal(executeConnectorPolicyV2LifecycleWrite(() => {
      setup.saveTrustBundle({ installationId: f.installationId, expectedRevision: 0,
        bundleJson: connectorJcs(trust), digest: connectorTrustBundleDigest(trust).toString('base64url'), nowMs });
      setup.saveVerifiedPack({ installationId: f.installationId, issuer: pack.issuerId, channel: pack.channel,
        sequence: pack.sequence, envelopeJson: connectorJcs(envelope), digest, trustBundleRevision: 1,
        acceptedWallMs: nowMs, clockHighWaterMs: nowMs });
      setup.saveLocalActivation({ installationId: f.installationId, expectedRevision: 0,
        envelopeJson: connectorJcs({ record, mac: connectorRuntimeActivationMac(authority,
          Buffer.from(connectorJcs(record), 'utf8')) }),
        digest: connectorLocalActivationDigest(record).toString('base64url'), policyEpoch: state.policyEpoch,
        writerEpoch: state.writerEpoch, originRevision: state.originRevision });
    }), true);
    assert.doesNotThrow(() => assertConnectorProviderEffectEnabled({
      operation: ConnectorPolicyOperation.ProfileConfigure, providerId: 'github', serviceId: 'github' }));
    assert.throws(() => assertConnectorProviderEffectEnabled({
      operation: ConnectorPolicyOperation.ProfileConfigure, providerId: 'github', serviceId: 'slack' }),
    /pack_uncertified|local_disabled/u);
    assert.throws(() => assertConnectorProviderEffectEnabled(ConnectorPolicyOperation.ProfileConfigure),
      /activation_required/u, 'legacy operation-only calls cannot inherit ambient flags');
  } finally {
    initializeConnectorPolicyV2SubstrateOnly(f.database, '/proc/nassaj-connector-runtime-authority.json');
    f.database.close(); rmSync(directory, { recursive: true, force: true });
  }
});

test('environment proposal bootstraps first-owner auth without becoming runtime origin authority', async () => {
  const f = databaseFixture(); const directory = mkdtempSync('/var/tmp/nassaj-origin-bootstrap-');
  const prior = process.env.NASSAJ_PUBLIC_ORIGIN;
  process.env.NASSAJ_PUBLIC_ORIGIN = 'https://proposal.example';
  try {
    assert.deepEqual(initializeConnectorPolicyV2SubstrateOnly(f.database, join(directory, 'authority.json')),
      { ready: true, reason: 'ready' });
    const cookies = new Map<string, string>();
    assert.equal(recordConnectorOwnerAuthentication({ cookie: (name: string, value: string) => {
      cookies.set(name, value); return undefined as never;
    }, clearCookie: () => undefined as never } as unknown as express.Response, 7, 'password'), true);
    const app = express(); app.use(express.json()); app.use((req, _res, next) => {
      (req as express.Request & { user: { id: number } }).user = { id: 7 }; next();
    });
    app.use('/setup', connectorPolicyV2OwnerSetupRoutes);
    const server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve, reject) => {
      server.once('listening', resolve); server.once('error', reject);
    });
    try {
      const recent = cookies.get('nassaj_connector_recent_auth');
      const csrf = cookies.get('nassaj_connector_csrf');
      const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/setup/origin`, {
        method: 'PUT', headers: { 'content-type': 'application/json', origin: 'https://proposal.example',
          'if-match': '"0"', 'idempotency-key': 'origin-bootstrap-1', 'x-csrf-token': csrf!,
          cookie: `nassaj_connector_recent_auth=${recent}` },
        body: JSON.stringify({ canonicalOrigin: 'https://proposal.example', expectedOriginRevision: 0 }),
      });
      assert.equal(response.status, 200);
      process.env.NASSAJ_PUBLIC_ORIGIN = 'https://conflict.example';
      assert.equal(resolveConnectorRuntimeInstallationOrigin()?.canonicalOrigin, 'https://proposal.example');
    } finally {
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  } finally {
    if (prior === undefined) delete process.env.NASSAJ_PUBLIC_ORIGIN;
    else process.env.NASSAJ_PUBLIC_ORIGIN = prior;
    initializeConnectorPolicyV2SubstrateOnly(f.database, '/proc/nassaj-connector-runtime-authority.json', () => NOW);
    f.database.close(); rmSync(directory, { recursive: true, force: true });
  }
});

const legacyDatabase = (): Database.Database => {
  const database = new Database(':memory:');
  database.exec(`CREATE TABLE users (
    id INTEGER PRIMARY KEY, role TEXT NOT NULL, status TEXT NOT NULL, is_active INTEGER NOT NULL
  ); INSERT INTO users VALUES (7,'owner','active',1);
  CREATE TABLE sentinel (value TEXT NOT NULL); INSERT INTO sentinel VALUES ('preserved');`);
  return database;
};

const databaseFixture = () => {
  const database = legacyDatabase();
  migrateConnectorAuthSchema(database);
  const installationId = migrateConnectorPolicyV2Substrate(database);
  return { database, installationId };
};

test('existing substrate inspection requires persisted authority and origin without generating either', () => {
  const f = databaseFixture(); const directory = mkdtempSync(join(process.cwd(), '.artifacts', 'existing-substrate-'));
  const authorityPath = join(directory, 'authority.json');
  try {
    assert.throws(() => inspectExistingConnectorPolicyV2Substrate(f.database, authorityPath, NOW));
    assert.equal(existsSync(authorityPath), false);
    const authority = openOrCreateConnectorRuntimeAuthorityRoot(authorityPath).authority;
    reinstallConnectorRuntimeFence(f.database, authority);
    const before = f.database.serialize(); const authorityBefore = readFileSync(authorityPath);
    f.database.pragma('query_only = ON');
    assert.throws(() => inspectExistingConnectorPolicyV2Substrate(f.database, authorityPath, NOW), /origin_missing/);
    assert.deepEqual(f.database.serialize(), before);
    assert.deepEqual(readFileSync(authorityPath), authorityBefore);
  } finally { f.database.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('existing substrate inspection reuses persisted origin and validates it without writes', () => {
  const f = databaseFixture(); const directory = mkdtempSync(join(process.cwd(), '.artifacts', 'existing-substrate-'));
  const authorityPath = join(directory, 'authority.json');
  try {
    f.database.prepare('INSERT INTO connector_m5_installation_origin VALUES (?, ?, ?)')
      .run(f.installationId, 'https://existing.example', NOW);
    const authority = openOrCreateConnectorRuntimeAuthorityRoot(authorityPath).authority;
    reinstallConnectorRuntimeFence(f.database, authority);
    const before = f.database.serialize(); f.database.pragma('query_only = ON');
    const observed = inspectExistingConnectorPolicyV2Substrate(f.database, authorityPath, NOW);
    assert.equal(observed.installationId, f.installationId);
    assert.equal(observed.origin.canonicalOrigin, 'https://existing.example');
    assert.deepEqual(f.database.serialize(), before);
    f.database.pragma('query_only = OFF');
    const gate = new ConnectorRuntimeWriteGate(f.database, { runtimeVersion: 1,
      maximumPolicySchemaVersion: 2, supportsWriterFencing: true }, authority, () => NOW);
    assert.ok(gate.acquireForInitialization('00000000-0000-4000-8000-000000000001', 30_000));
    assert.equal(gate.runFencedMutation(() => {
      f.database.prepare('UPDATE connector_m5_installation_origin SET canonical_origin = ?').run('http://untrusted.example');
    }, false), true);
    f.database.pragma('query_only = ON');
    assert.throws(() => inspectExistingConnectorPolicyV2Substrate(f.database, authorityPath, NOW), /origin_invalid/);
  } finally { f.database.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('substrate migration is additive, idempotent, empty, and rollback-readable at floor one', () => {
  const database = legacyDatabase();
  const directory = mkdtempSync('/var/tmp/nassaj-substrate-backup-');
  const backupPath = join(directory, 'pre-migration.sqlite');
  try {
    database.exec(`VACUUM INTO '${backupPath}'`);
    migrateConnectorAuthSchema(database);
    const installationId = migrateConnectorPolicyV2Substrate(database);
    assert.equal(migrateConnectorPolicyV2Substrate(database), installationId);
    assert.deepEqual(database.prepare('SELECT * FROM sentinel').all(), [{ value: 'preserved' }]);
    const metadata = database.prepare(`SELECT mode,production_manifest_active AS manifest,
      stored_unverified_creation_enabled AS unverified,provider_activation_enabled AS activation,
      runtime_floor AS runtimeFloor FROM connector_policy_v2_substrate`).get();
    assert.deepEqual(metadata, { mode: 'substrate_only', manifest: 0, unverified: 0,
      activation: 0, runtimeFloor: 1 });
    for (const table of ['connector_policy_v2_oauth_pending', 'connector_policy_v2_placement',
      'connector_migration_v2_account', 'connector_m5_installation_origin']) {
      assert.equal((database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count,
        0, table);
    }
    const state = JSON.parse((database.prepare(`SELECT state_json AS stateJson
      FROM connector_policy_v2_state`).get() as { stateJson: string }).stateJson) as Record<string, unknown>;
    assert.equal(state.certificationManifestDigest,
      initialConnectorPolicyV2SubstrateState().certificationManifestDigest);
    const restored = new Database(backupPath);
    try {
      migrateConnectorAuthSchema(restored);
      assert.doesNotThrow(() => migrateConnectorPolicyV2Substrate(restored));
      assert.deepEqual(restored.prepare('SELECT * FROM sentinel').all(), [{ value: 'preserved' }]);
    } finally { restored.close(); }
  } finally { database.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('all M3-M5 substrate tables are present and policy state is the only initialized work row', () => {
  const f = databaseFixture();
  try {
    const rows = f.database.prepare(`SELECT name FROM sqlite_master WHERE type='table'`)
      .all() as Array<{ name: string }>;
    const present = new Set(rows.map(row => row.name));
    for (const table of CONNECTOR_POLICY_V2_SUBSTRATE_TABLES) assert.equal(present.has(table), true, table);
    const policyCount = f.database.prepare('SELECT COUNT(*) AS count FROM connector_policy_v2_state')
      .get() as { count: number };
    assert.equal(policyCount.count, 1);
  } finally { f.database.close(); }
});

test('unwritable authority root keeps schema one and performs no provider effect', async () => {
  const f = databaseFixture();
  const result = initializeConnectorPolicyV2SubstrateOnly(f.database,
    '/proc/nassaj-connector-runtime-authority.json', () => NOW);
  assert.equal(result.ready, false);
  const app = express(); app.use('/api/connectors/v2/installation', connectorPolicyV2SubstrateRoutes);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve, reject) => {
    server.once('listening', resolve); server.once('error', reject);
  });
  try {
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
      + '/api/connectors/v2/installation/catalog';
    const response = await fetch(url);
    assert.equal(response.status, 200);
    assert.equal(((await response.json()) as { schemaVersion: number }).schemaVersion, 1);
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    f.database.close();
  }
});

test('a throwing opt-in auto-setup never drops a ready substrate to unavailable', () => {
  const f = databaseFixture();
  const directory = mkdtempSync('/var/tmp/nassaj-auto-setup-contain-');
  const authorityPath = join(directory, 'authority.json');
  // A regular file where the key directory's parent should be: the auto-setup lock's
  // mkdirSync throws ENOTDIR. The substrate must stay ready regardless.
  const blockerFile = join(directory, 'blocker');
  writeFileSync(blockerFile, 'x');
  const priorFlag = process.env.NASSAJ_CONNECTOR_AUTO_SETUP;
  const priorOrigin = process.env.NASSAJ_PUBLIC_ORIGIN;
  const priorKeyDir = process.env.NASSAJ_CONNECTOR_SIGNING_KEY_DIR;
  process.env.NASSAJ_CONNECTOR_AUTO_SETUP = '1';
  process.env.NASSAJ_PUBLIC_ORIGIN = 'https://substrate-auto.example';
  process.env.NASSAJ_CONNECTOR_SIGNING_KEY_DIR = join(blockerFile, 'keys');
  try {
    assert.deepEqual(initializeConnectorPolicyV2SubstrateOnly(f.database, authorityPath, () => NOW),
      { ready: true, reason: 'ready' });
  } finally {
    if (priorFlag === undefined) delete process.env.NASSAJ_CONNECTOR_AUTO_SETUP;
    else process.env.NASSAJ_CONNECTOR_AUTO_SETUP = priorFlag;
    if (priorOrigin === undefined) delete process.env.NASSAJ_PUBLIC_ORIGIN;
    else process.env.NASSAJ_PUBLIC_ORIGIN = priorOrigin;
    if (priorKeyDir === undefined) delete process.env.NASSAJ_CONNECTOR_SIGNING_KEY_DIR;
    else process.env.NASSAJ_CONNECTOR_SIGNING_KEY_DIR = priorKeyDir;
    initializeConnectorPolicyV2SubstrateOnly(f.database, '/proc/nassaj-connector-runtime-authority.json', () => NOW);
    f.database.close(); rmSync(directory, { recursive: true, force: true });
  }
});

test('ready substrate serves schema two and fenced origin write advances policy and M2 epochs together', async () => {
  const f = databaseFixture();
  const directory = mkdtempSync('/var/tmp/nassaj-substrate-');
  const authorityPath = join(directory, 'connector-runtime-authority.json');
  const repository = createConnectorAuthDb(f.database);
  const token = 'a'.repeat(64); const csrf = 'b'.repeat(64);
  const initialized = initializeConnectorPolicyV2SubstrateOnly(f.database, authorityPath, () => NOW);
  assert.deepEqual(initialized, { ready: true, reason: 'ready' });
  runConnectorPolicyV2GuardedBootstrap(f.database, authorityPath, () => {
    repository.recordOwnerAuthSession({
      sessionId: '11111111-2222-4333-8444-555555555555', installationId: f.installationId,
      sessionTokenHash: createHash('sha256').update('e'.repeat(64)).digest('hex'),
      csrfTokenHash: createHash('sha256').update('f'.repeat(64)).digest('hex'), userId: 7,
      authMethod: 'password', authTimeMs: NOW - 2_000, expiresAtMs: NOW + 60_000,
    });
  }, () => NOW);
  assert.deepEqual(initializeConnectorPolicyV2SubstrateOnly(f.database, authorityPath, () => NOW),
    { ready: true, reason: 'ready' }, 'runtime reacquires after the guarded boot migration takeover');
  assert.throws(() => repository.recordOwnerAuthSession({
    sessionId: '22222222-3333-4444-8555-666666666666', installationId: f.installationId,
    sessionTokenHash: createHash('sha256').update('c'.repeat(64)).digest('hex'),
    csrfTokenHash: createHash('sha256').update('d'.repeat(64)).digest('hex'), userId: 7,
    authMethod: 'password', authTimeMs: NOW - 1_000, expiresAtMs: NOW + 60_000,
  }), /connector_runtime_fence_required/u, 'raw owner-session writers remain fenced');
  createConnectorOwnerAuthSessionAdapter({ repository, installationId: f.installationId,
    canonicalOrigin: 'https://nassaj.example', now: () => NOW - 1_000,
    randomToken: () => token, randomCsrfToken: () => csrf,
    sessionId: () => '11111111-1111-4111-8111-111111111111',
    executeWrite: executeConnectorPolicyV2LifecycleWrite }).record(
    { cookie: () => undefined, clearCookie: () => undefined } as unknown as express.Response,
    7, 'password',
  );
  const app = express(); app.use(express.json());
  app.use((req, _res, next) => {
    (req as express.Request & { user: { id: number } }).user = { id: 7 }; next();
  });
  app.use('/api/connectors/v2/installation', connectorPolicyV2SubstrateRoutes);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve, reject) => {
    server.once('listening', resolve); server.once('error', reject);
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    + '/api/connectors/v2/installation';
  try {
    const catalog = await fetch(`${base}/catalog`);
    const catalogBody = await catalog.json() as { schemaVersion: number;
      origin: { configured: boolean }; services: Array<{ authMethod: string; state: string }> };
    assert.equal(catalogBody.schemaVersion, 2);
    assert.equal(catalogBody.origin.configured, false);
    assert.equal(catalogBody.services.find(item => item.authMethod === 'api_key')?.state,
      'coming_soon_uncertified');
    const initial = await fetch(`${base}/origin`, { method: 'PUT', headers: {
      'content-type': 'application/json', origin: 'https://nassaj.example',
      'x-csrf-token': csrf, cookie: `nassaj_connector_recent_auth=${token}`,
    }, body: JSON.stringify({ canonicalOrigin: 'https://nassaj.example', expectedOriginRevision: 0 }) });
    assert.equal(initial.status, 200);
    const change = await fetch(`${base}/origin`, { method: 'PUT', headers: {
      'content-type': 'application/json', origin: 'https://nassaj.example',
      'x-csrf-token': csrf, cookie: `nassaj_connector_recent_auth=${token}`,
    }, body: JSON.stringify({ canonicalOrigin: 'https://new.example', expectedOriginRevision: 1 }) });
    assert.equal(change.status, 200);
    const policy = JSON.parse((f.database.prepare(`SELECT state_json AS stateJson FROM connector_policy_v2_state`)
      .get() as { stateJson: string }).stateJson) as { originRevision: number; writerEpoch: number };
    const control = f.database.prepare(`SELECT writer_epoch AS writerEpoch,connector_runtime_floor AS floor
      FROM connector_runtime_control`).get() as { writerEpoch: number; floor: number };
    assert.deepEqual(policy, { ...policy, originRevision: 2, writerEpoch: 2 });
    assert.equal(control.writerEpoch, 2); assert.equal(control.floor, 1);
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    initializeConnectorPolicyV2SubstrateOnly(f.database, '/proc/nassaj-connector-runtime-authority.json', () => NOW);
    f.database.close(); rmSync(directory, { recursive: true, force: true });
  }
});

test('fresh authority bootstrap is durable 0600, race-stable, and corrupt roots are never replaced', () => {
  const directory = mkdtempSync('/var/tmp/nassaj-authority-root-');
  const path = join(directory, 'authority.json');
  try {
    const first = openOrCreateConnectorRuntimeAuthorityRoot(path);
    const bytes = readFileSync(path);
    const second = openOrCreateConnectorRuntimeAuthorityRoot(path);
    assert.equal(first.rotationId, second.rotationId);
    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.deepEqual(readFileSync(path), bytes);
    const valid = JSON.parse(bytes.toString('utf8')) as { format: string; rotationId: string; rootKey: string };
    const invalidDocuments = [
      `${JSON.stringify({ ...valid, rotationId: '-'.repeat(36) })}\n`,
      `${JSON.stringify({ ...valid, unexpected: true })}\n`,
      `${JSON.stringify({ format: valid.format, rootKey: valid.rootKey })}\n`,
      `${JSON.stringify({ ...valid, rotationId: 7 })}\n`,
      `{"format":${JSON.stringify(valid.format)},"rotationId":${JSON.stringify(valid.rotationId)},`
        + `"rotationId":${JSON.stringify(valid.rotationId)},"rootKey":${JSON.stringify(valid.rootKey)}}\n`,
      `${JSON.stringify({ ...valid, padding: 'x'.repeat(2_000) })}\n`,
    ];
    for (const invalid of invalidDocuments) {
      writeFileSync(path, invalid, { mode: 0o600 }); chmodSync(path, 0o600);
      const corrupt = readFileSync(path);
      assert.throws(() => openOrCreateConnectorRuntimeAuthorityRoot(path), /root_corrupt/u);
      assert.deepEqual(readFileSync(path), corrupt, 'corrupt authority is not silently rotated');
    }
    const corrupt = readFileSync(path);
    for (const mode of [0o400, 0o200, 0o000, 0o644]) {
      chmodSync(path, mode);
      assert.throws(() => openOrCreateConnectorRuntimeAuthorityRoot(path), /permissions_invalid/u,
        `root mode ${mode.toString(8)} must be rejected`);
      chmodSync(path, 0o600);
      assert.deepEqual(readFileSync(path), corrupt, 'permission failure is not silently replaced');
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('authority and lock symlinks are rejected without touching their targets', () => {
  const directory = mkdtempSync('/var/tmp/nassaj-authority-symlink-');
  const authorityPath = join(directory, 'authority.json');
  const target = join(directory, 'foreign-target');
  try {
    writeFileSync(target, 'foreign\n', { mode: 0o600 });
    symlinkSync(target, authorityPath);
    assert.throws(() => openOrCreateConnectorRuntimeAuthorityRoot(authorityPath), /permissions_invalid/u);
    assert.equal(readFileSync(target, 'utf8'), 'foreign\n');
    rmSync(authorityPath);
    symlinkSync(target, `${authorityPath}.lock`);
    assert.throws(() => openOrCreateConnectorRuntimeAuthorityRoot(authorityPath), /lock_identity_invalid/u);
    assert.equal(readFileSync(target, 'utf8'), 'foreign\n');
    assert.equal(existsSync(`${authorityPath}.lock`), true, 'foreign lock symlink is not deleted');
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('dead stale lock is recovered atomically and authority bootstrap needs no PATH executable', () => {
  const directory = mkdtempSync('/var/tmp/nassaj-authority-stale-lock-');
  const authorityPath = join(directory, 'authority.json');
  const lockPath = `${authorityPath}.lock`;
  const previousPath = process.env.PATH;
  try {
    writeFileSync(lockPath, `${JSON.stringify({
      format: 'nassaj-connector-runtime-authority-lock-v1', pid: 2_147_483_647,
      createdAtMs: Date.now() - 60_000, nonce: 'a'.repeat(43),
    })}\n`, { mode: 0o600 });
    process.env.PATH = '/definitely/missing';
    assert.match(openOrCreateConnectorRuntimeAuthorityRoot(authorityPath).rotationId, /^[0-9a-f-]{36}$/u);
    assert.equal(existsSync(lockPath), false, 'owned stale lock and replacement lock are both released');
  } finally {
    if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath;
    rmSync(directory, { recursive: true, force: true });
  }
});

test('authority lock also requires exact 0600 and never replaces a wrong-mode owner record', () => {
  const directory = mkdtempSync('/var/tmp/nassaj-authority-lock-mode-');
  const authorityPath = join(directory, 'authority.json');
  const lockPath = `${authorityPath}.lock`;
  const contents = `${JSON.stringify({
    format: 'nassaj-connector-runtime-authority-lock-v1', pid: process.pid,
    createdAtMs: Date.now(), nonce: 'b'.repeat(43),
  })}\n`;
  try {
    for (const mode of [0o400, 0o200, 0o000, 0o644]) {
      writeFileSync(lockPath, contents, { mode: 0o600 }); chmodSync(lockPath, mode);
      assert.throws(() => openOrCreateConnectorRuntimeAuthorityRoot(authorityPath),
        /lock_identity_invalid/u, `lock mode ${mode.toString(8)} must be rejected`);
      assert.equal(existsSync(lockPath), true, 'wrong-mode lock is not removed or replaced');
      chmodSync(lockPath, 0o600); rmSync(lockPath);
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('two concurrent boots converge on one authority rotation id', async () => {
  const directory = mkdtempSync('/var/tmp/nassaj-authority-race-');
  const path = join(directory, 'authority.json');
  const run = () => new Promise<{ ok: boolean; rotationId?: string; error?: string }>((resolve, reject) => {
    const worker = new Worker(new URL('./__tests__/connector-runtime-authority-root.worker.ts', import.meta.url),
      { workerData: path, execArgv: ['--import', 'tsx'] });
    worker.once('message', resolve); worker.once('error', reject);
  });
  try {
    const results = await Promise.all([run(), run()]);
    assert.deepEqual(results.map(result => result.ok), [true, true]);
    assert.equal(results[0]?.rotationId, results[1]?.rotationId);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
