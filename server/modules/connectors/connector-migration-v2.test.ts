import assert from 'node:assert/strict';
import test from 'node:test';

import Database from 'better-sqlite3';

import {
  CONNECTOR_MIGRATION_V2_ENABLED,
  CONNECTOR_MIGRATION_V2_CUTOVER_EXIT_CONDITIONS,
  ConnectorMigrationOwnerCapability,
  ConnectorMigrationPolicyCapability,
  ConnectorMigrationV2Engine,
  ConnectorMigrationV2Store,
  evaluateLegacyOperationalContinuation,
  type MigrationAdapters,
  type SecretFreeLegacyInventory,
} from './connector-migration-v2.js';
import { ConnectorPolicyOperation } from './connector-policy-v2.js';

const NOW = Date.parse('2026-08-26T00:00:00.000Z');
const MANIFEST = 'm'.repeat(86);
const KEY = Object.freeze({ installationId: 'install-1', sourceId: 'source-1' });
const item = (mutation: Partial<SecretFreeLegacyInventory> = {}): SecretFreeLegacyInventory => ({
  sourceId: 'source-1', installationId: 'install-1', userId: 7, ownership: 'personal',
  providerId: 'google', serviceId: 'gmail', accountId: 'account-1', grantId: 'grant-1',
  generation: 'legacy', provenanceMarkers: ['legacy'], envelopeDigest: 'd'.repeat(43),
  corrupt: false, ...mutation,
});
const authority = (expiresAtMs = NOW + 60_000) => ConnectorMigrationOwnerCapability.fixture({
  installationId: 'install-1', userId: 7, csrfVerified: true,
  consent: 'migrate_connectors', issuedAtMs: NOW - 1, expiresAtMs,
});
const policyAuthority = (mutation: Readonly<{ accountId?: string; nowMs?: number; killed?: boolean;
  snapshotRegistry?: string; certificationRegistry?: string; operation?: ConnectorPolicyOperation;
  contractDigest?: string; installationId?: string }> = {}) => {
  const nowMs = mutation.nowMs ?? NOW;
  return ConnectorMigrationPolicyCapability.fixture({
    installationId: mutation.installationId ?? 'install-1', userId: 7,
    ownership: 'personal', providerId: 'google',
    serviceId: 'gmail', accountId: mutation.accountId ?? 'account-1', grantId: 'grant-1',
    issuedAtMs: nowMs - 1, expiresAtMs: nowMs + 60_000,
    snapshot: { policySchemaVersion: 2, policyEpoch: 1,
      registryRevision: mutation.snapshotRegistry ?? 'registry-1',
      certificationManifestDigest: MANIFEST, installationMode: 'legacy_quarantined',
      originRevision: 1, killRevision: mutation.killed ? 1 : 0, writerEpoch: 1,
      capturedAt: new Date(nowMs).toISOString() },
    certification: { certified: true, providerId: 'google', serviceId: 'gmail',
      operation: mutation.operation ?? ConnectorPolicyOperation.CredentialVerify, manifestSequence: 1,
      manifestDigest: MANIFEST, originRevision: 1,
      registryRevision: mutation.certificationRegistry ?? 'registry-1', registryDigest: 'r'.repeat(43),
      operationsRevision: 'operations-1', operationsDigest: 'o'.repeat(43),
      capabilityRevision: 'capability-1', capabilityDigest: 'c'.repeat(43),
      shapeRevision: 1, shapeDigest: 's'.repeat(43), contractRevision: 1,
      contractDigest: mutation.contractDigest ?? 'd'.repeat(43) },
    kills: { global: mutation.killed ?? false, providers: [], serviceOperations: [] },
  });
};
const fixture = () => {
  const database = new Database(':memory:'); const store = new ConnectorMigrationV2Store(database);
  store.inventory('install-1', [item()], false, NOW);
  let nowMs = NOW; let allowed = true;
  const calls = { read: 0, shape: 0, verify: 0, candidate: 0, promote: 0, placements: 0 };
  const adapters = {
    readLegacyOnce: async () => { calls.read += 1; },
    shape: async () => { calls.shape += 1; },
    verifyLive: async () => { calls.verify += 1; return {
      verified: true, certificationDigest: 'd'.repeat(43),
    }; },
    writeM2Candidate: async () => { calls.candidate += 1; },
    promoteCandidateCas: async () => { calls.promote += 1; return 'promoted' as const; },
    confirmRevisionPlacements: async () => { calls.placements += 1; return true; },
  } satisfies MigrationAdapters;
  const policy = (operation: ConnectorPolicyOperation) => policyAuthority({ nowMs, killed: !allowed, operation });
  const engine = () => new ConnectorMigrationV2Engine(store, adapters, () => nowMs,
    (_key, operation) => policy(operation));
  return { database, store, adapters, calls, engine, setNow: (value: number) => { nowMs = value; },
    policy, engineWithPolicy: (provider: (key: typeof KEY,
      operation: ConnectorPolicyOperation) => ConnectorMigrationPolicyCapability) =>
      new ConnectorMigrationV2Engine(store, adapters, () => nowMs, provider),
    kill: () => { allowed = false; }, allow: () => { allowed = true; } };
};

