import assert from 'node:assert/strict';
import test from 'node:test';

import Database from 'better-sqlite3';

// eslint-disable-next-line boundaries/dependencies -- origin integration must exercise the canonical database migration.
import { migrateConnectorPolicyV2Substrate } from '../database/connector-policy-v2.migration.js';

import {
  ConnectorInstallationOriginResolver,
  connectorEnvironmentOriginProposal,
  connectorOriginProposalFromConfig,
  type ConnectorOriginRotationFence,
} from './connector-installation-origin-resolver.js';
import { ConnectorSetupStore, type ConnectorSetupPrerequisites } from './connector-setup-store.js';

const NOW = 1_787_776_000_000;
const DIGEST = 'a'.repeat(43);
const ready: ConnectorSetupPrerequisites = {
  substrateReady: true, authorityRootReady: true, authorityAnchorReady: true, originReady: true,
  trustReady: true, providerPackReady: true, clockReady: true, digestsReady: true,
  profileReady: true, profileRequired: true, activationReady: true, eligibilityReady: true,
  tampered: false,
};

const fixture = () => {
  const database = new Database(':memory:');
  database.exec(`CREATE TABLE connector_installations (
    installation_id TEXT PRIMARY KEY,singleton INTEGER UNIQUE CHECK(singleton=1));`);
  const installationId = migrateConnectorPolicyV2Substrate(database);
  const store = new ConnectorSetupStore(database, false);
  database.prepare(`INSERT INTO connector_m5_installation_origin
    (installation_id,canonical_origin,updated_at_ms) VALUES (?,?,?)`)
    .run(installationId, 'https://old.example', NOW);
  const resolver = new ConnectorInstallationOriginResolver(database, store);
  const fence: ConnectorOriginRotationFence = {
    runFencedMutation: (effect) => database.transaction(effect).immediate() === undefined,
  };
  return { database, installationId, store, resolver, fence };
};

test('environment value is an explicit proposal and runtime resolution remains database-only', () => {
  const f = fixture();
  try {
    assert.deepEqual(connectorEnvironmentOriginProposal('https://env.example'), {
      source: 'environment_proposal', canonicalOrigin: 'https://env.example',
      callbackUrl: 'https://env.example/connectors/oauth/callback',
    });
    assert.deepEqual(f.resolver.resolve(f.installationId), {
      source: 'database', installationId: f.installationId, canonicalOrigin: 'https://old.example',
      callbackUrl: 'https://old.example/connectors/oauth/callback', originRevision: 1,
    });
    assert.equal(connectorEnvironmentOriginProposal(undefined), null);
    assert.throws(() => connectorEnvironmentOriginProposal('http://public.example'), /origin_invalid/u);
  } finally { f.database.close(); }
});

