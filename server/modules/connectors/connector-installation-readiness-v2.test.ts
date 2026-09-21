import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import Database from 'better-sqlite3';
import express from 'express';

import { SqliteConnectorPolicyV2Store } from './connector-policy-v2-store.js';
import type { ConnectorPolicyState } from './connector-policy-v2.js';
import {
  CONNECTOR_INSTALLATION_READINESS_V2_ENABLED,
  ConnectorInstallationOriginV2Store,
  ConnectorInstallationOwnerCapability,
  canonicalizeConnectorInstallationOrigin,
  connectorInstallationReadinessCatalog,
  createConnectorInstallationReadinessV2Routes,
  type ConnectorReadinessFact,
} from './connector-installation-readiness-v2.js';

const NOW = Date.parse('2026-08-27T00:00:00.000Z');
const INSTALLATION = 'install-1';
const initialPolicy = (): ConnectorPolicyState => ({
  policySchemaVersion: 2, policyEpoch: 1, registryRevision: 'registry-1',
  certificationManifestDigest: 'm'.repeat(86), installationMode: 'portable_default',
  originRevision: 1, killRevision: 0, writerEpoch: 1,
  kills: { global: false, providers: [], serviceOperations: [] },
});

const authority = (overrides: Partial<Parameters<typeof ConnectorInstallationOwnerCapability.fixture>[0]> = {}) =>
  ConnectorInstallationOwnerCapability.fixture({
    installationId: INSTALLATION, userId: 7, role: 'owner', recentAuth: true,
    csrfVerified: true, requestOrigin: 'https://nassaj.example', intent: 'set_installation_origin',
    issuedAtMs: NOW - 1_000, expiresAtMs: NOW + 30_000, ...overrides,
  });

const fact = (overrides: Partial<ConnectorReadinessFact> = {}): ConnectorReadinessFact => ({
  installationId: INSTALLATION, providerId: 'github', serviceId: 'github', authMethod: 'api_key',
  productionManifestActive: true, featureEnabled: true, temporarilyDisabled: false,
  migrationRequired: false, savedInactive: false, operationalConnected: false, ...overrides,
});

const fixture = () => {
  const database = new Database(':memory:');
  const policy = new SqliteConnectorPolicyV2Store(database, INSTALLATION, initialPolicy());
  const store = new ConnectorInstallationOriginV2Store(database, policy,
    { allowInitialOriginBootstrap: true });
  return { database, policy, store };
};

const addInstallation = (database: Database.Database, installationId: string): void => {
  new SqliteConnectorPolicyV2Store(database, installationId, initialPolicy());
};

const setInitialOrigin = (store: ConnectorInstallationOriginV2Store): void => {
  store.setOrigin({ installationId: INSTALLATION, userId: 7,
    proposedOrigin: 'https://nassaj.example', expectedOriginRevision: 0,
    authority: authority(), nowMs: NOW });
};

test('M5 is statically inert and has no ambient origin or provider-I/O escape hatch', () => {
  assert.equal(CONNECTOR_INSTALLATION_READINESS_V2_ENABLED, false);
  const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)),
    'connector-installation-readiness-v2.ts'), 'utf8');
  for (const forbidden of ['process.env', 'x-forwarded', "req.get('host')", 'node:http', 'node:https']) {
    assert.equal(source.toLowerCase().includes(forbidden), false, forbidden);
  }
  assert.equal(/\bfetch\s*\(/u.test(source), false);
});

test('canonical origin is exact HTTPS with only an explicit loopback development exception', () => {
  assert.equal(canonicalizeConnectorInstallationOrigin('https://nassaj.example'), 'https://nassaj.example');
  assert.equal(canonicalizeConnectorInstallationOrigin('http://127.0.0.1:5173', true),
    'http://127.0.0.1:5173');
  assert.equal(canonicalizeConnectorInstallationOrigin('http://[::1]:5173', true),
    'http://[::1]:5173');
  for (const raw of ['http://nassaj.example', 'http://localhost:5173', 'https://nassaj.example/',
    'https://nassaj.example/path', 'https://user@nassaj.example', ' https://nassaj.example']) {
    assert.throws(() => canonicalizeConnectorInstallationOrigin(raw), /origin_invalid/u, raw);
  }
});