test('M4 is inert and full migration stops at cleanup_pending without shred', async () => {
  const f = fixture();
  try {
    assert.equal(CONNECTOR_MIGRATION_V2_ENABLED, false);
    assert.equal(await f.engine().migrate(KEY, authority(), 7), 'cleanup_pending');
    assert.deepEqual(f.calls, { read: 1, shape: 1, verify: 1, candidate: 1, promote: 1, placements: 1 });
    const row = f.database.prepare(`SELECT generation,state,envelope_digest
      FROM connector_migration_v2_account`).get() as Record<string, unknown>;
    assert.deepEqual(row, { generation: 'legacy', state: 'cleanup_pending',
      envelope_digest: 'd'.repeat(43) }, 'legacy is marked, never deleted or crypto-shredded');
  } finally { f.database.close(); }
});

test('inventory quarantines ambiguous, corrupt, compound, unknown, and exact collisions', () => {
  const database = new Database(':memory:'); const store = new ConnectorMigrationV2Store(database);
  try {
    const items = [
      item({ sourceId: 'ambiguous', provenanceMarkers: [] }),
      item({ sourceId: 'corrupt', accountId: 'a2', grantId: 'g2', corrupt: true }),
      item({ sourceId: 'compound', accountId: 'a3', grantId: 'g3', provenanceMarkers: ['legacy', 'm1'] }),
      item({ sourceId: 'unknown', accountId: 'a4', grantId: 'g4', generation: 'unknown',
        provenanceMarkers: ['unknown'] }),
      item({ sourceId: 'collision-a', accountId: 'same', grantId: 'same' }),
      item({ sourceId: 'collision-b', accountId: 'same', grantId: 'same' }),
    ];
    store.inventory('install-1', items, false, NOW);
    const rows: Array<{ source_id: string; state: string }> = database
      .prepare(`SELECT source_id,state FROM connector_migration_v2_account`).all() as Array<{
        source_id: string; state: string;
      }>;
    assert.equal(rows.length, 6);
    assert.equal(rows.every(row => row.state === 'quarantined'), true);
  } finally { database.close(); }
});

test('absent inventory is a mutation-free no-op', () => {
  const database = new Database(':memory:'); const store = new ConnectorMigrationV2Store(database);
  try {
    store.inventory('install-1', [], false, NOW);
    const count = database.prepare(`SELECT count(*) AS count
      FROM connector_migration_v2_installation`).get() as { count: number };
    assert.equal(count.count, 0);
  } finally { database.close(); }
});

test('same secret-free inventory is idempotent while changed source provenance is quarantined', () => {
  const database = new Database(':memory:'); const store = new ConnectorMigrationV2Store(database);
  try {
    store.inventory('install-1', [item()], false, NOW);
    store.inventory('install-1', [item()], false, NOW + 1);
    assert.equal(store.read(KEY).state, 'inventory');
    store.inventory('install-1', [item({ accountId: 'changed' })], false, NOW + 2);
    assert.equal(store.read(KEY).state, 'quarantined');
  } finally { database.close(); }
});

test('inventory fingerprint detects later corrupt or provenance changes', () => {
  for (const mutation of [{ corrupt: true }, { provenanceMarkers: ['legacy', 'm1'] }]) {
    const database = new Database(':memory:'); const store = new ConnectorMigrationV2Store(database);
    try {
      store.inventory('install-1', [item()], false, NOW);
      store.inventory('install-1', [item(mutation)], false, NOW + 1);
      assert.equal(store.read(KEY).state, 'quarantined');
    } finally { database.close(); }
  }
});