test('fenced origin rotation atomically kills, invalidates, downgrades and persists recovery intents', () => {
  const f = fixture();
  try {
    f.store.recomputeProjection({ installationId: f.installationId, scopeKey: 'google:gmail',
      prerequisites: ready, expectedProjectionRevision: 0, evidenceDigest: DIGEST,
      invalidReason: null, policyEpoch: 1, writerEpoch: 1, nowMs: NOW });
    f.database.prepare(`INSERT INTO connector_setup_local_activation
      (installation_id,record_revision,envelope_json,digest,policy_epoch,writer_epoch,origin_revision,valid)
      VALUES (?,1,'{}',?,1,1,1,1)`).run(f.installationId, DIGEST);
    f.database.prepare(`INSERT INTO connector_m5_profile_readiness
      (installation_id,provider_id,ready,valid_origin_revision) VALUES (?,'google',1,1)`)
      .run(f.installationId);
    f.database.prepare(`INSERT INTO connector_policy_v2_capability_nonce
      (nonce,installation_id,record_json,binding_digest,subject_digest) VALUES ('nonce',?,'{}','b','s')`)
      .run(f.installationId);
    f.database.prepare(`INSERT INTO connector_policy_v2_oauth_pending
      (transaction_id,installation_id,user_id,ownership,provider_id,service_id,account_id,grant_id,
       consumer_body,operation,state,created_at_ms) VALUES ('tx',?,7,'personal','google','gmail','a','g',
       'claude','oauth.start','pending',?)`).run(f.installationId, NOW);
    f.database.prepare(`INSERT INTO connector_policy_v2_placement
      (installation_id,user_id,ownership,provider_id,service_id,account_id,grant_id,consumer_body,
       opaque_grant_ref,bridge_open) VALUES (?,7,'personal','google','gmail','a','g','claude','opaque',1)`)
      .run(f.installationId);
    let audited = 0;
    const result = f.resolver.rotate({ installationId: f.installationId, actorUserId: 7,
      proposedOrigin: 'https://new.example', expectedOriginRevision: 1, nowMs: NOW + 1,
      fence: f.fence, hooks: { audit: () => { audited += 1; } } });
    assert.equal(result.originRevision, 2); assert.equal(audited, 1);
    const policy = JSON.parse((f.database.prepare(`SELECT state_json AS json FROM connector_policy_v2_state`)
      .get() as { json: string }).json) as { originRevision: number; policyEpoch: number;
      writerEpoch: number; killRevision: number; kills: { global: boolean } };
    assert.deepEqual([policy.originRevision, policy.policyEpoch, policy.writerEpoch,
      policy.killRevision, policy.kills.global], [2, 2, 2, 1, true]);
    assert.equal(f.store.readProjection(f.installationId, 'google:gmail')?.readiness, 'R0');
    assert.deepEqual(f.database.prepare(`SELECT valid FROM connector_setup_local_activation`).get(), { valid: 0 });
    assert.deepEqual(f.database.prepare(`SELECT state FROM connector_policy_v2_oauth_pending`).get(),
      { state: 'invalidated' });
    assert.equal((f.database.prepare(`SELECT consumed_at AS consumed FROM connector_policy_v2_capability_nonce`)
      .get() as { consumed: string|null }).consumed !== null, true);
    assert.deepEqual(f.database.prepare(`SELECT ready,valid_origin_revision AS revision
      FROM connector_m5_profile_readiness`).get(), { ready: 0, revision: null });
    assert.equal((f.database.prepare(`SELECT count(*) AS count FROM connector_setup_removal_intent`)
      .get() as { count: number }).count, 1);
    assert.deepEqual(f.database.prepare(`SELECT intent_type AS type,state FROM connector_setup_authority_intent`).get(),
      { type: 'origin_rotation', state: 'pending' });
  } finally { f.database.close(); }
});

test('stale CAS, rejected fence, and failing audit leave the complete rotation unchanged', () => {
  for (const scenario of ['stale', 'fence', 'audit'] as const) {
    const f = fixture();
    try {
      const before = f.database.serialize();
      const fence = scenario === 'fence' ? { runFencedMutation: () => false } : f.fence;
      assert.throws(() => f.resolver.rotate({ installationId: f.installationId, actorUserId: 7,
        proposedOrigin: 'https://new.example', expectedOriginRevision: scenario === 'stale' ? 9 : 1,
        nowMs: NOW + 1, fence, hooks: scenario === 'audit'
          ? { audit: () => { throw new Error('audit unavailable'); } } : undefined }),
      /revision_conflict|fence_rejected|audit unavailable/u, scenario);
      assert.deepEqual(f.database.serialize(), before, scenario);
      assert.equal(f.resolver.resolve(f.installationId)?.canonicalOrigin, 'https://old.example');
    } finally { f.database.close(); }
  }
});

test('same origin is an idempotent no-op and does not advance policy epochs', () => {
  const f = fixture();
  try {
    const before = f.database.prepare(`SELECT state_json AS json FROM connector_policy_v2_state`).get();
    const result = f.resolver.rotate({ installationId: f.installationId, actorUserId: 7,
      proposedOrigin: 'https://old.example', expectedOriginRevision: 1, nowMs: NOW + 1, fence: f.fence });
    assert.equal(result.originRevision, 1);
    assert.deepEqual(f.database.prepare(`SELECT state_json AS json FROM connector_policy_v2_state`).get(), before);
  } finally { f.database.close(); }
});