test('secret-free catalog works without origin and API-key readiness is unaffected', () => {
  const f = fixture();
  try {
    const dto = connectorInstallationReadinessCatalog({ installationId: INSTALLATION, owner: true,
      store: f.store, facts: [
        fact(),
        fact({ providerId: 'google', serviceId: 'gmail', authMethod: 'byo_app' }),
        fact({ providerId: 'slack', serviceId: 'slack', productionManifestActive: false }),
      ] });
    assert.deepEqual(dto.origin, { configured: false, originRevision: null,
      canonicalOrigin: null, callbackUrl: null });
    assert.deepEqual(dto.services.map(item => [item.serviceId, item.state, item.actions]), [
      ['github', 'connect_now', ['connect_account']],
      ['gmail', 'installation_origin_required', ['set_installation_origin']],
      ['slack', 'coming_soon_uncertified', []],
    ]);
    assert.deepEqual(Object.keys(dto).sort(), ['origin', 'schemaVersion', 'services']);
    assert.equal(/secret|apiKey|clientSecret|token/u.test(JSON.stringify(dto)), false);
  } finally { f.database.close(); }
});

test('owner setup requires exact recent-auth, CSRF, installation, and request origin authority', () => {
  const invalid = [
    authority({ installationId: 'install-2' }), authority({ userId: 8 }),
    authority({ requestOrigin: 'https://spoofed.example' }), authority({ expiresAtMs: NOW }),
    authority({ recentAuth: false as true }), authority({ csrfVerified: false as true }),
  ];
  for (const capability of invalid) {
    const f = fixture();
    try {
      assert.throws(() => f.store.setOrigin({ installationId: INSTALLATION, userId: 7,
        proposedOrigin: 'https://nassaj.example', expectedOriginRevision: 0,
        authority: capability, nowMs: NOW }), /authority_invalid/u);
      assert.equal(f.store.read(INSTALLATION), null);
    } finally { f.database.close(); }
  }
  const replay = fixture();
  try {
    const oneUse = authority();
    replay.store.setOrigin({ installationId: INSTALLATION, userId: 7,
      proposedOrigin: 'https://nassaj.example', expectedOriginRevision: 0,
      authority: oneUse, nowMs: NOW });
    assert.throws(() => replay.store.setOrigin({ installationId: INSTALLATION, userId: 7,
      proposedOrigin: 'https://nassaj.example', expectedOriginRevision: 1,
      authority: oneUse, nowMs: NOW }), /authority_invalid/u);
  } finally { replay.database.close(); }
});

test('origin persists an exact fixed callback and revision CAS', () => {
  const f = fixture();
  try {
    setInitialOrigin(f.store);
    assert.deepEqual(f.store.read(INSTALLATION), {
      installationId: INSTALLATION, canonicalOrigin: 'https://nassaj.example',
      callbackUrl: 'https://nassaj.example/connectors/oauth/callback', originRevision: 1,
    });
    assert.throws(() => f.store.setOrigin({ installationId: INSTALLATION, userId: 7,
      proposedOrigin: 'https://new.example', expectedOriginRevision: 0,
      authority: authority(), nowMs: NOW + 1 }), /revision_conflict/u);
    assert.equal(f.store.read(INSTALLATION)?.originRevision, 1);
  } finally { f.database.close(); }
});

test('pending OAuth denies origin change with no mutation', () => {
  const f = fixture();
  try {
    setInitialOrigin(f.store);
    f.store.recordProfileReadiness(INSTALLATION, 'google', true);
    f.database.prepare(`INSERT INTO connector_policy_v2_oauth_pending
      (transaction_id,installation_id,user_id,ownership,provider_id,service_id,account_id,grant_id,
       consumer_body,operation,state,created_at_ms) VALUES (?,?,?,?,?,?,?,?,?,?,'pending',?)`)
      .run('tx-1', INSTALLATION, 7, 'personal', 'google', 'gmail', 'account-1', 'grant-1',
        'claude', 'oauth.start', NOW);
    assert.throws(() => f.store.setOrigin({ installationId: INSTALLATION, userId: 7,
      proposedOrigin: 'https://new.example', expectedOriginRevision: 1,
      authority: authority(), nowMs: NOW + 1 }), /oauth_pending/u);
    assert.equal(f.store.read(INSTALLATION)?.canonicalOrigin, 'https://nassaj.example');
    assert.equal(f.store.profileReady(INSTALLATION, 'google'), true);
  } finally { f.database.close(); }
});