test('same sourceId remains isolated across installations', () => {
  const database = new Database(':memory:'); const store = new ConnectorMigrationV2Store(database);
  try {
    store.inventory('install-1', [item()], false, NOW);
    store.inventory('install-2', [item({ installationId: 'install-2', accountId: 'other' })], false, NOW);
    assert.equal(store.read(KEY).state, 'inventory');
    assert.equal(store.read({ installationId: 'install-2', sourceId: 'source-1' }).state, 'inventory');
  } finally { database.close(); }
});

test('external adapter subjects and idempotency keys are installation-scoped', async () => {
  const f = fixture();
  try {
    const secondKey = { installationId: 'install-2', sourceId: 'source-1' } as const;
    f.store.inventory('install-2', [item({ installationId: 'install-2', accountId: 'other' })], false, NOW);
    const reads: Array<{ installationId: string; idempotencyKey: string }> = [];
    f.adapters.readLegacyOnce = async (key, idempotencyKey) => {
      reads.push({ installationId: key.installationId, idempotencyKey });
    };
    await f.engine().migrate(KEY, authority(), 7);
    const engine2 = new ConnectorMigrationV2Engine(f.store, f.adapters, () => NOW,
      (_key, operation) => policyAuthority({ installationId: 'install-2', accountId: 'other', operation }));
    const owner2 = ConnectorMigrationOwnerCapability.fixture({ installationId: 'install-2', userId: 7,
      csrfVerified: true, consent: 'migrate_connectors', issuedAtMs: NOW - 1, expiresAtMs: NOW + 60_000 });
    await engine2.migrate(secondKey, owner2, 7);
    assert.deepEqual(reads.map(read => read.installationId), ['install-1', 'install-2']);
    assert.notEqual(reads[0]!.idempotencyKey, reads[1]!.idempotencyKey);
  } finally { f.database.close(); }
});

test('any explicit or persisted V2 marker blocks legacy fallback', () => {
  const database = new Database(':memory:'); const store = new ConnectorMigrationV2Store(database);
  try {
    assert.throws(() => store.inventory('install-1', [item()], true, NOW), /v2_fallback_blocked/u);
    assert.throws(() => store.inventory('install-2', [item({ installationId: 'install-2', generation: 'm2',
      provenanceMarkers: ['m2'] })], false, NOW),
      /v2_fallback_blocked/u);
    assert.throws(() => store.inventory('install-1', [item()], false, NOW), /v2_fallback_blocked/u,
      'persisted marker blocks fallback even when caller later passes false');
  } finally { database.close(); }
});

test('expired/replayed owner authority and wrong owner fail before legacy read', async () => {
  for (const [capability, userId] of [[authority(NOW), 7], [authority(), 8]] as const) {
    const f = fixture();
    try {
      await assert.rejects(f.engine().migrate(KEY, capability, userId), /authority_rejected/u);
      assert.equal(f.calls.read, 0);
    } finally { f.database.close(); }
  }
  const f = fixture();
  try {
    const cap = authority();
    await f.engine().migrate(KEY, cap, 7);
    await assert.rejects(f.engine().migrate(KEY, cap, 7), /authority_rejected/u);
  } finally { f.database.close(); }
});

test('crash/failure resumes idempotently from durable state and reads legacy only once', async () => {
  const f = fixture();
  try {
    let failShape = true;
    f.adapters.shape = async () => {
      f.calls.shape += 1;
      if (failShape) { failShape = false; throw new Error('crash'); }
    };
    await assert.rejects(f.engine().migrate(KEY, authority(), 7), /crash/u);
    assert.equal(f.store.read(KEY).state, 'legacy_read');
    f.setNow(NOW + 30_001);
    assert.equal(await f.engine().migrate(KEY, ConnectorMigrationOwnerCapability.fixture({
      installationId: 'install-1', userId: 7, csrfVerified: true, consent: 'migrate_connectors',
      issuedAtMs: NOW, expiresAtMs: NOW + 60_000,
    }), 7), 'cleanup_pending');
    assert.equal(f.calls.read, 1);
    assert.equal(f.calls.shape, 2);
  } finally { f.database.close(); }
});

