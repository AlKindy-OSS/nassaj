import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';

import Database from 'better-sqlite3';

import { ConversationFoundationRepository, ConversationRepositoryError } from './repository.js';
import { createUniversalConversationShadowCoreResolver } from './shadow-core-resolver.js';
import { initializeConversationFoundationSchema } from './schema.js';
import {
  closeUniversalConversationShadowRuntime,
  initializeUniversalConversationShadowRuntime,
  issueTrustedShadowAuthorization,
  UniversalConversationShadowRuntime,
} from './shadow-runtime.js';
import { UNIVERSAL_CONVERSATION_SHADOW_FLAG } from './shadow-orchestrator.js';

const ENABLED_ENV = { [UNIVERSAL_CONVERSATION_SHADOW_FLAG]: '1' };
const REFERENCE_KEY = 'tester-phase-0-reference-key-0123456789abcdef';
const OTHER_REFERENCE_KEY = 'tester-phase-0-other-key----0123456789abcdef';

async function tempFixture(): Promise<{
  directory: string;
  databasePath: string;
  lockPath: string;
}> {
  const directory = await mkdtemp('/tmp/nassaj-shadow-adversarial-');
  return {
    directory,
    databasePath: path.join(directory, 'auth.db'),
    lockPath: path.join(directory, 'universal-conversations.lock'),
  };
}

function boot(
  db: Database.Database,
  lockPath: string,
  options: Partial<Parameters<typeof UniversalConversationShadowRuntime.boot>[1]> = {},
) {
  return UniversalConversationShadowRuntime.boot(db, {
    env: ENABLED_ENV,
    lockPath,
    referenceKey: REFERENCE_KEY,
    referenceKeyVersion: 7,
    authorizationResolverVersion: 'tester-core-v1',
    ...options,
  });
}

function freshAuthorization(
  principalId: string | number,
  clientMsgId: string,
  projectId = 'project-1',
) {
  return issueTrustedShadowAuthorization({
    kind: 'fresh',
    projectId,
    principalId,
    clientMsgId,
    canSubmit: true,
    authorizationProvenance: 'tester-jwt+project-write:v1',
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
    authorizationProvenance: 'tester-jwt+verified-session+project-write:v1',
    legacyProvider: provider,
    legacySessionId,
  });
}

function assertNoFoundationTextValueContains(
  db: Database.Database,
  forbidden: readonly string[],
): void {
  const tables = db.prepare(
    `SELECT name FROM sqlite_master
      WHERE type='table' AND name NOT LIKE 'sqlite_%'
      ORDER BY name`,
  ).all() as Array<{ name: string }>;
  for (const { name } of tables) {
    const escapedTable = `"${name.replaceAll('"', '""')}"`;
    const columns = db.prepare(`PRAGMA table_info(${escapedTable})`).all() as Array<{
      name: string;
      type: string;
    }>;
    for (const column of columns.filter((item) => item.type.toUpperCase().includes('TEXT'))) {
      const escapedColumn = `"${column.name.replaceAll('"', '""')}"`;
      const values = db.prepare(
        `SELECT ${escapedColumn} AS value FROM ${escapedTable} WHERE ${escapedColumn} IS NOT NULL`,
      ).all() as Array<{ value: string }>;
      for (const { value } of values) {
        for (const needle of forbidden) {
          assert.equal(
            value.includes(needle),
            false,
            `${name}.${column.name} leaked protected value ${needle}`,
          );
        }
      }
    }
  }
}

afterEach(() => closeUniversalConversationShadowRuntime());

