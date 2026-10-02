import assert from 'node:assert/strict';
import test from 'node:test';

import Database from 'better-sqlite3';

import { migratePermissionExecution, PermissionStateConflictError } from '@/modules/database/index.js';
import {
  currentApiKeySsoUnavailableGate,
  setApiKeySsoUnavailableGate,
} from '@/modules/database/repositories/api-key-sso-gate.js';

import { createAuthenticatedLaunchActor } from './actor.js';
import { createExecutionPermissionGateway } from './execution-gateway.service.js';
import {
  PERMISSION_CAPABILITY_ARTIFACT_DIGEST,
  computePermissionReleaseCapabilityDigest,
  resolveMeasuredPermissionCandidate,
} from './capability-registry.js';
import artifact from './fixtures/permission-capabilities.v1.json' with { type: 'json' };
import { CLAUDE_REFERENCE_VECTOR_V1 } from './fixtures/claude-reference-v1.js';
import type { CanonicalLaunchContext, SealedPermissionPolicy } from './types.js';

const setup = (): Database.Database => {
  const database = new Database(':memory:');
  database.pragma('foreign_keys = ON');
  database.exec(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY, username TEXT NOT NULL, password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'user', status TEXT NOT NULL DEFAULT 'active',
      is_active INTEGER NOT NULL DEFAULT 1, password_changed_at INTEGER
    );
    CREATE TABLE api_keys (
      id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, key_digest TEXT,
      is_active INTEGER NOT NULL DEFAULT 1
    );
    INSERT INTO users (id, username, password_hash) VALUES (1, 'owner', 'hash');
  `);
  migratePermissionExecution(database);
  return database;
};

const TEST_RELEASE_BUILD = 'c'.repeat(64);
const TEST_PROFILE_DIGEST = `sha256:${'a'.repeat(64)}`;
const capabilitySeal = (generation: number) => computePermissionReleaseCapabilityDigest(
  TEST_RELEASE_BUILD, TEST_PROFILE_DIGEST, generation,
);

const authority = (protocolGeneration: number): SealedPermissionPolicy => Object.freeze({
  source: 'sealed_release_manifest',
  profileId: 'full_delegation',
  contractVersion: 'permission-parity/v1',
  profileDigest: TEST_PROFILE_DIGEST,
  capabilityDigest: capabilitySeal(protocolGeneration),
  protocolGeneration,
});

const actor = createAuthenticatedLaunchActor({
  id: 1, role: 'owner', status: 'active', is_active: 1,
  authenticationKind: 'session', authorizationGeneration: 1,
}, '2030-01-01T00:00:00.000Z');

const context = Object.freeze({
  launchId: 'launch-1', principalId: 'user:1', sessionId: null,
  projectId: 'project-1', workspacePath: '/workspace/project', provider: 'codex',
  body: 'codex', engine: 'sdk', entrypoint: 'ws.chat', purpose: 'sdk_turn' as const, effectFootprint: 'external' as const,
});

const gateway = (
  database: Database.Database,
  generation: number,
  now: { value: number },
  candidateFor: Parameters<typeof createExecutionPermissionGateway>[0]['candidateFor'] = () => null,
  isDevicePrincipalCurrent: Parameters<typeof createExecutionPermissionGateway>[0]['isDevicePrincipalCurrent'] = () => true,
) => {
  let sequence = 0;
  return createExecutionPermissionGateway({
    database,
    authority: authority(generation),
    reference: CLAUDE_REFERENCE_VECTOR_V1,
    candidateFor,
    capabilityArtifactDigest: PERMISSION_CAPABILITY_ARTIFACT_DIGEST,
    releaseBuild: TEST_RELEASE_BUILD,
    manifestDigest: generation === 1 ? null : 'digest',
    processIdentity: {
      ownerId: 'process:1', ownerPid: 10, ownerBootId: 'boot', ownerStartTicks: '100',
    },
    randomId: () => `id-${++sequence}`,
    nowMs: () => now.value,
    isDevicePrincipalCurrent,
  });
};

test('legacy admits unchanged effect but permit consumption is durable and single-use', () => {
  const database = setup();
  try {
    const now = { value: 100 };
    const result = gateway(database, 1, now).authorize(actor, context, 'full_delegation');
    assert.equal(result.kind, 'authorized');
    if (result.kind !== 'authorized') return;
    assert.equal(result.execution.mode, 'legacy');
    assert.equal(result.execution.consume().launchId, 'launch-1');
    assert.throws(() => result.execution.consume(), /PERMIT_REPLAYED/);
    const row = database.prepare(`SELECT decision.state, lease.status
      FROM permission_launch_decisions decision JOIN permission_admission_leases lease
      ON lease.decision_id = decision.decision_id`).get();
    assert.deepEqual(row, { state: 'effect_claimed', status: 'active' });
  } finally {
    database.close();
  }
});

test('device-session actor reaches the real launch gateway with wallet fencing intact', () => {
  const database = setup();
  try {
    const deviceActor = createAuthenticatedLaunchActor({
      id: 1, role: 'owner', status: 'active', is_active: 1,
      authenticationKind: 'device_session', authorizationGeneration: 1,
      deviceSessionId: 'device_server_issued', slotId: 'slot_server_issued',
      deviceGeneration: 4,
    }, '2030-01-01T00:00:00.000Z');
    const result = gateway(database, 1, { value: 100 })
      .authorize(deviceActor, context, 'full_delegation');
    assert.equal(result.kind, 'authorized');
    assert.equal(deviceActor.authenticationKind, 'session');
    assert.equal(deviceActor.deviceSessionId, 'device_server_issued');
    assert.equal(deviceActor.slotId, 'slot_server_issued');
    assert.equal(deviceActor.deviceGeneration, 4);
    const row = database.prepare(`
      SELECT authentication_kind AS authenticationKind,
             device_session_id AS deviceSessionId,
             device_slot_id AS slotId,
             device_generation AS deviceGeneration
      FROM permission_launch_decisions
    `).get();
    assert.deepEqual(row, {
      authenticationKind: 'session',
      deviceSessionId: 'device_server_issued',
      slotId: 'slot_server_issued',
      deviceGeneration: 4,
    });
  } finally {
    database.close();
  }
});

test('device-session permit cannot be consumed after its wallet generation changes', () => {
  const database = setup();
  try {
    let current = true;
    const deviceActor = createAuthenticatedLaunchActor({
      id: 1, role: 'owner', status: 'active', is_active: 1,
      authenticationKind: 'device_session', authorizationGeneration: 1,
      deviceSessionId: 'device_server_issued', slotId: 'slot_server_issued',
      deviceGeneration: 4,
    }, '2030-01-01T00:00:00.000Z');
    const result = gateway(database, 1, { value: 100 }, () => null, () => current)
      .authorize(deviceActor, context, 'full_delegation');
    assert.equal(result.kind, 'authorized');
    if (result.kind !== 'authorized') return;
    current = false;
    assert.throws(
      () => result.execution.consume(),
      (error: unknown) => error instanceof PermissionStateConflictError
        && error.code === 'DEVICE_IDENTITY_STALE',
    );
    assert.equal((database.prepare(
      "SELECT COUNT(*) AS count FROM permission_admission_leases WHERE status = 'active'",
    ).get() as { count: number }).count, 0);
  } finally {
    database.close();
  }
});

test('JWT permit cannot be consumed after global authorization generation changes', () => {
  const database = setup();
  try {
    const result = gateway(database, 1, { value: 100 }).authorize(actor, context, 'full_delegation');
    assert.equal(result.kind, 'authorized');
    if (result.kind !== 'authorized') return;
    database.prepare('UPDATE users SET role = ? WHERE id = 1').run('admin');
    assert.throws(() => result.execution.consume(), (error: unknown) =>
      error instanceof PermissionStateConflictError && error.code === 'IDENTITY_STALE');
  } finally {
    database.close();
  }
});

test('CK permit binds the exact key across disable, re-enable and fresh admission', () => {
  const database = setup();
  try {
    const permissionGateway = gateway(database, 1, { value: 100 });
    database.prepare("INSERT INTO api_keys(id,user_id,key_digest,is_active) VALUES(11,1,'digest',1)").run();
    const oldActor = createAuthenticatedLaunchActor({
      id: 1, role: 'owner', status: 'active', is_active: 1,
      authenticationKind: 'ck', authenticationCredentialId: 'api-key:11', authorizationGeneration: 2,
    }, '2030-01-01T00:00:00.000Z');
    const admitted = permissionGateway.authorize(oldActor, context, 'full_delegation');
    assert.equal(admitted.kind, 'authorized');
    if (admitted.kind !== 'authorized') return;
    database.prepare('UPDATE api_keys SET is_active = 0 WHERE id = 11').run();
    database.prepare('UPDATE api_keys SET is_active = 1 WHERE id = 11').run();
    assert.throws(() => admitted.execution.consume(), (error: unknown) =>
      error instanceof PermissionStateConflictError && error.code === 'IDENTITY_STALE');

    const generation = (database.prepare('SELECT authorization_generation AS generation FROM users WHERE id=1')
      .get() as { generation: number }).generation;
    const freshActor = createAuthenticatedLaunchActor({
      id: 1, role: 'owner', status: 'active', is_active: 1,
      authenticationKind: 'ck', authenticationCredentialId: 'api-key:11',
      authorizationGeneration: generation,
    }, '2030-01-01T00:00:00.000Z');
    assert.equal(permissionGateway.authorize(
      freshActor, { ...context, launchId: 'fresh-ck' }, 'full_delegation',
    ).kind, 'authorized');
  } finally {
    database.close();
  }
});

test('CK launch applies the T-1946 SSO window at authorize and at deferred consume', (t) => {
  // This test's private database has no SSO state; the gate (ADR-194 D6) reads
  // the application connection, so pin the plain T-1946 window (owner-disabled
  // SSO). The SSO-unavailable refusal is covered by the D1 matrices.
  const previousGate = currentApiKeySsoUnavailableGate();
  setApiKeySsoUnavailableGate(() => false);
  t.after(() => setApiKeySsoUnavailableGate(previousGate));
  const database = setup();
  try {
    const DAY_MS = 24 * 60 * 60 * 1000;
    const now = { value: Date.UTC(2026, 9, 1, 12) };
    database.exec(`
      CREATE TABLE app_config (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE user_identities (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL,
        issuer TEXT NOT NULL, subject TEXT NOT NULL, last_attested_at INTEGER);
      INSERT INTO users (id, username, password_hash, role) VALUES (2, 'member', 'hash', 'user');
      INSERT INTO api_keys (id, user_id, key_digest, is_active) VALUES (12, 2, 'member-digest', 1);
      INSERT INTO user_identities (id, user_id, issuer, subject) VALUES (5, 2, 'https://idp', 'sub');
    `);
    const generation = (database.prepare('SELECT authorization_generation AS generation FROM users WHERE id=2')
      .get() as { generation: number }).generation;
    const member = createAuthenticatedLaunchActor({
      id: 2, role: 'user', status: 'active', is_active: 1,
      authenticationKind: 'ck', authenticationCredentialId: 'api-key:12', authorizationGeneration: generation,
    }, '2030-01-01T00:00:00.000Z');
    const attest = (agoMs: number) => database.prepare('UPDATE user_identities SET last_attested_at = ? WHERE id = 5')
      .run(now.value - agoMs);
    const permissionGateway = gateway(database, 1, now);
    const stale = (error: unknown) => error instanceof PermissionStateConflictError && error.code === 'IDENTITY_STALE';

    attest(8 * DAY_MS);
    assert.throws(() => permissionGateway.authorize(member, { ...context, launchId: 'stale' }, 'full_delegation'), stale);

    attest(DAY_MS);
    const admitted = permissionGateway.authorize(member, { ...context, launchId: 'fresh' }, 'full_delegation');
    assert.equal(admitted.kind, 'authorized');
    if (admitted.kind !== 'authorized') return;
    now.value += 7 * DAY_MS;
    assert.throws(() => admitted.execution.consume(), stale, 'a deferred launch re-applies the window');
  } finally {
    database.close();
  }
});

test('legacy preserves forbidden-purpose effects until shadow/enforce transition', () => {
  for (const purpose of ['mcp', 'delegation', 'external_agent_dispatch'] as const) {
    const database = setup();
    try {
      const result = gateway(database, 1, { value: 100 }).authorize(
        actor,
        { ...context, launchId: `launch-${purpose}`, purpose },
        'full_delegation',
      );
      assert.equal(result.kind, 'authorized');
      assert.equal((database.prepare('SELECT COUNT(*) AS count FROM permission_admission_leases')
        .get() as { count: number }).count, 1);
    } finally {
      database.close();
    }
  }
});

test('authorized handle can close a pre-provider refusal as not-started', () => {
  const database = setup();
  try {
    const result = gateway(database, 1, { value: 100 })
      .authorize(actor, context, 'full_delegation');
    assert.equal(result.kind, 'authorized');
    if (result.kind !== 'authorized') return;
    result.execution.notStarted();
    assert.deepEqual(database.prepare(`SELECT decision.terminal_outcome AS outcome,
      lease.status FROM permission_launch_decisions decision
      JOIN permission_admission_leases lease ON lease.decision_id = decision.decision_id`).get(), {
      outcome: 'not_started', status: 'revoked',
    });
    assert.throws(() => result.execution.consume(), /LEASE_NOT_CLAIMABLE|PERMIT_REPLAYED/);
  } finally {
    database.close();
  }
});

test('terminal CAS ambiguity durably blocks the generation', () => {
  const database = setup();
  try {
    const result = gateway(database, 1, { value: 100 })
      .authorize(actor, context, 'full_delegation');
    assert.equal(result.kind, 'authorized');
    if (result.kind !== 'authorized') return;
    result.execution.consume();
    database.prepare(`UPDATE permission_admission_leases SET status = 'revoked',
      terminal_at_ms = 101 WHERE lease_id = ?`).run(result.execution.leaseId);
    assert.throws(() => result.execution.settle('failed'), /LEASE_NOT_SETTLEABLE/);
    assert.equal((database.prepare(
      'SELECT COUNT(*) AS count FROM permission_generation_blocks WHERE protocol_generation = 1',
    ).get() as { count: number }).count, 1);
  } finally {
    database.close();
  }
});

test('T-1593: a reconciled-unknown terminal fact fences its own session scope, never the generation', () => {
  const database = setup();
  try {
    const service = gateway(database, 1, { value: 100 });
    const result = service.authorize(actor, context, 'full_delegation');
    assert.equal(result.kind, 'authorized');
    if (result.kind !== 'authorized') return;
    result.execution.consume();
    result.execution.markStarted();
    result.execution.settle('reconciled_unknown');
    assert.equal((database.prepare(
      'SELECT COUNT(*) AS count FROM permission_generation_blocks WHERE protocol_generation = 1',
    ).get() as { count: number }).count, 0);
    // The fixture context carries no session, so the scope is user+provider+purpose.
    assert.deepEqual(database.prepare(
      'SELECT scope_kind AS scopeKind, scope_key AS scopeKey FROM permission_effect_fences',
    ).all(), [{ scopeKind: 'user_provider_purpose', scopeKey: `${actor.userId}:codex:sdk_turn` }]);
    // Like GENERATION_BLOCKED, a fenced scope surfaces as a conflict error, not a denial.
    assert.throws(() => service.authorize(actor, { ...context, launchId: 'launch-2' }, 'full_delegation'),
      (error: unknown) => error instanceof PermissionStateConflictError && error.code === 'EFFECT_SCOPE_FENCED');
    const otherScope = service.authorize(actor, { ...context, launchId: 'launch-3', purpose: 'catalog' }, 'full_delegation');
    assert.equal(otherScope.kind, 'authorized');
  } finally {
    database.close();
  }
});

test('child identity can attach only after the durable pre-effect start', () => {
  const database = setup();
  try {
    const result = gateway(database, 1, { value: 100 })
      .authorize(actor, { ...context, effectFootprint: 'local' }, 'full_delegation');
    assert.equal(result.kind, 'authorized');
    if (result.kind !== 'authorized') return;
    result.execution.consume();
    const child = { pid: 4242, bootId: 'boot-id', startTicks: '777' };
    assert.throws(() => result.execution.attachChildIdentity(child), /CHILD_IDENTITY_NOT_RECORDABLE/);
    result.execution.markStarted();
    result.execution.attachChildIdentity(child);
    assert.deepEqual(database.prepare(`SELECT effect_child_pid AS pid,
      effect_child_boot_id AS bootId, effect_child_start_ticks AS startTicks
      FROM permission_admission_leases WHERE lease_id = ?`)
      .get(result.execution.leaseId), child);
    assert.throws(() => result.execution.attachChildIdentity(child), /CHILD_IDENTITY_NOT_RECORDABLE/);
  } finally { database.close(); }
});

test('shadow records a missing candidate without changing the legacy launch outcome', () => {
  const database = setup();
  try {
    database.exec(`INSERT INTO permission_rollout_transitions (
      transition_id, from_profile, to_profile, from_generation, to_generation,
      manifest_digest, contract_version, profile_digest, capability_digest,
      state, revision, created_at_ms, updated_at_ms, terminal_at_ms
    ) VALUES ('shadow', 'legacy', 'shadow', 1, 2, 'digest', 'permission-parity/v1',
      '${TEST_PROFILE_DIGEST}', '${capabilitySeal(2)}', 'applied', 3, 1, 2, 2)`);
    const result = gateway(database, 2, { value: 100 }).authorize(actor, context, 'full_delegation');
    assert.equal(result.kind, 'authorized');
    const row = database.prepare(
      'SELECT reason_codes_json AS reasons FROM permission_launch_decisions',
    ).get() as { reasons: string };
    const reasons = JSON.parse(row.reasons) as string[];
    assert.ok(reasons.includes('MALFORMED_CANDIDATE'));
  } finally {
    database.close();
  }
});

test('enforce denies a missing candidate and creates no lease', () => {
  const database = setup();
  try {
    database.exec(`INSERT INTO permission_rollout_transitions (
      transition_id, from_profile, to_profile, from_generation, to_generation,
      manifest_digest, contract_version, profile_digest, capability_digest,
      state, revision, created_at_ms, updated_at_ms, terminal_at_ms
    ) VALUES ('enforce', 'legacy', 'enforce', 1, 2, 'digest', 'permission-parity/v1',
      '${TEST_PROFILE_DIGEST}', '${capabilitySeal(2)}', 'applied', 3, 1, 2, 2)`);
    const result = gateway(database, 2, { value: 100 }).authorize(actor, context, 'full_delegation');
    assert.equal(result.kind, 'denied');
    assert.equal((database.prepare('SELECT COUNT(*) AS count FROM permission_admission_leases')
      .get() as { count: number }).count, 0);
    assert.deepEqual(database.prepare(
      'SELECT verdict, state FROM permission_launch_decisions',
    ).get(), { verdict: 'denied', state: 'not_started' });
  } finally {
    database.close();
  }
});

test('enforce authorizes a measured Codex candidate and exposes the sealed effective policy', () => {
  const database = setup();
  try {
    database.exec(`INSERT INTO permission_rollout_transitions (
      transition_id, from_profile, to_profile, from_generation, to_generation,
      manifest_digest, contract_version, profile_digest, capability_digest,
      state, revision, created_at_ms, updated_at_ms, terminal_at_ms
    ) VALUES ('enforce-ok', 'legacy', 'enforce', 1, 2, 'digest', 'permission-parity/v1',
      '${TEST_PROFILE_DIGEST}', '${capabilitySeal(2)}', 'applied', 3, 1, 2, 2)`);
    const candidateFor = (launchContext: CanonicalLaunchContext) => resolveMeasuredPermissionCandidate(
      launchContext,
      artifact.candidates.find(candidate => candidate.body === 'codex')!.evidence.measuredAt,
      { buildFingerprint: artifact.candidates.find(candidate => candidate.body === 'codex')!.evidence.measuredBuildFingerprint },
    );
    const driftedCandidateFor = (launchContext: CanonicalLaunchContext) => resolveMeasuredPermissionCandidate(
      launchContext, artifact.candidates.find(candidate => candidate.body === 'codex')!.evidence.measuredAt,
      { buildFingerprint: `sha256:${'f'.repeat(64)}` },
    );
    let useDrifted = true;
    const testedGateway = gateway(database, 2, { value: 100 }, launchContext =>
      useDrifted ? driftedCandidateFor(launchContext) : candidateFor(launchContext));
    const denied = testedGateway.authorize(actor, context, 'full_delegation');
    assert.equal(denied.kind, 'denied');
    if (denied.kind === 'denied') assert.ok(denied.reasonCodes.includes('BINARY_DRIFT'));
    assert.equal((database.prepare('SELECT COUNT(*) AS count FROM permission_admission_leases').get() as { count: number }).count, 0);
    useDrifted = false;
    const result = testedGateway.authorize(actor, context, 'full_delegation');
    assert.equal(result.kind, 'authorized');
    if (result.kind !== 'authorized') return;
    assert.equal(result.execution.mode, 'enforce');
    assert.equal(result.execution.effectivePolicy?.profileId, 'full_delegation');
    result.execution.consume();
    result.execution.markStarted();
    result.execution.settle('succeeded');
  } finally {
    database.close();
  }
});

test('T-1872: one acquired launch identity flows to the candidate and the execution handle', () => {
  const database = setup();
  try {
    const identity = Object.freeze({ executablePath: '/machine/releases/0.156.0/bin/codex' });
    let acquisitions = 0;
    const seen: unknown[] = [];
    let sequence = 0;
    const build = (acquire: () => Readonly<Record<string, unknown>> | null) => createExecutionPermissionGateway({
      database, authority: authority(1), reference: CLAUDE_REFERENCE_VECTOR_V1,
      candidateFor: (_context, launchIdentity) => { seen.push(launchIdentity); return null; },
      acquireLaunchIdentity: acquire,
      capabilityArtifactDigest: PERMISSION_CAPABILITY_ARTIFACT_DIGEST, releaseBuild: TEST_RELEASE_BUILD,
      manifestDigest: null,
      processIdentity: { ownerId: 'process:1', ownerPid: 10, ownerBootId: 'boot', ownerStartTicks: '100' },
      randomId: () => `identity-${++sequence}`, nowMs: () => 100, isDevicePrincipalCurrent: () => true,
    });
    const result = build(() => { acquisitions += 1; return identity; })
      .authorize(actor, { ...context, launchId: 'identity-launch' }, 'full_delegation');
    assert.equal(result.kind, 'authorized');
    if (result.kind !== 'authorized') return;
    assert.equal(acquisitions, 1);
    assert.equal(seen[0], identity);
    assert.equal(result.execution.launchIdentity, identity);
    assert.equal(result.execution.launchIdentityError, null);
    // An unresolvable harness yields no identity (and so no candidate), never a throw;
    // the cause rides on the handle (qa M1) so the launch refuses instead of re-acquiring.
    const cause = Object.assign(new Error('CODEX_MACHINE_CLI_MISSING'), { code: 'CODEX_MACHINE_CLI_MISSING' });
    const missing = build(() => { throw cause; })
      .authorize(actor, { ...context, launchId: 'missing-launch' }, 'full_delegation');
    assert.equal(missing.kind, 'authorized');
    if (missing.kind === 'authorized') {
      assert.equal(missing.execution.launchIdentity, null);
      assert.equal(missing.execution.launchIdentityError, cause);
    }
    assert.equal(seen[1], null);
    const opaque = build(() => { throw 'not an error'; })
      .authorize(actor, { ...context, launchId: 'opaque-launch' }, 'full_delegation');
    if (opaque.kind === 'authorized') assert.match(String(opaque.execution.launchIdentityError), /not an error/u);
  } finally {
    database.close();
  }
});