test('crash after actual legacy read retries the same key without a second underlying read', async () => {
  const f = fixture();
  try {
    const keys = new Set<string>(); let calls = 0;
    f.adapters.readLegacyOnce = async (_source, key) => {
      if (!keys.has(key)) { keys.add(key); calls += 1; throw new Error('crash_after_read'); }
    };
    await assert.rejects(f.engine().migrate(KEY, authority(), 7), /crash_after_read/u);
    f.setNow(NOW + 30_001);
    const resumed = ConnectorMigrationOwnerCapability.fixture({ installationId: 'install-1', userId: 7,
      csrfVerified: true, consent: 'migrate_connectors', issuedAtMs: NOW, expiresAtMs: NOW + 60_000 });
    assert.equal(await f.engine().migrate(KEY, resumed, 7), 'cleanup_pending');
    assert.equal(calls, 1); assert.equal(keys.size, 1);
  } finally { f.database.close(); }
});

test('partial promotion resumes with the same source/candidate CAS revisions', async () => {
  const f = fixture();
  try {
    const revisions: Array<[number, number]> = [];
    f.adapters.promoteCandidateCas = async (_source, expected, candidate) => {
      revisions.push([expected, candidate]);
      if (revisions.length === 1) f.kill();
      return revisions.length === 1 ? 'promoted' : 'already_promoted';
    };
    await assert.rejects(f.engine().migrate(KEY, authority(), 7), /policy_rejected/u);
    assert.equal(f.store.read(KEY).state, 'candidate');
    f.setNow(NOW + 30_001); f.allow();
    const resumed = ConnectorMigrationOwnerCapability.fixture({ installationId: 'install-1', userId: 7,
      csrfVerified: true, consent: 'migrate_connectors', issuedAtMs: NOW, expiresAtMs: NOW + 60_000 });
    assert.equal(await f.engine().migrate(KEY, resumed, 7), 'cleanup_pending');
    assert.deepEqual(revisions, [[1, 2], [1, 2]], 'retry uses one idempotent CAS identity');
  } finally { f.database.close(); }
});

test('kill before and during live verification prevents candidate or promotion', async () => {
  const f = fixture();
  try {
    f.kill();
    await assert.rejects(f.engine().migrate(KEY, authority(), 7), /policy_rejected/u);
    assert.equal(f.calls.read, 0);
  } finally { f.database.close(); }
  const during = fixture();
  try {
    during.adapters.verifyLive = async () => { during.calls.verify += 1; during.kill(); return {
      verified: true, certificationDigest: 'd'.repeat(43),
    }; };
    await assert.rejects(during.engine().migrate(KEY, authority(), 7), /policy_rejected/u);
    assert.equal(during.store.read(KEY).state, 'shaped');
    assert.equal(during.calls.candidate, 0);
  } finally { during.database.close(); }
});

test('certified policy authority rejects identity/revision drift, expiry, and replay', async () => {
  const cases = [
    () => policyAuthority({ accountId: 'other' }),
    () => policyAuthority({ snapshotRegistry: 'registry-2', certificationRegistry: 'registry-1' }),
    () => policyAuthority({ nowMs: NOW - 120_000 }),
  ];
  for (const capability of cases) {
    const f = fixture();
    try {
      await assert.rejects(f.engineWithPolicy(capability).migrate(KEY, authority(), 7),
        /policy_rejected/u);
      assert.equal(f.store.read(KEY).state, 'inventory');
    } finally { f.database.close(); }
  }
  const replay = fixture();
  try {
    const oneUse = policyAuthority();
    await assert.rejects(replay.engineWithPolicy(() => oneUse).migrate(KEY, authority(), 7),
      /policy_rejected/u);
    assert.equal(replay.store.read(KEY).state, 'inventory');
    assert.equal(replay.calls.read, 0);
  } finally { replay.database.close(); }
});

test('stage-specific policy kills and verification evidence drift stop candidate/placement stages', async () => {
  for (const blockedOperation of [ConnectorPolicyOperation.CredentialStoreUnverified,
    ConnectorPolicyOperation.PlacementWrite]) {
    const f = fixture();
    try {
      const engine = f.engineWithPolicy((_key, operation) => policyAuthority({ operation,
        killed: operation === blockedOperation }));
      await assert.rejects(engine.migrate(KEY, authority(), 7), /policy_rejected/u);
      assert.notEqual(f.store.read(KEY).state, 'cleanup_pending');
      if (blockedOperation === ConnectorPolicyOperation.CredentialStoreUnverified) {
        assert.equal(f.calls.candidate, 0);
      }
    } finally { f.database.close(); }
  }
  const drift = fixture();
  try {
    const engine = drift.engineWithPolicy((_key, operation) => policyAuthority({ operation,
      contractDigest: operation === ConnectorPolicyOperation.CredentialVerify
        && drift.store.read(KEY).state === 'verified'
        ? 'e'.repeat(43) : 'd'.repeat(43) }));
    await assert.rejects(engine.migrate(KEY, authority(), 7), /verification_evidence_stale/u);
    assert.equal(drift.store.read(KEY).state, 'verified');
    assert.equal(drift.calls.candidate, 0);
  } finally { drift.database.close(); }
});

