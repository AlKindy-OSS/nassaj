import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import Database from 'better-sqlite3';
import express from 'express';

/* eslint-disable boundaries/dependencies -- integration test drives the real migration and persistence owners. */
import { migrateConnectorAuthSchema } from '../database/connector-auth.migration.js';
import { migrateConnectorPolicyV2Substrate } from '../database/connector-policy-v2.migration.js';
import { createConnectorAuthDb } from '../database/repositories/connector-auth.db.js';
/* eslint-enable boundaries/dependencies */
import { providerAuthSpecFor } from '../../../shared/connector-auth-registry.js';

import { createConnectorProfileManagementService } from './connector-auth-profile-management.js';
import { createConnectorUserGrantService } from './connector-user-grant.service.js';
import { createConnectorUserGrantRoutes } from './connector-user-grant.routes.js';
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
  executeConnectorPolicyV2LifecycleWrite,
  initializeConnectorPolicyV2SubstrateOnly,
} from './connector-substrate-only.production.js';
import { connectorRuntimeActivationMac } from './connector-runtime-fence.js';
import { connectorTrustBundleDigest, type ConnectorTrustBundle } from './connector-trust-bundle.js';

// T-1539 / B-845 / ADR-138: the routes unit test proves the ordering fix against
// `faithfulProfileGate`, a hand-written re-statement of the readiness rule. That
// can drift from the production gate without either test failing. This test
// instead wires the ROUTE to the real `assertConnectorProviderEffectEnabled`
// (with its real signed pack, trust bundle and local activation) on a clean
// database, so the fix is proven against the exact code that ships.

const SESSION = '6'.repeat(64);
const CSRF = '7'.repeat(64);
const ORIGIN = 'https://nassaj.example';
const keyring = {
  activeKekVersion: () => 1,
  readKek: () => Buffer.alloc(32, 6),
  activeHmacKeyVersion: () => 1,
  readHmacKey: () => Buffer.alloc(32, 7),
};