test('origin change bumps revision and invalidates profile and pending policy authority only in its installation', () => {
  const f = fixture();
  try {
    setInitialOrigin(f.store);
    addInstallation(f.database, 'install-2');
    f.store.setOrigin({ installationId: 'install-2', userId: 9,
      proposedOrigin: 'https://second.example', expectedOriginRevision: 0,
      authority: authority({ installationId: 'install-2', userId: 9,
        requestOrigin: 'https://second.example' }), nowMs: NOW });
    f.store.recordProfileReadiness(INSTALLATION, 'google', true);
    f.store.recordProfileReadiness('install-2', 'google', true);
    const insert = f.database.prepare(`INSERT INTO connector_policy_v2_capability_nonce
      (nonce,installation_id,record_json,binding_digest,subject_digest) VALUES (?,?,?,?,?)`);
    insert.run('nonce-1', INSTALLATION, '{}', 'binding', 'subject');
    insert.run('nonce-2', 'install-2', '{}', 'binding', 'subject');
    const changed = f.store.setOrigin({ installationId: INSTALLATION, userId: 7,
      proposedOrigin: 'https://new.example', expectedOriginRevision: 1,
      authority: authority(), nowMs: NOW + 1 });
    assert.equal(changed.originRevision, 2);
    assert.equal(f.policy.readCurrent(INSTALLATION).originRevision, 2);
    assert.equal(f.policy.readCurrent(INSTALLATION).policyEpoch, 2);
    assert.equal(f.policy.readCurrent(INSTALLATION).writerEpoch, 2);
    assert.equal(changed.callbackUrl, 'https://new.example/connectors/oauth/callback');
    assert.equal(f.store.profileReady(INSTALLATION, 'google'), false);
    assert.equal(f.store.profileReady('install-2', 'google'), true);
    const rows = f.database.prepare(`SELECT installation_id AS installationId, consumed_at AS consumedAt
      FROM connector_policy_v2_capability_nonce ORDER BY installation_id`).all() as Array<Record<string, unknown>>;
    assert.equal(rows[0]?.consumedAt !== null, true);
    assert.equal(rows[1]?.consumedAt, null);
  } finally { f.database.close(); }
});

test('readiness exposes every honest state and only state-owned allowlisted actions', () => {
  const f = fixture();
  try {
    setInitialOrigin(f.store);
    const facts = [
      fact({ serviceId: 'temporarily', temporarilyDisabled: true }),
      fact({ serviceId: 'migration', migrationRequired: true }),
      fact({ serviceId: 'saved', savedInactive: true }),
      fact({ providerId: 'google', serviceId: 'gmail', authMethod: 'byo_app' }),
      fact({ serviceId: 'future', productionManifestActive: false }),
      fact({ serviceId: 'flagged-off', featureEnabled: false }),
      fact({ serviceId: 'ready' }),
      fact({ serviceId: 'connected', operationalConnected: true }),
    ];
    const owner = connectorInstallationReadinessCatalog({ installationId: INSTALLATION,
      owner: true, store: f.store, facts });
    assert.deepEqual(owner.services.map(item => [item.state, item.actions]), [
      ['temporarily_disabled', []], ['migration_required', ['review_migration']],
      ['saved_inactive', ['remove_saved_credential']],
      ['owner_setup_required', ['configure_provider']], ['coming_soon_uncertified', []],
      ['coming_soon_uncertified', []], ['connect_now', ['connect_account']],
      ['connected', ['connect_account']],
    ]);
    const member = connectorInstallationReadinessCatalog({ installationId: INSTALLATION,
      owner: false, store: f.store, facts });
    assert.deepEqual(member.services.find(item => item.state === 'owner_setup_required')?.actions, []);
    assert.deepEqual(member.services.find(item => item.state === 'migration_required')?.actions, []);
  } finally { f.database.close(); }
});

