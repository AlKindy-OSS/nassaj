/**
 * T-1910 S2 (B-1202): a new-chat sdk_turn decision binds to its provider session once, and a
 * crash then fences that session only. Drives the real gateway and repository on SQLite.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import Database from 'better-sqlite3';

import {
  listPermissionEffectFences,
  migratePermissionExecution,
  PermissionStateConflictError,
  reconcileExpiredPermissionExecutions,
} from '@/modules/database/index.js';

import { createAuthenticatedLaunchActor } from './actor.js';
import {
  PERMISSION_CAPABILITY_ARTIFACT_DIGEST,
  computePermissionReleaseCapabilityDigest,
} from './capability-registry.js';
import { createExecutionPermissionGateway, type PermissionExecutionHandle } from './execution-gateway.service.js';
import { CLAUDE_REFERENCE_VECTOR_V1 } from './fixtures/claude-reference-v1.js';
import { liftFence } from './permission-fence.js';

const SESSION_A = '11111111-1111-4111-8111-111111111111';
const SESSION_B = '22222222-2222-4222-8222-222222222222';
const SESSION_C = '33333333-3333-4333-8333-333333333333';
const RELEASE = 'c'.repeat(64);
const PROFILE = `sha256:${'a'.repeat(64)}`;

const setup = (file = ':memory:'): Database.Database => {
  const database = new Database(file);
  database.pragma('foreign_keys = ON');
  database.exec(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY, username TEXT NOT NULL, password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'user', status TEXT NOT NULL DEFAULT 'active',
      is_active INTEGER NOT NULL DEFAULT 1, password_changed_at INTEGER
    );
    CREATE TABLE api_keys (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, key_digest TEXT,
      is_active INTEGER NOT NULL DEFAULT 1);
    CREATE TABLE projects (project_id TEXT PRIMARY KEY, project_path TEXT NOT NULL UNIQUE);
    CREATE TABLE sessions (session_id TEXT PRIMARY KEY, provider TEXT, project_path TEXT);
    CREATE TABLE session_participants (session_id TEXT NOT NULL, user_id INTEGER NOT NULL,
      role TEXT NOT NULL DEFAULT 'participant', PRIMARY KEY (session_id, user_id));
    INSERT INTO users (id, username, password_hash, role) VALUES (1, 'owner', 'hash', 'owner'),
      (2, 'other', 'hash', 'user');
    INSERT INTO projects VALUES ('project-1', '/workspace/project'), ('project-2', '/workspace/other');
  `);
  migratePermissionExecution(database);
  return database;
};

const actorFor = (id: number) => createAuthenticatedLaunchActor({
  id, role: id === 1 ? 'owner' : 'user', status: 'active', is_active: 1,
  authenticationKind: 'session', authorizationGeneration: 1,
}, '2030-01-01T00:00:00.000Z');

const contextFor = (sessionId: string | null, provider = 'claude') => Object.freeze({
  launchId: `launch-${sessionId ?? 'new'}`, principalId: 'user:1', sessionId,
  projectId: 'project-1', workspacePath: '/workspace/project', provider,
  body: provider, engine: 'sdk', entrypoint: 'ws.chat', purpose: 'sdk_turn' as const,
  effectFootprint: 'external' as const,
});

const gatewayFor = (database: Database.Database, now: { value: number }) => {
  let sequence = 0;
  return createExecutionPermissionGateway({
    database,
    authority: Object.freeze({
      source: 'sealed_release_manifest', profileId: 'full_delegation',
      contractVersion: 'permission-parity/v1', profileDigest: PROFILE,
      capabilityDigest: computePermissionReleaseCapabilityDigest(RELEASE, PROFILE, 1),
      protocolGeneration: 1,
    }),
    reference: CLAUDE_REFERENCE_VECTOR_V1,
    candidateFor: () => null,
    capabilityArtifactDigest: PERMISSION_CAPABILITY_ARTIFACT_DIGEST,
    releaseBuild: RELEASE,
    manifestDigest: null,
    processIdentity: { ownerId: 'process:1', ownerPid: 10, ownerBootId: 'boot', ownerStartTicks: '100' },
    randomId: () => `id-${++sequence}`,
    nowMs: () => now.value,
  });
};

type Harness = Readonly<{
  database: Database.Database;
  now: { value: number };
  admit(sessionId: string | null, provider?: string, userId?: number): PermissionExecutionHandle;
}>;

const harness = (database = setup()): Harness => {
  const now = { value: 100 };
  const gateway = gatewayFor(database, now);
  return {
    database,
    now,
    admit: (sessionId, provider = 'claude', userId = 1) => {
      const result = gateway.authorize(actorFor(userId),
        { ...contextFor(sessionId, provider), principalId: `user:${userId}` }, 'full_delegation');
      assert.equal(result.kind, 'authorized');
      if (result.kind !== 'authorized') throw new Error('unreachable');
      return result.execution;
    },
  };
};

const fences = (database: Database.Database) => listPermissionEffectFences(database)
  .map(fence => ({ scopeKind: fence.scopeKind, scopeKey: fence.scopeKey }));

const refusedWith = (code: string) => (error: unknown) => error instanceof PermissionStateConflictError
  && error.code === code;

const decisionSession = (database: Database.Database, decisionId: string) => (database.prepare(
  'SELECT session_id AS sessionId FROM permission_launch_decisions WHERE decision_id = ?',
).get(decisionId) as { sessionId: string | null }).sessionId;

test('new-chat turn crashing before session_created fences its bound session, never the user', () => {
  const { database, admit } = harness();
  try {
    const turn = admit(null);
    turn.bindSession(SESSION_A); // Claude: committed before the CLI is spawned.
    turn.consume();
    turn.markStarted();
    turn.settle('reconciled_unknown');
    assert.deepEqual(fences(database), [{ scopeKind: 'session', scopeKey: SESSION_A }]);

    const nextNewChat = admit(null);
    nextNewChat.consume();
    const resumeOther = admit(SESSION_B);
    resumeOther.consume();
    assert.throws(() => admit(SESSION_A), (error: unknown) => error instanceof PermissionStateConflictError
      && error.code === 'EFFECT_SCOPE_FENCED' && error.fence?.scopeKind === 'session');
  } finally {
    database.close();
  }
});

test('boot reconciliation of a bound new chat whose owner died fences that session only', () => {
  const { database, now, admit } = harness();
  try {
    const turn = admit(null, 'codex');
    turn.consume();
    turn.markStarted();
    turn.bindSession(SESSION_A); // Codex: bound at thread.started, after the start fence.
    now.value = 1_000_000;
    const summary = reconcileExpiredPermissionExecutions(database, now.value, () => false);
    assert.equal(summary.unknownExternal, 1);
    assert.deepEqual(fences(database), [{ scopeKind: 'session', scopeKey: SESSION_A }]);
    admit(null, 'codex').consume();
    admit(SESSION_B, 'codex').consume();
  } finally {
    database.close();
  }
});

test('the tool gate stays closed until the bind CAS commits, and a refused bind keeps it closed', () => {
  const { database, admit } = harness();
  try {
    database.prepare("INSERT INTO sessions VALUES (?, 'claude', '/workspace/other')").run(SESSION_C);
    const turn = admit(null);
    assert.equal(turn.isSessionBound(), false, 'no tool before the CAS');
    assert.throws(() => turn.bindSession(SESSION_C), refusedWith('SESSION_FOREIGN'));
    assert.equal(turn.isSessionBound(), false, 'a refused bind never opens the gate');
    turn.bindSession(SESSION_A);
    assert.equal(turn.isSessionBound(), true);
    assert.equal(admit(SESSION_B).isSessionBound(), true, 'a resume is admitted bound');
  } finally {
    database.close();
  }
});

test('bind is one-shot: a second bind and a bind on a resume are refused', () => {
  const { database, admit } = harness();
  try {
    const turn = admit(null);
    turn.bindSession(SESSION_A);
    assert.throws(() => turn.bindSession(SESSION_B), refusedWith('SESSION_ALREADY_BOUND'));
    assert.equal(decisionSession(database, turn.decisionId), SESSION_A);
    const resume = admit(SESSION_B);
    assert.throws(() => resume.bindSession(SESSION_C), refusedWith('SESSION_ALREADY_BOUND'));
    assert.equal(decisionSession(database, resume.decisionId), SESSION_B);
  } finally {
    database.close();
  }
});

test('a foreign or malformed session id is refused and the decision stays unbound', () => {
  const { database, admit } = harness();
  try {
    database.prepare("INSERT INTO sessions VALUES (?, 'claude', '/workspace/other')").run(SESSION_A);
    database.prepare("INSERT INTO session_participants (session_id, user_id) VALUES (?, 2)").run(SESSION_B);
    const othersTurn = admit(null, 'claude', 2);
    othersTurn.bindSession(SESSION_C);
    const turn = admit(null);
    for (const [sessionId, code] of [
      [SESSION_A, 'SESSION_FOREIGN'], // session row of another project
      [SESSION_B, 'SESSION_FOREIGN'], // participant of another user
      [SESSION_C, 'SESSION_FOREIGN'], // another user's decision already names it
      ['not-a-uuid', 'INVALID_SESSION_ID'],
      ['AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA', 'INVALID_SESSION_ID'],
    ] as const) {
      assert.throws(() => turn.bindSession(sessionId), refusedWith(code), sessionId);
    }
    assert.equal(decisionSession(database, turn.decisionId), null);
    assert.equal(turn.isSessionBound(), false);
  } finally {
    database.close();
  }
});

test('an own, same-project session row does not count as foreign; a settled decision is not bindable', () => {
  const { database, admit } = harness();
  try {
    database.prepare("INSERT INTO sessions VALUES (?, 'claude', '/workspace/project')").run(SESSION_A);
    database.prepare("INSERT INTO session_participants (session_id, user_id) VALUES (?, 1)").run(SESSION_A);
    admit(null).bindSession(SESSION_A);
    const settled = admit(null);
    settled.notStarted();
    assert.throws(() => settled.bindSession(SESSION_B), refusedWith('DECISION_NOT_BINDABLE'));
  } finally {
    database.close();
  }
});

test('an unbound turn that dies keeps the user-wide fence (Codex window with no host tool gate)', () => {
  const { database, admit } = harness();
  try {
    const turn = admit(null, 'codex');
    turn.consume();
    turn.markStarted();
    turn.settle('reconciled_unknown');
    assert.deepEqual(fences(database), [{ scopeKind: 'user_provider_purpose', scopeKey: '1:codex:sdk_turn' }]);
    assert.throws(() => admit(null, 'codex'), refusedWith('EFFECT_SCOPE_FENCED'));
    admit(null, 'claude').consume();
  } finally {
    database.close();
  }
});

test('a pre-existing user-wide sdk_turn fence row still blocks new chats, resumes and claims until its audited lift', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 't1910-s2-'));
  const database = setup(path.join(directory, 'db.sqlite'));
  try {
    const { admit } = harness(database);
    const issued = admit(SESSION_B);
    database.prepare(`INSERT INTO permission_effect_fences (scope_kind, scope_key, protocol_generation,
      decision_id, reason_code, created_at_ms) VALUES ('user_provider_purpose', '1:claude:sdk_turn', 1,
      NULL, 'RECONCILED_EFFECT_UNKNOWN', 50)`).run();
    assert.throws(() => admit(null), (error: unknown) => error instanceof PermissionStateConflictError
      && error.code === 'EFFECT_SCOPE_FENCED' && error.fence?.scopeKind === 'user_provider_purpose');
    assert.throws(() => admit(SESSION_A), refusedWith('EFFECT_SCOPE_FENCED'));
    assert.throws(() => issued.consume(), refusedWith('LEASE_NOT_CLAIMABLE'));

    const lifted = liftFence(database, {
      scopeKind: 'user_provider_purpose', scopeKey: '1:claude:sdk_turn',
      reason: 'test lift', force: true, forceExternal: true, actor: 'tester',
    });
    assert.equal(lifted.databaseCommitted, true);
    admit(null).consume();
    admit(SESSION_A).consume();
  } finally {
    database.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
