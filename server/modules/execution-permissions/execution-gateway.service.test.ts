import assert from 'node:assert/strict';
import test from 'node:test';

import Database from 'better-sqlite3';

import { migratePermissionExecution, PermissionStateConflictError } from '@/modules/database/index.js';

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