test('profile readiness is revision-bound and production manifest remains mandatory', () => {
  const f = fixture();
  try {
    setInitialOrigin(f.store);
    f.store.recordProfileReadiness(INSTALLATION, 'google', true);
    const google = fact({ providerId: 'google', serviceId: 'gmail', authMethod: 'byo_app' });
    assert.equal(connectorInstallationReadinessCatalog({ installationId: INSTALLATION, owner: true,
      store: f.store, facts: [google] }).services[0]?.state, 'connect_now');
    assert.equal(connectorInstallationReadinessCatalog({ installationId: INSTALLATION, owner: true,
      store: f.store, facts: [{ ...google, productionManifestActive: false }] }).services[0]?.state,
    'coming_soon_uncertified');
    f.store.setOrigin({ installationId: INSTALLATION, userId: 7,
      proposedOrigin: 'https://new.example', expectedOriginRevision: 1,
      authority: authority(), nowMs: NOW + 1 });
    assert.equal(connectorInstallationReadinessCatalog({ installationId: INSTALLATION, owner: true,
      store: f.store, facts: [google] }).services[0]?.state, 'owner_setup_required');
  } finally { f.database.close(); }
});

test('catalog rejects duplicate and cross-install state does not leak', () => {
  const f = fixture();
  try {
    setInitialOrigin(f.store);
    assert.throws(() => connectorInstallationReadinessCatalog({ installationId: INSTALLATION,
      owner: true, store: f.store, facts: [fact(), fact()] }), /catalog_invalid/u);
    assert.throws(() => connectorInstallationReadinessCatalog({ installationId: INSTALLATION,
      owner: true, store: f.store, facts: [fact({ installationId: 'install-2' })] }),
    /catalog_invalid/u);
    addInstallation(f.database, 'install-2');
    const other = connectorInstallationReadinessCatalog({ installationId: 'install-2', owner: true,
      store: f.store, facts: [fact({ installationId: 'install-2', providerId: 'google',
        serviceId: 'gmail', authMethod: 'byo_app' })] });
    assert.equal(other.origin.configured, false);
    assert.equal(other.services[0]?.state, 'installation_origin_required');
  } finally { f.database.close(); }
});

test('missing policy authority, persisted tamper, and loopback-policy drift fail closed on read', () => {
  for (const mutation of ['policy', 'origin', 'loopback'] as const) {
    const f = fixture();
    try {
      if (mutation === 'loopback') {
        const developmentStore = new ConnectorInstallationOriginV2Store(f.database, f.policy,
          { allowInitialOriginBootstrap: true, allowLoopbackDevelopment: true });
        developmentStore.setOrigin({ installationId: INSTALLATION, userId: 7,
          proposedOrigin: 'http://127.0.0.1:5173', expectedOriginRevision: 0,
          authority: authority({ requestOrigin: 'http://127.0.0.1:5173' }), nowMs: NOW });
        const productionStore = new ConnectorInstallationOriginV2Store(f.database, f.policy);
        assert.throws(() => productionStore.read(INSTALLATION), /readiness_unavailable/u);
      } else {
        setInitialOrigin(f.store);
        if (mutation === 'policy') f.database.exec('DROP TABLE connector_policy_v2_state');
        else f.database.prepare(`UPDATE connector_m5_installation_origin
          SET canonical_origin = ? WHERE installation_id = ?`).run('https://evil.example/path', INSTALLATION);
        assert.throws(() => f.store.read(INSTALLATION), /readiness_unavailable/u);
      }
    } finally { f.database.close(); }
  }
});

test('first-origin bootstrap is explicit and refuses installations with prior connector effects', () => {
  for (const unsafe of ['disabled', 'effect'] as const) {
    const database = new Database(':memory:');
    const policy = new SqliteConnectorPolicyV2Store(database, INSTALLATION, initialPolicy());
    const store = new ConnectorInstallationOriginV2Store(database, policy,
      { allowInitialOriginBootstrap: unsafe !== 'disabled' });
    try {
      if (unsafe === 'effect') database.prepare(`INSERT INTO connector_policy_v2_capability_nonce
        (nonce,installation_id,record_json,binding_digest,subject_digest) VALUES (?,?,?,?,?)`)
        .run('existing', INSTALLATION, '{}', 'binding', 'subject');
      assert.throws(() => store.setOrigin({ installationId: INSTALLATION, userId: 7,
        proposedOrigin: 'https://nassaj.example', expectedOriginRevision: 0,
        authority: authority(), nowMs: NOW }), /bootstrap_unsafe/u);
      assert.equal(store.read(INSTALLATION), null);
    } finally { database.close(); }
  }
});

