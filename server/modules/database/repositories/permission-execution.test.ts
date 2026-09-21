import assert from 'node:assert/strict';
import test from 'node:test';

import Database from 'better-sqlite3';

import { migratePermissionExecution } from '../permission-execution.migration.js';

import {
  beginPermissionTransitionClosing,
  blockPermissionGeneration,
  claimPermissionLease,
  countPermissionGenerationBlocks,
  createPermissionAdmission,
  listPermissionEffectFences,
  digestPermissionWorkspace,
  finishPermissionTransition,
  markPermissionEffectStarted,
  PermissionStateConflictError,
  preparePermissionTransition,
  reconcileExpiredPermissionExecutions,
  readPermissionRolloutState,
  settlePermissionEffect,
  settlePermissionNotStarted,
} from './permission-execution.js';

const setup = (verbose?: (sql: string) => void): Database.Database => {
  const database = new Database(':memory:', { verbose });
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

const input = (nowMs = 10) => ({
  decisionId: 'decision-1',
  leaseId: 'lease-1',
  userId: 1,
  principalId: 'user:1',
  authenticationKind: 'session' as const,
  authorizationGeneration: 1,
  launchId: 'launch-1',
  sessionId: 'session-1',
  projectId: 'project-1',
  workspaceDigest: digestPermissionWorkspace('/workspace/project'),
  provider: 'codex',
  body: 'codex',
  engine: 'sdk',
  entrypoint: 'ws.chat',
  purpose: 'sdk_turn' as const,
  requestedProfile: 'full_delegation',
  contractVersion: 'permission-parity/v1',
  profileDigest: 'profile-digest',
  capabilityDigest: 'capability-digest',
  releaseBuild: 'development-unsealed',
  protocolGeneration: 1,
  ownerId: 'process:1',
  ownerPid: 123,
  ownerBootId: 'boot-id',
  ownerStartTicks: '100',
  effectIdentity: 'permission-effect:decision-1',
  expiresAtMs: nowMs + 1_000,
  nowMs,
});

test('admission, claim, start, and settle form one CAS-protected lifecycle', () => {
  const database = setup();
  try {
    createPermissionAdmission(database, input());
    const leaseRevision = claimPermissionLease(database, 'lease-1', 1, 20);
    assert.equal(leaseRevision, 2);
    assert.throws(
      () => claimPermissionLease(database, 'lease-1', 1, 21),
      (error: unknown) => error instanceof PermissionStateConflictError
        && error.code === 'LEASE_NOT_CLAIMABLE',
    );
    const decisionAfterClaim = database.prepare(
      'SELECT revision FROM permission_launch_decisions WHERE decision_id = ?',
    ).get('decision-1') as { revision: number };
    const startedRevision = markPermissionEffectStarted(
      database,
      'decision-1',
      decisionAfterClaim.revision,
      30,
    );
    settlePermissionEffect(database, 'decision-1', 'succeeded', startedRevision, 40);
    const row = database.prepare(`SELECT decision.state, decision.terminal_outcome AS outcome,
      lease.status AS lease_status
      FROM permission_launch_decisions decision
      JOIN permission_admission_leases lease ON lease.decision_id = decision.decision_id
      WHERE decision.decision_id = ?`).get('decision-1') as {
        state: string; outcome: string; lease_status: string;
      };
    assert.deepEqual(row, { state: 'terminal', outcome: 'succeeded', lease_status: 'terminal' });
    assert.throws(
      () => settlePermissionEffect(database, 'decision-1', 'failed', startedRevision, 41),
      /DECISION_NOT_SETTLEABLE/,
    );
    const terminal = database.prepare(`SELECT decision.terminal_outcome AS outcome,
      decision.revision AS decision_revision, lease.status AS lease_status,
      lease.revision AS lease_revision
      FROM permission_launch_decisions decision
      JOIN permission_admission_leases lease ON lease.decision_id = decision.decision_id
      WHERE decision.decision_id = ?`).get('decision-1') as {
        outcome: string;
        decision_revision: number;
        lease_status: string;
        lease_revision: number;
      };
    assert.deepEqual(terminal, {
      outcome: 'succeeded',
      decision_revision: startedRevision + 1,
      lease_status: 'terminal',
      lease_revision: 3,
    });
  } finally {
    database.close();
  }
});

test('T-1593: an in-process unknown settlement fences its session scope, not the generation', () => {
  const database = setup();
  try {
    createPermissionAdmission(database, input());
    claimPermissionLease(database, 'lease-1', 1, 20);
    const claimed = database.prepare(
      'SELECT revision FROM permission_launch_decisions WHERE decision_id = ?',
    ).get('decision-1') as { revision: number };
    settlePermissionEffect(database, 'decision-1', 'reconciled_unknown', claimed.revision, 30);

    assert.equal(countPermissionGenerationBlocks(database), 0);
    assert.deepEqual(listPermissionEffectFences(database).map(({ scopeKind, scopeKey, reasonCode, decisionId }) =>
      ({ scopeKind, scopeKey, reasonCode, decisionId })), [{
      scopeKind: 'session', scopeKey: 'session-1', reasonCode: 'RECONCILED_EFFECT_UNKNOWN', decisionId: 'decision-1',
    }]);
    assert.throws(
      () => createPermissionAdmission(database, {
        ...input(40),
        decisionId: 'decision-2',
        leaseId: 'lease-2',
        launchId: 'launch-2',
        effectIdentity: 'permission-effect:decision-2',
      }),
      (error: unknown) => error instanceof PermissionStateConflictError
        && error.code === 'EFFECT_SCOPE_FENCED',
    );
    // Another session of the same user is untouched: the node keeps working.
    createPermissionAdmission(database, {
      ...input(40), decisionId: 'decision-3', leaseId: 'lease-3', launchId: 'launch-3',
      sessionId: 'session-other', effectIdentity: 'permission-effect:decision-3',
    });
  } finally {
    database.close();
  }
});

test('expired lease is not claimable at the exact expiry boundary', () => {
  const database = setup();
  try {
    createPermissionAdmission(database, { ...input(), expiresAtMs: 20 });

    assert.throws(
      () => claimPermissionLease(database, 'lease-1', 1, 20),
      (error: unknown) => error instanceof PermissionStateConflictError
        && error.code === 'LEASE_NOT_CLAIMABLE',
    );

    const row = database.prepare(`SELECT decision.state, decision.revision AS decision_revision,
      lease.status AS lease_status, lease.revision AS lease_revision,
      lease.claimed_at_ms
      FROM permission_launch_decisions decision
      JOIN permission_admission_leases lease ON lease.decision_id = decision.decision_id
      WHERE decision.decision_id = ?`).get('decision-1') as {
        state: string;
        decision_revision: number;
        lease_status: string;
        lease_revision: number;
        claimed_at_ms: number | null;
      };
    assert.deepEqual(row, {
      state: 'authorized',
      decision_revision: 1,
      lease_status: 'issued',
      lease_revision: 1,
      claimed_at_ms: null,
    });
  } finally {
    database.close();
  }
});

test('not-started closes an issued lease without falsely claiming a provider spawn', () => {
  const database = setup();
  try {
    createPermissionAdmission(database, input());
    settlePermissionNotStarted(database, 'decision-1', 20);
    assert.deepEqual(database.prepare(`SELECT decision.state,
      decision.terminal_outcome AS outcome, lease.status AS lease_status,
      lease.claimed_at_ms AS claimed_at
      FROM permission_launch_decisions decision
      JOIN permission_admission_leases lease ON lease.decision_id = decision.decision_id`).get(), {
      state: 'terminal', outcome: 'not_started', lease_status: 'revoked', claimed_at: null,
    });
  } finally {
    database.close();
  }
});

test('durable generation block fences both new admission and issued permits', () => {
  const database = setup();
  try {
    createPermissionAdmission(database, input());
    blockPermissionGeneration(database, {
      protocolGeneration: 1, reasonCode: 'AMBIGUOUS_EFFECT', nowMs: 15,
    });
    assert.throws(() => claimPermissionLease(database, 'lease-1', 1, 20), /LEASE_NOT_CLAIMABLE/);
    assert.throws(() => createPermissionAdmission(database, {
      ...input(), decisionId: 'decision-2', leaseId: 'lease-2',
      effectIdentity: 'permission-effect:decision-2',
    }), /GENERATION_BLOCKED/);
  } finally {
    database.close();
  }
});

test('lease remains claimable immediately before expiry', () => {
  const database = setup();
  try {
    createPermissionAdmission(database, { ...input(), expiresAtMs: 20 });

    assert.equal(claimPermissionLease(database, 'lease-1', 1, 19), 2);
  } finally {
    database.close();
  }
});

test('stale decision revision loses CAS without advancing lifecycle state', () => {
  const database = setup();
  try {
    createPermissionAdmission(database, input());
    claimPermissionLease(database, 'lease-1', 1, 20);

    assert.throws(
      () => markPermissionEffectStarted(database, 'decision-1', 1, 30),
      (error: unknown) => error instanceof PermissionStateConflictError
        && error.code === 'DECISION_NOT_STARTABLE',
    );

    const decision = database.prepare(`SELECT state, terminal_outcome, revision
      FROM permission_launch_decisions WHERE decision_id = ?`).get('decision-1');
    assert.deepEqual(decision, {
      state: 'effect_claimed',
      terminal_outcome: null,
      revision: 2,
    });
  } finally {
    database.close();
  }
});

test('duplicate admission replay leaves the original decision and lease unchanged', () => {
  const database = setup();
  try {
    createPermissionAdmission(database, input());

    assert.throws(
      () => createPermissionAdmission(database, input()),
      /UNIQUE constraint failed: permission_launch_decisions.decision_id/,
    );
    assert.throws(
      () => createPermissionAdmission(database, {
        ...input(),
        decisionId: 'decision-2',
        effectIdentity: 'permission-effect:decision-2',
      }),
      /UNIQUE constraint failed: permission_admission_leases.lease_id/,
    );

    const decisions = database.prepare(`SELECT decision_id, revision, state
      FROM permission_launch_decisions ORDER BY decision_id`).all();
    const leases = database.prepare(`SELECT lease_id, decision_id, revision, status
      FROM permission_admission_leases ORDER BY lease_id`).all();
    assert.deepEqual(decisions, [{ decision_id: 'decision-1', revision: 1, state: 'authorized' }]);
    assert.deepEqual(leases, [{
      lease_id: 'lease-1',
      decision_id: 'decision-1',
      revision: 1,
      status: 'issued',
    }]);
  } finally {
    database.close();
  }
});

test('settlement transaction rolls back the decision when its active lease cannot close', () => {
  const database = setup();
  try {
    createPermissionAdmission(database, input());
    claimPermissionLease(database, 'lease-1', 1, 20);
    const claimed = database.prepare(
      'SELECT revision FROM permission_launch_decisions WHERE decision_id = ?',
    ).get('decision-1') as { revision: number };
    database.prepare(`UPDATE permission_admission_leases
      SET status = 'revoked', terminal_at_ms = ?, revision = revision + 1
      WHERE lease_id = ?`).run(21, 'lease-1');

    assert.throws(
      () => settlePermissionEffect(database, 'decision-1', 'succeeded', claimed.revision, 30),
      (error: unknown) => error instanceof PermissionStateConflictError
        && error.code === 'LEASE_NOT_SETTLEABLE',
    );

    const decision = database.prepare(`SELECT state, terminal_outcome, revision
      FROM permission_launch_decisions WHERE decision_id = ?`).get('decision-1');
    assert.deepEqual(decision, {
      state: 'effect_claimed',
      terminal_outcome: null,
      revision: claimed.revision,
    });
  } finally {
    database.close();
  }
});

test('actor revocation after claim does not overwrite the truthful terminal outcome', () => {
  const database = setup();
  try {
    createPermissionAdmission(database, input());
    claimPermissionLease(database, 'lease-1', 1, 20);
    database.prepare('UPDATE users SET is_active = ? WHERE id = ?').run(0, 1);
    const claimed = database.prepare(
      'SELECT revision FROM permission_launch_decisions WHERE decision_id = ?',
    ).get('decision-1') as { revision: number };

    const startedRevision = markPermissionEffectStarted(
      database,
      'decision-1',
      claimed.revision,
      30,
    );
    settlePermissionEffect(database, 'decision-1', 'succeeded', startedRevision, 40);

    const row = database.prepare(`SELECT state, terminal_outcome
      FROM permission_launch_decisions WHERE decision_id = ?`).get('decision-1');
    assert.deepEqual(row, { state: 'terminal', terminal_outcome: 'succeeded' });
  } finally {
    database.close();
  }
});

test('actor revocation and generation transition both deny before effect', () => {
  const database = setup();
  try {
    createPermissionAdmission(database, input());
    database.prepare('UPDATE users SET status = ? WHERE id = ?').run('disabled', 1);
    assert.throws(
      () => claimPermissionLease(database, 'lease-1', 1, 20),
      /LEASE_NOT_CLAIMABLE/,
    );

    database.prepare('UPDATE users SET status = ? WHERE id = ?').run('active', 1);
    const generation = database.prepare(
      'SELECT authorization_generation AS value FROM users WHERE id = ?',
    ).get(1) as { value: number };
    assert.throws(
      () => createPermissionAdmission(database, {
        ...input(), decisionId: 'decision-stale', leaseId: 'lease-stale',
      }),
      /ACTOR_REVOKED_OR_STALE/,
    );
    createPermissionAdmission(database, {
      ...input(), decisionId: 'decision-2', leaseId: 'lease-2',
      effectIdentity: 'permission-effect:decision-2',
      authorizationGeneration: generation.value,
    });
    database.prepare(`INSERT INTO permission_rollout_transitions (
      transition_id, from_profile, to_profile, from_generation, to_generation,
      manifest_digest, contract_version, profile_digest, capability_digest,
      state, created_at_ms, updated_at_ms
    ) VALUES ('transition-1', 'legacy', 'shadow', 1, 2, 'digest',
      'permission-parity/v1', 'profile-digest', 'capability-digest', 'closing', 15, 15)`)
      .run();
    assert.throws(
      () => claimPermissionLease(database, 'lease-2', 1, 20),
      /LEASE_NOT_CLAIMABLE/,
    );
  } finally {
    database.close();
  }
});

test('rollout transition fences admission and applies only after old leases drain', () => {
  const database = setup();
  try {
    assert.deepEqual(readPermissionRolloutState(database), {
      profile: 'legacy', generation: 1, manifestDigest: null,
      contractVersion: null, profileDigest: null, capabilityDigest: null,
    });
    createPermissionAdmission(database, input());
    preparePermissionTransition(database, {
      transitionId: 'transition-1', fromProfile: 'legacy', toProfile: 'shadow',
      fromGeneration: 1, toGeneration: 2, manifestDigest: 'manifest-digest', nowMs: 20,
      contractVersion: 'permission-parity/v1', profileDigest: 'profile-digest',
      capabilityDigest: 'capability-digest',
    });
    const closingRevision = beginPermissionTransitionClosing(database, 'transition-1', 1, 21);
    assert.throws(
      () => finishPermissionTransition(database, 'transition-1', 'applied', closingRevision, 22),
      /GENERATION_NOT_DRAINED/,
    );
    database.prepare(`UPDATE permission_admission_leases
      SET status = 'revoked', terminal_at_ms = ?, revision = revision + 1, updated_at_ms = ?
      WHERE lease_id = ? AND status = 'issued'`).run(23, 23, 'lease-1');
    finishPermissionTransition(database, 'transition-1', 'applied', closingRevision, 24);
    assert.deepEqual(readPermissionRolloutState(database), {
      profile: 'shadow', generation: 2, manifestDigest: 'manifest-digest',
      contractVersion: 'permission-parity/v1', profileDigest: 'profile-digest',
      capabilityDigest: 'capability-digest',
    });
    assert.throws(
      () => finishPermissionTransition(database, 'transition-1', 'rolled_back', closingRevision, 25),
      /TRANSITION_NOT_FINISHABLE/,
    );
  } finally {
    database.close();
  }
});

test('boot reconciliation distinguishes never-claimed, dead-owner, and live-owner leases', () => {
  const database = setup();
  try {
    createPermissionAdmission(database, { ...input(), expiresAtMs: 20 });
    createPermissionAdmission(database, {
      ...input(), decisionId: 'decision-2', leaseId: 'lease-2', expiresAtMs: 20,
      effectIdentity: 'permission-effect:decision-2',
    });
    createPermissionAdmission(database, {
      ...input(), decisionId: 'decision-3', leaseId: 'lease-3', expiresAtMs: 20,
      effectIdentity: 'permission-effect:decision-3',
    });
    claimPermissionLease(database, 'lease-2', 1, 19);
    claimPermissionLease(database, 'lease-3', 1, 19);
    const summary = reconcileExpiredPermissionExecutions(
      database,
      20,
      owner => owner.pid === 123 && owner.startTicks === '100' && owner.bootId === 'boot-id',
    );
    assert.deepEqual(summary, { notStarted: 1, unknownLocal: 0, unknownExternal: 0, unknown: 0, stillActive: 2, blocked: 0, orphans: [] });
    const second = reconcileExpiredPermissionExecutions(database, 21, () => false);
    assert.deepEqual(second, { notStarted: 0, unknownLocal: 0, unknownExternal: 2, unknown: 2, stillActive: 0, blocked: 0, orphans: [] });
    // Both unknowns share one session, so one scoped fence; the generation stays open.
    assert.equal(listPermissionEffectFences(database).length, 1);
    assert.deepEqual(database.prepare(`SELECT terminal_outcome AS outcome FROM
      permission_launch_decisions ORDER BY decision_id`).all(), [
      { outcome: 'not_started' },
      { outcome: 'reconciled_unknown' },
      { outcome: 'reconciled_unknown' },
    ]);
    assert.equal((database.prepare(
      'SELECT COUNT(*) AS count FROM permission_reconciliation_items',
    ).get() as { count: number }).count, 3);
  } finally {
    database.close();
  }
});

const summaryOf = (partial: Partial<ReturnType<typeof reconcileExpiredPermissionExecutions>>) => ({
  notStarted: 0, unknownLocal: 0, unknownExternal: 0, unknown: 0, stillActive: 0, blocked: 0, orphans: [], ...partial,
});
const child = { pid: 4242, bootId: 'boot-id', startTicks: '777' };

for (const purpose of ['sdk_turn', 'catalog', 'external_agent_dispatch'] as const) {
  test(`T-1593: a previous-boot external ${purpose} unknown fences only its scope`, () => {
    const database = setup();
    try {
      const sessionId = purpose === 'catalog' ? undefined : 'session-1';
      createPermissionAdmission(database, { ...input(), purpose, sessionId, expiresAtMs: 20 });
      claimPermissionLease(database, 'lease-1', 1, 19);
      assert.deepEqual(reconcileExpiredPermissionExecutions(database, 21, () => false),
        summaryOf({ unknownExternal: 1, unknown: 1 }));
      assert.deepEqual(reconcileExpiredPermissionExecutions(database, 30, () => false), summaryOf({}));
      assert.equal(countPermissionGenerationBlocks(database), 0);
      const [fence] = listPermissionEffectFences(database);
      assert.deepEqual({ scopeKind: fence.scopeKind, scopeKey: fence.scopeKey }, sessionId
        ? { scopeKind: 'session', scopeKey: 'session-1' }
        : { scopeKind: 'user_provider_purpose', scopeKey: `1:codex:${purpose}` });
      assert.throws(() => createPermissionAdmission(database, {
        ...input(40), decisionId: 'next', leaseId: 'next', purpose, sessionId, effectIdentity: 'next',
      }), /EFFECT_SCOPE_FENCED/);
      // A different scope of the same user passes: other session, or other purpose.
      createPermissionAdmission(database, {
        ...input(40), decisionId: 'free', leaseId: 'free', effectIdentity: 'free',
        purpose: sessionId ? purpose : 'quota', sessionId: sessionId ? 'session-2' : undefined,
      });
    } finally { database.close(); }
  });
}

test('T-1593: a local effect whose child is proven dead reconciles without any fence', () => {
  const database = setup();
  try {
    createPermissionAdmission(database, { ...input(), purpose: 'spawn', effectFootprint: 'local', expiresAtMs: 20 });
    claimPermissionLease(database, 'lease-1', 1, 19);
    markPermissionEffectStarted(database, 'decision-1', 2, 19, child);
    assert.deepEqual(database.prepare(`SELECT effect_child_pid AS pid, effect_child_boot_id AS bootId,
      effect_child_start_ticks AS startTicks FROM permission_admission_leases`).get(), child);
    const summary = reconcileExpiredPermissionExecutions(database, 21, () => false, () => false);
    assert.deepEqual(summary, summaryOf({ unknownLocal: 1, unknown: 1 }));
    assert.equal(countPermissionGenerationBlocks(database), 0);
    assert.deepEqual(listPermissionEffectFences(database), []);
    assert.equal(database.prepare('SELECT terminal_outcome FROM permission_launch_decisions').pluck().get(), 'reconciled_unknown');
    createPermissionAdmission(database, { ...input(40), decisionId: 'next', leaseId: 'next', effectIdentity: 'next' });
  } finally { database.close(); }
});

test('T-1593: a local effect whose child survives its owner is fenced as external and reported as an orphan', () => {
  const database = setup();
  try {
    createPermissionAdmission(database, { ...input(), purpose: 'spawn', effectFootprint: 'local', expiresAtMs: 20 });
    claimPermissionLease(database, 'lease-1', 1, 19);
    markPermissionEffectStarted(database, 'decision-1', 2, 19, child);
    // Same boot id and matching start ticks: pm2 restarted the server, the child lives on.
    const alive = (identity: { pid: number; bootId: string; startTicks: string }) =>
      identity.pid === child.pid && identity.bootId === 'boot-id' && identity.startTicks === '777';
    const summary = reconcileExpiredPermissionExecutions(database, 21, () => false, alive);
    assert.deepEqual(summary, summaryOf({ unknownExternal: 1, unknown: 1, orphans: [4242] }));
    assert.equal(listPermissionEffectFences(database)[0]?.scopeKey, 'session-1');
    assert.throws(() => claimPermissionLease(database, 'lease-1', 1, 22), PermissionStateConflictError);
  } finally { database.close(); }
});

test('T-1593: a local effect without a recorded child identity, or after a kernel reboot, is decided by evidence', () => {
  const missing = setup();
  try {
    createPermissionAdmission(missing, { ...input(), purpose: 'spawn', effectFootprint: 'local', expiresAtMs: 20 });
    claimPermissionLease(missing, 'lease-1', 1, 19);
    // Broker starts without child proof: wrapper death cannot prove the CLI died.
    markPermissionEffectStarted(missing, 'decision-1', 2, 19);
    assert.deepEqual(reconcileExpiredPermissionExecutions(missing, 21, () => false, () => false),
      summaryOf({ unknownExternal: 1, unknown: 1 }));
    assert.equal(listPermissionEffectFences(missing).length, 1);
  } finally { missing.close(); }
  const rebooted = setup();
  try {
    createPermissionAdmission(rebooted, { ...input(), purpose: 'spawn', effectFootprint: 'local', expiresAtMs: 20 });
    claimPermissionLease(rebooted, 'lease-1', 1, 19);
    markPermissionEffectStarted(rebooted, 'decision-1', 2, 19, child);
    const afterReboot = (identity: { bootId: string }) => identity.bootId === 'boot-id-after-reboot';
    assert.deepEqual(reconcileExpiredPermissionExecutions(rebooted, 21, afterReboot, afterReboot),
      summaryOf({ unknownLocal: 1, unknown: 1 }));
    assert.deepEqual(listPermissionEffectFences(rebooted), []);
  } finally { rebooted.close(); }
});

test('T-1593: two external unknowns on different sessions fence independently and hide nothing', () => {
  const database = setup();
  try {
    for (let index = 1; index <= 3; index += 1) {
      createPermissionAdmission(database, { ...input(), decisionId: `d${index}`, sessionId: `s${index}`,
        leaseId: `l${index}`, effectIdentity: `e${index}`, expiresAtMs: index === 3 ? 1000 : 20 });
      if (index < 3) claimPermissionLease(database, `l${index}`, 1, 19);
    }
    assert.deepEqual(reconcileExpiredPermissionExecutions(database, 21, () => false),
      summaryOf({ unknownExternal: 2, unknown: 2 }));
    assert.deepEqual(listPermissionEffectFences(database).map(f => f.scopeKey), ['s1', 's2']);
    assert.equal(database.prepare("SELECT status FROM permission_admission_leases WHERE lease_id = 'l3'").pluck().get(), 'issued');
    assert.equal(countPermissionGenerationBlocks(database), 0);
    claimPermissionLease(database, 'l3', 1, 22);
  } finally { database.close(); }
});

test('T-1593: migration is idempotent and pre-existing leases read as external', () => {
  const database = setup();
  try {
    createPermissionAdmission(database, input());
    // Recreate the actual pre-T1593 lease shape around an existing row.
    for (const column of ['effect_footprint', 'effect_child_pid', 'effect_child_boot_id', 'effect_child_start_ticks']) {
      database.exec(`ALTER TABLE permission_admission_leases DROP COLUMN ${column}`);
    }
    database.exec('DROP TABLE permission_effect_fences');
    blockPermissionGeneration(database, { protocolGeneration: 1, reasonCode: 'START_EVIDENCE_WRITE_FAILED', nowMs: 30 });
    migratePermissionExecution(database);
    assert.equal(database.prepare('SELECT lease_id FROM permission_admission_leases').pluck().get(), 'lease-1');
    assert.equal(database.prepare('SELECT effect_footprint FROM permission_admission_leases').pluck().get(), 'external');
    blockPermissionGeneration(database, { protocolGeneration: 1, reasonCode: 'START_EVIDENCE_WRITE_FAILED', nowMs: 30 });
    migratePermissionExecution(database);
    assert.equal(countPermissionGenerationBlocks(database), 1);
  } finally { database.close(); }
});

test('startup reconciliation finite SQL trace changes only its decision, lease, reconciliation and scoped fences', () => {
  const trace: string[] = [];
  const database = setup(sql => trace.push(sql));
  const rowsByTable = () => Object.fromEntries((database.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
    .all() as { name: string }[]).map(({ name }) => [name, JSON.stringify(database.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}"`).all())]));
  try {
    createPermissionAdmission(database, { ...input(), expiresAtMs: 20 });
    createPermissionAdmission(database, { ...input(), decisionId: 'active', leaseId: 'active-lease',
      effectIdentity: 'active-effect', expiresAtMs: 20 });
    claimPermissionLease(database, 'active-lease', 1, 19);
    const before = rowsByTable(); trace.length = 0;
    const result = reconcileExpiredPermissionExecutions(database, 21, () => false);
    const statements = [...trace]; const after = rowsByTable();
    assert.equal(result.notStarted, 1); assert.equal(result.unknownExternal, 1);
    assert.deepEqual(Object.keys(before).filter(name => before[name] !== after[name]).sort(), [
      'permission_admission_leases', 'permission_effect_fences', 'permission_launch_decisions', 'permission_reconciliation_items',
    ]);
    assert.equal(statements.some(sql => /^\s*(CREATE|ALTER|DROP|DELETE|PRAGMA|ATTACH|DETACH|VACUUM)/i.test(sql)), false);
    assert.deepEqual(reconcileExpiredPermissionExecutions(database, 22, () => false), summaryOf({}));
  } finally { database.close(); }
});

test('T-1593: child evidence failure rolls back decision CAS', () => {
  const database = setup();
  try {
    createPermissionAdmission(database, { ...input(), effectFootprint: 'local' });
    claimPermissionLease(database, 'lease-1', 1, 19);
    assert.throws(() => markPermissionEffectStarted(database, 'decision-1', 2, 19, { ...child, pid: -1 }), /INVALID_CHILD_IDENTITY/);
    assert.equal(database.prepare('SELECT state FROM permission_launch_decisions').pluck().get(), 'effect_claimed');
    markPermissionEffectStarted(database, 'decision-1', 2, 19, child);
    assert.throws(() => markPermissionEffectStarted(database, 'decision-1', 2, 19, { ...child, pid: 99 }), /DECISION_NOT_STARTABLE/);
    assert.equal(database.prepare('SELECT effect_child_pid FROM permission_admission_leases').pluck().get(), child.pid);
  } finally { database.close(); }
});
test('T-1593: delimiter-bearing scope components cannot collide', () => {
  const database = setup();
  try {
    assert.throws(() => createPermissionAdmission(database, { ...input(), provider: 'codex:quota' }), /INVALID_EFFECT_SCOPE/);
    assert.equal(database.prepare('SELECT COUNT(*) FROM permission_launch_decisions').pluck().get(), 0);
  } finally { database.close(); }
});

test('T-1593: mixed footprints cannot clear a scope fence or claim a previously issued lease', () => {
  const database = setup();
  try {
    createPermissionAdmission(database, { ...input(), sessionId: 'mixed', expiresAtMs: 20 });
    createPermissionAdmission(database, { ...input(), decisionId: 'local', leaseId: 'local', launchId: 'local', effectIdentity: 'local', sessionId: 'mixed', effectFootprint: 'local', expiresAtMs: 20 });
    createPermissionAdmission(database, { ...input(), decisionId: 'waiting', leaseId: 'waiting', launchId: 'waiting', effectIdentity: 'waiting', sessionId: 'mixed', expiresAtMs: 100 });
    claimPermissionLease(database, 'lease-1', 1, 19);
    claimPermissionLease(database, 'local', 1, 19);
    markPermissionEffectStarted(database, 'local', 2, 19, child);
    const summary = reconcileExpiredPermissionExecutions(database, 21, () => false);
    assert.equal(summary.unknownLocal, 1);
    assert.equal(summary.unknownExternal, 1);
    assert.equal(listPermissionEffectFences(database).length, 1);
    assert.throws(() => claimPermissionLease(database, 'waiting', 1, 22));
    assert.equal(reconcileExpiredPermissionExecutions(database, 23, () => false).unknown, 0);
    assert.equal(listPermissionEffectFences(database).length, 1);
  } finally { database.close(); }
});