const PROD = { allowLoopback: false, legacyRedirectProposal: true } as const;

test('B-1461 proposal order: NASSAJ_PUBLIC_ORIGIN, then OIDC redirect origin, then single WebAuthn origin', () => {
  const all = { NASSAJ_PUBLIC_ORIGIN: 'https://public.example',
    OIDC_REDIRECT_URI: 'https://sso.example/api/auth/oidc/callback', WEBAUTHN_ORIGIN: 'https://passkey.example' };
  assert.deepEqual(connectorOriginProposalFromConfig(all, PROD),
    { canonicalOrigin: 'https://public.example', source: 'public_origin' });
  assert.deepEqual(connectorOriginProposalFromConfig({ ...all, NASSAJ_PUBLIC_ORIGIN: '' }, PROD),
    { canonicalOrigin: 'https://sso.example', source: 'oidc_redirect_uri' });
  assert.deepEqual(connectorOriginProposalFromConfig({ WEBAUTHN_ORIGIN: ' https://passkey.example ' }, PROD),
    { canonicalOrigin: 'https://passkey.example', source: 'webauthn_origin' });
  assert.equal(connectorOriginProposalFromConfig({}, PROD), null);
});

test('B-1461 H1: a set-but-invalid NASSAJ_PUBLIC_ORIGIN fails closed without falling through', () => {
  for (const invalid of ['http://public.example', 'https://public.example/', 'not a url', ' https://p.example']) {
    assert.deepEqual(connectorOriginProposalFromConfig({ NASSAJ_PUBLIC_ORIGIN: invalid,
      OIDC_REDIRECT_URI: 'https://sso.example/cb', WEBAUTHN_ORIGIN: 'https://passkey.example' }, PROD),
    { canonicalOrigin: null, source: 'invalid_public_origin' }, invalid);
  }
});

test('B-1461 OIDC redirect: only an exact canonical https URI counts, and only while OIDC is enabled', () => {
  for (const rejected of ['http://sso.example/cb', 'https://SSO.example/cb', 'https://sso.example:443/cb',
    'https://user@sso.example/cb', 'https://sso.example/cb?x=1', 'https://sso.example/cb#f',
    ' https://sso.example/cb', 'http://localhost:3001/cb']) {
    assert.equal(connectorOriginProposalFromConfig({ OIDC_REDIRECT_URI: rejected },
      { allowLoopback: true, legacyRedirectProposal: true }), null, rejected);
  }
  assert.equal(connectorOriginProposalFromConfig({ OIDC_REDIRECT_URI: 'https://sso.example/cb' },
    { allowLoopback: false, legacyRedirectProposal: false }), null, 'OIDC off ignores OIDC_REDIRECT_URI');
});

test('B-1461 WebAuthn: several origins, http, or non-canonical values give no proposal', () => {
  for (const rejected of ['https://a.example,https://b.example', 'http://passkey.example',
    'https://passkey.example/', 'http://localhost:5173']) {
    assert.equal(connectorOriginProposalFromConfig({ WEBAUTHN_ORIGIN: rejected },
      { allowLoopback: true, legacyRedirectProposal: false }), null, rejected);
  }
});

test('B-1461 loopback http is a proposal only for NASSAJ_PUBLIC_ORIGIN and only when allowed', () => {
  assert.deepEqual(connectorOriginProposalFromConfig({ NASSAJ_PUBLIC_ORIGIN: 'http://localhost:3001' },
    { allowLoopback: true, legacyRedirectProposal: false }), { canonicalOrigin: 'http://localhost:3001', source: 'public_origin' });
  assert.deepEqual(connectorOriginProposalFromConfig({ NASSAJ_PUBLIC_ORIGIN: 'http://localhost:3001' }, PROD),
    { canonicalOrigin: null, source: 'invalid_public_origin' });
});
