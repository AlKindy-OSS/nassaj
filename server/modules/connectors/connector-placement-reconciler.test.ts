import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import {
  closeConnection,
  getConnection,
  initializeDatabase,
  type ConnectorRow,
} from '@/modules/database/index.js';
import { providerMcpService } from '@/modules/providers/index.js';
import {
  nextPlacementFence,
  runConnectorPlacementDryRun,
  validatePlacementFence,
} from '@/modules/connectors/connector-placement-reconciler.js';
import { readConnectorRuntimeAuthorityRoot } from '@/modules/connectors/connector-runtime-authority-root.js';
import {
  CONNECTOR_POLICY_SCHEMA_VERSION,
  CONNECTOR_RUNTIME_FLOOR,
  ConnectorRuntimeWriteGate,
} from '@/modules/connectors/connector-runtime-fence.js';

function connector(overrides: Partial<ConnectorRow>): ConnectorRow {
  return {
    id: 'github-u1',
    service: 'github',
    displayName: 'GitHub',
    accountLabel: '',
    credentialMode: 'per_member',
    ownerUserId: 1,
    allowsSharing: false,
    enabled: true,
    transport: 'http',
    command: null,
    args: [],
    url: 'https://example.invalid/mcp',
    keyEnvVar: null,
    keyHeader: 'Authorization',
    keyHeaderPrefix: 'Bearer ',
    extraEnv: {},
    authMode: 'key',
    createdBy: 1,
    createdAt: '2026-08-25T00:00:00.000Z',
    updatedAt: '2026-08-25T00:00:00.000Z',
    ...overrides,
  };
}

test('dry-run is disabled by default and performs no reads', () => {
  let reads = 0;
  const result = runConnectorPlacementDryRun({
    env: {},
    deps: {
      listConnectors: () => { reads += 1; return []; },
      listUsers: () => { reads += 1; return []; },
      hasCredential: () => { reads += 1; return false; },
    },
  });
  assert.equal(result.enabled, false);
  assert.equal(result.checksum, null);
  assert.equal(reads, 0);
});

test('dry-run computes only personal Claude/Codex intent with redacted diagnostics', () => {
  const connectors = [
    connector({ id: 'github-u1' }),
    connector({ id: 'missing-owner', ownerUserId: null }),
    connector({ id: 'shared-secret-name', credentialMode: 'org_shared', ownerUserId: null }),
    connector({ id: 'disabled', enabled: false }),
  ];
  const deps = {
    listConnectors: () => connectors,
    listUsers: () => [{ id: 1, status: 'active' }, { id: 2, status: 'disabled' }],
    hasCredential: () => true,
  };

  const first = runConnectorPlacementDryRun({
    env: { NASSAJ_CONNECTOR_RECONCILER_DRY_RUN: '1' },
    deps,
  });
  const second = runConnectorPlacementDryRun({
    env: { NASSAJ_CONNECTOR_RECONCILER_DRY_RUN: '1' },
    deps,
  });

  assert.equal(first.enabled, true);
  assert.equal(first.metrics.connectorsScanned, 4);
  assert.equal(first.metrics.connectorsEligible, 1);
  assert.equal(first.metrics.activeMembers, 1);
  assert.equal(first.metrics.desiredPlacements, 2, 'one owner × Claude/Codex only');
  assert.equal(first.metrics.blockedConnectors, 2);
  assert.deepEqual(first.metrics.errorsByCode, {
    CONNECTOR_OWNER_MISSING: 1,
    CONNECTOR_SHARED_SCOPE_NOT_ARMED: 1,
  });
  assert.equal(first.checksum, second.checksum, 'same desired state has a stable checksum');
  assert.match(first.checksum ?? '', /^[a-f0-9]{64}$/);
  const rendered = JSON.stringify(first);
  assert.doesNotMatch(rendered, /missing-owner|shared-secret-name|example\.invalid|Authorization|Bearer/);
  assert.ok(first.errors.every((error) => Object.keys(error).length === 1), 'diagnostics expose code only');
});

test('enabled key and OAuth connectors without credentials are absent from desired state', () => {
  const result = runConnectorPlacementDryRun({
    env: { NASSAJ_CONNECTOR_RECONCILER_DRY_RUN: '1' },
    deps: {
      listConnectors: () => [
        connector({ id: 'key-without-secret', authMode: 'key' }),
        connector({ id: 'oauth-without-grant', authMode: 'oauth' }),
      ],
      listUsers: () => [{ id: 1, status: 'active' }],
      hasCredential: () => false,
    },
  });

  assert.equal(result.metrics.connectorsEligible, 0);
  assert.equal(result.metrics.desiredPlacements, 0);
  assert.equal(result.metrics.blockedConnectors, 2);
  assert.deepEqual(result.metrics.errorsByCode, { CONNECTOR_CREDENTIAL_MISSING: 2 });
  assert.deepEqual(result.errors, [
    { code: 'CONNECTOR_CREDENTIAL_MISSING' },
    { code: 'CONNECTOR_CREDENTIAL_MISSING' },
  ]);
});

