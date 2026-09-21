import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';

import Database from 'better-sqlite3';

import { ConversationFoundationRepository } from './repository.js';
import { initializeConversationFoundationSchema } from './schema.js';
import { createUniversalConversationShadowCoreResolver } from './shadow-core-resolver.js';
import { UNIVERSAL_CONVERSATION_SHADOW_FLAG } from './shadow-orchestrator.js';
import {
  closeUniversalConversationShadowRuntime,
  initializeUniversalConversationShadowRuntime,
  issueTrustedShadowAuthorization,
  SHADOW_CONTENT_ACCUMULATOR_CAPACITY,
  type ShadowLegacyTurnHandle,
  UniversalConversationShadowRuntime,
  universalConversationShadowHook,
} from './shadow-runtime.js';

const ENABLED_ENV = { [UNIVERSAL_CONVERSATION_SHADOW_FLAG]: '1' };
const REFERENCE_KEY = 'phase-0-reference-key-for-tests-0123456789abcdef';
const ROTATED_REFERENCE_KEY = 'phase-0-rotated-key-for-tests-fedcba9876543210';
const RETAINED_REFERENCE_KEY = 'phase-0-retained-key-for-tests-0011223344556677';

async function tempFixture(): Promise<{
  directory: string;
  databasePath: string;
  lockPath: string;
}> {
  const directory = await mkdtemp('/tmp/nassaj-shadow-');
  return {
    directory,
    databasePath: path.join(directory, 'auth.db'),
    lockPath: path.join(directory, 'universal-conversations.lock'),
  };
}

function freshAuthorization(principalId: string | number, clientMsgId: string, projectId = 'project-1') {
  return issueTrustedShadowAuthorization({
    kind: 'fresh',
    projectId,
    principalId,
    clientMsgId,
    canSubmit: true,
    authorizationProvenance: 'test-jwt+project-write:v1',
  });
}

function resumeAuthorization(
  principalId: string | number,
  clientMsgId: string,
  legacySessionId: string,
  projectId = 'project-1',
  provider = 'codex',
) {
  return issueTrustedShadowAuthorization({
    kind: 'resume',
    projectId,
    principalId,
    clientMsgId,
    canSubmit: true,
    authorizationProvenance: 'test-jwt+verified-session+write:v1',
    legacyProvider: provider,
    legacySessionId,
  });
}

function boot(db: Database.Database, lockPath: string, instanceId = 'writer') {
  return UniversalConversationShadowRuntime.boot(db, {
    env: ENABLED_ENV,
    lockPath,
    instanceId,
    referenceKey: REFERENCE_KEY,
  });
}

function protectedRef(version: number, key: string, provider: string, sessionId: string): string {
  return createHmac('sha256', key)
    .update(['legacy-session-ref-v1', String(version), provider, sessionId].join('\u001f'))
    .digest('hex');
}

afterEach(() => closeUniversalConversationShadowRuntime());