test('post-write candidate kill leaves verified state and retry reuses the same idempotency key', async () => {
  const f = fixture();
  try {
    let storeChecks = 0; let blockPostWrite = true;
    const keys: string[] = [];
    f.adapters.writeM2Candidate = async (_key, _revision, idempotencyKey) => {
      f.calls.candidate += 1; keys.push(idempotencyKey);
    };
    const engine = f.engineWithPolicy((_key, operation) => {
      if (operation === ConnectorPolicyOperation.CredentialStoreUnverified) storeChecks += 1;
      return policyAuthority({ operation, killed: blockPostWrite && storeChecks === 3 });
    });
    await assert.rejects(engine.migrate(KEY, authority(), 7), /policy_rejected/u);
    assert.equal(f.store.read(KEY).state, 'verified');
    assert.equal(f.calls.candidate, 1);
    f.setNow(NOW + 30_001); blockPostWrite = false;
    const owner = ConnectorMigrationOwnerCapability.fixture({ installationId: 'install-1', userId: 7,
      csrfVerified: true, consent: 'migrate_connectors', issuedAtMs: NOW, expiresAtMs: NOW + 60_000 });
    assert.equal(await engine.migrate(KEY, owner, 7), 'cleanup_pending');
    assert.deepEqual(keys, [keys[0], keys[0]], 'external adapter receives one stable retry identity');
  } finally { f.database.close(); }
});

test('CAS or placement confirmation failure never advances to cleanup_pending', async () => {
  for (const failure of ['cas', 'placement'] as const) {
    const f = fixture();
    try {
      if (failure === 'cas') f.adapters.promoteCandidateCas = async () => 'conflict';
      else f.adapters.confirmRevisionPlacements = async () => false;
      await assert.rejects(f.engine().migrate(KEY, authority(), 7),
        failure === 'cas' ? /promote_cas_failed/u : /placements_unconfirmed/u);
      assert.notEqual(f.store.read(KEY).state, 'cleanup_pending');
    } finally { f.database.close(); }
  }
});

test('central legacy continuation requires exact snapshot, bounded deadline, and no V2 state', () => {
  const f = fixture();
  const snapshot = f.store.issueLegacyContinuation(KEY, NOW, NOW + 60_000, 4);
  const expected = { installationId: 'install-1', sourceId: 'source-1', policyEpoch: 4 };
  try {
    assert.equal(evaluateLegacyOperationalContinuation(f.store, snapshot, expected, NOW + 1), true);
    assert.equal(evaluateLegacyOperationalContinuation(f.store, snapshot, expected, NOW + 60_000), false);
    assert.equal(evaluateLegacyOperationalContinuation(f.store, snapshot,
      { ...expected, policyEpoch: 5 }, NOW + 1), false);
    assert.throws(() => f.store.issueLegacyContinuation(KEY, NOW,
      NOW + 86_400_001, 4), /issue_rejected/u);
    f.store.inventory('install-1', [item({ corrupt: true })], false, NOW + 2);
    assert.equal(evaluateLegacyOperationalContinuation(f.store, snapshot, expected, NOW + 3), false,
      'inventory revision/fingerprint drift and quarantine revoke an issued continuation');
    assert.throws(() => f.store.inventory('install-1', [], true, NOW + 2), /v2_fallback_blocked/u);
    assert.equal(evaluateLegacyOperationalContinuation(f.store, snapshot, expected, NOW + 3), false,
      'caller cannot override authoritative persisted V2 marker');
    assert.throws(() => JSON.stringify(snapshot), /not_serializable/u);
  } finally { f.database.close(); }
});