test('dry-run leaves the SQLite bytes and provider config untouched and calls no writer', async () => {
  const previous = process.env.DATABASE_PATH;
  const previousHome = process.env.HOME;
  const directory = await mkdtemp('/var/tmp/connector-placement-dry-run-');
  const databasePath = path.join(directory, 'db.sqlite');
  const providerConfigPath = path.join(directory, 'provider-config.json');
  process.env.DATABASE_PATH = databasePath;
  process.env.HOME = directory;
  await writeFile(databasePath, '');
  await writeFile(providerConfigPath, '{"mcpServers":{"existing":{}}}\n');
  closeConnection();
  await initializeDatabase();

  const digest = async (filePath: string): Promise<string> =>
    crypto.createHash('sha256').update(await readFile(filePath)).digest('hex');
  const originalWriter = providerMcpService.upsertProviderMcpServer;
  let writerCalls = 0;
  providerMcpService.upsertProviderMcpServer = async (...args) => {
    writerCalls += 1;
    return originalWriter(...args);
  };

  try {
    const db = getConnection();
    db.prepare("INSERT INTO users (username, password_hash, role) VALUES ('owner', 'hash', 'owner')").run();
    const userId = (db.prepare("SELECT id FROM users WHERE username = 'owner'").get() as { id: number }).id;
    const authority = readConnectorRuntimeAuthorityRoot(
      `${databasePath}.connector-runtime-authority.json`,
    ).authority;
    const gate = new ConnectorRuntimeWriteGate(db, {
      runtimeVersion: CONNECTOR_RUNTIME_FLOOR,
      maximumPolicySchemaVersion: CONNECTOR_POLICY_SCHEMA_VERSION,
      supportsWriterFencing: true,
    }, authority);
    assert.ok(gate.acquireForInitialization('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'));
    assert.equal(gate.runFencedMutation(() => {
      db.prepare(
        `INSERT INTO connectors (
           id, service, display_name, credential_mode, owner_user_id, created_by
         ) VALUES (?, ?, ?, 'per_member', ?, ?)`,
      ).run('github-u1', 'github', 'GitHub', userId, userId);
    }, false), true, 'fixture setup must use the guarded connector writer');
    db.pragma('wal_checkpoint(TRUNCATE)');
    const databaseBefore = await digest(databasePath);
    const configBefore = await digest(providerConfigPath);

    const result = runConnectorPlacementDryRun({
      env: { NASSAJ_CONNECTOR_RECONCILER_DRY_RUN: '1' },
    });

    db.pragma('wal_checkpoint(TRUNCATE)');
    assert.equal(await digest(databasePath), databaseBefore, 'dry-run must not change database bytes');
    assert.equal(await digest(providerConfigPath), configBefore, 'dry-run must not change provider files');
    assert.equal(writerCalls, 0, 'dry-run must never call a provider writer');
    assert.equal(result.metrics.desiredPlacements, 0, 'enabled without a stored key is not desired');
    assert.deepEqual(result.metrics.errorsByCode, { CONNECTOR_CREDENTIAL_MISSING: 1 });
    assert.equal(
      (db.prepare('SELECT COUNT(*) AS count FROM connector_placements').get() as { count: number }).count,
      0,
      'dry-run must not materialize placement rows',
    );
  } finally {
    providerMcpService.upsertProviderMcpServer = originalWriter;
    closeConnection();
    if (previous === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previous;
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    await rm(directory, { recursive: true, force: true });
  }
});

test('placement fence rejects stale token, stale generation, and expiry', () => {
  const first = nextPlacementFence(0, 7, 1_000, 500);
  const second = nextPlacementFence(first.fencingToken, 8, 1_100, 500);

  assert.equal(validatePlacementFence(second, second, 1_200), null);
  assert.equal(
    validatePlacementFence(second, first, 1_200),
    'PLACEMENT_STALE_FENCING_TOKEN',
    'an older worker cannot commit after lease reacquisition',
  );
  assert.equal(
    validatePlacementFence(second, { fencingToken: second.fencingToken, desiredGeneration: 7 }, 1_200),
    'PLACEMENT_STALE_DESIRED_GENERATION',
    'the current worker cannot commit obsolete desired material',
  );
  assert.equal(validatePlacementFence(second, second, second.leaseExpiresAtMs), 'PLACEMENT_LEASE_EXPIRED');
});

test('placement fence rejects every invalid numeric input before comparison', () => {
  const valid = nextPlacementFence(2, 9, 1_000, 500);
  const invalidValues = [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -1, 1.5, Number.MAX_SAFE_INTEGER + 1];

  for (const invalid of invalidValues) {
    for (const field of ['desiredGeneration', 'fencingToken', 'leaseExpiresAtMs'] as const) {
      assert.throws(
        () => validatePlacementFence({ ...valid, [field]: invalid }, valid, 1_100),
        TypeError,
        `invalid current.${field} must throw`,
      );
    }
    for (const field of ['desiredGeneration', 'fencingToken'] as const) {
      assert.throws(
        () => validatePlacementFence(valid, { ...valid, [field]: invalid }, 1_100),
        TypeError,
        `invalid presented.${field} must throw`,
      );
    }
    assert.throws(() => validatePlacementFence(valid, valid, invalid), TypeError, 'invalid nowMs must throw');
  }
});