describe('Universal Conversation Phase-0 runtime', () => {
  it('is a no-op by default without a schema, key, or lock attempt', async () => {
    const fixture = await tempFixture();
    const db = new Database(fixture.databasePath);
    let lockAttempts = 0;
    try {
      const runtime = UniversalConversationShadowRuntime.boot(db, {
        env: {},
        lockPath: fixture.lockPath,
        acquireLock: () => {
          lockAttempts += 1;
          throw new Error('disabled shadow must not acquire a lock');
        },
      });
      assert.equal(runtime, null);
      assert.equal(lockAttempts, 0);
      assert.equal(
        db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='conversations'").get(),
        undefined,
      );
    } finally {
      db.close();
      await rm(fixture.directory, { recursive: true, force: true });
    }
  });

  it('requires an opt-in HMAC reference key before acquiring the process lock', async () => {
    const fixture = await tempFixture();
    const db = new Database(fixture.databasePath);
    let lockAttempts = 0;
    try {
      assert.throws(
        () => UniversalConversationShadowRuntime.boot(db, {
          env: ENABLED_ENV,
          lockPath: fixture.lockPath,
          acquireLock: () => {
            lockAttempts += 1;
            return null;
          },
        }),
        /UNIVERSAL_CONVERSATION_REFERENCE_KEY_REQUIRED/,
      );
      assert.equal(lockAttempts, 0);
      assert.throws(
        () => UniversalConversationShadowRuntime.boot(db, {
          env: ENABLED_ENV,
          lockPath: fixture.lockPath,
          referenceKey: REFERENCE_KEY,
          referenceKeyVersion: 0x1_0000_0000,
          acquireLock: () => {
            lockAttempts += 1;
            return null;
          },
        }),
        /UNIVERSAL_CONVERSATION_REFERENCE_KEY_VERSION_INVALID/,
      );
      assert.throws(
        () => UniversalConversationShadowRuntime.boot(db, {
          env: {
            ...ENABLED_ENV,
            NASSAJ_UNIVERSAL_CONVERSATIONS_REFERENCE_KEY_VERSION: '4294967296',
          },
          lockPath: fixture.lockPath,
          referenceKey: REFERENCE_KEY,
          acquireLock: () => {
            lockAttempts += 1;
            return null;
          },
        }),
        /UNIVERSAL_CONVERSATION_REFERENCE_KEY_VERSION_INVALID/,
      );
      assert.equal(lockAttempts, 0);
    } finally {
      db.close();
      await rm(fixture.directory, { recursive: true, force: true });
    }
  });

  it('fails closed on flock contention and releases the lock idempotently', async () => {
    const fixture = await tempFixture();
    const firstDb = new Database(fixture.databasePath);
    const secondDb = new Database(fixture.databasePath);
    const first = boot(firstDb, fixture.lockPath, 'first');
    try {
      assert.ok(first);
      assert.throws(
        () => boot(secondDb, fixture.lockPath, 'second'),
        /UNIVERSAL_CONVERSATION_NOT_WRITER/,
      );
      first.close();
      first.close();
      const second = boot(secondDb, fixture.lockPath, 'second');
      assert.ok(second);
      second.close();
    } finally {
      first?.close();
      firstDb.close();
      secondDb.close();
      await rm(fixture.directory, { recursive: true, force: true });
    }
  });

  it('atomically rolls back run, event, command, and related evidence on callback failure', () => {
    const db = new Database(':memory:');
    try {
      initializeConversationFoundationSchema(db);
      const repository = new ConversationFoundationRepository(db);
      repository.createConversation({
        conversationId: 'conversation-atomic',
        projectId: 'project-1',
        createdBy: 'user-1',
      });
      const epoch = repository.acquireWriterEpoch('conversation-atomic', 'writer');
      repository.markWriterRecovered('conversation-atomic', 'writer', epoch);
      assert.throws(
        () => repository.acceptRunCommandWithRelated({
          commandId: 'command-atomic',
          runId: 'run-atomic',
          conversationId: 'conversation-atomic',
          principalId: 'user-1',
          clientMsgId: 'client-atomic',
          requestDigest: 'digest-atomic',
          requestedHarness: 'codex',
          writerEpoch: epoch,
        }, () => {
          throw new Error('fault-after-canonical-before-commit');
        }),
        /fault-after-canonical-before-commit/,
      );
      for (const table of ['conversation_runs', 'canonical_events', 'conversation_commands']) {
        assert.equal(
          (db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count,
          0,
          table,
        );
      }
      assert.equal(
        (db.prepare("SELECT next_run_seq FROM conversations WHERE conversation_id='conversation-atomic'")
          .get() as { next_run_seq: number }).next_run_seq,
        1,
      );
    } finally {
      db.close();
    }
  });

  it('keeps logical identity independent, resumes across authorized users, and stores only HMAC refs', async () => {
    const fixture = await tempFixture();
    const db = new Database(fixture.databasePath);
    const runtime = boot(db, fixture.lockPath);
    try {
      assert.ok(runtime);
      const authorization = resumeAuthorization(7, 'client-message-1', 'native-codex-thread');
      const input = {
        principalId: 7,
        clientMsgId: 'client-message-1',
        requestedProvider: 'codex',
        requestedModel: 'gpt-test',
        command: 'a prompt that must never be persisted',
        authorization,
      };
      const first = runtime.beginLegacyTurn(input);
      const duplicate = runtime.beginLegacyTurn(input);
      assert.ok(first && duplicate);
      assert.equal(duplicate.reused, true);
      assert.equal(duplicate.runId, first.runId);
      assert.match(first.conversationId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);

      first.markLegacyDispatchStarted();
      first.observeLegacyPayload({
        kind: 'complete',
        provider: 'codex',
        sessionId: 'native-codex-thread',
        coordinatorId: 7,
        success: true,
        exitCode: 0,
      });

      const parity = runtime.getParity(first.runId);
      assert.ok(parity);
      assert.equal(parity.identityState, 'match');
      assert.equal(parity.authorshipState, 'unknown', 'adapter actor claims are never authority');
      assert.equal(parity.orderState, 'match');
      assert.equal(parity.legacyTerminalOutcome, 'success');
      const link = db.prepare(
        'SELECT legacy_ref_digest, reference_key_version FROM conversation_legacy_links',
      ).get() as { legacy_ref_digest: string; reference_key_version: number };
      assert.notEqual(link.legacy_ref_digest, 'native-codex-thread');
      assert.match(link.legacy_ref_digest, /^[0-9a-f]{64}$/);
      assert.equal(link.reference_key_version, 1);
      assert.doesNotMatch(
        JSON.stringify(db.prepare('SELECT * FROM conversation_shadow_parity').all()),
        /native-codex-thread|prompt that must never/,
      );
      assert.doesNotMatch(
        (db.prepare('SELECT payload_json FROM canonical_events WHERE run_id = ?')
          .get(first.runId) as { payload_json: string }).payload_json,
        /prompt that must never/,
      );

      const secondAuthorization = resumeAuthorization(8, 'client-message-2', 'native-codex-thread');
      const resumed = runtime.beginLegacyTurn({
        principalId: 8,
        clientMsgId: 'client-message-2',
        requestedProvider: 'codex',
        requestedModel: null,
        command: 'authorized collaborator follow-up',
        authorization: secondAuthorization,
      });
      assert.ok(resumed);
      assert.equal(resumed.conversationId, first.conversationId);
      assert.equal(
        (db.prepare('SELECT COUNT(*) AS count FROM conversation_participants WHERE conversation_id = ?')
          .get(first.conversationId) as { count: number }).count,
        2,
      );
      assert.equal(
        (db.prepare('SELECT COUNT(*) AS count FROM conversation_shadow_authorizations')
          .get() as { count: number }).count,
        2,
      );
      assert.throws(
        () => db.prepare("UPDATE conversation_legacy_links SET legacy_provider='forged'").run(),
        /SHADOW_LINK_IDENTITY_IMMUTABLE/,
      );
      assert.throws(
        () => db.prepare("UPDATE conversation_shadow_ingress SET request_digest='forged'").run(),
        /SHADOW_INGRESS_IDENTITY_IMMUTABLE/,
      );
      assert.throws(
        () => db.prepare("UPDATE conversation_shadow_authorizations SET project_id='forged'").run(),
        /SHADOW_AUTHORIZATION_APPEND_ONLY/,
      );
      assert.throws(
        () => db.prepare("UPDATE conversation_shadow_observations SET legacy_kind='forged'").run(),
        /SHADOW_OBSERVATION_APPEND_ONLY/,
      );
      assert.throws(
        () => db.prepare('DELETE FROM conversation_shadow_parity').run(),
        /SHADOW_PARITY_APPEND_ONLY/,
      );
    } finally {
      runtime?.close();
      db.close();
      await rm(fixture.directory, { recursive: true, force: true });
    }
  });

  it('skips missing client ids and forged/untrusted authorizations without creating a run', async () => {
    const fixture = await tempFixture();
    const db = new Database(fixture.databasePath);
    const runtime = boot(db, fixture.lockPath);
    try {
      assert.ok(runtime);
      assert.equal(runtime.beginLegacyTurn({
        principalId: 'user-1',
        clientMsgId: null,
        requestedProvider: 'codex',
        requestedModel: null,
        command: 'missing key',
        authorization: null,
      }), null);
      assert.equal(runtime.beginLegacyTurn({
        principalId: 'attacker',
        clientMsgId: 'copied-id',
        requestedProvider: 'codex',
        requestedModel: null,
        command: 'copied physical reference',
        authorization: {
          kind: 'resume',
          projectId: 'project-1',
          principalId: 'attacker',
          clientMsgId: 'copied-id',
          canSubmit: true,
          legacyProvider: 'codex',
          legacySessionId: 'copied-physical-id',
        } as never,
      }), null);
      assert.equal(
        (db.prepare('SELECT COUNT(*) AS count FROM conversation_runs').get() as { count: number }).count,
        0,
      );
      assert.equal(
        (db.prepare('SELECT COUNT(*) AS count FROM conversation_shadow_divergences')
          .get() as { count: number }).count,
        2,
      );
    } finally {
      runtime?.close();
      db.close();
      await rm(fixture.directory, { recursive: true, force: true });
    }
  });

  it('rolls back participant and authorization evidence when accepted-run evidence faults', async () => {
    const fixture = await tempFixture();
    const db = new Database(fixture.databasePath);
    const runtime = boot(db, fixture.lockPath);
    try {
      assert.ok(runtime);
      const owner = runtime.beginLegacyTurn({
        principalId: 'user-1',
        clientMsgId: 'atomic-owner',
        requestedProvider: 'codex',
        requestedModel: null,
        command: 'owner fixture',
        authorization: resumeAuthorization('user-1', 'atomic-owner', 'atomic-physical'),
      });
      assert.ok(owner);
      db.exec(`
        CREATE TRIGGER inject_shadow_parity_fault
        BEFORE INSERT ON conversation_shadow_parity
        WHEN NEW.principal_id = 'user-2'
        BEGIN
          SELECT RAISE(ABORT, 'INJECTED_PARITY_FAULT');
        END;
      `);
      assert.throws(
        () => runtime.beginLegacyTurn({
          principalId: 'user-2',
          clientMsgId: 'atomic-collaborator',
          requestedProvider: 'codex',
          requestedModel: null,
          command: 'must roll back membership evidence',
          authorization: resumeAuthorization('user-2', 'atomic-collaborator', 'atomic-physical'),
        }),
        /INJECTED_PARITY_FAULT/,
      );
      assert.equal(
        db.prepare(
          `SELECT 1 FROM conversation_participants
            WHERE conversation_id = ? AND principal_id = 'user-2'`,
        ).get(owner.conversationId),
        undefined,
      );
      assert.equal(
        db.prepare(
          `SELECT 1 FROM conversation_shadow_authorizations
            WHERE conversation_id = ? AND principal_id = 'user-2'`,
        ).get(owner.conversationId),
        undefined,
      );
      assert.equal(
        (db.prepare('SELECT COUNT(*) AS count FROM conversation_runs')
          .get() as { count: number }).count,
        1,
      );
    } finally {
      runtime?.close();
      db.close();
      await rm(fixture.directory, { recursive: true, force: true });
    }
  });

  it('atomically rolls back a newly created conversation when acceptance evidence faults', async () => {
    const fixture = await tempFixture();
    const db = new Database(fixture.databasePath);
    const runtime = boot(db, fixture.lockPath);
    try {
      assert.ok(runtime);
      db.exec(`
        CREATE TRIGGER inject_fresh_shadow_parity_fault
        BEFORE INSERT ON conversation_shadow_parity
        WHEN NEW.client_msg_id = 'atomic-fresh'
        BEGIN
          SELECT RAISE(ABORT, 'INJECTED_FRESH_PARITY_FAULT');
        END;
      `);
      assert.throws(
        () => runtime.beginLegacyTurn({
          principalId: 'fresh-owner',
          clientMsgId: 'atomic-fresh',
          requestedProvider: 'codex',
          requestedModel: null,
          command: 'must leave no bootstrap orphan',
          authorization: freshAuthorization('fresh-owner', 'atomic-fresh'),
        }),
        /INJECTED_FRESH_PARITY_FAULT/,
      );
      for (const table of [
        'conversations',
        'conversation_participants',
        'conversation_writer_state',
        'conversation_shadow_authorizations',
        'conversation_legacy_links',
        'conversation_runs',
        'canonical_events',
        'conversation_commands',
        'conversation_shadow_parity',
        'conversation_shadow_ingress',
      ]) {
        assert.equal(
          (db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count,
          0,
          table,
        );
      }
    } finally {
      runtime?.close();
      db.close();
      await rm(fixture.directory, { recursive: true, force: true });
    }
  });

  it('never links from forged output and treats exact session replay as idempotent evidence', async () => {
    const fixture = await tempFixture();
    const db = new Database(fixture.databasePath);
    const runtime = boot(db, fixture.lockPath);
    try {
      assert.ok(runtime);
      const authorization = freshAuthorization('user-1', 'candidate');
      const turn = runtime.beginLegacyTurn({
        principalId: 'user-1',
        clientMsgId: 'candidate',
        requestedProvider: 'codex',
        requestedModel: null,
        command: 'candidate fixture',
        authorization,
      });
      assert.ok(turn);
      turn.markLegacyDispatchStarted();
      const verdict = { kind: 'session_created', provider: 'codex', sessionId: 'unverified-thread' };
      turn.observeLegacyPayload(verdict);
      turn.observeLegacyPayload(verdict);
      turn.observeLegacyPayload({ kind: 'stream_delta', provider: 'codex', sessionId: 'forged-delta-id' });
      turn.observeLegacyPayload({ kind: 'stream_delta', provider: 'codex', sessionId: 'forged-delta-id' });
      const parity = runtime.getParity(turn.runId);
      assert.ok(parity);
      assert.equal(parity.duplicateCount, 1);
      assert.equal(parity.lastObservationSeq, 1, 'stream deltas never allocate durable observation rows');
      assert.equal(
        (db.prepare("SELECT COUNT(*) AS count FROM conversation_shadow_observations WHERE legacy_kind NOT IN ('session_created', 'complete', 'error')")
          .get() as { count: number }).count,
        0,
      );
      assert.notEqual(parity.orderState, 'diverged');
      assert.equal(
        (db.prepare('SELECT COUNT(*) AS count FROM conversation_legacy_links')
          .get() as { count: number }).count,
        0,
      );
      assert.equal(
        (db.prepare("SELECT verification_state FROM conversation_shadow_observations WHERE legacy_kind='session_created'")
          .get() as { verification_state: string }).verification_state,
        'pending',
      );
    } finally {
      runtime?.close();
      db.close();
      await rm(fixture.directory, { recursive: true, force: true });
    }
  });

  it('records real nonterminal output before fresh acceptance but leaves terminal-only order unknown', async () => {
    const fixture = await tempFixture();
    const db = new Database(fixture.databasePath);
    const runtime = boot(db, fixture.lockPath);
    try {
      assert.ok(runtime);
      const earlyAuthorization = freshAuthorization('user-1', 'early-output');
      const early = runtime.beginLegacyTurn({
        principalId: 'user-1',
        clientMsgId: 'early-output',
        requestedProvider: 'codex',
        requestedModel: null,
        command: 'early output fixture',
        authorization: earlyAuthorization,
      });
      assert.ok(early);
      early.markLegacyDispatchStarted();
      early.observeLegacyPayload({ kind: 'stream_delta', provider: 'codex' });
      assert.equal(runtime.getParity(early.runId)?.orderState, 'pending');
      early.observeLegacyPayload({ kind: 'complete', provider: 'codex', success: true, exitCode: 0 });
      assert.equal(runtime.getParity(early.runId)?.orderState, 'diverged');
      assert.ok(
        runtime.getParity(early.runId)?.divergenceCodes.includes('LEGACY_OUTPUT_BEFORE_SESSION_CREATED'),
      );

      const terminalAuthorization = freshAuthorization('user-1', 'terminal-only');
      const terminalOnly = runtime.beginLegacyTurn({
        principalId: 'user-1',
        clientMsgId: 'terminal-only',
        requestedProvider: 'codex',
        requestedModel: null,
        command: 'terminal only fixture',
        authorization: terminalAuthorization,
      });
      assert.ok(terminalOnly);
      terminalOnly.markLegacyDispatchStarted();
      terminalOnly.observeLegacyPayload({
        kind: 'complete',
        provider: 'codex',
        success: false,
        notStarted: true,
      });
      assert.equal(runtime.getParity(terminalOnly.runId)?.orderState, 'unknown');
    } finally {
      runtime?.close();
      db.close();
      await rm(fixture.directory, { recursive: true, force: true });
    }
  });

  it('bounds ingress identifiers/models and stores only fixed observation categories', async () => {
    const fixture = await tempFixture();
    const db = new Database(fixture.databasePath);
    const runtime = boot(db, fixture.lockPath);
    const secret = `SECRET_${'x'.repeat(2 * 1024 * 1024)}`;
    try {
      assert.ok(runtime);
      const modelAuthorization = freshAuthorization('user-1', 'bounded-model');
      assert.equal(runtime.beginLegacyTurn({
        principalId: 'user-1',
        clientMsgId: 'bounded-model',
        requestedProvider: 'codex',
        requestedModel: secret,
        command: 'invalid model must be skipped',
        authorization: modelAuthorization,
      }), null);
      assert.equal(runtime.beginLegacyTurn({
        principalId: 'user-1',
        clientMsgId: secret,
        requestedProvider: 'codex',
        requestedModel: null,
        command: 'invalid client id must be skipped',
        authorization: null,
      }), null);

      const observationAuthorization = freshAuthorization('user-1', 'bounded-observation');
      const turn = runtime.beginLegacyTurn({
        principalId: 'user-1',
        clientMsgId: 'bounded-observation',
        requestedProvider: 'codex',
        requestedModel: 'gpt-safe/model',
        command: 'bounded observation fixture',
        authorization: observationAuthorization,
      });
      assert.ok(turn);
      turn.markLegacyDispatchStarted();
      turn.observeLegacyPayload({
        kind: secret,
        provider: secret,
        clientMsgId: secret,
        sessionId: secret,
      });
      turn.observeLegacyPayload({
        kind: 'complete',
        provider: secret,
        clientMsgId: secret,
        sessionId: secret,
        success: true,
        exitCode: 0,
      });
      const observation = db.prepare(
        'SELECT legacy_kind, legacy_ref_digest, envelope_digest FROM conversation_shadow_observations',
      ).get() as { legacy_kind: string; legacy_ref_digest: string | null; envelope_digest: string };
      assert.deepEqual({
        kind: observation.legacy_kind,
        legacyRef: observation.legacy_ref_digest,
        digestLength: observation.envelope_digest.length,
      }, { kind: 'complete', legacyRef: null, digestLength: 64 });
      const boundedParity = runtime.getParity(turn.runId);
      assert.ok(boundedParity);
      assert.equal(boundedParity.identityState, 'diverged');
      assert.ok(boundedParity.divergenceCodes.includes('INVALID_LEGACY_PROVIDER_CLAIM'));
      assert.ok(boundedParity.divergenceCodes.includes('INVALID_LEGACY_CLIENT_MSG_ID_CLAIM'));
      assert.ok(boundedParity.divergenceCodes.includes('INVALID_LEGACY_SESSION_REF'));
      assert.equal(boundedParity.contentIntegrityState, 'unknown');
      assert.equal(
        (db.prepare('SELECT schema_gap FROM conversation_shadow_content_summaries WHERE run_id = ?')
          .get(turn.runId) as { schema_gap: number }).schema_gap,
        1,
      );
      assert.doesNotMatch(
        JSON.stringify({
          observations: db.prepare('SELECT * FROM conversation_shadow_observations').all(),
          parity: db.prepare('SELECT * FROM conversation_shadow_parity').all(),
          runs: db.prepare('SELECT requested_model FROM conversation_runs').all(),
          divergences: db.prepare('SELECT * FROM conversation_shadow_divergences').all(),
        }),
        /SECRET_/,
      );
    } finally {
      runtime?.close();
      db.close();
      await rm(fixture.directory, { recursive: true, force: true });
    }
  });

  it('does not count an unknown content-integrity summary as a completed comparison', async () => {
    const fixture = await tempFixture();
    const db = new Database(fixture.databasePath);
    const runtime = boot(db, fixture.lockPath);
    try {
      assert.ok(runtime);
      const turn = runtime.beginLegacyTurn({
        principalId: 'user-1',
        clientMsgId: 'unknown-integrity-metric',
        requestedProvider: 'codex',
        requestedModel: null,
        command: 'unknown integrity metric fixture',
        authorization: resumeAuthorization(
          'user-1',
          'unknown-integrity-metric',
          'metric-thread',
        ),
      });
      assert.ok(turn);
      turn.markLegacyDispatchStarted();
      turn.observeLegacyPayload({ kind: 'future_visible_kind', content: 'unsupported' });
      turn.observeLegacyPayload({ kind: 'complete', provider: 'codex', success: true, exitCode: 0 });
      db.prepare(
        `UPDATE conversation_shadow_parity
            SET authorship_state = 'match'
          WHERE run_id = ?`,
      ).run(turn.runId);
      assert.equal(runtime.getParity(turn.runId)?.contentIntegrityState, 'unknown');
      assert.equal(runtime.getParityMetrics().completedComparisons, 0);
    } finally {
      runtime?.close();
      db.close();
      await rm(fixture.directory, { recursive: true, force: true });
    }
  });

  it('keeps a fresh session-created candidate pending even when a same-project server row exists', async () => {
    const fixture = await tempFixture();
    const db = new Database(fixture.databasePath);
    const runtime = boot(db, fixture.lockPath);
    const sessions = new Map<string, { sessionId: string; provider: string; projectPath: string }>();
    const resolver = createUniversalConversationShadowCoreResolver({
      coercePrincipalId: (value) => Number.isInteger(Number(value)) ? Number(value) : null,
      getSession: (sessionId) => sessions.get(sessionId) ?? null,
      getProjectByPath: (projectPath) => projectPath === '/project'
        ? { projectId: 'project-1' }
        : null,
      isSessionParticipant: () => false,
      isProjectWritable: () => true,
    });
    try {
      assert.ok(runtime);
      const authorization = resolver.authorize({
        principalId: 7,
        clientMsgId: 'revoked-before-attest',
        requestedProvider: 'codex',
        requestedLegacySessionId: null,
        requestedProjectPath: '/project',
      });
      assert.ok(authorization);
      const turn = runtime.beginLegacyTurn({
        principalId: 7,
        clientMsgId: 'revoked-before-attest',
        requestedProvider: 'codex',
        requestedModel: null,
        command: 'revocation fixture',
        authorization,
      });
      assert.ok(turn);
      turn.markLegacyDispatchStarted();
      sessions.set('new-physical-thread', {
        sessionId: 'new-physical-thread',
        provider: 'codex',
        projectPath: '/project',
      });
      const attestation = resolver.attest({
        authorization,
        provider: 'codex',
        legacySessionId: 'new-physical-thread',
      });
      assert.equal(attestation, null);
      turn.observeLegacyPayload({
        kind: 'session_created',
        provider: 'codex',
        sessionId: 'new-physical-thread',
      }, attestation);
      assert.equal(
        (db.prepare("SELECT verification_state FROM conversation_shadow_observations WHERE legacy_kind='session_created'")
          .get() as { verification_state: string }).verification_state,
        'pending',
      );
      assert.equal(
        (db.prepare('SELECT COUNT(*) AS count FROM conversation_legacy_links')
          .get() as { count: number }).count,
        0,
      );
    } finally {
      runtime?.close();
      db.close();
      await rm(fixture.directory, { recursive: true, force: true });
    }
  });

  it('preserves the first terminal outcome and marks later evidence as reordered', async () => {
    const fixture = await tempFixture();
    const db = new Database(fixture.databasePath);
    const runtime = boot(db, fixture.lockPath);
    try {
      assert.ok(runtime);
      const authorization = resumeAuthorization('user-1', 'terminal', 'existing-thread');
      const turn = runtime.beginLegacyTurn({
        principalId: 'user-1',
        clientMsgId: 'terminal',
        requestedProvider: 'codex',
        requestedModel: null,
        command: 'terminal fixture',
        authorization,
      });
      assert.ok(turn);
      turn.markLegacyDispatchStarted();
      const completed = { kind: 'complete', provider: 'codex', success: true, exitCode: 0 };
      turn.observeLegacyPayload(completed);
      turn.observeLegacyPayload(completed);
      turn.observeLegacyPayload({ kind: 'error', provider: 'codex', success: false, exitCode: 1 });
      turn.recordLegacyFailure('PROVIDER_THROW_AFTER_COMPLETE');
      const parity = runtime.getParity(turn.runId);
      assert.ok(parity);
      assert.equal(parity.legacyTerminalOutcome, 'success');
      assert.equal(parity.duplicateCount, 1);
      assert.equal(parity.lastObservationSeq, 2, 'exact terminal replay does not allocate a sequence');
      assert.equal(parity.orderState, 'diverged');
      assert.ok(parity.divergenceCodes.includes('LEGACY_EVENT_AFTER_TERMINAL'));
      assert.ok(parity.divergenceCodes.includes('LEGACY_FAILURE_AFTER_TERMINAL'));
      assert.equal(
        runtime.getParityMetrics().completedComparisons,
        0,
        'unknown authorship keeps the comparison incomplete',
      );
    } finally {
      runtime?.close();
      db.close();
      await rm(fixture.directory, { recursive: true, force: true });
    }
  });

  it('binds terminal control claims without treating control content as visible output', async () => {
    const fixture = await tempFixture();
    const db = new Database(fixture.databasePath);
    const runtime = boot(db, fixture.lockPath);
    try {
      assert.ok(runtime);
      const turn = runtime.beginLegacyTurn({
        principalId: 'user-1',
        clientMsgId: 'terminal-control',
        requestedProvider: 'codex',
        requestedModel: null,
        command: 'terminal control fixture',
        authorization: resumeAuthorization('user-1', 'terminal-control', 'terminal-control-thread'),
      });
      assert.ok(turn);
      turn.markLegacyDispatchStarted();
      turn.observeLegacyPayload({
        kind: 'complete',
        provider: 'codex',
        content: 'first-control',
        code: 'CONTROL_A',
        reason: 'first reason',
        aborted: false,
        timestamp: '2026-08-10T01:00:00.000Z',
        success: true,
        exitCode: 0,
      });
      turn.observeLegacyPayload({
        kind: 'complete',
        provider: 'codex',
        content: 'first-control',
        code: 'CONTROL_A',
        reason: 'first reason',
        aborted: false,
        timestamp: '2026-08-10T02:00:00.000Z',
        success: true,
        exitCode: 0,
      });
      turn.observeLegacyPayload({
        kind: 'complete',
        provider: 'codex',
        content: 'first-control',
        code: 'CONTROL_B',
        reason: 'changed reason',
        aborted: true,
        success: true,
        exitCode: 0,
      });
      const parity = runtime.getParity(turn.runId);
      assert.equal(parity?.duplicateCount, 1);
      assert.equal(parity?.orderState, 'diverged');
      assert.ok(parity?.divergenceCodes.includes('LEGACY_TERMINAL_CONTROL_CHANGED'));
      assert.deepEqual(
        db.prepare(
          `SELECT segment_count, source_chunk_count, canonical_bytes, integrity_state
             FROM conversation_shadow_content_summaries WHERE run_id = ?`,
        ).get(turn.runId),
        {
          segment_count: 0,
          source_chunk_count: 0,
          canonical_bytes: 0,
          integrity_state: 'verified',
        },
      );
      assert.equal(runtime.getParity(turn.runId)?.contentComparisonState, 'pending');
      db.prepare("UPDATE conversation_shadow_parity SET authorship_state = 'match' WHERE run_id = ?")
        .run(turn.runId);
      assert.equal(
        runtime.getParityMetrics().completedComparisons,
        0,
        'a local commitment is not an end-to-end content comparison',
      );
    } finally {
      runtime?.close();
      db.close();
      await rm(fixture.directory, { recursive: true, force: true });
    }
  });

  it('dedupes an exact session verdict replay before flagging a distinct post-terminal session', async () => {
    const fixture = await tempFixture();
    const db = new Database(fixture.databasePath);
    const runtime = boot(db, fixture.lockPath);
    try {
      assert.ok(runtime);
      const turn = runtime.beginLegacyTurn({
        principalId: 'user-1',
        clientMsgId: 'post-terminal-session',
        requestedProvider: 'codex',
        requestedModel: null,
        command: 'post terminal session fixture',
        authorization: freshAuthorization('user-1', 'post-terminal-session'),
      });
      assert.ok(turn);
      turn.markLegacyDispatchStarted();
      const firstSession = {
        kind: 'session_created',
        provider: 'codex',
        sessionId: 'session-a',
        newSessionId: 'session-a',
        forked: true,
        parentSessionId: 'parent-a',
        timestamp: '2026-08-10T01:00:00.000Z',
      };
      turn.observeLegacyPayload(firstSession);
      turn.observeLegacyPayload({ kind: 'complete', provider: 'codex', success: true, exitCode: 0 });
      turn.observeLegacyPayload({ ...firstSession, timestamp: '2026-08-10T02:00:00.000Z' });
      assert.equal(runtime.getParity(turn.runId)?.duplicateCount, 1);
      turn.observeLegacyPayload({ ...firstSession, parentSessionId: 'parent-b' });
      const parity = runtime.getParity(turn.runId);
      assert.equal(parity?.orderState, 'diverged');
      assert.ok(parity?.divergenceCodes.includes('LEGACY_EVENT_AFTER_TERMINAL'));
      assert.ok(parity?.divergenceCodes.includes('LEGACY_SESSION_CONTROL_CHANGED'));
      turn.observeLegacyPayload({
        ...firstSession,
        sessionId: 'session-a',
        newSessionId: 'session-b',
      });
      assert.ok(
        runtime.getParity(turn.runId)?.divergenceCodes
          .includes('INVALID_LEGACY_SESSION_CONTROL_CLAIM'),
      );
    } finally {
      runtime?.close();
      db.close();
      await rm(fixture.directory, { recursive: true, force: true });
    }
  });

  it('never labels an invalid or incomplete control projection as an exact replay', async () => {
    const fixture = await tempFixture();
    const db = new Database(fixture.databasePath);
    const runtime = boot(db, fixture.lockPath);
    try {
      assert.ok(runtime);
      const turn = runtime.beginLegacyTurn({
        principalId: 'user-invalid-control',
        clientMsgId: 'invalid-control-replay',
        requestedProvider: 'codex',
        requestedModel: null,
        command: 'invalid control replay',
        authorization: freshAuthorization('user-invalid-control', 'invalid-control-replay'),
      });
      assert.ok(turn);
      turn.markLegacyDispatchStarted();
      const invalidVerdict = {
        kind: 'error',
        provider: 'codex',
        success: false,
        exitCode: 1,
        unexpectedVisibleClaim: 'must fail closed',
      };
      turn.observeLegacyPayload(invalidVerdict);
      turn.observeLegacyPayload(invalidVerdict);
      const parity = runtime.getParity(turn.runId);
      assert.equal(parity?.duplicateCount, 0);
      assert.equal(parity?.orderState, 'diverged');
      assert.ok(parity?.divergenceCodes.includes('LEGACY_EVENT_AFTER_TERMINAL'));
      assert.equal(parity?.contentIntegrityState, 'unknown');
      assert.equal(
        (db.prepare('SELECT COUNT(*) AS count FROM conversation_shadow_observations WHERE run_id = ?')
          .get(turn.runId) as { count: number }).count,
        2,
      );
    } finally {
      runtime?.close();
      db.close();
      await rm(fixture.directory, { recursive: true, force: true });
    }
  });

  it('never collapses malformed core verdict claims into an absent exact replay', async () => {
    const fixture = await tempFixture();
    const db = new Database(fixture.databasePath);
    const runtime = boot(db, fixture.lockPath);
    try {
      assert.ok(runtime);
      const turn = runtime.beginLegacyTurn({
        principalId: 'user-malformed-verdict',
        clientMsgId: 'malformed-verdict',
        requestedProvider: 'codex',
        requestedModel: null,
        command: 'malformed verdict replay',
        authorization: freshAuthorization('user-malformed-verdict', 'malformed-verdict'),
      });
      assert.ok(turn);
      turn.markLegacyDispatchStarted();
      turn.observeLegacyPayload({ kind: 'complete' });
      turn.observeLegacyPayload({
        kind: 'complete',
        provider: 7,
        clientMsgId: {},
        sessionId: 42,
        success: 'yes',
        exitCode: '0',
        notStarted: 'true',
      });
      const parity = runtime.getParity(turn.runId);
      assert.equal(parity?.duplicateCount, 0);
      assert.equal(parity?.legacyTerminalOutcome, 'unknown');
      assert.equal(parity?.orderState, 'diverged');
      for (const code of [
        'INVALID_LEGACY_PROVIDER_CLAIM',
        'INVALID_LEGACY_CLIENT_MSG_ID_CLAIM',
        'INVALID_LEGACY_SESSION_REF',
        'INVALID_LEGACY_SUCCESS_CLAIM',
        'INVALID_LEGACY_EXIT_CODE',
        'INVALID_LEGACY_NOT_STARTED_CLAIM',
      ]) {
        assert.ok(parity?.divergenceCodes.includes(code), code);
      }
      assert.equal(
        (db.prepare('SELECT COUNT(*) AS count FROM conversation_shadow_observations WHERE run_id = ?')
          .get(turn.runId) as { count: number }).count,
        2,
      );
    } finally {
      runtime?.close();
      db.close();
      await rm(fixture.directory, { recursive: true, force: true });
    }
  });

  it('normalizes contradictory and invalid terminal signals to unknown', async () => {
    const fixture = await tempFixture();
    const db = new Database(fixture.databasePath);
    const runtime = boot(db, fixture.lockPath);
    const cases = [
      { id: 'false-zero', payload: { kind: 'complete', success: false, exitCode: 0 }, conflict: true },
      { id: 'true-one', payload: { kind: 'complete', success: true, exitCode: 1 }, conflict: true },
      { id: 'error-success', payload: { kind: 'error', success: true, exitCode: 0 }, conflict: true },
      {
        id: 'not-started-success',
        payload: { kind: 'complete', notStarted: true, success: true, exitCode: 0 },
        conflict: true,
      },
      { id: 'fractional-exit', payload: { kind: 'complete', exitCode: 1.5 }, invalidExit: true },
    ] as const;
    try {
      assert.ok(runtime);
      for (const item of cases) {
        const turn = runtime.beginLegacyTurn({
          principalId: 'terminal-matrix',
          clientMsgId: item.id,
          requestedProvider: 'codex',
          requestedModel: null,
          command: item.id,
          authorization: freshAuthorization('terminal-matrix', item.id),
        });
        assert.ok(turn);
        turn.markLegacyDispatchStarted();
        turn.observeLegacyPayload({ ...item.payload, provider: 'codex' });
        const parity = runtime.getParity(turn.runId);
        assert.equal(parity?.legacyTerminalOutcome, 'unknown', item.id);
        if ('conflict' in item) {
          assert.ok(parity?.divergenceCodes.includes('LEGACY_TERMINAL_SIGNAL_CONFLICT'), item.id);
        }
        if ('invalidExit' in item) {
          assert.ok(parity?.divergenceCodes.includes('INVALID_LEGACY_EXIT_CODE'), item.id);
        }
      }
    } finally {
      runtime?.close();
      db.close();
      await rm(fixture.directory, { recursive: true, force: true });
    }
  });

  it('records each legacy redispatch generation and never dedupes terminal evidence across them', async () => {
    const fixture = await tempFixture();
    const db = new Database(fixture.databasePath);
    const runtime = boot(db, fixture.lockPath);
    try {
      assert.ok(runtime);
      const input = {
        principalId: 'user-1',
        clientMsgId: 'redispatch',
        requestedProvider: 'codex',
        requestedModel: null,
        command: 'same idempotent ingress',
        authorization: resumeAuthorization('user-1', 'redispatch', 'redispatch-thread'),
      };
      const first = runtime.beginLegacyTurn(input);
      assert.ok(first);
      first.markLegacyDispatchStarted();
      first.observeLegacyPayload({ kind: 'complete', provider: 'codex', success: true, exitCode: 0 });

      const retry = runtime.beginLegacyTurn(input);
      assert.ok(retry);
      assert.equal(retry.reused, true);
      assert.equal(retry.runId, first.runId);
      retry.markLegacyDispatchStarted();
      retry.observeLegacyPayload({ kind: 'complete', provider: 'codex', success: true, exitCode: 0 });

      const parity = runtime.getParity(first.runId);
      assert.ok(parity);
      assert.equal(parity.legacyDispatchCount, 2);
      assert.equal(parity.duplicateCount, 0);
      assert.equal(parity.lastObservationSeq, 2);
      assert.equal(parity.orderState, 'diverged');
      assert.ok(parity.divergenceCodes.includes('LEGACY_REDISPATCH_OF_IDEMPOTENT_RUN'));
      assert.deepEqual(
        db.prepare(
          'SELECT dispatch_generation FROM conversation_shadow_observations WHERE run_id = ? ORDER BY observation_seq',
        ).all(first.runId),
        [{ dispatch_generation: 1 }, { dispatch_generation: 2 }],
      );
      assert.deepEqual(
        db.prepare(
          `SELECT dispatch_generation, integrity_state, terminal_outcome
             FROM conversation_shadow_content_summaries
            WHERE run_id = ? ORDER BY dispatch_generation`,
        ).all(first.runId),
        [
          { dispatch_generation: 1, integrity_state: 'verified', terminal_outcome: 'success' },
          { dispatch_generation: 2, integrity_state: 'verified', terminal_outcome: 'success' },
        ],
      );
      assert.equal(
        (db.prepare('SELECT COUNT(*) AS count FROM conversation_runs WHERE run_id = ?')
          .get(first.runId) as { count: number }).count,
        1,
      );
    } finally {
      runtime?.close();
      db.close();
      await rm(fixture.directory, { recursive: true, force: true });
    }
  });

  it('persists no stream rows and one terminal summary for 100k small chunks', async () => {
    const fixture = await tempFixture();
    const db = new Database(fixture.databasePath);
    const runtime = boot(db, fixture.lockPath);
    try {
      assert.ok(runtime);
      const turn = runtime.beginLegacyTurn({
        principalId: 'user-1',
        clientMsgId: 'content-load',
        requestedProvider: 'codex',
        requestedModel: null,
        command: 'content load fixture',
        authorization: resumeAuthorization('user-1', 'content-load', 'load-thread'),
      });
      assert.ok(turn);
      turn.markLegacyDispatchStarted();
      const changesBeforeChunks = (db.prepare('SELECT total_changes() AS count').get() as {
        count: number;
      }).count;
      for (let index = 0; index < 100_000; index += 1) {
        turn.observeLegacyPayload({ kind: 'stream_delta', content: 'x'.repeat(16) });
      }
      const changesAfterChunks = (db.prepare('SELECT total_changes() AS count').get() as {
        count: number;
      }).count;
      assert.equal(changesAfterChunks, changesBeforeChunks, 'stream deltas perform zero DB writes');
      assert.equal(
        (db.prepare('SELECT COUNT(*) AS count FROM conversation_shadow_observations WHERE run_id = ?')
          .get(turn.runId) as { count: number }).count,
        0,
      );
      assert.equal(
        (db.prepare('SELECT COUNT(*) AS count FROM conversation_shadow_content_summaries WHERE run_id = ?')
          .get(turn.runId) as { count: number }).count,
        0,
      );
      turn.observeLegacyPayload({ kind: 'complete', provider: 'codex', success: true, exitCode: 0 });
      assert.equal(
        (db.prepare('SELECT COUNT(*) AS count FROM conversation_shadow_observations WHERE run_id = ?')
          .get(turn.runId) as { count: number }).count,
        1,
      );
      assert.deepEqual(
        db.prepare(
          `SELECT source_chunk_count, canonical_bytes, segment_count, integrity_state
             FROM conversation_shadow_content_summaries WHERE run_id = ?`,
        ).get(turn.runId),
        {
          source_chunk_count: 100_000,
          canonical_bytes: 3_200_000,
          segment_count: 1,
          integrity_state: 'verified',
        },
      );
    } finally {
      runtime?.close();
      db.close();
      await rm(fixture.directory, { recursive: true, force: true });
    }
  });

  it('globally caps live content accumulators and releases each reservation exactly once', async () => {
    const fixture = await tempFixture();
    const db = new Database(fixture.databasePath);
    const runtime = boot(db, fixture.lockPath);
    const handles: ShadowLegacyTurnHandle[] = [];
    try {
      assert.ok(runtime);
      for (let index = 0; index < SHADOW_CONTENT_ACCUMULATOR_CAPACITY; index += 1) {
        const clientMsgId = `capacity-${index}`;
        const handle = runtime.beginLegacyTurn({
          principalId: 'user-capacity',
          clientMsgId,
          requestedProvider: 'codex',
          requestedModel: null,
          command: `capacity fixture ${index}`,
          authorization: freshAuthorization('user-capacity', clientMsgId),
        });
        assert.ok(handle);
        handle.markLegacyDispatchStarted();
        handles.push(handle);
      }
      assert.deepEqual(runtime.getContentAccumulatorDiagnostics(), {
        active: SHADOW_CONTENT_ACCUMULATOR_CAPACITY,
        capacity: SHADOW_CONTENT_ACCUMULATOR_CAPACITY,
        estimatedMaximumBytes: SHADOW_CONTENT_ACCUMULATOR_CAPACITY * 340 * 1024,
      });
      assert.ok(runtime.getContentAccumulatorDiagnostics().estimatedMaximumBytes < 48 * 1024 * 1024);

      handles[0].markLegacyDispatchStarted();
      assert.equal(runtime.getContentAccumulatorDiagnostics().active, SHADOW_CONTENT_ACCUMULATOR_CAPACITY);
      assert.equal(runtime.getParity(handles[0].runId)?.legacyDispatchCount, 1);

      const capped = runtime.beginLegacyTurn({
        principalId: 'user-capacity',
        clientMsgId: 'capacity-overflow',
        requestedProvider: 'codex',
        requestedModel: null,
        command: 'capacity overflow fixture',
        authorization: freshAuthorization('user-capacity', 'capacity-overflow'),
      });
      assert.ok(capped);
      capped.markLegacyDispatchStarted();
      capped.observeLegacyPayload({ kind: 'session_created', provider: 'codex', sessionId: 'ignored-cap' });
      capped.observeLegacyPayload({ kind: 'complete', provider: 'codex', success: true, exitCode: 0 });
      capped.observeLegacyPayload({ kind: 'stream_delta', content: 'late but still forwarded' });
      const cappedParity = runtime.getParity(capped.runId);
      assert.ok(cappedParity);
      assert.equal(cappedParity.legacyDispatchCount, 1);
      assert.equal(cappedParity.legacyTerminalOutcome, 'success');
      assert.equal(cappedParity.contentIntegrityState, 'unknown');
      assert.ok(cappedParity.divergenceCodes.includes('CONTENT_ACCUMULATOR_CAPACITY_EXCEEDED'));
      assert.equal(
        (db.prepare('SELECT COUNT(*) AS count FROM conversation_shadow_observations WHERE run_id = ?')
          .get(capped.runId) as { count: number }).count,
        2,
      );
      assert.equal(
        (db.prepare('SELECT COUNT(*) AS count FROM conversation_shadow_content_summaries WHERE run_id = ?')
          .get(capped.runId) as { count: number }).count,
        0,
      );

      handles[0].finishLegacyDispatch?.();
      assert.equal(runtime.getContentAccumulatorDiagnostics().active, SHADOW_CONTENT_ACCUMULATOR_CAPACITY - 1);
      const replacement = runtime.beginLegacyTurn({
        principalId: 'user-capacity',
        clientMsgId: 'capacity-replacement',
        requestedProvider: 'codex',
        requestedModel: null,
        command: 'capacity replacement fixture',
        authorization: freshAuthorization('user-capacity', 'capacity-replacement'),
      });
      assert.ok(replacement);
      replacement.markLegacyDispatchStarted();
      assert.equal(runtime.getContentAccumulatorDiagnostics().active, SHADOW_CONTENT_ACCUMULATOR_CAPACITY);
      replacement.observeLegacyPayload({
        kind: 'complete',
        provider: 'codex',
        success: true,
        exitCode: 0,
      });
      assert.equal(runtime.getParity(replacement.runId)?.contentIntegrityState, 'verified');
      replacement.finishLegacyDispatch?.();
      capped.finishLegacyDispatch?.();
      assert.equal(runtime.getParity(capped.runId)?.orderState, 'diverged');
      assert.ok(
        runtime.getParity(capped.runId)?.divergenceCodes.includes('LEGACY_CONTENT_AFTER_TERMINAL'),
      );
      const changesBeforeDelayedPayload = db.prepare('SELECT total_changes() AS count')
        .get() as { count: number };
      replacement.observeLegacyPayload({ kind: 'stream_delta', content: 'async-late-1' });
      replacement.observeLegacyPayload({ kind: 'stream_delta', content: 'async-late-2' });
      const changesAfterDelayedPayload = db.prepare('SELECT total_changes() AS count')
        .get() as { count: number };
      assert.equal(changesAfterDelayedPayload.count - changesBeforeDelayedPayload.count, 1);
      assert.ok(
        runtime.getParity(replacement.runId)?.divergenceCodes
          .includes('LEGACY_PAYLOAD_AFTER_DISPATCH_FINISH'),
      );
      for (const handle of handles) handle.finishLegacyDispatch?.();
      assert.equal(runtime.getContentAccumulatorDiagnostics().active, 0);
    } finally {
      runtime?.close();
      db.close();
      await rm(fixture.directory, { recursive: true, force: true });
    }
  });

  it('commits terminal observation and content summary atomically', async () => {
    const fixture = await tempFixture();
    const db = new Database(fixture.databasePath);
    const runtime = boot(db, fixture.lockPath);
    try {
      assert.ok(runtime);
      const turn = runtime.beginLegacyTurn({
        principalId: 'user-1',
        clientMsgId: 'summary-atomic',
        requestedProvider: 'codex',
        requestedModel: null,
        command: 'summary atomic fixture',
        authorization: freshAuthorization('user-1', 'summary-atomic'),
      });
      assert.ok(turn);
      turn.markLegacyDispatchStarted();
      turn.observeLegacyPayload({ kind: 'stream_delta', content: 'must roll back with summary' });
      db.exec(`
        CREATE TRIGGER inject_content_summary_fault
        BEFORE INSERT ON conversation_shadow_content_summaries
        BEGIN
          SELECT RAISE(ABORT, 'INJECTED_CONTENT_SUMMARY_FAULT');
        END;
      `);
      turn.observeLegacyPayload({ kind: 'complete', provider: 'codex', success: false, exitCode: 1 });
      assert.equal(
        (db.prepare('SELECT COUNT(*) AS count FROM conversation_shadow_observations WHERE run_id = ?')
          .get(turn.runId) as { count: number }).count,
        0,
      );
      assert.equal(
        (db.prepare('SELECT COUNT(*) AS count FROM conversation_shadow_content_summaries WHERE run_id = ?')
          .get(turn.runId) as { count: number }).count,
        0,
      );
      assert.equal(runtime.getParity(turn.runId)?.legacyTerminalOutcome, 'pending');
      db.exec('DROP TRIGGER inject_content_summary_fault');
      turn.observeLegacyPayload({ kind: 'error', provider: 'codex', success: false, exitCode: 1 });
      turn.finishLegacyDispatch?.();
      assert.equal(runtime.getParity(turn.runId)?.legacyTerminalOutcome, 'pending');
      assert.equal(
        (db.prepare('SELECT COUNT(*) AS count FROM conversation_shadow_observations WHERE run_id = ?')
          .get(turn.runId) as { count: number }).count,
        0,
      );
      assert.equal(
        (db.prepare('SELECT COUNT(*) AS count FROM conversation_shadow_content_summaries WHERE run_id = ?')
          .get(turn.runId) as { count: number }).count,
        0,
      );
    } finally {
      runtime?.close();
      db.close();
      await rm(fixture.directory, { recursive: true, force: true });
    }
  });

  it('flushes late content once after provider completion without rewriting the terminal summary', async () => {
    const fixture = await tempFixture();
    const db = new Database(fixture.databasePath);
    const runtime = boot(db, fixture.lockPath);
    try {
      assert.ok(runtime);
      const turn = runtime.beginLegacyTurn({
        principalId: 'user-1',
        clientMsgId: 'late-content',
        requestedProvider: 'codex',
        requestedModel: null,
        command: 'late content fixture',
        authorization: resumeAuthorization('user-1', 'late-content', 'late-thread'),
      });
      assert.ok(turn);
      turn.markLegacyDispatchStarted();
      turn.observeLegacyPayload({ kind: 'stream_delta', content: 'before' });
      turn.observeLegacyPayload({ kind: 'complete', provider: 'codex', success: true, exitCode: 0 });
      const summaryBefore = db.prepare(
        'SELECT summary_digest FROM conversation_shadow_content_summaries WHERE run_id = ?',
      ).get(turn.runId);
      turn.observeLegacyPayload({ kind: 'stream_delta', content: 'late' });
      assert.equal(runtime.getParity(turn.runId)?.orderState, 'match');
      turn.finishLegacyDispatch?.();
      assert.equal(runtime.getParity(turn.runId)?.orderState, 'diverged');
      assert.ok(runtime.getParity(turn.runId)?.divergenceCodes.includes('LEGACY_CONTENT_AFTER_TERMINAL'));
      assert.deepEqual(
        db.prepare('SELECT summary_digest FROM conversation_shadow_content_summaries WHERE run_id = ?')
          .get(turn.runId),
        summaryBefore,
      );
    } finally {
      runtime?.close();
      db.close();
      await rm(fixture.directory, { recursive: true, force: true });
    }
  });

  it('rolls back terminal evidence when the parity CAS is ignored', async () => {
    const fixture = await tempFixture();
    const db = new Database(fixture.databasePath);
    const runtime = boot(db, fixture.lockPath);
    try {
      assert.ok(runtime);
      const turn = runtime.beginLegacyTurn({
        principalId: 'user-cas',
        clientMsgId: 'terminal-cas-ignore',
        requestedProvider: 'codex',
        requestedModel: null,
        command: 'terminal CAS fixture',
        authorization: freshAuthorization('user-cas', 'terminal-cas-ignore'),
      });
      assert.ok(turn);
      turn.markLegacyDispatchStarted();
      db.exec(`
        CREATE TRIGGER inject_parity_terminal_ignore
        BEFORE UPDATE ON conversation_shadow_parity
        WHEN NEW.terminal_observed = 1 AND OLD.terminal_observed = 0
        BEGIN
          SELECT RAISE(IGNORE);
        END;
      `);
      turn.observeLegacyPayload({ kind: 'complete', provider: 'codex', success: true, exitCode: 0 });
      assert.equal(runtime.getParity(turn.runId)?.legacyTerminalOutcome, 'pending');
      assert.equal(
        (db.prepare('SELECT COUNT(*) AS count FROM conversation_shadow_observations WHERE run_id = ?')
          .get(turn.runId) as { count: number }).count,
        0,
      );
      assert.equal(
        (db.prepare('SELECT COUNT(*) AS count FROM conversation_shadow_content_summaries WHERE run_id = ?')
          .get(turn.runId) as { count: number }).count,
        0,
      );
      assert.equal(
        (db.prepare('SELECT state FROM conversation_commands WHERE run_id = ?').get(turn.runId) as {
          state: string;
        }).state,
        'dispatched',
      );
    } finally {
      runtime?.close();
      db.close();
      await rm(fixture.directory, { recursive: true, force: true });
    }
  });

  it('forbids identity rewrites and raw deletion of durable Foundation evidence', async () => {
    const fixture = await tempFixture();
    const db = new Database(fixture.databasePath);
    const runtime = boot(db, fixture.lockPath);
    try {
      assert.ok(runtime);
      const turn = runtime.beginLegacyTurn({
        principalId: 'user-1',
        clientMsgId: 'immutable-foundation',
        requestedProvider: 'codex',
        requestedModel: 'gpt-test',
        command: 'immutable fixture',
        authorization: freshAuthorization('user-1', 'immutable-foundation'),
      });
      assert.ok(turn);
      assert.throws(
        () => db.prepare('UPDATE conversations SET schema_version = 2 WHERE conversation_id = ?')
          .run(turn.conversationId),
        /CONVERSATION_IDENTITY_IMMUTABLE/,
      );
      assert.throws(
        () => db.prepare("UPDATE conversation_runs SET requested_model = 'forged' WHERE run_id = ?")
          .run(turn.runId),
        /RUN_IDENTITY_IMMUTABLE/,
      );
      assert.throws(
        () => db.prepare("UPDATE conversation_participants SET principal_id = 'forged' WHERE conversation_id = ?")
          .run(turn.conversationId),
        /PARTICIPANT_IDENTITY_IMMUTABLE/,
      );
      turn.markLegacyDispatchStarted();
      turn.observeLegacyPayload({ kind: 'complete', provider: 'codex', success: true, exitCode: 0 });
      assert.throws(
        () => db.prepare(
          "UPDATE conversation_shadow_content_summaries SET integrity_state = 'unknown' WHERE run_id = ?",
        ).run(turn.runId),
        /SHADOW_CONTENT_SUMMARY_APPEND_ONLY/,
      );
      assert.throws(
        () => db.prepare('DELETE FROM conversation_shadow_content_summaries WHERE run_id = ?')
          .run(turn.runId),
        /SHADOW_CONTENT_SUMMARY_APPEND_ONLY/,
      );
      assert.throws(
        () => db.prepare(
          `INSERT INTO conversation_shadow_content_summaries
            (run_id, conversation_id, dispatch_generation, reference_key_version,
             integrity_state, content_digest, summary_digest, segment_count,
             source_chunk_count, canonical_bytes, duplicate_event_count, overflow,
             schema_gap, reentrant, substitution_count, sequence_gap_count,
             sequence_reorder_count, terminal_outcome, writer_epoch)
           SELECT run_id, conversation_id, 99, 99, 'unknown', ?, ?, 0, 0, 0, 0,
                  0, 0, 0, 0, 0, 0, 'unknown', writer_epoch
             FROM conversation_shadow_parity WHERE run_id = ?`,
        ).run('0'.repeat(64), '1'.repeat(64), turn.runId),
        /SHADOW_CONTENT_REFERENCE_KEY_VERSION_MISSING/,
      );
      assert.throws(
        () => db.prepare('DELETE FROM conversation_runs WHERE run_id = ?').run(turn.runId),
        /RUN_APPEND_ONLY/,
      );
      assert.throws(
        () => db.prepare('DELETE FROM conversations WHERE conversation_id = ?').run(turn.conversationId),
        /CONVERSATION_APPEND_ONLY/,
      );
      db.prepare(
        `INSERT INTO harness_capability_profiles
          (profile_id, harness_id, adapter_version, runtime_version, credential_scope_id,
           model_id, capabilities_json, evidence_at)
         VALUES ('profile-1', 'codex', 'adapter-v1', 'runtime-v1', 'scope-1',
                 'gpt-test', '{}', CURRENT_TIMESTAMP)`,
      ).run();
      assert.throws(
        () => db.prepare("UPDATE harness_capability_profiles SET model_id = 'forged'").run(),
        /CAPABILITY_PROFILE_APPEND_ONLY/,
      );
      db.prepare(
        "UPDATE harness_capability_profiles SET invalidated_at = '2026-08-10T12:00:00.000Z'",
      ).run();
      assert.throws(
        () => db.prepare('UPDATE harness_capability_profiles SET invalidated_at = NULL').run(),
        /CAPABILITY_PROFILE_APPEND_ONLY/,
      );
      assert.throws(
        () => db.prepare(
          "UPDATE harness_capability_profiles SET invalidated_at = '2026-08-10T13:00:00.000Z'",
        ).run(),
        /CAPABILITY_PROFILE_APPEND_ONLY/,
      );
      assert.throws(
        () => db.prepare('DELETE FROM harness_capability_profiles').run(),
        /CAPABILITY_PROFILE_APPEND_ONLY/,
      );
    } finally {
      runtime?.close();
      db.close();
      await rm(fixture.directory, { recursive: true, force: true });
    }
  });

  it('recovers pending parity and link candidates after a dispatch without terminal evidence', async () => {
    const fixture = await tempFixture();
    const firstDb = new Database(fixture.databasePath);
    const first = boot(firstDb, fixture.lockPath, 'first');
    assert.ok(first);
    const authorization = freshAuthorization('user-1', 'recovery');
    const turn = first.beginLegacyTurn({
      principalId: 'user-1',
      clientMsgId: 'recovery',
      requestedProvider: 'codex',
      requestedModel: null,
      command: 'recovery fixture',
      authorization,
    });
    assert.ok(turn);
    turn.markLegacyDispatchStarted();
    turn.observeLegacyPayload({ kind: 'session_created', provider: 'codex', sessionId: 'pending-thread' });
    first.close();
    firstDb.close();

    const secondDb = new Database(fixture.databasePath);
    const second = boot(secondDb, fixture.lockPath, 'replacement');
    try {
      assert.ok(second);
      const report = second.getRecoveryReports().find(
        (item) => item.conversationId === turn.conversationId,
      );
      assert.ok(report);
      assert.deepEqual({
        classified: report.classified,
        safeUnstarted: report.safeUnstarted,
        requiresReconciliation: report.requiresReconciliation,
        operatorReview: report.operatorReview,
      }, {
        classified: 3,
        safeUnstarted: 0,
        requiresReconciliation: 1,
        operatorReview: 2,
      });
      assert.deepEqual(
        secondDb.prepare(
          'SELECT record_type, disposition FROM conversation_shadow_recovery ORDER BY record_type',
        ).all(),
        [
          { record_type: 'command', disposition: 'requires_reconciliation' },
          { record_type: 'link_candidate', disposition: 'operator_review' },
          { record_type: 'parity', disposition: 'operator_review' },
        ],
      );
      assert.throws(
        () => secondDb.prepare("UPDATE conversation_shadow_recovery SET prior_state='forged'").run(),
        /SHADOW_RECOVERY_APPEND_ONLY/,
      );
      assert.equal(
        (secondDb.prepare('SELECT state FROM conversation_commands WHERE run_id = ?')
          .get(turn.runId) as { state: string }).state,
        'dispatched',
      );
      assert.equal(
        (secondDb.prepare('SELECT COUNT(*) AS count FROM conversation_legacy_links')
          .get() as { count: number }).count,
        0,
      );
    } finally {
      second?.close();
      secondDb.close();
      await rm(fixture.directory, { recursive: true, force: true });
    }
  });

  it('rejects stale direct writes to every shadow ledger through fencing', async () => {
    const fixture = await tempFixture();
    const db = new Database(fixture.databasePath);
    const runtime = boot(db, fixture.lockPath, 'first');
    try {
      assert.ok(runtime);
      const authorization = freshAuthorization('user-1', 'stale');
      const turn = runtime.beginLegacyTurn({
        principalId: 'user-1',
        clientMsgId: 'stale',
        requestedProvider: 'codex',
        requestedModel: null,
        command: 'stale fixture',
        authorization,
      });
      assert.ok(turn);
      const repository = new ConversationFoundationRepository(db);
      const epoch = repository.acquireWriterEpoch(turn.conversationId, 'replacement', {
        allowCrashTakeover: true,
      });
      repository.markWriterRecovered(turn.conversationId, 'replacement', epoch);
      assert.throws(
        () => db.prepare(
          'UPDATE conversation_shadow_parity SET duplicate_count = duplicate_count + 1 WHERE run_id = ?',
        ).run(turn.runId),
        /STALE_WRITER_EPOCH/,
      );
      assert.throws(
        () => db.prepare(
          `INSERT INTO conversation_shadow_content_summaries
            (run_id, conversation_id, dispatch_generation, reference_key_version,
             integrity_state, content_digest, summary_digest, segment_count,
             source_chunk_count, canonical_bytes, duplicate_event_count, overflow,
             schema_gap, reentrant, substitution_count, sequence_gap_count,
             sequence_reorder_count, terminal_outcome, writer_epoch)
           SELECT run_id, conversation_id, 1, reference_key_version, 'unknown', ?, ?,
                  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 'unknown', writer_epoch
             FROM conversation_shadow_parity WHERE run_id = ?`,
        ).run('0'.repeat(64), '1'.repeat(64), turn.runId),
        /STALE_WRITER_EPOCH/,
      );
    } finally {
      runtime?.close();
      db.close();
      await rm(fixture.directory, { recursive: true, force: true });
    }
  });

  it('reads retained old keys across rotation, preserves retries, and fails closed on key gaps/conflicts', async () => {
    const fixture = await tempFixture();
    const firstDb = new Database(fixture.databasePath);
    const first = UniversalConversationShadowRuntime.boot(firstDb, {
      env: ENABLED_ENV,
      lockPath: fixture.lockPath,
      instanceId: 'v1',
      referenceKey: REFERENCE_KEY,
      referenceKeyVersion: 1,
    });
    assert.ok(first);
    const firstAuthorization = resumeAuthorization('user-1', 'rotation-v1', 'physical-rotation');
    const firstTurn = first.beginLegacyTurn({
      principalId: 'user-1',
      clientMsgId: 'rotation-v1',
      requestedProvider: 'codex',
      requestedModel: null,
      command: 'rotation fixture',
      authorization: firstAuthorization,
    });
    assert.ok(firstTurn);
    const logicalConversationId = firstTurn.conversationId;
    first.close();
    firstDb.close();

    const secondDb = new Database(fixture.databasePath);
    const second = UniversalConversationShadowRuntime.boot(secondDb, {
      env: ENABLED_ENV,
      lockPath: fixture.lockPath,
      instanceId: 'v2',
      referenceKeys: {
        1: REFERENCE_KEY,
        2: ROTATED_REFERENCE_KEY,
        3: RETAINED_REFERENCE_KEY,
      },
      referenceKeyVersion: 2,
    });
    assert.ok(second);
    const rotatedAuthorization = resumeAuthorization('user-2', 'rotation-v2', 'physical-rotation');
    const rotatedTurn = second.beginLegacyTurn({
      principalId: 'user-2',
      clientMsgId: 'rotation-v2',
      requestedProvider: 'codex',
      requestedModel: null,
      command: 'rotation follow-up',
      authorization: rotatedAuthorization,
    });
    assert.ok(rotatedTurn);
    assert.equal(rotatedTurn.conversationId, logicalConversationId);
    assert.equal(
      (secondDb.prepare('SELECT reference_key_version FROM conversation_shadow_parity WHERE run_id = ?')
        .get(rotatedTurn.runId) as { reference_key_version: number }).reference_key_version,
      2,
      'old-key lookup resolves identity while a new ingress writes the active version',
    );

    second.close();
    secondDb.close();

    const retryDb = new Database(fixture.databasePath);
    const retryRuntime = UniversalConversationShadowRuntime.boot(retryDb, {
      env: ENABLED_ENV,
      lockPath: fixture.lockPath,
      instanceId: 'v2-retry',
      referenceKeys: {
        1: REFERENCE_KEY,
        2: ROTATED_REFERENCE_KEY,
        3: RETAINED_REFERENCE_KEY,
      },
      referenceKeyVersion: 2,
    });
    assert.ok(retryRuntime);
    const retry = retryRuntime.beginLegacyTurn({
      principalId: 'user-2',
      clientMsgId: 'rotation-v2',
      requestedProvider: 'codex',
      requestedModel: null,
      command: 'rotation follow-up',
      authorization: resumeAuthorization('user-2', 'rotation-v2', 'physical-rotation'),
    });
    assert.ok(retry);
    assert.equal(retry.reused, true);
    assert.equal(retry.runId, rotatedTurn.runId);
    retry.markLegacyDispatchStarted();
    retry.observeLegacyPayload({
      kind: 'complete',
      provider: 'codex',
      sessionId: 'physical-rotation',
      success: true,
      exitCode: 0,
    });
    assert.equal(retryRuntime.getParity(retry.runId)?.legacyTerminalOutcome, 'success');

    const otherAuthorization = freshAuthorization('user-1', 'rotation-other');
    const other = retryRuntime.beginLegacyTurn({
      principalId: 'user-1',
      clientMsgId: 'rotation-other',
      requestedProvider: 'codex',
      requestedModel: null,
      command: 'other logical conversation',
      authorization: otherAuthorization,
    });
    assert.ok(other);
    const otherEpoch = (retryDb.prepare(
      'SELECT writer_epoch FROM conversations WHERE conversation_id = ?',
    ).get(other.conversationId) as { writer_epoch: number }).writer_epoch;
    retryDb.prepare(
      `INSERT INTO conversation_legacy_links
        (legacy_provider, reference_key_version, legacy_ref_digest, conversation_id,
         link_kind, first_principal_id, writer_epoch)
       VALUES ('codex', 3, ?, ?, 'resume_verified', 'user-1', ?)`,
    ).run(
      protectedRef(3, RETAINED_REFERENCE_KEY, 'codex', 'physical-rotation'),
      other.conversationId,
      otherEpoch,
    );
    assert.throws(
      () => retryRuntime.beginLegacyTurn({
        principalId: 'user-3',
        clientMsgId: 'rotation-conflict',
        requestedProvider: 'codex',
        requestedModel: null,
        command: 'must fail closed',
        authorization: resumeAuthorization('user-3', 'rotation-conflict', 'physical-rotation'),
      }),
      (error) => error instanceof Error
        && 'code' in error
        && error.code === 'LEGACY_KEYRING_IDENTITY_CONFLICT',
    );
    retryRuntime.close();
    retryDb.close();

    const missingOldDb = new Database(fixture.databasePath);
    try {
      assert.throws(
        () => UniversalConversationShadowRuntime.boot(missingOldDb, {
          env: ENABLED_ENV,
          lockPath: fixture.lockPath,
          instanceId: 'missing-v1',
          referenceKey: ROTATED_REFERENCE_KEY,
          referenceKeyVersion: 2,
        }),
        /UNIVERSAL_CONVERSATION_REFERENCE_KEY_VERSION_UNAVAILABLE:1/,
      );
    } finally {
      missingOldDb.close();
      await rm(fixture.directory, { recursive: true, force: true });
    }
  });

  it('requires every registered reference-key version even before evidence references it', async () => {
    const fixture = await tempFixture();
    const firstDb = new Database(fixture.databasePath);
    const first = UniversalConversationShadowRuntime.boot(firstDb, {
      env: ENABLED_ENV,
      lockPath: fixture.lockPath,
      instanceId: 'registered-keyring',
      referenceKeys: { 1: REFERENCE_KEY, 2: ROTATED_REFERENCE_KEY },
      referenceKeyVersion: 2,
    });
    assert.ok(first);
    first.close();
    firstDb.close();

    const missingDb = new Database(fixture.databasePath);
    try {
      assert.throws(
        () => UniversalConversationShadowRuntime.boot(missingDb, {
          env: ENABLED_ENV,
          lockPath: fixture.lockPath,
          instanceId: 'missing-unused-registered-key',
          referenceKey: ROTATED_REFERENCE_KEY,
          referenceKeyVersion: 2,
        }),
        /UNIVERSAL_CONVERSATION_REFERENCE_KEY_VERSION_UNAVAILABLE:1/,
      );
      assert.equal(
        (missingDb.prepare('SELECT COUNT(*) AS count FROM conversation_legacy_links')
          .get() as { count: number }).count,
        0,
      );
      assert.equal(
        (missingDb.prepare('SELECT COUNT(*) AS count FROM conversation_shadow_parity')
          .get() as { count: number }).count,
        0,
      );
    } finally {
      missingDb.close();
      await rm(fixture.directory, { recursive: true, force: true });
    }
  });

  it('verifies schema manifest version/checksum and rejects a missing manifest', () => {
    const db = new Database(':memory:');
    initializeConversationFoundationSchema(db);
    assert.throws(
      () => db.prepare(
        "UPDATE conversation_schema_metadata SET schema_checksum='tampered' WHERE component='universal-conversations'",
      ).run(),
      /UNIVERSAL_CONVERSATION_SCHEMA_MANIFEST_IMMUTABLE/,
    );
    assert.throws(
      () => db.prepare(
        "DELETE FROM conversation_schema_metadata WHERE component='universal-conversations'",
      ).run(),
      /UNIVERSAL_CONVERSATION_SCHEMA_MANIFEST_IMMUTABLE/,
    );
    db.close();

    const mismatched = new Database(':memory:');
    mismatched.exec(`
      CREATE TABLE conversation_schema_metadata (
        component TEXT PRIMARY KEY,
        schema_version INTEGER NOT NULL,
        schema_checksum TEXT NOT NULL,
        applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      INSERT INTO conversation_schema_metadata (component, schema_version, schema_checksum)
      VALUES ('universal-conversations', 1, 'tampered');
      CREATE TABLE conversations (conversation_id TEXT PRIMARY KEY);
    `);
    assert.throws(
      () => initializeConversationFoundationSchema(mismatched),
      /UNIVERSAL_CONVERSATION_SCHEMA_VERSION_MISMATCH/,
    );
    mismatched.close();

    const missingRow = new Database(':memory:');
    missingRow.exec(`
      CREATE TABLE conversation_schema_metadata (
        component TEXT PRIMARY KEY,
        schema_version INTEGER NOT NULL,
        schema_checksum TEXT NOT NULL,
        applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE conversations (conversation_id TEXT PRIMARY KEY);
    `);
    assert.throws(
      () => initializeConversationFoundationSchema(missingRow),
      /UNIVERSAL_CONVERSATION_SCHEMA_MANIFEST_MISSING/,
    );
    missingRow.close();
  });

  it('binds the singleton façade once, accepts identical bootstrap, and rejects target drift', async () => {
    const fixture = await tempFixture();
    const db = new Database(fixture.databasePath);
    const authorization = freshAuthorization(1, 'facade');
    try {
      assert.equal(universalConversationShadowHook.beginLegacyTurn({
        principalId: 1,
        clientMsgId: 'facade',
        requestedProvider: 'codex',
        requestedModel: null,
        command: 'before boot',
        authorization,
      }), null);
      const options = {
        env: ENABLED_ENV,
        lockPath: fixture.lockPath,
        referenceKey: REFERENCE_KEY,
        authorizationResolverVersion: 'core-v1',
      };
      const first = initializeUniversalConversationShadowRuntime(db, options);
      const same = initializeUniversalConversationShadowRuntime(db, options);
      assert.ok(first);
      assert.equal(same, first);
      const sameNormalizedPath = initializeUniversalConversationShadowRuntime(db, {
        ...options,
        lockPath: path.join(fixture.directory, 'unused', '..', 'universal-conversations.lock'),
      });
      assert.equal(sameNormalizedPath, first);
      assert.throws(
        () => initializeUniversalConversationShadowRuntime(db, {
          ...options,
          authorizationResolverVersion: 'core-v2',
        }),
        /UNIVERSAL_CONVERSATION_SINGLETON_TARGET_MISMATCH/,
      );
      const turn = universalConversationShadowHook.beginLegacyTurn({
        principalId: 1,
        clientMsgId: 'facade',
        requestedProvider: 'codex',
        requestedModel: null,
        command: 'after boot',
        authorization,
      });
      assert.ok(turn);
      closeUniversalConversationShadowRuntime();
      assert.equal(universalConversationShadowHook.beginLegacyTurn({
        principalId: 1,
        clientMsgId: 'facade-2',
        requestedProvider: 'codex',
        requestedModel: null,
        command: 'must not rebind',
        authorization: freshAuthorization(1, 'facade-2'),
      }), null);
      assert.throws(
        () => initializeUniversalConversationShadowRuntime(db, {
          ...options,
          lockPath: path.join(fixture.directory, 'new.lock'),
        }),
        /UNIVERSAL_CONVERSATION_SHADOW_FACADE_CLOSED/,
      );
    } finally {
      closeUniversalConversationShadowRuntime();
      db.close();
      await rm(fixture.directory, { recursive: true, force: true });
    }
  });
});