test('origin persistence failure atomically preserves policy revision, capabilities, and readiness', () => {
  const f = fixture();
  try {
    setInitialOrigin(f.store);
    f.store.recordProfileReadiness(INSTALLATION, 'google', true);
    f.database.prepare(`INSERT INTO connector_policy_v2_capability_nonce
      (nonce,installation_id,record_json,binding_digest,subject_digest) VALUES (?,?,?,?,?)`)
      .run('pending-capability', INSTALLATION, '{}', 'binding', 'subject');
    f.database.exec(`CREATE TRIGGER reject_m5_origin_update BEFORE UPDATE ON connector_m5_installation_origin
      BEGIN SELECT RAISE(ABORT, 'rejected'); END`);
    assert.throws(() => f.store.setOrigin({ installationId: INSTALLATION, userId: 7,
      proposedOrigin: 'https://new.example', expectedOriginRevision: 1,
      authority: authority(), nowMs: NOW + 1 }));
    const policy = f.policy.readCurrent(INSTALLATION);
    assert.equal(policy.originRevision, 1);
    assert.equal(policy.policyEpoch, 1);
    assert.equal(policy.writerEpoch, 1);
    assert.equal(f.store.read(INSTALLATION)?.canonicalOrigin, 'https://nassaj.example');
    assert.equal(f.store.profileReady(INSTALLATION, 'google'), true);
    const row = f.database.prepare(`SELECT consumed_at AS consumedAt
      FROM connector_policy_v2_capability_nonce WHERE nonce = ?`)
      .get('pending-capability') as { consumedAt: string | null };
    assert.equal(row.consumedAt, null);
  } finally { f.database.close(); }
});

test('unmounted route factory serves GET without origin and protects owner PUT end to end', async () => {
  const f = fixture();
  const csrf = 'c'.repeat(64);
  let factsRead = 0;
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as express.Request & { user: { id: number; role: string } }).user = { id: 7, role: 'owner' };
    next();
  });
  app.use('/api/connectors/v2/installation', createConnectorInstallationReadinessV2Routes({
    installationId: INSTALLATION, store: f.store, now: () => NOW,
    resolveInstallationMember: () => ({ installationId: INSTALLATION, userId: 7, role: 'owner' }),
    executeOriginWrite: (_advance, effect) => { effect(); return true; },
    readFacts: () => { factsRead += 1; return [fact()]; },
    readRecentOwnerSession: () => ({ installationId: INSTALLATION, userId: 7,
      authTimeMs: NOW - 1_000, expiresAtMs: NOW + 30_000,
      csrfTokenHash: createHash('sha256').update(csrf).digest('hex') }),
  }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve, reject) => {
    server.once('listening', resolve); server.once('error', reject);
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/connectors/v2/installation`;
  try {
    const get = await fetch(`${base}/catalog`, { headers: {
      host: 'spoofed.example', 'x-forwarded-host': 'forwarded.example', origin: 'https://evil.example',
    } });
    assert.equal(get.status, 200);
    assert.equal(((await get.json()) as { services: unknown[] }).services.length, 1);
    assert.equal(factsRead, 1);
    const spoof = await fetch(`${base}/origin`, { method: 'PUT', headers: {
      'content-type': 'application/json', origin: 'https://evil.example', 'x-csrf-token': csrf,
      host: 'spoofed.example', 'x-forwarded-host': 'https://nassaj.example',
    }, body: JSON.stringify({ canonicalOrigin: 'https://nassaj.example', expectedOriginRevision: 0 }) });
    assert.equal(spoof.status, 403);
    assert.equal(f.store.read(INSTALLATION), null);
    const put = await fetch(`${base}/origin`, { method: 'PUT', headers: {
      'content-type': 'application/json', origin: 'https://nassaj.example', 'x-csrf-token': csrf,
    }, body: JSON.stringify({ canonicalOrigin: 'https://nassaj.example', expectedOriginRevision: 0 }) });
    assert.equal(put.status, 200);
    assert.equal(((await put.json()) as { schemaVersion: number }).schemaVersion, 2);
    assert.equal(f.store.read(INSTALLATION)?.originRevision, 1);
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    f.database.close();
  }
});

test('route PUT enforces exact body, CSRF, recent auth, and revision conflicts', async () => {
  const f = fixture();
  const csrf = 'd'.repeat(64);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as express.Request & { user: { id: number; role: string } }).user = { id: 7, role: 'owner' };
    next();
  });
  app.use('/api/connectors/v2/installation', createConnectorInstallationReadinessV2Routes({
    installationId: INSTALLATION, store: f.store, readFacts: () => [], now: () => NOW,
    resolveInstallationMember: () => ({ installationId: INSTALLATION, userId: 7, role: 'owner' }),
    executeOriginWrite: (_advance, effect) => { effect(); return true; },
    readRecentOwnerSession: () => ({ installationId: INSTALLATION, userId: 7,
      authTimeMs: NOW - 1_000, expiresAtMs: NOW + 30_000,
      csrfTokenHash: createHash('sha256').update(csrf).digest('hex') }),
  }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve, reject) => {
    server.once('listening', resolve); server.once('error', reject);
  });
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/connectors/v2/installation/origin`;
  const request = (body: unknown, token = csrf, origin = 'https://nassaj.example') => fetch(url, { method: 'PUT', headers: {
    'content-type': 'application/json', origin, 'x-csrf-token': token,
  }, body: JSON.stringify(body) });
  try {
    assert.equal((await request({ canonicalOrigin: 'https://nassaj.example',
      expectedOriginRevision: 0, extra: true })).status, 400);
    assert.equal((await request({ canonicalOrigin: 'https://nassaj.example',
      expectedOriginRevision: 0 }, 'wrong'.repeat(10))).status, 403);
    assert.equal((await request({ canonicalOrigin: 'https://nassaj.example',
      expectedOriginRevision: 0 })).status, 200);
    assert.equal((await request({ canonicalOrigin: 'https://new.example',
      expectedOriginRevision: 1 }, csrf, 'https://new.example')).status, 403,
    'current exact Origin is required before CAS');
    assert.equal((await request({ canonicalOrigin: 'https://new.example',
      expectedOriginRevision: 0 })).status, 409);
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    f.database.close();
  }
});