test('quarantined and failed material can never receive legacy continuation', async () => {
  const database = new Database(':memory:'); const store = new ConnectorMigrationV2Store(database);
  try {
    store.inventory('install-1', [item({ corrupt: true })], false, NOW);
    assert.throws(() => store.issueLegacyContinuation(KEY, NOW, NOW + 1_000, 1), /issue_rejected/u);
  } finally { database.close(); }
  const failed = fixture();
  try {
    failed.adapters.verifyLive = async () => ({ verified: false, certificationDigest: 'd'.repeat(43) });
    assert.equal(await failed.engine().migrate(KEY, authority(), 7), 'failed');
    assert.throws(() => failed.store.issueLegacyContinuation(KEY, NOW, NOW + 1_000, 1), /issue_rejected/u);
  } finally { failed.database.close(); }
});

test('audit and public state contain metadata only and reject secret-like detail', () => {
  const f = fixture();
  try {
    assert.throws(() => f.store.audit(KEY, 'migration', NOW, 'token=raw'),
      /audit_code_rejected/u);
    const schema = f.database.prepare(`SELECT sql FROM sqlite_master
      WHERE name IN ('connector_migration_v2_account','connector_migration_v2_audit')`).all();
    assert.equal(/plaintext|access_token|refresh_token|client_secret/iu.test(JSON.stringify(schema)), false);
  } finally { f.database.close(); }
});

test('transition graph is closed and audit failure rolls the state update back atomically', () => {
  const f = fixture();
  try {
    const invalidLease = f.store.acquire(KEY, 'owner', NOW, 1_000);
    assert.throws(() => f.store.transition(invalidLease, 'inventory', 'promoted', NOW),
      /graph_rejected/u);
    assert.throws(() => f.store.transition(invalidLease, 'inventory', 'legacy_read_pending', NOW,
      { candidateRevision: 2 }), /mutation_rejected/u);
    f.setNow(NOW + 1_001);
    const lease = f.store.acquire(KEY, 'owner', NOW + 1_001, 1_000);
    f.database.exec(`CREATE TRIGGER reject_migration_audit BEFORE INSERT ON connector_migration_v2_audit
      WHEN NEW.event = 'state.legacy_read_pending' BEGIN SELECT RAISE(ABORT,'audit_down'); END`);
    assert.throws(() => f.store.transition(lease, 'inventory', 'legacy_read_pending', NOW + 1_001),
      /audit_down/u);
    assert.deepEqual(f.store.read(KEY), { state: 'inventory', revision: 1,
      sourceRevision: 1, candidateRevision: null, failureCode: null });
  } finally { f.database.close(); }
});

test('direct store transitions enforce exact candidate/source relations and failure code', () => {
  for (const scenario of ['candidate', 'promote', 'failed'] as const) {
    const f = fixture();
    try {
      if (scenario === 'candidate') f.database.prepare(`UPDATE connector_migration_v2_account
        SET state = 'verified' WHERE installation_id = ? AND source_id = ?`)
        .run(KEY.installationId, KEY.sourceId);
      else if (scenario === 'promote') f.database.prepare(`UPDATE connector_migration_v2_account
        SET state = 'candidate',candidate_revision = 2 WHERE installation_id = ? AND source_id = ?`)
        .run(KEY.installationId, KEY.sourceId);
      else f.database.prepare(`UPDATE connector_migration_v2_account SET state = 'shaped'
        WHERE installation_id = ? AND source_id = ?`).run(KEY.installationId, KEY.sourceId);
      const lease = f.store.acquire(KEY, 'owner', NOW, 1_000);
      if (scenario === 'candidate') assert.throws(() => f.store.transition(
        lease, 'verified', 'candidate', NOW, { candidateRevision: 3 }), /relation_rejected/u);
      else if (scenario === 'promote') assert.throws(() => f.store.transition(
        lease, 'candidate', 'promoted', NOW, { sourceRevision: 3 }), /relation_rejected/u);
      else assert.throws(() => f.store.transition(lease, 'shaped', 'failed', NOW,
        { failureCode: 'collision' }), /relation_rejected/u);
    } finally { f.database.close(); }
  }
});

test('canonical M2 authority integration remains a mandatory inert cutover exit condition', () => {
  assert.deepEqual(CONNECTOR_MIGRATION_V2_CUTOVER_EXIT_CONDITIONS, [
    'write_and_read_v2_presence_from_the_canonical_M2_fenced_authority',
    'add_all_migration_tables_to_the_M2_guarded_inventory_before_activation',
    'start_no_migration_when_canonical_v2_authority_is_unavailable',
  ]);
});