describe('Universal Conversation Phase-0 adversarial runtime', () => {
  it('does not even attempt a process lock while the shadow flag is off', async () => {
    const fixture = await tempFixture();
    const db = new Database(fixture.databasePath);
    let lockAttempts = 0;
    try {
      const runtime = UniversalConversationShadowRuntime.boot(db, {
        env: {},
        lockPath: fixture.lockPath,
        acquireLock: () => {
          lockAttempts += 1;
          throw new Error('the disabled path must return before this callback');
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

  it('acquires the process lock before applying schema or creating writer state', async () => {
    const fixture = await tempFixture();
    const db = new Database(fixture.databasePath);
    let inspectedBeforeSchema = false;
    let released = 0;
    try {
      const runtime = boot(db, fixture.lockPath, {
        acquireLock: () => {
          inspectedBeforeSchema = true;
          assert.equal(
            db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='conversations'").get(),
            undefined,
          );
          return { fd: 123, release: () => { released += 1; } };
        },
      });
      assert.ok(runtime);
      assert.equal(inspectedBeforeSchema, true);
      runtime.close();
      runtime.close();
      assert.equal(released, 1, 'process lock release is idempotent');
    } finally {
      db.close();
      await rm(fixture.directory, { recursive: true, force: true });
    }
  });

  it('atomically rolls back the run sequence, run, event, command, and related evidence', () => {
    const db = new Database(':memory:');
    try {
      initializeConversationFoundationSchema(db);
      const repository = new ConversationFoundationRepository(db);
      repository.createConversation({
        conversationId: 'atomic-conversation',
        projectId: 'project-1',
        createdBy: 'jwt-user',
      });
      const epoch = repository.acquireWriterEpoch('atomic-conversation', 'writer');
      repository.markWriterRecovered('atomic-conversation', 'writer', epoch);
      assert.throws(
        () => repository.acceptRunCommandWithRelated({
          commandId: 'atomic-command',
          runId: 'atomic-run',
          conversationId: 'atomic-conversation',
          principalId: 'jwt-user',
          clientMsgId: 'atomic-client-key',
          requestDigest: 'atomic-request-digest',
          requestedHarness: 'codex',
          writerEpoch: epoch,
        }, () => {
          db.prepare(
            `INSERT INTO conversation_shadow_parity
              (run_id, conversation_id, principal_id, client_msg_id, request_digest,
               requested_provider, reference_key_version, writer_epoch)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          ).run(
            'atomic-run',
            'atomic-conversation',
            'jwt-user',
            'atomic-client-key',
            'atomic-request-digest',
            'codex',
            7,
            epoch,
          );
          throw new Error('fault-after-related-evidence');
        }),
        /fault-after-related-evidence/,
      );
      for (const table of [
        'conversation_runs',
        'canonical_events',
        'conversation_commands',
        'conversation_shadow_parity',
      ]) {
        assert.equal(
          (db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count,
          0,
          table,
        );
      }
      assert.equal(
        (db.prepare(
          "SELECT next_run_seq FROM conversations WHERE conversation_id='atomic-conversation'",
        ).get() as { next_run_seq: number }).next_run_seq,
        1,
      );
    } finally {
      db.close();
    }
  });

  it('skips missing client identity without creating any canonical run', async () => {
    const fixture = await tempFixture();
    const db = new Database(fixture.databasePath);
    const runtime = boot(db, fixture.lockPath);
    try {
      assert.ok(runtime);
      assert.equal(runtime.beginLegacyTurn({
        principalId: 'jwt-user',
        clientMsgId: null,
        requestedProvider: 'codex',
        requestedModel: null,
        command: 'must stay legacy-only',
        authorization: null,
      }), null);
      assert.equal(
        (db.prepare('SELECT COUNT(*) AS count FROM conversation_runs').get() as { count: number }).count,
        0,
      );
      assert.equal(
        (db.prepare('SELECT COUNT(*) AS count FROM canonical_events').get() as { count: number }).count,
        0,
      );
    } finally {
      runtime?.close();
      db.close();
      await rm(fixture.directory, { recursive: true, force: true });
    }
  });

  it('does not let an unauthorized user copy a physical session into participants or links', async () => {
    const fixture = await tempFixture();
    const db = new Database(fixture.databasePath);
    const runtime = boot(db, fixture.lockPath);
    const copiedPhysicalId = 'copied-provider-thread';
    const resolver = createUniversalConversationShadowCoreResolver({
      coercePrincipalId: (value) => Number.isInteger(Number(value)) ? Number(value) : null,
      getSession: (sessionId) => sessionId === copiedPhysicalId
        ? { sessionId, provider: 'codex', projectPath: '/protected-project' }
        : null,
      getProjectByPath: (projectPath) => projectPath === '/protected-project'
        ? { projectId: 'protected-project' }
        : null,
      isSessionParticipant: () => false,
      isProjectWritable: () => false,
    });
    try {
      assert.ok(runtime);
      const authorization = resolver.authorize({
        principalId: 99,
        clientMsgId: 'copied-client-key',
        requestedProvider: 'codex',
        requestedLegacySessionId: copiedPhysicalId,
        requestedProjectPath: null,
      });
      assert.equal(authorization, null);
      assert.equal(runtime.beginLegacyTurn({
        principalId: 99,
        clientMsgId: 'copied-client-key',
        requestedProvider: 'codex',
        requestedModel: null,
        command: 'unauthorized resume',
        authorization,
      }), null);
      for (const table of [
        'conversations',
        'conversation_participants',
        'conversation_runs',
        'conversation_legacy_links',
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

  it('keeps UUID logical identities and joins users only through a verified resume link', async () => {
    const fixture = await tempFixture();
    const db = new Database(fixture.databasePath);
    const runtime = boot(db, fixture.lockPath);
    const physicalId = 'native-codex-thread-sensitive';
    const promptA = 'secret prompt alpha';
    const sessions = new Map<string, { sessionId: string; provider: string; projectPath: string }>();
    const resolver = createUniversalConversationShadowCoreResolver({
      coercePrincipalId: (value) => Number.isInteger(Number(value)) ? Number(value) : null,
      getSession: (sessionId) => sessions.get(sessionId) ?? null,
      getProjectByPath: (projectPath) => projectPath === '/shared-project'
        ? { projectId: 'shared-project' }
        : null,
      isSessionParticipant: (_sessionId, principalId) => principalId === 1,
      isProjectWritable: (_projectId, principalId) => principalId === 1 || principalId === 2,
    });
    try {
      assert.ok(runtime);
      const firstAuthorization = resolver.authorize({
        principalId: 1,
        clientMsgId: 'fresh-client-key',
        requestedProvider: 'codex',
        requestedLegacySessionId: null,
        requestedProjectPath: '/shared-project',
      });
      assert.ok(firstAuthorization);
      const first = runtime.beginLegacyTurn({
        principalId: 1,
        clientMsgId: 'fresh-client-key',
        requestedProvider: 'codex',
        requestedModel: 'gpt-test',
        command: promptA,
        authorization: firstAuthorization,
      });
      assert.ok(first);
      assert.match(first.conversationId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
      assert.notEqual(first.conversationId, physicalId);

      sessions.set(physicalId, {
        sessionId: physicalId,
        provider: 'codex',
        projectPath: '/shared-project',
      });
      const freshAttestation = resolver.attest({
        authorization: firstAuthorization,
        provider: 'codex',
        legacySessionId: physicalId,
      });
      assert.equal(freshAttestation, null, 'fresh authorization cannot mint a physical link');
      first.observeLegacyPayload({
        kind: 'session_created',
        provider: 'codex',
        sessionId: physicalId,
      }, freshAttestation);
      assert.equal(
        (db.prepare('SELECT COUNT(*) AS count FROM conversation_legacy_links').get() as {
          count: number;
        }).count,
        0,
      );

      const anchorAuthorization = resolver.authorize({
        principalId: 1,
        clientMsgId: 'resume-anchor-client-key',
        requestedProvider: 'codex',
        requestedLegacySessionId: physicalId,
        requestedProjectPath: '/forged-client-path-is-ignored',
      });
      assert.ok(anchorAuthorization);
      const anchor = runtime.beginLegacyTurn({
        principalId: 1,
        clientMsgId: 'resume-anchor-client-key',
        requestedProvider: 'codex',
        requestedModel: null,
        command: 'first verified resume establishes the bridge',
        authorization: anchorAuthorization,
      });
      assert.ok(anchor);
      assert.match(anchor.conversationId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
      assert.notEqual(anchor.conversationId, first.conversationId);
      assert.notEqual(anchor.conversationId, physicalId);

      const secondAuthorization = resolver.authorize({
        principalId: 2,
        clientMsgId: 'resume-client-key',
        requestedProvider: 'codex',
        requestedLegacySessionId: physicalId,
        requestedProjectPath: '/forged-client-path-is-ignored',
      });
      assert.ok(secondAuthorization);
      const second = runtime.beginLegacyTurn({
        principalId: 2,
        clientMsgId: 'resume-client-key',
        requestedProvider: 'codex',
        requestedModel: null,
        command: 'authorized collaborator turn',
        authorization: secondAuthorization,
      });
      assert.ok(second);
      assert.equal(second.conversationId, anchor.conversationId);
      assert.notEqual(second.conversationId, physicalId);
      const provenance = db.prepare(
        `SELECT principal_id, authorization_kind, provenance_digest
           FROM conversation_shadow_authorizations ORDER BY principal_id, authorization_kind`,
      ).all() as Array<{
        principal_id: string;
        authorization_kind: string;
        provenance_digest: string;
      }>;
      assert.deepEqual(
        provenance.map(({ principal_id, authorization_kind }) => ({
          principal_id,
          authorization_kind,
        })),
        [
          { principal_id: '1', authorization_kind: 'fresh' },
          { principal_id: '1', authorization_kind: 'resume' },
          { principal_id: '2', authorization_kind: 'resume' },
        ],
      );
      assert.ok(provenance.every((row) => /^[0-9a-f]{64}$/.test(row.provenance_digest)));
      assert.notEqual(provenance[0]?.provenance_digest, provenance[1]?.provenance_digest);
      assert.deepEqual(
        db.prepare(
          `SELECT principal_id, role FROM conversation_participants
            WHERE conversation_id = ? ORDER BY principal_id`,
        ).all(anchor.conversationId),
        [
          { principal_id: '1', role: 'owner' },
          { principal_id: '2', role: 'participant' },
        ],
      );
      assert.equal(
        (db.prepare('SELECT first_principal_id FROM conversation_legacy_links').get() as {
          first_principal_id: string;
        }).first_principal_id,
        '1',
      );
      assertNoFoundationTextValueContains(db, [physicalId, promptA]);
    } finally {
      runtime?.close();
      db.close();
      await rm(fixture.directory, { recursive: true, force: true });
    }
  });

  it('reuses an identical client command and rejects a changed digest under the same key', async () => {
    const fixture = await tempFixture();
    const db = new Database(fixture.databasePath);
    const runtime = boot(db, fixture.lockPath);
    try {
      assert.ok(runtime);
      const input = {
        principalId: 'jwt-user',
        clientMsgId: 'stable-client-key',
        requestedProvider: 'codex',
        requestedModel: 'gpt-test',
        command: 'original input',
        authorization: freshAuthorization('jwt-user', 'stable-client-key'),
      };
      const first = runtime.beginLegacyTurn(input);
      const duplicate = runtime.beginLegacyTurn(input);
      assert.ok(first && duplicate);
      assert.equal(duplicate.reused, true);
      assert.equal(duplicate.runId, first.runId);
      assert.throws(
        () => runtime.beginLegacyTurn({ ...input, command: 'mutated input' }),
        (error) => error instanceof ConversationRepositoryError
          && error.code === 'IDEMPOTENCY_CONFLICT',
      );
      assert.equal(
        (db.prepare('SELECT COUNT(*) AS count FROM conversation_runs').get() as { count: number }).count,
        1,
      );
      assert.equal(
        (db.prepare('SELECT COUNT(*) AS count FROM canonical_events').get() as { count: number }).count,
        1,
      );
    } finally {
      runtime?.close();
      db.close();
      await rm(fixture.directory, { recursive: true, force: true });
    }
  });

  it('classifies every incomplete command on restart without mutating or dispatching it', async () => {
    const fixture = await tempFixture();
    const firstDb = new Database(fixture.databasePath);
    const first = boot(firstDb, fixture.lockPath, {
      instanceId: 'first',
    });
    assert.ok(first);
    const turn = first.beginLegacyTurn({
      principalId: 'jwt-user',
      clientMsgId: 'recovery-seed',
      requestedProvider: 'codex',
      requestedModel: null,
      command: 'seed',
      authorization: freshAuthorization('jwt-user', 'recovery-seed'),
    });
    assert.ok(turn);
    turn.markLegacyDispatchStarted();
    turn.observeLegacyPayload({ kind: 'complete', provider: 'codex', success: true });
    const epoch = (firstDb.prepare(
      'SELECT writer_epoch FROM conversations WHERE conversation_id = ?',
    ).get(turn.conversationId) as { writer_epoch: number }).writer_epoch;
    const insert = firstDb.prepare(
      `INSERT INTO conversation_commands
        (command_id, conversation_id, principal_id, operation, idempotency_key,
         request_digest, state, writer_epoch)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    insert.run('prepared-record', turn.conversationId, 'jwt-user', 'test-prepared', 'p', 'p', 'prepared', epoch);
    insert.run('dispatched-record', turn.conversationId, 'jwt-user', 'test-dispatched', 'd', 'd', 'dispatched', epoch);
    insert.run('uncertain-record', turn.conversationId, 'jwt-user', 'test-uncertain', 'u', 'u', 'uncertain', epoch);
    first.close();
    firstDb.close();

    const secondDb = new Database(fixture.databasePath);
    const second = boot(secondDb, fixture.lockPath, {
      instanceId: 'replacement',
    });
    try {
      assert.ok(second);
      const report = second.getRecoveryReports().find(
        (candidate) => candidate.conversationId === turn.conversationId,
      );
      assert.deepEqual(report && {
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
          `SELECT command_id, state FROM conversation_commands
            WHERE command_id IN ('prepared-record', 'dispatched-record', 'uncertain-record')
            ORDER BY command_id`,
        ).all(),
        [
          { command_id: 'dispatched-record', state: 'dispatched' },
          { command_id: 'prepared-record', state: 'prepared' },
          { command_id: 'uncertain-record', state: 'uncertain' },
        ],
      );
    } finally {
      second?.close();
      secondDb.close();
      await rm(fixture.directory, { recursive: true, force: true });
    }
  });

  it('dedupes an exact protected verdict while retaining every distinct streaming observation', async () => {
    const fixture = await tempFixture();
    const db = new Database(fixture.databasePath);
    const runtime = boot(db, fixture.lockPath);
    try {
      assert.ok(runtime);
      const turn = runtime.beginLegacyTurn({
        principalId: 'jwt-user',
        clientMsgId: 'duplicate-verdict',
        requestedProvider: 'codex',
        requestedModel: null,
        command: 'duplicate fixture',
        authorization: freshAuthorization('jwt-user', 'duplicate-verdict'),
      });
      assert.ok(turn);
      turn.markLegacyDispatchStarted();
      const verdict = {
        kind: 'session_created',
        provider: 'codex',
        sessionId: 'physical-thread',
        clientMsgId: 'duplicate-verdict',
      };
      turn.observeLegacyPayload(verdict);
      turn.observeLegacyPayload(verdict);
      turn.observeLegacyPayload({
        kind: 'stream_delta',
        provider: 'codex',
        sessionId: 'delta-candidate-one',
        content: 'same visible delta',
      });
      turn.observeLegacyPayload({
        kind: 'stream_delta',
        provider: 'codex',
        sessionId: 'delta-candidate-one',
        content: 'same visible delta',
      });
      turn.observeLegacyPayload({
        kind: 'complete',
        provider: 'codex',
        success: true,
        exitCode: 0,
      });
      const parity = runtime.getParity(turn.runId);
      assert.ok(parity);
      assert.equal(parity.duplicateCount, 1);
      assert.equal(parity.lastObservationSeq, 2, 'only session-created and terminal are durable rows');
      assert.notEqual(parity.orderState, 'diverged');
      assert.equal(parity.divergenceCodes.some((code) => code.includes('DUPLICATE')), false);
      assert.equal(
        (db.prepare(
          `SELECT COUNT(*) AS count FROM conversation_shadow_observations
            WHERE run_id = ? AND legacy_kind = 'stream_delta'`,
        ).get(turn.runId) as { count: number }).count,
        0,
      );
      assert.deepEqual(
        db.prepare(
          `SELECT source_chunk_count, terminal_outcome
             FROM conversation_shadow_content_summaries WHERE run_id = ?`,
        ).get(turn.runId),
        { source_chunk_count: 2, terminal_outcome: 'success' },
      );
      assert.equal(
        (db.prepare('SELECT COUNT(*) AS count FROM conversation_legacy_links').get() as {
          count: number;
        }).count,
        0,
        'unattested provider output is only a pending candidate',
      );
    } finally {
      runtime?.close();
      db.close();
      await rm(fixture.directory, { recursive: true, force: true });
    }
  });

  it('rechecks authorization at attestation and leaves a revoked candidate pending without a link', async () => {
    const fixture = await tempFixture();
    const db = new Database(fixture.databasePath);
    const runtime = boot(db, fixture.lockPath);
    const physicalId = 'revoked-before-attestation-thread';
    let writable = true;
    const sessions = new Map<string, { sessionId: string; provider: string; projectPath: string }>();
    const resolver = createUniversalConversationShadowCoreResolver({
      coercePrincipalId: (value) => Number.isInteger(Number(value)) ? Number(value) : null,
      getSession: (sessionId) => sessions.get(sessionId) ?? null,
      getProjectByPath: (projectPath) => projectPath === '/revocable-project'
        ? { projectId: 'revocable-project' }
        : null,
      isSessionParticipant: () => false,
      isProjectWritable: () => writable,
    });
    try {
      assert.ok(runtime);
      const authorization = resolver.authorize({
        principalId: 5,
        clientMsgId: 'revoked-client-key',
        requestedProvider: 'codex',
        requestedLegacySessionId: null,
        requestedProjectPath: '/revocable-project',
      });
      assert.ok(authorization);
      const turn = runtime.beginLegacyTurn({
        principalId: 5,
        clientMsgId: 'revoked-client-key',
        requestedProvider: 'codex',
        requestedModel: null,
        command: 'revocation race',
        authorization,
      });
      assert.ok(turn);
      turn.markLegacyDispatchStarted();
      sessions.set(physicalId, {
        sessionId: physicalId,
        provider: 'codex',
        projectPath: '/revocable-project',
      });
      writable = false;
      const attestation = resolver.attest({
        authorization,
        provider: 'codex',
        legacySessionId: physicalId,
      });
      assert.equal(attestation, null);
      turn.observeLegacyPayload({
        kind: 'session_created',
        provider: 'codex',
        sessionId: physicalId,
      }, attestation);
      assert.equal(
        (db.prepare(
          `SELECT verification_state FROM conversation_shadow_observations
            WHERE run_id = ? AND legacy_kind = 'session_created'`,
        ).get(turn.runId) as { verification_state: string }).verification_state,
        'pending',
      );
      assert.equal(
        (db.prepare('SELECT COUNT(*) AS count FROM conversation_legacy_links').get() as {
          count: number;
        }).count,
        0,
      );
      assertNoFoundationTextValueContains(db, [physicalId]);
    } finally {
      runtime?.close();
      db.close();
      await rm(fixture.directory, { recursive: true, force: true });
    }
  });

  it('classifies pending parity and link evidence for operator review without dispatching on restart', async () => {
    const fixture = await tempFixture();
    const firstDb = new Database(fixture.databasePath);
    const first = boot(firstDb, fixture.lockPath, { instanceId: 'pending-first' });
    assert.ok(first);
    const authorization = freshAuthorization('jwt-user', 'pending-recovery');
    const turn = first.beginLegacyTurn({
      principalId: 'jwt-user',
      clientMsgId: 'pending-recovery',
      requestedProvider: 'codex',
      requestedModel: null,
      command: 'pending recovery',
      authorization,
    });
    assert.ok(turn);
    turn.markLegacyDispatchStarted();
    turn.observeLegacyPayload({
      kind: 'session_created',
      provider: 'codex',
      sessionId: 'pending-provider-thread',
    });
    first.close();
    firstDb.close();

    const secondDb = new Database(fixture.databasePath);
    const second = boot(secondDb, fixture.lockPath, { instanceId: 'pending-replacement' });
    try {
      assert.ok(second);
      const evidence = secondDb.prepare(
        `SELECT record_type, prior_state, disposition
           FROM conversation_shadow_recovery
          WHERE conversation_id = ? ORDER BY record_type`,
      ).all(turn.conversationId);
      assert.deepEqual(evidence, [
        { record_type: 'command', prior_state: 'dispatched', disposition: 'requires_reconciliation' },
        { record_type: 'link_candidate', prior_state: 'pending', disposition: 'operator_review' },
        { record_type: 'parity', prior_state: 'pending', disposition: 'operator_review' },
      ]);
      assert.equal(
        (secondDb.prepare('SELECT state FROM conversation_commands WHERE run_id = ?')
          .get(turn.runId) as { state: string }).state,
        'dispatched',
      );
      assert.equal(
        (secondDb.prepare('SELECT COUNT(*) AS count FROM conversation_legacy_links').get() as {
          count: number;
        }).count,
        0,
      );
      assert.equal(
        (secondDb.prepare(
          'SELECT COUNT(*) AS count FROM conversation_shadow_content_summaries WHERE run_id = ?',
        ).get(turn.runId) as { count: number }).count,
        0,
        'a process crash is recovery evidence, not a fabricated call-failure summary',
      );
    } finally {
      second?.close();
      secondDb.close();
      await rm(fixture.directory, { recursive: true, force: true });
    }
  });

  it('rejects stale writer epochs on shadow parity mutation', async () => {
    const fixture = await tempFixture();
    const db = new Database(fixture.databasePath);
    const runtime = boot(db, fixture.lockPath, { instanceId: 'stale-first' });
    try {
      assert.ok(runtime);
      const turn = runtime.beginLegacyTurn({
        principalId: 'jwt-user',
        clientMsgId: 'stale-client-key',
        requestedProvider: 'codex',
        requestedModel: null,
        command: 'stale writer fixture',
        authorization: freshAuthorization('jwt-user', 'stale-client-key'),
      });
      assert.ok(turn);
      const repository = new ConversationFoundationRepository(db);
      const replacementEpoch = repository.acquireWriterEpoch(
        turn.conversationId,
        'stale-replacement',
        { allowCrashTakeover: true },
      );
      repository.markWriterRecovered(turn.conversationId, 'stale-replacement', replacementEpoch);
      assert.throws(
        () => db.prepare(
          `UPDATE conversation_shadow_parity
              SET duplicate_count = duplicate_count + 1 WHERE run_id = ?`,
        ).run(turn.runId),
        /STALE_WRITER_EPOCH/,
      );
    } finally {
      runtime?.close();
      db.close();
      await rm(fixture.directory, { recursive: true, force: true });
    }
  });

  it('finalizes an unknown per-generation summary for a provider call failure, not a crash', async () => {
    const fixture = await tempFixture();
    const db = new Database(fixture.databasePath);
    const runtime = boot(db, fixture.lockPath);
    try {
      assert.ok(runtime);
      const turn = runtime.beginLegacyTurn({
        principalId: 'jwt-user',
        clientMsgId: 'provider-call-failure',
        requestedProvider: 'codex',
        requestedModel: null,
        command: 'provider call failure fixture',
        authorization: resumeAuthorization(
          'jwt-user',
          'provider-call-failure',
          'provider-call-failure-thread',
        ),
      });
      assert.ok(turn);
      turn.markLegacyDispatchStarted();
      turn.observeLegacyPayload({ kind: 'stream_delta', content: 'partial output' });
      turn.recordLegacyFailure('LEGACY_PROVIDER_CALL_FAILED');
      assert.deepEqual(
        db.prepare(
          `SELECT terminal_outcome, source_chunk_count
             FROM conversation_shadow_content_summaries WHERE run_id = ?`,
        ).get(turn.runId),
        { terminal_outcome: 'unknown', source_chunk_count: 1 },
      );
      assert.equal(
        (db.prepare(
          'SELECT COUNT(*) AS count FROM conversation_shadow_observations WHERE run_id = ?',
        ).get(turn.runId) as { count: number }).count,
        0,
        'a call failure summary is not fabricated as a provider terminal verdict',
      );
      assert.equal(runtime.getParity(turn.runId)?.legacyTerminalOutcome, 'unknown');
    } finally {
      runtime?.close();
      db.close();
      await rm(fixture.directory, { recursive: true, force: true });
    }
  });

  it('retains terminal evidence and marks every later legacy event as reordered', async () => {
    const fixture = await tempFixture();
    const db = new Database(fixture.databasePath);
    const runtime = boot(db, fixture.lockPath);
    try {
      assert.ok(runtime);
      const turn = runtime.beginLegacyTurn({
        principalId: 'jwt-user',
        clientMsgId: 'late-event',
        requestedProvider: 'codex',
        requestedModel: null,
        command: 'late fixture',
        authorization: resumeAuthorization('jwt-user', 'late-event', 'existing-thread'),
      });
      assert.ok(turn);
      turn.markLegacyDispatchStarted();
      const completed = {
        kind: 'complete',
        provider: 'codex',
        sessionId: 'existing-thread',
        success: true,
      };
      turn.observeLegacyPayload(completed);
      turn.observeLegacyPayload(completed);
      turn.observeLegacyPayload({
        kind: 'error',
        provider: 'codex',
        sessionId: 'existing-thread',
        success: false,
        exitCode: 1,
      });
      turn.observeLegacyPayload({
        kind: 'stream_delta',
        provider: 'codex',
        sessionId: 'existing-thread',
      });
      turn.finishLegacyDispatch?.();
      const parity = runtime.getParity(turn.runId);
      assert.ok(parity);
      assert.equal(parity.terminalObserved, true);
      assert.equal(parity.legacyTerminalOutcome, 'success');
      assert.equal(parity.orderState, 'diverged');
      assert.ok(parity.divergenceCodes.includes('LEGACY_EVENT_AFTER_TERMINAL'));
      assert.equal(runtime.getParityMetrics().completedComparisons, 0);
      const command = db.prepare(
        'SELECT state, durable_outcome_json FROM conversation_commands WHERE run_id = ?',
      ).get(turn.runId) as { state: string; durable_outcome_json: string };
      assert.equal(command.state, 'confirmed');
      assert.deepEqual(JSON.parse(command.durable_outcome_json), { terminalOutcome: 'success' });
      assert.equal(
        (db.prepare(
          'SELECT COUNT(*) AS count FROM conversation_shadow_content_summaries WHERE run_id = ?',
        ).get(turn.runId) as { count: number }).count,
        1,
        'an exact duplicate terminal never creates another generation summary',
      );
    } finally {
      runtime?.close();
      db.close();
      await rm(fixture.directory, { recursive: true, force: true });
    }
  });

  it('rejects singleton HMAC-key and reference-key-version drift', async () => {
    const fixture = await tempFixture();
    const db = new Database(fixture.databasePath);
    const options = {
      env: ENABLED_ENV,
      lockPath: fixture.lockPath,
      referenceKey: REFERENCE_KEY,
      referenceKeyVersion: 7,
      authorizationResolverVersion: 'tester-core-v1',
    };
    try {
      const first = initializeUniversalConversationShadowRuntime(db, options);
      assert.ok(first);
      assert.equal(initializeUniversalConversationShadowRuntime(db, options), first);
      assert.throws(
        () => initializeUniversalConversationShadowRuntime(db, {
          ...options,
          referenceKey: OTHER_REFERENCE_KEY,
        }),
        /UNIVERSAL_CONVERSATION_SINGLETON_TARGET_MISMATCH/,
      );
      assert.throws(
        () => initializeUniversalConversationShadowRuntime(db, {
          ...options,
          referenceKeyVersion: 8,
        }),
        /UNIVERSAL_CONVERSATION_SINGLETON_TARGET_MISMATCH/,
      );
    } finally {
      closeUniversalConversationShadowRuntime();
      db.close();
      await rm(fixture.directory, { recursive: true, force: true });
    }
  });
});