test('route dependency failures and cross-install facts return bounded secret-free 503', async () => {
  for (const failure of ['membership', 'facts', 'session', 'store'] as const) {
    const f = fixture();
    const csrf = 'e'.repeat(64);
    if (failure === 'store') f.database.exec('DROP TABLE connector_policy_v2_state');
    const app = express(); app.use(express.json());
    app.use('/api/connectors/v2/installation', createConnectorInstallationReadinessV2Routes({
      installationId: INSTALLATION, store: f.store, now: () => NOW,
      resolveInstallationMember: () => {
        if (failure === 'membership') throw new Error('private membership failure');
        return { installationId: INSTALLATION, userId: 7, role: 'owner' };
      },
      executeOriginWrite: (_advance, effect) => { effect(); return true; },
      readFacts: () => failure === 'facts'
        ? [fact({ installationId: 'install-2' })] : [fact()],
      readRecentOwnerSession: () => {
        if (failure === 'session') throw new Error('private auth failure');
        return { installationId: INSTALLATION, userId: 7, authTimeMs: NOW - 1_000,
          expiresAtMs: NOW + 30_000, csrfTokenHash: createHash('sha256').update(csrf).digest('hex') };
      },
    }));
    const server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve, reject) => {
      server.once('listening', resolve); server.once('error', reject);
    });
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/connectors/v2/installation`;
    try {
      const response = failure === 'session'
        ? await fetch(`${base}/origin`, { method: 'PUT', headers: { 'content-type': 'application/json',
          origin: 'https://nassaj.example', 'x-csrf-token': csrf }, body: JSON.stringify({
          canonicalOrigin: 'https://nassaj.example', expectedOriginRevision: 0 }) })
        : await fetch(`${base}/catalog`);
      assert.equal(response.status, 503, failure);
      assert.deepEqual(await response.json(), { code: 'CONNECTOR_READINESS_UNAVAILABLE' });
    } finally {
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      f.database.close();
    }
  }
});
