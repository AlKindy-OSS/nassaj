import assert from 'node:assert/strict';
import test from 'node:test';

import Database from 'better-sqlite3';

import { classifyAdmissionFailure } from '@/modules/execution-permissions/index.js';

import { migratePermissionExecution } from '../permission-execution.migration.js';

import {
  blockPermissionGeneration,
  claimPermissionLease,
  createPermissionAdmission,
  digestPermissionWorkspace,
  PermissionStateConflictError,
  reconcileExpiredPermissionExecutions,
} from './permission-execution.js';

// B-1076: the refusing scope travels on the thrown error so the client can explain it.

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

const input = (id: string, nowMs: number, sessionId: string | undefined) => ({
  decisionId: id,
  leaseId: `lease-${id}`,
  userId: 1,
  principalId: 'user:1',
  authenticationKind: 'session' as const,
  authorizationGeneration: 1,
  launchId: `launch-${id}`,
  sessionId,
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
  effectIdentity: `permission-effect:${id}`,
  expiresAtMs: nowMs + 10,
  nowMs,
});

/** Admits, claims, and lets restart reconciliation fence one interrupted turn. */
const interruptTurn = (database: Database.Database, sessionId: string | undefined): void => {
  createPermissionAdmission(database, input('interrupted', 10, sessionId));
  claimPermissionLease(database, 'lease-interrupted', 1, 15);
  reconcileExpiredPermissionExecutions(database, 30, () => false);
};

const refusal = (run: () => void): PermissionStateConflictError => {
  try {
    run();
  } catch (error) {
    assert.ok(error instanceof PermissionStateConflictError);
    return error;
  }
  assert.fail('admission was expected to be refused');
};

test('B-1076: a fenced session reports scopeKind session without leaking the scope key', () => {
  const database = setup();
  try {
    interruptTurn(database, 'session-1');
    const error = refusal(() => createPermissionAdmission(database, input('next', 40, 'session-1')));
    assert.equal(error.code, 'EFFECT_SCOPE_FENCED');
    assert.deepEqual(error.fence, { scopeKind: 'session', reasonCode: 'RECONCILED_EFFECT_UNKNOWN' });
    const classified = classifyAdmissionFailure(error);
    assert.deepEqual(classified, {
      code: 'effect_scope_fenced', retryable: false, httpStatus: 409,
      fence: { scopeKind: 'session', reasonCode: 'RECONCILED_EFFECT_UNKNOWN' },
    });
    assert.doesNotMatch(JSON.stringify(classified), /session-1|decision|interrupted/);
  } finally {
    database.close();
  }
});

test('B-1076: a first-turn decision without a sessionId fences user_provider_purpose', () => {
  const database = setup();
  try {
    interruptTurn(database, undefined);
    for (const sessionId of [undefined, 'session-brand-new']) {
      const error = refusal(() => createPermissionAdmission(
        database, input(`next-${sessionId ?? 'none'}`, 40, sessionId),
      ));
      assert.equal(error.code, 'EFFECT_SCOPE_FENCED');
      assert.deepEqual(error.fence, {
        scopeKind: 'user_provider_purpose', reasonCode: 'RECONCILED_EFFECT_UNKNOWN',
      });
      const classified = classifyAdmissionFailure(error);
      assert.equal(classified.fence?.scopeKind, 'user_provider_purpose');
      assert.doesNotMatch(JSON.stringify(classified), /1:codex:sdk_turn/);
    }
  } finally {
    database.close();
  }
});

test('B-1076: a blocked generation reports scopeKind generation and its reason', () => {
  const database = setup();
  try {
    blockPermissionGeneration(database, {
      protocolGeneration: 1, reasonCode: 'START_EVIDENCE_WRITE_FAILED', nowMs: 5,
    });
    const error = refusal(() => createPermissionAdmission(database, input('next', 40, 'session-1')));
    assert.equal(error.code, 'GENERATION_BLOCKED');
    assert.deepEqual(classifyAdmissionFailure(error), {
      code: 'generation_blocked', retryable: false, httpStatus: 409,
      fence: { scopeKind: 'generation', reasonCode: 'START_EVIDENCE_WRITE_FAILED' },
    });
  } finally {
    database.close();
  }
});