const put = async (app: express.Express, body: unknown) => {
  const server = http.createServer(app);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  try {
    return await fetch(`http://127.0.0.1:${address.port}/grants/github/api-key`, {
      method: 'PUT',
      headers: {
        'content-type': 'application/json', origin: ORIGIN,
        cookie: `nassaj_connector_recent_auth=${SESSION}`, 'x-csrf-token': CSRF,
      },
      body: JSON.stringify(body),
    });
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
};

// Installs a signed pack + trust bundle + local activation that certify and
// enable BOTH operations the api-key route asserts (ProfileConfigure, then
// CredentialVerify) for github/github, so only profile readiness gates the flow.
const installSubstrate = (database: Database.Database, installationId: string,
  authorityPath: string, providerId: string, serviceId: string): void => {
  const nowMs = Date.now();
  const authority = openOrCreateConnectorRuntimeAuthorityRoot(authorityPath).authority;
  const setup = new ConnectorSetupStore(database, false);
  const keys = generateKeyPairSync('ed25519');
  const trust: ConnectorTrustBundle = { schemaVersion: 1, revision: 1, distributionIssuerId: 'test-issuer',
    revokedKeyIds: [], roots: [{ issuerId: 'test-issuer', keyId: 'root-1', algorithm: 'Ed25519',
      publicKeyPem: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
      validFrom: new Date(nowMs - 60_000).toISOString(), validUntil: new Date(nowMs + 86_400_000).toISOString(),
      source: 'distribution' }] };
  const certification = (operation: ConnectorPolicyOperation) => ({ providerId, serviceId, operation,
    authMethod: 'api_key' as const, shapeRevision: 1, shapeDigest: 's'.repeat(43), contractRevision: 1,
    contractDigest: 'd'.repeat(43), status: 'certified' as const });
  const pack = { schemaVersion: 1 as const, domain: CONNECTOR_GLOBAL_PACK_DOMAIN,
    issuerId: 'test-issuer', channel: 'stable' as const, sequence: 1,
    issuedAt: new Date(nowMs - 1_000).toISOString(), expiresAt: new Date(nowMs + 86_400_000).toISOString(),
    minimumRuntimeFloor: 1, maximumPolicySchemaVersion: 2, ...CONNECTOR_RUNTIME_MANIFEST,
    certifications: [certification(ConnectorPolicyOperation.ProfileConfigure),
      certification(ConnectorPolicyOperation.CredentialVerify)], signingKeyId: 'root-1' };
  const envelope = { pack, signature: sign(null, connectorGlobalPackSignedBytes(pack),
    keys.privateKey).toString('base64url') };
  const digest = connectorGlobalPackDigest(pack).toString('base64url');
  const state = JSON.parse((database.prepare('SELECT state_json AS json FROM connector_policy_v2_state')
    .get() as { json: string }).json) as { policyEpoch: number; writerEpoch: number; originRevision: number };
  const record = parseConnectorLocalActivationRecord({ schemaVersion: 1,
    domain: CONNECTOR_LOCAL_ACTIVATION_DOMAIN, installationId, recordRevision: 1,
    policyEpoch: state.policyEpoch, writerEpoch: state.writerEpoch, originRevision: state.originRevision,
    globalPackIssuerId: pack.issuerId, globalPackChannel: pack.channel, globalPackSequence: pack.sequence,
    globalPackDigest: digest, trustBundleRevision: 1, issuedAt: new Date(nowMs).toISOString(),
    issuedByUserId: 7, activations: [
      { providerId, serviceId, operation: ConnectorPolicyOperation.ProfileConfigure,
        enabled: true, profileRevision: null },
      { providerId, serviceId, operation: ConnectorPolicyOperation.CredentialVerify,
        enabled: true, profileRevision: null }] });
  assert.ok(record);
  assert.equal(executeConnectorPolicyV2LifecycleWrite(() => {
    setup.saveTrustBundle({ installationId, expectedRevision: 0,
      bundleJson: connectorJcs(trust), digest: connectorTrustBundleDigest(trust).toString('base64url'), nowMs });
    setup.saveVerifiedPack({ installationId, issuer: pack.issuerId, channel: pack.channel,
      sequence: pack.sequence, envelopeJson: connectorJcs(envelope), digest, trustBundleRevision: 1,
      acceptedWallMs: nowMs, clockHighWaterMs: nowMs });
    setup.saveLocalActivation({ installationId, expectedRevision: 0,
      envelopeJson: connectorJcs({ record, mac: connectorRuntimeActivationMac(authority,
        Buffer.from(connectorJcs(record), 'utf8')) }),
      digest: connectorLocalActivationDigest(record).toString('base64url'), policyEpoch: state.policyEpoch,
      writerEpoch: state.writerEpoch, originRevision: state.originRevision });
  }), true);
};

test('T-1539: real provider-effect gate lets the fixed api-key route through on a clean install', async () => {
  const previous = { ...process.env };
  Object.assign(process.env, {
    NASSAJ_CONNECTOR_GRANTS_V2: '1', NASSAJ_CONNECTOR_AUTH_REGISTRY_V1: '1',
    NASSAJ_CONNECTOR_AUTH_CERT_GITHUB: '1', NASSAJ_CONNECTOR_GRANT_CERT_GITHUB: '1',
    NASSAJ_CONNECTOR_AUTO_SETUP: '0',
  });
  const directory = mkdtempSync(join(process.cwd(), '.artifacts', 'nassaj-grant-gate-integration-'));
  const database = new Database(':memory:');
  database.exec("CREATE TABLE users (id INTEGER PRIMARY KEY, role TEXT, status TEXT, is_active INTEGER);"
    + " INSERT INTO users VALUES (7,'owner','active',1)");
  migrateConnectorAuthSchema(database);
  const installationId = migrateConnectorPolicyV2Substrate(database);
  const authorityPath = join(directory, 'authority.json');
  try {
    // The substrate runtime the real gate reads must be THIS database.
    assert.equal(initializeConnectorPolicyV2SubstrateOnly(database, authorityPath).ready, true);
    const spec = providerAuthSpecFor('github')!;
    installSubstrate(database, installationId, authorityPath, spec.profileId, 'github');

    const repository = createConnectorAuthDb(database);
    assert.equal(repository.getOrCreateInstallation(), installationId,
      'grants repository and substrate must share the singleton installation');
    assert.equal(executeConnectorPolicyV2LifecycleWrite(() => {
      repository.recordOwnerAuthSession({
        sessionId: randomUUID(), installationId,
        sessionTokenHash: createHash('sha256').update(SESSION).digest('hex'),
        csrfTokenHash: createHash('sha256').update(CSRF).digest('hex'),
        userId: 7, authMethod: 'password', authTimeMs: Date.now(), expiresAtMs: Date.now() + 60_000,
      });
    }), true, 'owner auth fixture must use the installed lifecycle writer');
    const grants = createConnectorUserGrantService({
      installationId, repository, keyring, env: process.env,
      testApiKeyCandidate: async () => {
        assert.throws(() => database.prepare('UPDATE connector_auth_profiles SET status = status').run(),
          /connector_runtime_fence_required/u, 'provider await must execute outside the synchronous database fence');
        return { providerSubject: 'provider-user-7', identityKind: 'user' };
      },
    });
    const profiles = createConnectorProfileManagementService({
      installation: { installationId, canonicalOrigin: ORIGIN, callbackUrl: `${ORIGIN}/connectors/oauth/callback` },
      repository, keyring, env: process.env,
      testByoCandidate: async () => undefined, testApiKeyCandidate: async () => undefined,
    });

    // (1) Without the fix — asserting CredentialVerify before any profile row
    // exists — the REAL gate denies with profile_unready. This is the exact
    // production code, not a re-statement of its rule.
    assert.equal((database.prepare('SELECT count(*) AS c FROM connector_auth_profiles')
      .get() as { c: number }).c, 0, 'clean install starts with zero profile rows');
    assert.throws(() => assertConnectorProviderEffectEnabled({
      operation: ConnectorPolicyOperation.CredentialVerify,
      providerId: spec.profileId, serviceId: 'github', userId: 7,
    }), /profile_unready/u, 'the real gate denies CredentialVerify before the profile is materialised');
    // Sanity: ProfileConfigure is allowed on the same clean install (it must be,
    // since the fix runs it first to materialise the profile).
    assert.doesNotThrow(() => assertConnectorProviderEffectEnabled({
      operation: ConnectorPolicyOperation.ProfileConfigure,
      providerId: spec.profileId, serviceId: 'github', userId: 7,
    }));

    // (2) With the fix wired through the route and the real gate, the first save
    // materialises the ready profile and returns 200.
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as express.Request & { user: unknown }).user = { id: 7, role: 'user' };
      next();
    });
    app.use('/grants', createConnectorUserGrantRoutes(() => ({
      installationId, canonicalOrigin: ORIGIN, repository, grants, profiles,
      assertProviderEffect: assertConnectorProviderEffectEnabled,
      getConnector: (id: string) => ({
        id, service: 'github', ownerUserId: 7, authMode: 'key',
        credentialMode: 'per_member', accountLabel: 'Work',
      }) as never,
    })));
    let routeError: unknown;
    app.use((error: unknown, _req: express.Request, res: express.Response,
      _next: express.NextFunction) => {
      routeError = error;
      res.status(500).json({ error: 'Integration route failed' });
    });
    const saved = await put(app, {
      connectorId: 'github-work-u7', apiKey: 'github-pat', accountLabel: 'Work',
    });
    assert.ifError(routeError);
    assert.equal(saved.status, 200,
      `the fixed route passes the real gate: ${await saved.text()}`);
    const profile = database.prepare(
      "SELECT status FROM connector_auth_profiles WHERE provider_id = ?",
    ).get(spec.profileId) as { status: string } | undefined;
    assert.equal(profile?.status, 'ready', 'ProfileConfigure parity created the ready row');
    assert.equal(grants.list(7, 'github').length, 1, 'the grant persisted');

    // The now-ready profile makes the real CredentialVerify gate open too.
    assert.doesNotThrow(() => assertConnectorProviderEffectEnabled({
      operation: ConnectorPolicyOperation.CredentialVerify,
      providerId: spec.profileId, serviceId: 'github', userId: 7,
    }), 'CredentialVerify is eligible once the profile row is ready');
  } finally {
    initializeConnectorPolicyV2SubstrateOnly(database, '/proc/nassaj-connector-runtime-authority.json');
    database.close();
    rmSync(directory, { recursive: true, force: true });
    for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
    Object.assign(process.env, previous);
  }
});
